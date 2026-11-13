// A dropped promise caught, then a long job tracked. No API key, no network: the "model" is
// a tiny fake, and 100 ms stands in for one minute.
//
//   node examples/simulate.mjs
//
// Part 1: the user sends a video link. The agent replies "I'll send the summary when it's done".
// The summary gets written in a background turn whose output never reaches the user. Five
// "minutes" after that reply the check fires, the agent compares its conversation with the
// delivered list, sees the summary is missing, and sends it.
//
// Part 2: the user asks for a long render. The host links the render to the conversation with
// wrapJob(). The check at minute 5 answers STILL_RUNNING and parks on the job: no more model
// wakes while it runs. When the render ends, one report turn tells the user what it produced,
// and the parked check runs once to confirm nothing else is owed.
import { createNothingOwed } from 'nothing-owed';

const CHAT = 'chat-42';
const MINUTE = 100; // ms
const t0 = Date.now();
const log = (who, msg) => console.log(`[min ${String(((Date.now() - t0) / MINUTE).toFixed(1)).padStart(5)}] ${who.padEnd(6)} ${msg}`);
const sleep = (minutes) => new Promise((r) => setTimeout(r, minutes * MINUTE));

// ---- a fake agent with a memory of its own conversation ---------------------------------
const memory = []; // everything the agent wrote, delivered or not
const fakeModel = {
  reply(text) {
    memory.push(text);
    return text;
  },
  check(prompt) {
    const delivered = prompt.split('send log):')[1]?.split('Only what is')[0] ?? '';
    const summary = memory.find((m) => m.startsWith('SUMMARY'));
    if (summary && !delivered.includes('SUMMARY')) return summary; // owed: deliver it now
    if (prompt.includes('render') && !delivered.includes('Render finished')) return 'STILL_RUNNING';
    return 'NOTHING_OWED';
  },
  report(prompt) {
    const output = prompt.split('What it returned:\n')[1]?.split('\n')[0] ?? '';
    return `Render finished: ${output}. Nothing else is open.`;
  },
};

// ---- the host: a send function that logs what really reached the user -------------------
let owed;
async function send(conversationId, text) {
  log('host', `-> user: "${text}"`);
  owed.noteDelivered(conversationId, text); // the host's own send log
  return { ids: [Date.now()] };
}
function agentSays(text) {
  const t = fakeModel.reply(text);
  send(CHAT, t);
  owed.noteReply(CHAT, t);
}
function userSays(text) {
  log('user', `"${text}"`);
  owed.noteUserMessage(CHAT);
}

owed = createNothingOwed({
  delayMs: 5 * MINUTE, // the default is 5 real minutes
  runTurn: async (conversationId, prompt, ctx) => {
    if (ctx.kind === 'report') {
      log('report', 'the job ended; one report turn');
      return fakeModel.report(prompt);
    }
    const back = prompt.match(/\((\d+ messages? back)/);
    log('check', `fires; the agent audits its conversation${back ? ` (its first reply: ${back[1]})` : ''}`);
    return fakeModel.check(prompt);
  },
  deliver: send,
  onEvent: (e) => {
    if (e.type === 'scheduled') log('timer', 'check window opened: fires in 5 min, later replies will not move it');
    if (e.type === 'nothing_owed') log('check', 'NOTHING_OWED: nothing sent');
    if (e.type === 'delivered') log('check', 'owed item delivered');
    if (e.type === 'job_tracked') log('job', `tracked: ${e.title}`);
    if (e.type === 'parked') log('check', `STILL_RUNNING with an open job: parked on ${e.jobIds.join(', ')}, no wakes until it ends`);
    if (e.type === 'job_finished') log('job', `finished: ${e.status}`);
    if (e.type === 'unparked') log('check', 'unparked: runs once now');
  },
});
await owed.start();

// ---- part 1: a dropped promise -----------------------------------------------------------
userSays('Can you summarize this video? https://example.com/v/123');
agentSays("Got it. I'll send the summary when it's done.");
await sleep(1);
fakeModel.reply('SUMMARY: three points: setup, demo, pricing. Verdict: worth a watch.');
log('agent', 'wrote the summary in a background turn... but nothing sent it (dropped)');
await sleep(4.5);
await owed.idle();

// ---- part 2: a tracked long job ----------------------------------------------------------
userSays('Now render the full video, please.');
agentSays('Starting the render. It takes a while; I will report when it is done.');
const render = owed.wrapJob(CHAT, 'render-1', sleep(20).then(() => '4 clips, 2.1 GB'), { title: 'render' });
await render;
await owed.idle();

owed.stop();
log('done', 'one dropped promise caught, one long job reported; 4 model wakes in total');
