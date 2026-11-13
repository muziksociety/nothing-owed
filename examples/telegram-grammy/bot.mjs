// A minimal grammY bot wired to nothing-owed.
//
//   npm i grammy
//   BOT_TOKEN=... node examples/telegram-grammy/bot.mjs
//
// Replace askAgent() with your agent. It must be able to resume a conversation by id, so the
// check turn runs in the same context the promise was made in.
import { Bot } from 'grammy';
import { createNothingOwed, createFileStore, createDeliveredLog } from 'nothing-owed';
import { deliveredTransformer, conversationIdOf } from './delivered-transformer.mjs';

const bot = new Bot(process.env.BOT_TOKEN);
const busy = new Set(); // conversations with a user turn in flight

// Your agent goes here: (conversationId, text) -> reply text.
async function askAgent(conversationId, text) {
  return `echo: ${text}`;
}

const owed = createNothingOwed({
  store: createFileStore('./data/pending-checks.json'),
  deliveredLog: createDeliveredLog({ path: './data/delivered.json' }),
  runTurn: (cid, prompt) => askAgent(cid, prompt), // pass ctx.signal on to your agent if it can stop
  deliver: async (cid, text) => {
    const [chatId, threadId] = cid.split(':');
    await bot.api.sendMessage(chatId, text, threadId ? { message_thread_id: Number(threadId) } : {});
  },
  isUserBusy: (cid) => busy.has(cid),
  onEvent: (e) => console.log('[nothing-owed]', e.type, e.conversationId ?? ''),
});

// Every successful Bot API send lands in the delivered log.
bot.api.config.use(deliveredTransformer(owed));

bot.on('message:text', async (ctx) => {
  const cid = conversationIdOf(ctx.chat.id, ctx.msg.is_topic_message ? ctx.msg.message_thread_id : undefined);
  busy.add(cid);
  try {
    const reply = await askAgent(cid, ctx.msg.text);
    for (const line of owed.flushMissed(cid)) await ctx.reply(line); // owed "Missed:" notices first
    await ctx.reply(reply);
    owed.noteReply(cid, reply); // the timer starts here
  } finally {
    busy.delete(cid);
  }
});

await owed.start();
bot.start();
