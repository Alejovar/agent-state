import type { AgentAdapter } from "./adapter.js";
import { genericFraming } from "./adapter.js";
import type { Project } from "../core/project.js";
import { AgentSession } from "./session-core.js";

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
  const native = n["thread-id"] ?? "session";
  const s = new AgentSession(project, "codex", "cx", native);
  const known = project.db().query({ session_id: s.session_id, types: ["SESSION_STARTED"], limit: 1 }).length > 0;
  if (!known) s.attach("notify", { native_session_id: native, ...(n.cwd ? { cwd: n.cwd } : {}) });
  for (const text of (n["input-messages"] ?? []).filter((m) => typeof m === "string" && m.trim())) {
    s.prompt(text, { native_session_id: native });
  }
  const last = n["last-assistant-message"];
  if (last) {
    const task = s.task();
    project.emit({
      type: "TOOL_FINISHED",
      agent_id: "codex",
      session_id: s.session_id,
      task_id: task?.id ?? null,
      payload: { tool: "turn", turn_id: n["turn-id"] ?? null, summary: last.slice(0, 600) },
    });
  }
}
