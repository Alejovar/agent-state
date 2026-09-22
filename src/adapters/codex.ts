import type { AgentAdapter } from "./adapter.js";
import { genericFraming } from "./adapter.js";
import type { Project } from "../core/project.js";
import { TaskService } from "../core/tasks.js";

/**
 * OpenAI Codex CLI adapter.
 *
 * Codex exposes a documented `notify` hook: it runs a configured program with
 * a JSON payload (type "agent-turn-complete") as the last argument. That only
 * covers turn boundaries (user input + last assistant message), so Codex
 * sessions record requests and turns; file changes come from git. Configure:
 *
 *   # ~/.codex/config.toml
 *   notify = ["agent-state", "hook", "codex"]
 */
export const codex: AgentAdapter = {
  id: "codex",
  displayName: "Codex CLI",
  formatContext: genericFraming,
  launchCommand(context: string) {
    return { cmd: "codex", args: [context] };
  },
};

export interface CodexNotification {
  type?: string;
  "turn-id"?: string;
  "thread-id"?: string;
  "input-messages"?: string[];
  "last-assistant-message"?: string;
  cwd?: string;
}

export function handleCodexNotification(project: Project, n: CodexNotification): void {
  if (!n || n.type !== "agent-turn-complete") return;
  const svc = new TaskService(project);
  const native = n["thread-id"] ?? "session";
  const session_id = `cx_${native.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)}`;
  const inputs = (n["input-messages"] ?? []).filter((m) => typeof m === "string" && m.trim());
  let task = svc.currentTask() ?? svc.latestUnfinished();
  const known = svc.load().sessions.has(session_id);
  if (!task && inputs[0]) task = svc.create(inputs[0].split("\n")[0]!.slice(0, 160), { agent_id: "codex", session_id });
  if (!known) {
    project.emit({ type: "SESSION_STARTED", agent_id: "codex", session_id, task_id: task?.id ?? null, payload: { native_session_id: native, source: "notify", cwd: n.cwd } });
  }
  if (project.config.privacy.record_prompts) {
    for (const text of inputs) project.emit({ type: "USER_REQUEST", agent_id: "codex", session_id, task_id: task?.id ?? null, payload: { text: text.slice(0, 4000) } });
  }
  const last = n["last-assistant-message"];
  if (last) {
    project.emit({
      type: "TOOL_FINISHED",
      agent_id: "codex",
      session_id,
      task_id: task?.id ?? null,
      payload: { tool: "turn", turn_id: n["turn-id"] ?? null, summary: last.slice(0, 600) },
    });
  }
  project.setCurrent({ session_id, agent_id: "codex", ...(task ? { task_id: task.id } : {}) });
}
