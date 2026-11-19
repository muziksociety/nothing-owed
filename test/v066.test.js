// v0.6.6: the check and report prompts say the delivered list is shortened for the prompt only, so the
// agent never sends "the rest" of a message whose entry looks cut. (Came from a host-side patch.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, buildReportPrompt } from '../src/index.js';

const note = (max) => `Texts in these lists are shortened to about ${max} characters for this prompt only. A shortened entry is NOT a cut-off message: the full text reached the user. Never send "the rest" of a message because its entry here looks cut.`;

test('check prompt: the shortened-list note follows the delivered list, with maxTextLength', () => {
  const p = buildPrompt({ replies: [{ at: 0, text: 'x' }], delivered: [{ at: 0, text: 'On it.' }], maxTextLength: 500 });
  assert.ok(p.includes(note(500)));
  assert.ok(p.indexOf(note(500)) > p.indexOf('On it.'));
});

test('report prompt: the shortened-list note follows the delivered list, at 300', () => {
  const p = buildReportPrompt({ job: { id: 'j1', title: 'render', status: 'done', text: 'ok' }, delivered: [{ at: 0, text: 'Here it is.' }] });
  assert.ok(p.includes(note(300)));
  assert.ok(p.indexOf(note(300)) > p.indexOf('Here it is.'));
});
