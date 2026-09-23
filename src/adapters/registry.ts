import type { AgentAdapter } from "./adapter.js";
import { genericFraming } from "./adapter.js";
import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import { cursor } from "./cursor.js";
import { gemini } from "./gemini.js";
import { UsageError } from "../commands/types.js";

const generic: AgentAdapter = {
  id: "generic",
  displayName: "any agent (plain text)",
  formatContext: genericFraming,
};

export const ADAPTERS: Record<string, AgentAdapter> = {
  "claude-code": claudeCode,
  cursor,
  "gemini-cli": gemini,
  codex,
  generic,
};

export function adapterFor(id: string | undefined): AgentAdapter {
  const key = (id ?? "claude-code").toLowerCase().replace(/^claude$/, "claude-code").replace(/^gemini$/, "gemini-cli");
  const a = ADAPTERS[key];
  if (!a) throw new UsageError(`Unknown agent "${id}". Available: ${Object.keys(ADAPTERS).join(", ")}`);
  return a;
}
