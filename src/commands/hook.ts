import * as fs from "node:fs";
import { Project } from "../core/project.js";
import { ClaudeHookHandler, type ClaudeHookInput } from "../adapters/claude-hooks.js";
import { handleCodexNotification, type CodexNotification } from "../adapters/codex.js";
import { EVENT_TYPES, type EventType } from "../core/events.js";
import { type Command, parse, out, UsageError } from "./types.js";
import { cliAttribution, resolveTask } from "./context.js";
import { installClaude, uninstallClaude } from "../integrations/claude.js";
import { c } from "../ui/term.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const ch of process.stdin) chunks.push(ch as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export const hook: Command = {
  name: "hook",
  group: "Integration",
  summary: "Entry point for agent integrations (Claude Code hooks, Codex notify)",
  usage: `agent-state hook claude-code     reads a Claude Code hook payload on stdin
agent-state hook codex <json>     Codex CLI notify payload (last argument)

Hooks never fail the agent: errors are logged to .agent-state/reports/hook-errors.log.`,
  async run(argv) {
    const [agent, ...rest] = argv;
    const project = Project.tryOpen(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
    // Not an agent-state project: stay silent so a global hook config is harmless.
    if (!project) return 0;
    try {
      if (agent === "claude-code" || agent === "claude") {
        const raw = await readStdin();
        const input = JSON.parse(raw || "{}") as ClaudeHookInput;
        const res = new ClaudeHookHandler(project).handle(input);
        if (res.stdout) process.stdout.write(res.stdout);
        if (res.stderr) process.stderr.write(res.stderr);
        return res.exitCode;
      }
      if (agent === "codex") {
        const payload = rest.at(-1) ?? (await readStdin());
        handleCodexNotification(project, JSON.parse(payload || "{}") as CodexNotification);
        return 0;
      }
      throw new UsageError(`Unknown agent "${agent ?? ""}". Supported: claude-code, codex.`);
    } catch (err) {
      if (err instanceof UsageError) throw err;
      logHookError(project, err);
      return 0;
    } finally {
      project.close();
    }
  },
};

function logHookError(project: Project, err: unknown): void {
  try {
    const { appendFileSync, mkdirSync } = fs;
    mkdirSync(project.paths.reports, { recursive: true });
    appendFileSync(`${project.paths.reports}/hook-errors.log`, `${new Date().toISOString()} ${(err as Error)?.stack ?? String(err)}\n`);
  } catch {
    // never break the agent
  }
}


export const event: Command = {
  name: "event",
  group: "Integration",
  summary: "Record a normalized event from any agent or script (generic adapter)",
  usage: `agent-state event <TYPE> [--json '<payload>'] [--agent <id>] [--session <id>] [--task <id>]
  e.g. agent-state event FILE_MODIFIED --json '{"path":"src/a.ts"}' --agent cursor
Types: ${EVENT_TYPES.join(", ")}`,
  async run(argv) {
    const { values, positionals } = parse(argv, { json: { type: "string" }, agent: { type: "string" }, session: { type: "string" }, task: { type: "string" } });
    const type = positionals[0]?.toUpperCase() as EventType | undefined;
    if (!type || !EVENT_TYPES.includes(type)) throw new UsageError(event.usage);
    const project = Project.open();
    let payload: Record<string, unknown> = {};
    const raw = values.json ?? (await readStdin());
    if (raw.trim()) {
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new UsageError("--json must be a JSON object");
      }
    }
    const t = resolveTask(project, values.task, { required: false });
    const who = cliAttribution(project);
    const e = project.emit({
      type,
      agent_id: values.agent ?? who.agent_id,
      session_id: values.session ?? who.session_id,
      task_id: t?.id ?? null,
      payload,
    });
    out(e.id);
    return 0;
  },
};

export const integrate: Command = {
  name: "integrate",
  aliases: ["install"],
  group: "Integration",
  summary: "Install/uninstall agent integrations (claude-code hooks + slash commands, codex notify)",
  usage: `agent-state integrate claude-code [--shared] [--uninstall]
    --shared   write hooks to .claude/settings.json (committed) instead of settings.local.json
agent-state integrate codex   prints the ~/.codex/config.toml line to add`,
  run(argv) {
    const { values, positionals } = parse(argv, { shared: { type: "boolean" }, uninstall: { type: "boolean" } });
    const agent = positionals[0] ?? "claude-code";
    const project = Project.open();
    if (agent === "claude-code" || agent === "claude") {
      const lines = values.uninstall ? uninstallClaude(project) : installClaude(project, { shared: values.shared });
      for (const l of lines) out(`${c.green("✓")} ${l}`);
      return 0;
    }
    if (agent === "codex") {
      out("Add this to ~/.codex/config.toml (Codex calls it after every agent turn):");
      out("");
      out('  notify = ["agent-state", "hook", "codex"]');
      out("");
      out(c.dim("Codex's notify hook reports turns (requests + final message); file changes are taken from git."));
      return 0;
    }
    throw new UsageError(`Unknown agent "${agent}". Supported: claude-code, codex.`);
  },
};
