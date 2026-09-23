import type { Project } from "../core/project.js";
import type { AgentAdapter } from "./adapter.js";
import { genericFraming } from "./adapter.js";
import { AgentSession, type ScopeGate, type StartSource } from "./session-core.js";
import type { HookResult } from "./claude-hooks.js";
import { responseText } from "./claude-hooks.js";

/**
 * Gemini CLI adapter (hooks in `.gemini/settings.json`).
 *
 * Documented events used: SessionStart, SessionEnd, BeforeAgent, BeforeTool,
 * AfterTool, PreCompress, AfterAgent. Gemini CLI requires hooks to print only
 * JSON on stdout. PreCompress cannot inject context, so recovery is re-injected
 * through the next BeforeAgent/AfterTool `additionalContext`.
 */
export const gemini: AgentAdapter = {
  id: "gemini-cli",
  displayName: "Gemini CLI",
  formatContext: genericFraming,
  launchCommand(context: string) {
    return { cmd: "gemini", args: ["-i", context] };
  },
};

export interface GeminiHookInput {
  hook_event_name: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  timestamp?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: { llmContent?: unknown; returnDisplay?: unknown; error?: unknown } | unknown;
  source?: string;
  reason?: string;
  trigger?: string;
}

const FILE_TOOLS = new Set(["write_file", "replace"]);
const SHELL = "run_shell_command";
const out = (v: unknown): HookResult => ({ exitCode: 0, stdout: JSON.stringify(v) });
const ctxOut = (event: string, ctx: string | null): HookResult =>
  out(ctx ? { hookSpecificOutput: { hookEventName: event, additionalContext: ctx } } : {});

function llmText(resp: unknown): { text: string; error: boolean } {
  if (resp && typeof resp === "object") {
    const o = resp as Record<string, unknown>;
    const err = o.error;
    const text = [o.llmContent, typeof err === "string" ? err : err && typeof err === "object" ? (err as Record<string, unknown>).message : null]
      .filter((x): x is string => typeof x === "string")
      .join("\n");
    return { text: text || responseText(resp), error: !!err };
  }
  return { text: responseText(resp), error: false };
}

export class GeminiHookHandler {
  constructor(private readonly project: Project) {}

  handle(input: GeminiHookInput): HookResult {
    const native = input.session_id ?? process.env.GEMINI_SESSION_ID;
    if (!input || !input.hook_event_name || !native) return out({});
    const s = new AgentSession(this.project, "gemini-cli", "gm", native);
    const cwd = input.cwd ?? process.env.GEMINI_CWD ?? this.project.root;
    const tool = input.tool_name ?? "";
    const ti = input.tool_input ?? {};

    switch (input.hook_event_name) {
      case "SessionStart":
        return ctxOut("SessionStart", s.start((input.source ?? "startup") as StartSource, { native_session_id: native, cwd }));
      case "BeforeAgent": {
        s.prompt(input.prompt ?? "", { native_session_id: native, cwd });
        return ctxOut("BeforeAgent", s.takePendingInjection());
      }
      case "BeforeTool": {
        if (tool === SHELL && typeof ti.command === "string") {
          s.commandStarted(`${SHELL}:${ti.command}`, ti.command);
          return out({});
        }
        if (FILE_TOOLS.has(tool) && typeof ti.file_path === "string") {
          const rel = s.relPath(ti.file_path, cwd);
          if (rel) return gate(s.beforeFileChange(`${tool}:${rel}`, tool, rel));
        }
        return out({});
      }
      case "AfterTool": {
        let reminder: string | null = null;
        if (tool === SHELL) {
          const command = typeof ti.command === "string" ? ti.command : null;
          const id = command ? `${SHELL}:${command}` : s.latestPendingId("shell");
          const res = llmText(input.tool_response);
          const exit = Number(/\bExit Code: (-?\d+)/.exec(res.text)?.[1] ?? NaN);
          if (command) {
            s.commandFinished(id, { command, ok: !res.error && !(exit > 0), exit_code: Number.isFinite(exit) ? exit : null, output: res.text.replace(/^Output: /, "") });
          }
        } else if (FILE_TOOLS.has(tool)) {
          const rel = typeof ti.file_path === "string" ? s.relPath(ti.file_path, cwd) : null;
          const id = rel ? `${tool}:${rel}` : s.latestPendingId(tool);
          if (!llmText(input.tool_response).error) s.afterFileChange(id, tool, rel);
          if (rel) reminder = s.reminders({ path: rel });
        } else if (tool === "write_todos" && Array.isArray(ti.todos)) {
          s.todos((ti.todos as Record<string, unknown>[]).map((t) => ({ content: String(t.description ?? t.content ?? ""), status: t.status })));
        }
        return ctxOut("AfterTool", [s.takePendingInjection(), reminder].filter(Boolean).join("\n\n") || null);
      }
      case "PreCompress": {
        const msg = s.compacting(input.trigger ?? "unknown", { reinjectLater: true });
        return out(msg ? { systemMessage: msg } : {});
      }
      case "AfterAgent":
        s.flushStale();
        return out({});
      case "SessionEnd":
        s.end(input.reason ?? "other");
        return out({});
      default:
        return out({});
    }
  }
}

/** Gemini's BeforeTool supports allow/deny: `confirm` denies with instructions to confirm explicitly. */
function gate(g: ScopeGate | null): HookResult {
  if (!g) return out({});
  const how = "Update the contract with `agent-state scope allow <glob>` if this change is intended.";
  if (g.policy === "warn") return out({ systemMessage: `⚠ agent-state: scope expansion — ${g.reason}.` });
  if (g.policy === "block") return out({ decision: "deny", reason: `agent-state scope policy: ${g.reason}. ${how}` });
  return out({ decision: "deny", reason: `This edit is outside the task scope (${g.reason}). Ask the user to confirm; they can allow it with \`agent-state scope allow <glob>\`.` });
}
