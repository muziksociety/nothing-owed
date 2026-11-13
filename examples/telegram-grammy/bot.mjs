// A minimal grammY bot wired to nothing-owed.
//
//   npm i grammy
//   BOT_TOKEN=... node examples/telegram-grammy/bot.mjs
//
// Replace askAgent() with your agent. It must be able to resume a conversation by id, so the
// check turn runs in the same context the promise was made in.
import { Bot } from 'grammy';
import { createNothingOwed, createFileStore } from 'nothing-owed';
import { deliveredTransformer, conversationIdOf } from './delivered-transformer.mjs';

const bot = new Bot(process.env.BOT_TOKEN);

// One queue per conversation, used by user turns AND check turns: two turns never run on the
// same session at once.
const queues = new Map();
function inQueue(conversationId, fn) {
  const next = (queues.get(conversationId) ?? Promise.resolve()).then(fn, fn);
  queues.set(conversationId, next.catch(() => {}));
  return next;
}
const busy = new Set(); // conversations with a user turn in progress

// Your agent goes here: (conversationId, text, { signal }) -> reply text. It only returns text;
// sending is done below (user turns) or by nothing-owed (check turns).
async function askAgent(conversationId, text, { signal } = {}) {
  return `echo: ${text}`;
}

const owed = createNothingOwed({
  store: createFileStore('./data/pending-checks.json'), // the delivered log lives next to it
  runTurn: (cid, prompt, ctx) => inQueue(cid, () => askAgent(cid, prompt, { signal: ctx.signal })),
  deliver: async (cid, text) => {
    const [chatId, threadId] = cid.split(':');
    await bot.api.sendMessage(chatId, text, threadId ? { message_thread_id: Number(threadId) } : {});
  },
  isUserBusy: (cid) => busy.has(cid),
  timeZone: 'UTC', // or (cid) => the user's IANA zone
  onEvent: (e) => console.log('[nothing-owed]', e.type, e.conversationId ?? ''),
});

// Every successful Bot API send lands in the delivered log.
bot.api.config.use(deliveredTransformer(owed));

bot.on('message:text', async (ctx) => {
  const cid = conversationIdOf(ctx.chat.id, ctx.msg.is_topic_message ? ctx.msg.message_thread_id : undefined);
  owed.noteUserMessage(cid);
  busy.add(cid);
  try {
    const reply = await inQueue(cid, () => askAgent(cid, ctx.msg.text));
    for (const line of owed.flushMissed(cid)) await ctx.reply(line); // owed "Missed:" notices first
    await ctx.reply(reply);
    owed.noteReply(cid, reply); // the timer starts here
  } finally {
    busy.delete(cid);
  }
});

await owed.start();
bot.start(); // long polling keeps the process alive; the scheduler's own timers are unref'd
