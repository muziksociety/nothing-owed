// The check prompt, the job report prompt, and the parser for the check turn's answer.

export const NOTHING_OWED = 'NOTHING_OWED';
export const STILL_RUNNING = 'STILL_RUNNING';

const iso = (t) => new Date(t).toISOString();

/**
 * Flatten whitespace and bound a text to `max` characters. A longer text keeps its head and its
 * tail ("first half … last half"), because a promise often sits at the end of a long reply.
 */
export function clipText(s, max = 300) {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!(max > 0) || flat.length <= max) return flat;
  const head = Math.ceil(max / 2);
  const tail = max - head;
  return `${flat.slice(0, head)} … ${tail > 0 ? flat.slice(-tail) : ''}`;
}

const back = (n) => (n === 1 ? '1 message back' : `${n} messages back`);
const hasSeq = (items) => items.some((x) => x.seq != null);

const list = (items, max, messageCount) =>
  items.length
    ? items
        .map((x, i) => {
          const when = x.seq != null && messageCount ? `${back(Math.max(1, messageCount - x.seq + 1))}, ${iso(x.at)}` : iso(x.at);
          return `${i + 1}. (${when}) "${clipText(x.text, max)}"`;
        })
        .join('\n')
    : '(nothing)';

/**
 * Build the prompt for one check turn.
 *
 * @param {object} input
 * @param {{at:number,text:string,seq?:number}[]} input.replies the agent's replies in this check
 * @param {{at:number,text:string}[]} [input.delivered] what the host actually delivered in that window
 * @param {{at:number,text:string}[]} [input.queued] deliveries waiting for a retry (sent automatically)
 * @param {boolean} [input.isLastCheck]  true on the final check (one-line status)
 * @param {string}  [input.userLabel]    how the prompt names the user (default "the user")
 * @param {number}  [input.maxTextLength] bound each listed text to this many characters (default 300)
 * @param {number}  [input.maxDelivered] show at most this many delivered messages, newest (default 40)
 * @param {number}  [input.messageCount] messages in the conversation so far (for "N messages back")
 * @param {number}  [input.now]          the time now, epoch ms (shown so the agent can write DUE times)
 * @param {'window'|'recheck'|'verify'|'due'|'park_timeout'} [input.reason] why this check runs
 * @param {number}  [input.dueAt]        on a dated check: the time the agent set
 * @returns {string}
 */
export function buildPrompt({
  replies,
  delivered = [],
  queued = [],
  isLastCheck = false,
  userLabel = 'the user',
  maxTextLength = 300,
  maxDelivered = 40,
  messageCount = 0,
  now,
  reason,
  dueAt,
}) {
  const u = userLabel;
  const lines = [`[Check from the system, not from ${u}.`];
  if (now != null) lines.push(`The time now is ${iso(now)}.`);
  if (reason === 'due') {
    lines.push(`This check runs at the time you set${dueAt != null ? ` (${iso(dueAt)})` : ''} for something you promised ${u}. If it is owed now, deliver it now.`);
  }
  lines.push(`Your replies to ${u} since the last check:`, list(replies, maxTextLength, messageCount));
  if (messageCount && hasSeq(replies)) {
    lines.push('Each reply shows how many messages back in this conversation it is. If one holds a promise, look it up there in your history before you answer.');
  }
  const cap = Math.max(0, maxDelivered ?? 40);
  const hidden = Math.max(0, delivered.length - cap);
  const shown = hidden ? delivered.slice(-cap || delivered.length) : delivered;
  lines.push(`Messages the host actually delivered to ${u} in this conversation since just before the first of those replies (from the host's send log):`);
  if (hidden) lines.push(`(${hidden} older not shown)`);
  lines.push(cap === 0 && hidden ? '' : list(shown, maxTextLength, 0));
  if (queued.length) {
    lines.push('Queued, will be sent automatically - do not write these again:', list(queued, maxTextLength, 0));
  }
  lines.push(
    `Only what is in this delivered list reached ${u}. Anything you wrote that is not in it, they never saw.`,
    `If you promised ${u} anything that is not in the delivered list, deliver it now, in full.`,
    `Background work you said will report back on its own stays owed until its report is in the delivered list.`,
  );
  if (isLastCheck) {
    lines.push(`This is the last check: if such work is still running, tell ${u} in one line what is still running, and say plainly that it is no longer being watched, so they should ask you for news. Do not say it will report.`);
  } else {
    lines.push(
      `If the only thing owed is such work and it is still running, reply with exactly ${STILL_RUNNING}; the check comes back later.`,
      `If you deliver something now but another promise is still running, put the line ${STILL_RUNNING} at the very end of your reply.`,
    );
  }
  lines.push(
    `If you promised something for a later time (a reminder, "I will check again at 9"), reply with the line DUE <ISO 8601 time>, for example DUE 2030-01-01T09:00:00Z, alone or as the last line after what you deliver now; the check comes back at that time.`,
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
 * @param {number} [input.maxTextLength] bound the job's output to this many characters (default 1500)
 * @returns {string}
 */
export function buildReportPrompt({ job, userLabel = 'the user', maxTextLength = 1500 }) {
  const u = userLabel;
  return [
    `[Report from the system, not from ${u}.`,
    `The background job "${job.title || job.id}" you started for ${u} has ended. Status: ${job.status || 'done'}.`,
    `What it returned:`,
    job.text ? clipText(job.text, maxTextLength) : '(no output)',
    `Tell ${u} in a few lines what it produced and what is still open. No waiting in this turn.]`,
  ].join('\n');
}

// ---- parser -------------------------------------------------------------------------------

// Strip decoration a model puts around a marker: quotes, bold, code, a quote mark, list bullets,
// trailing punctuation.
const decor = (line) =>
  String(line)
    .trim()
    .replace(/^(?:[>#\-*+]\s+)+/, '')
    .replace(/^[`*_"'“”‘’\s]+/, '')
    .replace(/[`*_"'“”‘’.!?,;:\s]+$/, '');

const markerRe = (word) => new RegExp(`^${word}\\s*(?:\\(.*\\)|\\[.*\\]|[-–—:].*)?$`, 'i');
const NOTHING_LINE = markerRe('nothing[\\s_-]*owed');
const RUNNING_LINE = markerRe('still[\\s_-]*running');
const NOTHING_ANY = /nothing[\s_-]*owed/i;
const SHORT = 200;

// A DUE line: { at } for a valid time, { invalid: true } for an upper-case DUE line whose time does
// not parse, null for a line that is not a DUE line ("Due to the outage..." stays content).
function dueLine(line) {
  const d = decor(line);
  const m = d.match(/^due\b[\s:]*(.*)$/i);
  if (!m) return null;
  const rest = m[1].replace(/[`*"']/g, '').trim();
  const at = /^\d/.test(rest) ? Date.parse(rest) : NaN;
  if (Number.isFinite(at)) return { at };
  return /^DUE\b/.test(d) ? { invalid: true } : null;
}

function trimBlank(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

/**
 * Classify the check turn's reply and return the text to deliver.
 *
 * - empty, `...`, or a `failTexts` entry: failed
 * - a NOTHING_OWED first or last line (any case, decorated, with a short note), or a reply under
 *   200 characters that contains NOTHING_OWED anywhere: nothing (never sent)
 * - a `DUE <ISO time>` line alone or last (or first): due, with the rest as the text to deliver now
 * - a STILL_RUNNING first or last line: running, or deliver_running with the rest
 * - anything else: deliver
 *
 * @param {string} text
 * @param {{failTexts?: string[]}} [opts] canned failure notices your runtime returns instead of a reply
 * @returns {{outcome: 'nothing'|'running'|'deliver'|'deliver_running'|'due'|'failed', text: string, dueAt?: number}}
 */
export function parseCheckReply(text, { failTexts = [] } = {}) {
  const s = String(text ?? '').trim();
  if (!s || s === '...' || s === '…' || failTexts.includes(s)) return { outcome: 'failed', text: '' };
  let lines = trimBlank(s.split(/\r?\n/));
  if (NOTHING_LINE.test(decor(lines[0])) || NOTHING_LINE.test(decor(lines[lines.length - 1]))) return { outcome: 'nothing', text: '' };
  if (s.length < SHORT && NOTHING_ANY.test(s)) return { outcome: 'nothing', text: '' };

  let dueAt = null;
  let running = false;
  const last = dueLine(lines[lines.length - 1]);
  const first = !last && lines.length > 1 ? dueLine(lines[0]) : null;
  if (last) lines = lines.slice(0, -1);
  else if (first) lines = lines.slice(1);
  const due = last || first;
  if (due?.at != null) dueAt = due.at;
  else if (due?.invalid) running = true;

  lines = trimBlank(lines);
  if (lines.length && RUNNING_LINE.test(decor(lines[lines.length - 1]))) {
    lines = trimBlank(lines.slice(0, -1));
    running = true;
  } else if (lines.length && RUNNING_LINE.test(decor(lines[0]))) {
    lines = trimBlank(lines.slice(1));
    running = true;
  }
  const body = lines.join('\n').trim();
  if (dueAt != null) return { outcome: 'due', text: body, dueAt };
  if (running) return body ? { outcome: 'deliver_running', text: body } : { outcome: 'running', text: '' };
  return body ? { outcome: 'deliver', text: body } : { outcome: 'nothing', text: '' };
}

/**
 * Classify the check turn's reply.
 * @returns {'nothing'|'running'|'deliver'|'deliver_running'|'due'|'failed'}
 */
export function parseOutcome(text, opts = {}) {
  return parseCheckReply(text, opts).outcome;
}

/** The reply minus a STILL_RUNNING first or last line (unchanged if it has none). */
export function stripStillRunning(text) {
  const s = String(text ?? '').trim();
  const r = parseCheckReply(s);
  return r.outcome === 'deliver_running' ? r.text : s;
}
