/**
 * Normalized, agent-agnostic event model. Adapters (Claude Code, Codex, CLI…)
 * translate their native signals into these events; everything else in
 * agent-state is derived from them.
 */

export const EVENT_TYPES = [
  "SESSION_STARTED",
  "SESSION_ENDED",
  "USER_REQUEST",
  "TOOL_STARTED",
  "TOOL_FINISHED",
  "FILE_CREATED",
  "FILE_MODIFIED",
  "FILE_DELETED",
  "COMMAND_EXECUTED",
  "TEST_STARTED",
  "TEST_FINISHED",
  "DECISION_RECORDED",
  "TASK_CREATED",
  "TASK_UPDATED",
  "TODOS_UPDATED",
  "NOTE_RECORDED",
  "CHECKPOINT_CREATED",
  "CHECKPOINT_RESTORED",
  "RECOVERY_GENERATED",
  "CONTEXT_PRESSURE",
  "CONTEXT_COMPACTED",
  "SCOPE_VIOLATION",
  "SUBAGENT_STARTED",
  "SUBAGENT_FINISHED",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface AgentEvent<P = Record<string, unknown>> {
  /** Schema version of the event envelope. */
  v: 1;
  id: string;
  /** ISO-8601 timestamp. */
  ts: string;
  type: EventType;
  /** Which agent produced the event: "claude-code", "codex", "cli", … */
  agent_id: string;
  session_id: string | null;
  task_id: string | null;
  parent_task_id?: string | null;
  payload: P;
}

export type TaskStatus = "NEW" | "ACTIVE" | "COMPACTED" | "PAUSED" | "RECOVERED" | "COMPLETED" | "ABANDONED";

export type NoteKind =
  | "issue" // a known problem
  | "resolved" // resolves an issue (payload.ref = issue text or id)
  | "failed_attempt" // an approach that did not work
  | "next" // explicit recommended next action
  | "done" // a completed item recorded manually
  | "pending" // a pending item recorded manually
  | "blocked" // a blocked item
  | "context"; // relevant context worth preserving

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
}

// ---- Payload shapes (documentation + light typing for producers) ----

export interface TaskCreatedPayload {
  number: number;
  goal: string;
  base_head: string | null;
  base_branch: string | null;
  parent_task_id?: string | null;
  /** Files already changed when the task started (path → content hash, null = deleted). */
  base_dirty?: Record<string, string | null>;
}

export interface TaskUpdatedPayload {
  status?: TaskStatus;
  goal?: string;
  reason?: string;
}

export interface SessionStartedPayload {
  native_session_id?: string;
  source?: string; // startup | resume | compact | clear | cli
  cwd?: string;
  transcript_path?: string;
  model?: string;
  head?: string | null;
  branch?: string | null;
}

export interface FileEventPayload {
  path: string;
  tool?: string;
}

export interface CommandPayload {
  command: string;
  exit_code?: number | null;
  ok?: boolean | null;
  output_tail?: string;
  duration_ms?: number;
  description?: string;
}

export interface TestFinishedPayload extends CommandPayload {
  runner: string;
  passed?: number | null;
  failed?: number | null;
  skipped?: number | null;
  /** How the outcome was determined. */
  evidence: "exit_code" | "output_parse" | "reported";
}

export interface DecisionPayload {
  number: number;
  decision: string;
  reason?: string;
  alternatives?: string[];
  files?: string[];
}

export interface NotePayload {
  kind: NoteKind;
  text: string;
  files?: string[];
  ref?: string;
}
