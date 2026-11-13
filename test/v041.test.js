// v0.4.1: the normal-flow review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCheckReply, buildReportPrompt, fallbackReportText } from '../src/index.js';
import { world, MIN } from './helpers.js';

const C = 'chat-41';
const FIVE = 5 * MIN;
const NINE = Date.UTC(2026, 10, 14, 9, 0, 0);
const texts = (w) => w.sent.map((s) => s.text);

async function five(opts = {}, extra = {}) {
  const w = world(opts);
  w.no = w.make({ delayMs: FIVE, ...extra });
  await w.no.start();
  return w;
}

// ---- H1: zoneless, space-separated and "UTC" DUE times read as UTC ---------------------------

for (const s of ['DUE 2026-11-14T09:00:00', 'DUE 2026-11-14 09:00:00Z', 'DUE 2026-11-14 09:00 UTC', 'DUE 2026-11-14T09:00:00 UTC', 'DUE 2026-11-14T09:00', 'DUE 2026-11-14T10:00:00+01:00']) {
  test(`H1: ${s} is 09:00 UTC`, () => {
    assert.deepEqual(parseCheckReply(s), { outcome: 'due', text: '', dueAt: NINE });
  });
}

test('H1: a date without a time, or words, still count as running', () => {
  assert.equal(parseCheckReply('DUE 2026-11-14').outcome, 'running');
  assert.equal(parseCheckReply('DUE tomorrow at 9').outcome, 'running');
});

// ---- H4: NOTHING_OWED with one short remark; brackets and emoji around markers ----------------

test('H4: NOTHING_OWED then one short plain sentence is nothing', () => {
  assert.deepEqual(parseCheckReply('NOTHING_OWED\n\nEverything I promised is in the delivered list.'), { outcome: 'nothing', text: '' });
});

test('H4: NOTHING_OWED then content with except/but/however/a URL, or a long text, is delivered', () => {
  assert.equal(parseCheckReply('NOTHING_OWED\nBut the invoice is still open: 50 USD.').outcome, 'deliver');
  assert.equal(parseCheckReply('NOTHING_OWED\nHowever, here is the file list.').outcome, 'deliver');
  assert.equal(parseCheckReply('NOTHING_OWED\nHere it is: https://example.com/a').outcome, 'deliver');
  assert.equal(parseCheckReply(`NOTHING_OWED\n${'Here is the full text. '.repeat(10)}`).outcome, 'deliver');
  assert.equal(parseCheckReply('NOTHING_OWED\nFirst line.\nSecond line.').outcome, 'deliver');
});

test('H4: brackets and emoji around markers are stripped', () => {
  for (const s of ['[STILL_RUNNING]', '(STILL_RUNNING)', '🚧 STILL_RUNNING 🚧', '{STILL_RUNNING}']) {
    assert.deepEqual(parseCheckReply(s), { outcome: 'running', text: '' }, s);
  }
  for (const s of ['[NOTHING_OWED]', '✅ NOTHING_OWED ✅', '(NOTHING_OWED)']) {
    assert.deepEqual(parseCheckReply(s), { outcome: 'nothing', text: '' }, s);
  }
});

// ---- H2: a report after the host already answered --------------------------------------------

test('H2: the report prompt lists what was delivered since the job ended', () => {
  const p = buildReportPrompt({ job: { id: 'j', title: 'render', status: 'done', text: 'ok' }, delivered: [{ at: 0, text: 'Your render is ready: https://x/y.mp4' }] });
  assert.match(p, /since the job ended/);
  assert.match(p, /Your render is ready/);
  assert.match(p, /NOTHING_OWED/);
});

test('H2: the host sent the result itself; a NOTHING_OWED report sends nothing', async () => {
  const w = await five({ reply: (_c, p, ctx) => (ctx.kind === 'report' && p.includes('Your render is ready') ? 'NOTHING_OWED' : 'NOTHING_OWED') });
  const result = await w.no.wrapJob(C, 'r1', async () => ({ clips: 4, url: 'https://x/y.mp4' }), { title: 'render' });
  w.no.noteDelivered(C, `Your render is ready: ${result.url}`);
  w.no.noteReply(C, `Your render is ready: ${result.url}`);
  await w.no.idle();
  assert.deepEqual(texts(w), []);
  assert.ok(w.events.some((e) => e.type === 'report_skipped' && e.reason === 'host_replied'));
});

test('H2: without a host reply, a NOTHING_OWED report still gets the fallback, without raw JSON', async () => {
  const w = await five({ reply: 'NOTHING_OWED' });
  await w.no.wrapJob(C, 'r2', async () => ({ clips: 4, url: 'https://x/y.mp4' }), { title: 'render' });
  await w.no.idle();
  assert.deepEqual(texts(w), ['render done.']);
});

test('H2: the fallback prefers result.text, then result.summary', async () => {
  const w = await five({ reply: 'NOTHING_OWED' });
  await w.no.wrapJob(C, 'a', async () => ({ text: 'Exported 12 rows', extra: 1 }), { title: 'export' });
  await w.no.wrapJob('chat-b', 'b', async () => ({ summary: '4 clips, 2.1 GB' }), { title: 'render' });
  await w.no.idle();
  assert.deepEqual(texts(w).sort(), ['export done: Exported 12 rows', 'render done: 4 clips, 2.1 GB']);
  assert.equal(fallbackReportText({ id: 'j', title: 'sync', status: 'done', text: '{"a":1}' }), 'sync done.');
});

// ---- H5: a normal reply resets the verify depth ----------------------------------------------

test('H5: windows in a normal chat never hit the verify cap', async () => {
  let k = 0;
  const w = await five({ reply: (_c, p) => (p.includes('PROMISE') ? `RESULT ${++k}` : 'NOTHING_OWED') });
  for (let i = 0; i < 6; i++) {
    w.no.noteUserMessage(C);
    w.no.noteDelivered(C, `PROMISE ${i}: I'll send it in a bit.`);
    w.no.noteReply(C, `PROMISE ${i}: I'll send it in a bit.`);
    await w.advance(5.5 * MIN);
  }
  await w.advance(60 * MIN);
  assert.ok(!texts(w).some((t) => /no longer watching/.test(t)), JSON.stringify(texts(w)));
  assert.ok(!w.events.some((e) => e.type === 'verify_capped'));
});

test('H5: a normal reply joining a verify record sets its depth to 0', async () => {
  const w = await five({ reply: 'Here it is.' });
  w.no.noteReply(C, 'x');
  await w.advance(FIVE);
  assert.equal(w.no.pending()[0].depth, 1);
  const rec = w.no.noteReply(C, 'a new answer');
  assert.equal(rec.depth, 0);
});

// ---- timeZone as a function ----------------------------------------------------------------

test('timeZone may be a function of the conversation', async () => {
  const w = await five({}, { timeZone: (cid) => (cid === 'es' ? 'Europe/Madrid' : 'America/New_York') });
  w.no.noteReply('es', 'x');
  w.no.noteReply('us', 'y');
  await w.advance(FIVE);
  assert.match(w.turns.find((t) => t.conversationId === 'es').prompt, /\(Europe\/Madrid\)/);
  assert.match(w.turns.find((t) => t.conversationId === 'us').prompt, /\(America\/New_York\)/);
});
