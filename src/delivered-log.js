// Built-in delivered log, for hosts that have no send log of their own.
// Record every message that really reached the user (after the transport call succeeded),
// never what the model says it sent. An entry with an `id` can be updated in place, so a
// streamed reply that is sent once and then edited stays one entry.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SAME_MS = 60 * 1000;
// File-backed logs write on a short debounce; whatever is pending is written when the process exits.
const pendingLogs = new Set();
let exitHooked = false;
const flushPending = () => { for (const flush of pendingLogs) { try { flush(); } catch { /* best effort */ } } };
const clip = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
let tmpSeq = 0;

/**
 * @param {object} [opts]
 * @param {string} [opts.path]          persist to this JSON file (default: memory only)
 * @param {{ map?: Map<string, any[]>, path?: string, debounceMs?: number }} [opts.backing]
 *   where a store keeps its delivered log: a shared Map (memory store) or a file (file store)
 * @param {number} [opts.debounceMs=100] batch file writes this long (flush() writes at once; 0 writes on every note)
 * @param {number} [opts.maxPerConversation=400]
 * @param {number} [opts.maxAgeMs=172800000] drop entries, and whole idle conversations, older than this (default 2 days)
 * @param {number} [opts.maxTextLength=2000]
 * @param {() => number} [opts.now]
 */
export function createDeliveredLog({
  path: pathOpt = null,
  backing = null,
  debounceMs: debounceOpt,
  maxPerConversation = 400,
  maxAgeMs = 2 * 24 * 60 * 60 * 1000,
  maxTextLength = 2000,
  now = () => Date.now(),
} = {}) {
  const path = pathOpt ?? backing?.path ?? null;
  const debounceMs = debounceOpt ?? backing?.debounceMs ?? 100;
  /** @type {Map<string, {id:any, at:number, last:number, text:string}[]>} */
  const byConv = backing?.map instanceof Map ? backing.map : new Map();
  let timer = null;

  if (path) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      for (const [k, v] of Object.entries(raw || {})) if (Array.isArray(v)) byConv.set(k, v);
    } catch { /* fresh log */ }
  }

  const prune = (arr) => {
    const cut = now() - maxAgeMs;
    const kept = arr.filter((e) => e.last >= cut);
    return kept.length > maxPerConversation ? kept.slice(-maxPerConversation) : kept;
  };

  // Forget conversations whose newest entry is older than maxAgeMs.
  const pruneIdle = () => {
    const cut = now() - maxAgeMs;
    for (const [k, arr] of byConv) if (!arr.length || arr[arr.length - 1].last < cut) byConv.delete(k);
  };

  const writeFile = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    pendingLogs.delete(writeFile);
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(byConv)));
    renameSync(tmp, path);
  };

  const persist = () => {
    if (!path) return;
    if (debounceMs <= 0) return writeFile();
    if (!timer) {
      timer = setTimeout(() => { timer = null; try { writeFile(); } catch { /* the next write retries */ } }, debounceMs);
      timer.unref?.();
      pendingLogs.add(writeFile);
      if (!exitHooked) { exitHooked = true; process.once('exit', flushPending); }
    }
  };

  return {
    /**
     * Record a delivered message. If `id` matches an earlier entry in the same conversation,
     * that entry's text is replaced (an edit) and its first-delivery time is kept.
     * @param {string} conversationId
     * @param {string} text
     * @param {{at?:number, id?:string|number}} [opts]
     */
    note(conversationId, text, { at, id } = {}) {
      const key = String(conversationId);
      const t = at ?? now();
      const arr = byConv.get(key) || [];
      const body = clip(text, maxTextLength);
      let entry = id != null ? arr.findLast((e) => e.id === id) : undefined;
      // The same text noted twice within a minute is one delivery noted by two layers (for
      // example the host's transport log and the scheduler's own record of its deliveries).
      if (!entry) entry = arr.findLast((e) => e.text === body && Math.abs(t - e.last) <= SAME_MS && (id == null || e.id == null));
      if (entry) {
        entry.text = body;
        entry.last = Math.max(entry.last, t);
        if (id != null && entry.id == null) entry.id = id;
      } else {
        entry = { id: id ?? null, at: t, last: t, text: body };
        arr.push(entry);
      }
      byConv.set(key, prune(arr));
      pruneIdle();
      persist();
      return { at: entry.at, text: entry.text };
    },
    /**
     * Messages delivered (or edited) in one conversation at or after `sinceMs`, oldest first.
     * @returns {{at:number,text:string}[]}
     */
    since(conversationId, sinceMs = 0) {
      return (byConv.get(String(conversationId)) || [])
        .filter((e) => e.last >= sinceMs)
        .map((e) => ({ at: e.at, text: e.text }));
    },
    /** The oldest time this log still covers (entries older than that were dropped). */
    horizon() {
      return now() - maxAgeMs;
    },
    clear(conversationId) {
      if (conversationId == null) byConv.clear();
      else byConv.delete(String(conversationId));
      persist();
    },
    /** Write a pending debounced change now. */
    flush() {
      if (timer) writeFile();
    },
  };
}
