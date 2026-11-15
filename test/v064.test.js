// v0.6.4: "STILL_RUNNING." with a period and a status note on the same line is a marker line, like
// "STILL_RUNNING - note". Before, such replies went to the user as "Still running. <note>" on every
// recheck while a job was open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCheckReply } from '../src/index.js';

test('parser: STILL_RUNNING then a period and a note on the same line is running, not sent', () => {
  const live = "STILL_RUNNING. The build job hasn't posted its result yet. I'll pass it on when it lands.";
  assert.deepEqual(parseCheckReply(live), { outcome: 'running', text: '' });
  assert.deepEqual(parseCheckReply("Still running. The job hasn't posted yet."), { outcome: 'running', text: '' });
  assert.deepEqual(parseCheckReply('**STILL_RUNNING.** The render is at 40%.'), { outcome: 'running', text: '' });
});

test('parser: content before a period-note marker line is still delivered', () => {
  assert.deepEqual(parseCheckReply('Here is A.\nSTILL_RUNNING. B is not done yet.'), { outcome: 'deliver_running', text: 'Here is A.' });
});

test('parser: the period form does not touch other text', () => {
  assert.deepEqual(parseCheckReply('Still running.'), { outcome: 'running', text: '' });
  assert.equal(parseCheckReply('Still running.now').outcome, 'deliver', 'a period with no space after it is not the marker form');
  assert.deepEqual(parseCheckReply('The render is STILL_RUNNING. Back soon.'), { outcome: 'deliver_running', text: 'The render is still running. Back soon.' });
  assert.equal(parseCheckReply('NOTHING_OWED. But I owe you the link: https://example.com/a').outcome, 'deliver', 'NOTHING_OWED keeps its old rule');
});

test('buildPrompt: a check that is not the last asks for no note about work that is still running', async () => {
  const { buildPrompt, STILL_RUNNING } = await import('../src/index.js');
  const line = `Never write a note about work that is still running ("not done yet", "I'll pass it on when it lands"): ${STILL_RUNNING} says it, and any text with it is sent to the user.`;
  assert.ok(buildPrompt({ replies: [{ at: 0, text: 'x' }] }).includes(line));
  assert.ok(!buildPrompt({ replies: [{ at: 0, text: 'x' }], isLastCheck: true }).includes(line), 'the last check asks for a one-line status instead');
});
