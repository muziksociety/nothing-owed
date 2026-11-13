// The scheduler: one fixed-window timer per conversation, a self-audit turn against the host's
// own send log when it fires, verify checks on the package's own deliveries, dated timers, job
// tracking for long work, report turns with a code-written fallback, and delivery retry.
// Code holds every alarm; the model is only woken to judge and to write.
import {
  buildPrompt as defaultBuildPrompt,
  buildReportPrompt as defaultBuildReportPrompt,
  parseCheckReply,
  clipText,
} from './outcome.js';
import { createMemoryStore } from './stores.js';
import { createDeliveredLog } from './delivered-log.js';

const VERIFY_KINDS = new Set(['check', 'report']); // replies the user saw that may hold a promise
const CODE_KINDS = new Set(['giveup', 'fallback', 'missed']); // code-written lines: no promise in them
const MAX_TIMER_MS = 2 ** 31 - 1;
const STORE_VERSION = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const ECHO_MS = 60 * 1000; // a package delivery routed back through noteReply within this long is an echo
const OWN_KEEP = 20;
const LOST_TEXT = 'the work was interrupted by a restart';

const noop = () => {};
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const rand = () => Math.random().toString(36).slice(2, 8);
const newId = (prefix, t) => `${prefix}_${t.toString(36)}${rand()}`;
const copy = (v) => JSON.parse(JSON.stringify(v));
const isRunning = (o) => o === 'running' || o === 'deliver_running';
const byDue = (a, b) => a.due - b.due;

/** The default give-up line. `reason` is 'failed' (checks kept failing) or 'still_running'. */
export function defaultGiveUpText({ reason } = {}) {
  if (reason === 'still_running') return 'Something I promised you earlier is still running, and I am no longer watching it. Ask me again if it is still open.';
  return 'I could not check on what I promised you earlier. Ask me again if it is still open.';
}

/** The code-written report for a job whose report turn failed or declined: "<title> <status>: <first line>". */
export function fallbackReportText(job) {
  const line = String(job?.text ?? '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  const head = `${job?.title || job?.id} ${job?.status || 'done'}`;
  return line ? `${head}: ${line.slice(0, 300)}` : `${head}.`;
}

/**
 * Create a nothing-owed scheduler. See index.d.ts for the full option and event types.
 */
export function createNothingOwed(options = {}) {
  const {
    delayMs = 5 * 60 * 1000,
    maxRechecks = 6,
    backoffMs = [15, 30, 60, 120].map((m) => m * 60 * 1000),
    busyRetryMs = 60 * 1000,
    deliveredLookbackMs = 10 * 60 * 1000,
    maxReplies = 12,
    maxTextLength = 300,
    maxReportLength = 1500,
    maxDeliveredInPrompt = 40,
    jobTimeoutMs = 2 * 60 * 60 * 1000,
    turnTimeoutMs = 3 * 60 * 1000,
    maxVerifyDepth = 3,
    maxDueMs = 30 * DAY_MS,
    maxConcurrent = 2,
    dailyCap = 60,
    retryMs = 5 * 60 * 1000,
    maxDeliveryAttempts = 12,
    userLabel = 'the user',
    store = createMemoryStore(),
    runTurn,
    deliver,
    getDelivered,
    isUserBusy,
    isPermanentError = () => false,
    onJobFinished,
    onStartJobs,
    giveUpText = defaultGiveUpText,
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

  // Timed rechecks: maxRechecks at delayMs, then one per back-off step. The last one asks for a status.
  const totalRechecks = maxRechecks + backoffMs.length;
  const recheckDelay = (done) => (done < maxRechecks ? delayMs : backoffMs[done - maxRechecks]);
  const slots = maxConcurrent > 0 ? maxConcurrent : Infinity;

  const deliveredLog = options.deliveredLog || createDeliveredLog({ now });
  const readDelivered = getDelivered || ((id, since) => deliveredLog.since(id, since));

  // Check records: state 'pending' (one per conversation, waits for due), 'running', 'parked'
  // (waits for jobs; due is the job timeout) or 'dated' (a DUE timer; any number per conversation).
  let records = [];
  let reports = []; // finished jobs whose report turn is still owed
  let counters = {}; // conversationId -> messages so far
  let jobs = {}; // jobId -> open tracked job
  let outbox = []; // deliveries that failed and wait for a retry
  let missed = {}; // conversationId -> full texts of deliveries that were given up on
  let turnsByDay = {}; // conversationId -> { day, n } model turns today
  let timer = null;
  let started = false;
  const inflight = new Set();
  const own = new Map(); // conversationId -> recent package deliveries [{ text, at, done }]
  let active = 0;
  const waiters = [];

  const emit = (event) => {
    try { onEvent({ at: now(), ...event }); } catch { /* a broken listener never breaks the loop */ }
  };

  const track = (p) => {
    inflight.add(p);
    return p.finally(() => inflight.delete(p));
  };

  const save = async () => {
    const today = Math.floor(now() / DAY_MS);
    for (const [k, v] of Object.entries(turnsByDay)) if (v.day < today) delete turnsByDay[k];
    try {
      await store.save(copy({ version: STORE_VERSION, records, reports, counters, jobs, outbox, missed, turnsByDay }));
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
  const convBusy = (cid) =>
    records.some((r) => r.conversationId === cid && r.state === 'running') || reports.some((p) => p.conversationId === cid && p.state === 'running');
  const openJobIds = (cid) => Object.values(jobs).filter((j) => j.conversationId === cid).map((j) => j.id);
  const count = (cid) => (counters[cid] = (counters[cid] || 0) + 1);
  const recCopy = (r) => ({ ...r, replies: r.replies.slice(), ...(r.parkedOn ? { parkedOn: r.parkedOn.slice() } : {}) });

  const arm = () => {
    if (timer != null) { clearTimer(timer); timer = null; }
    if (!started) return;
    let next = Infinity;
    for (const r of records) {
      if ((r.state === 'pending' || r.state === 'parked' || r.state === 'dated') && r.due < next && !convBusy(r.conversationId)) next = r.due;
    }
    for (const p of reports) if (p.state === 'pending' && p.due < next && !convBusy(p.conversationId)) next = p.due;
    for (const o of outbox) if (!o.sending && o.due < next) next = o.due;
    if (next === Infinity) return;
    const wait = Math.min(Math.max(0, next - now()), MAX_TIMER_MS);
    timer = setTimer(() => { timer = null; void track(api.tick()); }, wait);
  };

  // ---- model turns: a shared slot pool, a daily cap, a timeout --------------------------------

  const acquire = () => {
    if (active < slots) { active++; return Promise.resolve(); }
    return new Promise((resolve) => waiters.push(resolve));
  };
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else active--;
  };

  const nextDay = () => (Math.floor(now() / DAY_MS) + 1) * DAY_MS;
  const spendTurn = (cid) => {
    const day = Math.floor(now() / DAY_MS);
    let u = turnsByDay[cid];
    if (!u || u.day !== day) u = turnsByDay[cid] = { day, n: 0 };
    if (dailyCap > 0 && u.n >= dailyCap) return false;
    u.n++;
    return true;
  };

  const callTurn = async (cid, prompt, ctx) => {
    const ac = new AbortController();
    const limit = turnTimeoutMs > 0 && Number.isFinite(turnTimeoutMs) ? Math.min(turnTimeoutMs, MAX_TIMER_MS) : 0;
    let handle = null;
    const run = Promise.resolve().then(() => runTurn(cid, prompt, { ...ctx, signal: ac.signal }));
    run.catch(noop);
    if (!limit) return run;
    const timeout = new Promise((_, reject) => {
      handle = setTimer(() => {
        handle = null;
        const error = new Error(`nothing-owed: the ${ctx.kind} turn timed out after ${turnTimeoutMs} ms`);
        error.code = 'TURN_TIMEOUT';
        emit({ type: 'turn_timeout', conversationId: cid, kind: ctx.kind, checkId: ctx.checkId, jobId: ctx.jobId });
        try { ac.abort(error); } catch { /* ignore */ }
        reject(error);
      }, limit);
    });
    try {
      return await Promise.race([run, timeout]);
    } finally {
      if (handle != null) clearTimer(handle);
    }
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
    if (typeof r === 'string') {
      if (r === 'deliver' || r === 'deliver_running' || r === 'due') {
        const full = parseCheckReply(text, { failTexts });
        if (full.outcome === r) return full;
        return { outcome: r === 'due' ? 'deliver' : r, text: String(text ?? '').trim() };
      }
      return { outcome: r, text: '' };
    }
    return { outcome: r?.outcome ?? 'failed', text: r?.text ?? '', dueAt: r?.dueAt };
  };

  // ---- delivery with retry ----------------------------------------------------------------

  const ownAdd = (cid, text) => {
    const e = { text: flat(text), at: now(), done: false };
    const arr = own.get(cid) || [];
    arr.push(e);
    if (arr.length > OWN_KEEP) arr.shift();
    own.set(cid, arr);
    return e;
  };
  const ownDrop = (cid, e) => own.set(cid, (own.get(cid) || []).filter((x) => x !== e));
  const isEcho = (cid, text) => {
    const f = flat(text);
    return (own.get(cid) || []).some((e) => e.text === f && (!e.done || now() - e.at <= ECHO_MS));
  };

  // One send. On success the package counts it and logs it in the built-in delivered log.
  const sendOnce = async (cid, text, meta) => {
    const e = ownAdd(cid, text);
    let res;
    try {
      res = await deliver(cid, text, { kind: meta.kind, checkId: meta.checkId ?? null, jobId: meta.jobId ?? null });
    } catch (error) {
      ownDrop(cid, e);
      throw error;
    }
    e.done = true;
    e.at = now();
    count(cid);
    try { deliveredLog.note(cid, text); } catch (error) { emit({ type: 'error', stage: 'deliveredLog', conversationId: cid, error }); }
    return { ids: res && typeof res === 'object' && Array.isArray(res.ids) ? res.ids : undefined };
  };

  // Send every "Missed:" notice still owed in this conversation. Resolves false if one failed.
  const sendMissed = async (cid) => {
    while (missed[cid]?.length) {
      const text = missed[cid][0];
      try {
        await sendOnce(cid, `Missed: ${text}`, { kind: 'missed' });
      } catch (error) {
        emit({ type: 'error', stage: 'deliver', conversationId: cid, error });
        return false;
      }
      if (missed[cid]?.[0] === text) missed[cid].shift();
      emit({ type: 'missed_notice', conversationId: cid });
    }
    if (missed[cid] && !missed[cid].length) delete missed[cid];
    return true;
  };

  const sendWithMissed = async (cid, text, meta) => {
    await sendMissed(cid);
    return sendOnce(cid, text, meta);
  };

  const outboxIds = (item) => ({ conversationId: item.conversationId, kind: item.kind, checkId: item.checkId, jobId: item.jobId });

  // A delivery attempt failed: queue a retry or give up.
  const failDelivery = (item, error) => {
    const permanent = (() => { try { return !!isPermanentError(error); } catch { return false; } })();
    if (permanent || item.attempts >= maxDeliveryAttempts) {
      outbox = outbox.filter((o) => o !== item);
      (missed[item.conversationId] ||= []).push(item.text);
      emit({ type: 'delivery_failed', ...outboxIds(item), attempts: item.attempts, permanent, error });
      // A fresh check: it sends the Missed notice first, then judges what is still owed. Not
      // after a permanent error (a blocked user, a deleted chat): the host gets flushMissed().
      if (!permanent) scheduleVerify(item.conversationId, item.text, (item.depth || 0) + 1);
      return;
    }
    const wait = Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0 ? error.retryAfterMs : retryMs;
    item.due = now() + wait;
    if (!outbox.includes(item)) outbox.push(item);
    emit({ type: 'delivery_retry', ...outboxIds(item), attempt: item.attempts, retryInMs: wait, error });
  };

  // First attempt for a text the package produced. Resolves { ok, ids }. A failure is kept for
  // retry; it never reaches runTurn again.
  const deliverOwed = async (cid, text, meta) => {
    try {
      const { ids } = await sendWithMissed(cid, text, meta);
      return { ok: true, ids };
    } catch (error) {
      const item = { id: newId('out', now()), conversationId: cid, text, attempts: 1, due: 0, at: now(), ...meta };
      failDelivery(item, error);
      return { ok: false };
    }
  };

  const retryDelivery = async (item) => {
    item.sending = true;
    item.attempts += 1;
    try {
      const { ids } = await sendWithMissed(item.conversationId, item.text, item);
      outbox = outbox.filter((o) => o !== item);
      emit({ type: 'delivery_recovered', ...outboxIds(item), attempt: item.attempts, ids });
      if (VERIFY_KINDS.has(item.kind)) scheduleVerify(item.conversationId, item.text, (item.depth || 0) + 1);
    } catch (error) {
      failDelivery(item, error);
    } finally {
      delete item.sending;
    }
    await save();
    arm();
  };

  const giveUp = async (cid, reason, ids) => {
    let text;
    try { text = giveUpText({ conversationId: cid, reason, ...ids }); } catch { text = defaultGiveUpText({ reason }); }
    text = String(text ?? '').trim();
    if (!text) return;
    const sent = await deliverOwed(cid, text, { kind: 'giveup', ...ids });
    emit({ type: 'gave_up', conversationId: cid, reason, ...ids, delivered: sent.ok });
  };

  // An exact copy of something already delivered, queued or missed is never sent twice.
  const isDuplicate = (cid, body, delivered, since) => {
    const f = flat(body);
    if (!f) return false;
    const same = (t) => { const x = flat(t); return x === f || x === `Missed: ${f}`; };
    if (outbox.some((o) => o.conversationId === cid && same(o.text))) return true;
    if ((missed[cid] || []).some(same)) return true;
    if ((delivered || []).some((d) => same(d.text))) return true;
    return (own.get(cid) || []).some((e) => e.done && e.at >= since && same(e.text));
  };

  // ---- check records ----------------------------------------------------------------------

  // Put a record (back) into pending, merging into whatever was scheduled meanwhile.
  const requeue = (rec, due, rechecks) => {
    const cur = find(rec.conversationId, 'pending');
    if (cur) {
      cur.replies = keepFirst([...rec.replies, ...cur.replies]);
      cur.rechecks = Math.max(cur.rechecks || 0, rechecks);
      cur.depth = Math.max(cur.depth || 0, rec.depth || 0);
    } else {
      records.push({ ...rec, state: 'pending', due, rechecks, parkedOn: undefined, parkedAt: undefined, timedOut: undefined });
    }
  };

  // One follow-up check on a reply the user saw that may itself hold a promise.
  const scheduleVerify = (cid, text, depth, at) => {
    if (depth > maxVerifyDepth) {
      emit({ type: 'verify_capped', conversationId: cid, depth });
      return null;
    }
    const t = at ?? now();
    const reply = { at: t, text: clipText(text, maxTextLength), seq: counters[cid] };
    let rec = find(cid, 'pending');
    if (rec) {
      rec.replies = keepFirst([...rec.replies, reply]);
      rec.depth = Math.max(rec.depth || 0, depth);
    } else {
      rec = { id: newId('chk', t), conversationId: cid, state: 'pending', kind: 'verify', due: t + delayMs, replies: [reply], rechecks: 0, depth };
      records.push(rec);
    }
    emit({ type: 'verify_scheduled', conversationId: cid, checkId: rec.id, depth, due: rec.due });
    return rec;
  };

  // A DUE timer: at that time, a check runs with the replies that made the promise.
  const addDated = (rec, dueAt) => {
    const cid = rec.conversationId;
    const cur = records.find((r) => r.conversationId === cid && r.state === 'dated' && Math.abs(r.due - dueAt) <= ECHO_MS);
    if (cur) {
      const seen = new Set(cur.replies.map((x) => `${x.at}|${x.text}`));
      cur.replies = keepFirst([...cur.replies, ...rec.replies.filter((x) => !seen.has(`${x.at}|${x.text}`))]);
      emit({ type: 'dated', conversationId: cid, checkId: cur.id, due: cur.due });
      return;
    }
    const d = { id: newId('due', now()), conversationId: cid, state: 'dated', kind: 'due', due: dueAt, dueAt, replies: rec.replies.slice(), rechecks: 0, depth: rec.depth || 0 };
    records.push(d);
    emit({ type: 'dated', conversationId: cid, checkId: d.id, due: dueAt });
  };

  const validDue = (dueAt) => Number.isFinite(dueAt) && dueAt > now() && dueAt - now() <= maxDueMs;

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
      cur.depth = Math.max(cur.depth || 0, rec.depth || 0);
      cur.due = Math.min(cur.due, now());
    } else {
      rec.state = 'pending';
      rec.due = now();
      delete rec.parkedOn;
      delete rec.parkedAt;
      delete rec.timedOut;
    }
  };

  const unparkFor = (job) => {
    for (const r of records.filter((x) => x.state === 'parked' && x.conversationId === job.conversationId && x.parkedOn?.includes(job.id))) {
      r.parkedOn = r.parkedOn.filter((id) => jobs[id]);
      if (!r.parkedOn.length) unpark(r, job.id);
    }
  };

  const reasonOf = (rec, timeout) => {
    if (timeout) return 'park_timeout';
    if ((rec.rechecks || 0) > 0) return 'recheck';
    if (rec.kind === 'verify') return 'verify';
    if (rec.kind === 'due') return 'due';
    return 'window';
  };

  async function runCheck(rec, { timeout = false, from = 'pending' } = {}) {
    const cid = rec.conversationId;
    const t0 = now();
    const rechecks = rec.rechecks || 0;
    const verifies = []; // [text, depth] for deliveries that landed
    let datedAt = null;

    const finish = async (outcome) => {
      records = records.filter((r) => r !== rec);
      const open = openJobIds(cid);
      const unresolved = isRunning(outcome) || outcome === 'failed';
      if (outcome === 'busy' || outcome === 'capped') {
        const later = outcome === 'busy' ? now() + busyRetryMs : nextDay();
        if (from === 'parked' || from === 'dated') records.push({ ...rec, state: from, due: later });
        else requeue(rec, later, rechecks);
      } else if (timeout) {
        if (open.length) park(rec, open, { timedOut: true });
      } else if (unresolved && open.length) {
        park(rec, open);
      } else if (unresolved && rechecks < totalRechecks) {
        requeue(rec, now() + recheckDelay(rechecks), rechecks + 1);
      }
      if (datedAt != null) addDated(rec, datedAt);
      for (const [text, depth] of verifies) scheduleVerify(cid, text, depth);
      await save();
      arm();
      return outcome;
    };

    await acquire();
    let held = true;
    const free = () => { if (held) { held = false; release(); } };
    try {
      if (isUserBusy) {
        let busy = false;
        try { busy = !!(await isUserBusy(cid)); } catch (error) { emit({ type: 'error', stage: 'isUserBusy', conversationId: cid, error }); }
        if (busy) {
          free();
          emit({ type: 'yielded', conversationId: cid, checkId: rec.id });
          return await finish('busy');
        }
      }
      if (!spendTurn(cid)) {
        free();
        emit({ type: 'daily_cap', conversationId: cid, checkId: rec.id, until: nextDay() });
        return await finish('capped');
      }
      if (missed[cid]?.length) await sendMissed(cid);
      if (timeout) emit({ type: 'park_timeout', conversationId: cid, checkId: rec.id, jobIds: openJobIds(cid) });

      const isLastCheck = timeout || (rechecks >= totalRechecks && !openJobIds(cid).length);
      const reason = reasonOf(rec, timeout);
      const since = (rec.replies[0]?.at ?? now()) - deliveredLookbackMs;
      let outcome = 'failed';
      let body = '';
      let dueAt;
      let sent = null;
      try {
        // Built now, after every wait, so the lists are current.
        const delivered = (await readDelivered(cid, since)) || [];
        const queued = [
          ...outbox.filter((o) => o.conversationId === cid).map((o) => ({ at: o.at ?? now(), text: o.text })),
          ...(missed[cid] || []).map((text) => ({ at: now(), text })),
        ];
        const prompt = buildPrompt({
          replies: rec.replies, delivered, queued, isLastCheck, userLabel, maxTextLength,
          maxDelivered: maxDeliveredInPrompt, messageCount: counters[cid] || 0, now: now(), reason, dueAt: rec.dueAt,
        });
        emit({ type: 'check_started', conversationId: cid, checkId: rec.id, replies: rec.replies.length, delivered: delivered.length, recheck: rechecks, isLastCheck, reason });

        let res;
        try {
          res = await callTurn(cid, prompt, { kind: 'check', checkId: rec.id, recheck: rechecks, isLastCheck, reason });
        } finally {
          free();
        }
        const text = typeof res === 'string' ? res : res?.text ?? '';
        usageOf(res, { conversationId: cid, checkId: rec.id });

        ({ outcome, text: body, dueAt } = parse(text));
        if (outcome === 'due' && !validDue(dueAt)) outcome = body ? 'deliver_running' : 'running';
        // On the last check there is nothing left to wait for.
        if (isLastCheck && outcome === 'deliver_running') outcome = 'deliver';
        const carries = outcome === 'deliver' || outcome === 'deliver_running' || outcome === 'due';
        if (carries && body && isDuplicate(cid, body, delivered, since)) {
          emit({ type: 'duplicate_skipped', conversationId: cid, checkId: rec.id, chars: body.length });
          body = '';
          if (outcome === 'deliver') outcome = 'nothing';
          if (outcome === 'deliver_running') outcome = 'running';
        }
        if (carries && body) {
          sent = await deliverOwed(cid, body, { kind: 'check', checkId: rec.id, depth: rec.depth || 0 });
          // A last-check status says the work is no longer watched: no verify after it.
          if (sent.ok && !isLastCheck) verifies.push([body, (rec.depth || 0) + 1]);
        }
        if (outcome === 'due') datedAt = dueAt;
      } catch (error) {
        outcome = 'failed';
        emit({ type: 'error', stage: 'check', conversationId: cid, checkId: rec.id, error });
      }
      free();

      // The last check ended without an answer for the user: code tells them plainly.
      if (isLastCheck && (outcome === 'failed' || outcome === 'running')) {
        await giveUp(cid, outcome === 'failed' ? 'failed' : 'still_running', { checkId: rec.id });
      }

      const ms = now() - t0;
      if (outcome === 'nothing') emit({ type: 'nothing_owed', conversationId: cid, checkId: rec.id, ms });
      else if (outcome === 'running') emit({ type: 'still_running', conversationId: cid, checkId: rec.id, recheck: rechecks + 1, ms });
      else if (outcome === 'failed') emit({ type: 'failed', conversationId: cid, checkId: rec.id, recheck: rechecks + 1, ms });
      if (sent?.ok) emit({ type: 'delivered', conversationId: cid, checkId: rec.id, chars: body.length, ms, ids: sent.ids, stillRunning: outcome === 'deliver_running' });
      return await finish(outcome);
    } finally {
      free();
    }
  }

  // ---- jobs and report turns --------------------------------------------------------------

  async function reportFallback(rep, reason) {
    const text = fallbackReportText(rep.job);
    const sent = await deliverOwed(rep.conversationId, text, { kind: 'fallback', jobId: rep.job.id });
    emit({ type: 'report_fallback', conversationId: rep.conversationId, jobId: rep.job.id, reason, delivered: sent.ok });
  }

  async function reportDone(rep) {
    reports = reports.filter((x) => x !== rep);
    unparkFor(rep.job);
    await save();
    arm();
    await api.tick();
    return 'report';
  }

  async function runReport(rep) {
    const cid = rep.conversationId;
    const job = rep.job;
    await acquire();
    let held = true;
    const free = () => { if (held) { held = false; release(); } };
    try {
      if (isUserBusy) {
        let busy = false;
        try { busy = !!(await isUserBusy(cid)); } catch (error) { emit({ type: 'error', stage: 'isUserBusy', conversationId: cid, error }); }
        if (busy) {
          free();
          rep.state = 'pending';
          rep.due = now() + busyRetryMs;
          emit({ type: 'yielded', conversationId: cid, checkId: null, jobId: job.id });
          await save();
          arm();
          return 'busy';
        }
      }
      if (!spendTurn(cid)) {
        free();
        emit({ type: 'daily_cap', conversationId: cid, checkId: null, jobId: job.id, until: nextDay() });
        await reportFallback(rep, 'capped');
        return await reportDone(rep);
      }
      if (missed[cid]?.length) await sendMissed(cid);

      let outcome = 'failed';
      let body = '';
      let dueAt;
      try {
        const prompt = buildReportPrompt({ job, userLabel, maxTextLength: maxReportLength });
        let res;
        try {
          res = await callTurn(cid, prompt, { kind: 'report', jobId: job.id, checkId: null, recheck: rep.attempts || 0, isLastCheck: false, reason: 'report' });
        } finally {
          free();
        }
        const text = typeof res === 'string' ? res : res?.text ?? '';
        usageOf(res, { conversationId: cid, checkId: null, jobId: job.id });
        ({ outcome, text: body, dueAt } = parse(text));
      } catch (error) {
        outcome = 'failed';
        emit({ type: 'error', stage: 'report', conversationId: cid, jobId: job.id, error });
      }
      free();

      if (outcome === 'failed') {
        rep.attempts = (rep.attempts || 0) + 1;
        if (rep.attempts <= totalRechecks) {
          rep.state = 'pending';
          rep.due = now() + recheckDelay(rep.attempts - 1);
          emit({ type: 'report_retry', conversationId: cid, jobId: job.id, attempt: rep.attempts, due: rep.due });
          await save();
          arm();
          return 'failed';
        }
        await reportFallback(rep, 'failed');
        return await reportDone(rep);
      }

      if (outcome === 'due' && validDue(dueAt)) {
        addDated({ conversationId: cid, replies: [{ at: now(), text: clipText(body || fallbackReportText(job), maxTextLength), seq: counters[cid] }], depth: 0 }, dueAt);
      }
      const carries = (outcome === 'deliver' || outcome === 'deliver_running' || outcome === 'due') && body;
      if (!carries) {
        await reportFallback(rep, outcome);
      } else if (isDuplicate(cid, body, [], -Infinity)) {
        emit({ type: 'duplicate_skipped', conversationId: cid, checkId: null, jobId: job.id, chars: body.length });
      } else {
        const sent = await deliverOwed(cid, body, { kind: 'report', jobId: job.id, depth: 0 });
        if (sent.ok) {
          emit({ type: 'report_delivered', conversationId: cid, jobId: job.id, chars: body.length, ids: sent.ids });
          scheduleVerify(cid, body, 1);
        }
      }
      return await reportDone(rep);
    } finally {
      free();
    }
  }

  const api = {
    /**
     * The agent sent `text` to the user in `conversationId`. Opens that conversation's check
     * window if none is pending; otherwise joins it (the due time never moves). Kinds 'check' and
     * 'report' (replies the host delivered itself) count and get one verify check; 'giveup',
     * 'fallback' and 'missed' only count; 'system' does neither. A package delivery routed back
     * here is recognized and ignored (it is already counted and verified).
     */
    noteReply(conversationId, text, { kind, at } = {}) {
      const cid = String(conversationId);
      if (isEcho(cid, text)) return null;
      if (kind === 'system') return null;
      count(cid);
      if (kind && CODE_KINDS.has(kind)) { void save(); return null; }
      if (kind && VERIFY_KINDS.has(kind)) {
        const rec = scheduleVerify(cid, text, 1, at);
        void save();
        arm();
        return rec ? recCopy(rec) : null;
      }
      const t = at ?? now();
      const reply = { at: t, text: clipText(text, maxTextLength), seq: counters[cid] };
      let rec = find(cid, 'pending');
      if (rec) {
        rec.replies = keepFirst([...rec.replies, reply]);
        if (rec.kind === 'verify') rec.kind = 'window'; // a new reply joined: it is a window check now
        emit({ type: 'merged', conversationId: cid, checkId: rec.id, replies: rec.replies.length, due: rec.due });
      } else {
        rec = { id: newId('chk', t), conversationId: cid, state: 'pending', kind: 'window', due: t + delayMs, replies: [reply], rechecks: 0, depth: 0 };
        records.push(rec);
        emit({ type: 'scheduled', conversationId: cid, checkId: rec.id, due: rec.due });
      }
      void save();
      arm();
      return recCopy(rec);
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

    /**
     * "Missed:" notices for deliveries that were given up on, for the host to send before its
     * next message in that conversation. Each is returned once.
     */
    flushMissed(conversationId) {
      const cid = String(conversationId);
      const list = missed[cid] || [];
      delete missed[cid];
      if (list.length) void save();
      return list.map((t) => `Missed: ${t}`);
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
     * Tracked work ended. Runs onJobFinished, or queues one report turn (it waits for a busy user,
     * retries on failure and falls back to a code-written line), then any check parked on it.
     * Resolves when that has run, or once it is waiting.
     */
    finishJob(jobId, { status = 'done', text = '' } = {}) {
      const id = String(jobId);
      const open = jobs[id];
      if (!open) return Promise.resolve(null);
      delete jobs[id];
      const job = { ...open, status, text: String(text ?? ''), finishedAt: now() };
      const cid = job.conversationId;
      emit({ type: 'job_finished', conversationId: cid, jobId: id, status });
      return track((async () => {
        if (typeof onJobFinished === 'function') {
          try { await onJobFinished(cid, { ...job }); } catch (error) { emit({ type: 'error', stage: 'onJobFinished', conversationId: cid, jobId: id, error }); }
          unparkFor(job);
        } else {
          reports.push({ id: newId('rep', now()), conversationId: cid, job, due: now(), attempts: 0, state: 'pending' });
        }
        await save();
        arm();
        await api.tick();
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

    /**
     * Load persisted state and arm the timer. Checks and reports that were running at a stop run
     * again. Jobs found in the store died with the old process: they finish as 'lost' unless
     * onStartJobs(jobs) returns their ids.
     */
    async start() {
      if (started) return api;
      const raw = (await store.load()) || [];
      const state = Array.isArray(raw) ? { records: raw } : raw; // v0.1 stores held a plain array
      for (const [k, v] of Object.entries(state.counters || {})) counters[k] = Math.max(counters[k] || 0, v);
      const loadedJobs = [];
      for (const [k, v] of Object.entries(state.jobs || {})) if (!jobs[k]) { jobs[k] = v; loadedJobs.push(v); }
      for (const [k, v] of Object.entries(state.missed || {})) missed[k] = [...(missed[k] || []), ...(Array.isArray(v) ? v : [v])];
      for (const [k, v] of Object.entries(state.turnsByDay || {})) if (!turnsByDay[k]) turnsByDay[k] = v;
      const seenOut = new Set(outbox.map((o) => o.id));
      for (const o of state.outbox || []) if (!seenOut.has(o.id)) outbox.push({ ...o, sending: undefined });
      const seenRep = new Set(reports.map((p) => p.id));
      for (const p of state.reports || []) if (!seenRep.has(p.id)) reports.push({ ...p, state: 'pending' });
      const seen = new Set(records.map((r) => r.id));
      for (const r of state.records || []) {
        if (seen.has(r.id)) continue;
        if (r.state === 'dated') { records.push({ ...r }); continue; }
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
      let keep = [];
      if (loadedJobs.length && typeof onStartJobs === 'function') {
        try { keep = (await onStartJobs(loadedJobs.map((j) => ({ ...j })))) || []; } catch (error) { emit({ type: 'error', stage: 'onStartJobs', error }); }
      }
      const keepIds = new Set([...keep].map(String));
      const lost = loadedJobs.filter((j) => !keepIds.has(j.id));
      started = true;
      await save();
      arm();
      emit({
        type: 'started',
        pending: records.filter((r) => r.state === 'pending').length,
        parked: records.filter((r) => r.state === 'parked').length,
        dated: records.filter((r) => r.state === 'dated').length,
        jobs: Object.keys(jobs).length,
        lost: lost.length,
        reports: reports.length,
        outbox: outbox.length,
      });
      for (const j of lost) {
        emit({ type: 'job_lost', conversationId: j.conversationId, jobId: j.id });
        void api.finishJob(j.id, { status: 'lost', text: LOST_TEXT });
      }
      return api;
    },

    /** Stop the timer. Work already running finishes; the rest stays in the store. */
    stop() {
      started = false;
      if (timer != null) { clearTimer(timer); timer = null; }
      emit({ type: 'stopped' });
    },

    /**
     * Run every check, report and delivery retry that is due now: at most one model turn per
     * conversation at a time (reports first). Resolves with the outcomes.
     */
    async tick() {
      const t = now();
      const taken = new Set();
      for (const r of records) if (r.state === 'running') taken.add(r.conversationId);
      for (const p of reports) if (p.state === 'running') taken.add(p.conversationId);
      const runs = [];
      for (const p of reports.filter((x) => x.state === 'pending' && x.due <= t).sort(byDue)) {
        if (taken.has(p.conversationId)) continue;
        taken.add(p.conversationId);
        p.state = 'running';
        runs.push(() => runReport(p));
      }
      const due = records.filter((r) => (r.state === 'pending' || r.state === 'parked' || r.state === 'dated') && r.due <= t).sort(byDue);
      for (const r of due) {
        if (taken.has(r.conversationId)) continue;
        if (r.state === 'parked' && r.timedOut) {
          records = records.filter((x) => x !== r);
          emit({ type: 'park_ended', conversationId: r.conversationId, checkId: r.id, jobIds: r.parkedOn || [] });
          continue;
        }
        const from = r.state;
        taken.add(r.conversationId);
        r.state = 'running';
        runs.push(() => runCheck(r, { timeout: from === 'parked', from }));
      }
      const retries = outbox.filter((o) => !o.sending && o.due <= t);
      if (!runs.length && !retries.length) { arm(); return []; }
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
      return records.filter((r) => r.state === 'pending').map(recCopy);
    },

    /** Copies of the checks parked on open jobs. */
    parked() {
      return records.filter((r) => r.state === 'parked').map((r) => ({ ...recCopy(r), parkedOn: (r.parkedOn || []).slice() }));
    },

    /** Copies of the dated checks (DUE timers). */
    dated() {
      return records.filter((r) => r.state === 'dated').map(recCopy);
    },

    /** Copies of the open tracked jobs. */
    jobs() {
      return Object.values(jobs).map((j) => ({ ...j }));
    },

    /** Copies of the report turns still owed for finished jobs. */
    reports() {
      return reports.map((p) => ({ ...p, job: { ...p.job } }));
    },

    /** Copies of the deliveries waiting for a retry. */
    outbox() {
      return outbox.map(({ sending, ...o }) => ({ ...o }));
    },

    deliveredLog,
  };
  return api;
}
