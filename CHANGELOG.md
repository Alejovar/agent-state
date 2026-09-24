# Changelog

## 0.6.3

- **Review brief:** files whose names contain spaces or non-ASCII characters (`mi archivo.ts`, `ñandú.ts`) are analyzed correctly. Git quotes such paths and appends a tab after names with spaces, so they were missed or counted as entirely new. Code lines that start with `++` or `--` are no longer mistaken for diff headers.

## 0.6.2

- **Security: more secret formats are redacted before anything is written:** `curl -u user:password`, tokens used as the whole userinfo of a URL (`https://<token>@github.com/…`), `docker|podman|helm … login -p/--password`, `sshpass -p`, `az login … -p`, `redis-cli -a`, sensitive fields in JSON (`"password": "…"`) and hyphenated header names (`x-api-key`). Everyday flags like `mkdir -p`, `docker run -p 8080:80` and `ssh -p 2222` are left alone.
- **Restore:** a path that changed between file and directory no longer aborts the restore halfway (deletions now happen before writes, and the index is restored as it should be). Verified with exec bits, symlinks, staged files and ignored files.
- **Restore backups are never overwritten:** two restores within the same second used the same backup name and the second replaced the first. Backup names are now unique.

## 0.6.1

Fixes from a full code review and a live end-to-end test with Claude Code.

- **Agents were told a command that might not exist.** Instructions handed to the agent (record decisions, recover, switch task) always said `agent-state …`; without a global install that command doesn't exist, so recording decisions failed and the agent burned turns retrying. They now use the command that works on this machine. Verified live: Claude recorded a decision with only the permission agent-state installs.
- Sessions that started before their task existed are attributed to it consistently in every view (`task show`, `task list`, recovery), and their end is seen even when the end event carried no task.
- `agent-state rebuild` repairs a corrupted `state.db` too; parallel hooks can no longer repair it twice at once.
- Unsupported Node.js: hooks still answer with the JSON Cursor and Gemini expect; Node 23.0–23.3 (no `node:sqlite`) is detected correctly.
- Prompts in languages written without spaces (Chinese, Japanese, Korean, Thai) create tasks again.
- `task switch` counts as activity, so the task isn't treated as stale; short gaps are reported in hours.
- A broken `config.yaml` is logged once an hour instead of on every hook; the hook error log is capped and rotated.
- `drift` counts code imports as evidence (e.g. `node:sqlite`), not only declared dependencies.
- The current task is resolved once per hook; Codex uses an indexed lookup. Hooks stay flat as history grows (~71 ms empty vs ~74 ms with 50,000 events on the same machine).

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
