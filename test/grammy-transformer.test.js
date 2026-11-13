import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeliveredLog } from '../src/index.js';
import { deliveredTransformer, conversationIdOf } from '../examples/telegram-grammy/delivered-transformer.mjs';

// A fake grammY call chain: every call succeeds unless `failing`.
let nextId = 7;
const prev = (failing = false) => async (method, payload) =>
  failing ? { ok: false, error_code: 400, description: 'Bad Request' } : { ok: true, result: { message_id: payload.message_id ?? nextId++ } };

function setup() {
  const log = createDeliveredLog();
  const owed = { noteDelivered: (cid, text, opts) => log.note(cid, text, opts) };
  return { log, call: deliveredTransformer(owed) };
}

test('grammY transformer: only successful sends count, per chat and topic', async () => {
  const { log, call } = setup();
  await call(prev(), 'sendMessage', { chat_id: 42, text: 'On it.' });
  await call(prev(true), 'sendMessage', { chat_id: 42, text: 'failed send' });
  await call(prev(), 'sendMessage', { chat_id: 42, message_thread_id: 5, text: 'in a topic' });
  await call(prev(), 'sendMessage', { chat_id: 99, text: 'another chat' });
  await call(prev(), 'getMe', {});
  assert.deepEqual(log.since('42').map((e) => e.text), ['On it.']);
  assert.deepEqual(log.since(conversationIdOf(42, 5)).map((e) => e.text), ['in a topic']);
  assert.deepEqual(log.since('99').map((e) => e.text), ['another chat']);
});

test('grammY transformer: a streamed message edited in place stays one entry', async () => {
  const { log, call } = setup();
  const first = await call(prev(), 'sendMessage', { chat_id: 42, text: '...' });
  await call(prev(), 'editMessageText', { chat_id: 42, message_id: first.result.message_id, text: 'the full reply' });
  await call(prev(), 'sendPhoto', { chat_id: 42, caption: 'the cover' });
  assert.deepEqual(log.since('42').map((e) => e.text), ['the full reply', 'the cover']);
});
