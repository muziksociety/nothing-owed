// v0.6.2: an owed file is never answered with an empty "I'll send it again".
// A host whose check turns can send files says so (canSendFiles) and the agent is told to send it
// now; a host whose check turns cannot is told to point the user at the file instead of promising.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/index.js';
import { world, MIN } from './helpers.js';

const base = { replies: [{ at: 0, text: 'I will send the video here.' }] };

test('default prompt does not ask the agent to promise a resend', () => {
  const p = buildPrompt(base);
  assert.doesNotMatch(p, /will be sent again/);
  assert.match(p, /This turn cannot send files/);
  assert.match(p, /where .* can find it/);
  assert.match(p, /Do not promise to send it from this turn/);
});

test('canSendFiles tells the agent to send the owed file now', () => {
  const p = buildPrompt({ ...base, canSendFiles: true });
  assert.doesNotMatch(p, /cannot send files/);
  assert.match(p, /send it now with your file tool/);
  assert.match(p, /Never pretend to attach anything/);
});

test('canSendFiles reaches the check prompt', async () => {
  const w = world();
  w.no = w.make({ delayMs: 5 * MIN, canSendFiles: true });
  await w.no.start();
  w.no.noteReply('c1', 'I will send the video here.');
  await w.advance(5 * MIN);
  assert.equal(w.turns.length, 1);
  assert.match(w.turns[0].prompt, /send it now with your file tool/);
});

test('without canSendFiles the check prompt keeps the no-files line', async () => {
  const w = world();
  w.no = w.make({ delayMs: 5 * MIN });
  await w.no.start();
  w.no.noteReply('c1', 'I will send the video here.');
  await w.advance(5 * MIN);
  assert.match(w.turns[0].prompt, /This turn cannot send files/);
});
