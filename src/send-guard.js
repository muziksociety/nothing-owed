// The send guard: a last pass over any text before the host sends it, so a check marker never
// reaches the user. Unlike parseCheckReply (which judges a check turn's answer and may decide that
// nothing is owed), the guard never drops a normal message: it only cuts the markers.
import { NOTHING_OWED, STILL_RUNNING } from './outcome.js';

const DECOR_START = /^[>\s`*_"'“”«»]+/;
const DECOR_END = /[.!\s`*_"'“”«»]+$/g;
const bareWord = (s) => String(s ?? '').trim().replace(DECOR_START, '').replace(DECOR_END, '').toUpperCase();
const isMarker = (line) => { const w = bareWord(line); return w === NOTHING_OWED || w === STILL_RUNNING; };

// Indexes of the first and last non-empty lines.
const edges = (lines) => {
  const ix = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
  return ix.length ? [ix[0], ix[ix.length - 1]] : [-1, -1];
};

/**
 * A DUE line ("DUE 2030-01-01T09:00:00Z", decoration allowed) → its time in epoch ms, else null.
 */
export function dueOf(line) {
  const m = String(line ?? '').trim().replace(DECOR_START, '').replace(DECOR_END, '').match(/^DUE:?\s+(\S+)$/i);
  const at = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(at) ? at : null;
}

/**
 * Cut marker lines (NOTHING_OWED, STILL_RUNNING, decorated or not) from the first two and the last
 * two non-empty lines. → { text, marker } where `marker` says whether one was cut.
 */
export function stripMarkerLines(text) {
  const lines = String(text ?? '').trimEnd().split(/\r?\n/);
  const ix = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
  const edge = new Set([...ix.slice(0, 2), ...ix.slice(-2)]);
  let marker = false;
  const kept = lines.filter((l, i) => {
    if (edge.has(i) && isMarker(l)) { marker = true; return false; }
    return true;
  });
  return { text: kept.join('\n').trim(), marker };
}

const GLUED_END = new RegExp(`[\\s>\`*_"'“”«»]*\\b(${NOTHING_OWED}|${STILL_RUNNING})\\b[.!\\s\`*_"'“”«»]*$`, 'i');
const GLUED_START = new RegExp(`^[\\s>\`*_"'“”«»]*\\b(${NOTHING_OWED}|${STILL_RUNNING})\\b[.:!\\s\`*_"'“”«»]*`, 'i');
const RUNNING_WORD = new RegExp(`\\b${STILL_RUNNING}\\b`, 'gi');
const RUNNING_AT_START = new RegExp(`^([\\s>\`*_"'“”«»\\-]*)${STILL_RUNNING}\\b`, 'i');
// "STILL_RUNNING" at the start of a line reads "Still running", elsewhere "still running".
const runningText = (line) => line.replace(RUNNING_AT_START, '$1Still running').replace(RUNNING_WORD, 'still running');

/**
 * The send guard. Run every text the host sends through it. It cuts:
 * - marker lines on the first two or last two non-empty lines,
 * - a marker word glued to the end of the last line or the start of the first,
 * - a DUE line as the last line.
 * A STILL_RUNNING left in the middle of the text (its own line or inside a sentence) becomes the
 * words "still running", so the user reads plain text, never the marker.
 * A normal message is never dropped. → the text left ('' when nothing is left).
 */
export function cutMarkers(text) {
  const lines = stripMarkerLines(text).text.split(/\r?\n/);
  const [a, z] = edges(lines);
  if (a < 0) return '';
  if (dueOf(lines[z]) != null) lines[z] = '';
  else lines[z] = lines[z].replace(GLUED_END, '');
  lines[a] = lines[a].replace(GLUED_START, '');
  return lines.map(runningText).join('\n').trim();
}
