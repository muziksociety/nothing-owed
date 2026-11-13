import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, parseOutcome, NOTHING_OWED, STILL_RUNNING } from '../src/index.js';

test('parseOutcome: NOTHING_OWED variants', () => {
  for (const s of ['NOTHING_OWED', ' nothing_owed ', 'NOTHING_OWED.', '`NOTHING_OWED`', '**NOTHING_OWED**', '**`NOTHING_OWED`**', 'Nothing_Owed', '"NOTHING_OWED"', 'NOTHING_OWED\n']) {
    assert.equal(parseOutcome(s), 'nothing', JSON.stringify(s));
  }
});

test('parseOutcome: STILL_RUNNING variants', () => {
  for (const s of ['STILL_RUNNING', '`STILL_RUNNING`', ' still_running. ', '**STILL_RUNNING**', '_STILL_RUNNING_']) {
    assert.equal(parseOutcome(s), 'running', JSON.stringify(s));
  }
});

test('parseOutcome: a short nothing-owed sentence is nothing; marker plus real content is delivered', () => {
  assert.equal(parseOutcome('Nothing owed.'), 'nothing');
  assert.equal(parseOutcome('Nothing owed, but here is a note'), 'deliver');
  assert.equal(parseOutcome('NOTHING_OWED except the summary: ...'), 'deliver');
  assert.equal(parseOutcome('Here is the summary.'), 'deliver');
});

test('parseOutcome: empty, ellipsis and canned failures are failed', () => {
  assert.equal(parseOutcome(''), 'failed');
  assert.equal(parseOutcome(null), 'failed');
  assert.equal(parseOutcome('...'), 'failed');
  assert.equal(parseOutcome('Model unavailable.', { failTexts: ['Model unavailable.'] }), 'failed');
});

test('buildPrompt: lists replies and delivered messages with the key line', () => {
  const p = buildPrompt({
    replies: [{ at: 0, text: "I'll send the summary when it lands." }],
    delivered: [{ at: 0, text: 'On it.' }],
  });
  assert.match(p, /1\. \(1970-01-01T00:00:00\.000Z\) "I'll send the summary when it lands\."/);
  assert.match(p, /send log\):\n1\. \(1970-01-01T00:00:00\.000Z\) "On it\."/);
  assert.ok(p.includes('Only what is in this delivered list reached the user. Anything you wrote that is not in it, they never saw.'));
  assert.ok(p.includes(`reply with exactly ${NOTHING_OWED}`));
  assert.ok(p.includes(`reply with exactly ${STILL_RUNNING}`));
});

test('buildPrompt: last check swaps STILL_RUNNING for a one-line status', () => {
  const p = buildPrompt({ replies: [{ at: 0, text: 'x' }], isLastCheck: true });
  assert.match(p, /This is the last check/);
  assert.doesNotMatch(p, /reply with exactly STILL_RUNNING/);
});

test('buildPrompt: custom user label and clipped texts', () => {
  const p = buildPrompt({ replies: [{ at: 0, text: 'y'.repeat(50) }], userLabel: 'the customer', maxTextLength: 10 });
  assert.match(p, /reached the customer\./);
  assert.match(p, /"yyyyy … yyyyy"/);
});
