// A dropped promise, caught. No API key, no network: the "model" is a tiny fake.
//
//   node examples/simulate.mjs
//
// Story: the user sends a video link. The agent replies "I'll send the summary when it's done"
// and starts background work. The summary gets written in a background turn whose output
// never reaches the user (nothing runs between turns to deliver it). Ten "minutes" later
// (300 ms here) the check fires, the agent compares its conversation with the delivered list,
// sees the summary is missing, and sends it.
import { createNothingOwed } from 'nothing-owed';

const CHAT = 'chat-42';
const t0 = Date.now();
const log = (who, msg) => console.log(`[+${String(Date.now() - t0).padStart(4)} ms] ${who.padEnd(7)} ${msg}`);

// ---- a fake agent with a memory of its own conversation ---------------------------------
const memory = []; // everything the agent wrote, delivered or not
const fakeModel = {
  reply(text) {
    memory.push(text);
    return text;
  },
  // The check turn: the model judges its own conversation against the delivered list.
  check(prompt) {
    const delivered = prompt.split('send log):')[1]?.split('Only what is')[0] ?? '';
    const summary = memory.find((m) => m.startsWith('SUMMARY'));
    if (summary && !delivered.includes('SUMMARY')) return summary; // owed: deliver it now
    return 'NOTHING_OWED';
  },
};

// ---- the host: a send function that logs what really reached the user -------------------
let owed;
async function send(conversationId, text) {
  log('host', `-> user: "${text}"`);
  owed.noteDelivered(conversationId, text); // the host's own send log
}

owed = createNothingOwed({
  delayMs: 300, // stands in for 10 minutes
  runTurn: async (conversationId, prompt) => {
    log('check', `fires for ${conversationId}; the agent audits its conversation`);
    return fakeModel.check(prompt);
  },
  deliver: send,
  onEvent: (e) => {
    if (e.type === 'scheduled') log('timer', `check scheduled for ${e.conversationId} in 300 ms`);
    if (e.type === 'merged') log('timer', `reply merged into the pending check (${e.replies} replies)`);
    if (e.type === 'nothing_owed') log('check', 'NOTHING_OWED: nothing sent');
    if (e.type === 'delivered') log('check', 'owed item delivered');
  },
});
await owed.start();

// ---- the conversation --------------------------------------------------------------------
log('user', '"Can you summarize this video? https://example.com/v/123"');
const first = fakeModel.reply("Got it. I'll send the summary when it's done.");
await send(CHAT, first);
owed.noteReply(CHAT, first);

// Background work finishes and the agent writes the summary in a turn nobody delivers.
await new Promise((r) => setTimeout(r, 100));
fakeModel.reply('SUMMARY: three points: setup, demo, pricing. Verdict: worth a watch.');
log('agent', 'wrote the summary in a background turn... but nothing sent it (dropped)');

// The check fires 300 ms after the last reply.
await new Promise((r) => setTimeout(r, 350));
await owed.idle();

// A second, clean round: everything was delivered, so the check stays silent.
log('user', '"Thanks!"');
const thanks = fakeModel.reply('You are welcome.');
await send(CHAT, thanks);
owed.noteReply(CHAT, thanks);
await new Promise((r) => setTimeout(r, 350));
await owed.idle();

owed.stop();
log('done', 'the dropped promise was caught; the second check sent nothing');
