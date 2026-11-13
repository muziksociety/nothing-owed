// v0.4.3: deliver() may say what it really sent ({ text }) or that it sent nothing ({ skipped: true }).
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, MIN } from './helpers.js';

const C = 'chat-43';

async function setup(deliverResult) {
  const w = world();
  w.no = w.make({
    delayMs: 5 * MIN,
    deliver: async (cid, text, meta) => {
      w.sent.push({ conversationId: cid, text });
      w.metas.push(meta);
      return deliverResult(text);
    },
  });
  await w.no.start();
  return w;
}

test('deliver returning { text }: the next check sees the text that was really sent', async () => {
  const w = await setup(() => ({ text: 'REWRITTEN BY HOST' }));
  w.reply = (cid, prompt, ctx) => (w.turns.length === 1 ? 'ORIGINAL PROMISE: it arrives tomorrow.' : 'NOTHING_OWED');
  w.no.noteReply(C, 'I will send the mix notes.');
  await w.advance(5 * MIN);
  assert.equal(w.sent.length, 1);
  await w.advance(5 * MIN); // the verify check
  assert.equal(w.turns.length, 2, 'one verify check');
  const p = w.turns[1].prompt;
  assert.match(p, /REWRITTEN BY HOST/);
  assert.doesNotMatch(p.split('delivered to the user')[1] || '', /ORIGINAL PROMISE/, 'the original text is not in the delivered list');
});

test('deliver returning { skipped: true }: nothing logged as delivered, no verify, no retry', async () => {
  const w = await setup(() => ({ skipped: true }));
  w.reply = () => 'Here is the report.';
  w.no.noteReply(C, 'I will report.');
  await w.advance(5 * MIN);
  assert.equal(w.sent.length, 1);
  assert.ok(w.types().includes('delivery_skipped'));
  await w.advance(60 * MIN);
  assert.equal(w.turns.length, 1, 'no verify check after a skipped send');
  assert.equal(w.sent.length, 1, 'no retry');
});

test('deliver returning nothing keeps the old behaviour (text logged, verify runs)', async () => {
  const w = await setup(() => undefined);
  w.reply = (cid, prompt) => (w.turns.length === 1 ? 'The notes: vocals 2 dB hot.' : 'NOTHING_OWED');
  w.no.noteReply(C, 'notes coming');
  await w.advance(5 * MIN);
  await w.advance(5 * MIN);
  assert.equal(w.turns.length, 2);
  assert.match(w.turns[1].prompt, /vocals 2 dB hot/);
});
