import type { Project } from "../core/project.js";
import { AgentSession, type ScopeGate, type StartSource } from "./session-core.js";
import { claudeCode } from "./claude-code.js";

/** Input shape of Claude Code command hooks (documented fields only). */
export interface ClaudeHookInput {
  hook_event_name: string;
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  agent_id?: string;
  agent_type?: string;
  source?: string;
  model?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: unknown;
  error?: unknown;
  trigger?: string;
  reason?: string;
  last_assistant_message?: string;
}

export interface HookResult {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function sessionIdFor(nativeId: string): string {
  return `cc_${nativeId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)}`;
}

export function responseText(r: unknown): string {
  if (r == null) return "";
  if (typeof r === "string") return r;
  if (typeof r === "object") {
    const o = r as Record<string, unknown>;
    const parts = [o.stdout, o.stderr, o.output, o.error, o.content, o.llmContent].filter((x): x is string => typeof x === "string" && x.length > 0);
    if (parts.length) return parts.join("\n");
    try {
      return JSON.stringify(r);
    } catch {
      return "";
    }
  }
  return String(r);
}

export function exitCodeOf(r: unknown): number | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  for (const k of ["exit_code", "exitCode", "returncode", "code"]) if (typeof o[k] === "number") return o[k] as number;
  return null;
}

const json = (v: unknown): HookResult => ({ exitCode: 0, stdout: JSON.stringify(v) });
const message = (m: string | null): HookResult => (m ? json({ systemMessage: m }) : { exitCode: 0 });

/**
 * Claude Code adapter. Uses only documented hook events; translates them into
 * AgentSession calls and the neutral results back into Claude Code hook output.
 */
export class ClaudeHookHandler {
  constructor(private readonly project: Project) {}

  handle(input: ClaudeHookInput): HookResult {
    if (!input || typeof input.session_id !== "string" || !input.hook_event_name) return { exitCode: 0 };
    const actor = input.agent_id ? `claude-code:${input.agent_type ?? "subagent"}` : "claude-code";
    const s = new AgentSession(this.project, "claude-code", "cc", input.session_id, actor);
    const cwd = input.cwd ?? this.project.root;
    const tool = input.tool_name ?? "";
    const ti = input.tool_input ?? {};
    const id = input.tool_use_id ?? `${tool}-${Date.now()}`;

    switch (input.hook_event_name) {
      case "SessionStart": {
        const ctx = s.start((input.source ?? "startup") as StartSource, {
          native_session_id: input.session_id,
          cwd: input.cwd,
          ...(input.model ? { model: input.model } : {}),
        });
        // SessionStart stdout is added to Claude's context.
        return ctx ? { exitCode: 0, stdout: ctx + "\n" } : { exitCode: 0 };
      }
      case "UserPromptSubmit":
        s.prompt(input.prompt ?? "", { native_session_id: input.session_id, cwd: input.cwd });
        return this.pressure(s, input);
      case "PreToolUse": {
        if (tool === "Bash" && typeof ti.command === "string") {
          s.commandStarted(id, ti.command);
          return { exitCode: 0 };
        }
        if (FILE_TOOLS.has(tool)) {
          const rel = filePath(s, ti, cwd);
          if (!rel) return { exitCode: 0 };
          return gateOutput(s.beforeFileChange(id, tool, rel));
        }
        return { exitCode: 0 };
      }
      case "PostToolUse":
      case "PostToolUseFailure": {
        const success = input.hook_event_name === "PostToolUse";
        if (tool === "Bash" && typeof ti.command === "string") {
          const resp = input.tool_response;
          const interrupted = !!(resp && typeof resp === "object" && (resp as Record<string, unknown>).interrupted);
          s.commandFinished(id, {
            command: ti.command,
            ok: success && !interrupted,
            exit_code: exitCodeOf(resp),
            output: responseText(success ? resp : input.error ?? resp),
            ...(typeof ti.description === "string" ? { description: ti.description } : {}),
          });
          return this.pressure(s, input);
        }
        if (FILE_TOOLS.has(tool) && success) {
          s.afterFileChange(id, tool, filePath(s, ti, cwd));
          return this.pressure(s, input);
        }
        if (tool === "TodoWrite" && success && Array.isArray(ti.todos)) {
          s.todos((ti.todos as Record<string, unknown>[]).map((t) => ({ content: String(t.content ?? t.activeForm ?? ""), status: t.status })));
          return { exitCode: 0 };
        }
        if (/^Task(Create|Update)$/.test(tool) && success) {
          const resp = (input.tool_response ?? {}) as Record<string, unknown>;
          const key = String(ti.taskId ?? ti.id ?? resp.taskId ?? resp.id ?? ti.subject ?? ti.content ?? "");
          const content = (ti.subject ?? ti.content ?? ti.description) as string | undefined;
          s.todoUpsert(key, content ?? null, ti.status);
          return { exitCode: 0 };
        }
        return { exitCode: 0 };
      }
      case "PreCompact":
        return message(s.compacting(input.trigger ?? "unknown"));
      case "SubagentStart":
      case "SubagentStop":
        s.subagent(input.hook_event_name === "SubagentStart", { id: input.agent_id ?? null, agent_type: input.agent_type ?? null });
        return { exitCode: 0 };
      case "Stop":
        s.flushStale();
        return this.pressure(s, input);
      case "SessionEnd":
        s.end(input.reason ?? "other");
        return { exitCode: 0 };
      default:
        return { exitCode: 0 };
    }
  }

  /** Context pressure estimated from the transcript (main agent only). */
  private pressure(s: AgentSession, input: ClaudeHookInput): HookResult {
    if (!input.transcript_path || input.agent_id) return { exitCode: 0 };
    const tokens = claudeCode.estimateContextTokens(input.transcript_path);
    if (tokens === null) return { exitCode: 0 };
    return message(s.pressure(tokens / this.project.config.context.window_tokens, tokens, true));
  }
}

function filePath(s: AgentSession, ti: Record<string, unknown>, cwd: string): string | null {
  const fp = (ti.file_path ?? ti.notebook_path) as string | undefined;
  return fp ? s.relPath(fp, cwd) : null;
}

function gateOutput(gate: ScopeGate | null): HookResult {
  if (!gate) return { exitCode: 0 };
  if (gate.policy === "block") {
    return json({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `agent-state scope policy: ${gate.reason}. Update the contract with \`agent-state scope allow <glob>\` if this change is intended.`,
      },
    });
  }
  if (gate.policy === "confirm") {
    return json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: `⚠ Scope expansion: ${gate.reason}.` } });
  }
  return json({ systemMessage: `⚠ agent-state: scope expansion — ${gate.reason}.` });
}
