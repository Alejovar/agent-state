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
  };
  context: {
    /** Context window of the agent model, in tokens, used to estimate pressure. */
    window_tokens: number;
    warn_at: number;
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
  recovery: { max_bytes: 6000, auto_inject: true, inject_on_startup: "brief" },
  context: { window_tokens: 200_000, warn_at: 0.8, compact_at: 0.94 },
  scope: { policy: "warn" },
  redaction: { patterns: [] },
  privacy: { record_prompts: true, max_output_chars: 2000 },
  tests: { commands: [] },
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

export function loadConfig(path: string): Config {
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  const parsed = YAML.parse(readFileSync(path, "utf8")) as unknown;
  return merge(structuredClone(DEFAULT_CONFIG), parsed);
}

export function writeDefaultConfig(path: string): void {
  const doc = `# agent-state configuration. Everything stays on this machine unless you configure an AI provider.
version: 1

recovery:
  max_bytes: 6000        # hard budget for recovery context handed to an agent
  auto_inject: true      # re-inject recovery context after the agent compacts, resumes or clears
  inject_on_startup: brief  # full | brief | off — on a fresh start while a task is unfinished

context:
  window_tokens: 200000  # model context window used to estimate context pressure
  warn_at: 0.80          # suggest \`agent-state compact\`
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
