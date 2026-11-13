// v0.4: what a real-model replay of the v0.3 prompt found, with the replies it quoted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCheckReply, buildPrompt, isJunkReply } from '../src/index.js';
import { world, MIN } from './helpers.js';

const C = 'chat-r';
const FIVE = 5 * MIN;
const T = '2026-11-20T09:00:00Z';
const Z = Date.parse(T);

test('replay: "STILL_RUNNING\\nDUE <t>" keeps both: the timer and the running path', () => {
  assert.deepEqual(parseCheckReply(`STILL_RUNNING\nDUE ${T}`), { outcome: 'due', text: '', dueAt: Z, running: true });
});

test('replay: "content\\nDUE <t>\\nSTILL_RUNNING" delivers only the content and keeps both markers', () => {
  assert.deepEqual(parseCheckReply(`Here is the outline.\nDUE ${T}\nSTILL_RUNNING`), { outcome: 'due', text: 'Here is the outline.', dueAt: Z, running: true });
  assert.deepEqual(parseCheckReply(`Here is the outline.\nSTILL_RUNNING\nDUE ${T}`), { outcome: 'due', text: 'Here is the outline.', dueAt: Z, running: true });
});

test('scheduler: running + DUE sets the dated timer and keeps the recheck', async () => {
  const w = world({});
  w.no = w.make({ delayMs: FIVE });
  await w.no.start();
  const at = new Date(w.t + 24 * 60 * MIN).toISOString();
  w.reply = `Here is the outline.\nDUE ${at}\nSTILL_RUNNING`;
  w.no.noteReply(C, 'outline now, the full draft tomorrow');
  await w.advance(FIVE);
  assert.deepEqual(w.sent.map((s) => s.text), ['Here is the outline.']);
  assert.equal(w.no.dated().length, 1);
  assert.equal(w.no.pending().length, 1);
  assert.equal(w.no.pending()[0].rechecks, 1);
});

const junk = [
  '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>search',
  '<invoke name="send_file">\n<parameter name="path">a.pdf</parameter>\n</invoke>',
  '<tool_call>{"name": "send_file"}</tool_call>',
  'Let me send it.\n<function_calls>\n<invoke name="send_file"></invoke>\n</function_calls>',
];

test('replay: tool-call markup returned as text is junk', () => {
  for (const s of junk) assert.equal(isJunkReply(s), true, s);
  assert.equal(isJunkReply('Here is the file you asked for.'), false);
});

test('scheduler: a junk reply is a failed check, never delivered; isJunk can be replaced', async () => {
  for (const reply of junk) {
    const w = world({ reply });
    w.no = w.make({ delayMs: FIVE });
    await w.no.start();
    w.no.noteReply(C, 'x');
    await w.advance(FIVE);
    assert.deepEqual(w.sent, [], reply);
    assert.equal(w.no.pending()[0].rechecks, 1);
  }
  const w = world({ reply: 'BEEP internal noise' });
  w.no = w.make({ delayMs: FIVE, isJunk: (t) => t.startsWith('BEEP') });
  await w.no.start();
  w.no.noteReply(C, 'x');
  await w.advance(FIVE);
  assert.deepEqual(w.sent, []);
});

test('prompt: the time in the user zone and in UTC, and DUE asked in UTC', () => {
  const now = Date.UTC(2026, 10, 13, 10, 0);
  const p = buildPrompt({ replies: [{ at: 0, text: 'x' }], now, timeZone: 'America/New_York' });
  const line = p.split('\n').find((l) => l.startsWith('Now: '));
  assert.ok(line.includes('05:00') && line.endsWith('(America/New_York), 2026-11-13T10:00:00.000Z.'), line);
  assert.ok(buildPrompt({ replies: [{ at: 0, text: 'x' }], now }).includes('Now (UTC): 2026-11-13T10:00:00.000Z.'));
  assert.match(p, /DUE <time in UTC, ISO 8601 ending in Z>/);
});

test('prompt: file entries, no attachments in this turn, never claim a send', () => {
  const p = buildPrompt({ replies: [{ at: 0, text: 'x' }] });
  assert.match(p, /Entries like \[photo\], \[document: name\] or \[voice\] mean that file reached the user/);
  assert.match(p, /This turn cannot send files/);
  assert.match(p, /Never pretend to attach anything/);
  assert.match(p, /Never say something was sent unless it is in this list/);
});

test('scheduler: timeZone reaches the prompt', async () => {
  const w = world({});
  w.no = w.make({ delayMs: FIVE, timeZone: 'Europe/Madrid' });
  await w.no.start();
  w.no.noteReply(C, 'x');
  await w.advance(FIVE);
  assert.match(w.turns[0].prompt, /\(Europe\/Madrid\), \d{4}-/);
});
