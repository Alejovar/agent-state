import type { Project } from "./project.js";
import { buildRecovery, loadRecovery, saveRecovery, verifyRecovery, type RecoveryState } from "./recovery.js";
import { renderMarkdown, type RenderMode } from "./render.js";
import { TaskService, type Task } from "./tasks.js";
import { unexpectedFiles } from "./scope.js";

export interface CompactResult {
  state: RecoveryState;
  markdown: string;
  paths: { json: string; md: string };
}

/**
 * Compaction: fold a task's events + verified repository state into the
 * minimum state needed to continue, render it within the byte budget, persist it.
 */
export function compactTask(project: Project, task: Task, opts: { status?: boolean; session_id?: string | null; agent_id?: string } = {}): CompactResult {
  const state = buildRecovery(project, task, { unexpected: unexpectedFiles(project, task) });
  const { markdown, truncated } = renderMarkdown(state, { maxBytes: project.config.recovery.max_bytes });
  state.stats.markdown_bytes = Buffer.byteLength(markdown);
  state.stats.truncated = truncated;
  const paths = saveRecovery(project, state, markdown);
  project.emit({
    type: "RECOVERY_GENERATED",
    agent_id: opts.agent_id,
    session_id: opts.session_id ?? null,
    task_id: task.id,
    payload: { path: paths.md, bytes: state.stats.markdown_bytes, events: state.stats.events },
  });
  if (opts.status !== false && task.status === "ACTIVE") {
    new TaskService(project).setStatus(task.id, "COMPACTED", { agent_id: opts.agent_id, session_id: opts.session_id });
    state.task.status = "COMPACTED";
  }
  return { state, markdown, paths };
}

export interface RecoverResult {
  state: RecoveryState;
  markdown: string;
  saved: RecoveryState | null;
}

/**
 * Recovery: rebuild the state from events and the repository *now*, and
 * report where a previously saved recovery state disagrees with reality.
 */
export function recoverTask(project: Project, task: Task, opts: { mode?: RenderMode; maxBytes?: number } = {}): RecoverResult {
  const saved = loadRecovery(project, task.number);
  const state = buildRecovery(project, task, { unexpected: unexpectedFiles(project, task) });
  if (saved) {
    state.conflicts = verifyRecovery(project, saved, state);
    // Carry forward an AI summary only as clearly-labelled, possibly stale context.
    if (saved.ai_summary && !state.ai_summary) state.ai_summary = saved.ai_summary;
  }
  const { markdown, truncated } = renderMarkdown(state, {
    maxBytes: opts.maxBytes ?? project.config.recovery.max_bytes,
    mode: opts.mode ?? "recovery",
  });
  state.stats.markdown_bytes = Buffer.byteLength(markdown);
  state.stats.truncated = truncated;
  return { state, markdown, saved };
}

/** Re-renders and re-saves a recovery state after it was enriched (e.g. with an AI summary). */
export function resave(project: Project, state: RecoveryState): CompactResult {
  const { markdown, truncated } = renderMarkdown(state, { maxBytes: project.config.recovery.max_bytes });
  state.stats.markdown_bytes = Buffer.byteLength(markdown);
  state.stats.truncated = truncated;
  const paths = saveRecovery(project, state, markdown);
  return { state, markdown, paths };
}
