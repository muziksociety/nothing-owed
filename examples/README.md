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
send, `noteReply` for the agent's normal replies, `noteUserMessage` for each user message, and
throw from `deliver` when the platform did not confirm the send. The package counts and logs its
own deliveries, so logging them again in your send path is harmless. Send what `flushMissed(id)`
returns before your next normal message, and pass `ctx.signal` to your model call so a check that
runs past `turnTimeoutMs` is really stopped.

The check turn resumes the same session as the user's turns: never run both at once (use
`isUserBusy`, `onTurnStart`/`onTurnEnd` and `isChecking`), and make sure `runTurn` only returns
the agent's text. It must not post anything to the chat itself.
