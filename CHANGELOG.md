# Changelog

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
