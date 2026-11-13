// v0.3 whole timelines: each lost-promise case from the v0.2 review, replayed minute by minute on
// the fake clock. Each test asserts what the user receives, and when.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/index.js';
import { world, MIN } from './helpers.js';

const C = 'chat-5';
const FIVE = 5 * MIN;
const deliveredPart = (prompt) => (prompt.split('send log):')[1] ?? '').split('Only what is')[0];
const queuedPart = (prompt) => (prompt.split('do not write these again:')[1] ?? '').split('Only what is')[0];

// s.got: [{ min, text }] what reached the user. s.wakes: [{ min, kind, reason }] every model wake.
function scenario({ model, store = createMemoryStore(), failSend, hostLogs = true, extra = {} } = {}) {
  const s = world({ store });
  s.T0 = s.t;
  s.got = [];
  s.wakes = [];
  s.sends = 0;
  s.min = () => (s.t - s.T0) / MIN;
  s.reply = (_cid, prompt, ctx) => {
    s.wakes.push({ min: s.min(), kind: ctx.kind, reason: ctx.reason });
    return model(prompt, ctx, s);
  };
  s.build = async (more = {}) => {
    s.no = s.make({
      delayMs: FIVE,
      deliver: async (cid, text) => {
        s.sends++;
        if (failSend?.(s.sends, text, s)) throw new Error('platform did not confirm');
        s.got.push({ min: s.min(), text });
        if (hostLogs) s.no.noteDelivered(cid, text);
        return { ids: [s.sends] };
      },
      ...extra,
      ...more,
    });
    await s.no.start();
  };
  s.restart = async (more) => {
    s.no.stop();
    s.timers = [];
    await s.build(more);
    await s.no.idle();
  };
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

test('case 1: the model is overloaded at the check; the promise is kept and delivered when it recovers', async () => {
  const s = scenario({
    model: (prompt, ctx, sc) => {
      if (sc.min() < 20) throw new Error('529 overloaded');
      return deliveredPart(prompt).includes('Summary:') ? 'NOTHING_OWED' : 'Summary: three points.';
    },
  });
  await s.build();
  s.user();
  s.agent('I will send the summary when it is done.');
  await s.to(60);
  assert.deepEqual(s.wakes.map((w) => w.min), [5, 10, 15, 20, 25]);
  assert.deepEqual(s.got, [{ min: 20, text: 'Summary: three points.' }]);
});

test('case 1b: the model never recovers; the user is told plainly at the end of the ladder', async () => {
  const s = scenario({ model: () => { throw new Error('529 overloaded'); } });
  await s.build();
  s.user();
  s.agent('I will send the summary when it is done.');
  await s.to(400);
  assert.deepEqual(s.wakes.map((w) => w.min), [5, 10, 15, 20, 25, 30, 35, 50, 80, 140, 260]);
  assert.deepEqual(s.got, [{ min: 260, text: 'I could not check on what I promised you earlier. Ask me again if it is still open.' }]);
});

test('case 2: a check reply that is itself a promise is watched; the summary arrives at the verify', async () => {
  const s = scenario({
    model: (prompt, ctx, sc) => {
      const got = deliveredPart(prompt);
      if (got.includes('Summary:')) return 'NOTHING_OWED';
      if (sc.min() >= 10) return 'Summary: done, three points.';
      return 'Still on it, I will send the summary in ten minutes.';
    },
  });
  await s.build();
  s.user();
  s.agent('I will send the summary when it is done.');
  await s.to(60);
  assert.deepEqual(s.got, [
    { min: 5, text: 'Still on it, I will send the summary in ten minutes.' },
    { min: 10, text: 'Summary: done, three points.' },
  ]);
  assert.deepEqual(s.wakes.map((w) => [w.min, w.reason]), [[5, 'window'], [10, 'verify'], [15, 'verify']]);
});

test('case 4: README wiring (the host logs its own sends only): part A is listed as delivered, B follows, A is not repeated', async () => {
  const s = scenario({
    hostLogs: false, // the host's deliver() does not call noteDelivered: the package logs its own sends
    model: (prompt, ctx, sc) => {
      const got = deliveredPart(prompt);
      if (got.includes('Part B')) return 'NOTHING_OWED';
      if (got.includes('Part A')) return sc.min() >= 15 ? 'Part B: the rest.' : 'STILL_RUNNING';
      return 'Part A: the first half.\nSTILL_RUNNING';
    },
  });
  await s.build();
  s.user();
  s.agent('A and B coming.');
  await s.to(60);
  assert.deepEqual(s.got, [
    { min: 5, text: 'Part A: the first half.' },
    { min: 15, text: 'Part B: the rest.' },
  ]);
});

test('case 5: a send fails and waits for a retry; the recheck sees it queued; the user gets one copy', async () => {
  const s = scenario({
    failSend: (n) => n === 1,
    model: (prompt) => {
      const got = deliveredPart(prompt) + queuedPart(prompt);
      if (got.includes('Part A is ready') && got.includes('Part B')) return 'NOTHING_OWED';
      if (got.includes('Part A is ready')) return 'STILL_RUNNING';
      return 'Part A is ready: the outline.\nSTILL_RUNNING';
    },
    extra: { maxRechecks: 2, backoffMs: [] },
  });
  await s.build();
  s.user();
  s.agent('A and B coming.');
  await s.to(60);
  assert.equal(s.got.filter((g) => g.text.startsWith('Part A')).length, 1);
  assert.deepEqual(s.got, [
    { min: 10, text: 'Part A is ready: the outline.' }, // the retry; the recheck at 10 saw it queued
    // the last check (maxRechecks 2) still had only STILL_RUNNING: code says so plainly
    { min: 15, text: 'Something I promised you earlier is still running, and I am no longer watching it. Ask me again if it is still open.' },
  ]);
  assert.match(s.turns[1].prompt, /do not write these again:\n1\. \([^)]*\) "Part A is ready: the outline\."/);
});

test('case 6: a hung check turn times out; the conversation is not blocked and the promise lands', async () => {
  let hung = true;
  const s = scenario({
    model: (prompt) => {
      if (hung) { hung = false; return new Promise(() => {}); }
      return deliveredPart(prompt).includes('Here is the file') ? 'NOTHING_OWED' : 'Here is the file you asked for.';
    },
  });
  await s.build();
  s.user();
  s.agent('I will send the file.');
  for (let m = 1; m <= 30; m++) await s.advance(MIN, { wait: m > 9 }); // the hung turn settles at 8
  assert.deepEqual(s.got, [{ min: 13, text: 'Here is the file you asked for.' }]);
});

test('case 7: a reply sent while the package is delivering is scheduled and its promise kept', async () => {
  let release = null;
  const s = scenario({
    model: (prompt) => {
      const got = deliveredPart(prompt);
      if (prompt.includes('invoice tonight') && !got.includes('Invoice:')) return 'Invoice: 120 EUR, attached.';
      if (!got.includes('Here is what I owed')) return 'Here is what I owed.';
      return 'NOTHING_OWED';
    },
  });
  await s.build();
  const plain = s.no;
  s.no = s.make({
    delayMs: FIVE,
    deliver: async (cid, text) => {
      if (text === 'Here is what I owed.') await new Promise((r) => { release = r; });
      s.got.push({ min: s.min(), text });
      s.no.noteDelivered(cid, text);
    },
  });
  plain.stop();
  await s.no.start();
  s.user();
  s.agent('first promise');
  void s.advance(FIVE, { wait: false });
  await new Promise((r) => setTimeout(r, 10));
  s.user();
  s.agent('Sure, I will send the invoice tonight.'); // the user's own turn, answered during the delivery
  release();
  await s.no.idle();
  await s.to(30);
  assert.deepEqual(s.got.map((g) => g.text), ['Here is what I owed.', 'Invoice: 120 EUR, attached.']);
});

test('case 8: a restart kills a tracked job; the user is told, and nothing parks on a dead job', async () => {
  const store = createMemoryStore();
  const s = scenario({
    store,
    model: (prompt, ctx) => {
      if (ctx.kind === 'report') return 'The render stopped: the server restarted. Ask me to start it again.';
      return deliveredPart(prompt).includes('render stopped') ? 'NOTHING_OWED' : 'STILL_RUNNING';
    },
  });
  await s.build();
  s.user();
  s.agent('Rendering, I will report when done.');
  s.no.trackJob(C, 'render-1', { title: 'render' });
  await s.to(6);
  assert.equal(s.no.parked().length, 1);
  await s.restart();
  await s.to(60);
  assert.deepEqual(s.got, [{ min: 6, text: 'The render stopped: the server restarted. Ask me to start it again.' }]);
  assert.deepEqual(s.no.jobs(), []);
  // next day: a new STILL_RUNNING has no job to park on, so it rechecks on the clock
  s.agent('Uploading the new file, I will report.');
  await s.to(70);
  assert.equal(s.no.parked().length, 0);
});

test('case 9: a delivery is given up on; the Missed line with the full text comes at the next check, not days later', async () => {
  let down = true;
  const s = scenario({
    failSend: () => down,
    model: (prompt) => (deliveredPart(prompt).includes('Your summary') ? 'NOTHING_OWED' : 'Your summary: three points, all good.'),
    extra: { maxDeliveryAttempts: 3 },
  });
  await s.build();
  s.user();
  s.agent('Summary coming.');
  await s.to(15); // 5: fail, 10: fail, 15: fail -> give-up, fresh check due at 20
  down = false;
  await s.to(60);
  assert.deepEqual(s.got, [{ min: 20, text: 'Missed: Your summary: three points, all good.' }]);
});

test('case 10: "I will remind you tomorrow at 9" sets a dated timer; the reminder arrives then', async () => {
  const s = scenario({
    model: (prompt, ctx, sc) => {
      if (ctx.reason === 'due') return 'Reminder: your call with the bank is now.';
      if (deliveredPart(prompt).includes('Reminder:')) return 'NOTHING_OWED';
      return `DUE ${new Date(sc.T0 + 15 * 60 * MIN).toISOString()}`;
    },
  });
  await s.build();
  s.user();
  s.agent('I will remind you tomorrow at 9.');
  await s.to(1000);
  assert.deepEqual(s.got, [{ min: 900, text: 'Reminder: your call with the bank is now.' }]);
  // first check, the dated check at 900, its verify at 905
  assert.deepEqual(s.wakes.map((w) => [w.min, w.reason]), [[5, 'window'], [900, 'due'], [905, 'verify']]);
});

test('case 11: an outage at job end: the report turn retries, and the result reaches the user', async () => {
  let down = true;
  const s = scenario({
    model: (prompt, ctx) => {
      if (down) throw new Error('rate limited');
      if (ctx.kind === 'report') return 'The build is done: RESULT 42.';
      return deliveredPart(prompt).includes('RESULT 42') ? 'NOTHING_OWED' : 'STILL_RUNNING';
    },
  });
  await s.build();
  down = false;
  s.user();
  s.agent('Build started, I will report.');
  s.no.trackJob(C, 'j1', { title: 'build' });
  await s.to(5);
  down = true;
  await s.no.finishJob('j1', { status: 'done', text: 'RESULT 42' });
  await s.to(12);
  down = false;
  await s.to(60);
  assert.deepEqual(s.got, [{ min: 15, text: 'The build is done: RESULT 42.' }]);
});

test('case 11b: the model stays down; the code-written fallback carries the result', async () => {
  const s = scenario({
    model: (_p, ctx, sc) => {
      if (ctx.kind === 'report' || sc.min() > 5) throw new Error('rate limited');
      return 'STILL_RUNNING';
    },
  });
  await s.build();
  s.user();
  s.agent('Build started, I will report.');
  s.no.trackJob(C, 'j1', { title: 'build' });
  await s.to(5);
  await s.no.finishJob('j1', { status: 'done', text: 'RESULT 42\nlog line 2' });
  await s.to(400);
  assert.ok(s.got.some((g) => g.text === 'build done: RESULT 42'), JSON.stringify(s.got));
});

test('case 14: a promise at the end of a long reply is seen by the check and kept', async () => {
  const s = scenario({
    model: (prompt) => {
      if (deliveredPart(prompt).includes('PDF attached')) return 'NOTHING_OWED';
      return prompt.includes('full PDF tonight') ? 'PDF attached: report.pdf' : 'NOTHING_OWED';
    },
  });
  await s.build();
  s.user();
  s.agent('Here is the analysis. ' + 'detail '.repeat(60) + 'I will send the full PDF tonight.');
  await s.to(30);
  assert.deepEqual(s.got, [{ min: 5, text: 'PDF attached: report.pdf' }]);
});

test('case 15: a job ends while the user is mid-turn; the report waits for the turn to end', async () => {
  let busy = true;
  const s = scenario({
    model: (prompt, ctx) => (ctx.kind === 'report' ? 'Export finished: 12 rows.' : 'NOTHING_OWED'),
    extra: { isUserBusy: () => busy },
  });
  await s.build();
  s.no.trackJob(C, 'e1', { title: 'export' });
  await s.no.finishJob('e1', { text: '12 rows' });
  await s.to(3);
  assert.deepEqual(s.wakes, [], 'no turn while the user is busy');
  busy = false;
  await s.to(10);
  assert.deepEqual(s.got, [{ min: 4, text: 'Export finished: 12 rows.' }]);
});
