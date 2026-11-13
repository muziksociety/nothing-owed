# Examples

| Folder / file | Run | Needs |
|---|---|---|
| `simulate.mjs` | `node examples/simulate.mjs` | nothing |
| `telegram-grammy/` | `npm i grammy && BOT_TOKEN=... node examples/telegram-grammy/bot.mjs` | a bot token |
| `claude-agent-sdk/` | `npm i @anthropic-ai/claude-agent-sdk && node examples/claude-agent-sdk/index.mjs` | an API key |
| `claude-code-cli/` | `node examples/claude-code-cli/index.mjs` | the `claude` CLI, signed in |

The examples import `nothing-owed` by name. Inside this repository that resolves to the
package itself (Node package self-reference), so they run from a clone without installing.

The rule all adapters share: call `noteDelivered` only after the transport confirmed the
send, and call `noteReply` for the agent's normal replies (not for check replies).
