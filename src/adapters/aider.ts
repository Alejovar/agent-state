import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "../core/project.js";
import { readJson, writeJson } from "../core/store.js";
import { withLock } from "../core/lock.js";
import type { AgentAdapter } from "./adapter.js";
import { genericFraming } from "./adapter.js";
import { AgentSession } from "./session-core.js";

/**
 * Aider adapter.
 *
 * Aider has no hook system, but it appends everything to a Markdown chat log
 * (`.aider.chat.history.md` by default). agent-state imports new entries from
 * that file incrementally, from a saved byte offset, whenever a command runs:
 *
 *   # aider chat started at 2026-09-23 10:00:00   → session start
 *   #### <user input>                              → request
 *   > Applied edit to <path>                       → file modified
 *   > Running <command>                            → command
 *
 * To continue a task in Aider, the recovery context is passed as a read-only
 * file (`aider --read <file>`).
 */
export const aider: AgentAdapter = {
  id: "aider",
  displayName: "Aider",
  formatContext: genericFraming,
  launchCommand(context: string) {
    const dir = mkdtempSync(join(tmpdir(), "agent-state-aider-"));
    const file = join(dir, "agent-state-recovery.md");
    writeFileSync(file, context);
    return { cmd: "aider", args: ["--read", file] };
  },
};

export const AIDER_HISTORY = ".aider.chat.history.md";

interface ImportState {
  offset: number;
  session: string | null;
}

export interface AiderImport {
  sessions: number;
  requests: number;
  edits: number;
  commands: number;
}

/** Imports whatever Aider appended to its chat history since the last import. Cheap when nothing changed. */
export function importAiderHistory(project: Project, historyFile: string = join(project.root, AIDER_HISTORY)): AiderImport {
  const result: AiderImport = { sessions: 0, requests: 0, edits: 0, commands: 0 };
  if (!existsSync(historyFile)) return result;
  const statePath = join(project.paths.sessions, "aider-import.json");
  return withLock(project.lockPath("aider-import"), () => {
    const state = readJson<ImportState>(statePath, { offset: 0, session: null });
    const fd = openSync(historyFile, "r");
    let text: string;
    let end: number;
    try {
      const size = fstatSync(fd).size;
      if (size < state.offset) (state.offset = 0), (state.session = null); // history was truncated or replaced
      if (size === state.offset) return result;
      const buf = Buffer.alloc(size - state.offset);
      readSync(fd, buf, 0, buf.length, state.offset);
      // Only complete lines; a partially written line waits for the next import.
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl < 0) return result;
      text = buf.subarray(0, lastNl + 1).toString("utf8");
      end = state.offset + lastNl + 1;
    } finally {
      closeSync(fd);
    }

    let session = state.session ? new AgentSession(project, "aider", "ad", state.session) : null;
    let pendingInput: string[] = [];
    const flushInput = () => {
      if (!pendingInput.length || !session) return (pendingInput = []);
      const prompt = pendingInput.join("\n").trim();
      pendingInput = [];
      if (!prompt || prompt === "<blank>") return;
      session.prompt(prompt, { source: "aider-history" });
      result.requests++;
    };

    for (const raw of text.split("\n")) {
      const line = raw.replace(/ {2}$/, "");
      const started = /^# aider chat started at (.+)$/.exec(line);
      if (started) {
        flushInput();
        const native = started[1]!.replace(/[^0-9]/g, "");
        state.session = native;
        session = new AgentSession(project, "aider", "ad", native);
        session.attach("startup", { native_session_id: native, started_at: started[1] });
        result.sessions++;
        continue;
      }
      if (!session) continue;
      const input = /^#### ?(.*)$/.exec(line);
      if (input) {
        pendingInput.push(input[1]!);
        continue;
      }
      flushInput();
      const edit = /^> Applied edit to (.+)$/.exec(line);
      if (edit) {
        const rel = session.relPath(edit[1]!.trim());
        if (rel) (session.afterFileChange(null, "aider-edit", rel, existsSync(join(project.root, rel)) ? "modified" : "deleted"), result.edits++);
        continue;
      }
      const run = /^> Running (.+)$/.exec(line);
      if (run) {
        // Aider logs the command, not its exit status: recorded as unknown, never guessed.
        session.commandFinished(null, { command: run[1]!.trim(), ok: null, exit_code: null, output: "" });
        result.commands++;
      }
    }
    flushInput();
    state.offset = end;
    writeJson(statePath, state);
    return result;
  });
}
