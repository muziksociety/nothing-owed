import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeliveredLog } from '../src/index.js';
import { started, world, MIN, DELAY } from './helpers.js';

const LINE = 'Only what is in this delivered list reached the user. Anything you wrote that is not in it, they never saw.';

test('the check prompt lists what was delivered, not what the agent wrote', async () => {
  const w = await started();
  w.no.noteDelivered('chat-42', 'On it, the summary lands soon.');
  w.no.noteReply('chat-42', 'On it, the summary lands soon.');
  // The summary was written in a turn whose output never reached the user: nothing is noted.
  await w.advance(DELAY);
  const p = w.turns[0].prompt;
  assert.ok(p.includes(LINE));
  assert.match(p, /delivered[\s\S]*On it, the summary lands soon\./);
  assert.doesNotMatch(p, /SUMMARY:/);
});

test('delivered lists are isolated per conversation', async () => {
  const w = await started();
  w.no.noteDelivered('chat-1', 'SUMMARY: for chat one');
  w.no.noteDelivered('chat-2', 'SUMMARY: for chat two');
  w.no.noteReply('chat-1', 'a');
  w.no.noteReply('chat-2', 'b');
  await w.advance(DELAY);
  const one = w.turns.find((t) => t.conversationId === 'chat-1').prompt;
  const two = w.turns.find((t) => t.conversationId === 'chat-2').prompt;
  assert.match(one, /for chat one/);
  assert.doesNotMatch(one, /for chat two/);
  assert.match(two, /for chat two/);
  assert.doesNotMatch(two, /for chat one/);
});

test('the delivered window starts deliveredLookbackMs before the first merged reply', async () => {
  const w = await started();
  w.no.noteDelivered('chat-42', 'too old');
  w.t += 30 * MIN;
  w.no.noteDelivered('chat-42', 'recent enough');
  w.t += 5 * MIN;
  w.no.noteReply('chat-42', 'x');
  await w.advance(DELAY);
  const p = w.turns[0].prompt;
  assert.match(p, /recent enough/);
  assert.doesNotMatch(p, /too old/);
});

test('an empty delivered list says (nothing)', async () => {
  const w = await started();
  w.no.noteReply('chat-42', 'x');
  await w.advance(DELAY);
  assert.match(w.turns[0].prompt, /send log\):\n\(nothing\)/);
});

test('a host send log (getDelivered) replaces the built-in log', async () => {
  const calls = [];
  const w = world();
  w.no = w.make({
    getDelivered: async (cid, since) => {
      calls.push({ cid, since });
      return [{ at: since + 1, text: 'from the host log' }];
    },
  });
  await w.no.start();
  w.no.noteDelivered('chat-42', 'built-in entry');
  w.no.noteReply('chat-42', 'x');
  await w.advance(DELAY);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cid, 'chat-42');
  assert.match(w.turns[0].prompt, /from the host log/);
  assert.doesNotMatch(w.turns[0].prompt, /built-in entry/);
});

test('delivered log: edits by id update one entry and keep the first time', () => {
  let t = 1000;
  const log = createDeliveredLog({ now: () => t });
  log.note('chat-42', 'typing...', { id: 7 });
  t = 2000;
  log.note('chat-42', 'the full streamed reply', { id: 7 });
  const got = log.since('chat-42', 0);
  assert.deepEqual(got, [{ at: 1000, text: 'the full streamed reply' }]);
});

test('delivered log: keeps the newest entries per conversation and survives a restart', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'nothing-owed-')), 'delivered.json');
  let t = 0;
  const log = createDeliveredLog({ path, now: () => ++t, maxPerConversation: 3 });
  for (let i = 1; i <= 5; i++) log.note('chat-busy', `m${i}`);
  log.note('chat-quiet', 'only one');
  assert.deepEqual(log.since('chat-busy').map((e) => e.text), ['m3', 'm4', 'm5']);
  const again = createDeliveredLog({ path, now: () => t });
  assert.deepEqual(again.since('chat-quiet').map((e) => e.text), ['only one']);
  assert.equal(again.since('chat-busy').length, 3);
});

test('delivered log: drops entries older than maxAgeMs', () => {
  let t = 0;
  const log = createDeliveredLog({ now: () => t, maxAgeMs: 100 });
  log.note('chat-42', 'old');
  t = 500;
  log.note('chat-42', 'new');
  assert.deepEqual(log.since('chat-42').map((e) => e.text), ['new']);
});
