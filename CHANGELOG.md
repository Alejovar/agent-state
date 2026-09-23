# Changelog

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
