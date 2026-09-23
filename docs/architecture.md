# Architecture

agent-state is a local, event-sourced state layer that sits next to an AI coding agent. It observes, records, verifies and restores. It never drives the agent.

```text
Agent (Claude Code, Cursor, Gemini CLI, Codex, …)
   │ native signals (hooks, notify)
   ▼
Adapter  ──────────────►  normalized events  ──►  .agent-state/events/*.jsonl   (append-only, source of truth)
                                                      │ lazy, incremental
                                                      ▼
                                                 state.db (SQLite projection, rebuildable)
                                                      │
          git + filesystem ───────────────────────►  reducers ──► WorkingState ──► RecoveryState ──► Markdown / JSON
```

## Principles, and where they live in code

| Principle | Mechanism |
|---|---|
| Local-first | Everything lives in `.agent-state/`. No network code runs unless `ai.provider` is set (`src/ai/`) |
| Deterministic first | Git (`core/git.ts`), manifests (`core/deps.ts`), test output parsing (`core/testdetect.ts`), static import analysis (`index/`). AI only adds labelled text (`ai/`) |
| Agent-agnostic | The core only knows `AgentEvent`. Adapters live in `src/adapters/` |
| Repository is the source of truth | `verifyRecovery()` compares saved state with git and the filesystem. Conflicts are rendered first and never dropped |
| Never destroy work | Checkpoints use a temporary index. Restore takes an automatic backup checkpoint and never moves HEAD |
| No context bloat | Recovery is rendered within `recovery.max_bytes`, trimming low-priority sections first |

## Data model

| Entity | Stable ID | Notes |
|---|---|---|
| Project | directory containing `.agent-state/` | one per worktree |
| Task | `task_<n>` (shown as `#n`) | independent of sessions; holds the goal, status, base commit/branch and pre-existing dirty files |
| Session | `cc_<id>` (Claude Code), `cu_<conversation>` (Cursor), `gm_<id>` (Gemini CLI), `cx_<thread>` (Codex) | shown as `#<task>-A`, `-B`… in start order |
| Agent | `agent_id` on every event (`claude-code`, `claude-code:<subagent type>`, `cursor`, `gemini-cli`, `codex`, `cli`) | |
| Event | `evt_<time><seq><rand>` | time-sortable and monotonic within a process |
| Decision | `number` (project-wide sequence) | `DECISION_RECORDED` + `decisions/decision-NNNN.md` |
| Checkpoint | name | `refs/agent-state/checkpoints/<name>` + `checkpoints/<name>.json` |
| RecoveryState | per task | `recovery/task-<n>.json` / `.md` (+ `.prev.json`) |
| Policy | per task, falling back to config | `tasks/task-<n>.yaml` |
| TestResult | latest `TEST_FINISHED` per command | |

### Task vs session lifecycle

A task moves through `NEW → ACTIVE → COMPACTED → PAUSED → RECOVERED → ACTIVE → … → COMPLETED | ABANDONED`. Sessions only start and end. Ending a session pauses its task but never completes it. A new session joins the latest unfinished task, and the first user prompt with no active task creates one.

```text
Task #184
 ├── Session #184-A  (claude-code)   ACTIVE → COMPACTED (PreCompact) → RECOVERED (SessionStart:compact) → ACTIVE
 ├── Session #184-B  (claude-code)   PAUSED (SessionEnd) → RECOVERED (SessionStart)
 └── Session #184-C  (codex)
```

## Event schema (v1)

```json
{
  "v": 1,
  "id": "evt_1k9x3m2p4000a8f3kq",
  "ts": "2026-09-22T22:52:32.118Z",
  "type": "FILE_MODIFIED",
  "agent_id": "claude-code",
  "session_id": "cc_5f1c…",
  "task_id": "task_184",
  "parent_task_id": null,
  "payload": { "path": "src/auth/session.ts", "tool": "Edit" }
}
```

Types: `SESSION_STARTED`, `SESSION_ENDED`, `USER_REQUEST`, `TOOL_STARTED`, `TOOL_FINISHED`, `FILE_CREATED`, `FILE_MODIFIED`, `FILE_DELETED`, `COMMAND_EXECUTED`, `TEST_STARTED`, `TEST_FINISHED`, `DECISION_RECORDED`, `TASK_CREATED`, `TASK_UPDATED`, `TODOS_UPDATED`, `NOTE_RECORDED`, `CHECKPOINT_CREATED`, `CHECKPOINT_RESTORED`, `RECOVERY_GENERATED`, `CONTEXT_PRESSURE`, `CONTEXT_COMPACTED`, `SCOPE_VIOLATION`, `SUBAGENT_STARTED`, `SUBAGENT_FINISHED`. Payload shapes are defined in `src/core/events.ts`.

Events are immutable. Every derived view (tasks, sessions, working state, history) is a pure reduction over them. `agent-state rebuild` recreates `state.db` from the log.

## Storage

```text
.agent-state/
├── config.yaml          user configuration
├── current.json         pointer: current task/session/agent (rebuildable)
├── state.db             SQLite projection (events + project index)
├── events/<session>.jsonl   append-only log, one file per session (+ _project.jsonl)
├── sessions/<session>.json  per-session scratch (pending tool calls, pressure level)
├── checkpoints/<name>.json  checkpoint metadata (+ <name>.recovery.json)
├── decisions/decision-NNNN.md
├── tasks/task-<n>.yaml  task contracts (intent ledger)
├── recovery/task-<n>.{md,json}
├── index/               reserved
└── reports/             drift.json, handoffs, hook-errors.log
```

* Hooks **only append** a single line per event (`O_APPEND`, one `write()`), so parallel tool calls cannot interleave. They never open SQLite.
* The projection ingests new bytes lazily by byte offset and tolerates partial trailing lines and corrupt lines.
* Read-modify-write operations (task numbering, per-session scratch) use a small lock-file mutex.
* SQLite comes from Node's built-in `node:sqlite`, so there are no native dependencies.

## Recovery state schema (`agent-state/recovery@1`)

Main fields: `task`, `sessions`, `repository` (branch, head, base_head, commits_since_base), `objective`, `in_progress`, `pending`, `blocked`, `completed`, `issues`, `failing_commands`, `failed_attempts`, `decisions`, `files` (kind, role, exists, staged, evidence), `hot_files`, `tests` (ok, counts, `changed_since`), `dependencies` (added/removed/changed per manifest), `unexpected_files`, `recent_requests`, `context`, `next_action`, `unknowns`, `conflicts`, `ai_summary?`, `snapshot` (content hashes of changed files) and `stats`.

Every list item carries `evidence: verified | recorded | inferred | ai`.

## Compaction algorithm

1. **Gather** the task's events from the projection.
2. **Reduce** them to a `WorkingState`: the latest todo snapshot, manual notes (where a later `done` supersedes a `pending`), unresolved issues, failed attempts, decisions, the latest result per command/test (a command stops "failing" once it passes), file-touch counts and requests.
3. **Verify against the repository.** Take changes since the task's `base_head` from git: staged, unstaged, untracked and committed. Files that were already dirty when the task started and are unchanged since are excluded. Existence is checked, roles are classified, dependency manifests are diffed and tests are checked for staleness by comparing the mtimes of changed files with the test timestamp.
4. **Derive the next action** in this order: explicit `note next` → in-progress item → open issue → failing test → first pending item → "unknown".
5. **Render** sections in priority order: conflicts > next action > in progress > pending/blocked > issues > decisions > scope > files > tests > failed attempts > deps > hot files > context > completed > commits > requests > AI > unknowns. While the output exceeds `max_bytes`, the lowest-priority section that is still above its minimum is halved, or decremented once it is small. Conflicts, the objective and the next action are never dropped.
6. **Persist** the JSON (full) and the Markdown (budgeted), and keep the previous JSON for comparison.

Recovery repeats steps 1–5 against the repository *now*, then diffs against the saved JSON: branch changed, HEAD moved (new commits are listed), referenced files missing or changed, recorded dependencies gone, task completed.

## Adapters

`adapters/session-core.ts` (`AgentSession`) holds all agent-neutral behavior: session/task attribution, prompts, file and command tracking, test detection, todo snapshots, scope gates, compaction, pending re-injection and context pressure. Each adapter only maps native payloads onto it and neutral results back to native output:

| Adapter | Native surface | Re-injection after compaction |
|---|---|---|
| `claude-hooks.ts` | Claude Code hooks (`.claude/settings*.json`) | `SessionStart` with `source=compact` |
| `cursor.ts` | Cursor hooks (`.cursor/hooks.json`, v1) | next `postToolUse` → `additional_context` |
| `gemini.ts` | Gemini CLI hooks (`.gemini/settings.json`) | next `BeforeAgent`/`AfterTool` → `additionalContext` |
| `codex.ts` | Codex `notify` | n/a (turn notifications only) |

## Claude Code integration boundary

Only documented hook events and fields are used. The token estimate for context pressure reads usage figures from the transcript's tail. That format is not a public contract, so it lives in `adapters/claude-code.ts` and returns `null` ("unknown") on any parse problem. Commands with no completion signal (denied, killed, or running on a version without `PostToolUseFailure`) are recorded at `Stop` with `ok: null`, never guessed.

## Security & redaction

`Redactor` runs on every string of every payload before it is written. It covers provider API keys, cloud keys, tokens, JWTs, bearer/basic credentials, private-key blocks (including truncated ones), credentials in URLs, sensitive `KEY=value` assignments and password flags, plus user patterns from `config.yaml`. Keys named like `password`/`token`/`secret` are masked outright. File contents are never recorded. AI calls send redacted, repository-derived digests and announce what is sent and where on stderr.

## Static analysis

`index/parsers.ts` strips comments and extracts imports, symbols and routes for TS/JS (plus Vue/Svelte scripts), Python, Go, Rust, Ruby, Java/Kotlin, PHP and C/C++. `index/resolve.ts` resolves relative imports, extensionless and `.js→.ts` specifiers, `tsconfig` `paths`/`baseUrl`, Python packages (including `src/` layouts), Go module paths and Rust `mod`/`crate::` paths. The index is incremental: size+mtime first, then a content hash, so only changed files are parsed. Edges are recomputed from stored imports, which is cheap and needs no file IO.
