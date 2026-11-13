// The check prompt and the parser for the check turn's answer.

export const NOTHING_OWED = 'NOTHING_OWED';
export const STILL_RUNNING = 'STILL_RUNNING';

const iso = (t) => new Date(t).toISOString();
const clip = (s, max) => {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
};

const list = (items, max) =>
  items.length
    ? items.map((x, i) => `${i + 1}. (${iso(x.at)}) "${clip(x.text, max)}"`).join('\n')
    : '(nothing)';

/**
 * Build the prompt for one check turn.
 *
 * @param {object} input
 * @param {{at:number,text:string}[]} input.replies   the agent's replies since the last check
 * @param {{at:number,text:string}[]} [input.delivered] what the host actually delivered in that window
 * @param {boolean} [input.isLastCheck]  true on the final STILL_RUNNING recheck
 * @param {string}  [input.userLabel]    how the prompt names the user (default "the user")
 * @param {number}  [input.maxTextLength] clip each listed text to this many characters (default 300)
 * @returns {string}
 */
export function buildPrompt({ replies, delivered = [], isLastCheck = false, userLabel = 'the user', maxTextLength = 300 }) {
  const u = userLabel;
  const lines = [
    `[Check from the system, not from ${u}.`,
    `Your replies to ${u} since the last check:`,
    list(replies, maxTextLength),
    `Messages the host actually delivered to ${u} in this conversation since just before the first of those replies (from the host's send log):`,
    list(delivered, maxTextLength),
    `Only what is in this delivered list reached ${u}. Anything you wrote that is not in it, they never saw.`,
    `If you promised ${u} anything that is not in the delivered list, deliver it now, in full.`,
    `Background work you said will report back on its own stays owed until its report is in the delivered list.`,
    isLastCheck
      ? `This is the last check: if such work is still running, tell ${u} in one line what is still running and that it will report.`
      : `If the only thing owed is such work and it is still running, reply with exactly ${STILL_RUNNING}; the check comes back later.`,
    `If you owe nothing, or all of it is in the delivered list, reply with exactly ${NOTHING_OWED}.`,
    `Do not wait in this turn: no sleeping, no polling loops, no watching files or processes.]`,
  ];
  return lines.join('\n');
}

/**
 * Classify the check turn's reply.
 *
 * @param {string} text
 * @param {{failTexts?: string[]}} [opts] canned failure notices your runtime returns instead of a reply
 * @returns {'nothing'|'running'|'deliver'|'failed'}
 */
export function parseOutcome(text, { failTexts = [] } = {}) {
  const s = String(text ?? '').trim();
  if (!s || s === '...' || s === '…' || failTexts.includes(s)) return 'failed';
  const bare = s
    .replace(/^[`*_"'\s]+/, '')
    .replace(/[`*_"'.!\s]+$/, '')
    .toUpperCase();
  if (bare === NOTHING_OWED) return 'nothing';
  if (bare === STILL_RUNNING) return 'running';
  return 'deliver';
}
