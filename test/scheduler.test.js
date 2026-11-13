import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNothingOwed, createFileStore, createMemoryStore } from '../src/index.js';
import { world, started, MIN, DELAY } from './helpers.js';

const C = 'chat-42';

test('a reply schedules one check delayMs later, and it runs once', async () => {
  const w = await started();
  const rec = w.no.noteReply(C, 'On it.');
  assert.equal(rec.due, w.t + DELAY);
  assert.equal(w.no.pending().length, 1);
  await w.advance(DELAY - 1);
  assert.equal(w.turns.length, 0);
  await w.advance(1);
  assert.equal(w.turns.length, 1);
  assert.equal(w.turns[0].conversationId, C);
  assert.equal(w.no.pending().length, 0);
  await w.advance(DELAY * 5);
  assert.equal(w.turns.length, 1, 'no second check without a new reply');
});

test('a newer reply merges into the pending check without moving the due time', async () => {
  const w = await started();
  w.no.noteReply(C, 'first reply');
  await w.advance(5 * MIN);
  const rec = w.no.noteReply(C, 'second reply');
  assert.equal(rec.replies.length, 2);
  assert.equal(w.no.pending().length, 1);
  await w.advance(DELAY - 5 * MIN - 1);
  assert.equal(w.turns.length, 0);
  await w.advance(1);
  assert.equal(w.turns.length, 1, 'fires at the first reply + delay, one check per window');
  assert.match(w.turns[0].prompt, /first reply/);
  assert.match(w.turns[0].prompt, /second reply/);
  assert.ok(w.types().includes('merged'));
});

test('a merged check keeps the first reply and the newest ones', async () => {
  const w = world();
  w.no = w.make({ maxReplies: 3 });
  await w.no.start();
  for (let i = 1; i <= 5; i++) w.no.noteReply(C, `reply ${i}`);
  assert.deepEqual(w.no.pending()[0].replies.map((r) => r.text), ['reply 1', 'reply 4', 'reply 5']);
});

test('NOTHING_OWED sends nothing', async () => {
  const w = await started({ reply: 'NOTHING_OWED' });
  w.no.noteReply(C, 'Here you go.');
  await w.advance(DELAY);
  assert.equal(w.turns.length, 1);
  assert.deepEqual(w.sent, []);
  assert.ok(w.types().includes('nothing_owed'));
});

test('any other answer is delivered to the user in the same conversation', async () => {
  const w = await started({ reply: 'Here is the summary I promised: three points.' });
  w.no.noteReply(C, "I'll send the summary when it lands.");
  await w.advance(DELAY);
  assert.deepEqual(w.sent, [{ conversationId: C, text: 'Here is the summary I promised: three points.' }]);
  assert.ok(w.types().includes('delivered'));
});

test('STILL_RUNNING sends nothing and rechecks later until the work reports', async () => {
  const w = await started({ reply: 'STILL_RUNNING' });
  w.no.noteReply(C, 'The export is running; it will report on its own.');
  await w.advance(DELAY);
  assert.deepEqual(w.sent, []);
  const p = w.no.pending();
  assert.equal(p.length, 1);
  assert.equal(p[0].rechecks, 1);
  w.reply = 'NOTHING_OWED';
  await w.advance(DELAY);
  assert.equal(w.turns.length, 2);
  assert.equal(w.no.pending().length, 0);
  assert.match(w.turns[1].prompt, /reply with exactly STILL_RUNNING/);
});

test('STILL_RUNNING is capped: the last check asks for a one-line status', async () => {
  const w = world({ reply: 'STILL_RUNNING' });
  w.no = w.make({ maxRechecks: 6, backoffMs: [] });
  await w.no.start();
  w.no.noteReply(C, 'job will report');
  for (let i = 0; i < 6; i++) await w.advance(DELAY);
  assert.equal(w.turns.length, 6);
  assert.equal(w.no.pending()[0].rechecks, 6);
  await w.advance(DELAY);
  assert.equal(w.turns.length, 7);
  const last = w.turns[6];
  assert.equal(last.ctx.isLastCheck, true);
  assert.match(last.prompt, /This is the last check/);
  assert.doesNotMatch(last.prompt, /reply with exactly STILL_RUNNING/);
  assert.equal(w.no.pending().length, 0, 'no endless rechecks');
  await w.advance(DELAY * 10);
  assert.equal(w.turns.length, 7);
  assert.deepEqual(w.sent, []);
});

test('the last check delivers its one-line status', async () => {
  const w = world({ reply: (_c, _p, ctx) => (ctx.isLastCheck ? 'The export is still running and will report.' : 'STILL_RUNNING') });
  w.no = w.make({ maxRechecks: 2, backoffMs: [] });
  await w.no.start();
  w.no.noteReply(C, 'job will report');
  for (let i = 0; i < 3; i++) await w.advance(DELAY);
  assert.deepEqual(w.sent.map((s) => s.text), ['The export is still running and will report.']);
});

test('a check reply never schedules a new check', async () => {
  const w = world({ reply: 'Delivering it now: the file is ready.' });
  // A host that routes every outgoing message through noteReply, including the check's own.
  w.no = w.make({
    deliver: async (cid, text) => {
      w.sent.push({ conversationId: cid, text });
      w.no.noteReply(cid, text);
    },
  });
  await w.no.start();
  w.no.noteReply(C, 'x');
  await w.advance(DELAY);
  assert.equal(w.sent.length, 1);
  assert.equal(w.no.pending().length, 0);
  await w.advance(DELAY * 3);
  assert.equal(w.turns.length, 1);
});

test('replies marked check, report or system never schedule', async () => {
  const w = await started();
  for (const kind of ['check', 'report', 'system']) assert.equal(w.no.noteReply(C, 'x', { kind }), null);
  assert.equal(w.no.pending().length, 0);
  assert.ok(w.no.noteReply(C, 'x', { kind: 'reply' }));
});

test('a check yields while the user is busy, then runs', async () => {
  let busy = true;
  const w = world();
  w.no = w.make({ isUserBusy: () => busy, busyRetryMs: MIN });
  await w.no.start();
  w.no.noteReply(C, 'x');
  await w.advance(DELAY);
  assert.equal(w.turns.length, 0);
  assert.ok(w.types().includes('yielded'));
  assert.equal(w.no.pending().length, 1);
  assert.equal(w.no.pending()[0].rechecks, 0, 'yielding does not use up rechecks');
  busy = false;
  await w.advance(MIN);
  assert.equal(w.turns.length, 1);
});

test('a reply that arrives while a check yields merges into it, older replies first', async () => {
  let busy = true;
  const w = world();
  w.no = w.make({ isUserBusy: () => busy, busyRetryMs: MIN });
  await w.no.start();
  w.no.noteReply(C, 'old');
  await w.advance(DELAY);
  w.no.noteReply(C, 'new');
  const p = w.no.pending();
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].replies.map((r) => r.text), ['old', 'new']);
  busy = false;
  await w.advance(DELAY);
  assert.equal(w.turns.length, 1);
});

test('failed check turns are silent', async () => {
  const w = world({
    reply: () => {
      throw new Error('model offline');
    },
  });
  w.no = w.make();
  await w.no.start();
  w.no.noteReply(C, 'x');
  await w.advance(DELAY);
  assert.deepEqual(w.sent, []);
  assert.ok(w.types().includes('failed'));
  assert.ok(w.events.some((e) => e.type === 'error' && e.stage === 'check'));
  assert.equal(w.no.pending().length, 0);
});

test('empty answers and canned failure notices are silent', async () => {
  for (const reply of ['', '   ', '...', 'Could not reach the model.']) {
    const w = world({ reply });
    w.no = w.make({ failTexts: ['Could not reach the model.'] });
    await w.no.start();
    w.no.noteReply(C, 'x');
    await w.advance(DELAY);
    assert.deepEqual(w.sent, [], JSON.stringify(reply));
  }
});

test('a deliver() failure is silent to the user, queued for retry, and does not crash the loop', async () => {
  const w = world({ reply: 'owed text' });
  w.no = w.make({
    deliver: async () => {
      throw new Error('send failed');
    },
  });
  await w.no.start();
  w.no.noteReply(C, 'x');
  await w.advance(DELAY);
  assert.ok(w.types().includes('delivery_retry'));
  assert.equal(w.no.outbox().length, 1);
  w.no.noteReply(C, 'y');
  await w.advance(DELAY);
  assert.equal(w.turns.length, 2);
});

test('pending checks persist in a file and reload after a restart', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'nothing-owed-')), 'checks.json');
  const w = world({ store: createFileStore(path) });
  w.no = w.make();
  await w.no.start();
  w.no.noteReply(C, 'before restart');
  await new Promise((r) => setImmediate(r));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).records[0].replies[0].text, 'before restart');
  w.no.stop();

  w.timers = [];
  w.no = w.make();
  await w.no.start();
  assert.equal(w.no.pending().length, 1);
  await w.advance(DELAY);
  assert.equal(w.turns.length, 1);
  assert.match(w.turns[0].prompt, /before restart/);
});

test('a check that was running when the process stopped runs again after a restart', async () => {
  const store = createMemoryStore();
  const w = world({ store, reply: () => new Promise(() => {}) }); // the turn never finishes
  w.no = w.make();
  await w.no.start();
  w.no.noteReply(C, 'x');
  w.t += DELAY;
  void w.no.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(store.load().records[0].state, 'running');

  const again = createNothingOwed({ store, runTurn: async () => 'NOTHING_OWED', deliver: async () => {}, now: () => w.t, setTimer: () => 0, clearTimer: () => {} });
  await again.start();
  assert.equal(again.pending().length, 1);
  assert.equal(again.pending()[0].state, 'pending');
});

test('different conversations get independent checks', async () => {
  const w = await started();
  w.no.noteReply('chat-1', 'a');
  w.no.noteReply('chat-2', 'b');
  assert.equal(w.no.pending().length, 2);
  await w.advance(DELAY);
  assert.deepEqual(w.turns.map((t) => t.conversationId).sort(), ['chat-1', 'chat-2']);
});

test('stop() halts the timer; start() picks pending checks up again', async () => {
  const w = await started();
  w.no.noteReply(C, 'x');
  w.no.stop();
  assert.equal(w.timers.length, 0);
  await w.advance(DELAY * 2);
  assert.equal(w.turns.length, 0);
  // start() on the same instance re-arms
  await w.no.start();
  await w.advance(0);
  assert.equal(w.turns.length, 1);
});

test('runTurn may return usage and cost: an onUsage hook and a usage event fire', async () => {
  const seen = [];
  const w = world({ reply: { text: 'NOTHING_OWED', usage: { input_tokens: 10, output_tokens: 3 }, costUsd: 0.02 } });
  w.no = w.make({ onUsage: (u) => seen.push(u) });
  await w.no.start();
  w.no.noteReply(C, 'x');
  await w.advance(DELAY);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].costUsd, 0.02);
  assert.equal(seen[0].conversationId, C);
  assert.ok(w.types().includes('usage'));
  assert.deepEqual(w.sent, []);
});

test('runTurn and deliver are required', () => {
  assert.throws(() => createNothingOwed({ deliver() {} }), /runTurn/);
  assert.throws(() => createNothingOwed({ runTurn: async () => '' }), /deliver/);
});

test('real timers: the default setTimer fires the check', async () => {
  let ran = 0;
  const no = createNothingOwed({ delayMs: 20, runTurn: async () => { ran++; return 'NOTHING_OWED'; }, deliver() {} });
  await no.start();
  no.noteReply(C, 'x');
  await new Promise((r) => setTimeout(r, 80));
  await no.idle();
  no.stop();
  assert.equal(ran, 1);
});
