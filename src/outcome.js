// The check prompt, the job report prompt, and the parser for the check turn's answer.

export const NOTHING_OWED = 'NOTHING_OWED';
export const STILL_RUNNING = 'STILL_RUNNING';

const iso = (t) => new Date(t).toISOString();
const clip = (s, max) => {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
};
const back = (n) => (n === 1 ? '1 message back' : `${n} messages back`);
const hasSeq = (items) => items.some((x) => x.seq != null);

const list = (items, max, messageCount) =>
  items.length
    ? items
        .map((x, i) => {
          const when = x.seq != null && messageCount ? `${back(Math.max(1, messageCount - x.seq + 1))}, ${iso(x.at)}` : iso(x.at);
          return `${i + 1}. (${when}) "${clip(x.text, max)}"`;
        })
        .join('\n')
    : '(nothing)';

/**
 * Build the prompt for one check turn.
 *
 * @param {object} input
 * @param {{at:number,text:string,seq?:number}[]} input.replies the agent's replies in this check
 * @param {{at:number,text:string}[]} [input.delivered] what the host actually delivered in that window
 * @param {boolean} [input.isLastCheck]  true on the final check (one-line status)
 * @param {string}  [input.userLabel]    how the prompt names the user (default "the user")
 * @param {number}  [input.maxTextLength] clip each listed text to this many characters (default 300)
 * @param {number}  [input.messageCount] messages in the conversation so far (for "N messages back")
 * @returns {string}
 */
export function buildPrompt({ replies, delivered = [], isLastCheck = false, userLabel = 'the user', maxTextLength = 300, messageCount = 0 }) {
  const u = userLabel;
  const lines = [
    `[Check from the system, not from ${u}.`,
    `Your replies to ${u} since the last check:`,
    list(replies, maxTextLength, messageCount),
  ];
  if (messageCount && hasSeq(replies)) {
    lines.push('Each reply shows how many messages back in this conversation it is. If one holds a promise, look it up there in your history before you answer.');
  }
  lines.push(
    `Messages the host actually delivered to ${u} in this conversation since just before the first of those replies (from the host's send log):`,
    list(delivered, maxTextLength, 0),
    `Only what is in this delivered list reached ${u}. Anything you wrote that is not in it, they never saw.`,
    `If you promised ${u} anything that is not in the delivered list, deliver it now, in full.`,
    `Background work you said will report back on its own stays owed until its report is in the delivered list.`,
  );
  if (isLastCheck) {
    lines.push(`This is the last check: if such work is still running, tell ${u} in one line what is still running and that it will report.`);
  } else {
    lines.push(
      `If the only thing owed is such work and it is still running, reply with exactly ${STILL_RUNNING}; the check comes back later.`,
      `If you deliver something now but another promise is still running, put the line ${STILL_RUNNING} at the very end of your reply.`,
    );
  }
  lines.push(
    `If you owe nothing, or all of it is in the delivered list, reply with exactly ${NOTHING_OWED}.`,
    `Do not wait in this turn: no sleeping, no polling loops, no watching files or processes.]`,
  );
  return lines.join('\n');
}

/**
 * Build the prompt for the report turn that runs when a tracked job ends.
 *
 * @param {object} input
 * @param {{id:string, title?:string, status?:string, text?:string}} input.job
 * @param {string} [input.userLabel]
 * @param {number} [input.maxTextLength] clip the job's output to this many characters (default 1500)
 * @returns {string}
 */
export function buildReportPrompt({ job, userLabel = 'the user', maxTextLength = 1500 }) {
  const u = userLabel;
  return [
    `[Report from the system, not from ${u}.`,
    `The background job "${job.title || job.id}" you started for ${u} has ended. Status: ${job.status || 'done'}.`,
    `What it returned:`,
    job.text ? clip(job.text, maxTextLength) : '(no output)',
    `Tell ${u} in a few lines what it produced and what is still open. No waiting in this turn.]`,
  ].join('\n');
}

const bare = (s) =>
  s
    .replace(/^[`*_"'\s]+/, '')
    .replace(/[`*_"'.!\s]+$/, '')
    .toUpperCase();

// The reply body when its last line is the STILL_RUNNING marker, else null.
function splitMarker(s) {
  const lines = s.split(/\r?\n/);
  if (lines.length < 2 || bare(lines[lines.length - 1]) !== STILL_RUNNING) return null;
  const body = lines.slice(0, -1).join('\n').trim();
  return body || null;
}

/**
 * Classify the check turn's reply.
 *
 * @param {string} text
 * @param {{failTexts?: string[]}} [opts] canned failure notices your runtime returns instead of a reply
 * @returns {'nothing'|'running'|'deliver'|'deliver_running'|'failed'}
 */
export function parseOutcome(text, { failTexts = [] } = {}) {
  const s = String(text ?? '').trim();
  if (!s || s === '...' || s === '…' || failTexts.includes(s)) return 'failed';
  const b = bare(s);
  if (b === NOTHING_OWED) return 'nothing';
  if (b === STILL_RUNNING) return 'running';
  if (splitMarker(s) != null) return 'deliver_running';
  return 'deliver';
}

/** The reply minus a trailing STILL_RUNNING line (unchanged if it has none). */
export function stripStillRunning(text) {
  const s = String(text ?? '').trim();
  return splitMarker(s) ?? s;
}

/**
 * Classify the check turn's reply and return the text to deliver.
 * @returns {{outcome: 'nothing'|'running'|'deliver'|'deliver_running'|'failed', text: string}}
 */
export function parseCheckReply(text, opts = {}) {
  const outcome = parseOutcome(text, opts);
  if (outcome === 'deliver_running') return { outcome, text: stripStillRunning(text) };
  if (outcome === 'deliver') return { outcome, text: String(text ?? '').trim() };
  return { outcome, text: '' };
}
