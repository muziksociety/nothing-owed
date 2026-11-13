// Built-in delivered log, for hosts that have no send log of their own.
// Record every message that really reached the user (after the transport call succeeded),
// never what the model says it sent. An entry with an `id` can be updated in place, so a
// streamed reply that is sent once and then edited stays one entry.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const clip = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * @param {object} [opts]
 * @param {string} [opts.path]          persist to this JSON file (default: memory only)
 * @param {number} [opts.maxPerConversation=400]
 * @param {number} [opts.maxAgeMs=172800000] drop entries older than this (default 2 days)
 * @param {number} [opts.maxTextLength=2000]
 * @param {() => number} [opts.now]
 */
export function createDeliveredLog({
  path = null,
  maxPerConversation = 400,
  maxAgeMs = 2 * 24 * 60 * 60 * 1000,
  maxTextLength = 2000,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, {id:any, at:number, last:number, text:string}[]>} */
  const byConv = new Map();

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

  const persist = () => {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(byConv)));
    renameSync(tmp, path);
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
      if (entry) {
        entry.text = body;
        entry.last = t;
      } else {
        entry = { id: id ?? null, at: t, last: t, text: body };
        arr.push(entry);
      }
      byConv.set(key, prune(arr));
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
    clear(conversationId) {
      if (conversationId == null) byConv.clear();
      else byConv.delete(String(conversationId));
      persist();
    },
  };
}
