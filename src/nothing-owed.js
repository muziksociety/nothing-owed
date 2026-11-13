// The scheduler: one fixed-window timer per conversation, a self-audit turn against the host's
// own send log when it fires, job tracking for long work, and delivery retry.
import {
  buildPrompt as defaultBuildPrompt,
  buildReportPrompt as defaultBuildReportPrompt,
  parseCheckReply,
  stripStillRunning,
} from './outcome.js';
import { createMemoryStore } from './stores.js';
import { createDeliveredLog } from './delivered-log.js';

const SKIP_KINDS = new Set(['check', 'report', 'system']);
const MAX_TIMER_MS = 2 ** 31 - 1;
const STORE_VERSION = 2;

const noop = () => {};
const clip = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const rand = () => Math.random().toString(36).slice(2, 8);
const newId = (prefix, t) => `${prefix}_${t.toString(36)}${rand()}`;
const copy = (v) => JSON.parse(JSON.stringify(v));
const isRunning = (o) => o === 'running' || o === 'deliver_running';

/**
 * Create a nothing-owed scheduler. See index.d.ts for the full option and event types.
 */
export function createNothingOwed(options = {}) {
  const {
    delayMs = 5 * 60 * 1000,
    maxRechecks = 6,
    busyRetryMs = 60 * 1000,
    deliveredLookbackMs = 10 * 60 * 1000,
    maxReplies = 12,
    maxTextLength = 300,
    maxReportLength = 1500,
    jobTimeoutMs = 2 * 60 * 60 * 1000,
    retryMs = 5 * 60 * 1000,
    maxDeliveryAttempts = 12,
    missedLength = 120,
    userLabel = 'the user',
    store = createMemoryStore(),
    runTurn,
    deliver,
    getDelivered,
    isUserBusy,
    isPermanentError = () => false,
    onJobFinished,
    onEvent = noop,
    onUsage,
    failTexts = [],
    buildPrompt = defaultBuildPrompt,
    buildReportPrompt = defaultBuildReportPrompt,
    parseOutcome = parseCheckReply,
    now = () => Date.now(),
    setTimer = (fn, ms) => {
      const h = setTimeout(fn, ms);
      h.unref?.();
      return h;
    },
    clearTimer = (h) => clearTimeout(h),
  } = options;

  if (typeof runTurn !== 'function') throw new TypeError('nothing-owed: runTurn(conversationId, prompt) is required');
  if (typeof deliver !== 'function') throw new TypeError('nothing-owed: deliver(conversationId, text) is required');

  const deliveredLog = options.deliveredLog || createDeliveredLog({ now });
  const readDelivered = getDelivered || ((id, since) => deliveredLog.since(id, since));

  // Check records: state 'pending' (waits for due), 'running', or 'parked' (waits for jobs;
  // due is the job timeout).
  let records = [];
  let counters = {}; // conversationId -> messages so far
  let jobs = {}; // jobId -> open tracked job
  let outbox = []; // deliveries that failed and wait for a retry
  let missed = {}; // conversationId -> text of a delivery that was given up on
  let timer = null;
  let started = false;
  const delivering = new Set(); // conversations whose package-made reply is being delivered now
  const inflight = new Set();

  const emit = (event) => {
    try { onEvent({ at: now(), ...event }); } catch { /* a broken listener never breaks the loop */ }
  };

  const track = (p) => {
    inflight.add(p);
    return p.finally(() => inflight.delete(p));
  };

  const save = async () => {
    try {
      await store.save(copy({ version: STORE_VERSION, records, counters, jobs, outbox, missed }));
    } catch (error) {
      emit({ type: 'error', stage: 'store', error });
    }
  };

  const keepFirst = (list) => {
    if (list.length <= maxReplies) return list;
    if (maxReplies <= 1) return list.slice(0, 1);
    return [list[0], ...list.slice(-(maxReplies - 1))];
  };

  const find = (cid, state) => records.find((r) => r.conversationId === cid && r.state === state);
  const openJobIds = (cid) => Object.values(jobs).filter((j) => j.conversationId === cid).map((j) => j.id);
  const count = (cid) => (counters[cid] = (counters[cid] || 0) + 1);

  const arm = () => {
    if (timer != null) { clearTimer(timer); timer = null; }
    if (!started) return;
    let next = Infinity;
    for (const r of records) {
      if ((r.state === 'pending' || r.state === 'parked') && !find(r.conversationId, 'running') && r.due < next) next = r.due;
    }
    for (const o of outbox) if (!o.sending && o.due < next) next = o.due;
    if (next === Infinity) return;
    const wait = Math.min(Math.max(0, next - now()), MAX_TIMER_MS);
    timer = setTimer(() => { timer = null; api.tick(); }, wait);
  };

  // ---- delivery with retry ----------------------------------------------------------------

  const sendOnce = async (cid, text) => {
    delivering.add(cid);
    try {
      const res = await deliver(cid, text);
      count(cid);
      return { ids: res && typeof res === 'object' && Array.isArray(res.ids) ? res.ids : undefined };
    } finally {
      delivering.delete(cid);
    }
  };

  // Deliver a package-made text. Before it, a "Missed:" line for an earlier give-up, once.
  const sendWithMissed = async (cid, text) => {
    if (missed[cid] != null) {
      try {
        await sendOnce(cid, `Missed: ${missed[cid]}`);
        delete missed[cid];
        emit({ type: 'missed_notice', conversationId: cid });
      } catch (error) {
        emit({ type: 'error', stage: 'deliver', conversationId: cid, error });
      }
    }
    return sendOnce(cid, text);
  };

  // A delivery attempt failed: queue a retry or give up.
  const failDelivery = (item, error) => {
    const permanent = (() => { try { return !!isPermanentError(error); } catch { return false; } })();
    if (permanent || item.attempts >= maxDeliveryAttempts) {
      outbox = outbox.filter((o) => o !== item);
      missed[item.conversationId] = clip(item.text, missedLength);
      emit({ type: 'delivery_failed', conversationId: item.conversationId, kind: item.kind, checkId: item.checkId, jobId: item.jobId, attempts: item.attempts, permanent, error });
      return;
    }
    const wait = Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0 ? error.retryAfterMs : retryMs;
    item.due = now() + wait;
    if (!outbox.includes(item)) outbox.push(item);
    emit({ type: 'delivery_retry', conversationId: item.conversationId, kind: item.kind, checkId: item.checkId, jobId: item.jobId, attempt: item.attempts, retryInMs: wait, error });
  };

  // First attempt for a text the package produced (a check reply or a job report).
  // Resolves { ok, ids }. A failure is kept for retry; it never reaches runTurn again.
  const deliverOwed = async (cid, text, meta) => {
    try {
      const { ids } = await sendWithMissed(cid, text);
      return { ok: true, ids };
    } catch (error) {
      const item = { id: newId('out', now()), conversationId: cid, text, attempts: 1, due: 0, ...meta };
      failDelivery(item, error);
      return { ok: false };
    }
  };

  const retryDelivery = async (item) => {
    item.sending = true;
    item.attempts += 1;
    try {
      const { ids } = await sendWithMissed(item.conversationId, item.text);
      outbox = outbox.filter((o) => o !== item);
      emit({ type: 'delivery_recovered', conversationId: item.conversationId, kind: item.kind, checkId: item.checkId, jobId: item.jobId, attempt: item.attempts, ids });
    } catch (error) {
      failDelivery(item, error);
    } finally {
      delete item.sending;
    }
    await save();
    arm();
  };

  const usageOf = (res, ids) => {
    if (res && typeof res === 'object' && (res.usage || res.costUsd != null)) {
      const u = { ...ids, usage: res.usage ?? null, costUsd: res.costUsd ?? null };
      emit({ type: 'usage', ...u });
      try { onUsage?.(u); } catch { /* ignore */ }
    }
  };

  const parse = (text) => {
    const r = parseOutcome(text, { failTexts });
    if (typeof r === 'string') return { outcome: r, text: r === 'deliver_running' ? stripStillRunning(text) : String(text ?? '').trim() };
    return { outcome: r?.outcome ?? 'failed', text: r?.text ?? '' };
  };

  // ---- checks -----------------------------------------------------------------------------

  // Put a record (back) into pending, merging into whatever was scheduled meanwhile.
  const requeue = (rec, due, rechecks) => {
    const cur = find(rec.conversationId, 'pending');
    if (cur) {
      cur.replies = keepFirst([...rec.replies, ...cur.replies]);
      cur.rechecks = Math.max(cur.rechecks || 0, rechecks);
    } else {
      records.push({ ...rec, state: 'pending', due, rechecks, parkedOn: undefined, parkedAt: undefined, timedOut: undefined });
    }
  };

  const park = (rec, jobIds, { timedOut = false } = {}) => {
    const cur = find(rec.conversationId, 'parked');
    if (cur) {
      cur.replies = keepFirst([...cur.replies, ...rec.replies]);
      cur.parkedOn = [...new Set([...cur.parkedOn, ...jobIds])];
      emit({ type: 'parked', conversationId: cur.conversationId, checkId: cur.id, jobIds: cur.parkedOn, until: cur.due });
      return;
    }
    const t = now();
    const p = { ...rec, state: 'parked', parkedOn: jobIds, parkedAt: t, timedOut, due: t + jobTimeoutMs };
    records.push(p);
    emit({ type: 'parked', conversationId: p.conversationId, checkId: p.id, jobIds, until: p.due });
  };

  const unpark = (rec, jobId) => {
    emit({ type: 'unparked', conversationId: rec.conversationId, checkId: rec.id, jobId });
    const cur = find(rec.conversationId, 'pending');
    if (cur) {
      records = records.filter((r) => r !== rec);
      cur.replies = keepFirst([...rec.replies, ...cur.replies]);
      cur.rechecks = Math.max(cur.rechecks || 0, rec.rechecks || 0);
      cur.due = Math.min(cur.due, now());
    } else {
      rec.state = 'pending';
      rec.due = now();
      delete rec.parkedOn;
      delete rec.parkedAt;
      delete rec.timedOut;
    }
  };

  async function runCheck(rec, { timeout = false } = {}) {
    const cid = rec.conversationId;
    const t0 = now();
    const rechecks = rec.rechecks || 0;
    const finish = async (outcome) => {
      records = records.filter((r) => r !== rec);
      const open = openJobIds(cid);
      if (outcome === 'busy') {
        if (timeout) records.push({ ...rec, state: 'parked', due: now() + busyRetryMs });
        else requeue(rec, now() + busyRetryMs, rechecks);
      } else if (timeout) {
        if (open.length) park(rec, open, { timedOut: true });
      } else if (isRunning(outcome) && open.length) {
        park(rec, open);
      } else if (isRunning(outcome) && rechecks < maxRechecks) {
        requeue(rec, now() + delayMs, rechecks + 1);
      }
      await save();
      arm();
      return outcome;
    };

    try {
      if (isUserBusy && (await isUserBusy(cid))) {
        emit({ type: 'yielded', conversationId: cid, checkId: rec.id });
        return await finish('busy');
      }
    } catch (error) {
      emit({ type: 'error', stage: 'isUserBusy', conversationId: cid, error });
    }

    if (timeout) emit({ type: 'park_timeout', conversationId: cid, checkId: rec.id, jobIds: openJobIds(cid) });
    const isLastCheck = timeout || (rechecks >= maxRechecks && !openJobIds(cid).length);
    let outcome = 'failed';
    let body = '';
    let sent = null;
    try {
      const since = rec.replies[0].at - deliveredLookbackMs;
      const delivered = (await readDelivered(cid, since)) || [];
      const prompt = buildPrompt({ replies: rec.replies, delivered, isLastCheck, userLabel, maxTextLength, messageCount: counters[cid] || 0 });
      emit({ type: 'check_started', conversationId: cid, checkId: rec.id, replies: rec.replies.length, delivered: delivered.length, recheck: rechecks, isLastCheck });

      const res = await runTurn(cid, prompt, { kind: 'check', checkId: rec.id, recheck: rechecks, isLastCheck });
      const text = typeof res === 'string' ? res : res?.text ?? '';
      usageOf(res, { conversationId: cid, checkId: rec.id });

      ({ outcome, text: body } = parse(text));
      // On the last check there is nothing left to wait for: drop the marker, end the check.
      if (isLastCheck && outcome === 'running') outcome = 'nothing';
      if (isLastCheck && outcome === 'deliver_running') outcome = 'deliver';

      if (outcome === 'deliver' || outcome === 'deliver_running') {
        sent = await deliverOwed(cid, body, { kind: 'check', checkId: rec.id });
      }
    } catch (error) {
      outcome = 'failed';
      emit({ type: 'error', stage: 'check', conversationId: cid, checkId: rec.id, error });
    }

    const ms = now() - t0;
    if (outcome === 'nothing') emit({ type: 'nothing_owed', conversationId: cid, checkId: rec.id, ms });
    else if (outcome === 'running') emit({ type: 'still_running', conversationId: cid, checkId: rec.id, recheck: rechecks + 1, ms });
    else if (outcome === 'failed') emit({ type: 'failed', conversationId: cid, checkId: rec.id, ms });
    else if (sent?.ok) emit({ type: 'delivered', conversationId: cid, checkId: rec.id, chars: body.length, ms, ids: sent.ids, stillRunning: outcome === 'deliver_running' });
    return finish(outcome);
  }

  // ---- jobs -------------------------------------------------------------------------------

  async function runReport(job) {
    const cid = job.conversationId;
    try {
      const prompt = buildReportPrompt({ job, userLabel, maxTextLength: maxReportLength });
      const res = await runTurn(cid, prompt, { kind: 'report', jobId: job.id, checkId: null, recheck: 0, isLastCheck: false });
      const text = typeof res === 'string' ? res : res?.text ?? '';
      usageOf(res, { conversationId: cid, checkId: null, jobId: job.id });
      const { outcome, text: body } = parse(text);
      if (outcome === 'failed' || outcome === 'nothing' || outcome === 'running') {
        emit({ type: 'report_skipped', conversationId: cid, jobId: job.id, reason: outcome });
        return;
      }
      const sent = await deliverOwed(cid, body, { kind: 'report', jobId: job.id });
      if (sent.ok) emit({ type: 'report_delivered', conversationId: cid, jobId: job.id, chars: body.length, ids: sent.ids });
    } catch (error) {
      emit({ type: 'error', stage: 'report', conversationId: cid, jobId: job.id, error });
    }
  }

  async function afterJob(job) {
    const cid = job.conversationId;
    if (typeof onJobFinished === 'function') {
      try { await onJobFinished(cid, { ...job }); } catch (error) { emit({ type: 'error', stage: 'onJobFinished', conversationId: cid, jobId: job.id, error }); }
    } else {
      await runReport(job);
    }
    let any = false;
    for (const r of records.filter((x) => x.state === 'parked' && x.conversationId === cid && x.parkedOn?.includes(job.id))) {
      r.parkedOn = r.parkedOn.filter((id) => jobs[id]);
      if (r.parkedOn.length) continue;
      unpark(r, job.id);
      any = true;
    }
    await save();
    arm();
    if (any) await api.tick();
  }

  const api = {
    /**
     * The agent sent `text` to the user in `conversationId`. Opens that conversation's check
     * window if none is pending; otherwise joins it (the due time never moves). Replies of kind
     * 'check', 'report' or 'system' never schedule; 'check' and 'report' still count as messages.
     */
    noteReply(conversationId, text, { kind, at } = {}) {
      const cid = String(conversationId);
      if (delivering.has(cid)) return null; // the package's own reply, routed back through the host: already counted
      if (kind !== 'system') count(cid);
      if (kind && SKIP_KINDS.has(kind)) { void save(); return null; }
      const t = at ?? now();
      const reply = { at: t, text: clip(text, maxTextLength), seq: counters[cid] };
      let rec = find(cid, 'pending');
      if (rec) {
        rec.replies = keepFirst([...rec.replies, reply]);
        emit({ type: 'merged', conversationId: cid, checkId: rec.id, replies: rec.replies.length, due: rec.due });
      } else {
        rec = { id: newId('chk', t), conversationId: cid, state: 'pending', due: t + delayMs, replies: [reply], rechecks: 0 };
        records.push(rec);
        emit({ type: 'scheduled', conversationId: cid, checkId: rec.id, due: rec.due });
      }
      void save();
      arm();
      return { ...rec, replies: rec.replies.slice() };
    },

    /** The user sent a message in `conversationId`. Returns the conversation's message count. */
    noteUserMessage(conversationId) {
      const n = count(String(conversationId));
      void save();
      return n;
    },

    /** Messages counted so far in one conversation. */
    messageCount(conversationId) {
      return counters[String(conversationId)] || 0;
    },

    /** A message really reached the user (built-in delivered log). Ignored if you pass getDelivered. */
    noteDelivered(conversationId, text, atOrOpts) {
      const opts = typeof atOrOpts === 'number' ? { at: atOrOpts } : atOrOpts || {};
      return deliveredLog.note(conversationId, text, opts);
    },

    /** The host started long work for this conversation. A STILL_RUNNING check parks on it. */
    trackJob(conversationId, jobId, { title } = {}) {
      const id = String(jobId);
      const job = { id, conversationId: String(conversationId), title: title ?? id, startedAt: now() };
      jobs[id] = job;
      emit({ type: 'job_tracked', conversationId: job.conversationId, jobId: id, title: job.title });
      void save();
      return { ...job };
    },

    /**
     * Tracked work ended. Runs onJobFinished, or one report turn delivered to the user, then any
     * check parked on it (once no other job it waits for is open). Resolves when all that is done.
     */
    finishJob(jobId, { status = 'done', text = '' } = {}) {
      const id = String(jobId);
      const open = jobs[id];
      if (!open) return Promise.resolve(null);
      delete jobs[id];
      const job = { ...open, status, text: String(text ?? ''), finishedAt: now() };
      emit({ type: 'job_finished', conversationId: job.conversationId, jobId: id, status });
      return track((async () => {
        await save();
        await afterJob(job);
        return { ...job };
      })());
    },

    /** trackJob, await the work, finishJob with its result (or error message), return the result. */
    async wrapJob(conversationId, jobId, work, { title } = {}) {
      api.trackJob(conversationId, jobId, { title });
      let result;
      try {
        result = await (typeof work === 'function' ? work() : work);
      } catch (error) {
        await api.finishJob(jobId, { status: 'error', text: error?.message ?? String(error) });
        throw error;
      }
      let text = '';
      if (typeof result === 'string') text = result;
      else if (typeof result?.text === 'string') text = result.text;
      else if (result != null) { try { text = JSON.stringify(result); } catch { text = String(result); } }
      await api.finishJob(jobId, { status: 'done', text });
      return result;
    },

    /** Load persisted state and arm the timer. Checks that were running at a stop run again. */
    async start() {
      if (started) return api;
      const raw = (await store.load()) || [];
      const state = Array.isArray(raw) ? { records: raw } : raw; // v0.1 stores held a plain array
      for (const [k, v] of Object.entries(state.counters || {})) counters[k] = Math.max(counters[k] || 0, v);
      for (const [k, v] of Object.entries(state.jobs || {})) if (!jobs[k]) jobs[k] = v;
      for (const [k, v] of Object.entries(state.missed || {})) if (missed[k] == null) missed[k] = v;
      const seenOut = new Set(outbox.map((o) => o.id));
      for (const o of state.outbox || []) if (!seenOut.has(o.id)) outbox.push({ ...o, sending: undefined });
      const seen = new Set(records.map((r) => r.id));
      for (const r of state.records || []) {
        if (seen.has(r.id)) continue;
        if (r.state === 'parked') {
          const parkedOn = (r.parkedOn || []).filter((id) => jobs[id]);
          if (parkedOn.length || r.timedOut) { records.push({ ...r, parkedOn }); continue; }
          // Its jobs ended while the process was down: run it now.
          records.push({ ...r, state: 'parked', parkedOn: [] });
          unpark(records[records.length - 1], null);
          continue;
        }
        const rec = { ...r, state: 'pending', rechecks: r.rechecks || 0 };
        const cur = find(rec.conversationId, 'pending');
        if (cur) cur.replies = keepFirst([...rec.replies, ...cur.replies]);
        else records.push(rec);
      }
      started = true;
      await save();
      arm();
      emit({ type: 'started', pending: records.filter((r) => r.state === 'pending').length, parked: records.filter((r) => r.state === 'parked').length, jobs: Object.keys(jobs).length, outbox: outbox.length });
      return api;
    },

    /** Stop the timer. Work already running finishes; the rest stays in the store. */
    stop() {
      started = false;
      if (timer != null) { clearTimer(timer); timer = null; }
      emit({ type: 'stopped' });
    },

    /** Run every check and delivery retry that is due now. Resolves with the checks' outcomes. */
    async tick() {
      const t = now();
      const due = records.filter((r) => (r.state === 'pending' || r.state === 'parked') && r.due <= t && !find(r.conversationId, 'running'));
      const retries = outbox.filter((o) => !o.sending && o.due <= t);
      if (!due.length && !retries.length) { arm(); return []; }
      const runs = [];
      for (const r of due) {
        if (r.state === 'parked' && r.timedOut) {
          records = records.filter((x) => x !== r);
          emit({ type: 'park_ended', conversationId: r.conversationId, checkId: r.id, jobIds: r.parkedOn || [] });
          continue;
        }
        const timeout = r.state === 'parked';
        r.state = 'running';
        runs.push(() => runCheck(r, { timeout }));
      }
      for (const o of retries) o.sending = true;
      await save();
      arm();
      for (const o of retries) void track(retryDelivery(o));
      return Promise.all(runs.map((fn) => track(fn())));
    },

    /** Wait for every running check, report and retry to finish. */
    async idle() {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },

    /** Copies of the pending checks. */
    pending() {
      return records.filter((r) => r.state === 'pending').map((r) => ({ ...r, replies: r.replies.slice() }));
    },

    /** Copies of the checks parked on open jobs. */
    parked() {
      return records.filter((r) => r.state === 'parked').map((r) => ({ ...r, replies: r.replies.slice(), parkedOn: (r.parkedOn || []).slice() }));
    },

    /** Copies of the open tracked jobs. */
    jobs() {
      return Object.values(jobs).map((j) => ({ ...j }));
    },

    /** Copies of the deliveries waiting for a retry. */
    outbox() {
      return outbox.map(({ sending, ...o }) => ({ ...o }));
    },

    deliveredLog,
  };
  return api;
}
