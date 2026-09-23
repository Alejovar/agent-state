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
import type { ScopePolicy } from "../core/config.js";
import type { DecisionPayload, NotePayload, TodoItem } from "../core/events.js";
import { reduceState } from "../core/state.js";
import { genericFraming } from "./adapter.js";

/**
 * Agent-neutral session logic shared by every hook-based adapter (Claude Code,
 * Cursor, Gemini CLI…). Adapters only translate their native payloads into
 * these calls and translate the neutral results back into native output.
 */

export type StartSource = "startup" | "resume" | "compact" | "clear" | "attach" | "notify";

export interface ScopeGate {
  policy: ScopePolicy;
  path: string;
  reason: string;
}

export interface CommandOutcome {
  command: string;
  ok: boolean | null;
  exit_code: number | null;
  output: string;
  description?: string;
}

interface SessionFile {
  pending: Record<string, { tool: string; command?: string; path?: string; existed?: boolean; ts: string }>;
  pressure_level: number;
  todos: Record<string, TodoItem>;
  /** Recovery context waiting to be injected (agents without a post-compaction SessionStart). */
  inject_pending?: boolean;
  /** Reminder keys already delivered since the last compaction (so the agent is not nagged). */
  reminded?: Record<string, string>;
}

/** Read-only commands not worth recording as activity. */
export const TRIVIAL_COMMAND = /^\s*(?:ls|ll|la|pwd|cat|head|tail|less|more|wc|echo|printf|grep|rg|ag|find|fd|tree|which|type|file|stat|du|df|env|date|whoami|git\s+(?:status|log|diff|show|branch|remote|rev-parse|ls-files|blame)|agent-state\s+(?:status|recover|history|changes|impact|why|decisions|index|checkpoints|replay))\b/;

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function tail(s: string, n: number): string {
  return s.length > n ? "…" + s.slice(s.length - n + 1) : s;
}

function firstLine(prompt: string): string {
  const line = prompt.split("\n").map((l) => l.trim()).find(Boolean) ?? prompt;
  return clip(line, 160);
}

export function normalizeTodoStatus(s: unknown): TodoItem["status"] | null {
  const v = String(s ?? "").toLowerCase();
  if (v === "completed" || v === "done") return "completed";
  if (v === "in_progress" || v === "in-progress" || v === "active") return "in_progress";
  if (v === "blocked") return "blocked";
  if (v === "cancelled" || v === "canceled") return null;
  return "pending";
}

export class AgentSession {
  private readonly tasks: TaskService;
  readonly session_id: string;

  /**
   * @param agent   stable agent id stored on events ("claude-code", "cursor", "gemini-cli")
   * @param prefix  session id prefix ("cc", "cu", "gm")
   * @param native  the agent's own session/conversation id
   * @param actor   agent id for this particular event (e.g. "claude-code:Explore" inside a subagent)
   */
  constructor(
    private readonly project: Project,
    readonly agent: string,
    prefix: string,
    native: string,
    private readonly actor: string = agent,
  ) {
    this.tasks = new TaskService(project);
    this.session_id = `${prefix}_${native.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "session"}`;
  }

  private withSession<T>(fn: (s: SessionFile) => T): T {
    return withLock(this.project.lockPath(`session-${this.session_id}`), () => {
      const path = join(this.project.paths.sessions, `${this.session_id}.json`);
      const s = readJson<SessionFile>(path, { pending: {}, pressure_level: 0, todos: {} });
      s.pending ??= {};
      s.todos ??= {};
      const out = fn(s);
      writeJson(path, s);
      return out;
    });
  }

  task(): Task | null {
    return this.tasks.currentTask();
  }

  private base(task: Task | null) {
    return { agent_id: this.actor, session_id: this.session_id, task_id: task?.id ?? null };
  }

  /** Project-relative path, or null for paths outside the project / inside .agent-state. */
  relPath(file: string, cwd?: string): string | null {
    const rel = toProjectPath(this.project.root, file, cwd ?? this.project.root);
    return rel && !rel.startsWith(".agent-state/") ? rel : null;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Returns recovery text to inject into the agent, or null. */
  start(source: StartSource, meta: Record<string, unknown> = {}): string | null {
    let task = this.task() ?? this.tasks.latestUnfinished();
    const git = this.project.git;
    const isRepo = git.isRepo();
    this.project.emit({
      type: "SESSION_STARTED",
      ...this.base(task),
      payload: { ...meta, source, head: isRepo ? git.head() : null, branch: isRepo ? git.branch() : null },
    });
    this.project.setCurrent({ session_id: this.session_id, agent_id: this.agent, task_id: task?.id ?? null });
    // A new or cleared context has seen none of the earlier reminders.
    this.withSession((s) => {
      s.reminded = {};
    });
    const guidance = this.project.config.recovery.agent_guidance ? GUIDANCE : null;
    const body = this.startContext(task, source);
    return [body, guidance].filter(Boolean).join("\n\n") || null;
  }

  private startContext(task: Task | null, source: StartSource): string | null {
    if (!task) return null;

    if (task.status === "COMPACTED" || task.status === "PAUSED") {
      this.tasks.setStatus(task.id, "RECOVERED", { agent_id: this.actor, session_id: this.session_id });
      task = this.tasks.get(task.id) ?? task;
    }
    const cfg = this.project.config.recovery;
    const isContinuation = source === "compact" || source === "resume" || source === "clear";
    const mode = isContinuation ? (cfg.auto_inject ? "full" : "off") : cfg.inject_on_startup;
    if (mode === "off") return null;
    const r = recoverTask(this.project, task);
    if (mode === "brief") {
      return (
        `[agent-state] Unfinished task #${task.number}: "${clip(task.goal, 160)}" (${task.status}). ` +
        `Next recorded action: ${r.state.next_action.text} ` +
        `If this session continues that task, run \`agent-state recover\` to load its full verified context; ` +
        `if not, run \`agent-state task new "<goal>"\` so work is tracked separately.`
      );
    }
    this.project.emit({ type: "RECOVERY_GENERATED", ...this.base(task), payload: { injected: true, source, bytes: r.state.stats.markdown_bytes } });
    return genericFraming(r.markdown, r.state);
  }

  prompt(text: string, meta: Record<string, unknown> = {}): Task | null {
    const prompt = text.trim();
    let task = this.task();
    if (!task && prompt && !prompt.startsWith("/")) {
      task = this.tasks.create(firstLine(prompt), { agent_id: this.actor, session_id: this.session_id });
      // Attribute the already-running session to the new task.
      this.project.emit({ type: "SESSION_STARTED", ...this.base(task), payload: { ...meta, source: "attach" } });
    } else if (task && task.status === "RECOVERED") {
      this.tasks.setStatus(task.id, "ACTIVE", { agent_id: this.actor, session_id: this.session_id });
    }
    if (prompt && this.project.config.privacy.record_prompts) {
      this.project.emit({ type: "USER_REQUEST", ...this.base(task), payload: { text: clip(prompt, 4000) } });
    }
    this.project.setCurrent({ session_id: this.session_id, agent_id: this.agent });
    return task;
  }

  end(reason: string): void {
    const task = this.task();
    this.project.emit({ type: "SESSION_ENDED", ...this.base(task), payload: { reason } });
    if (task && reason !== "clear") {
      // Leave a fresh recovery state behind so the next session can pick up instantly.
      compactTask(this.project, task, { agent_id: this.actor, session_id: this.session_id, status: false });
      this.tasks.setStatus(task.id, "PAUSED", { agent_id: this.actor, session_id: this.session_id, reason: "session ended" });
    }
  }

  /** Saves a recovery state before the agent compacts its context. Returns a user-facing message. */
  compacting(trigger: string, opts: { reinjectLater?: boolean; usage?: { ratio: number; tokens?: number } } = {}): string | null {
    const task = this.task();
    if (opts.usage) {
      this.project.emit({ type: "CONTEXT_PRESSURE", ...this.base(task), payload: { ratio: opts.usage.ratio, tokens: opts.usage.tokens ?? null, estimated: false } });
    }
    this.project.emit({ type: "CONTEXT_COMPACTED", ...this.base(task), payload: { trigger } });
    if (!task) return null;
    const r = compactTask(this.project, task, { agent_id: this.actor, session_id: this.session_id });
    this.withSession((s) => {
      s.pressure_level = 0;
      s.reminded = {};
      if (opts.reinjectLater) s.inject_pending = true;
    });
    const rel = toProjectPath(this.project.root, r.paths.md) ?? r.paths.md;
    return `agent-state saved recovery state for task #${task.number} (${r.state.stats.markdown_bytes} B) → ${rel}; it will be re-injected after compaction.`;
  }

  /** For agents without a post-compaction session start: hands back recovery context once. */
  takePendingInjection(): string | null {
    const pending = this.withSession((s) => {
      const p = !!s.inject_pending;
      s.inject_pending = false;
      return p;
    });
    if (!pending) return null;
    const task = this.task();
    if (!task) return null;
    const r = recoverTask(this.project, task);
    this.project.emit({ type: "RECOVERY_GENERATED", ...this.base(task), payload: { injected: true, source: "compact", bytes: r.state.stats.markdown_bytes } });
    return genericFraming(r.markdown, r.state);
  }

  // ---------------------------------------------------------------- reminders

  /**
   * Just-in-time memory: the decisions, failed approaches and open issues that
   * concern the file the agent is about to edit (or the command it is about to
   * rerun), delivered once per context so long sessions don't contradict
   * themselves ("context rot"). Deterministic: explicit file links, mentions of
   * the file's name, and the last result of the same command.
   */
  reminders(target: { path?: string; command?: string }): string | null {
    if (!this.project.config.reminders.enabled) return null;
    const task = this.task();
    const db = this.project.db();
    const items: { key: string; text: string }[] = [];

    if (target.path) {
      const path = target.path;
      const base = path.split("/").pop() ?? path;
      const stem = base.replace(/\.[^.]+$/, "");
      const specificStem = stem.length >= 4 && !GENERIC_STEMS.has(stem.toLowerCase());
      const mentions = (text: string) => {
        const t = text.toLowerCase();
        return t.includes(path.toLowerCase()) || t.includes(base.toLowerCase()) || (specificStem && new RegExp(`\\b${escapeRe(stem.toLowerCase())}\\b`).test(t));
      };
      const linked = (files: string[] | undefined) => (files ?? []).some((f) => f === path || (f.endsWith("/") ? path.startsWith(f) : path.startsWith(f + "/")));

      for (const e of db.query({ types: ["DECISION_RECORDED"] })) {
        const d = e.payload as unknown as DecisionPayload;
        if (!linked(d.files) && !mentions(`${d.decision} ${d.reason ?? ""}`)) continue;
        const rejected = d.alternatives?.length ? ` Rejected: ${d.alternatives.join(", ")}.` : "";
        items.push({ key: `decision:${d.number}`, text: `decision #${d.number}: ${clip(d.decision, 160)}${d.reason ? ` (because ${clip(d.reason, 140)})` : ""}.${rejected}` });
      }
      const notes = db.query({ types: ["NOTE_RECORDED"], ...(task ? { task_id: task.id } : {}) });
      const resolved = new Set(notes.filter((n) => (n.payload as unknown as NotePayload).kind === "resolved").map((n) => String(n.payload.text).toLowerCase()));
      for (const e of notes) {
        const n = e.payload as unknown as NotePayload;
        if (n.kind !== "failed_attempt" && n.kind !== "issue") continue;
        if (!linked(n.files) && !mentions(n.text)) continue;
        if (n.kind === "issue" && [...resolved].some((r) => n.text.toLowerCase().includes(r) || r.includes(n.text.toLowerCase()))) continue;
        items.push({ key: `note:${e.id}`, text: `${n.kind === "issue" ? "open issue" : "already tried and failed"}: ${clip(n.text, 200)}` });
      }
    }

    if (target.command && task) {
      const cmd = target.command.trim().replace(/\s+/g, " ");
      const ws = reduceState(task.id, db.query({ task_id: task.id, types: ["COMMAND_EXECUTED", "TEST_FINISHED"] }));
      const last = [...ws.commands.failing].reverse().find((c) => c.command.trim().replace(/\s+/g, " ") === cmd);
      if (last) {
        const why = lastLine(last.output_tail ?? "");
        items.push({ key: `cmd:${cmd}:${last.ts}`, text: `\`${clip(cmd, 80)}\` failed last time${why ? `: ${why}` : ""}. Change the approach rather than rerunning it unchanged.` });
      }
    }

    if (!items.length) return null;
    const fresh = this.withSession((s) => {
      s.reminded ??= {};
      const now = new Date().toISOString();
      const out = items.filter((i) => !s.reminded![i.key]);
      for (const i of out) s.reminded![i.key] = now;
      return out;
    });
    if (!fresh.length) return null;
    const subject = target.path ? `before editing ${target.path}` : "before running this command";
    return clip(`[agent-state] Reminder ${subject}:\n` + fresh.slice(0, 4).map((i) => `- ${i.text}`).join("\n"), 900);
  }

  // ---------------------------------------------------------------- tools

  /** Before a file-editing tool runs: remembers whether the file existed; enforces scope. */
  beforeFileChange(toolId: string, tool: string, rel: string): ScopeGate | null {
    this.withSession((s) => {
      s.pending[toolId] = { tool, path: rel, existed: existsSync(join(this.project.root, rel)), ts: new Date().toISOString() };
    });
    const task = this.task();
    if (!task) return null;
    const contract = loadContract(this.project, task.number);
    const verdict = checkPath(contract, rel);
    if (verdict.status === "ok" || verdict.status === "no-contract") return null;
    const policy = effectivePolicy(this.project, contract);
    const reason =
      verdict.status === "restricted"
        ? `${rel} matches restricted scope "${verdict.rule}" of task #${task.number}`
        : `${rel} is outside the declared scope of task #${task.number} (allowed: ${contract!.scope.allowed.join(", ")})`;
    this.project.emit({
      type: "SCOPE_VIOLATION",
      ...this.base(task),
      payload: { path: rel, verdict: verdict.status, rule: verdict.status === "restricted" ? verdict.rule : null, policy },
    });
    return { policy, path: rel, reason };
  }

  /** After a file-editing tool succeeded. `kind` overrides created/modified detection. */
  afterFileChange(toolId: string | null, tool: string, rel: string | null, kind?: "created" | "modified" | "deleted"): void {
    const pending = toolId ? this.takePending(toolId) : undefined;
    const path = pending?.path ?? rel;
    if (!path) return;
    const k = kind ?? (pending?.existed === false ? "created" : "modified");
    const type = k === "created" ? "FILE_CREATED" : k === "deleted" ? "FILE_DELETED" : "FILE_MODIFIED";
    this.project.emit({ type, ...this.base(this.task()), payload: { path, tool } });
  }

  commandStarted(toolId: string, command: string): void {
    if (TRIVIAL_COMMAND.test(command)) return;
    this.withSession((s) => {
      s.pending[toolId] = { tool: "shell", command, ts: new Date().toISOString() };
    });
  }

  /** Most recent pending tool call for `tool` (for agents whose post-tool payload lacks an id). */
  latestPendingId(tool: string): string | null {
    return this.withSession((s) => {
      const hits = Object.entries(s.pending).filter(([, p]) => p.tool === tool).sort((a, b) => b[1].ts.localeCompare(a[1].ts));
      return hits[0]?.[0] ?? null;
    });
  }

  private takePending(toolId: string) {
    return this.withSession((s) => {
      const p = s.pending[toolId];
      delete s.pending[toolId];
      return p;
    });
  }

  /** Records a finished command; test commands become TEST_FINISHED with parsed counts. */
  commandFinished(toolId: string | null, outcome: CommandOutcome, durationMs?: number): void {
    const pending = toolId ? this.takePending(toolId) : undefined;
    if (TRIVIAL_COMMAND.test(outcome.command) && outcome.ok !== false) return;
    const maxOut = this.project.config.privacy.max_output_chars;
    const started = pending ? Date.parse(pending.ts) : NaN;
    const duration = durationMs ?? (Number.isFinite(started) ? Date.now() - started : undefined);
    const exit = outcome.exit_code ?? (outcome.ok === false ? Number(/\bExit Code:? (\d+)/i.exec(outcome.output)?.[1] ?? NaN) || null : null);
    const runner = detectTestRunner(outcome.command, this.project.config.tests.commands);
    let ok = outcome.ok;
    if (ok === true && exit !== null && exit !== 0) ok = false;
    const base = this.base(this.task());
    if (runner) {
      const counts = parseTestOutput(outcome.output);
      if (ok === true && counts.failed !== null && counts.failed > 0) ok = false;
      this.project.emit({
        type: "TEST_FINISHED",
        ...base,
        payload: {
          command: clip(outcome.command, 500),
          runner,
          ok,
          exit_code: exit,
          passed: counts.passed,
          failed: counts.failed,
          skipped: counts.skipped,
          evidence: exit !== null ? "exit_code" : counts.failed !== null ? "output_parse" : "exit_code",
          output_tail: ok ? "" : tail(outcome.output, maxOut),
          ...(duration !== undefined ? { duration_ms: duration } : {}),
        },
      });
      return;
    }
    this.project.emit({
      type: "COMMAND_EXECUTED",
      ...base,
      payload: {
        command: clip(outcome.command, 500),
        ok,
        exit_code: exit,
        ...(outcome.description ? { description: clip(outcome.description, 200) } : {}),
        ...(ok ? {} : { output_tail: tail(outcome.output, maxOut) }),
        ...(duration !== undefined ? { duration_ms: duration } : {}),
      },
    });
  }

  todos(items: { content: string; status: unknown }[]): void {
    const clean: TodoItem[] = [];
    for (const i of items) {
      const status = normalizeTodoStatus(i.status);
      if (status && i.content) clean.push({ content: i.content, status });
    }
    this.project.emit({ type: "TODOS_UPDATED", ...this.base(this.task()), payload: { items: clean } });
  }

  /** Incremental task-list tools (create/update one item at a time) folded into a snapshot. */
  todoUpsert(key: string, content: string | null, status: unknown): void {
    const snapshot = this.withSession((s) => {
      if (!key) return null;
      const prev = s.todos[key];
      const text = content ?? prev?.content ?? "";
      if (!text) return null;
      const st = status ? normalizeTodoStatus(status) : prev?.status ?? "pending";
      if (st === null) delete s.todos[key];
      else s.todos[key] = { content: text, status: st };
      return Object.values(s.todos);
    });
    if (snapshot) this.project.emit({ type: "TODOS_UPDATED", ...this.base(this.task()), payload: { items: snapshot } });
  }

  subagent(start: boolean, payload: { id?: string | null; agent_type?: string | null; description?: string }): void {
    this.project.emit({
      type: start ? "SUBAGENT_STARTED" : "SUBAGENT_FINISHED",
      ...this.base(this.task()),
      agent_id: this.agent,
      payload: { id: payload.id ?? null, agent_type: payload.agent_type ?? null, description: payload.description ?? payload.agent_type ?? "" },
    });
  }

  /** Commands that started but never reported completion are recorded as unknown. */
  flushStale(maxAgeMs = 60_000): void {
    const cutoff = Date.now() - maxAgeMs;
    const stale = this.withSession((s) => {
      const out = Object.entries(s.pending).filter(([, p]) => Date.parse(p.ts) < cutoff);
      for (const [k] of out) delete s.pending[k];
      return out.map(([, p]) => p);
    });
    const task = this.task();
    for (const p of stale) {
      if (!p.command) continue;
      const runner = detectTestRunner(p.command, this.project.config.tests.commands);
      this.project.emit({
        type: runner ? "TEST_FINISHED" : "COMMAND_EXECUTED",
        ...this.base(task),
        payload: { command: clip(p.command, 500), ok: null, ...(runner ? { runner, evidence: "reported" } : {}), note: "no completion signal" },
      });
    }
  }

  /**
   * Context pressure from a usage ratio (exact or estimated). At fresh_at the
   * state is saved and the user is told to continue in a clean context (/clear)
   * before quality degrades; at compact_at a recovery state is saved in case
   * the agent compacts on its own. Each level is announced once.
   */
  pressure(ratio: number, tokens: number | null, estimated: boolean): string | null {
    const cfg = this.project.config.context;
    const level = ratio >= cfg.compact_at ? 2 : ratio >= cfg.fresh_at ? 1 : 0;
    const prev = this.withSession((s) => {
      const p = s.pressure_level ?? 0;
      s.pressure_level = level;
      return p;
    });
    if (level <= prev) return null;
    const task = this.task();
    const pct = Math.round(ratio * 100);
    const usage = `context usage ${estimated ? "~" : ""}${pct}%${estimated ? " (estimated)" : ""}`;
    this.project.emit({ type: "CONTEXT_PRESSURE", ...this.base(task), payload: { tokens, ratio, level, estimated } });
    if (!task) return level === 1 ? `agent-state: ${usage}. Long contexts degrade; consider /clear and a fresh start.` : null;
    const r = compactTask(this.project, task, { agent_id: this.actor, session_id: this.session_id, status: false });
    const rel = toProjectPath(this.project.root, r.paths.md) ?? r.paths.md;
    const size = r.state.stats.markdown_bytes >= 1024 ? `${(r.state.stats.markdown_bytes / 1024).toFixed(1)} KB` : `${r.state.stats.markdown_bytes} B`;
    if (level === 1) {
      return `agent-state: ${usage}. Task #${task.number} state saved (${size}). To keep quality high, type /clear: the new context starts with just that state instead of the whole conversation.`;
    }
    return `agent-state: ${usage}. A compact recovery state has been generated: ${rel}`;
  }
}

/** One line at session start so the agent feeds the memory it later relies on. */
const GUIDANCE =
  "[agent-state] This project keeps task memory across sessions. When you make a design decision, run " +
  '`agent-state decide "<decision>" --reason "<why>" [--rejected "<alternative>"] [--file <path>]`; ' +
  'when an approach fails, `agent-state note tried "<what failed and why>" [--file <path>]`. ' +
  "Keep it to what a future session must not get wrong.";

const GENERIC_STEMS = new Set(["index", "main", "utils", "util", "helpers", "types", "config", "test", "tests", "readme", "package", "mod", "init", "__init__", "app", "lib", "common", "constants"]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lastLine(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const err = [...lines].reverse().find((l) => /error|fail|exception|cannot|not found|denied/i.test(l));
  return clip(err ?? lines.at(-1) ?? "", 140);
}
