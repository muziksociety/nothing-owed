// v0.4 parser: every row of the second review's table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCheckReply, buildPrompt } from '../src/index.js';

const Z = Date.parse('2026-11-20T09:00:00Z');
const long = 'I went through the conversation carefully. The summary was sent at 10:02 and it is in the delivered list, the link was sent at 10:04 and it is in the list too, and the user confirmed both. ';

const rows = [
  ['Status: STILL_RUNNING', { outcome: 'running', text: '' }],
  ['The render is STILL_RUNNING.', { outcome: 'deliver_running', text: 'The render is still running.' }],
  ['```\nSTILL_RUNNING\n```', { outcome: 'running', text: '' }],
  ['```\nDUE 2026-11-20T09:00:00Z\n```', { outcome: 'due', text: '', dueAt: Z }],
  ['DUE <2026-11-20T09:00:00Z>', { outcome: 'due', text: '', dueAt: Z }],
  ['DUE tomorrow at 9:00', { outcome: 'running', text: '' }],
  ['DUE 2026-11-20 09:00', { outcome: 'due', text: '', dueAt: Z }], // no zone reads as UTC (v0.4.1)
  ['DUE 20/11/2026 09:00', { outcome: 'running', text: '' }],
  ['DUE 9', { outcome: 'running', text: '' }],
  ['DUE 2026-11-20T09:00:00Z - reminder to call', { outcome: 'due', text: '', dueAt: Z }],
  ['DUE 2026-11-20T10:00:00+01:00', { outcome: 'due', text: '', dueAt: Z }],
  ['DUE 2026-11-20T09:00:00Z\n(I will remind them then.)', { outcome: 'due', text: '', dueAt: Z }],
  ['Nothing is owed.', { outcome: 'nothing', text: '' }],
  ['I owe nothing.', { outcome: 'nothing', text: '' }],
  [long + 'So the answer is NOTHING_OWED.', { outcome: 'nothing', text: '' }],
  [long + 'Therefore: nothing is owed here.', { outcome: 'nothing', text: '' }],
  ['Good news: nothing owed on invoice 42, your balance is zero.', { outcome: 'deliver', text: 'Good news: nothing owed on invoice 42, your balance is zero.' }],
  ['NOTHING_OWED except the link: https://example.com/file.pdf', { outcome: 'deliver', text: 'The link: https://example.com/file.pdf' }],
  ['Invoice summary\nAmount: 50 USD\nDue 2026-12-01', { outcome: 'deliver', text: 'Invoice summary\nAmount: 50 USD\nDue 2026-12-01' }],
  ['Due 12 May the report goes to the board.\nHere is the draft: ...', { outcome: 'deliver', text: 'Due 12 May the report goes to the board.\nHere is the draft: ...' }],
  ['<think>they got it</think>\nNOTHING_OWED', { outcome: 'nothing', text: '' }],
  ['NOTHING_OWED\nSTILL_RUNNING', { outcome: 'running', text: '' }],
  ['STILL_RUNNING\nNOTHING_OWED', { outcome: 'running', text: '' }],
  ['NOTHING_OWED\nHere is the link you asked for: https://example.com/a', { outcome: 'deliver', text: 'Here is the link you asked for: https://example.com/a' }],
  ['due 2026-11-20T09:00:00Z', { outcome: 'deliver', text: 'due 2026-11-20T09:00:00Z' }],
];

for (const [input, want] of rows) {
  test(`parser row: ${JSON.stringify(input.length > 60 ? input.slice(0, 25) + ' ... ' + input.slice(-30) : input)}`, () => {
    assert.deepEqual(parseCheckReply(input), want);
  });
}

test('prompt: failed sends get their own list, separate from queued retries', () => {
  const p = buildPrompt({ replies: [{ at: 0, text: 'x' }], queued: [{ at: 0, text: 'retrying' }], failed: [{ at: 0, text: 'lost text' }] });
  assert.match(p, /Queued, will be sent automatically - do not write these again:\n1\. \([^)]*\) "retrying"/);
  assert.match(p, /Failed to send - write it again if still needed:\n1\. \([^)]*\) "lost text"/);
});

test('prompt: says when the delivered list may be incomplete', () => {
  const p = buildPrompt({ replies: [{ at: 0, text: 'x' }], deliveredSince: 1000 });
  assert.match(p, /may be incomplete/);
  assert.ok(!buildPrompt({ replies: [{ at: 0, text: 'x' }] }).includes('may be incomplete'));
});
