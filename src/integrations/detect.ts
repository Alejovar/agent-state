import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AgentKind = "claude-code" | "cursor" | "gemini-cli" | "codex";

export interface DetectedAgent {
  id: AgentKind;
  name: string;
  /** Why we think it is installed. */
  evidence: string;
}

function onPath(cmd: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const CANDIDATES: { id: AgentKind; name: string; bins: string[]; dirs: string[] }[] = [
  { id: "claude-code", name: "Claude Code", bins: ["claude"], dirs: [".claude"] },
  { id: "cursor", name: "Cursor", bins: ["cursor", "cursor-agent"], dirs: [".cursor"] },
  { id: "gemini-cli", name: "Gemini CLI", bins: ["gemini"], dirs: [".gemini"] },
  { id: "codex", name: "Codex CLI", bins: ["codex"], dirs: [".codex"] },
];

/** Agents installed on this machine: a binary on PATH or its config directory in $HOME. */
export function detectAgents(home: string = homedir()): DetectedAgent[] {
  const out: DetectedAgent[] = [];
  for (const c of CANDIDATES) {
    const bin = c.bins.find(onPath);
    if (bin) {
      out.push({ id: c.id, name: c.name, evidence: `\`${bin}\` on PATH` });
      continue;
    }
    const dir = c.dirs.find((d) => existsSync(join(home, d)));
    if (dir) out.push({ id: c.id, name: c.name, evidence: `~/${dir}` });
  }
  return out;
}
