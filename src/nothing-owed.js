// The scheduler: one fixed-window timer per conversation, a self-audit turn against the host's
// own send log when it fires, verify checks on the package's own deliveries, dated timers, job
// tracking for long work, report turns with a code-written fallback, delivery retry, missed
// notices with their own timer, caps and a circuit breaker.
// Code holds every alarm; the model is only woken to judge and to write.
import {
  buildPrompt as defaultBuildPrompt,
  buildReportPrompt as defaultBuildReportPrompt,
  parseCheckReply,
  clipText,
  isJunkReply,
} from './outcome.js';
import { createMemoryStore } from './stores.js';
import { createDeliveredLog } from './delivered-log.js';

const VERIFY_KINDS = new Set(['check', 'report']); // replies the user saw that may hold a promise
const CODE_KINDS = new Set(['giveup', 'fallback', 'missed']); // code-written lines: no promise in them
const MAX_TIMER_MS = 2 ** 31 - 1;
const STORE_VERSION = 4;
const MIN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MIN_MS;
const ECHO_MS = MIN_MS; // a package delivery routed back through noteReply within this long is an echo
const DUP_WINDOW_MS = 10 * MIN_MS;
const OWN_KEEP = 20;

/**
 * Every user-visible string the package writes itself, in English. Pass a (partial) set as the
 * `strings` option to replace them; `status` and `giveUp` merge key by key. Templates fill
 * {title}, {status}, {line} and {time}.
 */
export const defaultStrings = Object.freeze({
  missedPrefix: 'Missed: ',
  fallbackReport: '{title} {status}: {line}',
  fallbackReportNoLine: '{title} {status}.',
  status: Object.freeze({ done: 'done', error: 'error', stopped: 'stopped', lost: 'lost' }),
  lostText: 'the work was interrupted by a restart',
  giveUp: Object.freeze({
    failed: "I may have said I'd follow up on something, and I couldn't check it. Ask me if anything is still open.",
    still_running: "Something I started for you may still be running, and I'm no longer watching it. Ask me if you need an update.",
    verify_capped: "I'm no longer watching this for you automatically. Ask me if anything is still open.",
    daily_cap: "I've hit today's limit for checking on promises; I'll check again at {time} UTC.",
    due_limit: "I can't hold another reminder here. Ask me again closer to the time.",
  }),
});

const mergeStrings = (s) => {
  if (!s || s === defaultStrings) return defaultStrings;
  return {
    ...defaultStrings,
    ...s,
    status: { ...defaultStrings.status, ...(s.status || {}) },
    giveUp: { ...defaultStrings.giveUp, ...(s.giveUp || {}) },
  };
};
// one pass, so a placeholder inside a value (a job title with "{line}") is never expanded
const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m));

const noop = () => {};
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const rand = () => Math.random().toString(36).slice(2, 8);
const newId = (prefix, t) => `${prefix}_${t.toString(36)}${rand()}`;
const copy = (v) => JSON.parse(JSON.stringify(v));
const isRunning = (o) => o === 'running' || o === 'deliver_running';
const byDue = (a, b) => a.due - b.due;
const hhmm = (t) => new Date(t).toISOString().slice(11, 16);

/**
 * The default code-written lines. `reason`: 'failed' (checks kept failing), 'still_running' (the
 * last check had nothing but STILL_RUNNING), 'verify_capped', 'daily_cap' (with `until`) or
 * 'due_limit'. None of them claims a promise was made. `strings`: a (partial) strings set.
 */
export function defaultGiveUpText({ reason, until } = {}, strings) {
  const g = mergeStrings(strings).giveUp;
  switch (reason) {
    case 'still_running': return g.still_running;
    case 'verify_capped': return g.verify_capped;
    case 'daily_cap': return fill(g.daily_cap, { time: hhmm(until) });
    case 'due_limit': return g.due_limit;
    default: return g.failed;
  }
}

/**
 * The code-written report for a job whose report turn failed or declined: "<title> <status>: <first
 * line>" by default. `strings`: a (partial) strings set (templates and status words).
 */
export function fallbackReportText(job, strings) {
  const S = mergeStrings(strings);
  let source = job?.summary ?? job?.text ?? '';
  const raw = String(source).trim();
  if (job?.summary == null && /^[[{]/.test(raw)) {
    // a JSON result: its text or summary, never the raw JSON
    try { const v = JSON.parse(raw); source = typeof v?.text === 'string' ? v.text : typeof v?.summary === 'string' ? v.summary : ''; } catch { /* plain text */ }
  }
  const line = String(source).split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  const status = job?.status || 'done';
  const values = { title: job?.title || job?.id, status: Object.hasOwn(S.status, status) ? S.status[status] : status, line: line.slice(0, 300) };
  return fill(line ? S.fallbackReport : S.fallbackReportNoLine, values);
}

/**
 * Create a nothing-owed scheduler. See index.d.ts for the full option and event types.
 */
export function createNothingOwed(options = {}) {
  const {
    delayMs = 5 * MIN_MS,
    maxRechecks = 6,
    backoffMs = [15, 30, 60, 120].map((m) => m * MIN_MS),
    busyRetryMs = MIN_MS,
    busyStuckMs = 30 * MIN_MS,
    deliveredLookbackMs = 10 * MIN_MS,
    maxReplies = 12,
    maxTextLength = 300,
    maxReportLength = 1500,
    maxDeliveredInPrompt = 40,
    jobTimeoutMs = 2 * 60 * MIN_MS,
    turnTimeoutMs = 3 * MIN_MS,
    callbackTimeoutMs = 30 * 1000,
    maxVerifyDepth = 3,
    maxDueMs = 30 * DAY_MS,
    maxDueDepth = 10,
    maxDatedPerConversation = 5,
    maxConcurrent = 2,
    maxConcurrentLimit = 8,
    dailyCap = 60,
    dailyCapReserve = 10,
    globalDailyCap = 1000,
    circuitFailures = 5,
    circuitPauseMs = 15 * MIN_MS,
    circuitMaxPauseMs = 2 * 60 * MIN_MS,
    retryMs = 5 * MIN_MS,
    maxDeliveryAttempts = 12,
    missedRetryMs = 15 * MIN_MS,
    missedMaxRetryMs = 6 * 60 * MIN_MS,
    idlePruneMs = 30 * DAY_MS,
    saveDebounceMs = 100,
    userLabel = 'the user',
    timeZone,
    store = createMemoryStore(),
    runTurn,
    deliver,
    getDelivered,
    isUserBusy,
    isPermanentError = () => false,
    isJunk = isJunkReply,
    onJobFinished,
    onStartJobs,
    onTurnStart,
    onTurnEnd,
    giveUpText,
    strings: stringsOpt,
    promptLanguage,
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
  const S = mergeStrings(stringsOpt);
  const missedLine = (text) => `${S.missedPrefix}${text}`;

  // Timed rechecks: maxRechecks at delayMs, then one per back-off step. The last one asks for a status.
  const totalRechecks = maxRechecks + backoffMs.length;
  const recheckDelay = (done) => (done < maxRechecks ? delayMs : backoffMs[done - maxRechecks]);
  // timeZone: an IANA zone, or a function of the conversation that returns one
  const zoneOf = (cid) => {
    if (typeof timeZone !== 'function') return timeZone;
    try { return timeZone(cid) || undefined; } catch { return undefined; }
  };

  const deliveredLog = options.deliveredLog || createDeliveredLog({ now, backing: store.deliveredBacking });
  const readDelivered = getDelivered || ((id, since) => deliveredLog.since(id, since));

  // Check records: state 'pending' (one per conversation, waits for due), 'running', 'parked'
  // (waits for jobs; due is the job timeout) or 'dated' (a DUE timer).
  let records = [];
  let reports = []; // finished jobs whose report is still owed
  let counters = {}; // conversationId -> messages so far
  let jobs = {}; // jobId -> open tracked job
  let outbox = []; // deliveries that failed and wait for a retry
  let missed = {}; // conversationId -> [{ text, at, due, wait }] given-up deliveries, retried on their own timer
  let turnsByDay = {}; // conversationId -> { day, n } model turns today
  let globalTurns = { day: 0, n: 0, told: false };
  let notices = {}; // conversationId -> { capDay, gaveUp }
  let circuit = { fails: 0, openUntil: 0, pauseMs: 0 };
  let lastActive = {}; // conversationId -> last activity time
  const lastHostReply = {}; // conversationId -> time of the last normal reply the host noted
  let timer = null;
  let started = false;
  let loaded = false;
  const inflight = new Set();
  const own = new Map(); // conversationId -> recent package deliveries [{ text, at, done, jobId }]
  const missedLocks = new Map();
  const activeTurns = new Set();
  let active = 0;
  let woken = 0;
  const waiters = [];
  let probing = false;

  const emit = (event) => {
    try { onEvent({ at: now(), ...event }); } catch { /* a broken listener never breaks the loop */ }
  };

  const track = (p) => {
    inflight.add(p);
    return p.finally(() => inflight.delete(p));
  };

  // Every host callback gets callbackTimeoutMs.
  const timed = (label, fn) => new Promise((resolve, reject) => {
    let done = false;
    let h = null;
    if (callbackTimeoutMs > 0 && Number.isFinite(callbackTimeoutMs)) {
      h = setTimer(() => {
        if (done) return;
        done = true;
        const error = new Error(`nothing-owed: ${label} did not settle within ${callbackTimeoutMs} ms`);
        error.code = 'CALLBACK_TIMEOUT';
        reject(error);
      }, Math.min(callbackTimeoutMs, MAX_TIMER_MS));
    }
    Promise.resolve().then(fn).then(
      (v) => { if (done) return; done = true; if (h != null) clearTimer(h); resolve(v); },
      (e) => { if (done) return; done = true; if (h != null) clearTimer(h); reject(e); },
    );
  });

  // ---- persistence: nothing before the load, debounced writes, a sync final save -------------

  const live = (cid) =>
    records.some((r) => r.conversationId === cid) || reports.some((p) => p.conversationId === cid) ||
    Object.values(jobs).some((j) => j.conversationId === cid) || outbox.some((o) => o.conversationId === cid) || missed[cid]?.length;

  const pruneIdle = () => {
    const cut = now() - idlePruneMs;
    for (const [cid, t] of Object.entries(lastActive)) {
      if (t >= cut || live(cid)) continue;
      delete lastActive[cid];
      delete counters[cid];
      delete turnsByDay[cid];
      delete notices[cid];
      own.delete(cid);
    }
    const today = Math.floor(now() / DAY_MS);
    for (const [k, v] of Object.entries(turnsByDay)) if (v.day < today) delete turnsByDay[k];
  };

  const snapshot = () => {
    pruneIdle();
    return copy({ version: STORE_VERSION, records, reports, counters, jobs, outbox, missed, turnsByDay, globalTurns, notices, circuit, lastActive });
  };

  let saveTimer = null;
  let writing = null;
  let again = false;
  const writeNow = () => {
    if (!loaded) return Promise.resolve();
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (writing) { again = true; return writing; }
    let r;
    try { r = store.save(snapshot()); } catch (error) { emit({ type: 'error', stage: 'store', error }); }
    writing = Promise.resolve(r)
      .catch((error) => emit({ type: 'error', stage: 'store', error }))
      .finally(() => {
        writing = null;
        if (again) { again = false; void writeNow(); }
      });
    return writing;
  };
  const save = () => {
    if (!loaded) return Promise.resolve();
    if (!(saveDebounceMs > 0)) return writeNow();
    if (!saveTimer) {
      saveTimer = setTimeout(() => { saveTimer = null; void writeNow(); }, saveDebounceMs);
      saveTimer.unref?.();
    }
    return Promise.resolve();
  };
  const flushAll = async () => {
    await writeNow();
    while (writing) await writing;
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
  const touch = (cid) => { lastActive[cid] = now(); };
  const count = (cid) => { touch(cid); return (counters[cid] = (counters[cid] || 0) + 1); };
  const recCopy = (r) => ({ ...r, replies: r.replies.slice(), ...(r.parkedOn ? { parkedOn: r.parkedOn.slice() } : {}) });

  // ---- the circuit breaker ------------------------------------------------------------------

  const circuitOn = () => circuitFailures > 0;
  const circuitOpen = () => circuitOn() && circuit.openUntil > now();
  const modelBlocked = () => circuitOn() && circuit.pauseMs > 0 && (circuitOpen() || probing);
  const turnOk = (cid) => {
    if (circuit.pauseMs > 0) emit({ type: 'circuit_closed', after: circuit.fails });
    circuit = { fails: 0, openUntil: 0, pauseMs: 0 };
    if (notices[cid]?.gaveUp) delete notices[cid].gaveUp;
  };
  const turnFailed = () => {
    if (!circuitOn()) return;
    circuit.fails++;
    if (circuit.pauseMs > 0) circuit.pauseMs = Math.min(circuit.pauseMs * 2, circuitMaxPauseMs);
    else if (circuit.fails >= circuitFailures) circuit.pauseMs = circuitPauseMs;
    else return;
    circuit.openUntil = now() + circuit.pauseMs;
    emit({ type: 'circuit_open', fails: circuit.fails, until: circuit.openUntil, pauseMs: circuit.pauseMs });
  };

  const arm = () => {
    if (timer != null) { clearTimer(timer); timer = null; }
    if (!started) return;
    const gate = circuitOpen() ? circuit.openUntil : 0;
    let next = Infinity;
    for (const r of records) {
      if ((r.state === 'pending' || r.state === 'parked' || r.state === 'dated') && !convBusy(r.conversationId)) next = Math.min(next, Math.max(r.due, gate));
    }
    for (const p of reports) if (p.state === 'pending' && !convBusy(p.conversationId)) next = Math.min(next, Math.max(p.due, gate));
    for (const o of outbox) if (!o.sending && o.due < next) next = o.due;
    for (const list of Object.values(missed)) for (const m of list || []) if (m.due < next) next = m.due;
    if (next === Infinity) return;
    const wait = Math.min(Math.max(0, next - now()), MAX_TIMER_MS);
    timer = setTimer(() => { timer = null; void track(api.tick()); }, wait);
  };

  // ---- model turns: a growing slot pool (never held while a host callback runs), caps, timeout --

  const slots = () => {
    if (!(maxConcurrent > 0)) return Infinity;
    return Math.min(Math.max(maxConcurrentLimit, maxConcurrent), maxConcurrent + Math.floor(waiters.length / 25));
  };
  const pump = () => {
    while (waiters.length && active + woken < slots()) { woken++; waiters.shift()(true); }
  };
  const gate = () => {
    // a pass is counted at once (woken), so passes granted before anyone takes a slot never overshoot
    if (!waiters.length && active + woken < slots()) { woken++; return Promise.resolve(true); }
    return new Promise((resolve) => { waiters.push(resolve); pump(); });
  };
  const release = () => { active--; pump(); };

  const nextDay = () => (Math.floor(now() / DAY_MS) + 1) * DAY_MS;
  // null when the turn may run; 'conv' or 'global' when a cap is reached.
  const spendTurn = (cid, reason) => {
    const day = Math.floor(now() / DAY_MS);
    if (globalTurns.day !== day) globalTurns = { day, n: 0, told: false };
    if (globalDailyCap > 0 && globalTurns.n >= globalDailyCap) {
      if (!globalTurns.told) { globalTurns.told = true; emit({ type: 'global_daily_cap', cap: globalDailyCap, until: nextDay() }); }
      return 'global';
    }
    let u = turnsByDay[cid];
    if (!u || u.day !== day) u = turnsByDay[cid] = { day, n: 0 };
    const limit = reason === 'window' || reason === 'due' ? dailyCap : Math.max(0, dailyCap - dailyCapReserve);
    if (dailyCap > 0 && u.n >= limit) return 'conv';
    u.n++;
    globalTurns.n++;
    return null;
  };

  const callTurn = async (cid, prompt, ctx) => {
    const ac = new AbortController();
    const limit = turnTimeoutMs > 0 && Number.isFinite(turnTimeoutMs) ? Math.min(turnTimeoutMs, MAX_TIMER_MS) : 0;
    let handle = null;
    activeTurns.add(cid);
    if (onTurnStart) { try { await timed('onTurnStart', () => onTurnStart(cid, { ...ctx })); } catch (error) { emit({ type: 'error', stage: 'onTurnStart', conversationId: cid, error }); } }
    const run = Promise.resolve().then(() => runTurn(cid, prompt, { ...ctx, signal: ac.signal }));
    run.catch(noop);
    try {
      if (!limit) return await run;
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
      return await Promise.race([run, timeout]);
    } finally {
      if (handle != null) clearTimer(handle);
      activeTurns.delete(cid);
      if (onTurnEnd) { try { await timed('onTurnEnd', () => onTurnEnd(cid, { ...ctx })); } catch (error) { emit({ type: 'error', stage: 'onTurnEnd', conversationId: cid, error }); } }
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
    let junk = false;
    try { junk = !!isJunk(String(text ?? '')); } catch { junk = false; }
    if (junk) return { outcome: 'failed', text: '', junk: true };
    const r = parseOutcome(text, { failTexts });
    if (typeof r === 'string') {
      if (r === 'deliver' || r === 'deliver_running' || r === 'due') {
        const full = parseCheckReply(text, { failTexts });
        if (full.outcome === r) return full;
        return { outcome: r === 'due' ? 'deliver' : r, text: String(text ?? '').trim() };
      }
      return { outcome: r, text: '' };
    }
    return { outcome: r?.outcome ?? 'failed', text: r?.text ?? '', dueAt: r?.dueAt, running: r?.running };
  };

  // The part of a check run that waits: busy user, host send log, a free slot. No slot is held
  // while a host callback runs. Resolves { busy } or { delivered } with a slot taken.
  const waitForTurn = async (cid, rec) => {
    for (;;) {
      if (isUserBusy) {
        let busy;
        try { busy = !!(await timed('isUserBusy', () => isUserBusy(cid))); } catch (error) {
          emit({ type: 'error', stage: 'isUserBusy', conversationId: cid, error });
          busy = true; // unknown: the user's turn wins
        }
        if (busy) {
          rec.busySince ??= now();
          if (!rec.busyStuck && now() - rec.busySince >= busyStuckMs) {
            rec.busyStuck = true;
            emit({ type: 'busy_stuck', conversationId: cid, checkId: rec.id ?? null, since: rec.busySince });
          }
          return { busy: true };
        }
        delete rec.busySince;
        delete rec.busyStuck;
      }
      let hostDelivered = null;
      if (getDelivered && rec.since != null) hostDelivered = (await timed('getDelivered', () => getDelivered(cid, rec.since))) || [];
      const wasWoken = await gate();
      if (wasWoken) woken--;
      // a waiter the pump woke had a slot counted for it: it takes it (re-checking here could
      // flip at the backlog boundary and loop forever)
      if (wasWoken || active < slots()) {
        active++;
        // the built-in log is read again now, synchronously, so the list is current
        const delivered = hostDelivered ?? (rec.since != null ? deliveredLog.since(cid, rec.since) : []);
        return { delivered };
      }
    }
  };

  // ---- delivery with retry ----------------------------------------------------------------

  const ownAdd = (cid, text, jobId) => {
    const e = { text: flat(text), at: now(), done: false, jobId: jobId ?? null };
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
    const e = ownAdd(cid, text, meta.jobId);
    let res;
    try {
      res = await timed('deliver', () => deliver(cid, text, { kind: meta.kind, checkId: meta.checkId ?? null, jobId: meta.jobId ?? null }));
    } catch (error) {
      ownDrop(cid, e);
      throw error;
    }
    const r = res && typeof res === 'object' ? res : {};
    if (r.skipped === true) {
      // the host chose not to send it: nothing reached the user, nothing to log or verify
      ownDrop(cid, e);
      emit({ type: 'delivery_skipped', conversationId: cid, kind: meta.kind, checkId: meta.checkId ?? null, jobId: meta.jobId ?? null });
      return { skipped: true, text: '' };
    }
    // the host may have changed the text on the way out (a guard rewrite): log what was really sent
    const sentText = typeof r.text === 'string' && r.text.trim() ? r.text : text;
    e.text = sentText;
    e.done = true;
    e.at = now();
    count(cid);
    try { deliveredLog.note(cid, sentText); } catch (error) { emit({ type: 'error', stage: 'deliveredLog', conversationId: cid, error }); }
    return { ids: Array.isArray(r.ids) ? r.ids : undefined, text: sentText };
  };

  // Send the owed "Missed:" notices of one conversation, one sender at a time. `force` ignores
  // their timers (before a package delivery). Resolves false if one failed.
  const runMissed = async (cid, force) => {
    while (missed[cid]?.length) {
      const m = missed[cid][0];
      if (!force && m.due > now()) return true;
      try {
        await sendOnce(cid, missedLine(m.text), { kind: 'missed' });
      } catch (error) {
        m.wait = Math.min((m.wait || missedRetryMs) * 2, missedMaxRetryMs);
        m.due = now() + m.wait;
        emit({ type: 'missed_retry', conversationId: cid, retryInMs: m.wait, error });
        void save();
        return false;
      }
      if (missed[cid]?.[0] === m) missed[cid].shift();
      emit({ type: 'missed_notice', conversationId: cid });
    }
    if (missed[cid] && !missed[cid].length) delete missed[cid];
    void save();
    return true;
  };
  const sendMissed = (cid, force = true) => {
    const prev = missedLocks.get(cid) || Promise.resolve();
    const p = prev.then(() => runMissed(cid, force));
    const settled = p.catch(() => false);
    missedLocks.set(cid, settled);
    void settled.then(() => { if (missedLocks.get(cid) === settled) missedLocks.delete(cid); });
    return p;
  };

  // `drop()`: asked right before deliver(); true means the text must not go out any more.
  const sendWithMissed = async (cid, text, meta, drop) => {
    if (missed[cid]?.length) await sendMissed(cid, true);
    if (drop?.()) return { dropped: true };
    return sendOnce(cid, text, meta);
  };

  const outboxIds = (item) => ({ conversationId: item.conversationId, kind: item.kind, checkId: item.checkId, jobId: item.jobId });
  // A job report (or its code-written fallback) not sent because the host told the user itself.
  const emitDropped = ({ conversationId, jobId, kind }) =>
    emit({ type: 'report_dropped', conversationId, jobId, kind, reason: 'user_notified' });

  // A delivery attempt failed: queue a retry or give up (the text becomes a missed notice).
  const failDelivery = (item, error) => {
    const permanent = (() => { try { return !!isPermanentError(error); } catch { return false; } })();
    if (permanent || item.attempts >= maxDeliveryAttempts) {
      outbox = outbox.filter((o) => o !== item);
      const t = now();
      (missed[item.conversationId] ||= []).push({ text: item.text, at: t, due: permanent ? Infinity : t + missedRetryMs, wait: missedRetryMs });
      emit({ type: 'delivery_failed', ...outboxIds(item), attempts: item.attempts, permanent, error });
      return;
    }
    const wait = Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0 ? error.retryAfterMs : retryMs;
    item.due = now() + wait;
    if (!outbox.includes(item)) outbox.push(item);
    emit({ type: 'delivery_retry', ...outboxIds(item), attempt: item.attempts, retryInMs: wait, error });
  };

  // First attempt for a text the package produced. Resolves { ok, ids }. A failure is kept for
  // retry; it never reaches runTurn again. A deliver() that hangs times out into the outbox.
  const deliverOwed = async (cid, text, meta, drop) => {
    try {
      const { ids, text: sentText, skipped, dropped } = await sendWithMissed(cid, text, meta, drop);
      if (dropped) return { ok: false, dropped: true };
      return { ok: true, ids, text: sentText, skipped: !!skipped };
    } catch (error) {
      if (drop?.()) return { ok: false, dropped: true };
      const item = { id: newId('out', now()), conversationId: cid, text, attempts: 1, due: 0, at: now(), ...meta };
      failDelivery(item, error);
      return { ok: false };
    }
  };

  const retryDelivery = async (item) => {
    item.sending = true;
    item.attempts += 1;
    try {
      const { ids, text: sentText, skipped, dropped } = await sendWithMissed(item.conversationId, item.text, item, () => !!item.userNotified);
      outbox = outbox.filter((o) => o !== item);
      if (dropped) emitDropped(item);
      else emit({ type: 'delivery_recovered', ...outboxIds(item), attempt: item.attempts, ids });
      if (!dropped && !skipped && VERIFY_KINDS.has(item.kind)) scheduleVerify(item.conversationId, sentText, (item.depth || 0) + 1, undefined, item.dueDepth);
    } catch (error) {
      failDelivery(item, error);
    } finally {
      delete item.sending;
    }
    await save();
    arm();
  };

  // A code-written line to the user (never a model turn).
  const sendLine = async (cid, reason, ids = {}, extra = {}) => {
    let text;
    try {
      text = giveUpText ? giveUpText({ conversationId: cid, reason, ...ids, ...extra }) : defaultGiveUpText({ reason, ...extra }, S);
    } catch { text = defaultGiveUpText({ reason, ...extra }, S); }
    text = String(text ?? '').trim();
    if (!text) return false;
    const sent = await deliverOwed(cid, text, { kind: 'giveup', ...ids });
    emit({ type: 'gave_up', conversationId: cid, reason, ...ids, delivered: sent.ok });
    return sent.ok;
  };

  // The limit lines (daily cap, verify cap, DUE limit) go at most once per conversation per day each.
  const onceADay = (cid, reason) => {
    const day = Math.floor(now() / DAY_MS);
    const n = (notices[cid] ||= {});
    const key = `${reason}Day`;
    if (n[key] === day) return false;
    n[key] = day;
    return true;
  };
  const capLine = async (cid, ids) => {
    if (onceADay(cid, 'daily_cap')) await sendLine(cid, 'daily_cap', ids, { until: nextDay() });
  };

  // An exact copy is not sent twice. Checks compare with copies delivered after the record's
  // previous run or in the last 10 minutes, and with queued and missed texts; dated checks are
  // never compared; reports only with copies of the same job.
  const isDuplicate = (cid, body, { delivered = [], start, jobId, mode }) => {
    if (mode === 'due') return false;
    const f = flat(body);
    if (!f) return false;
    const same = (t) => { const x = flat(t); return x === f || x === flat(missedLine(f)); };
    if (mode === 'report') {
      return outbox.some((o) => o.conversationId === cid && o.jobId === jobId && same(o.text)) ||
        (own.get(cid) || []).some((e) => e.done && e.jobId === jobId && same(e.text));
    }
    if (outbox.some((o) => o.conversationId === cid && same(o.text))) return true;
    if ((missed[cid] || []).some((m) => same(m.text))) return true;
    if (delivered.some((d) => d.at >= start && same(d.text))) return true;
    return (own.get(cid) || []).some((e) => e.done && e.at >= start && same(e.text));
  };

  // ---- check records ----------------------------------------------------------------------

  // Put a record (back) into pending, merging into whatever was scheduled meanwhile.
  const requeue = (rec, due, rechecks) => {
    const cur = find(rec.conversationId, 'pending');
    if (cur) {
      cur.replies = keepFirst([...rec.replies, ...cur.replies]);
      cur.rechecks = Math.max(cur.rechecks || 0, rechecks);
      cur.depth = Math.max(cur.depth || 0, rec.depth || 0);
      cur.dueDepth = Math.max(cur.dueDepth || 0, rec.dueDepth || 0);
      cur.jobRecheck = cur.jobRecheck || rec.jobRecheck;
      cur.lastRunAt = Math.max(cur.lastRunAt || 0, rec.lastRunAt || 0) || undefined;
    } else {
      records.push({ ...rec, state: 'pending', due, rechecks, fresh: false, parkedOn: undefined, parkedAt: undefined, timedOut: undefined, busySince: undefined, busyStuck: undefined });
    }
  };

  // One follow-up check on a reply the user saw that may itself hold a promise.
  // `runAt`: when the run that delivered the text started; the verify counts it as its previous
  // run, so the duplicate guard covers what that run sent.
  const scheduleVerify = (cid, text, depth, at, dueDepth = 0, runAt) => {
    if (depth > maxVerifyDepth) {
      emit({ type: 'verify_capped', conversationId: cid, depth });
      if (onceADay(cid, 'verify_capped')) void track(sendLine(cid, 'verify_capped').then(() => save()));
      return null;
    }
    const t = at ?? now();
    const reply = { at: t, text: clipText(text, maxTextLength), seq: counters[cid] };
    let rec = find(cid, 'pending');
    if (rec) {
      rec.replies = keepFirst([...rec.replies, reply]);
      rec.depth = Math.max(rec.depth || 0, depth);
      rec.dueDepth = Math.max(rec.dueDepth || 0, dueDepth || 0);
      rec.lastRunAt = Math.min(rec.lastRunAt ?? Infinity, runAt ?? t);
    } else {
      rec = { id: newId('chk', t), conversationId: cid, state: 'pending', kind: 'verify', due: t + delayMs, replies: [reply], rechecks: 0, depth, dueDepth: dueDepth || 0, lastRunAt: runAt ?? t };
      records.push(rec);
    }
    emit({ type: 'verify_scheduled', conversationId: cid, checkId: rec.id, depth, due: rec.due });
    return rec;
  };

  // A DUE timer: at that time, a check runs with the replies that made the promise. Bounded by
  // maxDueDepth (a chain of DUE answers) and maxDatedPerConversation.
  const addDated = (rec, dueAt) => {
    const cid = rec.conversationId;
    const cur = records.find((r) => r.conversationId === cid && r.state === 'dated' && Math.abs(r.due - dueAt) <= ECHO_MS);
    if (cur) {
      const seen = new Set(cur.replies.map((x) => `${x.at}|${x.text}`));
      cur.replies = keepFirst([...cur.replies, ...rec.replies.filter((x) => !seen.has(`${x.at}|${x.text}`))]);
      emit({ type: 'dated', conversationId: cid, checkId: cur.id, due: cur.due });
      return true;
    }
    const dueDepth = (rec.dueDepth || 0) + 1;
    const count = records.filter((r) => r.conversationId === cid && r.state === 'dated').length;
    if (dueDepth > maxDueDepth || count >= maxDatedPerConversation) {
      emit({ type: 'due_limit', conversationId: cid, checkId: rec.id ?? null, dueDepth, dated: count });
      if (onceADay(cid, 'due_limit')) void track(sendLine(cid, 'due_limit', { checkId: rec.id ?? null }).then(() => save()));
      return false;
    }
    const d = { id: newId('due', now()), conversationId: cid, state: 'dated', kind: 'due', due: dueAt, dueAt, replies: rec.replies.slice(), rechecks: 0, depth: rec.depth || 0, dueDepth };
    records.push(d);
    emit({ type: 'dated', conversationId: cid, checkId: d.id, due: dueAt });
    return true;
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
    if (rec.kind === 'due' && !(rec.rechecks > 0)) return 'due';
    if (rec.fresh) return 'window';
    if ((rec.rechecks || 0) > 0) return 'recheck';
    if (rec.kind === 'verify') return 'verify';
    return 'window';
  };

  async function runCheck(rec, { timeout = false, from = 'pending', probe = false } = {}) {
    const cid = rec.conversationId;
    const t0 = now();
    const rechecks = rec.rechecks || 0;
    const verifies = []; // [text, depth] for deliveries that landed
    let datedAt = null;
    let suppressed = false;

    const finish = async (outcome) => {
      records = records.filter((r) => r !== rec);
      const open = openJobIds(cid);
      if (outcome === 'busy' || outcome === 'capped') {
        const later = outcome === 'busy' ? now() + busyRetryMs : nextDay();
        if (from === 'parked' || from === 'dated') records.push({ ...rec, state: from, due: later });
        else {
          requeue(rec, later, rechecks);
          const cur = find(cid, 'pending');
          if (outcome === 'capped' && cur) cur.capped = true;
          if (cur && rec.fresh) cur.fresh = true;
          if (cur && rec.busySince) { cur.busySince = rec.busySince; cur.busyStuck = rec.busyStuck; }
        }
      } else if (suppressed) {
        // the circuit is open: keep the last step for after it closes
        requeue(rec, Math.max(circuit.openUntil, now() + delayMs), rechecks);
      } else if (timeout) {
        if (open.length) park(rec, open, { timedOut: true });
      } else if (outcome === 'failed' && rechecks < totalRechecks) {
        requeue(rec, now() + recheckDelay(rechecks), rechecks + 1);
      } else if (isRunning(outcome) && open.length && rec.jobRecheck) {
        park(rec, open);
      } else if (isRunning(outcome) && open.length) {
        rec.jobRecheck = true; // one recheck at delayMs before parking on the job
        requeue(rec, now() + delayMs, Math.min(rechecks + 1, totalRechecks));
      } else if (isRunning(outcome) && rechecks < totalRechecks) {
        requeue(rec, now() + recheckDelay(rechecks), rechecks + 1);
      }
      if (datedAt != null) addDated(rec, datedAt);
      for (const [text, depth] of verifies) scheduleVerify(cid, text, depth, undefined, rec.dueDepth, rec.lastRunAt);
      await save();
      arm();
      return outcome;
    };

    const reason = reasonOf(rec, timeout);
    rec.since = (rec.replies[0]?.at ?? now()) - deliveredLookbackMs;
    let held = false;
    const free = () => { if (held) { held = false; release(); } };
    try {
      let delivered;
      try {
        const w = await waitForTurn(cid, rec);
        if (w.busy) {
          emit({ type: 'yielded', conversationId: cid, checkId: rec.id });
          return await finish('busy');
        }
        held = true;
        delivered = w.delivered;
      } catch (error) {
        emit({ type: 'error', stage: 'getDelivered', conversationId: cid, checkId: rec.id, error });
        emit({ type: 'failed', conversationId: cid, checkId: rec.id, recheck: rechecks + 1, ms: now() - t0 });
        return await finish('failed');
      }
      const capped = spendTurn(cid, reason);
      if (capped) {
        free();
        emit({ type: 'daily_cap', conversationId: cid, checkId: rec.id, scope: capped, until: nextDay() });
        await capLine(cid, { checkId: rec.id });
        return await finish('capped');
      }
      if (missed[cid]?.length) await sendMissed(cid, true);
      if (timeout) emit({ type: 'park_timeout', conversationId: cid, checkId: rec.id, jobIds: openJobIds(cid) });

      const open0 = openJobIds(cid);
      const exhausted = rechecks >= totalRechecks;
      const isLastCheck = timeout || (exhausted && !open0.length);
      const dupStart = Math.min(rec.lastRunAt ?? Infinity, now() - DUP_WINDOW_MS);
      rec.lastRunAt = now();
      let outcome = 'failed';
      let body = '';
      let dueAt;
      let sent = null;
      let turned = false;
      try {
        const horizon = getDelivered ? null : deliveredLog.horizon?.();
        const prompt = buildPrompt({
          replies: rec.replies,
          delivered,
          queued: outbox.filter((o) => o.conversationId === cid).map((o) => ({ at: o.at ?? now(), text: o.text })),
          failed: (missed[cid] || []).map((m) => ({ at: m.at ?? now(), text: m.text })),
          deliveredSince: horizon != null && rec.since < horizon ? horizon : undefined,
          isLastCheck, userLabel, maxTextLength, maxDelivered: maxDeliveredInPrompt,
          messageCount: counters[cid] || 0, now: now(), timeZone: zoneOf(cid), reason, dueAt: rec.dueAt, language: promptLanguage,
        });
        emit({ type: 'check_started', conversationId: cid, checkId: rec.id, replies: rec.replies.length, delivered: delivered.length, recheck: rechecks, isLastCheck, reason });

        let res;
        try {
          turned = true;
          res = await callTurn(cid, prompt, { kind: 'check', checkId: rec.id, recheck: rechecks, isLastCheck, reason });
        } finally {
          free();
        }
        const text = typeof res === 'string' ? res : res?.text ?? '';
        usageOf(res, { conversationId: cid, checkId: rec.id });

        let running;
        ({ outcome, text: body, dueAt, running } = parse(text));
        if (outcome === 'due' && !validDue(dueAt)) { outcome = body ? 'deliver_running' : 'running'; dueAt = undefined; }
        if (outcome === 'due' && running) datedAt = dueAt; // both: the timer, and the running path below
        // On the last check there is nothing left to wait for.
        if (isLastCheck && outcome === 'deliver_running') outcome = 'deliver';
        const carries = outcome === 'deliver' || outcome === 'deliver_running' || outcome === 'due';
        const mode = rec.kind === 'due' && reason === 'due' ? 'due' : 'check';
        if (carries && body && isDuplicate(cid, body, { delivered, start: dupStart, mode })) {
          emit({ type: 'duplicate_skipped', conversationId: cid, checkId: rec.id, chars: body.length });
          body = '';
          if (outcome === 'deliver') outcome = 'nothing';
          if (outcome === 'deliver_running') outcome = 'running';
        }
        if (carries && body) {
          sent = await deliverOwed(cid, body, { kind: 'check', checkId: rec.id, depth: rec.depth || 0, dueDepth: rec.dueDepth || 0 });
          // No verify after a last-check status (it says the work is no longer watched), nor after
          // a delivery that also set a DUE timer (the timer is the follow-up).
          if (sent.ok && !sent.skipped && !isLastCheck && outcome !== 'due') verifies.push([sent.text, (rec.depth || 0) + 1]);
        }
        if (outcome === 'due') {
          datedAt = dueAt;
          if (running) outcome = sent?.ok ? 'deliver_running' : 'running';
        }
      } catch (error) {
        outcome = 'failed';
        emit({ type: 'error', stage: 'check', conversationId: cid, checkId: rec.id, error });
      }
      free();
      if (turned) {
        if (outcome === 'failed') turnFailed();
        else turnOk(cid);
      }

      // The last step ended with no answer for the user: code writes the line, unless the
      // circuit is open (then the step waits) or this conversation already got one this outage.
      const lastFail = outcome === 'failed' && (exhausted || timeout);
      const lastRunning = outcome === 'running' && isLastCheck;
      if (lastFail && circuitOn() && circuit.pauseMs > 0 && !timeout) {
        suppressed = true;
      } else if (lastFail || lastRunning) {
        const n = (notices[cid] ||= {});
        if (lastFail && n.gaveUp) {
          emit({ type: 'gave_up', conversationId: cid, reason: 'failed', checkId: rec.id, delivered: false, suppressed: true });
        } else {
          if (lastFail) n.gaveUp = true;
          await sendLine(cid, lastFail ? 'failed' : 'still_running', { checkId: rec.id });
        }
      }

      const ms = now() - t0;
      if (outcome === 'nothing') emit({ type: 'nothing_owed', conversationId: cid, checkId: rec.id, ms });
      else if (outcome === 'running') emit({ type: 'still_running', conversationId: cid, checkId: rec.id, recheck: rechecks + 1, ms });
      else if (outcome === 'failed') emit({ type: 'failed', conversationId: cid, checkId: rec.id, recheck: rechecks + 1, ms });
      if (sent?.ok) emit({ type: 'delivered', conversationId: cid, checkId: rec.id, chars: body.length, ms, ids: sent.ids, stillRunning: outcome === 'deliver_running' || outcome === 'running' });
      return await finish(outcome);
    } finally {
      free();
      if (probe) probing = false;
    }
  }

  // ---- jobs and report turns --------------------------------------------------------------

  // Mark the report delivered in the store before the send: a crash after the send never repeats it.
  // A text the host already covered (noteJobUserNotified) is dropped right before deliver().
  async function sendReport(rep, text, kind) {
    const drop = () => !!rep.userNotified;
    let sent = { ok: false, dropped: true };
    if (!drop()) {
      rep.delivering = true;
      await flushAll();
      sent = await deliverOwed(rep.conversationId, text, { kind, jobId: rep.job.id, depth: 0 }, drop);
    }
    if (sent.dropped) emitDropped({ conversationId: rep.conversationId, jobId: rep.job.id, kind });
    return sent;
  }

  async function reportFallback(rep, reason) {
    const sent = await sendReport(rep, fallbackReportText(rep.job, S), 'fallback');
    if (!sent.dropped) emit({ type: 'report_fallback', conversationId: rep.conversationId, jobId: rep.job.id, reason, delivered: sent.ok });
  }

  async function reportDone(rep) {
    reports = reports.filter((x) => x !== rep);
    unparkFor(rep.job);
    emit({ type: 'report_done', conversationId: rep.conversationId, jobId: rep.job.id });
    await save();
    arm();
    await api.tick();
    return 'report';
  }

  // A stored report the host already covered (noteJobUserNotified): it ends unrun.
  function skipNotified(rep) {
    rep.userNotified = true;
    emit({ type: 'report_skipped', conversationId: rep.conversationId, jobId: rep.job.id, reason: 'user_notified' });
    return reportDone(rep);
  }

  async function runReport(rep, { probe = false } = {}) {
    const cid = rep.conversationId;
    const job = rep.job;
    rep.since = job.finishedAt ?? now(); // the report prompt lists what reached the user since the job ended
    let held = false;
    const free = () => { if (held) { held = false; release(); } };
    try {
      const w = await waitForTurn(cid, rep).catch((error) => ({ error }));
      if (w.busy || w.error) {
        if (w.error) emit({ type: 'error', stage: 'isUserBusy', conversationId: cid, jobId: job.id, error: w.error });
        rep.state = 'pending';
        rep.due = now() + busyRetryMs;
        emit({ type: 'yielded', conversationId: cid, checkId: null, jobId: job.id });
        await save();
        arm();
        return 'busy';
      }
      held = true;
      if (rep.userNotified) {
        // the host told the user while this report waited (or before a restart)
        free();
        return await skipNotified(rep);
      }
      if (spendTurn(cid, 'report')) {
        free();
        emit({ type: 'daily_cap', conversationId: cid, checkId: null, jobId: job.id, until: nextDay() });
        await reportFallback(rep, 'capped');
        return await reportDone(rep);
      }
      if (missed[cid]?.length) await sendMissed(cid, true);

      let outcome = 'failed';
      let body = '';
      let dueAt;
      try {
        const prompt = buildReportPrompt({ job, userLabel, maxTextLength: maxReportLength, delivered: w.delivered || [], maxDelivered: maxDeliveredInPrompt, language: promptLanguage });
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
      if (outcome === 'failed') turnFailed();
      else turnOk(cid);

      if (outcome === 'failed') {
        rep.attempts = (rep.attempts || 0) + 1;
        if (rep.attempts <= totalRechecks || (circuitOn() && circuit.pauseMs > 0)) {
          rep.state = 'pending';
          rep.due = Math.max(now() + recheckDelay(Math.min(rep.attempts - 1, totalRechecks - 1)), circuit.openUntil || 0);
          emit({ type: 'report_retry', conversationId: cid, jobId: job.id, attempt: rep.attempts, due: rep.due });
          await save();
          arm();
          return 'failed';
        }
        await reportFallback(rep, 'failed');
        return await reportDone(rep);
      }

      if (outcome === 'due' && validDue(dueAt)) {
        addDated({ conversationId: cid, replies: [{ at: now(), text: clipText(body || fallbackReportText(job, S), maxTextLength), seq: counters[cid] }], depth: 0 }, dueAt);
      }
      const carries = (outcome === 'deliver' || outcome === 'deliver_running' || outcome === 'due') && body;
      if (!carries && outcome === 'nothing' && (lastHostReply[cid] ?? -Infinity) >= (job.finishedAt ?? Infinity)) {
        // the host answered after the job ended (for example with the result) and the model agrees
        emit({ type: 'report_skipped', conversationId: cid, jobId: job.id, reason: 'host_replied' });
      } else if (!carries) {
        await reportFallback(rep, outcome);
      } else if (isDuplicate(cid, body, { jobId: job.id, mode: 'report' })) {
        emit({ type: 'duplicate_skipped', conversationId: cid, checkId: null, jobId: job.id, chars: body.length });
      } else {
        const sent = await sendReport(rep, body, 'report');
        if (sent.ok && !sent.skipped) {
          emit({ type: 'report_delivered', conversationId: cid, jobId: job.id, chars: sent.text.length, ids: sent.ids });
          scheduleVerify(cid, sent.text, 1);
        }
      }
      return await reportDone(rep);
    } finally {
      free();
      if (probe) probing = false;
    }
  }

  const api = {
    /**
     * The agent sent `text` to the user in `conversationId`. Opens that conversation's check
     * window if none is pending; otherwise joins it (the due time never moves, except a check
     * waiting for tomorrow's cap, which comes back to now + delayMs). Kinds 'check' and 'report'
     * (replies the host delivered itself) count and get one verify check; 'giveup', 'fallback'
     * and 'missed' only count; 'system' does neither. A package delivery routed back here is
     * recognized and ignored (it is already counted and verified).
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
      lastHostReply[cid] = t;
      const reply = { at: t, text: clipText(text, maxTextLength), seq: counters[cid] };
      let rec = find(cid, 'pending');
      if (rec) {
        rec.replies = keepFirst([...rec.replies, reply]);
        if (rec.kind === 'verify') rec.kind = 'window'; // a new reply joined: it is a window check now
        rec.depth = 0; // a normal reply starts a new chain: verify depth counts package replies only
        rec.fresh = true;
        if (rec.capped && rec.due > t + delayMs) { rec.due = t + delayMs; delete rec.capped; }
        emit({ type: 'merged', conversationId: cid, checkId: rec.id, replies: rec.replies.length, due: rec.due });
      } else {
        rec = { id: newId('chk', t), conversationId: cid, state: 'pending', kind: 'window', fresh: true, due: t + delayMs, replies: [reply], rechecks: 0, depth: 0 };
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

    /** A message really reached the user (built-in delivered log). Never throws into your send path. */
    noteDelivered(conversationId, text, atOrOpts) {
      const opts = typeof atOrOpts === 'number' ? { at: atOrOpts } : atOrOpts || {};
      try {
        touch(String(conversationId));
        return deliveredLog.note(conversationId, text, opts);
      } catch (error) {
        emit({ type: 'error', stage: 'deliveredLog', conversationId: String(conversationId), error });
        return { at: opts.at ?? now(), text: String(text ?? '') };
      }
    },

    /**
     * "Missed:" notices for deliveries that were given up on, for the host to send before its
     * next message in that conversation. Each is returned once and its timer is cancelled.
     */
    flushMissed(conversationId) {
      const cid = String(conversationId);
      const list = missed[cid] || [];
      delete missed[cid];
      if (list.length) { void save(); arm(); }
      return list.map((m) => missedLine(m.text));
    },

    /** True while a model turn (check or report) runs for this conversation. */
    isChecking(conversationId) {
      return activeTurns.has(String(conversationId));
    },

    /** The host started long work for this conversation. A STILL_RUNNING check parks on it. */
    trackJob(conversationId, jobId, { title } = {}) {
      const id = String(jobId);
      const job = { id, conversationId: String(conversationId), title: title ?? id, startedAt: now() };
      jobs[id] = job;
      touch(job.conversationId);
      emit({ type: 'job_tracked', conversationId: job.conversationId, jobId: id, title: job.title });
      void save();
      return { ...job };
    },

    /**
     * Tracked work ended. Resolves at once with the finished job. In the background: onJobFinished,
     * or one stored report turn (it waits for a busy user, retries on failure and falls back to a
     * code-written line), then any check parked on it. Events say when: report_delivered,
     * report_fallback, report_done.
     */
    finishJob(jobId, { status = 'done', text = '', summary, userNotified = false } = {}) {
      const id = String(jobId);
      const open = jobs[id];
      if (!open) return Promise.resolve(null);
      delete jobs[id];
      const { userNotified: notedBefore, ...rest } = open;
      const job = { ...rest, status, text: String(text ?? ''), ...(summary != null ? { summary: String(summary) } : {}), finishedAt: now() };
      const cid = job.conversationId;
      emit({ type: 'job_finished', conversationId: cid, jobId: id, status });
      if (userNotified || notedBefore) {
        // the host already told the user how it ended: no report turn, no onJobFinished
        emit({ type: 'report_skipped', conversationId: cid, jobId: id, reason: 'user_notified' });
        unparkFor(job);
        void save();
        arm();
        void track(api.tick());
      } else if (typeof onJobFinished === 'function') {
        void track((async () => {
          try { await timed('onJobFinished', () => onJobFinished(cid, { ...job })); } catch (error) { emit({ type: 'error', stage: 'onJobFinished', conversationId: cid, jobId: id, error }); }
          unparkFor(job);
          await save();
          arm();
          await api.tick();
        })());
      } else {
        reports.push({ id: newId('rep', now()), conversationId: cid, job, due: now(), attempts: 0, state: 'pending' });
        void save();
        void track(api.tick());
      }
      return Promise.resolve({ ...job });
    },

    /**
     * The host told the user itself how a job ended (or will, for an open job). An open job's
     * finishJob then runs no report turn; a report still waiting is skipped; a report turn already
     * running, or a report waiting for a delivery retry, is dropped before deliver(). Returns
     * false when nothing about that job is still open.
     */
    noteJobUserNotified(jobId) {
      const id = String(jobId);
      if (jobs[id]) {
        jobs[id].userNotified = true;
        void save();
        return true;
      }
      let found = false;
      const rep = reports.find((p) => p.job.id === id);
      if (rep) {
        found = true;
        rep.userNotified = true;
        if (rep.state !== 'running') {
          rep.state = 'running';
          void track(skipNotified(rep));
        }
      }
      for (const o of outbox.filter((x) => x.jobId === id && (x.kind === 'report' || x.kind === 'fallback'))) {
        found = true;
        if (o.sending) { o.userNotified = true; continue; } // dropped before its deliver()
        outbox = outbox.filter((x) => x !== o);
        emitDropped(o);
      }
      if (found) { void save(); arm(); }
      return found;
    },

    /** trackJob, await the work, finishJob with its result (or error message), return the result. */
    async wrapJob(conversationId, jobId, work, { title, userNotifiedOnError = false } = {}) {
      api.trackJob(conversationId, jobId, { title });
      let result;
      try {
        result = await (typeof work === 'function' ? work() : work);
      } catch (error) {
        // userNotifiedOnError: the host's own error path tells the user (true, or per error)
        let userNotified = false;
        try { userNotified = typeof userNotifiedOnError === 'function' ? !!userNotifiedOnError(error) : !!userNotifiedOnError; } catch { userNotified = false; }
        await api.finishJob(jobId, { status: 'error', text: error?.message ?? String(error), userNotified });
        throw error;
      }
      let text = '';
      if (typeof result === 'string') text = result;
      else if (typeof result?.text === 'string') text = result.text;
      else if (result != null) { try { text = JSON.stringify(result); } catch { text = String(result); } }
      // the code-written fallback never shows raw JSON: the result's text or summary, else nothing
      const summary = typeof result === 'string' ? result : typeof result?.text === 'string' ? result.text : typeof result?.summary === 'string' ? result.summary : '';
      await api.finishJob(jobId, { status: 'done', text, summary });
      return result;
    },

    /**
     * Load persisted state and arm the timer. Notes made before start() are merged in. Checks and
     * reports that were running at a stop run again; a report already marked delivered is done.
     * Jobs found in the store died with the old process: they finish as 'lost' unless
     * onStartJobs(jobs) returns their ids.
     */
    async start() {
      if (started) return api;
      store.lock?.();
      const raw = (await store.load()) || [];
      const state = Array.isArray(raw) ? { records: raw } : raw; // v0.1 stores held a plain array
      for (const [k, v] of Object.entries(state.counters || {})) counters[k] = (counters[k] || 0) + v;
      for (const [k, v] of Object.entries(state.lastActive || {})) lastActive[k] = Math.max(lastActive[k] || 0, v);
      for (const k of Object.keys(counters)) lastActive[k] ??= now();
      const loadedJobs = [];
      for (const [k, v] of Object.entries(state.jobs || {})) if (!jobs[k]) { jobs[k] = v; loadedJobs.push(v); }
      for (const [k, v] of Object.entries(state.missed || {})) {
        const list = (Array.isArray(v) ? v : [v]).map((m) => (typeof m === 'string' ? { text: m, at: now(), due: now(), wait: missedRetryMs } : m));
        missed[k] = [...list, ...(missed[k] || [])];
      }
      for (const [k, v] of Object.entries(state.turnsByDay || {})) if (!turnsByDay[k]) turnsByDay[k] = v;
      for (const [k, v] of Object.entries(state.notices || {})) notices[k] = { ...v, ...(notices[k] || {}) };
      if (state.globalTurns) globalTurns = state.globalTurns;
      if (state.circuit) circuit = state.circuit;
      const seenOut = new Set(outbox.map((o) => o.id));
      for (const o of state.outbox || []) if (!seenOut.has(o.id)) outbox.push({ ...o, sending: undefined });
      const seenRep = new Set(reports.map((p) => p.id));
      const doneReports = [];
      for (const p of state.reports || []) {
        if (seenRep.has(p.id)) continue;
        if (p.delivering) { doneReports.push(p); continue; } // sent (or tried) before the stop: never again
        reports.push({ ...p, state: 'pending' });
      }
      const seen = new Set(records.map((r) => r.id));
      for (const r of state.records || []) {
        if (seen.has(r.id)) continue;
        if (r.state === 'dated') { records.push({ ...r }); continue; }
        if (r.state === 'parked') {
          const parkedOn = (r.parkedOn || []).filter((id) => jobs[id]);
          if (parkedOn.length || r.timedOut) { records.push({ ...r, parkedOn }); continue; }
          records.push({ ...r, state: 'parked', parkedOn: [] });
          unpark(records[records.length - 1], null);
          continue;
        }
        const rec = { ...r, state: 'pending', rechecks: r.rechecks || 0 };
        const cur = find(rec.conversationId, 'pending');
        if (cur) {
          cur.replies = keepFirst([...rec.replies, ...cur.replies]);
          cur.due = Math.min(cur.due, rec.due);
          cur.rechecks = Math.max(cur.rechecks || 0, rec.rechecks);
        } else records.push(rec);
      }
      loaded = true;
      for (const p of doneReports) unparkFor(p.job);
      let keep = [];
      if (loadedJobs.length && typeof onStartJobs === 'function') {
        try { keep = (await timed('onStartJobs', () => onStartJobs(loadedJobs.map((j) => ({ ...j }))))) || []; } catch (error) { emit({ type: 'error', stage: 'onStartJobs', error }); }
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
        void api.finishJob(j.id, { status: 'lost', text: S.lostText });
      }
      return api;
    },

    /** Stop the timer and write the final state (sync when the store can). Work already running finishes. */
    async stop() {
      started = false;
      if (timer != null) { clearTimer(timer); timer = null; }
      if (loaded) {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        if (typeof store.saveSync === 'function') {
          try { store.saveSync(snapshot()); } catch (error) { emit({ type: 'error', stage: 'store', error }); }
        } else {
          await flushAll();
        }
      }
      try { deliveredLog.flush?.(); } catch (error) { emit({ type: 'error', stage: 'deliveredLog', error }); }
      try { store.unlock?.(); } catch { /* ignore */ }
      emit({ type: 'stopped' });
    },

    /** Write any debounced state change now. */
    flush() {
      return flushAll();
    },

    /**
     * Run every check, report, missed notice and delivery retry that is due now: at most one model
     * turn per conversation at a time (reports first), none while the circuit is open.
     */
    async tick() {
      const t = now();
      const taken = new Set();
      for (const r of records) if (r.state === 'running') taken.add(r.conversationId);
      for (const p of reports) if (p.state === 'running') taken.add(p.conversationId);
      const runs = [];
      const halfOpen = circuitOn() && circuit.pauseMs > 0;
      const canRun = () => !modelBlocked() && !(halfOpen && runs.length);
      for (const p of reports.filter((x) => x.state === 'pending' && x.due <= t).sort(byDue)) {
        if (taken.has(p.conversationId)) continue;
        if (circuitOn() && circuit.pauseMs > 0) {
          // the model is out (circuit open or not yet closed again): the job's own output goes
          // now, as the code-written report
          taken.add(p.conversationId);
          p.state = 'running';
          runs.push(async () => { await reportFallback(p, 'circuit_open'); return reportDone(p); });
          continue;
        }
        if (!canRun()) continue;
        taken.add(p.conversationId);
        p.state = 'running';
        const probe = halfOpen;
        if (probe) probing = true;
        runs.push(() => runReport(p, { probe }));
      }
      const due = records.filter((r) => (r.state === 'pending' || r.state === 'parked' || r.state === 'dated') && r.due <= t).sort(byDue);
      for (const r of due) {
        if (taken.has(r.conversationId)) continue;
        if (r.state === 'parked' && r.timedOut) {
          records = records.filter((x) => x !== r);
          emit({ type: 'park_ended', conversationId: r.conversationId, checkId: r.id, jobIds: r.parkedOn || [] });
          continue;
        }
        if (!canRun()) continue;
        const from = r.state;
        taken.add(r.conversationId);
        r.state = 'running';
        const probe = halfOpen;
        if (probe) probing = true;
        runs.push(() => runCheck(r, { timeout: from === 'parked', from, probe }));
      }
      const retries = outbox.filter((o) => !o.sending && o.due <= t);
      const missedDue = Object.keys(missed).filter((cid) => !missedLocks.has(cid) && missed[cid]?.some((m) => m.due <= t));
      if (!runs.length && !retries.length && !missedDue.length) { arm(); return []; }
      for (const o of retries) o.sending = true;
      await save();
      arm();
      for (const o of retries) void track(retryDelivery(o));
      for (const cid of missedDue) void track(sendMissed(cid, false).then(() => arm()));
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

    /** Copies of the owed "Missed:" notices: [{ conversationId, text, due }]. */
    missed() {
      return Object.entries(missed).flatMap(([cid, list]) => (list || []).map((m) => ({ conversationId: cid, text: m.text, due: m.due })));
    },

    /** The circuit breaker: { open, fails, until }. */
    circuit() {
      return { open: circuitOpen(), fails: circuit.fails, until: circuit.openUntil };
    },

    deliveredLog,
  };
  return api;
}
