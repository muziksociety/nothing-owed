import { createNothingOwed, createMemoryStore } from '../src/index.js';

export const MIN = 60 * 1000;
export const DELAY = 10 * MIN;

/**
 * A fake world: a manual clock, a fake model whose answer you set, and a record of what reached
 * the user. No real timers: tests drive the scheduler with world.advance().
 */
export function world({ reply = 'NOTHING_OWED', store = createMemoryStore(), ...opts } = {}) {
  const w = {
    t: 1_700_000_000_000,
    reply,
    turns: [], // { conversationId, prompt }
    sent: [], // { conversationId, text }
    metas: [], // the third deliver() argument, in send order
    events: [],
    timers: [],
    store,
  };
  w.make = (extra = {}) =>
    createNothingOwed({
      delayMs: DELAY,
      store: w.store,
      now: () => w.t,
      setTimer: (fn, ms) => {
        const h = { fn, at: w.t + ms };
        w.timers.push(h);
        return h;
      },
      clearTimer: (h) => {
        w.timers = w.timers.filter((x) => x !== h);
      },
      runTurn: async (conversationId, prompt, ctx) => {
        w.turns.push({ conversationId, prompt, ctx });
        return typeof w.reply === 'function' ? w.reply(conversationId, prompt, ctx) : w.reply;
      },
      deliver: async (conversationId, text, meta) => {
        w.sent.push({ conversationId, text });
        w.metas.push(meta);
      },
      onEvent: (e) => w.events.push(e),
      ...opts,
      ...extra,
    });
  // Move the clock and fire any timer that came due, then let the checks finish. With
  // { wait: false } it does not wait for running turns (for turns that never settle).
  w.advance = async (ms, { wait = true } = {}) => {
    w.t += ms;
    for (;;) {
      const due = w.timers.filter((h) => h.at <= w.t);
      if (!due.length) break;
      w.timers = w.timers.filter((h) => !due.includes(h));
      for (const h of due) h.fn();
      if (wait) await w.no.idle();
      await new Promise((r) => setImmediate(r));
    }
  };
  w.types = () => w.events.map((e) => e.type);
  return w;
}

export async function started(opts) {
  const w = world(opts);
  w.no = w.make();
  await w.no.start();
  return w;
}
