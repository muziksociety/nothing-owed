// v0.3 parser and prompt: near-miss markers never reach the user, DUE lines, bounded prompts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, buildReportPrompt, parseCheckReply, parseOutcome, stripStillRunning } from '../src/index.js';

const T = Date.UTC(2026, 0, 10, 12, 0, 0);

test('parser: every near-miss NOTHING_OWED form is nothing, never sent', () => {
  for (const s of [
    'NOTHING_OWED - everything is in the delivered list.',
    'Nothing owed.',
    'NOTHING OWED',
    'nothing-owed',
    'I checked the list.\nNOTHING_OWED',
    'NOTHING_OWED: the summary was delivered.',
    '> **NOTHING_OWED**',
    '"Nothing_Owed!"',
  ]) {
    assert.deepEqual(parseCheckReply(s), { outcome: 'nothing', text: '' }, JSON.stringify(s));
  }
});

test('parser: a last-line NOTHING_OWED wins in a long reply; content after a first-line one is delivered', () => {
  const long = 'I looked at everything. '.repeat(20);
  assert.equal(parseOutcome(`${long}\nNOTHING_OWED`), 'nothing');
  assert.deepEqual(parseCheckReply(`**nothing_owed**\n${long}`), { outcome: 'deliver', text: long.trim() });
  assert.equal(parseOutcome('NOTHING_OWED\nSTILL_RUNNING'), 'running', 'contradicting markers keep the check open');
});

test('parser: STILL_RUNNING as the first line, with or without a note, is running or deliver_running', () => {
  assert.deepEqual(parseCheckReply('STILL_RUNNING\nThe render is still going.'), { outcome: 'deliver_running', text: 'The render is still going.' });
  assert.deepEqual(parseCheckReply('STILL_RUNNING (render)'), { outcome: 'running', text: '' });
  assert.deepEqual(parseCheckReply('Still running.'), { outcome: 'running', text: '' });
  assert.deepEqual(parseCheckReply('`STILL RUNNING`'), { outcome: 'running', text: '' });
  assert.deepEqual(parseCheckReply('Here is A.\n**still_running**'), { outcome: 'deliver_running', text: 'Here is A.' });
  assert.equal(stripStillRunning('STILL_RUNNING\nA'), 'A');
});

test('parser: DUE <ISO time> alone, or as the last line after content', () => {
  const iso = '2026-01-11T09:00:00.000Z';
  assert.deepEqual(parseCheckReply(`DUE ${iso}`), { outcome: 'due', text: '', dueAt: Date.parse(iso) });
  assert.deepEqual(parseCheckReply(`\`DUE 2026-01-11T09:00:00Z\``), { outcome: 'due', text: '', dueAt: Date.parse(iso) });
  assert.deepEqual(parseCheckReply(`Noted, I will remind you tomorrow at 9.\nDUE: ${iso}`), { outcome: 'due', text: 'Noted, I will remind you tomorrow at 9.', dueAt: Date.parse(iso) });
  assert.equal(parseOutcome(`due ${iso}`), 'deliver', 'only upper-case DUE is a marker');
});

test('parser: a DUE line with a time that does not parse is running, never sent', () => {
  assert.deepEqual(parseCheckReply('DUE tomorrow morning'), { outcome: 'running', text: '' });
  assert.deepEqual(parseCheckReply('Here is A.\nDUE soon'), { outcome: 'deliver_running', text: 'Here is A.' });
});

test('parser: plain content is still delivered, failures still failed', () => {
  assert.deepEqual(parseCheckReply('Here is the summary.'), { outcome: 'deliver', text: 'Here is the summary.' });
  assert.equal(parseOutcome(''), 'failed');
  assert.equal(parseOutcome('…'), 'failed');
  assert.equal(parseOutcome('Down.', { failTexts: ['Down.'] }), 'failed');
  // a long reply that mentions the token mid-text, not as a marker line, is content
  const long = `${'x'.repeat(250)} NOTHING_OWED was not the answer here. ${'y'.repeat(20)}`;
  assert.equal(parseOutcome(long), 'deliver');
});

test('prompt: a long reply keeps its first 150 and last 150 characters', () => {
  const text = 'Here is the analysis. ' + 'detail '.repeat(60) + 'I will send the full PDF tonight.';
  const p = buildPrompt({ replies: [{ at: 0, text }] });
  assert.ok(p.includes('I will send the full PDF tonight.'));
  assert.ok(p.includes('Here is the analysis.'));
  assert.ok(p.includes(' … '));
  const quoted = p.match(/1\. \([^)]*\) "(.*)"/)[1];
  assert.equal(quoted.length, 300 + 3);
});

test('prompt: the delivered list shows the newest 40 and says how many older ones are hidden', () => {
  const delivered = Array.from({ length: 45 }, (_, i) => ({ at: i, text: `d${i}` }));
  const p = buildPrompt({ replies: [{ at: 0, text: 'x' }], delivered });
  assert.ok(p.includes('(5 older not shown)'));
  assert.ok(!p.includes('"d4"'));
  assert.ok(p.includes('"d5"') && p.includes('"d44"'));
  const q = buildPrompt({ replies: [{ at: 0, text: 'x' }], delivered, maxDelivered: 10 });
  assert.ok(q.includes('(35 older not shown)'));
});

test('prompt: queued deliveries get their own do-not-repeat list', () => {
  const p = buildPrompt({ replies: [{ at: 0, text: 'x' }], queued: [{ at: 0, text: 'Part A is ready' }] });
  assert.match(p, /Queued, will be sent automatically - do not write these again:\n1\. \([^)]*\) "Part A is ready"/);
  assert.ok(!buildPrompt({ replies: [{ at: 0, text: 'x' }] }).includes('Queued'));
});

test('prompt: states the time now and explains DUE', () => {
  const p = buildPrompt({ replies: [{ at: 0, text: 'x' }], now: T });
  assert.ok(p.includes('The time now is 2026-01-10T12:00:00.000Z.'));
  assert.match(p, /DUE <ISO 8601 time>/);
});

test('prompt: the last check asks for a status that says plainly it is no longer watched', () => {
  const p = buildPrompt({ replies: [{ at: 0, text: 'x' }], isLastCheck: true });
  assert.match(p, /This is the last check/);
  assert.match(p, /no longer being watched/);
  assert.match(p, /Do not say it will report/);
  assert.doesNotMatch(p, /and that it will report/);
});

test('prompt: a dated check says the time the agent set has come', () => {
  const p = buildPrompt({ replies: [{ at: 0, text: 'remind you at 9' }], now: T, reason: 'due', dueAt: T });
  assert.match(p, /time you set/);
});

test('report prompt: keeps the head and tail of long output', () => {
  const p = buildReportPrompt({ job: { id: 'j', title: 'build', status: 'done', text: 'a'.repeat(2000) + 'THE END' }, maxTextLength: 100 });
  assert.ok(p.includes('THE END'));
});
