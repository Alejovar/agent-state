import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "./project.js";
import type { Task } from "./tasks.js";
import { buildChangeMap, type ChangedFile } from "./changes.js";
import { reduceState } from "./state.js";
import { unexpectedFiles } from "./scope.js";
import { ProjectIndex } from "../index/indexer.js";

/**
 * Review brief: everything a human needs to judge an agent's work quickly —
 * what was asked, what changed, why, how it was verified, and where to look
 * closely. Deterministic: git diff, recorded events and the import graph.
 */

export type Severity = "high" | "medium" | "low";

export interface ReviewFlag {
  severity: Severity;
  file: string | null;
  message: string;
}

export interface ReviewFile {
  path: string;
  kind: ChangedFile["kind"];
  role: ChangedFile["role"];
  added: number;
  removed: number;
  dependents: number;
  covered_by_tests: boolean | null;
  flags: number;
}

export interface ReviewBrief {
  task: { number: number; goal: string; status: string };
  agents: string[];
  sessions: number;
  requests: string[];
  commits: { sha: string; subject: string }[];
  files: ReviewFile[];
  totals: { files: number; added: number; removed: number };
  dependencies: { manifest: string; added: string[]; removed: string[]; changed: string[] }[];
  decisions: { number: number; decision: string; reason?: string; alternatives?: string[] }[];
  failed_attempts: string[];
  tests: { command: string; ok: boolean | null; passed: number | null; failed: number | null; stale: boolean }[];
  flags: ReviewFlag[];
  review_order: string[];
}

/** Patterns in *added* lines that deserve a human look. */
const ADDED_LINE_RULES: { re: RegExp; severity: Severity; message: string; tests?: boolean }[] = [
  { re: /\b(?:it|test|describe)\.(?:skip|todo)\s*\(|\bx(?:it|describe)\s*\(|@pytest\.mark\.skip|\bt\.Skip\(|#\[ignore\]/, severity: "high", message: "skips a test", tests: true },
  { re: /\b(?:it|test|describe)\.only\s*\(|\bf(?:it|describe)\s*\(/, severity: "high", message: "focuses a test (.only): the rest of the suite stops running", tests: true },
  { re: /@ts-ignore|@ts-nocheck|@ts-expect-error/, severity: "medium", message: "silences the TypeScript compiler" },
  { re: /eslint-disable|biome-ignore|# ?noqa|# ?type: ?ignore|#!\[allow\(|@SuppressWarnings|nolint/, severity: "medium", message: "silences a linter or type checker" },
  { re: /catch\s*(?:\([^)]*\))?\s*\{\s*\}|except[^:\n]*:\s*pass\b|\.catch\(\s*\(\)\s*=>\s*(?:\{\s*\}|undefined|null)\s*\)/, severity: "medium", message: "swallows an error silently" },
  { re: /\bas any\b|:\s*any\b/, severity: "low", message: "adds an `any` type" },
  { re: /\b(?:TODO|FIXME|XXX|HACK)\b/, severity: "low", message: "leaves a TODO/FIXME" },
  { re: /\bconsole\.log\(|\bprint\(|\bdebugger\b|\bpdb\.set_trace\(\)|\bdbg!\(/, severity: "low", message: "leaves debugging output" },
  { re: /(?:password|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{6,}["']/i, severity: "high", message: "hardcodes something that looks like a credential" },
  { re: /\bexpect\([^)]*\)\.(?:toBeTruthy|toBeDefined)\(\)\s*;?\s*$|assert\s+True\b/, severity: "low", message: "adds a very weak assertion", tests: true },
];

/** Decodes a path as git prints it in diff headers (C-style quoted when it has special characters). */
function unquoteGitPath(p: string): string {
  if (!p.startsWith('"')) return p;
  const bytes: number[] = [];
  const body = p.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[++i]!;
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(({ n: 10, t: 9, r: 13, '"': 34, "\\": 92 } as Record<string, number>)[next] ?? next.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Parses `git diff -U0` output into added / removed lines per file. Header
 * lines are only recognized between `diff --git` and the first hunk, so code
 * lines that start with "++" or "--" are never mistaken for headers.
 */
function parseDiff(diff: string): Map<string, { added: string[]; removed: number }> {
  const files = new Map<string, { added: string[]; removed: number }>();
  let cur: { added: string[]; removed: number } | null = null;
  let inHeader = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      cur = null;
      continue;
    }
    if (inHeader) {
      if (line.startsWith("+++ ")) {
        // git appends a TAB after paths that contain spaces.
        const raw = unquoteGitPath(line.slice(4).replace(/\t$/, ""));
        if (raw !== "/dev/null") {
          const p = raw.replace(/^b\//, "");
          cur = files.get(p) ?? { added: [], removed: 0 };
          files.set(p, cur);
        }
      } else if (line.startsWith("@@")) inHeader = false;
      continue;
    }
    if (line.startsWith("@@")) continue;
    if (cur && line.startsWith("+")) cur.added.push(line.slice(1));
    else if (cur && line.startsWith("-")) cur.removed++;
  }
  return files;
}

export function buildReview(project: Project, task: Task): ReviewBrief {
  const db = project.db();
  const events = db.query({ task_id: task.id });
  const ws = reduceState(task.id, events);
  const map = buildChangeMap(project, task, ws);
  const git = project.git;

  // Line-level changes relative to the task's base (committed + uncommitted).
  const diffs = new Map<string, { added: string[]; removed: number }>();
  const deletedLines = new Map<string, number>();
  if (map.is_git) {
    const base = task.base_head && git.hasCommit(task.base_head) ? task.base_head : git.head() ?? null;
    if (base) {
      const raw = git.tryRun(["diff", "-U0", "--no-color", "--no-ext-diff", base, "--"]) ?? "";
      for (const [p, d] of parseDiff(raw)) diffs.set(p, d);
      // -z: paths are never quoted or escaped.
      for (const rec of (git.tryRun(["diff", "--numstat", "-z", "--no-renames", base, "--"]) ?? "").split("\0")) {
        const [, del, path] = rec.split("\t");
        if (path && del && del !== "-") deletedLines.set(path, Number(del));
      }
    }
  }
  for (const f of map.files) {
    if (diffs.has(f.path) || f.kind === "deleted") continue;
    // Untracked new files: every line is added.
    const abs = join(project.root, f.path);
    if (existsSync(abs) && statSync(abs).size < 1_000_000) {
      const text = readFileSync(abs, "utf8");
      if (!text.includes("\u0000")) diffs.set(f.path, { added: text.replace(/\n$/, "").split("\n"), removed: 0 });
    }
  }

  const idx = new ProjectIndex(project);
  idx.update();

  const flags: ReviewFlag[] = [];
  const files: ReviewFile[] = [];
  for (const f of map.files) {
    if (f.path.startsWith(".agent-state/")) continue;
    const d = diffs.get(f.path) ?? { added: [], removed: deletedLines.get(f.path) ?? 0 };
    const role = f.role;
    const isTest = role === "test";
    let fileFlags = 0;
    const seen = new Set<string>();
    for (const line of d.added) {
      for (const rule of ADDED_LINE_RULES) {
        if (rule.tests && !isTest) continue;
        if (!rule.re.test(line) || seen.has(rule.message)) continue;
        seen.add(rule.message);
        flags.push({ severity: rule.severity, file: f.path, message: rule.message });
        fileFlags++;
      }
    }
    if (isTest && f.kind === "deleted") {
      flags.push({ severity: "high", file: f.path, message: "deletes a test file" });
      fileFlags++;
    } else if (isTest && d.removed > d.added.length + 5) {
      flags.push({ severity: "medium", file: f.path, message: `removes more test code than it adds (−${d.removed} / +${d.added.length})` });
      fileFlags++;
    }
    if (role === "infrastructure") {
      flags.push({ severity: "medium", file: f.path, message: "changes infrastructure / CI" });
      fileFlags++;
    } else if (role === "config" && !/(^|\/)\.gitignore$/.test(f.path)) {
      flags.push({ severity: "low", file: f.path, message: "changes configuration" });
      fileFlags++;
    }
    const deps = f.kind === "deleted" ? 0 : idx.dependents(f.path, 3).size;
    const covered = role === "source" && f.kind !== "deleted" ? idx.testsFor(f.path).length > 0 : null;
    if (covered === false && d.added.length > 10) {
      flags.push({ severity: "medium", file: f.path, message: "changed code with no test that imports it" });
      fileFlags++;
    }
    if (deps >= 5 && f.kind !== "created") {
      flags.push({ severity: "medium", file: f.path, message: `${deps} files depend on it` });
      fileFlags++;
    }
    files.push({ path: f.path, kind: f.kind, role, added: d.added.length, removed: d.removed, dependents: deps, covered_by_tests: covered, flags: fileFlags });
  }

  for (const dep of map.dependencies) {
    if (dep.added.length) flags.push({ severity: "medium", file: dep.manifest, message: `adds dependencies: ${dep.added.join(", ")}` });
    if (dep.removed.length) flags.push({ severity: "low", file: dep.manifest, message: `removes dependencies: ${dep.removed.join(", ")}` });
  }
  for (const u of unexpectedFiles(project, task)) flags.push({ severity: "high", file: u, message: "is outside the task's declared scope" });

  // Verification: latest result per test command, stale if code changed afterwards.
  const changedSource = files.filter((f) => f.kind !== "deleted").map((f) => f.path);
  const tests = ws.tests.map((t) => {
    const at = Date.parse(t.ts);
    const stale = changedSource.some((p) => {
      try {
        return statSync(join(project.root, p)).mtimeMs > at + 1000;
      } catch {
        return false;
      }
    });
    return { command: t.command, ok: t.ok ?? null, passed: t.passed ?? null, failed: t.failed ?? null, stale };
  });
  const sourceChanged = files.some((f) => f.role === "source");
  if (sourceChanged && !tests.length) flags.push({ severity: "high", file: null, message: "no test run was recorded for this task" });
  for (const t of tests) {
    if (t.ok === false) flags.push({ severity: "high", file: null, message: `tests fail: \`${t.command}\`${t.failed != null ? ` (${t.failed} failed)` : ""}` });
    else if (t.stale) flags.push({ severity: "medium", file: null, message: `code changed after the last \`${t.command}\` run` });
  }

  const weight: Record<Severity, number> = { high: 100, medium: 10, low: 1 };
  const score = new Map<string, number>();
  for (const fl of flags) if (fl.file) score.set(fl.file, (score.get(fl.file) ?? 0) + weight[fl.severity]);
  const review_order = [...files]
    .filter((f) => f.role !== "documentation")
    .sort((a, b) => (score.get(b.path) ?? 0) - (score.get(a.path) ?? 0) || b.dependents - a.dependents || b.added + b.removed - (a.added + a.removed))
    .map((f) => f.path);

  flags.sort((a, b) => weight[b.severity] - weight[a.severity]);
  const agents = [...new Set(task.sessions.map((s) => s.agent_id.split(":")[0]!))];
  return {
    task: { number: task.number, goal: task.goal, status: task.status },
    agents,
    sessions: task.sessions.length,
    requests: ws.requests.map((r) => r.text),
    commits: map.commits,
    files,
    totals: { files: files.length, added: files.reduce((a, f) => a + f.added, 0), removed: files.reduce((a, f) => a + f.removed, 0) },
    dependencies: map.dependencies,
    decisions: ws.decisions.map((d) => ({ number: d.number, decision: d.decision, ...(d.reason ? { reason: d.reason } : {}), ...(d.alternatives ? { alternatives: d.alternatives } : {}) })),
    failed_attempts: ws.failed_attempts.map((f) => f.text),
    tests,
    flags,
    review_order,
  };
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};

/** Markdown suitable for a terminal, a PR description or a chat message. */
export function renderReview(b: ReviewBrief): string {
  const out: string[] = [];
  const high = b.flags.filter((f) => f.severity === "high").length;
  const medium = b.flags.filter((f) => f.severity === "medium").length;
  out.push(`# Review brief — Task #${b.task.number}: ${b.task.goal}`);
  out.push("");
  out.push(
    `${b.totals.files} files · +${b.totals.added} −${b.totals.removed} lines · ${b.sessions} session(s) by ${b.agents.join(", ") || "unknown"}` +
      (b.commits.length ? ` · ${b.commits.length} commit(s)` : "") +
      ` · **${high ? `${high} to check carefully` : "nothing high-risk"}**${medium ? `, ${medium} worth a look` : ""}`,
  );
  if (b.requests.length) {
    out.push("", "## What was asked");
    const shown = b.requests.length > 3 ? [b.requests[0]!, ...b.requests.slice(-2)] : b.requests;
    for (const r of shown) out.push(`> ${clip(r, 240)}`);
    if (b.requests.length > 3) out.push(`> … ${b.requests.length - 3} more request(s)`);
  }
  if (b.flags.length) {
    out.push("", "## Look closely at");
    const icon: Record<Severity, string> = { high: "🔴", medium: "🟡", low: "⚪" };
    for (const f of b.flags.slice(0, 20)) out.push(`- ${icon[f.severity]} ${f.file ? `\`${f.file}\` ` : ""}${f.message}`);
    if (b.flags.length > 20) out.push(`- … ${b.flags.length - 20} more`);
  }
  if (b.decisions.length || b.failed_attempts.length) {
    out.push("", "## Why it looks like this");
    for (const d of b.decisions) {
      out.push(`- Decision #${d.number}: ${d.decision}${d.reason ? ` — ${d.reason}` : ""}${d.alternatives?.length ? ` (rejected: ${d.alternatives.join(", ")})` : ""}`);
    }
    for (const f of b.failed_attempts) out.push(`- Tried and dropped: ${clip(f, 200)}`);
  }
  out.push("", "## How it was verified");
  if (!b.tests.length) out.push("- No test runs recorded.");
  for (const t of b.tests) {
    const res = t.ok === true ? "passed" : t.ok === false ? "FAILED" : "result unknown";
    const counts = t.passed != null || t.failed != null ? ` (${t.passed ?? "?"} passed, ${t.failed ?? "?"} failed)` : "";
    out.push(`- \`${t.command}\` ${res}${counts}${t.stale ? " — code changed after this run" : ""}`);
  }
  if (b.dependencies.length) {
    out.push("", "## Dependencies");
    for (const d of b.dependencies) {
      for (const a of d.added) out.push(`- + ${a} (${d.manifest})`);
      for (const r of d.removed) out.push(`- − ${r} (${d.manifest})`);
      for (const ch of d.changed) out.push(`- ~ ${ch} (${d.manifest})`);
    }
  }
  if (b.files.length) {
    out.push("", "## Suggested review order");
    const byPath = new Map(b.files.map((f) => [f.path, f]));
    const ordered = [...b.review_order, ...b.files.filter((f) => !b.review_order.includes(f.path)).map((f) => f.path)];
    for (const [i, p] of ordered.slice(0, 25).entries()) {
      const f = byPath.get(p)!;
      const kind = f.kind === "created" ? "new" : f.kind;
      const bits = [`+${f.added} −${f.removed}`, kind];
      if (f.dependents) bits.push(`${f.dependents} dependent(s)`);
      if (f.covered_by_tests === false) bits.push("no test imports it");
      out.push(`${i + 1}. \`${p}\` — ${bits.join(", ")}`);
    }
    if (ordered.length > 25) out.push(`… ${ordered.length - 25} more`);
  }
  if (b.commits.length) {
    out.push("", "## Commits");
    for (const cm of b.commits.slice(0, 15)) out.push(`- ${cm.sha} ${cm.subject}`);
  }
  out.push("", `<sub>Generated by agent-state from git and recorded agent activity; flags are heuristics, not verdicts.</sub>`);
  return out.join("\n") + "\n";
}

