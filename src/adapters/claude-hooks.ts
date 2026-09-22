import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../core/project.js";
import { TaskService, type Task } from "../core/tasks.js";
import { toProjectPath } from "../core/paths.js";
import { readJson, writeJson } from "../core/store.js";
import { withLock } from "../core/lock.js";
import { detectTestRunner, parseTestOutput } from "../core/testdetect.js";
import { compactTask, recoverTask } from "../core/compact.js";
import { checkPath, effectivePolicy, loadContract } from "../core/scope.js";
import type { TodoItem } from "../core/events.js";
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

interface SessionFile {
  pending: Record<string, { tool: string; command?: string; path?: string; existed?: boolean; ts: string }>;
  pressure_level: number;
  todos: Record<string, TodoItem>;
}

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** Read-only commands not worth recording as activity. */
const TRIVIAL = /^\s*(?:ls|ll|la|pwd|cat|head|tail|less|more|wc|echo|printf|grep|rg|ag|find|fd|tree|which|type|file|stat|du|df|env|date|whoami|git\s+(?:status|log|diff|show|branch|remote|rev-parse|ls-files|blame)|agent-state\s+(?:status|recover|history|changes|impact|why|decisions|index|checkpoints|replay))\b/;

export function sessionIdFor(nativeId: string): string {
  return `cc_${nativeId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)}`;
}

function agentIdFor(input: ClaudeHookInput): string {
  return input.agent_id ? `claude-code:${input.agent_type ?? "subagent"}` : "claude-code";
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function tail(s: string, n: number): string {
  return s.length > n ? "…" + s.slice(s.length - n + 1) : s;
}

function responseText(r: unknown): string {
  if (r == null) return "";
  if (typeof r === "string") return r;
  if (typeof r === "object") {
    const o = r as Record<string, unknown>;
    const parts = [o.stdout, o.stderr, o.output, o.error, o.content].filter((x): x is string => typeof x === "string" && x.length > 0);
    if (parts.length) return parts.join("\n");
    try {
      return JSON.stringify(r);
    } catch {
      return "";
    }
  }
  return String(r);
}

function exitCodeOf(r: unknown): number | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  for (const k of ["exit_code", "exitCode", "returncode", "code"]) if (typeof o[k] === "number") return o[k] as number;
  return null;
}

export class ClaudeHookHandler {
  private readonly tasks: TaskService;

  constructor(private readonly project: Project) {
    this.tasks = new TaskService(project);
  }

  private sessionFilePath(sid: string): string {
    return join(this.project.paths.sessions, `${sid}.json`);
  }

  private withSession<T>(sid: string, fn: (s: SessionFile) => T): T {
    return withLock(this.project.lockPath(`session-${sid}`), () => {
      const path = this.sessionFilePath(sid);
      const s = readJson<SessionFile>(path, { pending: {}, pressure_level: 0, todos: {} });
      s.pending ??= {};
      s.todos ??= {};
      const out = fn(s);
      writeJson(path, s);
      return out;
    });
  }

  handle(input: ClaudeHookInput): HookResult {
    if (!input || typeof input.session_id !== "string" || !input.hook_event_name) return { exitCode: 0 };
    switch (input.hook_event_name) {
      case "SessionStart":
        return this.sessionStart(input);
      case "UserPromptSubmit":
        return this.userPrompt(input);
      case "PreToolUse":
        return this.preTool(input);
      case "PostToolUse":
        return this.postTool(input, true);
      case "PostToolUseFailure":
        return this.postTool(input, false);
      case "PreCompact":
        return this.preCompact(input);
      case "SubagentStart":
        return this.subagent(input, true);
      case "SubagentStop":
        return this.subagent(input, false);
      case "Stop":
        return this.stop(input);
      case "SessionEnd":
        return this.sessionEnd(input);
      default:
        return { exitCode: 0 };
    }
  }

  private base(input: ClaudeHookInput, task: Task | null) {
    return { agent_id: agentIdFor(input), session_id: sessionIdFor(input.session_id), task_id: task?.id ?? null };
  }

  /** The task this session reports to: the current task, if any. */
  private task(): Task | null {
    return this.tasks.currentTask();
  }

  private sessionStart(input: ClaudeHookInput): HookResult {
    const sid = sessionIdFor(input.session_id);
    // A new session continues the latest unfinished task, if there is one.
    let task = this.task() ?? this.tasks.latestUnfinished();
    const git = this.project.git;
    const isRepo = git.isRepo();
    this.project.emit({
      type: "SESSION_STARTED",
      ...this.base(input, task),
      payload: {
        native_session_id: input.session_id,
        source: input.source ?? "startup",
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        head: isRepo ? git.head() : null,
        branch: isRepo ? git.branch() : null,
      },
    });
    this.project.setCurrent({ session_id: sid, agent_id: "claude-code", task_id: task?.id ?? null });
    if (!task) return { exitCode: 0 };

    if (task.status === "COMPACTED" || task.status === "PAUSED") {
      this.tasks.setStatus(task.id, "RECOVERED", { agent_id: "claude-code", session_id: sid });
      task = this.tasks.get(task.id) ?? task;
    }
    const cfg = this.project.config.recovery;
    const source = input.source ?? "startup";
    const isContinuation = source === "compact" || source === "resume" || source === "clear";
    const mode = isContinuation ? (cfg.auto_inject ? "full" : "off") : cfg.inject_on_startup;
    if (mode === "off") return { exitCode: 0 };
    if (mode === "brief") {
      const r = recoverTask(this.project, task);
      return {
        exitCode: 0,
        stdout:
          `[agent-state] Unfinished task #${task.number}: "${clip(task.goal, 160)}" (${task.status}). ` +
          `Next recorded action: ${r.state.next_action.text} ` +
          `If this session continues that task, run \`agent-state recover\` to load its full verified context; ` +
          `if not, run \`agent-state task new "<goal>"\` so work is tracked separately.\n`,
      };
    }
    const r = recoverTask(this.project, task);
    this.project.emit({
      type: "RECOVERY_GENERATED",
      ...this.base(input, task),
      payload: { injected: true, source, bytes: r.state.stats.markdown_bytes },
    });
    return { exitCode: 0, stdout: claudeCode.formatContext(r.markdown, r.state) + "\n" };
  }

  private userPrompt(input: ClaudeHookInput): HookResult {
    const prompt = (input.prompt ?? "").trim();
    let task = this.task();
    const sid = sessionIdFor(input.session_id);
    if (!task && prompt && !prompt.startsWith("/")) {
      task = this.tasks.create(firstLine(prompt), { agent_id: "claude-code", session_id: sid });
      // Attribute the already-running session to the new task.
      this.project.emit({
        type: "SESSION_STARTED",
        ...this.base(input, task),
        payload: { native_session_id: input.session_id, source: "attach", cwd: input.cwd },
      });
    } else if (task && task.status === "RECOVERED") {
      this.tasks.setStatus(task.id, "ACTIVE", { agent_id: "claude-code", session_id: sid });
    }
    if (prompt && this.project.config.privacy.record_prompts) {
      this.project.emit({ type: "USER_REQUEST", ...this.base(input, task), payload: { text: clip(prompt, 4000) } });
    }
    this.project.setCurrent({ session_id: sid, agent_id: "claude-code" });
    return this.pressure(input, task);
  }

  private preTool(input: ClaudeHookInput): HookResult {
    const tool = input.tool_name ?? "";
    const ti = input.tool_input ?? {};
    const sid = sessionIdFor(input.session_id);
    const id = input.tool_use_id ?? `${tool}-${Date.now()}`;
    if (tool === "Bash" && typeof ti.command === "string") {
      if (!TRIVIAL.test(ti.command)) {
        this.withSession(sid, (s) => {
          s.pending[id] = { tool, command: ti.command as string, ts: new Date().toISOString() };
        });
      }
      return { exitCode: 0 };
    }
    if (FILE_TOOLS.has(tool)) {
      const fp = (ti.file_path ?? ti.notebook_path) as string | undefined;
      if (!fp) return { exitCode: 0 };
      const rel = toProjectPath(this.project.root, fp, input.cwd ?? this.project.root);
      if (!rel) return { exitCode: 0 };
      this.withSession(sid, (s) => {
        s.pending[id] = { tool, path: rel, existed: existsSync(join(this.project.root, rel)), ts: new Date().toISOString() };
      });
      return this.scopeGate(input, rel);
    }
    return { exitCode: 0 };
  }

  /** Enforces the task contract for file-editing tools according to policy. */
  private scopeGate(input: ClaudeHookInput, rel: string): HookResult {
    const task = this.task();
    if (!task) return { exitCode: 0 };
    const contract = loadContract(this.project, task.number);
    const verdict = checkPath(contract, rel);
    if (verdict.status === "ok" || verdict.status === "no-contract") return { exitCode: 0 };
    const policy = effectivePolicy(this.project, contract);
    const why =
      verdict.status === "restricted"
        ? `${rel} matches restricted scope "${verdict.rule}" of task #${task.number}`
        : `${rel} is outside the declared scope of task #${task.number} (allowed: ${contract!.scope.allowed.join(", ")})`;
    this.project.emit({
      type: "SCOPE_VIOLATION",
      ...this.base(input, task),
      payload: { path: rel, verdict: verdict.status, rule: verdict.status === "restricted" ? verdict.rule : null, policy },
    });
    if (policy === "block") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `agent-state scope policy: ${why}. Update the contract with \`agent-state scope allow <glob>\` if this change is intended.`,
          },
        }),
      };
    }
    if (policy === "confirm") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: `⚠ Scope expansion: ${why}.`,
          },
        }),
      };
    }
    return { exitCode: 0, stdout: JSON.stringify({ systemMessage: `⚠ agent-state: scope expansion — ${why}.` }) };
  }

  private postTool(input: ClaudeHookInput, success: boolean): HookResult {
    const tool = input.tool_name ?? "";
    const ti = input.tool_input ?? {};
    const sid = sessionIdFor(input.session_id);
    const task = this.task();
    const id = input.tool_use_id ?? "";
    const pending = this.withSession(sid, (s) => {
      const p = s.pending[id];
      delete s.pending[id];
      return p;
    });
    const base = this.base(input, task);
    const maxOut = this.project.config.privacy.max_output_chars;

    if (tool === "Bash" && typeof ti.command === "string") {
      if (TRIVIAL.test(ti.command) && success) return { exitCode: 0 };
      const out = responseText(success ? input.tool_response : input.error ?? input.tool_response);
      const exit = exitCodeOf(input.tool_response) ?? (success ? null : Number(/\bExit code (\d+)/i.exec(out)?.[1] ?? NaN) || null);
      const interrupted = !!(input.tool_response && typeof input.tool_response === "object" && (input.tool_response as Record<string, unknown>).interrupted);
      const runner = detectTestRunner(ti.command, this.project.config.tests.commands);
      let ok: boolean = success && !interrupted && (exit === null || exit === 0);
      const started = pending ? Date.parse(pending.ts) : NaN;
      const duration = Number.isFinite(started) ? Date.now() - started : undefined;
      if (runner) {
        const counts = parseTestOutput(out);
        if (ok && counts.failed !== null && counts.failed > 0) ok = false;
        this.project.emit({
          type: "TEST_FINISHED",
          ...base,
          payload: {
            command: clip(ti.command, 500),
            runner,
            ok,
            exit_code: exit,
            passed: counts.passed,
            failed: counts.failed,
            skipped: counts.skipped,
            evidence: exit !== null ? "exit_code" : counts.failed !== null ? "output_parse" : "exit_code",
            output_tail: ok ? "" : tail(out, maxOut),
            ...(duration !== undefined ? { duration_ms: duration } : {}),
          },
        });
      } else {
        this.project.emit({
          type: "COMMAND_EXECUTED",
          ...base,
          payload: {
            command: clip(ti.command, 500),
            ok,
            exit_code: exit,
            ...(typeof ti.description === "string" ? { description: clip(ti.description, 200) } : {}),
            ...(ok ? {} : { output_tail: tail(out, maxOut) }),
            ...(duration !== undefined ? { duration_ms: duration } : {}),
          },
        });
      }
      return this.pressure(input, task);
    }

    if (FILE_TOOLS.has(tool) && success) {
      const fp = (ti.file_path ?? ti.notebook_path) as string | undefined;
      const rel = pending?.path ?? (fp ? toProjectPath(this.project.root, fp, input.cwd ?? this.project.root) : null);
      if (rel && !rel.startsWith(".agent-state/")) {
        const created = tool === "Write" && pending?.existed === false;
        this.project.emit({ type: created ? "FILE_CREATED" : "FILE_MODIFIED", ...base, payload: { path: rel, tool } });
      }
      return this.pressure(input, task);
    }

    if (tool === "TodoWrite" && success && Array.isArray(ti.todos)) {
      const items: TodoItem[] = (ti.todos as Record<string, unknown>[])
        .map((t) => ({ content: String(t.content ?? t.activeForm ?? ""), status: normalizeStatus(t.status) }))
        .filter((t) => t.content);
      this.project.emit({ type: "TODOS_UPDATED", ...base, payload: { items } });
      return { exitCode: 0 };
    }

    // Newer task-list tools: fold incremental create/update calls into one snapshot.
    if (/^Task(Create|Update)$/.test(tool) && success) {
      const snapshot = this.withSession(sid, (s) => {
        const resp = (input.tool_response ?? {}) as Record<string, unknown>;
        const key = String(ti.taskId ?? ti.id ?? resp.taskId ?? resp.id ?? ti.subject ?? ti.content ?? "");
        if (!key) return null;
        const prev = s.todos[key];
        const content = String(ti.subject ?? ti.content ?? ti.description ?? prev?.content ?? "");
        if (!content) return null;
        s.todos[key] = { content, status: ti.status ? normalizeStatus(ti.status) : prev?.status ?? "pending" };
        return Object.values(s.todos);
      });
      if (snapshot) this.project.emit({ type: "TODOS_UPDATED", ...base, payload: { items: snapshot } });
      return { exitCode: 0 };
    }
    return { exitCode: 0 };
  }

  private preCompact(input: ClaudeHookInput): HookResult {
    const task = this.task();
    this.project.emit({ type: "CONTEXT_COMPACTED", ...this.base(input, task), payload: { trigger: input.trigger ?? "unknown" } });
    if (!task) return { exitCode: 0 };
    const r = compactTask(this.project, task, { agent_id: "claude-code", session_id: sessionIdFor(input.session_id) });
    this.withSession(sessionIdFor(input.session_id), (s) => {
      s.pressure_level = 0;
    });
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        systemMessage: `agent-state saved recovery state for task #${task.number} (${r.state.stats.markdown_bytes} B) → ${relPath(this.project, r.paths.md)}; it will be re-injected after compaction.`,
      }),
    };
  }

  private subagent(input: ClaudeHookInput, start: boolean): HookResult {
    const task = this.task();
    this.project.emit({
      type: start ? "SUBAGENT_STARTED" : "SUBAGENT_FINISHED",
      ...this.base(input, task),
      agent_id: "claude-code",
      payload: { id: input.agent_id ?? null, agent_type: input.agent_type ?? null, description: input.agent_type ?? "" },
    });
    return { exitCode: 0 };
  }

  private stop(input: ClaudeHookInput): HookResult {
    const task = this.task();
    // Commands that started but never reported completion (denied, killed, or
    // failed on a Claude Code version without PostToolUseFailure).
    const cutoff = Date.now() - 60_000;
    const stale = this.withSession(sessionIdFor(input.session_id), (s) => {
      const out = Object.entries(s.pending).filter(([, p]) => Date.parse(p.ts) < cutoff);
      for (const [k] of out) delete s.pending[k];
      return out.map(([, p]) => p);
    });
    for (const p of stale) {
      if (!p.command) continue;
      const runner = detectTestRunner(p.command, this.project.config.tests.commands);
      this.project.emit({
        type: runner ? "TEST_FINISHED" : "COMMAND_EXECUTED",
        ...this.base(input, task),
        payload: { command: clip(p.command, 500), ok: null, ...(runner ? { runner, evidence: "reported" } : {}), note: "no completion signal" },
      });
    }
    return this.pressure(input, task);
  }

  private sessionEnd(input: ClaudeHookInput): HookResult {
    const task = this.task();
    const sid = sessionIdFor(input.session_id);
    this.project.emit({ type: "SESSION_ENDED", ...this.base(input, task), payload: { reason: input.reason ?? "other" } });
    if (task && input.reason !== "clear") {
      // Leave a fresh recovery state behind so the next session can pick up instantly.
      compactTask(this.project, task, { agent_id: "claude-code", session_id: sid, status: false });
      this.tasks.setStatus(task.id, "PAUSED", { agent_id: "claude-code", session_id: sid, reason: "session ended" });
    }
    return { exitCode: 0 };
  }

  /** Context-pressure detection from the transcript (best effort, estimated). */
  private pressure(input: ClaudeHookInput, task: Task | null): HookResult {
    if (!input.transcript_path || input.agent_id) return { exitCode: 0 };
    const tokens = claudeCode.estimateContextTokens(input.transcript_path);
    if (tokens === null) return { exitCode: 0 };
    const cfg = this.project.config.context;
    const ratio = tokens / cfg.window_tokens;
    const level = ratio >= cfg.compact_at ? 2 : ratio >= cfg.warn_at ? 1 : 0;
    const sid = sessionIdFor(input.session_id);
    const prev = this.withSession(sid, (s) => {
      const p = s.pressure_level ?? 0;
      s.pressure_level = level;
      return p;
    });
    if (level <= prev) return { exitCode: 0 };
    const pct = Math.round(ratio * 100);
    this.project.emit({ type: "CONTEXT_PRESSURE", ...this.base(input, task), payload: { tokens, ratio, level, estimated: true } });
    if (level === 1) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ systemMessage: `agent-state: context usage ~${pct}% (estimated). Consider running \`agent-state compact\`.` }),
      };
    }
    if (!task) return { exitCode: 0 };
    const r = compactTask(this.project, task, { agent_id: "claude-code", session_id: sid, status: false });
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        systemMessage: `agent-state: context usage ~${pct}% (estimated). A compact recovery state has been generated: ${relPath(this.project, r.paths.md)}`,
      }),
    };
  }
}

function relPath(project: Project, abs: string): string {
  return toProjectPath(project.root, abs) ?? abs;
}

function firstLine(prompt: string): string {
  const line = prompt.split("\n").map((l) => l.trim()).find(Boolean) ?? prompt;
  return clip(line, 160);
}

function normalizeStatus(s: unknown): TodoItem["status"] {
  const v = String(s ?? "").toLowerCase();
  if (v === "completed" || v === "done") return "completed";
  if (v === "in_progress" || v === "in-progress" || v === "active") return "in_progress";
  if (v === "blocked") return "blocked";
  return "pending";
}
