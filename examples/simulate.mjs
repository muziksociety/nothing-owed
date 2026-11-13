// A dropped promise caught, then a long job tracked. No API key, no network: the "model" is
// a tiny fake, and the minutes are virtual (the scheduler takes an injected clock), so every run
// prints exactly the same lines and takes a fraction of a second.
//
//   node examples/simulate.mjs
//
// Part 1: the user sends a video link. The agent replies "I'll send the summary when it's done".
// The summary gets written in a background turn whose output never reaches the user. Five
// "minutes" after that reply the check fires, the agent compares its conversation with the
// delivered list, sees the summary is missing, and sends it.
//
// Part 2: the user asks for a long render. The host links the render to the conversation with
// wrapJob(). The check answers STILL_RUNNING; with an open job it checks once more 5 "minutes"
// later, then parks on the job: no more model wakes while it runs. When the render ends, one report turn tells the user what it produced,
// and the parked check runs once to confirm nothing else is owed. Five "minutes" after each
// delivery the package makes, one verify check reads it back in case it held a new promise.
import { createNothingOwed } from 'nothing-owed';

const CHAT = 'chat-42';
const MINUTE = 60 * 1000;

// ---- a virtual clock: the scheduler's timers fire as the script moves time forward --------
let clock = 0;
let timers = [];
const now = () => clock;
const setTimer = (fn, ms) => { const h = { fn, at: clock + ms }; timers.push(h); return h; };
const clearTimer = (h) => { timers = timers.filter((x) => x !== h); };
async function sleep(minutes) {
  const end = clock + minutes * MINUTE;
  for (;;) {
    const next = timers.filter((h) => h.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!next) break;
    clock = Math.max(clock, next.at);
    timers = timers.filter((h) => h !== next);
    next.fn();
    await owed.idle();
    await new Promise((r) => setImmediate(r));
  }
  clock = end;
}
const log = (who, msg) => console.log(`[min ${String((clock / MINUTE).toFixed(1)).padStart(5)}] ${who.padEnd(6)} ${msg}`);

// ---- a fake agent with a memory of its own conversation ---------------------------------
const memory = []; // everything the agent wrote, delivered or not
let wakes = 0;
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
  now, setTimer, clearTimer, // the virtual clock; the defaults are used for everything else (delayMs: 5 min)
  runTurn: async (conversationId, prompt, ctx) => {
    wakes++;
    if (ctx.kind === 'report') {
      log('report', 'the job ended; one report turn');
      return fakeModel.report(prompt);
    }
    const back = prompt.match(/\((\d+ messages? back)/);
    const why = ctx.reason === 'verify' ? 'verify check fires: reads back what it delivered' : 'fires; the agent audits its conversation';
    log('check', `${why}${back ? ` (its first reply: ${back[1]})` : ''}`);
    return fakeModel.check(prompt);
  },
  deliver: send,
  onEvent: (e) => {
    if (e.type === 'scheduled') log('timer', 'check window opened: fires in 5 min, later replies will not move it');
    if (e.type === 'nothing_owed') log('check', 'NOTHING_OWED: nothing sent');
    if (e.type === 'delivered') log('check', 'owed item delivered');
    if (e.type === 'job_tracked') log('job', `tracked: ${e.title}`);
    if (e.type === 'still_running') log('check', 'STILL_RUNNING');
    if (e.type === 'parked') log('check', `an open job: parked on ${e.jobIds.join(', ')}, no wakes until it ends`);
    if (e.type === 'job_finished') log('job', `finished: ${e.status}`);
    if (e.type === 'unparked') log('check', 'unparked: runs once now');
    if (e.type === 'verify_scheduled') log('timer', 'verify check in 5 min on what was just delivered');
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
const render = owed.wrapJob(CHAT, 'render-1', () => sleep(20).then(() => '4 clips, 2.1 GB'), { title: 'render' });
await render;
await owed.idle();
await sleep(5.5); // the verify check on the report
await owed.idle();

await owed.stop();
log('done', `one dropped promise caught, one long job reported; ${wakes} model wakes in total`);
