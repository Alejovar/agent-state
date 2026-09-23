import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Project } from "../core/project.js";
import { invocation, isOurHook } from "./claude.js";


function readJsonFile(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`${file} is not valid JSON; fix it before installing hooks.`);
  }
}

function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

// ---------------------------------------------------------------- Cursor

interface CursorEntry {
  command: string;
  timeout?: number;
  matcher?: string;
  type?: string;
  [k: string]: unknown;
}

export function cursorHooks(cmd: string): Record<string, CursorEntry[]> {
  const e = (matcher?: string): CursorEntry[] => [{ command: `${cmd} hook cursor`, timeout: 30, ...(matcher ? { matcher } : {}) }];
  return {
    sessionStart: e(),
    sessionEnd: e(),
    beforeSubmitPrompt: e(),
    preToolUse: e("Shell|Write|Delete|Edit|StrReplace|MultiEdit"),
    postToolUse: e(),
    postToolUseFailure: e("Shell|Write|Delete|Edit|StrReplace|MultiEdit"),
    afterFileEdit: e(),
    preCompact: e(),
    subagentStart: e(),
    subagentStop: e(),
    stop: e(),
  };
}

function stripCursor(hooks: Record<string, CursorEntry[]>): Record<string, CursorEntry[]> {
  const out: Record<string, CursorEntry[]> = {};
  for (const [ev, list] of Object.entries(hooks)) {
    const kept = (list ?? []).filter((h) => !isOurHook(h.command));
    if (kept.length) out[ev] = kept;
  }
  return out;
}

export function mergeCursor(doc: Record<string, unknown>, cmd: string): Record<string, unknown> {
  const hooks = stripCursor((doc.hooks as Record<string, CursorEntry[]>) ?? {});
  for (const [ev, list] of Object.entries(cursorHooks(cmd))) hooks[ev] = [...(hooks[ev] ?? []), ...list];
  return { ...doc, version: doc.version ?? 1, hooks };
}

export function installCursor(project: Project): string[] {
  const file = join(project.root, ".cursor", "hooks.json");
  const cmd = invocation();
  writeJsonFile(file, mergeCursor(readJsonFile(file), cmd));
  return [`Cursor hooks installed in .cursor/hooks.json`, ...(cmd !== "agent-state" ? [`Hooks call ${cmd} — install globally for a stable path.`] : [])];
}

export function uninstallCursor(project: Project): string[] {
  const file = join(project.root, ".cursor", "hooks.json");
  if (!existsSync(file)) return [];
  const doc = readJsonFile(file);
  writeJsonFile(file, { ...doc, hooks: stripCursor((doc.hooks as Record<string, CursorEntry[]>) ?? {}) });
  return ["Removed agent-state hooks from .cursor/hooks.json"];
}

// ---------------------------------------------------------------- Gemini CLI

interface GeminiGroup {
  matcher?: string;
  hooks: { name?: string; type: string; command: string; timeout?: number; description?: string }[];
}

export function geminiHooks(cmd: string): Record<string, GeminiGroup[]> {
  const g = (matcher?: string): GeminiGroup[] => [
    {
      ...(matcher ? { matcher } : {}),
      hooks: [{ name: "agent-state", type: "command", command: `${cmd} hook gemini`, timeout: 30000, description: "agent-state: task memory & recovery" }],
    },
  ];
  return {
    SessionStart: g(),
    SessionEnd: g(),
    BeforeAgent: g(),
    AfterAgent: g(),
    BeforeTool: g("write_file|replace|run_shell_command"),
    AfterTool: g("write_file|replace|run_shell_command|write_todos"),
    PreCompress: g(),
  };
}

function stripGemini(hooks: Record<string, GeminiGroup[]>): Record<string, GeminiGroup[]> {
  const out: Record<string, GeminiGroup[]> = {};
  for (const [ev, groups] of Object.entries(hooks)) {
    const kept = (groups ?? [])
      .map((grp) => ({ ...grp, hooks: (grp.hooks ?? []).filter((h) => !isOurHook(h.command)) }))
      .filter((grp) => grp.hooks.length);
    if (kept.length) out[ev] = kept;
  }
  return out;
}

export function mergeGemini(settings: Record<string, unknown>, cmd: string): Record<string, unknown> {
  const hooks = stripGemini((settings.hooks as Record<string, GeminiGroup[]>) ?? {});
  for (const [ev, groups] of Object.entries(geminiHooks(cmd))) hooks[ev] = [...(hooks[ev] ?? []), ...groups];
  return { ...settings, hooks };
}

export function installGemini(project: Project): string[] {
  const file = join(project.root, ".gemini", "settings.json");
  const cmd = invocation();
  writeJsonFile(file, mergeGemini(readJsonFile(file), cmd));
  return [
    "Gemini CLI hooks installed in .gemini/settings.json (Gemini asks you to trust project hooks the first time)",
    ...(cmd !== "agent-state" ? [`Hooks call ${cmd} — install globally for a stable path.`] : []),
  ];
}

export function uninstallGemini(project: Project): string[] {
  const file = join(project.root, ".gemini", "settings.json");
  if (!existsSync(file)) return [];
  const s = readJsonFile(file);
  const hooks = stripGemini((s.hooks as Record<string, GeminiGroup[]>) ?? {});
  const next: Record<string, unknown> = { ...s, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  writeJsonFile(file, next);
  return ["Removed agent-state hooks from .gemini/settings.json"];
}
