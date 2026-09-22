import { Project } from "../core/project.js";
import { parseTaskRef, TaskService, type Task } from "../core/tasks.js";
import { UsageError } from "./types.js";

/** Attribution for events emitted from the CLI: inside an agent shell, attach to its session. */
export function cliAttribution(project: Project): { agent_id: string; session_id: string | null } {
  const cur = project.current();
  const insideClaude = !!process.env.CLAUDECODE;
  const insideCodex = !!process.env.CODEX_SANDBOX || !!process.env.CODEX_HOME;
  if ((insideClaude || insideCodex) && cur.session_id) {
    return { agent_id: insideClaude ? "claude-code" : "codex", session_id: cur.session_id };
  }
  return { agent_id: "cli", session_id: null };
}

/** Resolves an explicit task ref, else the current task, else the latest unfinished task. */
export function resolveTask(project: Project, ref?: string, { required = true } = {}): Task | null {
  const svc = new TaskService(project);
  if (ref) {
    const id = parseTaskRef(ref);
    if (!id) throw new UsageError(`Invalid task reference "${ref}". Use a number like 184 or #184.`);
    const t = svc.get(id);
    if (!t) throw new UsageError(`Task #${ref.replace(/^#|^task_/, "")} does not exist. See \`agent-state task list\`.`);
    return t;
  }
  const t = svc.currentTask() ?? svc.latestUnfinished();
  if (!t && required) {
    throw new UsageError('No active task. Start one with `agent-state task new "<goal>"` (or just start working in Claude Code with hooks installed).');
  }
  return t;
}
