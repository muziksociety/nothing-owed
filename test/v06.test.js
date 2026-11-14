// v0.6.0: six host gaps found while moving a real host onto the package.
// 1 reply ids, 2 delivery id + attempt + saved progress, 3 the exported send guard,
// 4 the daily cap counts the user's local day, 5 host lines in the prompt,
// 6 a STILL_RUNNING left in the middle of a text is sent as "still running".
import test from 'node:test';
import assert from 'node:assert/strict';
import { cutMarkers, stripMarkerLines, dueOf, dayIn, dayStartIn, buildPrompt, createMemoryStore } from '../src/index.js';
import { world, MIN } from './helpers.js';

const C = 'chat-6';
const FIVE = 5 * MIN;
const BOGOTA = 'America/Bogota'; // UTC-5, no daylight saving

async function five(extra = {}, opts = {}) {
  const w = world(opts);
  w.no = w.make({ delayMs: FIVE, ...extra });
  await w.no.start();
  return w;
}

// ---- 1. reply ids ----------------------------------------------------------------------------

test('1: the same replyId noted twice updates the first reply and counts once', async () => {
  const w = await five();
  w.no.noteReply(C, 'Working on it', { replyId: 'r1' });
  const rec = w.no.noteReply(C, 'Working on it. I will send the stems at 9.', { replyId: 'r1' });
  assert.equal(rec.replies.length, 1);
  assert.match(rec.replies[0].text, /stems at 9/);
  assert.equal(w.no.messageCount(C), 1);
  assert.ok(w.types().includes('reply_updated'));
  await w.advance(FIVE);
  assert.equal(w.turns.length, 1);
  const p = w.turns[0].prompt;
  assert.match(p, /stems at 9/);
  assert.equal(p.split('Working on it').length - 1, 1, 'the reply is listed once');
});

test('1: different replyIds are two replies; no replyId keeps the old behaviour', async () => {
  const w = await five();
  w.no.noteReply(C, 'one', { replyId: 'a' });
  w.no.noteReply(C, 'two', { replyId: 'b' });
  const rec = w.no.noteReply(C, 'three');
  assert.equal(rec.replies.length, 3);
  assert.equal(w.no.messageCount(C), 3);
});

test('1: the whole reply arriving after its check ran joins the next check, not counted again', async () => {
  const w = await five();
  w.no.noteReply(C, 'Starting the render', { replyId: 'r2' });
  await w.advance(FIVE);
  assert.equal(w.turns.length, 1);
  const rec = w.no.noteReply(C, 'Starting the render. You get the link in an hour.', { replyId: 'r2' });
  assert.ok(rec, 'a new check is scheduled');
  assert.match(rec.replies[0].text, /link in an hour/);
  assert.equal(w.no.messageCount(C), 1);
  await w.advance(FIVE);
  assert.equal(w.turns.length, 2);
  assert.match(w.turns[1].prompt, /link in an hour/);
});

test('1: reply ids are kept in the store, so a restart does not count a reply twice', async () => {
  const store = createMemoryStore();
  const w = await five({}, { store });
  w.no.noteReply(C, 'Start', { replyId: 'r3' });
  await w.advance(FIVE);
  await w.no.stop();
  w.no = w.make({ delayMs: FIVE });
  await w.no.start();
  w.no.noteReply(C, 'Start and the whole rest', { replyId: 'r3' });
  assert.equal(w.no.messageCount(C), 1);
});

test('1: a replyId on a check or report kind is ignored (those are counted as before)', async () => {
  const w = await five();
  w.no.noteReply(C, 'report text', { kind: 'report', replyId: 'x' });
  w.no.noteReply(C, 'report text again', { kind: 'report', replyId: 'x' });
  assert.equal(w.no.messageCount(C), 2);
});

// ---- 2. delivery id, attempt and progress ------------------------------------------------------

function chunked(w, { failAfterFirst = 1 } = {}) {
  // deliver sends "chunks" one by one; the first attempt fails after `failAfterFirst` chunks
  let attempts = 0;
  return async (cid, text, meta) => {
    attempts++;
    w.metas.push({ ...meta, progress: meta.progress ? { ...meta.progress } : meta.progress });
    const chunks = text.split(' | ');
    let done = meta.progress?.done || 0;
    for (; done < chunks.length; done++) {
      if (attempts === 1 && done === failAfterFirst) throw new Error('network cut');
      w.sent.push({ conversationId: cid, text: chunks[done] });
      await meta.setProgress({ done: done + 1 });
    }
    return { ids: [attempts] };
  };
}

test('2: a retry gets the same deliveryId, the next attempt number and the saved progress', async () => {
  const w = world();
  w.no = w.make({ delayMs: FIVE, retryMs: MIN, deliver: chunked(w) });
  await w.no.start();
  w.reply = (cid, p, ctx) => (ctx.reason === 'verify' ? 'NOTHING_OWED' : 'part A | part B | part C');
  w.no.noteReply(C, 'I will send the three parts.');
  await w.advance(FIVE);
  assert.deepEqual(w.sent.map((s) => s.text), ['part A']);
  assert.equal(w.metas[0].attempt, 1);
  assert.equal(w.metas[0].progress, null);
  await w.advance(MIN);
  assert.deepEqual(w.sent.map((s) => s.text), ['part A', 'part B', 'part C'], 'only the rest is sent');
  assert.equal(w.metas[1].attempt, 2);
  assert.equal(w.metas[1].deliveryId, w.metas[0].deliveryId);
  assert.deepEqual(w.metas[1].progress, { done: 1 });
  assert.deepEqual(w.store.peek?.()?.progress ?? (await w.store.load()).progress, {}, 'progress cleared after success');
});

test('2: saved progress survives a restart', async () => {
  const store = createMemoryStore();
  const w = world({ store });
  w.no = w.make({ delayMs: FIVE, retryMs: MIN, deliver: chunked(w) });
  await w.no.start();
  w.reply = 'one | two';
  w.no.noteReply(C, 'two things coming');
  await w.advance(FIVE);
  assert.deepEqual(w.sent.map((s) => s.text), ['one']);
  await w.no.stop();
  const saved = (await store.load()).progress;
  assert.equal(Object.keys(saved).length, 1);
  w.no = w.make({ delayMs: FIVE, retryMs: MIN, deliver: chunked(w, { failAfterFirst: -1 }) }); // the new process does not fail
  await w.no.start();
  w.reply = 'NOTHING_OWED';
  await w.advance(MIN);
  assert.deepEqual(w.sent.map((s) => s.text), ['one', 'two']);
  assert.deepEqual(w.metas.at(-1).progress, { done: 1 });
});

test('2: deliver meta keeps kind, checkId and jobId', async () => {
  const w = await five();
  w.reply = 'Here it is.';
  w.no.noteReply(C, 'promise');
  await w.advance(FIVE);
  const m = w.metas[0];
  assert.equal(m.kind, 'check');
  assert.ok(m.checkId);
  assert.equal(m.jobId, null);
  assert.equal(typeof m.deliveryId, 'string');
  assert.equal(typeof m.setProgress, 'function');
});

// ---- 3 and 6. the send guard -------------------------------------------------------------------

test('3: cutMarkers cuts marker lines at the edges and never drops a normal message', () => {
  assert.equal(cutMarkers('Report done. Nothing new.\n\nNOTHING_OWED'), 'Report done. Nothing new.');
  assert.equal(cutMarkers('**STILL_RUNNING**\nThe render is at 40%.'), 'The render is at 40%.');
  assert.equal(cutMarkers('Here you go.\nDUE 2030-01-01T09:00:00Z'), 'Here you go.');
  assert.equal(cutMarkers('All sent NOTHING_OWED.'), 'All sent');
  assert.equal(cutMarkers('NOTHING_OWED'), '');
  assert.equal(cutMarkers('A normal message with no marker.'), 'A normal message with no marker.');
  assert.equal(cutMarkers(''), '');
});

test('6: a STILL_RUNNING in the middle stays as "still running" text', () => {
  assert.equal(cutMarkers('Mix sent.\nStems sent.\nSTILL_RUNNING\nThe video comes later.\nThanks.'), 'Mix sent.\nStems sent.\nStill running\nThe video comes later.\nThanks.');
  assert.equal(cutMarkers('Mix sent.\nSTILL_RUNNING\nThanks.'), 'Mix sent.\nThanks.', 'on the first two or last two lines it is a marker line: cut');
  assert.equal(cutMarkers('Line one.\nLine two.\nThe render is STILL_RUNNING, about 10 minutes.\nLine four.\nLine five.'), 'Line one.\nLine two.\nThe render is still running, about 10 minutes.\nLine four.\nLine five.');
});

test('3: stripMarkerLines and dueOf', () => {
  assert.deepEqual(stripMarkerLines('Done.\nNOTHING_OWED'), { text: 'Done.', marker: true });
  assert.deepEqual(stripMarkerLines('Done.'), { text: 'Done.', marker: false });
  assert.equal(dueOf('DUE 2030-01-01T09:00:00Z'), Date.UTC(2030, 0, 1, 9));
  assert.equal(dueOf('Due tomorrow'), null);
});

// ---- 4. the daily cap counts the local day -----------------------------------------------------

test('4: dayIn and dayStartIn follow the time zone', () => {
  const t = Date.UTC(2026, 10, 15, 1, 0); // 15 Nov 01:00 UTC = 14 Nov 20:00 in Bogota
  assert.equal(dayIn(t), Math.floor(t / 86400000));
  assert.equal(dayIn(t, BOGOTA), dayIn(t) - 1);
  assert.equal(dayStartIn(dayIn(t, BOGOTA) + 1, BOGOTA), Date.UTC(2026, 10, 15, 5, 0), 'Bogota midnight is 05:00 UTC');
  assert.equal(dayIn(t, 'Not/AZone'), dayIn(t), 'an unknown zone is UTC');
});

async function capWorld(extra) {
  const w = world();
  w.t = Date.UTC(2026, 10, 14, 23, 0); // 18:00 in Bogota
  w.no = w.make({ delayMs: FIVE, dailyCap: 2, dailyCapReserve: 0, timeZone: BOGOTA, ...extra });
  await w.no.start();
  for (let i = 0; i < 2; i++) { w.no.noteReply(C, `reply ${i}`); await w.advance(FIVE); }
  assert.equal(w.turns.length, 2);
  w.t = Date.UTC(2026, 10, 15, 1, 0); // past UTC midnight, still 14 Nov (20:00) in Bogota
  w.no.noteReply(C, 'reply 3');
  await w.advance(FIVE);
  return w;
}

test('4: with a timeZone the cap does not reset at UTC midnight, only at local midnight', async () => {
  const w = await capWorld();
  assert.equal(w.turns.length, 2, 'still capped: same local day');
  const cap = w.events.find((e) => e.type === 'daily_cap');
  assert.equal(cap.until, Date.UTC(2026, 10, 15, 5, 0));
  w.t = Date.UTC(2026, 10, 15, 5, 0);
  await w.advance(MIN);
  assert.equal(w.turns.length, 3, 'runs after local midnight');
});

test('4: capDay utc keeps the old UTC days', async () => {
  const w = await capWorld({ capDay: 'utc' });
  assert.equal(w.turns.length, 3, 'a new UTC day');
});

// ---- 5. host lines in the prompt ---------------------------------------------------------------

test('5: promptLines adds the host lines before the closing line, with the check context', async () => {
  const seen = [];
  const w = await five({
    promptLines: (cid, ctx) => { seen.push({ cid, ...ctx }); return ['Reports queued, will be sent automatically:', '1. "the mix report"']; },
  });
  w.no.noteReply(C, 'I will send the report.');
  await w.advance(FIVE);
  const lines = w.turns[0].prompt.split('\n');
  const i = lines.indexOf('1. "the mix report"');
  assert.ok(i > 0);
  assert.match(lines[i + 1], /^Do not wait in this turn/);
  assert.equal(seen[0].cid, C);
  assert.equal(seen[0].kind, 'check');
  assert.equal(seen[0].reason, 'window');
});

test('5: a promptLines that throws: an error event, and the check still runs', async () => {
  const w = await five({ promptLines: () => { throw new Error('queue down'); } });
  w.no.noteReply(C, 'promise');
  await w.advance(FIVE);
  assert.equal(w.turns.length, 1);
  assert.ok(w.events.some((e) => e.type === 'error' && e.stage === 'promptLines'));
});

test('5: the report prompt gets host lines too', async () => {
  const w = await five({ promptLines: (cid, ctx) => (ctx.kind === 'report' ? 'HOST LINE FOR REPORT' : []) });
  w.no.trackJob(C, 'job1', { title: 'render' });
  await w.no.finishJob('job1', { text: 'ok' });
  await w.no.idle();
  const rep = w.turns.find((t) => t.ctx.kind === 'report');
  assert.match(rep.prompt, /HOST LINE FOR REPORT/);
});

test('5: buildPrompt hostLines accepts a string or a list and drops blank lines', () => {
  const p = buildPrompt({ replies: [], hostLines: 'one\n\ntwo' });
  assert.match(p, /\none\ntwo\nDo not wait/);
  assert.doesNotMatch(buildPrompt({ replies: [] }), /\n\nDo not wait/);
});
