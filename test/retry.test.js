// Delivery retry: deliver() is done only when it resolves. Failed check replies and job reports
// are kept and resent (never regenerated) until they land or the attempts run out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/index.js';
import { world, MIN } from './helpers.js';

const C = 'chat-9';
const FIVE = 5 * MIN;

// A deliver() that fails `failures` times (or by predicate), then succeeds and returns ids.
function flaky(w, { failures = 0, error = () => new Error('send failed') } = {}) {
  let n = 0;
  w.attempts = [];
  return async (cid, text) => {
    n++;
    w.attempts.push({ at: w.t, text });
    if (typeof failures === 'function' ? failures(n, text) : n <= failures) throw error(n);
    w.sent.push({ conversationId: cid, text });
    return { ids: [`m${n}`] };
  };
}

async function setup({ reply = 'Here it is.', failures, error, store, ...extra } = {}) {
  const w = world({ reply, store });
  w.no = w.make({ delayMs: FIVE, deliver: flaky(w, { failures, error }), ...extra });
  await w.no.start();
  return w;
}

test('a successful deliver passes its ids into the delivered event', async () => {
  const w = await setup();
  w.no.noteReply(C, 'x');
  await w.advance(FIVE);
  const ev = w.events.find((e) => e.type === 'delivered');
  assert.deepEqual(ev.ids, ['m1']);
});

test('a failed check reply is kept and resent retryMs later without a new runTurn', async () => {
  const w = await setup({ failures: 1 });
  w.no.noteReply(C, 'x');
  await w.advance(FIVE);
  assert.equal(w.sent.length, 0);
  assert.equal(w.no.outbox().length, 1);
  assert.ok(w.types().includes('delivery_retry'));
  await w.advance(FIVE - 1);
  assert.equal(w.attempts.length, 1);
  await w.advance(1);
  assert.deepEqual(w.sent.map((s) => s.text), ['Here it is.']);
  assert.equal(w.turns.length, 1, 'never regenerated');
  assert.equal(w.no.outbox().length, 0);
  assert.ok(w.types().includes('delivery_recovered'));
});

test('retryMs is configurable and err.retryAfterMs overrides one wait', async () => {
  const w = await setup({
    failures: 2,
    error: (n) => Object.assign(new Error('rate limited'), n === 1 ? { retryAfterMs: 30 * 1000 } : {}),
    retryMs: 2 * MIN,
  });
  w.no.noteReply(C, 'x');
  await w.advance(FIVE);
  await w.advance(30 * 1000);
  assert.equal(w.attempts.length, 2, 'second attempt after retryAfterMs');
  await w.advance(2 * MIN);
  assert.equal(w.attempts.length, 3, 'third attempt after retryMs');
  assert.equal(w.sent.length, 1);
});

test('isPermanentError stops retrying at once', async () => {
  const w = await setup({ failures: 99, error: () => Object.assign(new Error('blocked'), { code: 403 }), isPermanentError: (e) => e.code === 403 });
  w.no.noteReply(C, 'x');
  await w.advance(FIVE);
  assert.equal(w.no.outbox().length, 0);
  const ev = w.events.find((e) => e.type === 'delivery_failed');
  assert.equal(ev.attempts, 1);
  assert.equal(ev.permanent, true);
  await w.advance(FIVE * 5);
  assert.equal(w.attempts.length, 1);
});

test('gives up after maxDeliveryAttempts; the fresh check sends the full Missed line once, and no copy', async () => {
  const long = 'L'.repeat(200);
  const w = await setup({ reply: long, failures: (n) => n <= 3, maxDeliveryAttempts: 3 });
  w.no.noteReply(C, 'x');
  await w.advance(FIVE);
  await w.advance(FIVE);
  await w.advance(FIVE);
  assert.equal(w.attempts.length, 3);
  assert.ok(w.types().includes('delivery_failed'));
  assert.equal(w.no.outbox().length, 0);
  await w.advance(FIVE); // the fresh check: the Missed line first; the model's copy is a duplicate
  assert.deepEqual(w.sent.map((s) => s.text), [`Missed: ${long}`]);
  assert.ok(w.types().includes('duplicate_skipped'));
  await w.advance(FIVE * 3);
  w.reply = 'Next item.';
  w.no.noteReply(C, 'y');
  await w.advance(FIVE);
  assert.deepEqual(w.sent.map((s) => s.text).slice(1), ['Next item.'], 'the Missed line goes once');
});

test('failed job reports are retried too', async () => {
  const w = await setup({ reply: 'Report: done.', failures: 1 });
  w.no.trackJob(C, 'j', { title: 't' });
  await w.no.finishJob('j', { status: 'done', text: 'ok' });
  assert.equal(w.no.outbox().length, 1);
  assert.equal(w.no.outbox()[0].kind, 'report');
  await w.advance(FIVE);
  assert.deepEqual(w.sent.map((s) => s.text), ['Report: done.']);
  assert.equal(w.turns.length, 1);
});

test('the attempt count persists across a restart', async () => {
  const store = createMemoryStore();
  const w = await setup({ store, failures: (n) => n <= 2, maxDeliveryAttempts: 3 });
  w.no.noteReply(C, 'x');
  await w.advance(FIVE);
  await w.advance(FIVE);
  assert.equal(w.no.outbox()[0].attempts, 2);
  w.no.stop();
  w.timers = [];
  w.no = w.make({ delayMs: FIVE, deliver: async () => { throw new Error('still down'); }, maxDeliveryAttempts: 3 });
  await w.no.start();
  assert.equal(w.no.outbox()[0].attempts, 2);
  await w.advance(FIVE);
  assert.equal(w.no.outbox().length, 0);
  assert.equal(w.events.filter((e) => e.type === 'delivery_failed').at(-1).attempts, 3);
});
