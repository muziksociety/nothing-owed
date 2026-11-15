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

// "Now: Friday 13 November 2026 at 05:00 (America/New_York), 2026-11-13T10:00:00.000Z", or the UTC time only.
function nowLine(t, timeZone) {
  if (timeZone) {
    try {
      const local = new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(t));
      return `Now: ${local} (${timeZone}), ${iso(t)}.`;
    } catch { /* unknown zone: UTC only */ }
  }
  return `Now (UTC): ${iso(t)}.`;
}

const languageLine = (u, language) => `Write anything for ${u} in ${language}.`;
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
 * @param {{at:number,text:string}[]} [input.failed] deliveries given up on (the agent may write them again)
 * @param {number}  [input.deliveredSince] set when the send log does not reach back to the window start:
 *   the oldest time it covers
 * @param {boolean} [input.isLastCheck]  true on the final check (one-line status)
 * @param {string}  [input.userLabel]    how the prompt names the user (default "the user")
 * @param {number}  [input.maxTextLength] bound each listed text to this many characters (default 300)
 * @param {number}  [input.maxDelivered] show at most this many delivered messages, newest (default 40)
 * @param {number}  [input.messageCount] messages in the conversation so far (for "N messages back")
 * @param {number}  [input.now]          the time now, epoch ms (shown so the agent can write DUE times)
 * @param {string}  [input.timeZone]     IANA zone of the user (e.g. 'America/New_York'): the time is shown in it too
 * @param {'window'|'recheck'|'verify'|'due'|'park_timeout'} [input.reason] why this check runs
 * @param {number}  [input.dueAt]        on a dated check: the time the agent set
 * @param {string}  [input.language]     e.g. 'Spanish': adds "Write anything for the user in Spanish."
 * @param {string[]} [input.hostLines]   lines from the host (its own queue, extra context), added
 *   before the closing "Do not wait" line
 * @param {boolean} [input.canSendFiles] true when the check turn has a tool that sends files: an owed
 *   file is sent now. Default false: the agent points the user at the file and promises nothing.
 * @returns {string}
 */
export function buildPrompt({
  replies,
  delivered = [],
  queued = [],
  failed = [],
  deliveredSince,
  isLastCheck = false,
  userLabel = 'the user',
  maxTextLength = 300,
  maxDelivered = 40,
  messageCount = 0,
  now,
  timeZone,
  reason,
  dueAt,
  language,
  hostLines = [],
  canSendFiles = false,
}) {
  const u = userLabel;
  const lines = [`[Check from the system, not from ${u}.`];
  if (now != null) lines.push(nowLine(now, timeZone));
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
  if (deliveredSince != null) {
    lines.push(`This delivered list may be incomplete: the send log only reaches back to ${iso(deliveredSince)}. Do not send anything again unless you are sure ${u} never got it.`);
  }
  if (queued.length) {
    lines.push('Queued, will be sent automatically - do not write these again:', list(queued, maxTextLength, 0));
  }
  if (failed.length) {
    lines.push('Failed to send - write it again if still needed:', list(failed, maxTextLength, 0));
  }
  lines.push(
    `Only what is in this delivered list reached ${u}. Anything you wrote that is not in it, they never saw. Never say something was sent unless it is in this list.`,
    canSendFiles
      ? `Entries like [photo], [document: name] or [voice] mean that file reached ${u}. If a file is owed, send it now with your file tool, to this conversation; it counts as sent only once it shows in the delivered list. Never pretend to attach anything.`
      : `Entries like [photo], [document: name] or [voice] mean that file reached ${u}. This turn cannot send files: if a file is owed, tell ${u} in one line where they can find it (a link, or the chat it went to), or describe what it holds. Do not promise to send it from this turn. Never pretend to attach anything.`,
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
    `If you promised something for a later time (a reminder, "I will check again at 9"), reply with the line DUE <time in UTC, ISO 8601 ending in Z>, for example DUE 2030-01-01T09:00:00Z, alone or as the last line after what you deliver now; the check comes back at that time. Text before it is sent to ${u}, so do not add a status note about the timer.`,
    `If you owe nothing, or all of it is in the delivered list, reply with exactly ${NOTHING_OWED}.`,
  );
  if (language) lines.push(languageLine(u, language));
  lines.push(...cleanLines(hostLines));
  lines.push(`Do not wait in this turn: no sleeping, no polling loops, no watching files or processes.]`);
  return lines.join('\n');
}

// Host lines: a string or a list of strings; blank lines dropped.
export function cleanLines(v) {
  const list = Array.isArray(v) ? v : v == null ? [] : [v];
  return list
    .flatMap((x) => String(x ?? '').split(/\r?\n/))
    .map((x) => x.trimEnd())
    .filter((x) => x.trim());
}

/**
 * Build the prompt for the report turn that runs when a tracked job ends.
 *
 * @param {object} input
 * @param {{id:string, title?:string, status?:string, text?:string}} input.job
 * @param {string} [input.userLabel]
 * @param {number} [input.maxTextLength] bound the job's output to this many characters (default 1500)
 * @param {{at:number,text:string}[]} [input.delivered] what reached the user since the job ended
 * @param {string} [input.language] e.g. 'Spanish': adds "Write anything for the user in Spanish."
 * @param {string[]} [input.hostLines] lines from the host, added before the closing line
 * @returns {string}
 */
export function buildReportPrompt({ job, userLabel = 'the user', maxTextLength = 1500, delivered = [], maxDelivered = 40, language, hostLines = [] }) {
  const u = userLabel;
  const shown = delivered.slice(-Math.max(1, maxDelivered));
  return [
    `[Report from the system, not from ${u}.`,
    `The background job "${job.title || job.id}" you started for ${u} has ended. Status: ${job.status || 'done'}.`,
    `What it returned:`,
    job.text ? clipText(job.text, maxTextLength) : '(no output)',
    `Messages the host delivered to ${u} since the job ended:`,
    list(shown, 300, 0),
    `If those messages already give ${u} what it produced, reply with exactly ${NOTHING_OWED}.`,
    ...(language ? [languageLine(u, language)] : []),
    ...cleanLines(hostLines),
    `Otherwise tell ${u} in a few lines what it produced and what is still open. No waiting in this turn.]`,
  ].join('\n');
}

// ---- parser -------------------------------------------------------------------------------

// Strip decoration a model puts around a marker: quotes, bold, code, a quote mark, list bullets,
// trailing punctuation.
// Strip decoration a model puts around a marker: quotes, bold, code, brackets, emoji, a quote mark,
// list bullets, trailing punctuation.
const decor = (line) =>
  String(line)
    .trim()
    .replace(/^(?:[>#\-*+]\s+)+/, '')
    .replace(/^[`*_"'“”‘’\s[({\p{Extended_Pictographic}\uFE0F\u200D]+/u, '')
    .replace(/[`*_"'“”‘’.!?,;:\s\])}\p{Extended_Pictographic}\uFE0F\u200D]+$/u, '');

// A marker line: the marker alone, an optional label before it ("Status:"), an optional short note
// after it ("(render)", "- all delivered").
const markerRe = (word) => new RegExp(`^(?:(?:status|answer|result|outcome|reply)\\s*:\\s*)?${word}\\s*(?:[([].*|[-–—:].*)?$`, 'i');
const NOTHING_LINE = markerRe('nothing[\\s_-]*owed');
const RUNNING_LINE = markerRe('still[\\s_-]*running');
const NOTHING_TOKEN = /nothing_owed/i;
const NOTHING_PHRASE = /\b(?:nothing[\s_-]+(?:is\s+)?owed|i\s+owe\s+nothing)\b/i;
const LEADING_NOTHING = /^nothing[_ ]owed\b[\s,:;.]*(?:except(?:\s+for)?|but|apart\s+from|other\s+than|besides|however)\b[\s,:;]*/i;
const RUNNING_TOKEN = /\bSTILL_RUNNING\b/gi;
const HAS_RUNNING_TOKEN = /\bSTILL_RUNNING\b/i;
const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

// A DUE line (upper-case DUE only, so "Due 12 May..." stays content). { at } for a date and time
// (T or a space between them; no zone, Z, UTC or GMT read as UTC; an offset is kept), optionally in
// <...> and followed by a short note; { invalid: true } for any other DUE line.
function dueLine(line) {
  const d = decor(line);
  const m = d.match(/^DUE\b[\s:]*(.*)$/);
  if (!m) return null;
  const t = m[1].match(/^<?\s*(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2}|UTC|GMT)?\s*>?\s*(.*)$/i);
  if (t && (!t[4] || /^[-–—:(,;[]/.test(t[4]))) {
    // the prompt asks for UTC: no zone, "Z", "UTC" or "GMT" all mean UTC; an explicit offset is kept
    const zone = !t[3] || /^(z|utc|gmt)$/i.test(t[3]) ? 'Z' : t[3];
    const at = Date.parse(`${t[1]}T${t[2]}${zone}`);
    if (Number.isFinite(at)) return { at };
  }
  return { invalid: true };
}

function trimBlank(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

const lastSentence = (s) => s.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean).pop() || '';
const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const hasLink = (body) => /https?:\/\/|www\./i.test(body);
const isNote = (body) => /^\(.*\)$/s.test(body.trim());
const DUE_STATUS = /^(?:nothing\s+(?:(?:new|else|more|further)\s+)?(?:is\s+)?owed|i\s+owe\s+nothing)\b/i;
const isDueStatus = (body) => body.length <= 400 && !hasLink(body) && DUE_STATUS.test(body.trim());
const isRemark = (body) =>
  body.length < 160 && !body.includes('\n') && !/\b(?:except|but|however)\b/i.test(body) &&
  !hasLink(body) && body.split(/(?<=[.!?])\s+/).filter(Boolean).length <= 1;

/**
 * Classify the check turn's reply and return the text to deliver. Strict about what it sends,
 * loose about how markers look.
 *
 * - `<think>` blocks and code-fence lines are removed first
 * - empty, `...`, or a `failTexts` entry: failed
 * - a `DUE <ISO time with zone>` line (upper-case DUE; the time may sit in <...> and a short note may
 *   follow) as the last or first line: due, the rest is delivered now. Any other DUE line: running
 * - NOTHING_OWED and STILL_RUNNING marker lines (first or last line, any case, decorated, an optional
 *   "Status:" label and a short note) are removed: both present is running; STILL_RUNNING is running
 *   or deliver_running; a last-line NOTHING_OWED is nothing (what came before was reasoning); a
 *   first-line NOTHING_OWED with content after it delivers that content
 * - a reply whose last sentence holds the NOTHING_OWED token, or is a short "nothing is owed"
 *   phrase with no numbers in it, is nothing
 * - a reply that starts "NOTHING_OWED except ..." delivers what follows
 * - a STILL_RUNNING token inside a sentence becomes "still running" and the reply is deliver_running
 * - anything else: deliver
 *
 * @param {string} text
 * @param {{failTexts?: string[]}} [opts] canned failure notices your runtime returns instead of a reply
 * @returns {{outcome: 'nothing'|'running'|'deliver'|'deliver_running'|'due'|'failed', text: string, dueAt?: number, running?: boolean}}
 *   `running` is set with outcome 'due' when a STILL_RUNNING marker came too: set the timer AND keep watching
 */
export function parseCheckReply(text, { failTexts = [] } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw || raw === '...' || raw === '…' || failTexts.includes(raw)) return { outcome: 'failed', text: '' };
  const s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').split(/\r?\n/).filter((l) => !/^\s*```/.test(l)).join('\n').trim();
  if (!s) return { outcome: 'failed', text: '' };
  let lines = trimBlank(s.split('\n'));

  let dueAt = null;
  let dueBad = false;
  let running = false;
  let nothingFirst = false;
  let nothingLast = false;
  // Take marker lines off the end (up to the last two), then off the start.
  const take = (line, end) => {
    const due = dueLine(line);
    if (due) { if (due.at != null && dueAt == null) dueAt = due.at; else if (due.at == null) dueBad = true; return true; }
    const d = decor(line);
    if (RUNNING_LINE.test(d)) { running = true; return true; }
    if (NOTHING_LINE.test(d)) { if (end) nothingLast = true; else nothingFirst = true; return true; }
    return false;
  };
  for (let i = 0; i < 2 && lines.length; i++) {
    if (!take(lines[lines.length - 1], true)) break;
    lines = trimBlank(lines.slice(0, -1));
  }
  if (lines.length && take(lines[0], false)) lines = trimBlank(lines.slice(1));
  if (dueBad && dueAt == null) running = true;

  if ((nothingFirst || nothingLast) && running) return dueAt != null ? { outcome: 'due', text: '', dueAt, running: true } : { outcome: 'running', text: '' };
  if (nothingLast && dueAt == null) return { outcome: 'nothing', text: '' };

  let body = lines.join('\n').trim();
  // "NOTHING_OWED" then one short remark ("Everything is in the delivered list.") is still nothing
  if (nothingFirst && !running && dueAt == null && isRemark(body)) return { outcome: 'nothing', text: '' };
  const leading = LEADING_NOTHING.test(body);
  if (body && !leading && !nothingFirst && dueAt == null && !running) {
    const end = lastSentence(body);
    if (NOTHING_TOKEN.test(end)) return { outcome: 'nothing', text: '' };
    if (end.length <= 60 && NOTHING_PHRASE.test(end) && !/\d/.test(end)) return { outcome: 'nothing', text: '' };
  }
  if (leading) body = capitalize(body.replace(LEADING_NOTHING, '').trim());
  if (HAS_RUNNING_TOKEN.test(body)) {
    body = capitalize(body.replace(RUNNING_TOKEN, 'still running'));
    running = true;
  }
  if ((dueAt != null || running) && isNote(body)) body = '';
  // "Nothing new owed tonight; the reminder comes in the morning." before a DUE line is a status
  // note about the timer, not something for the user. Long replies or links stay content.
  if (dueAt != null && isDueStatus(body)) body = '';

  if (dueAt != null) return running ? { outcome: 'due', text: body, dueAt, running: true } : { outcome: 'due', text: body, dueAt };
  if (running) return body ? { outcome: 'deliver_running', text: body } : { outcome: 'running', text: '' };
  return body ? { outcome: 'deliver', text: body } : { outcome: 'nothing', text: '' };
}

/**
 * True for a reply that is tool-call markup returned as text (it must never reach the user): a
 * line starting with "<｜", or "invoke name=", "<tool_call", "<function_calls>" anywhere.
 */
export function isJunkReply(text) {
  const s = String(text ?? '');
  return /^\s*<｜/m.test(s) || /invoke name=/i.test(s) || /<tool_call/i.test(s) || /<function_calls>/i.test(s);
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
