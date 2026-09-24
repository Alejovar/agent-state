import { existsSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";

export type ScopePolicy = "warn" | "confirm" | "block";

export interface Config {
  version: 1;
  recovery: {
    /** Upper bound for the rendered recovery markdown, in bytes. */
    max_bytes: number;
    /** Inject recovery context automatically when a new/compacted agent session starts. */
    auto_inject: boolean;
    /** What to inject on a fresh agent start while a task is unfinished: full context, a brief notice, or nothing. */
    inject_on_startup: "full" | "brief" | "off";
    /** Tell the agent (once per session) how to record decisions and failed approaches. */
    agent_guidance: boolean;
    /** A fresh session only joins an unfinished task active within this many hours; older ones are just mentioned. */
    resume_window_hours: number;
  };
  reminders: {
    /** Remind the agent of related decisions/failed approaches right before it edits a file or reruns a failing command. */
    enabled: boolean;
  };
  context: {
    /** Context window of the agent model, in tokens, used to estimate pressure. */
    window_tokens: number;
    /** Suggest starting fresh (/clear) with the saved state before quality degrades ("context rot"). */
    fresh_at: number;
    /** @deprecated kept for older configs; used as fresh_at when fresh_at is absent. */
    warn_at?: number;
    compact_at: number;
  };
  scope: {
    policy: ScopePolicy;
  };
  redaction: {
    /** Extra regular expressions (JavaScript syntax) whose matches are redacted. */
    patterns: string[];
  };
  privacy: {
    record_prompts: boolean;
    /** Maximum characters of command output kept per event (tail is kept). */
    max_output_chars: number;
  };
  tests: {
    /** Regular expressions matching commands that run tests. Built-ins cover common runners. */
    commands: string[];
  };
  sync: {
    /** Git remote used by `agent-state share` / `team`. */
    remote: string;
    /** Name other people see (defaults to the local part of your git email). */
    name?: string;
  };
  ai: {
    /** none | anthropic | openai-compatible | command */
    provider: "none" | "anthropic" | "openai-compatible" | "command";
    model?: string;
    base_url?: string;
    /** Name of the environment variable holding the API key. The key itself is never stored. */
    api_key_env?: string;
    /** For provider=command: a shell command that reads a prompt on stdin and writes the answer on stdout. */
    command?: string;
    timeout_ms: number;
  };
}

export const DEFAULT_CONFIG: Config = {
  version: 1,
  recovery: { max_bytes: 6000, auto_inject: true, inject_on_startup: "brief", agent_guidance: true, resume_window_hours: 72 },
  reminders: { enabled: true },
  context: { window_tokens: 200_000, fresh_at: 0.6, compact_at: 0.94 },
  scope: { policy: "warn" },
  redaction: { patterns: [] },
  privacy: { record_prompts: true, max_output_chars: 2000 },
  tests: { commands: [] },
  sync: { remote: "origin" },
  ai: { provider: "none", timeout_ms: 60_000 },
};

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== "object" || Array.isArray(over)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === "object" && !Array.isArray(b) ? merge(b, v) : v;
  }
  return out as T;
}

/** Set when config.yaml could not be parsed; the defaults are used instead. */
export let configError: string | null = null;

export function loadConfig(path: string): Config {
  configError = null;
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  let parsed: { context?: { fresh_at?: number; warn_at?: number } } | null;
  try {
    parsed = YAML.parse(readFileSync(path, "utf8")) as typeof parsed;
  } catch (err) {
    // A typo in the config must never take the agent's hooks down with it.
    configError = `${path}: ${(err as Error).message.split("\n")[0]}`;
    return structuredClone(DEFAULT_CONFIG);
  }
  if (parsed !== null && typeof parsed !== "object") {
    configError = `${path}: expected a YAML mapping at the top level`;
    return structuredClone(DEFAULT_CONFIG);
  }
  const cfg = merge(structuredClone(DEFAULT_CONFIG), parsed);
  // Older configs only had warn_at: honor it as the fresh-start threshold.
  if (parsed?.context?.fresh_at === undefined && typeof parsed?.context?.warn_at === "number") cfg.context.fresh_at = parsed.context.warn_at;
  return cfg;
}

export function writeDefaultConfig(path: string): void {
  const doc = `# agent-state configuration. Everything stays on this machine unless you configure an AI provider.
version: 1

recovery:
  max_bytes: 6000        # hard budget for recovery context handed to an agent
  auto_inject: true      # re-inject recovery context after the agent compacts, resumes or clears
  inject_on_startup: brief  # full | brief | off — on a fresh start while a task is unfinished
  agent_guidance: true   # tell the agent how to record decisions and failed approaches
  resume_window_hours: 72  # a fresh session joins an unfinished task only if it was active this recently

reminders:
  enabled: true          # remind the agent of related decisions right before it edits a file

context:
  window_tokens: 200000  # context budget used to measure pressure (quality tends to drop well before 1M)
  fresh_at: 0.60         # save state and suggest /clear to continue fresh, before "context rot" sets in
  compact_at: 0.94       # generate a recovery state automatically

scope:
  policy: warn           # warn | confirm | block — what to do when an agent edits outside the task scope

redaction:
  patterns: []           # extra regexes to redact, e.g. ['acme_[a-z0-9]{32}']

privacy:
  record_prompts: true
  max_output_chars: 2000

tests:
  commands: []           # extra regexes that identify test commands

sync:                    # only used by the explicit \`agent-state share\` / \`team\` commands
  remote: origin
  # name: alex            # how teammates see you (default: your git email's local part)

ai:
  provider: none         # none | anthropic | openai-compatible | command
  # model: claude-sonnet-5
  # api_key_env: ANTHROPIC_API_KEY
  # base_url: http://localhost:11434/v1    # e.g. Ollama for fully local semantic analysis
  # command: "claude -p"                   # any CLI that reads a prompt on stdin
  timeout_ms: 60000
`;
  writeFileSync(path, doc);
}
