import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Project } from "../core/project.js";
import { TaskService } from "../core/tasks.js";
import { buildChangeMap } from "../core/changes.js";
import { reduceState } from "../core/state.js";
import { Checkpoints } from "../core/checkpoint.js";
import { loadRecovery } from "../core/recovery.js";
import { unexpectedFiles } from "../core/scope.js";
import { activeLimits } from "../core/limits.js";
import { box, c, ago, kv, formatBytes } from "../ui/term.js";
import { gitAvailable } from "../core/git.js";
import { type Command, parse, out, json } from "./types.js";
import { resolveTask } from "./context.js";
import { installClaude } from "../integrations/claude.js";
import { installCursor, installGemini } from "../integrations/others.js";

export const init: Command = {
  name: "init",
  group: "Core",
  summary: "Initialize agent-state in this project",
  usage: `agent-state init [--claude] [--cursor] [--gemini] [--no-gitignore]

  Creates .agent-state/ at the repository root (config, event log, state db).
  --claude         also install Claude Code hooks and slash commands (.claude/)
  --cursor         also install Cursor hooks (.cursor/hooks.json)
  --gemini         also install Gemini CLI hooks (.gemini/settings.json)
  --no-gitignore   do not add .agent-state/ to .gitignore`,
  run(argv) {
    const { values } = parse(argv, { claude: { type: "boolean" }, cursor: { type: "boolean" }, gemini: { type: "boolean" }, "no-gitignore": { type: "boolean" } }, false);
    const { project, created } = Project.init(process.cwd(), { gitignore: !values["no-gitignore"] });
    out(created ? `${c.green("✓")} Project initialized: ${project.root}` : `${c.green("✓")} Already initialized: ${project.root}`);
    out(c.dim(`  state: ${project.paths.state}`));
    if (!project.git.isRepo()) out(c.yellow("  ⚠ Not a git repository — change tracking and checkpoints are limited."));
    const lines = [
      ...(values.claude ? installClaude(project) : []),
      ...(values.cursor ? installCursor(project) : []),
      ...(values.gemini ? installGemini(project) : []),
    ];
    for (const l of lines) out(`${c.green("✓")} ${l}`);
    if (!lines.length) {
      out("");
      out(`Next: ${c.cyan("agent-state init --claude")} (or --cursor / --gemini) to hook into your agent, or ${c.cyan('agent-state task new "<goal>"')}.`);
    }
    return 0;
  },
};

export const status: Command = {
  name: "status",
  aliases: ["st"],
  group: "Core",
  summary: "Concise overview of the current task, changes, tests, scope and recovery",
  usage: "agent-state status [--json]",
  run(argv) {
    const { values } = parse(argv, { json: { type: "boolean" } }, false);
    const project = Project.open();
    const task = resolveTask(project, undefined, { required: false });
    const events = task ? project.db().query({ task_id: task.id }) : [];
    const ws = task ? reduceState(task.id, events) : null;
    const changes = buildChangeMap(project, task, ws);
    const cps = project.git.isRepo() ? new Checkpoints(project).list() : [];
    const recovery = task ? loadRecovery(project, task.number) : null;
    const unexpected = task ? unexpectedFiles(project, task) : [];
    const lastTest = ws?.tests.at(-1) ?? null;
    const session = task?.sessions.at(-1) ?? null;
    const cur = project.current();

    if (values.json) {
      json({
        project: project.name,
        root: project.root,
        task: task ? { id: task.id, number: task.number, goal: task.goal, status: task.status } : null,
        session: session ? { id: session.id, label: session.label, agent_id: session.agent_id, active: !session.ended_at } : null,
        branch: changes.branch,
        head: changes.head,
        changes: changes.files.length,
        tests: lastTest ? { ok: lastTest.ok, passed: lastTest.passed, failed: lastTest.failed, ts: lastTest.ts } : null,
        unexpected_files: unexpected,
        recovery: recovery ? { generated_at: recovery.generated_at, bytes: recovery.stats.markdown_bytes } : null,
        checkpoint: cps[0]?.name ?? null,
        usage_limits: activeLimits(project),
      });
      return 0;
    }

    const lines: string[] = [];
    lines.push(`Project: ${project.name}${changes.branch ? c.dim(`  (${changes.branch} @ ${changes.head?.slice(0, 7) ?? "—"})`) : ""}`);
    if (!task) {
      lines.push("Task: " + c.dim("none"));
      lines.push("");
      lines.push(c.dim('Start: agent-state task new "<goal>"'));
    } else {
      lines.push(`Session: ${session ? `${session.label}${session.ended_at ? c.dim(" (ended)") : ""}` : c.dim("none")}`);
      lines.push(`Task: #${task.number} ${truncate(task.goal, 52)}`);
      lines.push("");
      const statusColor = task.status === "ACTIVE" || task.status === "RECOVERED" ? c.green : task.status === "COMPLETED" ? c.blue : c.yellow;
      lines.push(`Status: ${statusColor(task.status)}`);
      lines.push("");
      lines.push(`Changes: ${changes.files.length} file${changes.files.length === 1 ? "" : "s"}${changes.commits.length ? c.dim(` · ${changes.commits.length} commit(s)`) : ""}`);
      const pending = ws?.todos?.items.filter((t) => t.status !== "completed").length ?? 0;
      const done = ws?.todos?.items.filter((t) => t.status === "completed").length ?? 0;
      if (ws?.todos) lines.push(`Todos: ${done} done · ${pending} open`);
      if (lastTest) {
        const res =
          lastTest.ok === true
            ? c.green(`${lastTest.passed ?? "?"} passed`)
            : lastTest.ok === false
              ? c.red(`FAILED${lastTest.failed != null ? ` (${lastTest.failed})` : ""}`)
              : c.yellow("unknown");
        lines.push(`Tests: ${res} ${c.dim(ago(lastTest.ts))}`);
      } else lines.push(`Tests: ${c.dim("none recorded")}`);
      const openIssues = ws?.issues.filter((i) => !i.resolved).length ?? 0;
      if (openIssues) lines.push(`Issues: ${c.yellow(String(openIssues))} open`);
      lines.push(`Scope: ${unexpected.length ? c.yellow(`⚠ ${unexpected.length} unexpected file${unexpected.length === 1 ? "" : "s"}`) : c.green("ok")}`);
      lines.push("");
      lines.push(`Recovery: ${recovery ? `${c.green("SAVED")} ${c.dim(`${ago(recovery.generated_at)}, ${formatBytes(recovery.stats.markdown_bytes)}`)}` : c.dim("not saved")}`);
    }
    lines.push(`Checkpoint: ${cps[0] ? `${cps[0].name} ${c.dim(ago(cps[0].created_at))}` : c.dim("none")}`);
    for (const l of activeLimits(project)) {
      lines.push("");
      lines.push(c.yellow(`⚠ ${l.agent_id} hit its usage limit ${ago(l.ts)}`));
      lines.push(c.dim("  continue now in another agent: agent-state continue"));
    }
    if (cur.session_id && cur.agent_id) lines.push(c.dim(`Agent: ${cur.agent_id} · last activity ${ago(cur.updated_at)}`));
    out(box("AGENT STATE", lines));
    return 0;
  },
};

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export const rebuild: Command = {
  name: "rebuild",
  group: "Core",
  summary: "Rebuild the SQLite projection from the append-only event log",
  usage: "agent-state rebuild",
  run() {
    const project = Project.open();
    const n = project.store.rebuild();
    out(`${c.green("✓")} Rebuilt state.db from events: ${n} events`);
    return 0;
  },
};

export const doctor: Command = {
  name: "doctor",
  group: "Core",
  summary: "Check installation, integrations and state health",
  usage: "agent-state doctor",
  run() {
    const ok = (s: string) => out(`${c.green("✓")} ${s}`);
    const warn = (s: string) => out(`${c.yellow("⚠")} ${s}`);
    const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
    if (major > 22 || (major === 22 && minor >= 13)) ok(`Node ${process.versions.node}`);
    else warn(`Node ${process.versions.node} — agent-state needs Node ≥ 22.13 (node:sqlite)`);
    if (gitAvailable()) ok("git available");
    else warn("git not found — change tracking and checkpoints are unavailable");
    const project = Project.tryOpen();
    if (!project) {
      warn("No .agent-state/ here. Run `agent-state init`.");
      return 1;
    }
    ok(`Project: ${project.root}`);
    const evDir = project.paths.events;
    const files = existsSync(evDir) ? readdirSync(evDir).filter((f) => f.endsWith(".jsonl")) : [];
    const bytes = files.reduce((a, f) => a + statSync(join(evDir, f)).size, 0);
    ok(`Event log: ${files.length} file(s), ${formatBytes(bytes)}; db: ${project.db().count()} events`);
    const settings = join(project.root, ".claude", "settings.json");
    const local = join(project.root, ".claude", "settings.local.json");
    const hasHooks = [settings, local].some((p) => existsSync(p) && /agent-state[^"]*hook/.test(readText(p)));
    const cursorHooks = join(project.root, ".cursor", "hooks.json");
    const geminiSettings = join(project.root, ".gemini", "settings.json");
    const hasCursor = existsSync(cursorHooks) && readText(cursorHooks).includes("agent-state hook");
    const hasGemini = existsSync(geminiSettings) && readText(geminiSettings).includes("agent-state hook");
    if (hasHooks) ok("Claude Code hooks installed");
    if (hasCursor) ok("Cursor hooks installed");
    if (hasGemini) ok("Gemini CLI hooks installed");
    if (!hasHooks && !hasCursor && !hasGemini) warn("No agent hooks installed (run `agent-state init --claude`, `--cursor` or `--gemini`)");
    const ai = project.config.ai;
    out(kv("AI provider", ai.provider === "none" ? c.dim("none (deterministic only, nothing leaves this machine)") : `${ai.provider}${ai.model ? ` · ${ai.model}` : ""}`));
    const tasks = new TaskService(project).list();
    out(kv("Tasks", `${tasks.length} (${tasks.filter((t) => t.status !== "COMPLETED" && t.status !== "ABANDONED").length} unfinished)`));
    return 0;
  },
};

function readText(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
