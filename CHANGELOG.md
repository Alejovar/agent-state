# Changelog

## 0.6.0

Fixes and hardening; no new commands.

- **Faster on long histories:** hooks read only the current task's events (indexed) and check context pressure on prompts and turn ends, not on every tool call. With 50,000 recorded events a hook takes ~65 ms (was ~95 ms; ~55 ms on an empty project).
- **Self-healing:** a corrupted `state.db` is set aside and rebuilt from the event log automatically (only on real corruption; a busy database is never touched). A malformed `config.yaml` pauses recording, because privacy and redaction settings can't be honored, and says so in the agent's session, `status` and `doctor`, without ever breaking the agent. An unsupported Node.js version gets a clear message.
- **Better task boundaries:** small talk ("hola", "ok gracias", "continue") no longer creates a task named after it; a fresh session after more than `recovery.resume_window_hours` (72 h) without any activity on the task (prompts, edits, commands) starts a new task instead of silently joining the stale one, and mentions it so you can `task switch` back.
- **doctor** detects hooks installed by an older version (e.g. missing `StopFailure`), invalid agent settings JSON and a broken `config.yaml`; re-running `agent-state init` updates old hooks.
- Codex notifications now go through the same session core as the other adapters.

## 0.5.0

Polish of everything that exists; no new concepts.

- **Windows support**, now tested in CI next to Linux and macOS. Fixes a bug where edited files were not recorded on Windows: paths are canonicalized (8.3 short names like `RUNNER~1`, symlinks) before being compared.
- **`agent-state init` detects your agents** (Claude Code, Cursor, Gemini CLI, Codex) and hooks into each one, then explains what happens next. `--no-hooks` only creates `.agent-state/`.
- **`agent-state uninstall`** removes every hook, slash command and permission agent-state installed and keeps your own; `--purge` also deletes the recorded memory.
- **Bare `agent-state`** shows the project status (or how to get started outside a project).
- **`doctor`** detects hooks pointing at a script that no longer exists, a duplicate plugin + project install, and recent hook errors; exits 1 when something needs fixing.
- README: a clear "What it does" up front and a one-command quickstart.

## 0.4.0

- **Usage-limit handoff:** when Claude Code stops on its usage limit (`StopFailure` / `rate_limit`), the task is saved immediately and a desktop notification points to `agent-state continue`, which opens Codex or Gemini CLI (whichever is installed) with the full context and a takeover note. `status` shows active limits. A limit counts as over once the agent works again.
- **Review brief:** `agent-state review` (`/brief`) summarizes what was asked, what changed (+/− lines, dependents, test coverage), why (decisions, dropped approaches), how it was verified (fresh or stale test runs) and what to look at closely: skipped or focused tests, deleted tests, silenced type checkers and linters, swallowed errors, hardcoded credentials, new dependencies, infra/CI/config changes, scope violations, untested or widely used code. Includes a suggested review order; `--out` writes PR-ready Markdown.

## 0.3.0

- **Just-in-time reminders:** right before the agent edits a file, it receives the decisions, failed approaches and open issues linked to that file (explicit `--file` links or mentions of its name); before rerunning a command that failed, it gets the reason. Delivered once per context, never blocking. Claude Code gets them before the edit (`PreToolUse` additional context); Cursor and Gemini CLI with the tool result.
- **Fresh start before context rot:** at `context.fresh_at` (60% by default) the task state is saved and the user is told to `/clear`; the clean context receives just that state. New `/fresh` slash command.
- The agent is told once per session how to record decisions and failed approaches; `init --claude` allows exactly `agent-state decide` and `agent-state note` without a permission prompt.
- Config: `reminders.enabled`, `context.fresh_at` (replaces `warn_at`, which is still honored), `recovery.agent_guidance`.

## 0.2.0

- **Cursor adapter** (`agent-state init --cursor`): sessionStart, beforeSubmitPrompt, pre/postToolUse (+Failure), afterFileEdit, preCompact with exact context usage, subagents, stop, sessionEnd. Recovery is re-injected after compaction through the next tool result. Scope policies map to allow/deny.
- **Gemini CLI adapter** (`agent-state init --gemini`): SessionStart, BeforeAgent, Before/AfterTool (`write_file`, `replace`, `run_shell_command`, `write_todos`), PreCompress, AfterAgent, SessionEnd.
- Shared agent-neutral session core (`AgentSession`); the Claude Code adapter now uses it too.
- `integrate cursor|gemini [--uninstall]`, `doctor` detects every integration.
- Fix: reinstalling/uninstalling hooks installed through an absolute `node …/cli.js` path no longer duplicates or leaves them behind.
- Fix: AI `command` providers that ignore stdin no longer crash with EPIPE.
- Install straight from GitHub (`prepare` builds the CLI).

## 0.1.0

First release.

- **Context recovery:** normalized event store (append-only JSONL + rebuildable SQLite), tasks spanning sessions, `compact`, `recover`, `continue`, `handoff`, evidence levels, conflict detection against git/filesystem, byte-budgeted rendering.
- **Claude Code integration:** hooks (`SessionStart`, `UserPromptSubmit`, `Pre/PostToolUse`, `PostToolUseFailure`, `PreCompact`, `Subagent*`, `Stop`, `SessionEnd`), automatic re-injection after compaction, context-pressure detection, slash commands, plugin marketplace.
- **Checkpoints:** snapshots of the working tree, index and untracked files stored as private git objects; safe restore with dry-run, conflict report and automatic backup.
- **Project intelligence:** incremental index (imports, symbols, routes) for TS/JS, Python, Go, Rust, Ruby, JVM, PHP, C/C++; `impact`, `changes` with indirect effects, `index <query>` concept search, project overview.
- **Ledgers:** decisions, notes, `why <file>`, `history` search, `replay`, `sessions`, `worktrees`.
- **Agent control:** task contracts with allowed/restricted globs and `warn`/`confirm`/`block` policies enforced on edits.
- **Context drift:** dead paths, missing scripts/targets, package-manager mismatch, unsupported technology claims; optional AI semantic comparison.
- **AI (optional):** `anthropic`, `openai-compatible` (e.g. Ollama) and `command` providers; malformed/failed output never breaks deterministic features.
- **Security:** secret redaction before persistence, custom patterns, no telemetry.
- **Codex CLI** adapter via `notify`; generic `agent-state event` adapter.
