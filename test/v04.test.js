// v0.4: the second review's holes, one test (or more) per item.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore, createFileStore, createNothingOwed } from '../src/index.js';
import { world, MIN } from './helpers.js';

const C = 'chat-4';
const FIVE = 5 * MIN;
const DAY = 24 * 60 * MIN;
const texts = (w) => w.sent.map((s) => s.text);
const steps = async (w, minutes, o) => { for (let m = 0; m < minutes; m++) await w.advance(MIN, o); };
const boom = () => { throw new Error('overloaded'); };
const deliveredPart = (p) => (p.split('send log):')[1] ?? '').split('Only what is')[0];

async function five(opts = {}, extra = {}) {
  const w = world(opts);
  w.no = w.make({ delayMs: FIVE, ...extra });
  await w.no.start();
  return w;
}

// ---- 1. missed notices have their own timer -------------------------------------------------

test('a missed notice is retried on its own timer, 15 min doubling, until it lands', async () => {
  let down = true;
  const w = world({ reply: 'Summary: three points.' });
  w.no = w.make({ delayMs: FIVE, maxDeliveryAttempts: 2, deliver: async (c, text) => { if (down) throw new Error('net'); w.sent.push({ conversationId: c, text }); } });
  await w.no.start();
  const t0 = w.t;
  w.no.noteReply(C, 'summary coming');
  await steps(w, 10); // 5: fail, 10: fail -> give-up
  assert.ok(w.types().includes('delivery_failed'));
  assert.equal(w.no.pending().length, 0, 'no fresh model check: code retries the notice');
  await steps(w, 15); // 25: notice fails, next in 30
  const retries = w.events.filter((e) => e.type === 'missed_retry').map((e) => (e.at - t0) / MIN);
  assert.deepEqual(retries, [25]);
  down = false;
  await steps(w, 30); // 55
  assert.deepEqual(texts(w), ['Missed: Summary: three points.']);
  assert.deepEqual(w.no.flushMissed(C), []);
});

test('a missed text is listed as failed (write it again if needed), never as queued', async () => {
  const w = world({ reply: 'Summary: three points.' });
  w.no = w.make({ delayMs: FIVE, maxDeliveryAttempts: 1, deliver: async () => { throw new Error('net'); } });
  await w.no.start();
  w.no.noteReply(C, 'summary coming');
  await w.advance(FIVE);
  w.reply = 'NOTHING_OWED';
  w.no.noteReply(C, 'another reply');
  await w.advance(FIVE);
  const p = w.turns[1].prompt;
  assert.match(p, /Failed to send - write it again if still needed:\n1\. \([^)]*\) "Summary: three points\."/);
  assert.ok(!p.includes('do not write these again'));
});

// ---- 2. the duplicate guard ---------------------------------------------------------------

test('dated checks are never duplicate-guarded: a daily reminder goes out every day', async () => {
  const w = await five();
  const t0 = w.t;
  w.reply = (_c, _p, ctx) => (ctx.reason === 'due'
    ? `Time to take your medication.\nDUE ${new Date(w.t + DAY).toISOString()}`
    : (deliveredPart(_p).includes('medication') || ctx.reason === 'verify' ? 'NOTHING_OWED' : `DUE ${new Date(t0 + DAY).toISOString()}`));
  w.no.noteReply(C, 'I will remind you every day at this time.');
  for (let d = 0; d < 4 * 24; d++) await w.advance(60 * MIN); // days 1, 2, 3 and 4
  assert.deepEqual(texts(w), Array(4).fill('Time to take your medication.'));
  assert.ok(!w.types().includes('duplicate_skipped'));
});

test('identical reports for different jobs are both delivered', async () => {
  const w = await five({ reply: (_c, _p, ctx) => (ctx.kind === 'report' ? 'Backup finished, 0 errors.' : 'NOTHING_OWED') });
  w.no.trackJob(C, 'mon', { title: 'backup' });
  await w.no.finishJob('mon', { text: 'ok' });
  await w.no.idle();
  await w.advance(60 * MIN);
  w.no.trackJob(C, 'tue', { title: 'backup' });
  await w.no.finishJob('tue', { text: 'ok' });
  await w.no.idle();
  assert.deepEqual(texts(w), ['Backup finished, 0 errors.', 'Backup finished, 0 errors.']);
});

test('a copy delivered long before the check is not a duplicate', async () => {
  const w = await five({ reply: 'Here it is: the file.' });
  w.no.noteDelivered(C, 'Here it is: the file.');
  await w.advance(30 * MIN);
  w.no.noteReply(C, 'Can you send the file again?');
  await w.advance(FIVE);
  assert.deepEqual(texts(w), ['Here it is: the file.']);
});

// ---- 3. host callbacks time out -----------------------------------------------------------

test('a deliver() that hangs times out and goes to the outbox', async () => {
  let hang = true;
  const w = world({ reply: 'Here is what I owed.' });
  w.no = w.make({ delayMs: FIVE, deliver: (c, text) => (hang ? new Promise(() => {}) : (w.sent.push({ conversationId: c, text }), Promise.resolve())) });
  await w.no.start();
  w.no.noteReply(C, 'I will send it');
  await w.advance(FIVE, { wait: false });
  await w.advance(30 * 1000, { wait: false });
  await w.no.idle();
  assert.equal(w.no.outbox().length, 1);
  hang = false;
  await w.advance(FIVE);
  assert.deepEqual(texts(w), ['Here is what I owed.']);
});

test('a hung isUserBusy holds no turn slot: other conversations still get their checks', async () => {
  const w = await five({ reply: 'Owed thing.' }, { maxConcurrent: 1, maxConcurrentLimit: 1, isUserBusy: (cid) => (cid === 'stuck' ? new Promise(() => {}) : false) });
  w.no.noteReply('stuck', 'p');
  await w.advance(FIVE, { wait: false });
  w.no.noteReply('ok', 'p');
  for (let m = 0; m < 6; m++) await w.advance(MIN, { wait: false });
  await new Promise((r) => setImmediate(r));
  assert.ok(w.sent.some((s) => s.conversationId === 'ok'));
  assert.ok(w.events.some((e) => e.type === 'error' && e.stage === 'isUserBusy'));
});

test('a hung getDelivered fails the check, which comes back on the ladder', async () => {
  const w = await five({}, { getDelivered: () => new Promise(() => {}) });
  w.no.noteReply(C, 'x');
  await w.advance(FIVE, { wait: false });
  await w.advance(30 * 1000, { wait: false });
  await w.no.idle();
  assert.equal(w.turns.length, 0);
  assert.equal(w.no.pending()[0].rechecks, 1);
});

test('a hung onJobFinished times out and the parked check still runs', async () => {
  const w = await five({ reply: 'STILL_RUNNING' }, { onJobFinished: () => new Promise(() => {}) });
  w.no.trackJob(C, 'j', { title: 'render' });
  w.no.noteReply(C, 'render started');
  await w.advance(FIVE);
  await w.advance(FIVE);
  assert.equal(w.no.parked().length, 1);
  w.reply = 'NOTHING_OWED';
  void w.no.finishJob('j', { text: 'ok' });
  await w.advance(30 * 1000, { wait: false });
  await w.no.idle();
  assert.equal(w.no.parked().length, 0);
  assert.equal(w.turns.length, 3);
});

// ---- 4. nothing is saved before start() has loaded ------------------------------------------

test('a note before start() does not wipe the store; it is merged after the load', async () => {
  const store = createMemoryStore();
  const w1 = await five({ store });
  w1.no.noteUserMessage(C);
  w1.no.noteReply(C, 'I will send the report tonight');
  await w1.no.stop();
  const w2 = world({ store });
  w2.no = w2.make({ delayMs: FIVE });
  w2.no.noteUserMessage(C);
  w2.no.noteUserMessage('other');
  await new Promise((r) => setImmediate(r));
  assert.equal(store.load().records.length, 1, 'untouched before start');
  await w2.no.start();
  assert.equal(w2.no.pending().length, 1);
  assert.equal(w2.no.messageCount(C), 3);
  assert.equal(w2.no.messageCount('other'), 1);
});

// ---- 5. failed takes the ladder; park only on running ----------------------------------------

test('a failed check with an unrelated open job takes the ladder, not the park', async () => {
  const w = await five({ reply: boom });
  w.no.trackJob(C, 'render', { title: 'render' });
  w.no.noteReply(C, 'I will send the address in a minute');
  await w.advance(FIVE);
  assert.equal(w.no.parked().length, 0);
  w.reply = 'ADDRESS: 1 Main St';
  await w.advance(FIVE);
  assert.deepEqual(texts(w), ['ADDRESS: 1 Main St']);
});

test('STILL_RUNNING with an open job rechecks once at delayMs, then parks', async () => {
  const w = await five({ reply: 'STILL_RUNNING' });
  w.no.trackJob(C, 'render', { title: 'render' });
  w.no.noteReply(C, 'render started, I will report');
  await w.advance(FIVE);
  assert.equal(w.no.parked().length, 0);
  assert.equal(w.no.pending().length, 1);
  await w.advance(FIVE);
  assert.equal(w.no.parked().length, 1);
  await w.advance(60 * MIN);
  assert.equal(w.turns.length, 2);
});

// ---- 6. daily caps ------------------------------------------------------------------------

test('past the daily cap: one code-written line per conversation per day, then a wait to the next day', async () => {
  const w = await five({ reply: 'STILL_RUNNING' }, { dailyCap: 12, dailyCapReserve: 10 });
  w.no.noteReply(C, 'x');
  await steps(w, 30);
  assert.equal(w.turns.length, 2, 'window (reserved) + one recheck: the 2 unreserved turns');
  const line = texts(w).filter((t) => /today's limit/.test(t));
  assert.equal(line.length, 1);
  assert.match(line[0], /^I've hit today's limit for checking on promises; I'll check again at \d\d:\d\d UTC\.$/);
  w.no.noteReply(C, 'y'); // a new reply the same day is a window check: it may use the reserve
  await steps(w, 6);
  assert.equal(w.turns.length, 3);
  await steps(w, 20); // its recheck is capped again: no second line today
  assert.equal(w.turns.length, 3);
  assert.equal(texts(w).filter((t) => /today's limit/.test(t)).length, 1, 'one line per day');
});

test('the reserve keeps first-window checks running after rechecks used the rest', async () => {
  const w = await five({ reply: 'STILL_RUNNING' }, { dailyCap: 12, dailyCapReserve: 10 });
  w.no.noteReply('a', 'x');
  await steps(w, 20);
  const before = w.turns.length;
  w.reply = 'NOTHING_OWED';
  w.no.noteReply('b', 'y');
  await steps(w, 6);
  assert.equal(w.turns.length, before + 1, 'b is a different conversation: its window runs');
});

test('globalDailyCap stops model turns for everyone and tells the operator once', async () => {
  const w = await five({}, { globalDailyCap: 3 });
  for (const c of ['a', 'b', 'c', 'd', 'e']) w.no.noteReply(c, 'x');
  await w.advance(FIVE);
  assert.equal(w.turns.length, 3);
  assert.equal(w.events.filter((e) => e.type === 'global_daily_cap').length, 1);
});

// ---- 7. DUE chains are bounded --------------------------------------------------------------

test('a DUE chain stops at maxDueDepth with a code-written line', async () => {
  const w = await five();
  w.reply = () => `DUE ${new Date(w.t + 6 * MIN).toISOString()}`;
  w.no.noteReply(C, 'ok');
  await steps(w, 24 * 60);
  assert.equal(w.turns.length, 11, 'the window and 10 dated checks');
  assert.equal(w.no.dated().length, 0);
  assert.equal(w.sent.length, 1);
  assert.ok(w.types().includes('due_limit'));
});

test('at most 5 dated timers per conversation; the 6th gets the code line', async () => {
  const w = await five();
  const t0 = w.t;
  for (let i = 1; i <= 6; i++) {
    w.reply = `DUE ${new Date(t0 + i * DAY).toISOString()}`;
    w.no.noteReply(C, `reminder ${i}`);
    await w.advance(FIVE);
  }
  assert.equal(w.no.dated().length, 5);
  assert.equal(w.sent.length, 1);
});

// ---- 8. circuit breaker ---------------------------------------------------------------------

test('5 failed turns in a row open the circuit: no turns while paused, no give-up lines', async () => {
  const w = await five({ reply: boom });
  for (let h = 0; h < 48; h += 6) {
    w.no.noteReply(C, 'The capital of France is Paris.');
    await steps(w, 6 * 60);
  }
  assert.equal(w.sent.length, 0, 'a user who was promised nothing gets nothing');
  assert.ok(w.types().includes('circuit_open'));
  assert.ok(w.turns.length < 40, `turns ${w.turns.length}`);
  w.reply = 'NOTHING_OWED';
  await steps(w, 3 * 60);
  assert.ok(w.types().includes('circuit_closed'));
});

test('the give-up line does not assert a promise and goes once per conversation per outage', async () => {
  const w = await five({ reply: boom }, { circuitFailures: 0, maxRechecks: 1, backoffMs: [] });
  w.no.noteReply(C, 'x');
  await steps(w, 20);
  w.no.noteReply(C, 'y');
  await steps(w, 20);
  assert.deepEqual(texts(w), ["I may have said I'd follow up on something, and I couldn't check it. Ask me if anything is still open."]);
});

// ---- 9. delivered log persistence, report at-most-once, log horizon --------------------------

test('the delivered log lives with the store by default: a restart does not resend', async () => {
  const store = createMemoryStore();
  const model = (_c, p) => (deliveredPart(p).includes('SUMMARY') ? 'NOTHING_OWED' : 'SUMMARY: three points.');
  const w1 = await five({ store, reply: model });
  w1.no.noteDelivered(C, 'Here it is. SUMMARY: three points.');
  w1.no.noteReply(C, 'Here it is. SUMMARY: three points.');
  await w1.advance(2 * MIN);
  await w1.no.stop();
  const w2 = world({ store, reply: model });
  w2.t = w1.t;
  w2.no = w2.make({ delayMs: FIVE });
  await w2.no.start();
  await w2.advance(10 * MIN);
  assert.deepEqual(w2.sent, []);
});

test('a file store keeps the delivered log next to it', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'nothing-owed-')), 'state.json');
  const w = await five({ store: createFileStore(path), reply: 'Here it is.' });
  w.no.noteReply(C, 'x');
  await w.advance(FIVE);
  await w.no.stop();
  assert.ok(existsSync(`${path}.delivered.json`));
  assert.match(readFileSync(`${path}.delivered.json`, 'utf8'), /Here it is\./);
});

test('a report is marked delivered before it is sent: a crash after the send never repeats it', async () => {
  let frozen = null;
  let freeze = false;
  const store = { load: () => JSON.parse(frozen ?? '[]'), save: (s) => { if (!freeze) frozen = JSON.stringify(s); } };
  let n = 0;
  const got = [];
  const mk = async () => {
    const w = world({ store, reply: (_c, _p, ctx) => (ctx.kind === 'report' ? `Render finished (wording ${++n}).` : 'NOTHING_OWED') });
    w.no = w.make({ delayMs: FIVE, deliver: async (c, text) => { got.push(text); freeze = true; } });
    await w.no.start();
    return w;
  };
  const w1 = await mk();
  w1.no.trackJob(C, 'render');
  await w1.no.finishJob('render', { text: 'ok' });
  await w1.no.idle();
  freeze = false;
  const w2 = await mk();
  await w2.no.idle();
  assert.deepEqual(got, ['Render finished (wording 1).']);
});

test('a check whose window is older than the delivered log says the list may be incomplete', async () => {
  const w = await five();
  w.reply = (_c, _p, ctx) => (ctx.reason === 'due' ? 'Reminder: meeting today.' : `DUE ${new Date(w.t + 7 * DAY).toISOString()}`);
  w.no.noteReply(C, 'I will remind you of the meeting next week');
  await w.advance(FIVE);
  await w.advance(7 * DAY);
  const p = w.turns.find((t) => t.ctx.reason === 'due').prompt;
  assert.match(p, /may be incomplete/);
});

// ---- 10. one Missed send per conversation at a time ----------------------------------------

test('the Missed notice goes once even when two sends start together', async () => {
  let down = true;
  const sent = [];
  const w = world({ reply: (_c, p, ctx) => (ctx.kind === 'report' ? 'Render finished.' : 'Summary: three points.') });
  w.no = w.make({
    delayMs: FIVE, maxDeliveryAttempts: 1,
    deliver: async (c, text) => { if (down) throw new Error('down'); await new Promise((r) => setTimeout(r, 15)); sent.push(text); },
  });
  await w.no.start();
  w.no.noteReply(C, 'summary coming');
  w.no.trackJob(C, 'render');
  await w.advance(FIVE); // the summary fails: missed, its timer at minute 20
  down = false;
  w.reply = (_c, p, ctx) => (ctx.kind === 'report' ? 'Render finished.' : 'NOTHING_OWED');
  await w.advance(15 * MIN, { wait: false }); // the missed timer starts its send (15 ms)
  await w.no.finishJob('render', { text: 'ok' }); // the report also sends owed notices first
  await new Promise((r) => setTimeout(r, 100));
  await w.no.idle();
  assert.equal(sent.filter((t) => t.startsWith('Missed:')).length, 1, JSON.stringify(sent));
  assert.ok(sent.includes('Render finished.'));
});

// ---- 11. the verify cap tells the user ------------------------------------------------------

test('when the verify chain is capped, the user gets the no-longer-watched line', async () => {
  let n = 0;
  const w = await five({ reply: () => `Almost there (${++n}), ten more minutes.` }, { maxVerifyDepth: 1 });
  w.no.noteReply(C, 'I will send the file soon');
  await steps(w, 60);
  assert.equal(w.sent.length, 3);
  assert.match(texts(w)[2], /no longer/i);
});

// ---- 13. turn hooks -----------------------------------------------------------------------

test('onTurnStart/onTurnEnd wrap every model turn and isChecking() is true in between', async () => {
  const seen = [];
  let w;
  w = await five({ reply: (cid) => { seen.push(['in', cid, w.no.isChecking(cid)]); return 'NOTHING_OWED'; } }, {
    onTurnStart: (cid, ctx) => seen.push(['start', cid, ctx.kind]),
    onTurnEnd: (cid, ctx) => seen.push(['end', cid, ctx.kind]),
  });
  w.no.noteReply(C, 'x');
  await w.advance(FIVE);
  assert.deepEqual(seen, [['start', C, 'check'], ['in', C, true], ['end', C, 'check']]);
  assert.equal(w.no.isChecking(C), false);
});

// ---- 14. scale ----------------------------------------------------------------------------

test('turn slots grow with the backlog, up to maxConcurrentLimit', async () => {
  let live = 0;
  let peak = 0;
  const w = await five({ reply: async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 2)); live--; return 'NOTHING_OWED'; } });
  for (let i = 0; i < 80; i++) w.no.noteReply(`u${i}`, 'hi');
  await w.advance(FIVE);
  assert.equal(w.turns.length, 80);
  assert.ok(peak > 2 && peak <= 8, `peak ${peak}`);
});

test('saves are debounced; stop() writes the final state', async () => {
  let saves = 0;
  const inner = createMemoryStore();
  const store = { load: inner.load, save: (s) => { saves++; inner.save(s); } };
  const w = world({ store });
  w.no = w.make({ delayMs: FIVE, saveDebounceMs: 50 });
  await w.no.start();
  saves = 0;
  for (let i = 0; i < 100; i++) w.no.noteReply(`u${i}`, 'hi');
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(saves <= 2, `saves ${saves}`);
  w.no.noteReply('last', 'hi');
  await w.no.stop();
  assert.ok(inner.load().records.some((r) => r.conversationId === 'last'));
});

test('counters of conversations idle longer than 30 days are pruned', async () => {
  const w = await five();
  w.no.noteUserMessage('old');
  w.t += 31 * DAY;
  w.no.noteUserMessage('new');
  await w.no.flush();
  assert.equal(w.no.messageCount('old'), 0);
  assert.equal(w.no.messageCount('new'), 1);
});

// ---- 15. finishJob and wrapJob resolve right away ------------------------------------------

test('finishJob resolves before the report turn ends; events say when it is done', async () => {
  let release;
  const w = await five({ reply: () => new Promise((r) => { release = () => r('Render finished.'); }) });
  w.no.trackJob(C, 'j', { title: 'render' });
  const job = await w.no.finishJob('j', { text: 'ok' });
  assert.equal(job.status, 'done');
  assert.deepEqual(w.sent, []);
  await new Promise((r) => setImmediate(r));
  release();
  await w.no.idle();
  assert.deepEqual(texts(w), ['Render finished.']);
  assert.ok(w.types().includes('report_delivered'));
});

// ---- small ---------------------------------------------------------------------------------

test('noteDelivered never throws into the host send path', async () => {
  const w = await five({}, { deliveredLog: { note() { throw new Error('disk full'); }, since: () => [] } });
  assert.doesNotThrow(() => w.no.noteDelivered(C, 'x'));
  assert.ok(w.events.some((e) => e.type === 'error' && e.stage === 'deliveredLog'));
});

test('a file store refuses a second live process', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'nothing-owed-')), 'state.json');
  writeFileSync(`${path}.lock`, String(process.ppid));
  const no = createNothingOwed({ store: createFileStore(path), runTurn: async () => 'NOTHING_OWED', deliver: async () => {} });
  await assert.rejects(no.start(), /another process/);
});

test('isUserBusy true for over 30 minutes emits busy_stuck once and keeps waiting', async () => {
  const w = await five({}, { isUserBusy: () => true });
  w.no.noteReply(C, 'x');
  await steps(w, 70);
  assert.equal(w.turns.length, 0);
  assert.equal(w.events.filter((e) => e.type === 'busy_stuck').length, 1);
});

test('content + DUE every few minutes: one linear chain, bounded messages, each limit line once a day', async () => {
  let n = 0;
  const w = await five();
  w.reply = () => `Reminder ${++n}: I'll check again shortly.\nDUE ${new Date(w.t + 7 * MIN).toISOString()}`;
  w.no.noteReply(C, 'ok');
  await steps(w, 24 * 60);
  const reminders = texts(w).filter((t) => t.startsWith('Reminder'));
  const lines = texts(w).filter((t) => !t.startsWith('Reminder'));
  assert.ok(reminders.length <= 11, `reminders ${reminders.length}`);
  assert.equal(lines.length, 1, JSON.stringify(lines));
});

test('300 conversations due at once never run more than maxConcurrentLimit turns', async () => {
  let live = 0;
  let peak = 0;
  const w = await five({ reply: async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return 'NOTHING_OWED'; } });
  for (let i = 0; i < 300; i++) w.no.noteReply(`m${i}`, 'hi');
  await w.advance(FIVE);
  assert.equal(w.turns.length, 300);
  assert.ok(peak <= 8, `peak ${peak}`);
});
