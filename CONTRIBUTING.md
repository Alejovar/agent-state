# Contributing to agent-state

Thanks for helping! agent-state aims to stay **small, deterministic and local-first**. Please keep that in mind when proposing features.

## Setup

```bash
git clone https://github.com/Alejovar/agent-state && cd agent-state
npm install
npm test            # compiles src + test, runs node:test against real temporary git repos
npm run build       # dist/
node dist/cli.js --help
```

Requires Node ≥ 22.13 and git.

## Ground rules

- **Deterministic first.** If git, the filesystem, a manifest or a parser can answer the question, don't use an LLM.
- **Never present guesses as facts.** New recovery data needs an `evidence` level.
- **Never destroy user work.** Anything that writes to the working tree needs a dry-run, a confirmation and a backup.
- **No secrets on disk.** New event payloads go through `Redactor` automatically. Don't bypass `EventStore.append`.
- **No fake commands.** A command either works or says clearly that it isn't supported.
- Runtime dependencies are kept to a minimum (currently only `yaml`). Discuss before adding one.

## Good first contributions

- **New agent adapters** (`src/adapters/`): Cursor, Aider, Gemini CLI, Continue… Implement `AgentAdapter` and translate native signals into normalized events.
- **Language support** in `src/index/parsers.ts` / `resolve.ts` (C#, Swift, Elixir imports, …).
- **Drift rules** in `src/core/drift.ts`.
- **Test-runner output parsers** in `src/core/testdetect.ts`.

## Pull requests

- Add or extend tests. Fixtures are real git repositories, built with `makeRepo()` in `test/helpers.ts`.
- `npm test` must pass.
- Keep CLI output concise. agent-state must never become a source of context bloat.
- If you change `src/integrations/claude.ts`, run `npm run build:plugin` to regenerate `plugins/agent-state`.
