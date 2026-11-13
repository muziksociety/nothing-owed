# Contributing

Thanks for helping. Small, focused pull requests are easiest to review.

## Setup

```sh
git clone <your fork>
cd nothing-owed
npm test                    # node --test, no install needed
node examples/simulate.mjs  # the offline demo
```

There are no runtime dependencies and no build step. Please keep it that way: the package
is plain ESM JavaScript for Node 18 and later, with hand-written types in `index.d.ts`.

## Guidelines

- Add or update a test in `test/` for every behavior change. Tests use a fake clock and a
  fake model; they must not need network access or API keys.
- Keep `index.d.ts` in step with the code.
- Prompt changes (`src/outcome.js`) change behavior for every user. Explain in the pull
  request why the new wording is better, ideally with before/after results.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages
  (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- Never put real conversation text, user names, ids or tokens in tests, examples or issues.
  Use made-up ids like `chat-42`.

## Reporting bugs

Open an issue with the Node version, a minimal reproduction, and the `onEvent` log if you
have one (scrub any message text first). For security issues, see [SECURITY.md](./SECURITY.md).
