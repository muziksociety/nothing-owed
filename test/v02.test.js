// v0.2 behavior: fixed windows, keep-first lists, messages-back, split outcomes, job tracking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createNothingOwed,
  createMemoryStore,
  createFileStore,
  buildPrompt,
  buildReportPrompt,
  parseOutcome,
  parseCheckReply,
  stripStillRunning,
} from '../src/index.js';
import { world, MIN } from './helpers.js';

const C = 'chat-7';
const FIVE = 5 * MIN;

async function five(opts = {}, extra = {}) {
  const w = world(opts);
  w.no = w.make({ delayMs: FIVE, ...extra });
  await w.no.start();
  return w;
}

// ---- 1. fixed window ----------------------------------------------------------------------

test('default delay is 5 minutes', async () => {
  const no = createNothingOwed({ runTurn: async () => 'NOTHING_OWED', deliver() {}, now: () => 1000, setTimer: () => 0, clearTimer() {} });
  await no.start();
  assert.equal(no.noteReply(C, 'x').due, 1000 + 300000);
});

test('later replies join the list but never move the due time', async () => {
  const w = await five();
  const first = w.no.noteReply(C, 'first');
  await w.advance(3 * MIN);
  const merged = w.no.noteReply(C, 'second');
  assert.equal(merged.due, first.due, 'due unchanged');
  const ev = w.events.find((e) => e.type === 'merged');
  assert.equal(ev.due, first.due);
  await w.advance(2 * MIN);
  assert.equal(w.turns.length, 1, 'check fires at minute 5, not 8');
  assert.match(w.turns[0].prompt, /first/);
  assert.match(w.turns[0].prompt, /second/);
});

test('a long conversation cannot push the check back forever', async () => {
  const w = await five();
  for (let m = 0; m < 20; m++) {
    w.no.noteReply(C, `reply ${m}`);
    await w.advance(MIN);
  }
  assert.equal(w.turns.length, 4, 'checks at 5, 10, 15, 20');
});

test('after a check runs, the next reply opens a new window', async () => {
  const w = await five();
  w.no.noteReply(C, 'a');
  await w.advance(FIVE);
  assert.equal(w.turns.length, 1);
  await w.advance(MIN);
  const rec = w.no.noteReply(C, 'b');
  assert.equal(rec.due, w.t + FIVE);
  assert.equal(rec.replies.length, 1);
});

// ---- 2. keep the first reply --------------------------------------------------------------

test('an overflowing list keeps reply 1 plus the newest maxReplies-1', async () => {
  const w = await five({}, { maxReplies: 3 });
  for (let i = 1; i <= 5; i++) w.no.noteReply(C, `reply ${i}`);
  assert.deepEqual(w.no.pending()[0].replies.map((r) => r.text), ['reply 1', 'reply 4', 'reply 5']);
});

test('a requeue merge keeps the first reply too', async () => {
  let busy = true;
  const w = await five({}, { maxReplies: 3, isUserBusy: () => busy, busyRetryMs: MIN });
  w.no.noteReply(C, 'old 1');
  w.no.noteReply(C, 'old 2');
  await w.advance(FIVE); // yields, requeued
  w.no.noteReply(C, 'new 1');
  w.no.noteReply(C, 'new 2');
  assert.deepEqual(w.no.pending()[0].replies.map((r) => r.text), ['old 1', 'new 1', 'new 2']);
  busy = false;
});

// ---- 3. messages-back counter -------------------------------------------------------------

test('user messages and replies count; each reply gets a seq', async () => {
  const w = await five();
  assert.equal(w.no.noteUserMessage(C), 1);
  const rec = w.no.noteReply(C, 'promise');
  assert.equal(rec.replies[0].seq, 2);
  w.no.noteUserMessage(C);
  w.no.noteReply(C, 'x', { kind: 'check' }); // the user saw it: counts, not listed
  w.no.noteReply(C, 'y', { kind: 'system' }); // not a message the user saw
  assert.equal(w.no.messageCount(C), 4);
  assert.equal(w.no.pending()[0].replies.length, 1);
});

test('the prompt shows how many messages back each reply is, and the lookup line', async () => {
  const w = await five();
  w.no.noteUserMessage(C);
  w.no.noteReply(C, "I'll send the summary.");
  for (let i = 0; i < 6; i++) w.no.noteUserMessage(C);
  w.no.noteReply(C, 'latest');
  await w.advance(FIVE);
  const p = w.turns[0].prompt;
  assert.match(p, /1\. \(8 messages back, \d{4}-\d\d-\d\dT[\d:.]+Z\) "I'll send the summary\."/);
  assert.match(p, /2\. \(1 message back, /);
  assert.ok(p.includes('Each reply shows how many messages back in this conversation it is. If one holds a promise, look it up there in your history before you answer.'));
});

test('a delivered check reply counts as a message', async () => {
  const w = await five({ reply: 'Here it is.' });
  w.no.noteReply(C, 'promise');
  await w.advance(FIVE);
  assert.equal(w.no.messageCount(C), 2);
});

test('buildPrompt without seq keeps the plain time format', () => {
  const p = buildPrompt({ replies: [{ at: 0, text: 'x' }] });
  assert.match(p, /1\. \(1970-01-01T00:00:00\.000Z\) "x"/);
});

// ---- 4. split outcome ---------------------------------------------------------------------

test('parseOutcome: a reply ending in a STILL_RUNNING line is deliver_running', () => {
  for (const s of ['Here is A.\nSTILL_RUNNING', 'Here is A.\n\n**STILL_RUNNING**', 'Line 1\nLine 2\n`still_running`.\n']) {
    assert.equal(parseOutcome(s), 'deliver_running', JSON.stringify(s));
  }
  assert.equal(parseOutcome('STILL_RUNNING'), 'running');
  assert.equal(parseOutcome('STILL_RUNNING is what I would say, but here is A.'), 'deliver');
});

test('parseCheckReply returns the outcome and the text minus the marker line', () => {
  assert.deepEqual(parseCheckReply('Here is A.\nB is still running.\nSTILL_RUNNING'), { outcome: 'deliver_running', text: 'Here is A.\nB is still running.' });
  assert.deepEqual(parseCheckReply('Here is A.'), { outcome: 'deliver', text: 'Here is A.' });
  assert.equal(parseCheckReply('NOTHING_OWED').outcome, 'nothing');
  assert.equal(stripStillRunning('A\nSTILL_RUNNING'), 'A');
  assert.equal(stripStillRunning('A'), 'A');
});

test('the prompt asks for the STILL_RUNNING line on a split delivery, except on the last check', () => {
  const line = 'If you deliver something now but another promise is still running, put the line STILL_RUNNING at the very end of your reply.';
  assert.ok(buildPrompt({ replies: [{ at: 0, text: 'x' }] }).includes(line));
  assert.ok(!buildPrompt({ replies: [{ at: 0, text: 'x' }], isLastCheck: true }).includes(line));
});

test('deliver_running delivers the text and requeues the same record delayMs later', async () => {
  const w = await five({ reply: 'Here is A.\nSTILL_RUNNING' });
  w.no.noteReply(C, 'I will send A and B.');
  await w.advance(FIVE);
  assert.deepEqual(w.sent.map((s) => s.text), ['Here is A.']);
  const p = w.no.pending();
  assert.equal(p.length, 1);
  assert.equal(p[0].rechecks, 1);
  assert.equal(p[0].due, w.t + FIVE);
  assert.deepEqual(p[0].replies.map((r) => r.text), ['I will send A and B.']);
  assert.ok(w.events.some((e) => e.type === 'delivered' && e.stillRunning === true));
});

test('on the last check the marker is stripped and nothing is requeued', async () => {
  const w = await five({ reply: 'Status: B still running.\nSTILL_RUNNING' }, { maxRechecks: 1, backoffMs: [] });
  w.no.noteReply(C, 'x');
  await w.advance(FIVE);
  await w.advance(FIVE);
  assert.equal(w.turns.length, 2);
  assert.deepEqual(w.sent.map((s) => s.text), ['Status: B still running.', 'Status: B still running.']);
  assert.equal(w.no.pending().length, 0);
});

// ---- 5. job tracking ----------------------------------------------------------------------

test('a running check with an open tracked job parks: no model wake until the job ends', async () => {
  const w = await five({ reply: 'STILL_RUNNING' });
  w.no.noteReply(C, 'Rendering now, it will report.');
  w.no.trackJob(C, 'job-1', { title: 'render' });
  await w.advance(FIVE);
  assert.equal(w.turns.length, 1);
  assert.equal(w.no.pending().length, 0);
  assert.equal(w.no.parked().length, 1);
  assert.deepEqual(w.no.parked()[0].parkedOn, ['job-1']);
  await w.advance(50 * MIN);
  assert.equal(w.turns.length, 1, 'parked: no rechecks');
  assert.ok(w.types().includes('parked'));
  assert.ok(w.types().includes('job_tracked'));
});

test('finishJob runs one report turn, delivers it, then the parked check runs once', async () => {
  const w = await five({
    reply: (_c, p, ctx) => (ctx.kind === 'report' ? 'The render is done: 3 files.' : p.includes('render finished') ? 'NOTHING_OWED' : 'STILL_RUNNING'),
  });
  w.no.noteReply(C, 'Rendering now, it will report.');
  w.no.trackJob(C, 'job-1', { title: 'render' });
  await w.advance(FIVE);
  await w.advance(10 * MIN);
  w.reply = (_c, _p, ctx) => (ctx.kind === 'report' ? 'The render is done: 3 files.' : 'NOTHING_OWED');
  await w.no.finishJob('job-1', { status: 'done', text: 'x'.repeat(5000) });
  assert.equal(w.turns.length, 3);
  const report = w.turns[1];
  assert.equal(report.ctx.kind, 'report');
  assert.match(report.prompt, /render/);
  assert.match(report.prompt, /done/);
  assert.ok(!report.prompt.includes('x'.repeat(751)), 'job text bounded to 1500: head and tail');
  assert.ok(report.prompt.includes('x'.repeat(750) + ' … ' + 'x'.repeat(750)));
  assert.ok(report.prompt.includes('Tell the user in a few lines what it produced and what is still open. No waiting in this turn.'));
  assert.equal(w.turns[2].ctx.kind, 'check');
  assert.deepEqual(w.sent.map((s) => s.text), ['The render is done: 3 files.']);
  assert.equal(w.no.parked().length, 0);
  assert.equal(w.no.pending().length, 0);
  for (const t of ['job_finished', 'report_delivered', 'unparked']) assert.ok(w.types().includes(t), t);
  assert.deepEqual(w.no.jobs(), []);
});

test('a report reply routed back through noteReply never schedules a check', async () => {
  const w = world({ reply: 'Report: done.' });
  w.no = w.make({
    delayMs: FIVE,
    deliver: async (cid, text) => {
      w.sent.push({ conversationId: cid, text });
      w.no.noteReply(cid, text);
    },
  });
  await w.no.start();
  w.no.trackJob(C, 'j', { title: 't' });
  await w.no.finishJob('j', { status: 'done', text: 'ok' });
  assert.equal(w.sent.length, 1);
  assert.equal(w.no.pending().length, 0);
  assert.equal(w.no.messageCount(C), 1);
});

test('onJobFinished replaces the report turn', async () => {
  const seen = [];
  const w = await five({ reply: 'STILL_RUNNING' }, { onJobFinished: (cid, job) => seen.push([cid, job.id, job.status, job.text]) });
  w.no.noteReply(C, 'x');
  w.no.trackJob(C, 'j', { title: 't' });
  await w.advance(FIVE);
  w.reply = 'NOTHING_OWED';
  await w.no.finishJob('j', { status: 'error', text: 'boom' });
  assert.deepEqual(seen, [[C, 'j', 'error', 'boom']]);
  assert.equal(w.turns.length, 2, 'parked check ran, no report turn');
  assert.equal(w.turns[1].ctx.kind, 'check');
});

test('a check parked on two jobs waits for both', async () => {
  const w = await five({ reply: (_c, _p, ctx) => (ctx.kind === 'report' ? 'report' : 'STILL_RUNNING') });
  w.no.noteReply(C, 'x');
  w.no.trackJob(C, 'a', { title: 'A' });
  w.no.trackJob(C, 'b', { title: 'B' });
  await w.advance(FIVE);
  await w.no.finishJob('a', { status: 'done', text: 'A ok' });
  assert.equal(w.turns.length, 2, 'report for A only');
  assert.equal(w.no.parked().length, 1);
  assert.deepEqual(w.no.parked()[0].parkedOn, ['b']);
  w.reply = (_c, _p, ctx) => (ctx.kind === 'report' ? 'report' : 'NOTHING_OWED');
  await w.no.finishJob('b', { status: 'done', text: 'B ok' });
  assert.equal(w.turns.length, 4);
  assert.equal(w.no.parked().length, 0);
});

test('wrapJob tracks, awaits, finishes with the result and returns it', async () => {
  const w = await five({ reply: 'done report' });
  let resolve;
  const work = new Promise((r) => { resolve = r; });
  const p = w.no.wrapJob(C, 'w1', work, { title: 'export' });
  assert.deepEqual(w.no.jobs().map((j) => j.id), ['w1']);
  resolve('exported 12 rows');
  assert.equal(await p, 'exported 12 rows');
  assert.match(w.turns[0].prompt, /exported 12 rows/);
  assert.deepEqual(w.no.jobs(), []);
});

test('wrapJob reports an error and rethrows it', async () => {
  const w = await five({ reply: 'it failed' });
  await assert.rejects(w.no.wrapJob(C, 'w2', () => Promise.reject(new Error('disk full')), { title: 'export' }), /disk full/);
  assert.match(w.turns[0].prompt, /error/);
  assert.match(w.turns[0].prompt, /disk full/);
});

test('finishJob of an unknown job does nothing', async () => {
  const w = await five();
  assert.equal(await w.no.finishJob('nope', { status: 'done' }), null);
  assert.equal(w.turns.length, 0);
});

test('with no open tracked job, running keeps timed rechecks', async () => {
  const w = await five({ reply: 'STILL_RUNNING' });
  w.no.noteReply(C, 'x');
  await w.advance(FIVE);
  assert.equal(w.no.parked().length, 0);
  assert.equal(w.no.pending()[0].rechecks, 1);
});

test('jobTimeoutMs: a parked check runs once with the last-check prompt, parks one more period, then ends', async () => {
  const H2 = 120 * MIN;
  const w = await five({ reply: (_c, _p, ctx) => (ctx.isLastCheck ? 'The render is still running and will report.' : 'STILL_RUNNING') });
  w.no.noteReply(C, 'x');
  w.no.trackJob(C, 'j', { title: 'render' });
  await w.advance(FIVE);
  await w.advance(H2 - 1);
  assert.equal(w.turns.length, 1);
  await w.advance(1);
  assert.equal(w.turns.length, 2);
  assert.equal(w.turns[1].ctx.isLastCheck, true);
  assert.match(w.turns[1].prompt, /This is the last check/);
  assert.deepEqual(w.sent.map((s) => s.text), ['The render is still running and will report.']);
  assert.equal(w.no.parked().length, 1);
  await w.advance(H2);
  assert.equal(w.turns.length, 2);
  assert.equal(w.no.parked().length, 0, 'ended after one more period');
  assert.ok(w.types().includes('park_timeout'));
  assert.ok(w.types().includes('park_ended'));
});

// ---- persistence --------------------------------------------------------------------------

test('a v0.1 store file (a plain array) still loads', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'nothing-owed-')), 'checks.json');
  writeFileSync(path, JSON.stringify([{ id: 'chk_old', conversationId: C, state: 'pending', due: 1_700_000_000_000 + FIVE, replies: [{ at: 1_700_000_000_000, text: 'old reply' }], rechecks: 0 }]));
  const w = world({ store: createFileStore(path) });
  w.no = w.make({ delayMs: FIVE });
  await w.no.start();
  assert.equal(w.no.pending().length, 1);
  await w.advance(FIVE);
  assert.match(w.turns[0].prompt, /1\. \(\d{4}-[^)]*Z\) "old reply"/);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.version, 2);
});

test('counters, open jobs and parked checks survive a restart', async () => {
  const store = createMemoryStore();
  const w = world({ store, reply: 'STILL_RUNNING' });
  w.no = w.make({ delayMs: FIVE });
  await w.no.start();
  w.no.noteUserMessage(C);
  w.no.noteReply(C, 'x');
  w.no.trackJob(C, 'j', { title: 'render' });
  await w.advance(FIVE);
  w.no.stop();
  w.timers = [];
  w.no = w.make({ delayMs: FIVE });
  await w.no.start();
  assert.equal(w.no.messageCount(C), 2);
  assert.deepEqual(w.no.jobs().map((j) => j.id), ['j']);
  assert.equal(w.no.parked().length, 1);
  await w.advance(30 * MIN);
  assert.equal(w.turns.length, 1, 'still parked after restart');
  w.reply = (_c, _p, ctx) => (ctx.kind === 'report' ? 'done' : 'NOTHING_OWED');
  await w.no.finishJob('j', { status: 'done', text: 'ok' });
  assert.equal(w.turns.length, 3);
});

test('buildReportPrompt names the job, its status and the clipped text', () => {
  const p = buildReportPrompt({ job: { id: 'j', title: 'backup', status: 'stopped', text: 'partial' } });
  assert.match(p, /backup/);
  assert.match(p, /stopped/);
  assert.match(p, /partial/);
});

// ---- back-off ladder and no re-arm ----------------------------------------------------------

test('after the 5-minute rechecks, running backs off 15, 30, 60, then a final status at 120', async () => {
  const w = await five({ reply: (_c, _p, ctx) => (ctx.isLastCheck ? 'Still running; it will report.' : 'STILL_RUNNING') });
  const t0 = w.t;
  w.no.noteReply(C, 'x');
  for (let m = 0; m < 300; m++) await w.advance(MIN);
  const mins = w.events.filter((e) => e.type === 'check_started').map((e) => (e.at - t0) / MIN);
  assert.deepEqual(mins, [5, 10, 15, 20, 25, 30, 35, 50, 80, 140, 260]);
  assert.equal(w.turns.at(-1).ctx.isLastCheck, true);
  assert.equal(w.turns.filter((t) => t.ctx.isLastCheck).length, 1);
  assert.deepEqual(w.sent.map((s) => s.text), ['Still running; it will report.']);
  assert.equal(w.no.pending().length, 0);
});

test('backoffMs is configurable; [] disables the ladder', async () => {
  const w = await five({ reply: 'STILL_RUNNING' }, { maxRechecks: 1, backoffMs: [2 * MIN] });
  const t0 = w.t;
  w.no.noteReply(C, 'x');
  for (let m = 0; m < 60; m++) await w.advance(MIN);
  const mins = w.events.filter((e) => e.type === 'check_started').map((e) => (e.at - t0) / MIN);
  assert.deepEqual(mins, [5, 10, 12]);
});

test('a restart continues the back-off ladder', async () => {
  const store = createMemoryStore();
  const w = world({ store, reply: 'STILL_RUNNING' });
  const t0 = w.t;
  w.no = w.make({ delayMs: FIVE });
  await w.no.start();
  w.no.noteReply(C, 'x');
  for (let m = 0; m < 60; m++) await w.advance(MIN); // checks at 5..35 and 50
  w.no.stop();
  w.timers = [];
  w.no = w.make({ delayMs: FIVE });
  await w.no.start();
  assert.equal(w.no.pending()[0].rechecks, 8);
  for (let m = 0; m < 30; m++) await w.advance(MIN);
  const mins = w.events.filter((e) => e.type === 'check_started').map((e) => (e.at - t0) / MIN);
  assert.deepEqual(mins.slice(-2), [50, 80]);
});

test('check replies and report replies never schedule a new check', async () => {
  const w = world({ reply: (_c, _p, ctx) => (ctx.kind === 'report' ? 'Report: the job is done.' : 'Here is what I owed.') });
  // A host that routes every outgoing message through noteReply, including the package's own.
  w.no = w.make({
    delayMs: FIVE,
    deliver: async (cid, text) => {
      w.sent.push({ conversationId: cid, text });
      w.no.noteReply(cid, text);
    },
  });
  await w.no.start();
  w.no.noteReply(C, 'promise');
  await w.advance(FIVE);
  assert.equal(w.sent.length, 1);
  assert.equal(w.no.pending().length, 0, 'check reply did not schedule');
  w.no.trackJob(C, 'j', { title: 'job' });
  await w.no.finishJob('j', { status: 'done', text: 'ok' });
  assert.equal(w.sent.length, 2);
  assert.equal(w.no.pending().length, 0, 'report reply did not schedule');
  // A host that delivers them itself and marks the kind.
  assert.equal(w.no.noteReply(C, 'a check reply', { kind: 'check' }), null);
  assert.equal(w.no.noteReply(C, 'a report', { kind: 'report' }), null);
  assert.equal(w.no.pending().length, 0);
  await w.advance(FIVE * 6);
  assert.equal(w.turns.length, 2, 'one check, one report, nothing else');
});
