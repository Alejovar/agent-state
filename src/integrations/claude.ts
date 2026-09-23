import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../core/project.js";

/** How hooks and slash commands invoke agent-state. Prefers the binary on PATH. */
export function invocation(): string {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", ["agent-state"], { stdio: "ignore" });
    return "agent-state";
  } catch {
    const script = process.argv[1] ?? "agent-state";
    return `node ${JSON.stringify(script)}`;
  }
}

/** True for hook commands written by agent-state (binary on PATH or `node …/agent-state/dist/cli.js`). */
export function isOurHook(command: unknown): boolean {
  const c = String(command ?? "");
  return /\bhook (?:claude-code|cursor|gemini)\b/.test(c) && c.includes("agent-state");
}

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

export function hookConfig(cmd: string): Record<string, HookEntry[]> {
  const h = (matcher?: string): HookEntry[] => [
    { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: `${cmd} hook claude-code`, timeout: 30 }] },
  ];
  return {
    SessionStart: h(),
    UserPromptSubmit: h(),
    PreToolUse: h("Bash|Write|Edit|MultiEdit|NotebookEdit"),
    PostToolUse: h("Bash|Write|Edit|MultiEdit|NotebookEdit|TodoWrite|TaskCreate|TaskUpdate"),
    PostToolUseFailure: h("Bash|Write|Edit|MultiEdit|NotebookEdit"),
    PreCompact: h(),
    SubagentStart: h(),
    SubagentStop: h(),
    Stop: h(),
    SessionEnd: h(),
  };
}

/** Merges agent-state hooks into a Claude Code settings object, replacing previous agent-state entries. */
export function mergeHooks(settings: Record<string, unknown>, cmd: string): Record<string, unknown> {
  const hooks = { ...((settings.hooks as Record<string, HookEntry[]> | undefined) ?? {}) };
  for (const [event, entries] of Object.entries(hooks)) {
    hooks[event] = (entries ?? [])
      .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((x) => !isOurHook(x.command)) }))
      .filter((e) => e.hooks.length > 0);
    if (!hooks[event]!.length) delete hooks[event];
  }
  for (const [event, entries] of Object.entries(hookConfig(cmd))) hooks[event] = [...(hooks[event] ?? []), ...entries];
  return { ...settings, hooks };
}

export function removeHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = { ...((settings.hooks as Record<string, HookEntry[]> | undefined) ?? {}) };
  for (const [event, entries] of Object.entries(hooks)) {
    hooks[event] = entries
      .map((e) => ({ ...e, hooks: e.hooks.filter((x) => !isOurHook(x.command)) }))
      .filter((e) => e.hooks.length > 0);
    if (!hooks[event]!.length) delete hooks[event];
  }
  const outObj = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete (outObj as Record<string, unknown>).hooks;
  return outObj;
}

export const SLASH_COMMANDS: Record<string, { description: string; hint?: string; run: string; after: string }> = {
  recover: {
    description: "Recover the verified working context of the current task",
    hint: "[task-id]",
    run: "recover $ARGUMENTS",
    after: "Continue the task from the recovery context above. Trust ✓ items; re-verify anything else before relying on it. Do not redo completed work.",
  },
  handoff: {
    description: "Write a handoff for the next session or another agent",
    hint: "[task-id]",
    run: "handoff $ARGUMENTS",
    after: "Show the handoff path to the user. If important decisions, open issues or the next step are missing, record them with `agent-state decide` / `agent-state note` and run /handoff again.",
  },
  checkpoint: {
    description: "Create a safe checkpoint of the working tree and task state",
    hint: "<name>",
    run: "checkpoint $ARGUMENTS",
    after: "Report the checkpoint to the user in one line.",
  },
  restore: {
    description: "Preview restoring a checkpoint (dry run; the user confirms the real restore)",
    hint: "<name>",
    run: "restore $ARGUMENTS --dry-run",
    after: "Summarize what restoring would change and the conflicts. Do NOT run the real restore yourself; tell the user to run `agent-state restore <name>` in their terminal.",
  },
  changes: {
    description: "Show the change map of the current task",
    run: "changes $ARGUMENTS",
    after: "Summarize the change map briefly, highlighting unexpected or indirectly affected files.",
  },
  impact: {
    description: "Analyze what depends on a file",
    hint: "<file>",
    run: "impact $ARGUMENTS",
    after: "Use this impact analysis to decide what to re-test or review.",
  },
  history: {
    description: "Search the agent activity history",
    hint: "[keyword] [--file path] [--task id]",
    run: "history $ARGUMENTS",
    after: "Answer the user's question using this history.",
  },
  why: {
    description: "Explain why a file changed (decisions, tasks, commits)",
    hint: "<file>",
    run: "why $ARGUMENTS",
    after: "Explain concisely why the file changed, citing decision numbers and tasks.",
  },
  drift: {
    description: "Detect contradictions between docs/CLAUDE.md and the code",
    hint: "[path]",
    run: "drift $ARGUMENTS",
    after: "Summarize the drift findings. Never rewrite documentation without the user's approval.",
  },
  index: {
    description: "Query the project index",
    hint: "[query]",
    run: "index $ARGUMENTS",
    after: "Use the index results to answer.",
  },
};

export function slashCommandFile(cmd: string, spec: (typeof SLASH_COMMANDS)[string]): string {
  return [
    "---",
    `description: ${spec.description}`,
    ...(spec.hint ? [`argument-hint: ${spec.hint}`] : []),
    `allowed-tools: Bash(${cmd.startsWith("node ") ? "node" : "agent-state"}:*)`,
    "---",
    "",
    `!\`${cmd} ${spec.run}\``,
    "",
    spec.after,
    "",
  ].join("\n");
}

export function installClaude(project: Project, opts: { shared?: boolean } = {}): string[] {
  const cmd = invocation();
  const dir = join(project.root, ".claude");
  mkdirSync(join(dir, "commands"), { recursive: true });
  const file = join(dir, opts.shared ? "settings.json" : "settings.local.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`${file} is not valid JSON; fix it before installing hooks.`);
    }
  }
  writeFileSync(file, JSON.stringify(mergeHooks(settings, cmd), null, 2) + "\n");
  const written: string[] = [];
  for (const [name, spec] of Object.entries(SLASH_COMMANDS)) {
    const p = join(dir, "commands", `${name}.md`);
    if (existsSync(p) && !readFileSync(p, "utf8").includes("agent-state")) continue; // never clobber user commands
    writeFileSync(p, slashCommandFile(cmd, spec));
    written.push(`/${name}`);
  }
  const lines = [`Claude Code hooks installed in ${file.replace(project.root + "/", "")}`, `Slash commands: ${written.join(" ")}`];
  if (cmd !== "agent-state") lines.push(`Hooks call ${cmd} — install globally (npm i -g agent-state) for a stable path.`);
  return lines;
}

export function uninstallClaude(project: Project): string[] {
  const out: string[] = [];
  for (const name of ["settings.json", "settings.local.json"]) {
    const file = join(project.root, ".claude", name);
    if (!existsSync(file)) continue;
    const s = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify(removeHooks(s), null, 2) + "\n");
    out.push(`Removed agent-state hooks from .claude/${name}`);
  }
  return out;
}
