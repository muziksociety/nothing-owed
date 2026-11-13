// Whole timelines on the fake clock. Each asserts what the user receives at each minute and
// when the model is woken. Minutes are counted from the start of the scenario.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore } from '../src/index.js';
import { world, MIN } from './helpers.js';

const C = 'chat-1';
const FIVE = 5 * MIN;

// A scenario world: `model(prompt, ctx, s)` answers check and report turns.
// s.got:   what reached the user, [{ min, text }]
// s.wakes: every model wake, [{ min, kind }]
function scenario({ model, store, failSend, extra = {} } = {}) {
  const s = world({ store });
  s.T0 = s.t;
  s.got = [];
  s.wakes = [];
  s.sends = 0;
  s.min = () => (s.t - s.T0) / MIN;
  s.reply = (_cid, prompt, ctx) => {
    s.wakes.push({ min: s.min(), kind: ctx.kind });
    return model(prompt, ctx, s);
  };
  s.build = async () => {
    s.no = s.make({
      delayMs: FIVE,
      deliver: async (cid, text) => {
        s.sends++;
        if (failSend?.(s.sends, text)) throw new Error('platform did not confirm');
        s.got.push({ min: s.min(), text });
        s.no.noteDelivered(cid, text);
        return { ids: [s.sends] };
      },
      ...extra,
    });
    await s.no.start();
  };
  s.restart = async () => {
    s.no.stop();
    s.timers = [];
    await s.build();
  };
  // Step one minute at a time so every timer fires at its own minute.
  s.to = async (m) => {
    while (s.t < s.T0 + m * MIN) await s.advance(Math.min(MIN, s.T0 + m * MIN - s.t));
  };
  s.user = () => s.no.noteUserMessage(C);
  s.agent = (text) => {
    s.no.noteDelivered(C, text);
    s.no.noteReply(C, text);
  };
  return s;
}

const deliveredPart = (prompt) => prompt.split("send log):")[1] ?? '';

test('(a) 30-minute non-stop chat: the promise from minute 2 is in the check at 5, then a check every 5 minutes', async () => {
  const s = scenario({
    model: (prompt, ctx) => {
      if (prompt.includes('send the chart') && !deliveredPart(prompt).includes('Here is the chart')) return 'Here is the chart: up 12% this week.';
      return 'NOTHING_OWED';
    },
  });
  await s.build();
  for (let m = 0; m < 30; m++) {
    await s.to(m);
    s.user();
    s.agent(m === 2 ? "Good question. I'll send the chart in a bit." : `Answer ${m}.`);
  }
  await s.to(30);

  assert.deepEqual(s.wakes.map((x) => x.min), [5, 10, 15, 20, 25, 30]);
  const first = s.turns[0].prompt;
  // minute 2's reply is message 6; the check runs after 10 messages, so it is 5 messages back
  assert.match(first, /3\. \(5 messages back, [^)]+\) "Good question\. I'll send the chart in a bit\."/);
  assert.match(first, /1\. \(9 messages back, [^)]+\) "Answer 0\."/);
  assert.deepEqual(s.got, [{ min: 5, text: 'Here is the chart: up 12% this week.' }]);
  assert.equal(s.no.messageCount(C), 61, '60 chat messages plus the delivered chart');
});

test('(b) two promises, one done and one running: first item at 5, second at the next check', async () => {
  const s = scenario({
    model: (_p, ctx) => (ctx.recheck === 0 ? 'Here is the outline.\nThe full draft is still being written.\nSTILL_RUNNING' : 'Here is the full draft.'),
  });
  await s.build();
  s.user();
  s.agent("I'll send the outline and then the full draft.");
  await s.to(30);
  assert.deepEqual(s.got, [
    { min: 5, text: 'Here is the outline.\nThe full draft is still being written.' },
    { min: 10, text: 'Here is the full draft.' },
  ]);
  assert.deepEqual(s.wakes.map((x) => x.min), [5, 10]);
});

test('(c) 1-hour tracked job: parked at 5, no wakes until it ends at 60, then one report and one check', async () => {
  const s = scenario({
    model: (prompt, ctx) => {
      if (ctx.kind === 'report') return 'The render is done: 4 clips, 2.1 GB. Nothing else is open.';
      return deliveredPart(prompt).includes('The render is done') ? 'NOTHING_OWED' : 'STILL_RUNNING';
    },
  });
  await s.build();
  s.user();
  s.agent('Starting the 1-hour render now; it will report when done.');
  s.no.trackJob(C, 'render-1', { title: 'render' });
  await s.to(5);
  assert.equal(s.no.parked().length, 1);
  await s.to(60);
  assert.deepEqual(s.wakes, [{ min: 5, kind: 'check' }], 'no wakes while parked');
  await s.no.finishJob('render-1', { status: 'done', text: '4 clips written, 2.1 GB' });
  assert.deepEqual(s.wakes, [
    { min: 5, kind: 'check' },
    { min: 60, kind: 'report' },
    { min: 60, kind: 'check' },
  ]);
  assert.deepEqual(s.got, [{ min: 60, text: 'The render is done: 4 clips, 2.1 GB. Nothing else is open.' }]);
  await s.to(180);
  assert.equal(s.wakes.length, 3);
});

test('(d) untracked long work: rechecks every 5 minutes up to 6, then one status', async () => {
  const s = scenario({
    model: (_p, ctx) => (ctx.isLastCheck ? 'The upload is still running and will report when done.' : 'STILL_RUNNING'),
  });
  await s.build();
  s.user();
  s.agent('Uploading now; it will report when done.');
  await s.to(120);
  assert.deepEqual(s.wakes.map((x) => x.min), [5, 10, 15, 20, 25, 30, 35]);
  assert.deepEqual(s.got, [{ min: 35, text: 'The upload is still running and will report when done.' }]);
});

test('(e) restart mid-window and mid-park: nothing lost, the counter continues', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'nothing-owed-')), 'state.json');
  const s = scenario({
    store: createFileStore(path),
    model: (prompt, ctx) => {
      if (ctx.kind === 'report') return 'The import finished: 300 rows.';
      if (prompt.includes('send the list') && !deliveredPart(prompt).includes('Here is the list')) return 'Here is the list: a, b, c.';
      if (prompt.includes('import job') && !deliveredPart(prompt).includes('import finished')) return 'STILL_RUNNING';
      return 'NOTHING_OWED';
    },
  });
  await s.build();
  s.user();
  s.agent("I'll send the list soon.");
  await s.to(1);
  s.user();
  await s.to(2);
  await s.restart(); // mid-window
  await s.to(3);
  s.user();
  await s.to(5);
  assert.match(s.turns[0].prompt, /1\. \(3 messages back, [^)]+\) "I'll send the list soon\."/);
  assert.deepEqual(s.got, [{ min: 5, text: 'Here is the list: a, b, c.' }]);

  await s.to(6);
  s.agent('Running the import job; it will report.');
  s.no.trackJob(C, 'import-1', { title: 'import' });
  await s.to(11);
  assert.equal(s.no.parked().length, 1);
  await s.to(20);
  await s.restart(); // mid-park
  assert.equal(s.no.parked().length, 1);
  assert.deepEqual(s.no.jobs().map((j) => j.id), ['import-1']);
  await s.to(30);
  assert.equal(s.wakes.length, 2, 'still parked, no wakes');
  await s.no.finishJob('import-1', { status: 'done', text: '300 rows' });
  assert.deepEqual(s.wakes.slice(2), [{ min: 30, kind: 'report' }, { min: 30, kind: 'check' }]);
  assert.deepEqual(s.got.slice(-1), [{ min: 30, text: 'The import finished: 300 rows.' }]);
  // 4 user/agent messages, the list, the import reply, the report
  assert.equal(s.no.messageCount(C), 7);
});

test('(f) tracked job that never finishes: a status at 2 hours, then the check ends', async () => {
  const s = scenario({
    model: (_p, ctx) => (ctx.isLastCheck ? 'The backup is still running and will report.' : 'STILL_RUNNING'),
  });
  await s.build();
  s.user();
  s.agent('Starting the backup; it will report.');
  s.no.trackJob(C, 'backup-1', { title: 'backup' });
  await s.to(600);
  assert.deepEqual(s.wakes.map((x) => x.min), [5, 125]);
  assert.deepEqual(s.got, [{ min: 125, text: 'The backup is still running and will report.' }]);
  assert.equal(s.no.parked().length, 0);
});

test('(g) delivery fails twice and lands on attempt 3; the model is woken once', async () => {
  const s = scenario({
    model: () => 'Here is the report I promised.',
    failSend: (n, text) => text.startsWith('Here is the report') && n <= 2, // the first two sends fail
  });
  await s.build();
  s.user();
  s.agent("I'll send the report.");
  await s.to(30);
  assert.deepEqual(s.wakes, [{ min: 5, kind: 'check' }]);
  assert.deepEqual(s.got, [{ min: 15, text: 'Here is the report I promised.' }]);
  assert.deepEqual(s.events.filter((e) => e.type === 'delivery_retry').map((e) => e.attempt), [1, 2]);
  assert.equal(s.events.find((e) => e.type === 'delivery_recovered').attempt, 3);
});
