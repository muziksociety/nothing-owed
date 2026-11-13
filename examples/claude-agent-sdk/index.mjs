// nothing-owed with the Claude Agent SDK: the check turn resumes the conversation's session by id.
//
//   npm i @anthropic-ai/claude-agent-sdk
//   ANTHROPIC_API_KEY=... node examples/claude-agent-sdk/index.mjs
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createNothingOwed, createFileStore } from 'nothing-owed';

const sessions = new Map(); // conversationId -> SDK session id (persist this in a real host)

// One turn in a conversation's session. Returns the final text plus usage for cost tracking.
async function turn(conversationId, prompt, extraOptions = {}) {
  const resume = sessions.get(conversationId);
  let result = null;
  for await (const msg of query({ prompt, options: { ...(resume ? { resume } : {}), ...extraOptions } })) {
    if (msg.type === 'system' && msg.subtype === 'init') sessions.set(conversationId, msg.session_id);
    if (msg.type === 'result') result = msg;
  }
  if (!result || result.subtype !== 'success') throw new Error(`turn failed: ${result?.subtype ?? 'no result'}`);
  sessions.set(conversationId, result.session_id);
  return { text: result.result ?? '', usage: result.usage };
}

const owed = createNothingOwed({
  store: createFileStore('./data/pending-checks.json'),
  // Keep the check turn short: it should judge and deliver, not start new long work.
  // ctx.signal is aborted after turnTimeoutMs; the SDK stops on its abortController.
  runTurn: (cid, prompt, ctx) => {
    const abortController = new AbortController();
    ctx.signal.addEventListener('abort', () => abortController.abort(), { once: true });
    return turn(cid, prompt, { maxTurns: 8, abortController });
  },
  // The package counts and logs what it delivers; just send it.
  deliver: async (cid, text) => {
    console.log(`[to user in ${cid}] ${text}`);
  },
  onUsage: ({ conversationId, usage }) => console.log('[check usage]', conversationId, usage),
});
await owed.start();

// Your normal turn handler.
async function onUserMessage(conversationId, text) {
  const { text: reply } = await turn(conversationId, text);
  console.log(`[to user in ${conversationId}] ${reply}`);
  owed.noteDelivered(conversationId, reply);
  owed.noteReply(conversationId, reply);
  return reply;
}

await onUserMessage('chat-42', 'Summarize https://example.com/v/123 and send it to me when done.');
console.log('Check scheduled in 5 minutes. Keep this process running to see it fire.');
setInterval(() => {}, 60_000); // the scheduler's timer is unref'd
