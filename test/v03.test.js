// v0.3: every promise is delivered, or the user is told plainly it was not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore, createDeliveredLog } from '../src/index.js';
import { world, MIN } from './helpers.js';

const C = 'chat-3';
const FIVE = 5 * MIN;
const GIVE_UP = 'I could not check on what I promised you earlier. Ask me again if it is still open.';
const LADDER = [5, 10, 15, 20, 25, 30, 35, 50, 80, 140, 260];

async function five(opts = {}, extra = {}) {
  const w = world(opts);
  w.no = w.make({ delayMs: FIVE, ...extra });
  await w.no.start();
  return w;
}
const texts = (w) => w.sent.map((s) => s.text);
const checkMins = (w, t0) => w.events.filter((e) => e.type === 'check_started').map((e) => (e.at - t0) / MIN);
const steps = async (w, minutes) => { for (let m = 0; m < minutes; m++) await w.advance(MIN); };
const boom = () => { throw new Error('overloaded'); };

// ---- 1. failed checks requeue ---------------------------------------------------------------

test('a check turn that throws is retried delayMs later, and its delivery then lands', async () => {
  const w = await five({ reply: boom });
  w.no.noteReply(C, 'I will send the summary when it is done.');
  await w.advance(FIVE);
  assert.equal(w.no.pending().length, 1, 'requeued, not dropped');
  assert.equal(w.no.pending()[0].rechecks, 1);
  w.reply = 'Here is the summary.';
  await w.advance(FIVE);
  assert.deepEqual(texts(w), ['Here is the summary.']);
});

test('empty answers and canned failure texts requeue like a throw', async () => {
  for (const reply of ['', '...', 'Model down.']) {
    const w = await five({ reply }, { failTexts: ['Model down.'] });
    w.no.noteReply(C, 'x');
    await w.advance(FIVE);
    assert.equal(w.no.pending().length, 1, JSON.stringify(reply));
    assert.deepEqual(w.sent, []);
  }
});

test('failures walk the whole ladder, then the user gets the fixed give-up line', async () => {
  const w = await five({ reply: boom });
  const t0 = w.t;
  w.no.noteReply(C, 'x');
  await steps(w, 300);
  assert.deepEqual(checkMins(w, t0), LADDER);
  assert.deepEqual(texts(w), [GIVE_UP]);
  assert.equal(w.metas[0].kind, 'giveup');
  assert.equal(w.no.pending().length, 0);
  assert.ok(w.types().includes('gave_up'));
});

test('giveUpText(ctx) replaces the line', async () => {
  const seen = [];
  const w = await five({ reply: boom }, { maxRechecks: 1, backoffMs: [], giveUpText: (ctx) => { seen.push(ctx); return 'Sorry, lost track.'; } });
  w.no.noteReply(C, 'x');
  await steps(w, 20);
  assert.deepEqual(texts(w), ['Sorry, lost track.']);
  assert.equal(seen[0].conversationId, C);
  assert.equal(seen[0].reason, 'failed');
});

test('a last check that answers only STILL_RUNNING still tells the user it is no longer watched', async () => {
  const w = await five({ reply: 'STILL_RUNNING' }, { maxRechecks: 1, backoffMs: [] });
  w.no.noteReply(C, 'x');
  await steps(w, 20);
  assert.equal(w.sent.length, 1);
  assert.match(texts(w)[0], /no longer watching/);
});

// ---- 2. turn timeout ------------------------------------------------------------------------

test('a runTurn that never settles times out after turnTimeoutMs, is aborted, and counts as failed', async () => {
  let signal;
  const w = await five({ reply: (_c, _p, ctx) => { signal = ctx.signal; return new Promise(() => {}); } }, { turnTimeoutMs: 3 * MIN });
  w.no.noteReply(C, 'promise 1');
  await w.advance(FIVE, { wait: false });
  assert.equal(signal.aborted, false);
  await w.advance(3 * MIN, { wait: false });
  assert.equal(signal.aborted, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(w.no.pending().length, 1, 'requeued');
  assert.ok(w.events.some((e) => e.type === 'error' && e.stage === 'check' && /timed out/.test(e.error.message)));
  w.reply = 'Delivered now.';
  await w.advance(FIVE);
  assert.deepEqual(texts(w), ['Delivered now.']);
});

test('turnTimeoutMs defaults to 3 minutes', async () => {
  const w = await five({ reply: () => new Promise(() => {}) });
  w.no.noteReply(C, 'x');
  await w.advance(FIVE, { wait: false });
  await w.advance(3 * MIN - 1, { wait: false });
  assert.equal(w.no.pending().length, 0);
  await w.advance(1, { wait: false });
  await new Promise((r) => setImmediate(r));
  assert.equal(w.no.pending().length, 1);
});

// ---- 3. verify chain ------------------------------------------------------------------------

test('a delivered check reply gets one verify check delayMs later; NOTHING_OWED ends it', async () => {
  const w = await five({ reply: 'Still on it, I will send the summary in ten minutes.' });
  w.no.noteReply(C, 'I will send the summary when it is done.');
  await w.advance(FIVE);
  const p = w.no.pending();
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, 'verify');
  assert.equal(p[0].depth, 1);
  assert.match(p[0].replies.at(-1).text, /ten minutes/);
  w.reply = 'NOTHING_OWED';
  await w.advance(FIVE);
  assert.equal(w.turns.length, 2);
  assert.equal(w.turns[1].ctx.reason, 'verify');
  assert.match(w.turns[1].prompt, /ten minutes/);
  await w.advance(60 * MIN);
  assert.equal(w.turns.length, 2);
});

test('the verify chain stops at maxVerifyDepth', async () => {
  let n = 0;
  const w = await five({ reply: () => `Part ${++n}, more soon.` });
  w.no.noteReply(C, 'x');
  await steps(w, 120);
  assert.deepEqual(texts(w), ['Part 1, more soon.', 'Part 2, more soon.', 'Part 3, more soon.', 'Part 4, more soon.']);
  const w2 = await five({ reply: () => `Part ${++n}` }, { maxVerifyDepth: 1 });
  w2.no.noteReply(C, 'x');
  await steps(w2, 60);
  assert.equal(w2.sent.length, 2);
});

test('a delivered job report gets a verify check too', async () => {
  const w = await five({ reply: (_c, _p, ctx) => (ctx.kind === 'report' ? 'Done. I will also send the logs later.' : 'NOTHING_OWED') });
  w.no.trackJob(C, 'j', { title: 'build' });
  await w.no.finishJob('j', { text: 'ok' });
  assert.equal(w.no.pending()[0].kind, 'verify');
  await w.advance(FIVE);
  assert.equal(w.turns.at(-1).ctx.reason, 'verify');
});

test('host replies noted as check or report get one verify check', async () => {
  const w = await five();
  const rec = w.no.noteReply(C, 'Report: done. Logs follow tomorrow.', { kind: 'report' });
  assert.equal(rec.kind, 'verify');
  assert.equal(w.no.messageCount(C), 1);
  await w.advance(FIVE);
  assert.equal(w.turns.length, 1);
  assert.equal(w.no.noteReply(C, 'y', { kind: 'system' }), null);
});

test('the package delivery routed back through noteReply is not counted twice and starts nothing extra', async () => {
  for (const kind of [undefined, 'check']) {
    const w = world({ reply: 'Here it is.' });
    w.no = w.make({ delayMs: FIVE, deliver: async (cid, text, meta) => { w.sent.push({ conversationId: cid, text }); w.no.noteReply(cid, text, { kind: kind && meta.kind }); } });
    await w.no.start();
    w.no.noteReply(C, 'promise');
    await w.advance(FIVE);
    assert.equal(w.no.messageCount(C), 2, String(kind));
    assert.equal(w.no.pending().length, 1, 'only the package verify');
    assert.equal(w.no.pending()[0].replies.length, 1);
  }
});

// ---- 4. dated promises ----------------------------------------------------------------------

test('DUE <time> alone: nothing sent, a timer at that time runs a check with the original replies', async () => {
  const w = await five();
  const t0 = w.t;
  const at = t0 + 20 * 60 * MIN;
  w.reply = `DUE ${new Date(at).toISOString()}`;
  w.no.noteReply(C, 'I will remind you tomorrow at 9.');
  await w.advance(FIVE);
  assert.deepEqual(w.sent, []);
  assert.equal(w.no.pending().length, 0);
  assert.equal(w.no.dated().length, 1);
  assert.equal(w.no.dated()[0].due, at);
  w.reply = 'Reminder: your call is now.';
  await w.advance(at - w.t - 1);
  assert.equal(w.turns.length, 1, 'no wakes until the time');
  await w.advance(1);
  assert.equal(w.turns.length, 2);
  assert.equal(w.turns[1].ctx.reason, 'due');
  assert.match(w.turns[1].prompt, /I will remind you tomorrow at 9/);
  assert.match(w.turns[1].prompt, /time you set/);
  assert.deepEqual(texts(w), ['Reminder: your call is now.']);
  assert.equal(w.no.dated().length, 0);
});

test('content then a DUE line: the content goes now and the timer is set', async () => {
  const w = await five();
  const at = w.t + 2 * 60 * MIN;
  w.reply = `Here is part one.\nDUE ${new Date(at).toISOString()}`;
  w.no.noteReply(C, 'x');
  await w.advance(FIVE);
  assert.deepEqual(texts(w), ['Here is part one.']);
  assert.equal(w.no.dated()[0].due, at);
});

test('a dated timer survives a restart; new replies open a normal window beside it', async () => {
  const store = createMemoryStore();
  const w = world({ store });
  w.no = w.make({ delayMs: FIVE });
  await w.no.start();
  const at = w.t + 3 * 60 * MIN;
  w.reply = `DUE ${new Date(at).toISOString()}`;
  w.no.noteReply(C, 'remind at noon');
  await w.advance(FIVE);
  w.no.stop();
  w.timers = [];
  w.no = w.make({ delayMs: FIVE });
  await w.no.start();
  assert.equal(w.no.dated().length, 1);
  const rec = w.no.noteReply(C, 'another thing');
  assert.equal(rec.replies.length, 1, 'not merged into the dated record');
  w.reply = 'NOTHING_OWED';
  await w.advance(FIVE);
  w.reply = 'It is noon: here is your reminder.';
  await w.advance(at - w.t);
  assert.deepEqual(texts(w), ['It is noon: here is your reminder.']);
});

test('a DUE time past maxDueMs, or in the past, is treated as running', async () => {
  const w = await five({}, { maxDueMs: 60 * MIN });
  w.reply = `DUE ${new Date(w.t + 5 * 60 * MIN).toISOString()}`;
  w.no.noteReply(C, 'x');
  await w.advance(FIVE);
  assert.equal(w.no.dated().length, 0);
  assert.equal(w.no.pending()[0].rechecks, 1);
  w.reply = `DUE ${new Date(w.t - MIN).toISOString()}`;
  await w.advance(FIVE);
  assert.equal(w.no.pending()[0].rechecks, 2);
});

// ---- 6. restart: lost jobs ------------------------------------------------------------------

test('jobs found in the store at start are lost: the normal finish path runs and the check unparks', async () => {
  const store = createMemoryStore();
  const w = world({ store, reply: 'STILL_RUNNING' });
  w.no = w.make({ delayMs: FIVE });
  await w.no.start();
  w.no.trackJob(C, 'render-1', { title: 'render' });
  w.no.noteReply(C, 'Rendering, I will report when done.');
  await w.advance(FIVE);
  assert.equal(w.no.parked().length, 1);
  w.no.stop();
  w.timers = [];
  w.reply = (_c, p, ctx) => (ctx.kind === 'report' ? 'The render was interrupted by a restart. Ask me to start it again.' : 'NOTHING_OWED');
  w.no = w.make({ delayMs: FIVE });
  await w.no.start();
  await w.no.idle();
  assert.deepEqual(w.no.jobs(), []);
  const report = w.turns.find((t) => t.ctx.kind === 'report');
  assert.match(report.prompt, /Status: lost/);
  assert.match(report.prompt, /the work was interrupted by a restart/);
  assert.deepEqual(texts(w), ['The render was interrupted by a restart. Ask me to start it again.']);
  assert.equal(w.no.parked().length, 0);
  assert.ok(w.events.some((e) => e.type === 'job_finished' && e.status === 'lost'));
});

test('onStartJobs keeps the jobs the host still runs', async () => {
  const store = createMemoryStore();
  const w = world({ store });
  w.no = w.make({ delayMs: FIVE });
  await w.no.start();
  w.no.trackJob(C, 'a', { title: 'A' });
  w.no.trackJob(C, 'b', { title: 'B' });
  w.no.stop();
  let given;
  w.no = w.make({ delayMs: FIVE, onStartJobs: (jobs) => { given = jobs.map((j) => j.id); return ['b']; } });
  await w.no.start();
  await w.no.idle();
  assert.deepEqual(given.sort(), ['a', 'b']);
  assert.deepEqual(w.no.jobs().map((j) => j.id), ['b']);
});

// ---- 7. no delivering guard; the package logs its own deliveries -----------------------------

test('a normal reply sent while the package is delivering is scheduled, not dropped', async () => {
  let release;
  const w = world({ reply: 'Here is what I owed.' });
  w.no = w.make({ delayMs: FIVE, deliver: () => new Promise((r) => { release = r; }) });
  await w.no.start();
  w.no.noteReply(C, 'first');
  void w.advance(FIVE, { wait: false });
  await new Promise((r) => setTimeout(r, 10));
  const r = w.no.noteReply(C, 'Sure, I will send the invoice tonight');
  assert.ok(r, 'scheduled');
  release();
  await w.no.idle();
  assert.ok(w.no.pending().some((p) => p.replies.some((x) => /invoice/.test(x.text))));
});

test('the package records its own confirmed deliveries in the built-in delivered log, once', async () => {
  const w = await five({ reply: 'Here is part A.\nSTILL_RUNNING' });
  w.no.noteReply(C, 'A and B coming');
  w.no.noteDelivered(C, 'A and B coming');
  await w.advance(FIVE);
  w.reply = 'STILL_RUNNING';
  await w.advance(FIVE);
  const p = w.turns[1].prompt;
  const part = p.split('send log):')[1].split('Only what')[0];
  assert.match(part, /Here is part A\./);
  assert.equal(w.metas[0].kind, 'check');
  // a host that also logs it does not create a second entry
  const w2 = world({ reply: 'Here it is.' });
  w2.no = w2.make({ delayMs: FIVE, deliver: async (cid, text) => { w2.no.noteDelivered(cid, text, { id: 'm1' }); } });
  await w2.no.start();
  w2.no.noteReply(C, 'x');
  await w2.advance(FIVE);
  assert.equal(w2.no.deliveredLog.since(C, 0).length, 1);
});

// ---- 8. report turns ------------------------------------------------------------------------

test('the report turn waits while the user is busy', async () => {
  let busy = true;
  const w = await five({ reply: 'Report: done.' }, { isUserBusy: () => busy, busyRetryMs: MIN });
  w.no.trackJob(C, 'j', { title: 'build' });
  await w.no.finishJob('j', { text: 'ok' });
  assert.equal(w.turns.length, 0);
  assert.equal(w.no.reports().length, 1);
  busy = false;
  await w.advance(MIN);
  assert.equal(w.turns.length, 1);
  assert.deepEqual(texts(w), ['Report: done.']);
  assert.equal(w.no.reports().length, 0);
});

test('a failed report turn is retried, then a code-written fallback goes out', async () => {
  const w = await five({ reply: boom }, { maxRechecks: 1, backoffMs: [] });
  w.no.trackJob(C, 'j1', { title: 'render' });
  await w.no.finishJob('j1', { status: 'done', text: 'RESULT: 42\nmore lines' });
  assert.equal(w.sent.length, 0);
  await w.advance(FIVE);
  assert.equal(w.turns.length, 2);
  assert.deepEqual(texts(w), ['render done: RESULT: 42']);
  assert.equal(w.metas[0].kind, 'fallback');
  assert.ok(w.types().includes('report_fallback'));
});

test('a report that answers NOTHING_OWED or only STILL_RUNNING gets the fallback at once', async () => {
  for (const reply of ['NOTHING_OWED', 'STILL_RUNNING']) {
    const w = await five({ reply });
    w.no.trackJob(C, 'j', { title: 'export' });
    await w.no.finishJob('j', { status: 'error', text: 'x'.repeat(400) });
    assert.deepEqual(texts(w), [`export error: ${'x'.repeat(300)}`], reply);
  }
});

test('a pending report survives a restart', async () => {
  const store = createMemoryStore();
  const w = world({ store, reply: 'Report: done.' });
  w.no = w.make({ delayMs: FIVE, isUserBusy: () => true });
  await w.no.start();
  w.no.trackJob(C, 'j', { title: 'build' });
  await w.no.finishJob('j', { text: 'ok' });
  w.no.stop();
  w.timers = [];
  w.no = w.make({ delayMs: FIVE });
  await w.no.start();
  await w.advance(MIN);
  assert.deepEqual(texts(w), ['Report: done.']);
});

// ---- 9. missed ------------------------------------------------------------------------------

test('a give-up keeps the full text; flushMissed hands it to the host once', async () => {
  const long = 'L'.repeat(500);
  let down = true;
  const w = world({ reply: long });
  w.no = w.make({ delayMs: FIVE, maxDeliveryAttempts: 2, deliver: async (cid, text) => { if (down) throw new Error('net'); w.sent.push({ conversationId: cid, text }); } });
  await w.no.start();
  w.no.noteReply(C, 'x');
  await w.advance(FIVE);
  await w.advance(FIVE);
  assert.ok(w.types().includes('delivery_failed'));
  assert.deepEqual(w.no.flushMissed(C), [`Missed: ${long}`]);
  assert.deepEqual(w.no.flushMissed(C), []);
  down = false;
});

test('a give-up schedules a fresh check, which sends the Missed notice first', async () => {
  let down = true;
  const w = world({ reply: 'Your summary: three points.' });
  w.no = w.make({ delayMs: FIVE, maxDeliveryAttempts: 2, deliver: async (cid, text) => { if (down) throw new Error('net'); w.sent.push({ conversationId: cid, text }); } });
  await w.no.start();
  w.no.noteReply(C, 'summary coming');
  await w.advance(FIVE);
  await w.advance(FIVE); // attempt 2 fails: give-up
  assert.equal(w.no.pending().length, 1, 'fresh check');
  down = false;
  w.reply = (_c, p) => (p.includes('Your summary: three points.') ? 'NOTHING_OWED' : 'Your summary: three points.');
  await w.advance(FIVE);
  assert.deepEqual(texts(w), ['Missed: Your summary: three points.']);
});

// ---- 10. duplicates -------------------------------------------------------------------------

test('the check prompt lists queued deliveries, and an exact copy of one is not sent again', async () => {
  let down = true;
  const sent = [];
  const w = world({ reply: 'Part A is ready.\nSTILL_RUNNING' });
  w.no = w.make({ delayMs: FIVE, retryMs: 7 * MIN, deliver: async (c, text) => { if (down) throw new Error('net'); sent.push(text); } });
  await w.no.start();
  w.no.noteReply(C, 'A and B coming');
  await w.advance(FIVE); // the send fails: queued for minute 12, recheck at minute 10
  await w.advance(FIVE); // the recheck writes part A again, word for word
  assert.match(w.turns[1].prompt, /Queued, will be sent automatically - do not write these again:\n1\. \([^)]*\) "Part A is ready\."/);
  assert.ok(w.types().includes('duplicate_skipped'));
  down = false;
  await w.advance(2 * MIN);
  assert.deepEqual(sent, ['Part A is ready.']);
});

test('the prompt is built after the wait for a turn slot', async () => {
  const w = await five({}, { maxConcurrent: 1 });
  w.reply = (cid) => {
    if (cid === 'a') w.no.noteDelivered('b', 'sent to b during the turn of a');
    return 'NOTHING_OWED';
  };
  w.no.noteReply('a', 'x');
  w.no.noteReply('b', 'y');
  await w.advance(FIVE);
  const pb = w.turns.find((t) => t.conversationId === 'b').prompt;
  assert.match(pb, /sent to b during the turn of a/);
});

// ---- 12. bounds -----------------------------------------------------------------------------

test('maxConcurrent caps model turns across conversations (default 2)', async () => {
  let live = 0;
  let peak = 0;
  const w = await five({ reply: async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 2)); live--; return 'NOTHING_OWED'; } });
  for (let i = 0; i < 20; i++) w.no.noteReply(`user${i}`, 'hi');
  await w.advance(FIVE);
  assert.equal(w.turns.length, 20);
  assert.equal(peak, 2);
});

test('dailyCap: past the cap a conversation waits for the next day', async () => {
  const w = await five({ reply: 'STILL_RUNNING' }, { dailyCap: 3 });
  w.no.noteReply(C, 'x');
  await steps(w, 30);
  assert.equal(w.turns.length, 3);
  assert.ok(w.types().includes('daily_cap'));
  assert.equal(w.no.pending().length, 1);
  const DAY = 24 * 60 * MIN;
  const next = (Math.floor(w.t / DAY) + 1) * DAY;
  assert.equal(w.no.pending()[0].due, next);
  w.reply = 'NOTHING_OWED';
  await w.advance(next - w.t);
  assert.equal(w.turns.length, 4);
});

test('a stored reply keeps its head and tail, so a promise at the end is seen', async () => {
  const w = await five();
  w.no.noteReply(C, 'Here is the analysis. ' + 'detail '.repeat(60) + 'I will send the full PDF tonight.');
  await w.advance(FIVE);
  assert.match(w.turns[0].prompt, /full PDF tonight/);
});

test('the delivered list in the prompt is capped (maxDeliveredInPrompt)', async () => {
  const w = await five({}, { maxDeliveredInPrompt: 40 });
  w.no.noteReply(C, 'will report');
  for (let i = 0; i < 400; i++) w.no.noteDelivered(C, `m${i} ${'x'.repeat(290)}`);
  await w.advance(FIVE);
  assert.ok(w.turns[0].prompt.includes('(360 older not shown)'));
  assert.ok(w.turns[0].prompt.length < 20000);
});

test('the built-in delivered log drops conversations idle longer than maxAgeMs', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'nothing-owed-')), 'delivered.json');
  let t = 0;
  const log = createDeliveredLog({ path, now: () => t, maxAgeMs: 100 });
  log.note('old-chat', 'hi');
  t = 500;
  log.note('new-chat', 'hello');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))), ['new-chat']);
});

// ---- 13. one turn per conversation ----------------------------------------------------------

test('a pending and a dated record of one conversation never run in the same pass', async () => {
  const w = await five();
  let live = 0;
  let overlap = false;
  const at = w.t + 30 * MIN;
  w.reply = async () => { live++; if (live > 1) overlap = true; await new Promise((r) => setTimeout(r, 2)); live--; return `DUE ${new Date(at).toISOString()}`; };
  w.no.noteReply(C, 'remind me');
  await w.advance(FIVE);
  w.reply = async () => { live++; if (live > 1) overlap = true; await new Promise((r) => setTimeout(r, 2)); live--; return 'NOTHING_OWED'; };
  await w.advance(20 * MIN);
  w.no.noteReply(C, 'another', { at: at - FIVE });
  await w.advance(at - w.t);
  await w.no.idle();
  assert.equal(overlap, false);
  assert.equal(w.turns.length, 3);
});

test('a v0.2 store loads: its missed string becomes one notice', async () => {
  const store = createMemoryStore({ version: 2, records: [], counters: { [C]: 4 }, jobs: {}, outbox: [], missed: { [C]: 'old clipped text' } });
  const w = world({ store });
  w.no = w.make({ delayMs: FIVE });
  await w.no.start();
  assert.equal(w.no.messageCount(C), 4);
  assert.deepEqual(w.no.flushMissed(C), ['Missed: old clipped text']);
});
