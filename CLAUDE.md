# agent-state: notes for coding agents

TypeScript (ESM, Node ≥ 22.13), zero native deps. The only runtime dependency is `yaml`, plus the optional `@anthropic-ai/sdk`.

- Build: `npm run build`. Test: `npm test` (node:test against real temporary git repos in `test/`).
- Layout: `src/core/` (events, store, tasks, state, recovery, checkpoints, git, redaction, scope, drift), `src/index/` (static analysis), `src/adapters/` (Claude Code, Codex), `src/ai/` (optional providers), `src/commands/` (CLI).
- Every event goes through `EventStore.append`, which redacts secrets. Never write events any other way.
- Recovery items must carry an evidence level (`verified` | `recorded` | `inferred` | `ai`).
- After changing `src/integrations/claude.ts`, run `npm run build:plugin`.
- Architecture: `docs/architecture.md`.
