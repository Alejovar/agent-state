import { spawnSync, execFileSync } from "node:child_process";
import { join } from "node:path";
import { Project } from "../core/project.js";
import { compactTask, recoverTask, resave } from "../core/compact.js";
import { renderMarkdown } from "../core/render.js";
import { writeText } from "../core/store.js";
import { TaskService } from "../core/tasks.js";
import { toProjectPath } from "../core/paths.js";
import { adapterFor, ADAPTERS } from "../adapters/registry.js";
import { aiSummary } from "../ai/enhance.js";
import { c, confirm, formatBytes, ago } from "../ui/term.js";
import { activeLimits } from "../core/limits.js";
import { withCli } from "../core/invocation.js";
import { teammateRecovery } from "../core/team.js";
import { type Command, parse, out, err, json, UsageError } from "./types.js";
import { cliAttribution, resolveTask } from "./context.js";

export const compact: Command = {
  name: "compact",
  group: "Recovery",
  summary: "Compact the task into a minimal, verified recovery state (.md + .json)",
  usage: `agent-state compact [task-id] [--ai] [--json]

  Folds the task's events and the current repository state into the minimum
  information another session needs to continue. Deterministic by default;
  --ai adds a clearly-labelled AI summary if an AI provider is configured.`,
  async run(argv) {
    const { values, positionals } = parse(argv, { ai: { type: "boolean" }, json: { type: "boolean" } });
    const project = Project.open();
    const t = resolveTask(project, positionals[0])!;
    const who = cliAttribution(project);
    let r = compactTask(project, t, who);
    if (values.ai) {
      const summary = await aiSummary(project, r.state, "recovery");
      if (summary) {
        r.state.ai_summary = summary;
        r = resave(project, r.state);
      }
    }
    if (values.json) return json(r.state), 0;
    const s = r.state;
    out(c.bold("Recovery state generated."));
    out("");
    out(`Task:              #${s.task.number} ${s.task.goal}`);
    out(`Completed:         ${s.completed.length} item(s)`);
    out(`Pending:           ${s.pending.length + s.in_progress.length} item(s)`);
    out(`Decisions:         ${s.decisions.length}`);
    out(`Known issues:      ${s.issues.length + s.failing_commands.length}`);
    out(`Changed files:     ${s.files.length}`);
    out(`Recovery size:     ${formatBytes(s.stats.markdown_bytes)} ${c.dim(`(from ${s.stats.events} events${s.stats.truncated.length ? `; trimmed: ${s.stats.truncated.join(", ")}` : ""})`)}`);
    out("");
    out(`Saved: ${toProjectPath(project.root, r.paths.md)}`);
    out(c.dim(`       ${toProjectPath(project.root, r.paths.json)}`));
    if (s.unknowns.length) out(c.dim(`\nUnknown: ${s.unknowns.join(" ")}`));
    return 0;
  },
};

export const recover: Command = {
  name: "recover",
  group: "Recovery",
  summary: "Rebuild verified recovery context for a task (prints Markdown for an agent)",
  usage: `agent-state recover [task-id] [--json] [--agent claude-code|codex|generic] [--max-bytes N] [--raw]
agent-state recover --from <teammate> <task-id>   a teammate's shared task (see \`agent-state team\`)

  Verifies the saved recovery state against git and the filesystem, reports
  conflicts (the repository wins), and prints context ready to hand to an agent.
  --raw   print only the Markdown, without agent framing`,
  run(argv) {
    const { values, positionals } = parse(argv, {
      json: { type: "boolean" },
      agent: { type: "string" },
      "max-bytes": { type: "string" },
      raw: { type: "boolean" },
      from: { type: "string" },
    });
    const project = Project.open();
    if (values.from) {
      if (!positionals[0]) throw new UsageError("Usage: agent-state recover --from <teammate> <task-id>");
      const md = teammateRecovery(project, values.from, Number(positionals[0].replace(/^#|^task_/, "")));
      if (!md) throw new UsageError(`${values.from} has not shared task ${positionals[0]}. Run \`agent-state team\` to fetch and list shared tasks.`);
      const note = `You are picking up task #${positionals[0].replace(/^#|^task_/, "")} from your teammate ${values.from}. This is their shared state; verify it against the repository (their branch may differ from yours).`;
      process.stdout.write(withCli(values.raw ? md : `${note}\n\n${md}`));
      return 0;
    }
    const t = resolveTask(project, positionals[0])!;
    const maxBytes = values["max-bytes"] ? Number(values["max-bytes"]) : undefined;
    if (maxBytes !== undefined && (!Number.isFinite(maxBytes) || maxBytes < 500)) throw new UsageError("--max-bytes must be a number ≥ 500");
    const r = recoverTask(project, t, { maxBytes });
    if (values.json) return json(r.state), 0;
    const adapter = adapterFor(values.agent);
    process.stdout.write(withCli(values.raw ? r.markdown : adapter.formatContext(r.markdown, r.state) + "\n"));
    if (process.stderr.isTTY && !r.saved) err(c.dim("(no saved recovery state yet — built from events + repository; run `agent-state compact` to save one)"));
    return 0;
  },
};

export const handoff: Command = {
  name: "handoff",
  group: "Recovery",
  summary: "Generate a structured handoff for the next session or another agent",
  usage: `agent-state handoff [task-id] [--ai] [--stdout]

  Writes .agent-state/reports/handoff-task-<n>.md (and prints its path), or
  prints it with --stdout. --ai adds an AI-written narrative if configured.`,
  async run(argv) {
    const { values, positionals } = parse(argv, { ai: { type: "boolean" }, stdout: { type: "boolean" } });
    const project = Project.open();
    const t = resolveTask(project, positionals[0])!;
    const r0 = recoverTask(project, t, { mode: "handoff" });
    let markdown = r0.markdown;
    if (values.ai) {
      const summary = await aiSummary(project, r0.state, "handoff");
      if (summary) {
        r0.state.ai_summary = summary;
        markdown = renderMarkdown(r0.state, { maxBytes: project.config.recovery.max_bytes * 2, mode: "handoff" }).markdown;
      }
    }
    if (values.stdout) return process.stdout.write(markdown), 0;
    const path = join(project.paths.reports, `handoff-task-${t.number}.md`);
    writeText(path, markdown);
    out(markdown);
    out(c.dim(`Saved: ${toProjectPath(project.root, path)}`));
    return 0;
  },
};

export const cont: Command = {
  name: "continue",
  group: "Recovery",
  summary: "Resume the latest unfinished task: verify, show what will be restored, start the agent",
  usage: `agent-state continue [task-id] [--agent claude-code|codex|gemini-cli|aider|cursor|generic] [--print] [--yes]

  If Claude Code recently stopped on its usage limit and no --agent is given,
  the task continues in another installed agent (Codex, then Gemini CLI).

  1. finds the latest unfinished task   2. loads its state and recovery state
  3. verifies the repository            4. builds agent-specific continuation context
  5. shows it                            6. launches the agent with it (asks first)
  Never modifies project files. --print only prints the context.`,
  async run(argv) {
    const { values, positionals } = parse(argv, { agent: { type: "string" }, print: { type: "boolean" }, yes: { type: "boolean", short: "y" } });
    const project = Project.open();
    const svc = new TaskService(project);
    const t = positionals[0] ? resolveTask(project, positionals[0])! : svc.latestUnfinished();
    if (!t) {
      out("Nothing to continue: no unfinished tasks.");
      return 0;
    }
    const r = recoverTask(project, t);
    const limits = activeLimits(project);
    let agentId = values.agent;
    let handoff: string | null = null;
    const claudeLimit = limits.find((l) => l.agent_id === "claude-code");
    if (!agentId && claudeLimit) {
      const alt = HANDOFF_ORDER.find((id) => hasBinary(adapterFor(id).launchCommand?.("")?.cmd ?? ""));
      if (alt) {
        agentId = alt;
        out(c.yellow(`Claude Code hit its usage limit ${ago(claudeLimit.ts)} → continuing in ${adapterFor(alt).displayName}, which has its own quota.`));
        out(c.dim("  (Back to Claude after the reset: agent-state continue --agent claude-code)"));
        out("");
      } else {
        out(c.yellow(`Claude Code hit its usage limit ${ago(claudeLimit.ts)}, and no other agent CLI (codex, gemini) is installed.`));
        out(c.dim("  Install one to keep going now, or print the context for any tool: agent-state continue --print --agent generic"));
        out("");
      }
    }
    const adapter = adapterFor(agentId ?? "claude-code");
    const stopped = limits.find((l) => l.agent_id !== adapter.id);
    if (stopped) {
      handoff = `Note: the previous agent (${ADAPTERS[stopped.agent_id]?.displayName ?? stopped.agent_id}) stopped because it reached its usage limit. You are taking over the same task; the work so far is in the repository.`;
    }
    const context = withCli([handoff, adapter.formatContext(r.markdown, r.state)].filter(Boolean).join("\n\n"));
    if (values.print) return process.stdout.write(context + "\n"), 0;

    out(c.bold(`Continue task #${t.number}: ${t.goal}`));
    out(c.dim(`status ${t.status} · ${t.sessions.length} previous session(s) · recovery ${r.saved ? "saved " + r.saved.generated_at.slice(0, 16) : "built fresh"}`));
    out("");
    if (r.state.conflicts.length) {
      out(c.yellow("⚠ RECOVERY STATE CONFLICTS (source of truth: current repository)"));
      for (const cf of r.state.conflicts) out(c.yellow(`  - ${cf.message}`));
      out("");
    }
    out(`Will restore: ${r.state.completed.length} completed · ${r.state.in_progress.length + r.state.pending.length} pending · ${r.state.decisions.length} decisions · ${r.state.issues.length} issues · ${r.state.files.length} changed files`);
    out(`Next action:  ${r.state.next_action.text}`);
    out(`Context size: ${formatBytes(Buffer.byteLength(context))}`);
    out("");

    svc.switchTo(t.id);
    const launch = adapter.launchCommand?.(context) ?? null;
    if (!launch || !hasBinary(launch.cmd)) {
      out(c.dim(`Paste the context below into ${adapter.displayName}, or pipe it: agent-state continue --print`));
      out("");
      out(context);
      return 0;
    }
    const go = values.yes || (await confirm(`Start ${adapter.displayName} with this context?`, true));
    if (!go) {
      out(c.dim("Not started. Print the context with: agent-state continue --print"));
      return 0;
    }
    project.emit({ type: "TASK_UPDATED", ...cliAttribution(project), task_id: t.id, payload: { status: "RECOVERED", reason: "agent-state continue" } });
    project.close();
    const res = spawnSync(launch.cmd, launch.args, { stdio: "inherit" });
    return res.status ?? 0;
  },
};

/** Where a task goes when Claude Code is out of quota, in order of preference. */
const HANDOFF_ORDER = ["codex", "gemini-cli", "aider"];

function hasBinary(cmd: string): boolean {
  if (!cmd) return false;
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export const adaptersCmd: Command = {
  name: "agents",
  group: "Integration",
  summary: "List supported agent adapters",
  usage: "agent-state agents",
  run() {
    for (const a of Object.values(ADAPTERS)) out(`${a.id.padEnd(12)} ${a.displayName}`);
    return 0;
  },
};
