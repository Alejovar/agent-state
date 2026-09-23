import type { Project } from "../core/project.js";
import type { AgentAdapter } from "./adapter.js";
import { genericFraming } from "./adapter.js";
import { AgentSession, type ScopeGate } from "./session-core.js";
import type { HookResult } from "./claude-hooks.js";

/**
 * Cursor adapter (agent hooks, `.cursor/hooks.json`, version 1).
 *
 * Documented events used: sessionStart, sessionEnd, beforeSubmitPrompt,
 * preToolUse, postToolUse, postToolUseFailure, afterFileEdit, preCompact,
 * subagentStart, subagentStop, stop. Cursor has no session start after
 * compaction, so the recovery state saved at preCompact is re-injected through
 * the next postToolUse `additional_context`.
 */
export const cursor: AgentAdapter = {
  id: "cursor",
  displayName: "Cursor",
  formatContext: genericFraming,
};

export interface CursorHookInput {
  hook_event_name: string;
  conversation_id?: string;
  session_id?: string;
  generation_id?: string;
  workspace_roots?: string[];
  transcript_path?: string | null;
  model?: string;
  // tools
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: unknown;
  tool_use_id?: string;
  cwd?: string;
  duration?: number;
  error_message?: string;
  failure_type?: string;
  is_interrupt?: boolean;
  // prompt / files
  prompt?: string;
  file_path?: string;
  // lifecycle
  reason?: string;
  status?: string;
  trigger?: string;
  context_usage_percent?: number;
  context_tokens?: number;
  context_window_size?: number;
  // subagents
  subagent_id?: string;
  subagent_type?: string;
  task?: string;
  is_background_agent?: boolean;
  composer_mode?: string;
}

const FILE_TOOLS = new Set(["Write", "Delete", "Edit", "StrReplace", "MultiEdit"]);
const out = (v: unknown): HookResult => ({ exitCode: 0, stdout: JSON.stringify(v) });

function toolPath(ti: Record<string, unknown>): string | null {
  for (const k of ["file_path", "path", "target_file", "filePath"]) if (typeof ti[k] === "string") return ti[k] as string;
  return null;
}

/** Cursor serializes Shell tool output as a JSON string: {"exitCode":0,"stdout":"…"}. */
function shellOutput(raw: unknown): { exit: number | null; text: string } {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return { exit: null, text: raw };
    }
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const exit = typeof o.exitCode === "number" ? o.exitCode : typeof o.exit_code === "number" ? o.exit_code : null;
    const text = [o.stdout, o.stderr, o.output].filter((x): x is string => typeof x === "string").join("\n");
    return { exit, text };
  }
  return { exit: null, text: "" };
}

export class CursorHookHandler {
  constructor(private readonly project: Project) {}

  handle(input: CursorHookInput): HookResult {
    const native = input.conversation_id ?? input.session_id;
    if (!input || !input.hook_event_name || !native) return { exitCode: 0 };
    const s = new AgentSession(this.project, "cursor", "cu", native);
    const cwd = input.cwd ?? input.workspace_roots?.[0] ?? this.project.root;
    const tool = input.tool_name ?? "";
    const ti = input.tool_input ?? {};
    const id = input.tool_use_id ?? `${tool}-${Date.now()}`;

    switch (input.hook_event_name) {
      case "sessionStart": {
        if (input.composer_mode && input.composer_mode !== "agent") return out({});
        const ctx = s.start("startup", { native_session_id: native, ...(input.model ? { model: input.model } : {}) });
        return out(ctx ? { additional_context: ctx } : {});
      }
      case "beforeSubmitPrompt":
        s.prompt(input.prompt ?? "", { native_session_id: native });
        return out({ continue: true });
      case "preToolUse": {
        if (tool === "Shell" && typeof ti.command === "string") {
          s.commandStarted(id, ti.command);
          return out({ permission: "allow" });
        }
        if (FILE_TOOLS.has(tool)) {
          const fp = toolPath(ti);
          const rel = fp ? s.relPath(fp, cwd) : null;
          if (rel) return gate(s.beforeFileChange(id, tool, rel));
        }
        // preToolUse is a permission hook: always answer with valid JSON.
        return out({ permission: "allow" });
      }
      case "postToolUse":
      case "postToolUseFailure": {
        const success = input.hook_event_name === "postToolUse";
        let reminder: string | null = null;
        if (tool === "Shell" && typeof ti.command === "string") {
          const res = shellOutput(input.tool_output);
          s.commandFinished(
            id,
            { command: ti.command, ok: success && !input.is_interrupt, exit_code: res.exit, output: success ? res.text : input.error_message ?? res.text },
            input.duration,
          );
        } else if (FILE_TOOLS.has(tool) && success) {
          const fp = toolPath(ti);
          const rel = fp ? s.relPath(fp, cwd) : null;
          s.afterFileChange(id, tool, rel, tool === "Delete" ? "deleted" : undefined);
          if (rel && tool !== "Delete") reminder = s.reminders({ path: rel });
        } else if (/todo/i.test(tool) && success && Array.isArray(ti.todos)) {
          s.todos((ti.todos as Record<string, unknown>[]).map((t) => ({ content: String(t.content ?? t.description ?? ""), status: t.status })));
        }
        const ctx = [s.takePendingInjection(), reminder].filter(Boolean).join("\n\n");
        return out(ctx ? { additional_context: ctx } : {});
      }
      case "afterFileEdit": {
        const rel = input.file_path ? s.relPath(input.file_path, cwd) : null;
        if (rel) s.afterFileChange(null, "afterFileEdit", rel, "modified");
        return out({});
      }
      case "preCompact": {
        const pct = typeof input.context_usage_percent === "number" ? input.context_usage_percent / 100 : null;
        const msg = s.compacting(input.trigger ?? "unknown", {
          reinjectLater: true,
          ...(pct !== null ? { usage: { ratio: pct, ...(input.context_tokens ? { tokens: input.context_tokens } : {}) } } : {}),
        });
        return out(msg ? { user_message: msg } : {});
      }
      case "subagentStart":
      case "subagentStop":
        s.subagent(input.hook_event_name === "subagentStart", { id: input.subagent_id ?? null, agent_type: input.subagent_type ?? null, description: input.task ?? "" });
        return out({});
      case "stop":
        s.flushStale();
        return out({});
      case "sessionEnd":
        s.end(input.reason ?? "other");
        return out({});
      default:
        return out({});
    }
  }
}

/** Cursor's preToolUse supports allow/deny only: `confirm` denies with instructions to confirm explicitly. */
function gate(g: ScopeGate | null): HookResult {
  if (!g || g.policy === "warn") return out({ permission: "allow" });
  const how = "Update the contract with `agent-state scope allow <glob>` if this change is intended.";
  if (g.policy === "block") {
    return out({ permission: "deny", user_message: `agent-state blocked an edit: ${g.reason}.`, agent_message: `agent-state scope policy: ${g.reason}. ${how}` });
  }
  return out({
    permission: "deny",
    user_message: `⚠ Scope expansion needs your confirmation: ${g.reason}. ${how}`,
    agent_message: `This edit is outside the task scope (${g.reason}). Ask the user to confirm; they can allow it with \`agent-state scope allow <glob>\`.`,
  });
}
