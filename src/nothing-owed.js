// The scheduler: one blind timer per conversation, merged across replies, and a self-audit
// turn against the host's own send log when it fires.
import { buildPrompt as defaultBuildPrompt, parseOutcome as defaultParseOutcome } from './outcome.js';
import { createMemoryStore } from './stores.js';
import { createDeliveredLog } from './delivered-log.js';

const SKIP_KINDS = new Set(['check', 'report', 'system']);
const MAX_TIMER_MS = 2 ** 31 - 1;

const noop = () => {};
const clip = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const newId = (t) => `chk_${t.toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Create a nothing-owed scheduler. See index.d.ts for the full option and event types.
 */
export function createNothingOwed(options = {}) {
  const {
    delayMs = 10 * 60 * 1000,
    maxRechecks = 6,
    busyRetryMs = 60 * 1000,
    deliveredLookbackMs = 10 * 60 * 1000,
    maxReplies = 12,
    maxTextLength = 300,
    userLabel = 'the user',
    store = createMemoryStore(),
    runTurn,
    deliver,
    getDelivered,
    isUserBusy,
    onEvent = noop,
    onUsage,
    failTexts = [],
    buildPrompt = defaultBuildPrompt,
    parseOutcome = defaultParseOutcome,
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

  /** @type {Array<{id:string, conversationId:string, state:'pending'|'running', due:number, replies:{at:number,text:string}[], rechecks:number}>} */
  let records = [];
  let timer = null;
  let started = false;
  const delivering = new Set(); // conversations whose check reply is being delivered right now
  const inflight = new Set();

  const emit = (event) => {
    try { onEvent({ at: now(), ...event }); } catch { /* a broken listener never breaks the loop */ }
  };

  const save = async () => {
    try {
      await store.save(records.map((r) => ({ ...r, replies: r.replies.map((x) => ({ ...x })) })));
    } catch (error) {
      emit({ type: 'error', stage: 'store', error });
    }
  };

  const pendingFor = (cid) => records.find((r) => r.conversationId === cid && r.state === 'pending');
  const runningFor = (cid) => records.find((r) => r.conversationId === cid && r.state === 'running');

  const arm = () => {
    if (timer != null) { clearTimer(timer); timer = null; }
    if (!started) return;
    let next = Infinity;
    for (const r of records) {
      if (r.state === 'pending' && !runningFor(r.conversationId) && r.due < next) next = r.due;
    }
    if (next === Infinity) return;
    const wait = Math.min(Math.max(0, next - now()), MAX_TIMER_MS);
    timer = setTimer(() => { timer = null; api.tick(); }, wait);
  };

  // Put a record (back) into pending, merging into whatever was scheduled meanwhile.
  const requeue = (rec, due, rechecks) => {
    const cur = pendingFor(rec.conversationId);
    if (cur) {
      cur.replies = [...rec.replies, ...cur.replies].slice(-maxReplies);
      cur.rechecks = Math.max(cur.rechecks || 0, rechecks);
    } else {
      records.push({ ...rec, state: 'pending', due, rechecks });
    }
  };

  async function runCheck(rec) {
    const cid = rec.conversationId;
    const t0 = now();
    const finish = async (outcome) => {
      records = records.filter((r) => r !== rec);
      if (outcome === 'busy') requeue(rec, now() + busyRetryMs, rec.rechecks || 0);
      else if (outcome === 'running' && (rec.rechecks || 0) < maxRechecks) requeue(rec, now() + delayMs, (rec.rechecks || 0) + 1);
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

    const isLastCheck = (rec.rechecks || 0) >= maxRechecks;
    let outcome = 'failed';
    let text = '';
    try {
      const since = rec.replies[0].at - deliveredLookbackMs;
      const delivered = (await readDelivered(cid, since)) || [];
      const prompt = buildPrompt({ replies: rec.replies, delivered, isLastCheck, userLabel, maxTextLength });
      emit({ type: 'check_started', conversationId: cid, checkId: rec.id, replies: rec.replies.length, delivered: delivered.length, recheck: rec.rechecks || 0, isLastCheck });

      const res = await runTurn(cid, prompt, { checkId: rec.id, recheck: rec.rechecks || 0, isLastCheck });
      text = typeof res === 'string' ? res : res?.text ?? '';
      if (res && typeof res === 'object' && (res.usage || res.costUsd != null)) {
        const u = { conversationId: cid, checkId: rec.id, usage: res.usage ?? null, costUsd: res.costUsd ?? null };
        emit({ type: 'usage', ...u });
        try { onUsage?.(u); } catch { /* ignore */ }
      }

      outcome = parseOutcome(text, { failTexts });
      // A STILL_RUNNING on the last check has nothing left to wait for: end it silently.
      if (outcome === 'running' && isLastCheck) outcome = 'nothing';

      if (outcome === 'deliver') {
        delivering.add(cid);
        try { await deliver(cid, text); } finally { delivering.delete(cid); }
      }
    } catch (error) {
      outcome = 'failed';
      emit({ type: 'error', stage: 'check', conversationId: cid, checkId: rec.id, error });
    }

    const ms = now() - t0;
    if (outcome === 'nothing') emit({ type: 'nothing_owed', conversationId: cid, checkId: rec.id, ms });
    else if (outcome === 'running') emit({ type: 'still_running', conversationId: cid, checkId: rec.id, recheck: (rec.rechecks || 0) + 1, ms });
    else if (outcome === 'deliver') emit({ type: 'delivered', conversationId: cid, checkId: rec.id, chars: text.length, ms });
    else emit({ type: 'failed', conversationId: cid, checkId: rec.id, ms });
    return finish(outcome);
  }

  const api = {
    /**
     * The agent sent `text` to the user in `conversationId`. Schedules (or extends) that
     * conversation's check. Replies of kind 'check', 'report' or 'system' never schedule.
     */
    noteReply(conversationId, text, { kind, at } = {}) {
      const cid = String(conversationId);
      if (kind && SKIP_KINDS.has(kind)) return null;
      if (delivering.has(cid)) return null; // the check's own reply, routed back through the host
      const t = at ?? now();
      const reply = { at: t, text: clip(text, maxTextLength) };
      let rec = pendingFor(cid);
      if (rec) {
        rec.replies = [...rec.replies, reply].slice(-maxReplies);
        rec.due = t + delayMs;
        emit({ type: 'merged', conversationId: cid, checkId: rec.id, replies: rec.replies.length, due: rec.due });
      } else {
        rec = { id: newId(t), conversationId: cid, state: 'pending', due: t + delayMs, replies: [reply], rechecks: 0 };
        records.push(rec);
        emit({ type: 'scheduled', conversationId: cid, checkId: rec.id, due: rec.due });
      }
      void save();
      arm();
      return { ...rec, replies: rec.replies.slice() };
    },

    /** A message really reached the user (built-in delivered log). Ignored if you pass getDelivered. */
    noteDelivered(conversationId, text, atOrOpts) {
      const opts = typeof atOrOpts === 'number' ? { at: atOrOpts } : atOrOpts || {};
      return deliveredLog.note(conversationId, text, opts);
    },

    /** Load persisted checks and arm the timer. Checks that were running at a stop run again. */
    async start() {
      if (started) return api;
      const loaded = (await store.load()) || [];
      const seen = new Set(records.map((r) => r.id));
      for (const r of loaded) {
        if (seen.has(r.id)) continue;
        const rec = { ...r, state: 'pending', rechecks: r.rechecks || 0 };
        const cur = pendingFor(rec.conversationId);
        if (cur) cur.replies = [...rec.replies, ...cur.replies].slice(-maxReplies);
        else records.push(rec);
      }
      started = true;
      await save();
      arm();
      emit({ type: 'started', pending: records.length });
      return api;
    },

    /** Stop the timer. Checks already running finish; pending ones stay in the store. */
    stop() {
      started = false;
      if (timer != null) { clearTimer(timer); timer = null; }
      emit({ type: 'stopped' });
    },

    /** Run every check that is due now. Resolves with their outcomes once they finish. */
    async tick() {
      const t = now();
      const due = records.filter((r) => r.state === 'pending' && r.due <= t && !runningFor(r.conversationId));
      if (!due.length) { arm(); return []; }
      for (const r of due) r.state = 'running';
      await save();
      arm();
      const runs = due.map((r) => {
        const p = runCheck(r);
        inflight.add(p);
        return p.finally(() => inflight.delete(p));
      });
      return Promise.all(runs);
    },

    /** Wait for every running check to finish. */
    async idle() {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },

    /** Copies of the pending checks. */
    pending() {
      return records.filter((r) => r.state === 'pending').map((r) => ({ ...r, replies: r.replies.slice() }));
    },

    deliveredLog,
  };
  return api;
}
