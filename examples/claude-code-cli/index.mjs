// nothing-owed with the Claude Code CLI: the check turn is `claude -p --resume <session id>`.
//
//   node examples/claude-code-cli/index.mjs
//
// Needs the `claude` CLI on PATH and signed in.
import { spawn } from 'node:child_process';
import { createNothingOwed, createFileStore } from 'nothing-owed';

const sessions = new Map(); // conversationId -> CLI session id (persist this in a real host)

// Run one print-mode turn. The prompt goes in on stdin, so long check prompts are fine.
function claude(prompt, sessionId, signal) {
  const args = ['-p', '--output-format', 'json'];
  if (sessionId) args.push('--resume', sessionId);
  return new Promise((resolve, reject) => {
    // signal: aborted by nothing-owed after turnTimeoutMs, which kills the child process
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32', signal });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        const res = JSON.parse(out);
        if (res.is_error) return reject(new Error(res.result || 'claude returned an error'));
        resolve(res);
      } catch {
        reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`));
      }
    });
    child.stdin.end(prompt);
  });
}

// Cost from the result's own token counts. On a resumed session, total_cost_usd may count
// usage from earlier turns too, so for a per-check cost compute it from `usage`.
// Fill in your model's prices (USD per million tokens).
const PRICE = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
const costFromUsage = (u = {}) =>
  ((u.input_tokens || 0) * PRICE.input +
    (u.cache_creation_input_tokens || 0) * PRICE.cacheWrite +
    (u.cache_read_input_tokens || 0) * PRICE.cacheRead +
    (u.output_tokens || 0) * PRICE.output) / 1e6;

async function turn(conversationId, prompt, ctx) {
  const res = await claude(prompt, sessions.get(conversationId), ctx?.signal);
  sessions.set(conversationId, res.session_id);
  return { text: res.result ?? '', usage: res.usage, costUsd: costFromUsage(res.usage) };
}

const owed = createNothingOwed({
  store: createFileStore('./data/pending-checks.json'),
  runTurn: turn,
  // The package counts and logs what it delivers; just send it.
  deliver: async (cid, text) => {
    console.log(`[to user in ${cid}] ${text}`);
  },
  onUsage: ({ conversationId, costUsd }) => console.log(`[check cost] ${conversationId} $${costUsd?.toFixed(4)}`),
});
await owed.start();

const { text } = await turn('chat-42', 'Say hello, and promise to send a fun fact later.');
console.log(`[to user in chat-42] ${text}`);
owed.noteDelivered('chat-42', text);
owed.noteReply('chat-42', text);
console.log('Check scheduled in 5 minutes. Keep this process running to see it fire.');
// Keep the process alive until the check runs (the scheduler's timer is unref'd).
setInterval(() => {}, 60_000);
