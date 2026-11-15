// v0.6.3: canSendFiles per conversation (a function), and the report prompt gets the files line too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportPrompt } from '../src/index.js';
import { world, MIN } from './helpers.js';

const SEND = /send it now with your file tool/;
const NO_SEND = /This turn cannot send files/;

async function check(canSendFiles, conv) {
  const w = world();
  w.no = w.make({ delayMs: 5 * MIN, canSendFiles });
  await w.no.start();
  w.no.noteReply(conv, 'I will send the video here.');
  await w.advance(5 * MIN);
  return w;
}

test('canSendFiles as a function decides per conversation', async () => {
  const fn = (cid) => !String(cid).startsWith('flow-');
  const chat = await check(fn, 'chat-1');
  assert.match(chat.turns[0].prompt, SEND);
  const flow = await check(fn, 'flow-1');
  assert.match(flow.turns[0].prompt, NO_SEND);
});

test('canSendFiles function gets the conversation id', async () => {
  const seen = [];
  await check((cid) => { seen.push(cid); return false; }, 'chat-7');
  assert.ok(seen.includes('chat-7'));
});

test('a canSendFiles function that throws: error event, the check runs without file sending', async () => {
  const w = await check(() => { throw new Error('boom'); }, 'chat-2');
  assert.match(w.turns[0].prompt, NO_SEND);
  assert.ok(w.events.some((e) => e.type === 'error' && e.stage === 'canSendFiles' && e.conversationId === 'chat-2'));
});

const job = { id: 'j1', title: 'render', status: 'done', text: 'out/v3.mp4' };

test('report prompt, default: the no-send files line', () => {
  const p = buildReportPrompt({ job });
  assert.match(p, NO_SEND);
  assert.match(p, /Do not promise to send it from this turn/);
});

test('report prompt, canSendFiles: send the file now', () => {
  const p = buildReportPrompt({ job, canSendFiles: true });
  assert.match(p, SEND);
});

test('report turn gets canSendFiles from the option', async () => {
  const w = world();
  w.no = w.make({ delayMs: 5 * MIN, canSendFiles: (cid) => cid === 'chat-3' });
  await w.no.start();
  w.no.trackJob('chat-3', 'job-1', { title: 'render' });
  await w.no.finishJob('job-1', { status: 'done', text: 'out/v3.mp4' });
  await w.no.idle();
  const report = w.turns.find((t) => t.ctx?.kind === 'report');
  assert.ok(report, 'a report turn ran');
  assert.match(report.prompt, SEND);
});
