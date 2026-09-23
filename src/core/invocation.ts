import { execFileSync } from "node:child_process";

let cached: string | null = null;

/**
 * The command that runs agent-state on this machine: `agent-state` when it is
 * on PATH, otherwise `node "<this cli>"`. Every instruction handed to an agent
 * uses it, so the agent never tries a command that doesn't exist here.
 */
export function cliCommand(): string {
  if (cached) return cached;
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", ["agent-state"], { stdio: "ignore" });
    cached = "agent-state";
  } catch {
    const script = process.argv[1];
    cached = script && /cli\.[cm]?js$/.test(script) ? `node ${JSON.stringify(script)}` : "agent-state";
  }
  return cached;
}

/** Replaces the literal `agent-state ` command prefix in agent-facing text with the working command. */
export function withCli(text: string): string {
  const cmd = cliCommand();
  return cmd === "agent-state" ? text : text.replace(/`agent-state (?=[a-z])/g, "`" + cmd + " ");
}
