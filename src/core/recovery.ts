import { existsSync, statSync, copyFileSync } from "node:fs";
import { hashFile } from "./hash.js";
import { join } from "node:path";
import { buildChangeMap, type ChangeMap, type ChangedFile } from "./changes.js";
import type { DecisionPayload, TodoItem } from "./events.js";
import type { Project } from "./project.js";
import { reduceState, type WorkingState } from "./state.js";
import { readJson, writeJson, writeText } from "./store.js";
import type { Task } from "./tasks.js";

/**
 * Evidence levels. Every statement in a recovery state carries one so an agent
 * never mistakes a guess for a fact.
 *  verified — checked against the repository/filesystem while generating
 *  recorded — observed as an event (agent tool call, test run, CLI entry)
 *  inferred — derived by deterministic heuristics from the above
 *  ai       — produced by an AI provider
 */
export type Evidence = "verified" | "recorded" | "inferred" | "ai";

export interface Item {
  text: string;
  evidence: Evidence;
  source?: string;
}

export interface TestSummary {
  command: string;
  runner: string;
  ok: boolean | null;
  passed: number | null;
  failed: number | null;
  ts: string;
  evidence: Evidence;
  /** Files modified after this test run finished. */
  changed_since: number;
}

export interface Conflict {
  kind: "missing_file" | "branch_changed" | "head_moved" | "file_changed" | "dependency_changed" | "task_completed" | "drift";
  message: string;
  recorded?: string;
  current?: string;
}

export interface RecoveryState {
  schema: "agent-state/recovery@1";
  generated_at: string;
  project: string;
  task: { id: string; number: number; goal: string; status: string; created_at: string; parent_task_id: string | null };
  sessions: { id: string; label: string; agent_id: string; started_at: string; ended_at: string | null }[];
  repository: {
    is_git: boolean;
    branch: string | null;
    head: string | null;
    base_head: string | null;
    commits_since_base: { sha: string; subject: string }[];
  };
  objective: Item;
  in_progress: Item[];
  pending: Item[];
  blocked: Item[];
  completed: Item[];
  issues: Item[];
  failing_commands: Item[];
  failed_attempts: Item[];
  decisions: (DecisionPayload & { evidence: Evidence })[];
  files: ChangedFile[];
  hot_files: string[];
  tests: TestSummary[];
  dependencies: ChangeMap["dependencies"];
  unexpected_files: string[];
  recent_requests: Item[];
  context: Item[];
  next_action: Item;
  unknowns: string[];
  conflicts: Conflict[];
  ai_summary?: { text: string; provider: string; model?: string };
  /** Content hashes of changed files at generation time, to detect later divergence. */
  snapshot: Record<string, string | null>;
  stats: { events: number; sessions: number; compactions: number; markdown_bytes: number; truncated: string[] };
}

const clip = (s: string, n = 240): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};


export interface BuildOptions {
  /** Paths the task scope does not allow (computed by the scope module). */
  unexpected?: string[];
}

/** Assembles a recovery state for `task`, verifying recorded facts against the repository. */
export function buildRecovery(project: Project, task: Task, opts: BuildOptions = {}): RecoveryState {
  const db = project.db();
  const events = db.query({ task_id: task.id });
  const ws = reduceState(task.id, events);
  const changes = buildChangeMap(project, task, ws);
  return assemble(project, task, ws, changes, opts);
}

function assemble(project: Project, task: Task, ws: WorkingState, changes: ChangeMap, opts: BuildOptions): RecoveryState {
  const todoItems: TodoItem[] = ws.todos?.items ?? [];
  const fromTodos = (status: TodoItem["status"]): Item[] =>
    todoItems.filter((t) => t.status === status).map((t) => ({ text: clip(t.content), evidence: "recorded", source: "agent todo list" }));
  const fromManual = (kind: "done" | "pending" | "blocked"): Item[] =>
    ws.manual.filter((m) => m.kind === kind).map((m) => ({ text: clip(m.text), evidence: "recorded", source: "note" }));

  const dedupe = (items: Item[]): Item[] => {
    const seen = new Set<string>();
    return items.filter((i) => {
      const k = i.text.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  const completed = dedupe([...fromTodos("completed"), ...fromManual("done")]);
  const doneKeys = new Set(completed.map((c) => c.text.toLowerCase()));
  const notDone = (i: Item): boolean => !doneKeys.has(i.text.toLowerCase());
  const in_progress = dedupe(fromTodos("in_progress")).filter(notDone);
  const pending = dedupe([...fromTodos("pending"), ...fromManual("pending")]).filter(notDone);
  const blocked = dedupe([...fromTodos("blocked"), ...fromManual("blocked")]).filter(notDone);

  // Tests: recorded results, plus a staleness check against file mtimes (verified).
  const changedPaths = changes.files.filter((f) => f.exists).map((f) => f.path);
  const tests: TestSummary[] = ws.tests.slice(-6).map((t) => {
    const at = Date.parse(t.ts);
    let changedSince = 0;
    for (const p of changedPaths) {
      try {
        if (statSync(join(project.root, p)).mtimeMs > at + 1000) changedSince++;
      } catch {
        // deleted meanwhile
      }
    }
    return {
      command: clip(t.command, 160),
      runner: t.runner,
      ok: t.ok ?? null,
      passed: t.passed ?? null,
      failed: t.failed ?? null,
      ts: t.ts,
      evidence: "recorded",
      changed_since: changedSince,
    };
  });

  const testCommands = new Set(ws.tests.map((t) => t.command));
  const failing_commands: Item[] = ws.commands.failing
    .filter((c) => !testCommands.has(c.command))
    .slice(-4)
    .map((c) => ({
      text: clip(`\`${clip(c.command, 100)}\` failed${c.exit_code != null ? ` (exit ${c.exit_code})` : ""}${c.output_tail ? `: ${lastMeaningfulLine(c.output_tail)}` : ""}`, 300),
      evidence: "recorded",
    }));

  const issues: Item[] = ws.issues.filter((i) => !i.resolved).map((i) => ({ text: clip(i.text, 300), evidence: "recorded" }));
  for (const t of tests) {
    if (t.ok === false) {
      issues.push({
        text: `Tests failing: \`${t.command}\`${t.failed != null ? ` (${t.failed} failed${t.passed != null ? `, ${t.passed} passed` : ""})` : ""}`,
        evidence: "recorded",
        source: "test run",
      });
    }
  }

  // Files the agent touched most are the best proxy for "important code locations".
  const hot_files = [...ws.files.entries()]
    .filter(([p]) => existsSync(join(project.root, p)))
    .sort((a, b) => b[1].count - a[1].count || b[1].ts.localeCompare(a[1].ts))
    .slice(0, 8)
    .map(([p]) => p);

  const unknowns: string[] = [];
  if (!changes.is_git) unknowns.push("Not a git repository: file changes are known only from recorded agent events.");
  if (!ws.tests.length) unknowns.push("No test runs recorded for this task; test status is unknown.");
  if (!ws.todos && !ws.manual.length) unknowns.push("No task list recorded; completed/pending work cannot be listed.");
  if (!ws.decisions.length) unknowns.push("No decisions recorded.");

  const next_action = deriveNext(ws, in_progress, pending, issues, tests);

  const snapshot: Record<string, string | null> = {};
  for (const f of changes.files.slice(0, 200)) snapshot[f.path] = f.exists ? hashFile(join(project.root, f.path)) : null;

  const recent = ws.requests.slice(-3).map((r) => ({ text: clip(r.text, 400), evidence: "recorded" as Evidence }));

  return {
    schema: "agent-state/recovery@1",
    generated_at: new Date().toISOString(),
    project: project.name,
    task: {
      id: task.id,
      number: task.number,
      goal: task.goal,
      status: task.status,
      created_at: task.created_at,
      parent_task_id: task.parent_task_id,
    },
    sessions: task.sessions.map((s) => ({ id: s.id, label: s.label, agent_id: s.agent_id, started_at: s.started_at, ended_at: s.ended_at })),
    repository: {
      is_git: changes.is_git,
      branch: changes.branch,
      head: changes.head,
      base_head: changes.base_head,
      commits_since_base: changes.commits.slice(0, 20),
    },
    objective: { text: task.goal, evidence: "recorded" },
    in_progress,
    pending,
    blocked,
    completed,
    issues,
    failing_commands,
    failed_attempts: ws.failed_attempts.map((f) => ({ text: clip(f.text, 300), evidence: "recorded" })),
    decisions: ws.decisions.map((d) => ({ ...d, evidence: "recorded" as Evidence })),
    files: changes.files,
    hot_files,
    tests,
    dependencies: changes.dependencies,
    unexpected_files: opts.unexpected ?? [],
    recent_requests: recent,
    context: ws.context_notes.slice(-6).map((c) => ({ text: clip(c.text, 300), evidence: "recorded" })),
    next_action,
    unknowns,
    conflicts: [],
    snapshot,
    stats: {
      events: ws.event_count,
      sessions: task.sessions.length,
      compactions: ws.compactions,
      markdown_bytes: 0,
      truncated: [],
    },
  };
}

function lastMeaningfulLine(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const err = [...lines].reverse().find((l) => /error|fail|exception|cannot|not found|denied/i.test(l));
  return clip(err ?? lines[lines.length - 1] ?? "", 160);
}

function deriveNext(ws: WorkingState, inProgress: Item[], pending: Item[], issues: Item[], tests: TestSummary[]): Item {
  if (ws.next) return { text: clip(ws.next.text, 300), evidence: "recorded", source: "explicit next action" };
  if (inProgress[0]) return { text: `Continue: ${inProgress[0].text}`, evidence: "inferred", source: "in-progress item" };
  if (issues[0]) return { text: `Resolve: ${issues[0].text}`, evidence: "inferred", source: "open issue" };
  const staleFail = tests.find((t) => t.ok === false);
  if (staleFail) return { text: `Fix failing tests (\`${staleFail.command}\`)`, evidence: "inferred", source: "test run" };
  if (pending[0]) return { text: pending[0].text, evidence: "inferred", source: "first pending item" };
  return { text: "Unknown — review the objective and changed files, then decide.", evidence: "inferred", source: "no signal" };
}

// ---------------------------------------------------------------------------
// Verification of a previously saved recovery state against the repository.
// ---------------------------------------------------------------------------

/** Compares a saved recovery state with the repository as it is now. Repository wins. */
export function verifyRecovery(project: Project, saved: RecoveryState, fresh: RecoveryState): Conflict[] {
  const conflicts: Conflict[] = [];
  const git = project.git;
  if (saved.repository.is_git && fresh.repository.is_git) {
    if (saved.repository.branch !== fresh.repository.branch) {
      conflicts.push({
        kind: "branch_changed",
        message: "Branch changed since the recovery state was saved.",
        recorded: saved.repository.branch ?? "(detached)",
        current: fresh.repository.branch ?? "(detached)",
      });
    }
    if (saved.repository.head && fresh.repository.head && saved.repository.head !== fresh.repository.head) {
      const newer = git.commitsSince(saved.repository.head, 10);
      conflicts.push({
        kind: "head_moved",
        message: newer.length
          ? `${newer.length} commit(s) since the recovery state: ${newer.slice(0, 3).map((c) => `${c.sha} ${clip(c.subject, 60)}`).join("; ")}`
          : "HEAD moved to a commit that does not descend from the recorded one (rebase/reset/checkout).",
        recorded: saved.repository.head.slice(0, 10),
        current: fresh.repository.head.slice(0, 10),
      });
    }
  }
  for (const [path, hash] of Object.entries(saved.snapshot ?? {})) {
    const full = join(project.root, path);
    const exists = existsSync(full);
    if (hash && !exists) {
      conflicts.push({ kind: "missing_file", message: `Referenced file no longer exists: ${path}`, recorded: "exists", current: "missing" });
    } else if (hash && exists && hashFile(full) !== hash) {
      conflicts.push({ kind: "file_changed", message: `Changed after the recovery state was saved: ${path}` });
    }
  }
  for (const d of saved.decisions) {
    for (const f of d.files ?? []) {
      if (!existsSync(join(project.root, f))) {
        conflicts.push({ kind: "missing_file", message: `Decision #${d.number} references a missing file: ${f}` });
      }
    }
  }
  const savedDeps = new Set(saved.dependencies.flatMap((d) => d.added.map((a) => `${d.manifest}:${a}`)));
  const freshDeps = new Set(fresh.dependencies.flatMap((d) => d.added.map((a) => `${d.manifest}:${a}`)));
  for (const d of savedDeps) {
    if (!freshDeps.has(d)) conflicts.push({ kind: "dependency_changed", message: `Dependency recorded as added is no longer present: ${d}` });
  }
  if (fresh.task.status === "COMPLETED") {
    conflicts.push({ kind: "task_completed", message: "This task is marked COMPLETED." });
  }
  // Collapse noisy per-file changes.
  const changed = conflicts.filter((c) => c.kind === "file_changed");
  if (changed.length > 5) {
    const rest = conflicts.filter((c) => c.kind !== "file_changed");
    rest.push({ kind: "file_changed", message: `${changed.length} files changed after the recovery state was saved.` });
    return rest;
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function recoveryPaths(project: Project, taskNumber: number): { json: string; md: string; prev: string } {
  const base = join(project.paths.recovery, `task-${taskNumber}`);
  return { json: `${base}.json`, md: `${base}.md`, prev: `${base}.prev.json` };
}

export function loadRecovery(project: Project, taskNumber: number): RecoveryState | null {
  const { json } = recoveryPaths(project, taskNumber);
  return existsSync(json) ? readJson<RecoveryState | null>(json, null) : null;
}

export function saveRecovery(project: Project, state: RecoveryState, markdown: string): { json: string; md: string } {
  const p = recoveryPaths(project, state.task.number);
  if (existsSync(p.json)) copyFileSync(p.json, p.prev);
  writeJson(p.json, state);
  writeText(p.md, markdown);
  return { json: p.json, md: p.md };
}
