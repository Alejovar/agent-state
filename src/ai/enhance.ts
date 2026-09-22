import type { Project } from "../core/project.js";
import type { RecoveryState } from "../core/recovery.js";
import { AIError, providerFromConfig, type AIProvider } from "./provider.js";
import { c } from "../ui/term.js";

export interface AISummary {
  text: string;
  provider: string;
  model?: string;
}

const SYSTEM = `You help AI coding agents resume interrupted work. You receive a structured, evidence-tagged
task state extracted from a repository. Write for another coding agent. Be concise and concrete.
Never invent facts: only restate or connect what is in the input. If something is uncertain, say so.
Items tagged "verified" were checked against the repository; others are claims.`;

/** Returns the configured provider, printing a clear notice that data leaves the machine. */
export function aiProvider(project: Project, purpose: string, bytes: number): AIProvider | null {
  let provider: AIProvider | null;
  try {
    provider = providerFromConfig(project.config.ai);
  } catch (err) {
    process.stderr.write(c.yellow(`⚠ AI disabled: ${(err as Error).message}\n`));
    return null;
  }
  if (!provider) {
    process.stderr.write(c.dim("No AI provider configured (ai.provider: none) — using deterministic output only.\n"));
    return null;
  }
  const where = provider.name === "command" ? `command \`${provider.model}\`` : `${provider.name}${provider.model ? ` (${provider.model})` : ""}`;
  process.stderr.write(c.yellow(`↑ Sending ~${Math.ceil(bytes / 1024)} KB of redacted, repository-derived ${purpose} data to ${where}.\n`));
  return provider;
}

/** Compact JSON of the fields worth summarizing — never raw file contents. */
function digest(state: RecoveryState): string {
  return JSON.stringify({
    objective: state.objective.text,
    in_progress: state.in_progress,
    pending: state.pending,
    blocked: state.blocked,
    completed: state.completed.slice(-15),
    issues: state.issues,
    failing_commands: state.failing_commands,
    failed_attempts: state.failed_attempts,
    decisions: state.decisions.map((d) => ({ n: d.number, decision: d.decision, reason: d.reason, rejected: d.alternatives })),
    files: state.files.slice(0, 60).map((f) => `${f.kind} ${f.path} [${f.role}]`),
    tests: state.tests,
    dependencies: state.dependencies,
    recent_requests: state.recent_requests,
    context: state.context,
    next_action: state.next_action,
    conflicts: state.conflicts,
  });
}

export async function aiSummary(project: Project, state: RecoveryState, kind: "recovery" | "handoff"): Promise<AISummary | null> {
  const payload = project.redactor.redact(digest(state));
  const provider = aiProvider(project, kind, Buffer.byteLength(payload));
  if (!provider) return null;
  const ask =
    kind === "handoff"
      ? "Write a handoff narrative (max 180 words): where the work stands, what matters most, the risks, and the exact next step."
      : "Summarize (max 120 words) the state of this task and the single most important thing the next session must do first.";
  try {
    const text = await provider.complete(SYSTEM, `${ask}\n\nTask state (JSON):\n${payload}`);
    const clean = project.redactor.redact(text).slice(0, 2000);
    return { text: clean, provider: provider.name, ...(provider.model ? { model: provider.model } : {}) };
  } catch (err) {
    const msg = err instanceof AIError ? err.message : String(err);
    process.stderr.write(c.yellow(`⚠ AI summary skipped: ${msg}. Deterministic output is unaffected.\n`));
    return null;
  }
}
