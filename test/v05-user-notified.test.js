// v0.5.0: the host already told the user (userNotified): no second failure message.
// From a Telegram bot that sends rendered media to its users.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/index.js';
import { world, MIN } from './helpers.js';

const C = 'chat-50';
const FIVE = 5 * MIN;
const texts = (w) => w.sent.map((s) => s.text);
const ev = (w, type) => w.events.filter((e) => e.type === type);

async function five(opts = {}, extra = {}) {
  const w = world(opts);
  w.no = w.make({ delayMs: FIVE, ...extra });
  await w.no.start();
  return w;
}

// ---- 1. userNotified ------------------------------------------------------------------------

test('finishJob userNotified: no report turn, nothing sent, report_skipped user_notified', async () => {
  const w = await five({ reply: 'The render failed.' });
  w.no.trackJob(C, 'j', { title: 'render' });
  const job = await w.no.finishJob('j', { status: 'error', text: 'disk full', userNotified: true });
  await w.no.idle();
  assert.equal(job.status, 'error');
  assert.equal(w.turns.length, 0, 'no report turn');
  assert.deepEqual(texts(w), []);
  assert.deepEqual(ev(w, 'report_skipped').map((e) => [e.jobId, e.reason]), [['j', 'user_notified']]);
  assert.ok(w.types().includes('job_finished'));
  assert.deepEqual(w.no.reports(), []);
  assert.deepEqual(w.no.jobs(), []);
});

test('finishJob userNotified: a check parked on the job unparks and runs once', async () => {
  const w = await five({ reply: 'STILL_RUNNING' });
  w.no.noteReply(C, 'Rendering, I will report.');
  w.no.trackJob(C, 'j', { title: 'render' });
  await w.advance(FIVE);
  await w.advance(FIVE);
  assert.equal(w.no.parked().length, 1);
  w.reply = 'NOTHING_OWED';
  await w.no.finishJob('j', { status: 'error', text: 'boom', userNotified: true });
  await w.no.idle();
  assert.equal(w.no.parked().length, 0);
  assert.ok(w.types().includes('unparked'));
  assert.deepEqual(w.turns.map((t) => t.ctx.kind), ['check', 'check', 'check'], 'the parked check ran, no report turn');
  assert.deepEqual(texts(w), []);
});

test('finishJob userNotified: onJobFinished is not called either', async () => {
  const seen = [];
  const w = await five({}, { onJobFinished: (cid, job) => seen.push(job.id) });
  w.no.trackJob(C, 'j');
  await w.no.finishJob('j', { status: 'error', userNotified: true });
  await w.no.idle();
  assert.deepEqual(seen, []);
  assert.deepEqual(ev(w, 'report_skipped').map((e) => e.reason), ['user_notified']);
});

test('finishJob without userNotified keeps the report turn', async () => {
  const w = await five({ reply: 'The render failed: disk full.' });
  w.no.trackJob(C, 'j', { title: 'render' });
  await w.no.finishJob('j', { status: 'error', text: 'disk full' });
  await w.no.idle();
  assert.deepEqual(texts(w), ['The render failed: disk full.']);
});

test('wrapJob userNotifiedOnError: a rejection runs no report turn and still rethrows', async () => {
  const w = await five({ reply: 'it failed' });
  await assert.rejects(
    w.no.wrapJob(C, 'w', () => Promise.reject(new Error('disk full')), { title: 'export', userNotifiedOnError: true }),
    /disk full/,
  );
  await w.no.idle();
  assert.equal(w.turns.length, 0);
  assert.deepEqual(texts(w), []);
  assert.deepEqual(ev(w, 'report_skipped').map((e) => [e.jobId, e.reason]), [['w', 'user_notified']]);
});

test('wrapJob userNotifiedOnError as a function decides per error', async () => {
  const w = await five({ reply: 'The export failed: quota.' });
  const only = (err) => err.message === 'disk full';
  await assert.rejects(w.no.wrapJob(C, 'a', () => Promise.reject(new Error('disk full')), { userNotifiedOnError: only }));
  await w.no.idle();
  assert.equal(w.turns.length, 0, 'told by the host');
  await assert.rejects(w.no.wrapJob(C, 'b', () => Promise.reject(new Error('quota')), { userNotifiedOnError: only }));
  await w.no.idle();
  assert.equal(w.turns.length, 1, 'not told: the report turn runs');
  assert.deepEqual(texts(w), ['The export failed: quota.']);
});

test('wrapJob userNotifiedOnError: a success still gets its report', async () => {
  const w = await five({ reply: 'Exported 12 rows.' });
  assert.equal(await w.no.wrapJob(C, 'w', async () => 'ok', { userNotifiedOnError: true }), 'ok');
  await w.no.idle();
  assert.deepEqual(texts(w), ['Exported 12 rows.']);
});

test('noteJobUserNotified on an open job: its later finishJob runs no report turn', async () => {
  const w = await five({ reply: 'report' });
  w.no.trackJob(C, 'j');
  assert.equal(w.no.noteJobUserNotified('j'), true);
  assert.equal(w.no.jobs()[0].userNotified, true);
  await w.no.finishJob('j', { status: 'error', text: 'x' });
  await w.no.idle();
  assert.equal(w.turns.length, 0);
  assert.deepEqual(ev(w, 'report_skipped').map((e) => e.reason), ['user_notified']);
});

test('noteJobUserNotified on a report still waiting (user busy): the report is dropped unrun', async () => {
  let busy = true;
  const w = await five({ reply: 'report' }, { isUserBusy: () => busy });
  w.no.trackJob(C, 'j');
  await w.no.finishJob('j', { status: 'error', text: 'x' });
  await w.no.idle();
  assert.equal(w.no.reports().length, 1);
  assert.equal(w.no.noteJobUserNotified('j'), true);
  busy = false;
  await w.advance(10 * MIN);
  assert.equal(w.turns.length, 0);
  assert.deepEqual(w.no.reports(), []);
  assert.deepEqual(ev(w, 'report_skipped').map((e) => e.reason), ['user_notified']);
  assert.ok(w.types().includes('report_done'));
});

test('noteJobUserNotified while the report turn runs: its text is dropped before deliver()', async () => {
  let release;
  const w = await five({ reply: () => new Promise((r) => { release = r; }) });
  w.no.trackJob(C, 'j', { title: 'render' });
  await w.no.finishJob('j', { status: 'error', text: 'disk full' });
  await new Promise((r) => setImmediate(r));
  assert.equal(w.turns.length, 1, 'the report turn is running');
  assert.equal(w.no.noteJobUserNotified('j'), true);
  release('The render failed: disk full.');
  await w.no.idle();
  assert.deepEqual(texts(w), [], 'nothing reached deliver()');
  assert.deepEqual(ev(w, 'report_dropped').map((e) => [e.jobId, e.reason]), [['j', 'user_notified']]);
  assert.ok(w.types().includes('report_done'));
  assert.deepEqual(w.no.reports(), []);
});

test('noteJobUserNotified while the report turn runs: a code-written fallback is dropped too', async () => {
  let release;
  const w = await five({ reply: () => new Promise((r) => { release = r; }) }, { maxRechecks: 0, backoffMs: [] });
  w.no.trackJob(C, 'j', { title: 'render' });
  await w.no.finishJob('j', { status: 'error', text: 'disk full' });
  await new Promise((r) => setImmediate(r));
  w.no.noteJobUserNotified('j');
  release('NOTHING_OWED'); // would send the fallback line
  await w.no.idle();
  assert.deepEqual(texts(w), []);
  assert.deepEqual(ev(w, 'report_dropped').map((e) => e.reason), ['user_notified']);
});

test('noteJobUserNotified drops a report waiting in the delivery outbox', async () => {
  let fail = true;
  const w = world({ reply: 'The render failed.' });
  w.no = w.make({
    delayMs: FIVE,
    deliver: async (cid, text) => {
      if (fail) throw new Error('platform down');
      w.sent.push({ conversationId: cid, text });
    },
  });
  await w.no.start();
  w.no.trackJob(C, 'j');
  await w.no.finishJob('j', { status: 'error', text: 'x' });
  await w.no.idle();
  assert.equal(w.no.outbox().length, 1);
  assert.equal(w.no.noteJobUserNotified('j'), true);
  assert.deepEqual(w.no.outbox(), []);
  fail = false;
  await w.advance(30 * MIN);
  assert.deepEqual(texts(w), []);
  assert.deepEqual(ev(w, 'report_dropped').map((e) => e.reason), ['user_notified']);
});

test('noteJobUserNotified of an unknown or already reported job returns false', async () => {
  const w = await five({ reply: 'done' });
  assert.equal(w.no.noteJobUserNotified('nope'), false);
  w.no.trackJob(C, 'j');
  await w.no.finishJob('j', { text: 'ok' });
  await w.no.idle();
  assert.equal(w.no.noteJobUserNotified('j'), false);
});

test('userNotified on an open job survives a restart', async () => {
  const store = createMemoryStore();
  const w = await five({ store, reply: 'report' }, { onStartJobs: (jobs) => jobs.map((j) => j.id) });
  w.no.trackJob(C, 'j');
  w.no.noteJobUserNotified('j');
  await w.no.stop();
  w.no = w.make({ delayMs: FIVE, onStartJobs: (jobs) => jobs.map((j) => j.id) });
  await w.no.start();
  await w.no.finishJob('j', { status: 'error' });
  await w.no.idle();
  assert.equal(w.turns.length, 0);
});

// ---- scenario: the host's own failure message plus finishJob userNotified -------------------

test('scenario: the host says the render failed, finishJob userNotified: the user gets exactly one message', async () => {
  const got = [];
  const w = world({
    // the check sees the host's message in the delivered list and owes nothing
    reply: (_c, prompt, ctx) => (ctx.kind === 'report' ? 'Sorry, the render failed (disk full).' : 'NOTHING_OWED'),
  });
  w.no = w.make({
    delayMs: FIVE,
    deliver: async (cid, text) => { got.push(text); },
  });
  await w.no.start();
  const host = (text) => { got.push(text); w.no.noteDelivered(C, text); w.no.noteReply(C, text); };

  w.no.noteUserMessage(C);
  host('Rendering your video now; I will send it when it is ready.');
  w.no.trackJob(C, 'render-1', { title: 'render' });
  await w.advance(2 * MIN);
  // the render fails; the host's error handler tells the user itself
  host('Sorry, the render failed: the disk is full. Try again later.');
  await w.no.finishJob('render-1', { status: 'error', text: 'ENOSPC', userNotified: true });
  await w.advance(120 * MIN);
  assert.deepEqual(got.slice(1), ['Sorry, the render failed: the disk is full. Try again later.'], 'one failure message, from the host');
  assert.ok(!w.turns.some((t) => t.ctx.kind === 'report'), 'no report turn');
});

test('scenario control: the same timeline without userNotified sends a second failure message', async () => {
  const got = [];
  const w = world({ reply: (_c, _p, ctx) => (ctx.kind === 'report' ? 'Sorry, the render failed (disk full).' : 'NOTHING_OWED') });
  w.no = w.make({ delayMs: FIVE, deliver: async (cid, text) => { got.push(text); } });
  await w.no.start();
  const host = (text) => { got.push(text); w.no.noteDelivered(C, text); w.no.noteReply(C, text); };
  host('Rendering your video now; I will send it when it is ready.');
  w.no.trackJob(C, 'render-1', { title: 'render' });
  await w.advance(2 * MIN);
  host('Sorry, the render failed: the disk is full. Try again later.');
  await w.no.finishJob('render-1', { status: 'error', text: 'ENOSPC' });
  await w.advance(120 * MIN);
  assert.equal(got.length, 3, 'the report turn wrote its own failure message');
});

test('deliver() fails after noteJobUserNotified: no outbox retry, one report_dropped', async () => {
  const w = world({ reply: 'The render failed.' });
  w.no = w.make({
    delayMs: FIVE,
    deliver: async () => {
      w.no.noteJobUserNotified('j'); // the host tells the user while this send is on its way
      throw new Error('platform down');
    },
  });
  await w.no.start();
  w.no.trackJob(C, 'j');
  await w.no.finishJob('j', { status: 'error', text: 'x' });
  await w.no.idle();
  assert.deepEqual(w.no.outbox(), []);
  assert.deepEqual(ev(w, 'report_dropped').map((e) => [e.jobId, e.kind]), [['j', 'report']]);
  assert.ok(!w.types().includes('delivery_retry'));
});

// ---- v0.5.1 ------------------------------------------------------------------------------------

test('a report dropped for userNotified never becomes a DUE dated check', async () => {
  let release;
  const w = await five({ reply: () => new Promise((r) => { release = r; }) });
  w.no.trackJob(C, 'j', { title: 'render' });
  await w.no.finishJob('j', { status: 'error', text: 'disk full' });
  await new Promise((r) => setImmediate(r));
  w.no.noteJobUserNotified('j');
  const due = new Date(w.t + 24 * 60 * MIN).toISOString().slice(0, 19) + 'Z';
  release(`The render failed; I will try again tomorrow.\nDUE ${due}`);
  await w.no.idle();
  assert.deepEqual(texts(w), []);
  assert.deepEqual(w.no.dated(), [], 'no dated check holds the dropped text');
  await w.advance(25 * 60 * MIN);
  assert.deepEqual(texts(w), []);
});

test('a report turn that fails after noteJobUserNotified ends at once: no report_retry, checks unpark', async () => {
  let fail;
  const w = await five({ reply: (_c, _p, ctx) => (ctx.kind === 'report' ? new Promise((_, rej) => { fail = rej; }) : 'STILL_RUNNING') });
  w.no.noteReply(C, 'Rendering, I will report.');
  w.no.trackJob(C, 'j', { title: 'render' });
  await w.advance(FIVE);
  await w.advance(FIVE);
  assert.equal(w.no.parked().length, 1);
  w.reply = (_c, _p, ctx) => (ctx.kind === 'report' ? new Promise((_, rej) => { fail = rej; }) : 'NOTHING_OWED');
  await w.no.finishJob('j', { status: 'error', text: 'x' });
  await new Promise((r) => setImmediate(r));
  w.no.noteJobUserNotified('j');
  fail(new Error('model down'));
  await w.no.idle();
  assert.ok(!w.types().includes('report_retry'), 'no retry for a report the host covered');
  assert.deepEqual(ev(w, 'report_skipped').map((e) => e.reason), ['user_notified']);
  assert.ok(w.types().includes('report_done'));
  assert.deepEqual(w.no.reports(), []);
  assert.equal(w.no.parked().length, 0, 'the parked check unparked at once');
  assert.deepEqual(texts(w), []);
});

test('finishJob userNotified emits report_done like every other report path', async () => {
  const w = await five({ reply: 'report' });
  w.no.trackJob(C, 'j');
  await w.no.finishJob('j', { status: 'error', userNotified: true });
  await w.no.idle();
  const order = w.types().filter((t) => ['job_finished', 'report_skipped', 'report_done'].includes(t));
  assert.deepEqual(order, ['job_finished', 'report_skipped', 'report_done']);
  assert.deepEqual(ev(w, 'report_done').map((e) => [e.conversationId, e.jobId]), [[C, 'j']]);
});

test('noteJobUserNotified drops a missed notice of that job; other missed notices stay', async () => {
  const w = world({ reply: 'The render failed.' });
  w.no = w.make({ delayMs: FIVE, isPermanentError: () => true, deliver: async () => { throw new Error('gone'); } });
  await w.no.start();
  w.no.trackJob(C, 'j');
  await w.no.finishJob('j', { status: 'error', text: 'x' });
  await w.no.idle();
  assert.equal(w.no.missed().length, 1, 'the report became a missed notice');
  assert.equal(w.no.noteJobUserNotified('j'), true);
  assert.deepEqual(w.no.missed(), []);
  assert.deepEqual(w.no.flushMissed(C), []);
  assert.deepEqual(ev(w, 'report_dropped').map((e) => [e.jobId, e.kind]), [['j', 'report']]);
});

test('missed notices stored without a jobId (before v0.5.1) still load and are never dropped by a job', async () => {
  const t = 1_700_000_000_000;
  const store = createMemoryStore({ version: 4, records: [], missed: { [C]: [{ text: 'old text', at: t, due: Infinity, wait: 15 * MIN }] } });
  const w = await five({ store });
  assert.deepEqual(w.no.missed().map((m) => m.text), ['old text']);
  assert.equal(w.no.noteJobUserNotified('j'), false);
  assert.deepEqual(w.no.flushMissed(C), ['Missed: old text']);
});

test('a userNotifiedOnError callback that throws: an error event, the report runs, the original error is rethrown', async () => {
  const w = await five({ reply: 'The export failed.' });
  const bad = new Error('callback broke');
  await assert.rejects(
    w.no.wrapJob(C, 'w', () => Promise.reject(new Error('disk full')), { userNotifiedOnError: () => { throw bad; } }),
    /disk full/,
  );
  await w.no.idle();
  const errs = ev(w, 'error').filter((e) => e.stage === 'userNotifiedOnError');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].error, bad);
  assert.equal(errs[0].jobId, 'w');
  assert.equal(errs[0].conversationId, C);
  assert.deepEqual(texts(w), ['The export failed.'], 'treated as not notified');
});
