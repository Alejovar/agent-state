import type { Evidence, Item, RecoveryState } from "./recovery.js";

const MARK: Record<Evidence, string> = { verified: "✓", recorded: "•", inferred: "?", ai: "~" };

export type RenderMode = "recovery" | "handoff";

interface Section {
  key: string;
  /** Lower = more important; trimmed last. */
  priority: number;
  title: string;
  lines: string[];
  /** Minimum lines kept when trimming (0 allows dropping the section). */
  min: number;
}

function items(list: Item[], prefix?: string): string[] {
  return list.map((i) => `${prefix ?? MARK[i.evidence]} ${i.text}`);
}

function ago(ts: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(ts)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function sections(r: RecoveryState): Section[] {
  const out: Section[] = [];
  const add = (key: string, priority: number, title: string, lines: string[], min = 1): void => {
    if (lines.length) out.push({ key, priority, title, lines, min });
  };

  if (r.conflicts.length) {
    add(
      "conflicts",
      0,
      "⚠ Recovery state conflicts (repository is the source of truth)",
      r.conflicts.map((c) => `- ${c.message}${c.recorded || c.current ? ` (recorded: ${c.recorded ?? "?"} → current: ${c.current ?? "?"})` : ""}`),
      r.conflicts.length,
    );
  }
  add("next", 1, "Next recommended action", [`${MARK[r.next_action.evidence]} ${r.next_action.text}`], 1);
  add("in_progress", 2, "In progress", items(r.in_progress, "- [~]"));
  add("pending", 3, "Pending", items(r.pending, "- [ ]"));
  add("blocked", 3, "Blocked", items(r.blocked, "- [!]"));
  add("issues", 4, "Known issues / current errors", [...items(r.issues), ...items(r.failing_commands)]);
  add(
    "decisions",
    5,
    "Important decisions",
    r.decisions.map((d) => {
      const alt = d.alternatives?.length ? ` Rejected: ${d.alternatives.join(", ")}.` : "";
      return `• #${d.number} ${d.decision}${d.reason ? ` — ${d.reason}` : ""}${alt}`;
    }),
  );
  if (r.unexpected_files.length) {
    add("scope", 5, "⚠ Changes outside declared scope", r.unexpected_files.map((f) => `- ${f}`), r.unexpected_files.length);
  }
  const fileLine = (f: RecoveryState["files"][number]): string => {
    const tag = f.kind === "created" ? "A" : f.kind === "deleted" ? "D" : f.kind === "renamed" ? "R" : "M";
    const ev = f.evidence === "git" ? "✓" : "•";
    return `${ev} ${tag} ${f.path}${f.from ? ` (from ${f.from})` : ""}${f.role !== "source" ? ` [${f.role}]` : ""}`;
  };
  const files = [...r.files].sort((a, b) => b.edits - a.edits || a.path.localeCompare(b.path));
  add("files", 6, `Changed files (${r.files.length})`, files.map(fileLine));
  add(
    "tests",
    7,
    "Tests",
    r.tests.map((t) => {
      const res = t.ok === true ? "passed" : t.ok === false ? "FAILED" : "unknown result";
      const counts = t.passed != null || t.failed != null ? ` (${t.passed ?? "?"} passed, ${t.failed ?? "?"} failed)` : "";
      const stale = t.changed_since ? ` — ⚠ ${t.changed_since} changed file(s) modified since` : "";
      return `• \`${t.command}\` ${res}${counts}, ${ago(t.ts)}${stale}`;
    }),
  );
  add("failed_attempts", 8, "Failed approaches (do not retry blindly)", items(r.failed_attempts, "✗"));
  const depLines = r.dependencies.flatMap((d) => [
    ...d.added.map((a) => `+ ${a} (${d.manifest})`),
    ...d.removed.map((a) => `- ${a} (${d.manifest})`),
    ...d.changed.map((a) => `~ ${a} (${d.manifest})`),
  ]);
  add("deps", 9, "Dependencies", depLines.map((l) => `✓ ${l}`));
  add("hot", 9, "Most-edited files", r.hot_files.map((f) => `• ${f}`), 0);
  add("context", 10, "Relevant context", items(r.context), 0);
  add("completed", 11, "Completed (recorded)", items(r.completed, "- [x]"), 0);
  add(
    "commits",
    12,
    "Commits since task start",
    r.repository.commits_since_base.map((c) => `✓ ${c.sha} ${c.subject}`),
    0,
  );
  add("requests", 13, "Recent user requests (verbatim, most recent last)", r.recent_requests.map((q) => `> ${q.text}`), 0);
  if (r.ai_summary) add("ai", 14, `AI summary (~, ${r.ai_summary.provider})`, [r.ai_summary.text], 0);
  add("unknowns", 15, "Unknown", r.unknowns.map((u) => `? ${u}`), 0);
  return out;
}

function header(r: RecoveryState, mode: RenderMode): string[] {
  const repo = r.repository.is_git
    ? `branch \`${r.repository.branch ?? "detached"}\` @ ${r.repository.head?.slice(0, 7) ?? "(no commits)"}`
    : "no git";
  const title = mode === "handoff" ? `HANDOFF — Task #${r.task.number}` : `RECOVERY CONTEXT — Task #${r.task.number}`;
  const sessions = r.sessions.length ? ` · sessions ${r.sessions.map((s) => s.label).join(", ")}` : "";
  return [
    `# ${title}`,
    "",
    `**Objective:** ${r.objective.text}`,
    "",
    `<sub>agent-state · ${r.project} · ${repo} · status ${r.task.status}${sessions} · generated ${r.generated_at.slice(0, 16).replace("T", " ")}Z</sub>`,
    `<sub>Evidence: ✓ verified in repo · • recorded event · ? inferred · ~ AI. The repository is the source of truth; re-check before relying on anything not ✓.</sub>`,
  ];
}

function footer(mode: RenderMode): string[] {
  return mode === "handoff"
    ? ["", "---", "Continue with: `agent-state recover` (verifies this handoff against the repository)."]
    : [
        "",
        "---",
        "Record progress so the next session can recover it: `agent-state note done|pending|issue|next \"…\"`, `agent-state decide \"…\" --reason \"…\"`.",
      ];
}

/**
 * Renders a recovery state as compact Markdown within `maxBytes`. Lower-value
 * sections are trimmed first; conflicts, the objective and the next action are
 * never dropped.
 */
export function renderMarkdown(r: RecoveryState, opts: { maxBytes: number; mode?: RenderMode }): { markdown: string; truncated: string[] } {
  const mode = opts.mode ?? "recovery";
  const secs = sections(r);
  const limits = new Map<string, number>(secs.map((s) => [s.key, s.lines.length]));
  const truncated = new Set<string>();

  const build = (): string => {
    const out = header(r, mode);
    for (const s of secs) {
      const limit = limits.get(s.key)!;
      if (limit <= 0) continue;
      out.push("", `## ${s.title}`);
      out.push(...s.lines.slice(0, limit));
      if (limit < s.lines.length) out.push(`… ${s.lines.length - limit} more (see \`agent-state recover --json\`)`);
    }
    out.push(...footer(mode));
    return out.join("\n") + "\n";
  };

  let md = build();
  // Trim from the least important section upward until the budget fits.
  const order = [...secs].sort((a, b) => b.priority - a.priority);
  let guard = 0;
  while (Buffer.byteLength(md) > opts.maxBytes && guard++ < 2000) {
    let reduced = false;
    for (const s of order) {
      const cur = limits.get(s.key)!;
      if (cur > s.min) {
        limits.set(s.key, cur > 12 ? Math.ceil(cur / 2) : cur - 1);
        truncated.add(s.key);
        reduced = true;
        break;
      }
    }
    if (!reduced) break;
    md = build();
  }
  return { markdown: md, truncated: [...truncated] };
}
