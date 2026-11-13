// v0.4.2: a status sentence before a DUE line is not sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCheckReply, buildPrompt } from '../src/index.js';

const AT = Date.UTC(2026, 10, 14, 15, 30, 0);

test('DUE after a "nothing new owed" status sentence: timer set, nothing sent', () => {
  const r = parseCheckReply('Nothing new owed tonight. The two things I promised for later come with the morning check-in, not now.\nDUE 2026-11-14T15:30:00Z');
  assert.equal(r.outcome, 'due');
  assert.equal(r.dueAt, AT);
  assert.equal(r.text, '');
});

test('DUE after "Nothing else is owed right now except the check I promised": nothing sent', () => {
  const r = parseCheckReply("Nothing else is owed right now except the check I promised: I'll look at where things stand tomorrow at noon.\nDUE 2026-11-14T15:30:00Z");
  assert.equal(r.outcome, 'due');
  assert.equal(r.text, '');
});

test('DUE after real content: the content is still sent', () => {
  const r = parseCheckReply('Here are the mix notes: the vocals sit 2 dB hot in the chorus.\nDUE 2026-11-14T15:30:00Z');
  assert.equal(r.outcome, 'due');
  assert.match(r.text, /mix notes/);
});

test('DUE after a long "nothing owed except" reply with a link keeps the content', () => {
  const body = 'Nothing else is owed except the playlist, here it is: https://example.com/p ' + 'x'.repeat(50);
  const r = parseCheckReply(body + '\nDUE 2026-11-14T15:30:00Z');
  assert.equal(r.outcome, 'due');
  assert.match(r.text, /example\.com/);
});

test('the prompt says text before DUE is sent and asks for no status notes', () => {
  const p = buildPrompt({ replies: [{ at: 0, text: 'x' }], delivered: [], now: 1 });
  assert.match(p, /do not add a status note/i);
});
