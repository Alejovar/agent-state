#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { COMMANDS, findCommand } from "./commands/registry.js";
import { UsageError } from "./commands/types.js";
import { ConfigBrokenError, NotInitializedError, Project } from "./core/project.js";
import { configError } from "./core/config.js";
import { CheckpointError } from "./core/checkpoint.js";
import { GitError } from "./core/git.js";
import { c } from "./ui/term.js";

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    return pkg.version;
  } catch {
    return "unknown";
  }
}

function help(): string {
  const groups = new Map<string, typeof COMMANDS>();
  for (const cmd of COMMANDS) {
    if (cmd.name === "hook") continue;
    groups.set(cmd.group, [...(groups.get(cmd.group) ?? []), cmd]);
  }
  const lines = [
    `${c.bold("agent-state")} ${c.dim(`v${version()}`)} — local-first memory, recovery and control for AI coding agents`,
    "",
    `${c.bold("Usage:")} agent-state <command> [options]`,
  ];
  for (const g of ["Core", "Recovery", "Checkpoints", "Intelligence", "Control", "Integration"]) {
    const cmds = groups.get(g);
    if (!cmds?.length) continue;
    lines.push("", c.bold(g));
    for (const cmd of cmds) lines.push(`  ${cmd.name.padEnd(13)} ${cmd.summary}`);
  }
  lines.push("", c.dim("Run `agent-state <command> --help` for details. Docs: https://github.com/Alejovar/agent-state"));
  return lines.join("\n");
}

// Piping into `head` & co. closes stdout early; that is not an error.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split(".").map(Number) as [number, number];
const NODE_OK = NODE_MAJOR > 22 || (NODE_MAJOR === 22 && NODE_MINOR >= 13);

async function main(argv: string[]): Promise<number> {
  if (!NODE_OK) {
    process.stderr.write(`agent-state needs Node.js 22.13 or newer (it uses the built-in node:sqlite). You have ${process.versions.node}.\n`);
    // Hooks must never break the agent, even on an unsupported runtime.
    return argv[0] === "hook" ? 0 : 1;
  }
  const [name, ...rest] = argv;
  // Bare `agent-state` inside a project answers the most common question: where do things stand?
  if (!name && Project.tryOpen()) return await findCommand("status")!.run([]);
  if (!name) {
    process.stdout.write(help() + "\n\n" + c.bold("Get started: ") + c.cyan("agent-state init") + c.dim("  (in your project folder)") + "\n");
    return 0;
  }
  if (name === "help" || name === "--help" || name === "-h") {
    if (name === "help" && rest[0]) {
      const cmd = findCommand(rest[0]);
      if (cmd) return process.stdout.write(`${cmd.summary}\n\n${cmd.usage}\n`), 0;
    }
    process.stdout.write(help() + "\n");
    return 0;
  }
  if (name === "--version" || name === "-v" || name === "version") {
    process.stdout.write(version() + "\n");
    return 0;
  }
  const cmd = findCommand(name);
  if (cmd && name !== "hook") warnConfig();
  if (!cmd) {
    process.stderr.write(`Unknown command "${name}".\n\n${help()}\n`);
    return 2;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(`${cmd.summary}\n\n${cmd.usage}\n`);
    return 0;
  }
  return await cmd.run(rest);
}

function warnConfig(): void {
  const p = Project.tryOpen();
  p?.close();
  if (configError) process.stderr.write(`${c.yellow("⚠ config.yaml has an error; agent-state is not recording until it is fixed:")} ${configError}\n`);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof UsageError || err instanceof NotInitializedError || err instanceof CheckpointError || err instanceof GitError || err instanceof ConfigBrokenError) {
      process.stderr.write(`${c.red("error:")} ${err.message}\n`);
      process.exitCode = err instanceof UsageError ? 2 : 1;
      return;
    }
    process.stderr.write(`${c.red("unexpected error:")} ${(err as Error)?.stack ?? String(err)}\n`);
    process.exitCode = 1;
  },
);
