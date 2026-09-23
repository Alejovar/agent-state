import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Project } from "../core/project.js";
import { TaskService } from "../core/tasks.js";
import { buildChangeMap } from "../core/changes.js";
import { reduceState } from "../core/state.js";
import { Checkpoints } from "../core/checkpoint.js";
import { loadRecovery } from "../core/recovery.js";
import { unexpectedFiles } from "../core/scope.js";
import { activeLimits } from "../core/limits.js";
import { box, c, ago, kv, formatBytes, confirm } from "../ui/term.js";
import { gitAvailable } from "../core/git.js";
import { nodeSupported } from "../core/runtime.js";
import { isOurHook, hookConfig } from "../integrations/claude.js";
import { cursorHooks, geminiHooks } from "../integrations/others.js";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { type Command, parse, out, json } from "./types.js";
import { resolveTask } from "./context.js";
import { installClaude, uninstallClaude } from "../integrations/claude.js";
import { installCursor, installGemini, uninstallCursor, uninstallGemini } from "../integrations/others.js";
import { detectAgents, type AgentKind } from "../integrations/detect.js";

export const init: Command = {
  name: "init",
  group: "Core",
  summary: "Set up agent-state in this project and hook into the agents installed here",
  usage: `agent-state init [--claude] [--cursor] [--gemini] [--no-hooks] [--no-gitignore]

  Creates .agent-state/ at the repository root. With no agent flags it detects
  the agents installed on this machine (Claude Code, Cursor, Gemini CLI, Codex)
  and hooks into each of them. Pass flags to choose explicitly.
  --no-hooks       only create .agent-state/, install nothing
  --no-gitignore   do not add .agent-state/ to .gitignore`,
  run(argv) {
    const { values } = parse(
      argv,
      { claude: { type: "boolean" }, cursor: { type: "boolean" }, gemini: { type: "boolean" }, "no-hooks": { type: "boolean" }, "no-gitignore": { type: "boolean" } },
      false,
    );
    const { project, created } = Project.init(process.cwd(), { gitignore: !values["no-gitignore"] });
    out(created ? `${c.green("✓")} agent-state set up in ${project.root}` : `${c.green("✓")} agent-state already set up in ${project.root}`);
    if (!project.git.isRepo()) out(c.yellow("  ⚠ Not a git repository: change tracking and checkpoints are limited."));

    const explicit = values.claude || values.cursor || values.gemini;
    let targets: AgentKind[] = [];
    if (values["no-hooks"]) targets = [];
    else if (explicit) targets = [...(values.claude ? ["claude-code" as const] : []), ...(values.cursor ? ["cursor" as const] : []), ...(values.gemini ? ["gemini-cli" as const] : [])];
    else {
      const found = detectAgents();
      targets = found.map((a) => a.id);
      if (found.length) out(c.dim(`  detected: ${found.map((a) => `${a.name} (${a.evidence})`).join(", ")}`));
    }

    const lines: string[] = [];
    if (targets.includes("claude-code")) lines.push(...installClaude(project));
    if (targets.includes("cursor")) lines.push(...installCursor(project));
    if (targets.includes("gemini-cli")) lines.push(...installGemini(project));
    // Say "install globally" once, not once per agent.
    const unstable = lines.filter((l) => l.startsWith("Hooks call "));
    for (const l of lines.filter((l) => !l.startsWith("Hooks call "))) out(`${c.green("✓")} ${l}`);
    if (unstable.length) out(c.yellow(`  ⚠ ${unstable[0]!.replace(/ for a stable path\.$/, "")} — install it globally (npm i -g agent-state) so the hooks keep working if this folder moves.`));
    if (targets.includes("codex")) {
      out(`${c.yellow("•")} Codex CLI: add ${c.cyan('notify = ["agent-state", "hook", "codex"]')} to ~/.codex/config.toml (global file, so agent-state won't edit it for you)`);
    }

    out("");
    if (!targets.length && !values["no-hooks"]) {
      out(`No agent found on this machine. Hook one in later with ${c.cyan("agent-state init --claude")} (or --cursor / --gemini).`);
      return 0;
    }
    if (targets.length) {
      out(c.bold("What happens now"));
      out("  • Work with your agent as usual: agent-state records the task in the background.");
      out("  • When the context fills up, or you open a new session, the agent gets the task back automatically.");
      out(`  • Anytime: ${c.cyan("agent-state")} (where things stand) · ${c.cyan("agent-state review")} (check the agent's work) · ${c.cyan("agent-state --help")}`);
    }
    return 0;
  },
};

export const uninstall: Command = {
  name: "uninstall",
  group: "Core",
  summary: "Remove agent-state's hooks, slash commands and permissions from this project (--purge also deletes its memory)",
  usage: `agent-state uninstall [--purge] [--yes]

  Removes everything agent-state installed for Claude Code, Cursor and Gemini CLI
  in this project; your own hooks, commands and settings are kept.
  --purge   also delete .agent-state/ (all recorded history and recovery states)
  --yes     don't ask for confirmation`,
  async run(argv) {
    const { values } = parse(argv, { purge: { type: "boolean" }, yes: { type: "boolean", short: "y" } }, false);
    const project = Project.open();
    const lines = [...uninstallClaude(project), ...uninstallCursor(project), ...uninstallGemini(project)];
    for (const l of lines) out(`${c.green("✓")} ${l}`);
    if (!lines.length) out(c.dim("No agent integrations found in this project."));
    if (values.purge) {
      const ok = values.yes || (await confirm(`Delete ${project.paths.state} (all recorded history and recovery states)?`));
      if (!ok) {
        out("Kept .agent-state/.");
        return 0;
      }
      project.close();
      rmSync(project.paths.state, { recursive: true, force: true });
      out(`${c.green("✓")} Deleted .agent-state/`);
    } else {
      out(c.dim("Recorded memory kept in .agent-state/ (delete it with --purge)."));
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
      lines.push("Task: " + c.dim("none yet"));
      lines.push("");
      lines.push(c.dim("It starts by itself with your first request"));
      lines.push(c.dim('to the agent (or: agent-state task new "<goal>")'));
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
    if (nodeSupported()) ok(`Node ${process.versions.node}`);
    else warn(`Node ${process.versions.node}: agent-state needs Node 22.13+ or 23.4+ (node:sqlite)`);
    if (gitAvailable()) ok("git available");
    else warn("git not found — change tracking and checkpoints are unavailable");
    const project = Project.tryOpen();
    if (!project) {
      warn("No .agent-state/ here. Run `agent-state init`.");
      return 1;
    }
    ok(`Project: ${project.root}`);
    if (project.configProblem) {
      warn(`config.yaml has an error; nothing is being recorded until it is fixed: ${project.configProblem}`);
    }
    const evDir = project.paths.events;
    const files = existsSync(evDir) ? readdirSync(evDir).filter((f) => f.endsWith(".jsonl")) : [];
    const bytes = files.reduce((a, f) => a + statSync(join(evDir, f)).size, 0);
    ok(`Event log: ${files.length} file(s), ${formatBytes(bytes)}; db: ${project.db().count()} events`);
    // Integrations: which are installed, and does each hook command still point at something runnable?
    const integrationFiles: [string, string][] = [
      ["Claude Code", join(project.root, ".claude", "settings.local.json")],
      ["Claude Code", join(project.root, ".claude", "settings.json")],
      ["Cursor", join(project.root, ".cursor", "hooks.json")],
      ["Gemini CLI", join(project.root, ".gemini", "settings.json")],
    ];
    const installed = new Map<string, string[]>();
    for (const [agent, file] of integrationFiles) {
      if (!existsSync(file)) continue;
      for (const m of readText(file).matchAll(/"command":\s*"((?:[^"\\]|\\.)*)"/g)) {
        const cmd = JSON.parse(`"${m[1]}"`) as string;
        if (!isOurHook(cmd)) continue;
        installed.set(agent, [...(installed.get(agent) ?? []), cmd]);
      }
    }
    let problems = 0;
    // Hooks written by an older version miss newer events (e.g. StopFailure for usage limits).
    const expected: Record<string, string[]> = {
      "Claude Code": Object.keys(hookConfig("x")),
      Cursor: Object.keys(cursorHooks("x")),
      "Gemini CLI": Object.keys(geminiHooks("x")),
    };
    for (const [agent, file] of integrationFiles) {
      if (!existsSync(file) || !installed.has(agent)) continue;
      let hooks: Record<string, unknown> = {};
      try {
        hooks = ((JSON.parse(readText(file)) as { hooks?: Record<string, unknown> }).hooks ?? {}) as Record<string, unknown>;
      } catch {
        problems++;
        warn(`${file} is not valid JSON; ${agent} will ignore its hooks.`);
        continue;
      }
      const ours = Object.entries(hooks).filter(([, v]) => JSON.stringify(v).match(/hook (?:claude-code|cursor|gemini)/)).map(([k]) => k);
      const missing = expected[agent]!.filter((e) => !ours.includes(e));
      if (ours.length && missing.length) {
        problems++;
        warn(`${agent} hooks are from an older agent-state (missing: ${missing.join(", ")}). Run \`agent-state init\` to update them.`);
      }
    }
    for (const [agent, cmds] of installed) {
      const cmd = cmds[0]!;
      const script = /^node\s+"([^"]+)"/.exec(cmd)?.[1];
      const runnable = script ? existsSync(script) : onPath("agent-state");
      if (runnable) ok(`${agent} hooks installed`);
      else {
        problems++;
        warn(`${agent} hooks call ${script ?? "agent-state"}, which no longer exists. Re-run \`agent-state init\` to repair.`);
      }
    }
    if (!installed.size) warn("No agent hooks installed (run `agent-state init`)");
    const plugin = join(homedir(), ".claude", "plugins");
    if (installed.has("Claude Code") && existsSync(plugin) && readdirSync(plugin, { recursive: true }).some((f) => String(f).endsWith(join("agent-state", ".claude-plugin", "plugin.json")))) {
      warn("The agent-state Claude Code plugin is also installed: events may be recorded twice. Keep one (plugin or project hooks).");
    }
    const errLog = join(project.paths.reports, "hook-errors.log");
    if (existsSync(errLog)) {
      const lines = readText(errLog).split("\n").filter((l) => /^\d{4}-\d{2}-\d{2}T/.test(l));
      const recent = lines.filter((l) => Date.now() - Date.parse(l.slice(0, 24)) < 86_400_000);
      if (recent.length) {
        problems++;
        warn(`${recent.length} hook error(s) in the last 24h; latest: ${recent.at(-1)!.slice(25, 160)}`);
        out(c.dim(`  full log: ${errLog}`));
      }
    }
    const ai = project.config.ai;
    out(kv("AI provider", ai.provider === "none" ? c.dim("none (deterministic only, nothing leaves this machine)") : `${ai.provider}${ai.model ? ` · ${ai.model}` : ""}`));
    const tasks = new TaskService(project).list();
    out(kv("Tasks", `${tasks.length} (${tasks.filter((t) => t.status !== "COMPLETED" && t.status !== "ABANDONED").length} unfinished)`));
    return problems ? 1 : 0;
  },
};

function readText(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function onPath(cmd: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
