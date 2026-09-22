import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import type { AgentAdapter } from "./adapter.js";
import { genericFraming } from "./adapter.js";
import type { RecoveryState } from "../core/recovery.js";

/**
 * Claude Code adapter.
 *
 * Integration uses only documented hook events (SessionStart, UserPromptSubmit,
 * PreToolUse, PostToolUse, PostToolUseFailure, PreCompact, SubagentStart,
 * SubagentStop, Stop, SessionEnd). Anything that depends on undocumented
 * details (transcript format for token usage) is isolated here and degrades to
 * "unknown" when it cannot be read.
 */
export const claudeCode: AgentAdapter & {
  estimateContextTokens(transcriptPath: string): number | null;
} = {
  id: "claude-code",
  displayName: "Claude Code",

  formatContext(markdown: string, state: RecoveryState): string {
    return genericFraming(markdown, state);
  },

  launchCommand(context: string) {
    return { cmd: "claude", args: [context] };
  },

  /**
   * Best-effort context size estimate: the most recent assistant message's
   * input + cache tokens from the session transcript. The transcript format is
   * not a public contract, so any parse problem returns null (unknown).
   */
  estimateContextTokens(transcriptPath: string): number | null {
    try {
      if (!transcriptPath || !existsSync(transcriptPath)) return null;
      const size = statSync(transcriptPath).size;
      // Only the tail matters; avoid reading multi-megabyte transcripts fully.
      const window = Math.min(size, 512 * 1024);
      const fd = openSync(transcriptPath, "r");
      const buf = Buffer.alloc(window);
      try {
        readSync(fd, buf, 0, window, size - window);
      } finally {
        closeSync(fd);
      }
      const lines = buf.toString("utf8").split("\n").reverse();
      for (const line of lines) {
        if (!line.includes('"usage"')) continue;
        try {
          const j = JSON.parse(line) as {
            isSidechain?: boolean;
            message?: { usage?: Record<string, number> };
          };
          if (j.isSidechain) continue;
          const u = j.message?.usage;
          if (!u) continue;
          const total =
            (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          if (total > 0) return total;
        } catch {
          // partial first line of the window, or unrelated JSON
        }
      }
      return null;
    } catch {
      return null;
    }
  },
};

