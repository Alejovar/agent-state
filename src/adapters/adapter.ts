import type { RecoveryState } from "../core/recovery.js";

/**
 * An adapter translates one agent's native signals (hooks, notify callbacks,
 * logs) into normalized events, and formats recovery context for that agent.
 * The core never imports agent-specific code; it only sees this interface.
 */
export interface AgentAdapter {
  /** Stable agent identifier stored on events, e.g. "claude-code". */
  readonly id: string;
  readonly displayName: string;
  /** Wraps rendered recovery markdown in whatever framing the agent works best with. */
  formatContext(markdown: string, state: RecoveryState): string;
  /** Command line that starts a new agent session seeded with `context`, if supported. */
  launchCommand?(context: string): { cmd: string; args: string[] } | null;
}

/** Generic framing usable by any agent that accepts plain text. */
export function genericFraming(markdown: string, state: RecoveryState): string {
  return [
    `You are resuming task #${state.task.number} in ${state.project}. The previous session's context is gone;`,
    "agent-state preserved the working state below. Treat items marked ✓ as verified against the repository",
    "and everything else as claims to re-check before relying on them. Do not redo completed work.",
    "",
    markdown.trim(),
  ].join("\n");
}
