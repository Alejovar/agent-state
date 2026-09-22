import { spawn } from "node:child_process";
import type { Config } from "../core/config.js";

/**
 * Optional AI layer. Everything in agent-state works without it; providers are
 * only used for semantic tasks (summaries, drift, explanations) and only when
 * the user configured one explicitly.
 */
export interface AIProvider {
  readonly name: string;
  readonly model?: string;
  complete(system: string, prompt: string): Promise<string>;
}

export class AIError extends Error {}

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  constructor(
    readonly model: string,
    private readonly apiKeyEnv: string | undefined,
    private readonly timeoutMs: number,
    private readonly baseURL?: string,
  ) {}

  async complete(system: string, prompt: string): Promise<string> {
    let mod: typeof import("@anthropic-ai/sdk");
    try {
      mod = await import("@anthropic-ai/sdk");
    } catch {
      throw new AIError("The anthropic provider needs the optional package @anthropic-ai/sdk (npm i -g @anthropic-ai/sdk, or reinstall agent-state with optional deps).");
    }
    const Anthropic = mod.default;
    const apiKey = this.apiKeyEnv ? process.env[this.apiKeyEnv] : undefined;
    if (this.apiKeyEnv && !apiKey) throw new AIError(`Environment variable ${this.apiKeyEnv} is not set.`);
    const client = new Anthropic({ ...(apiKey ? { apiKey } : {}), ...(this.baseURL ? { baseURL: this.baseURL } : {}), timeout: this.timeoutMs, maxRetries: 2 });
    try {
      const response = await client.messages.create({
        model: this.model,
        max_tokens: 4000,
        system,
        messages: [{ role: "user", content: prompt }],
      });
      if (response.stop_reason === "refusal") throw new AIError("The model declined this request.");
      const text = response.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (!text) throw new AIError("Empty response from the model.");
      return text;
    } catch (err) {
      if (err instanceof AIError) throw err;
      if (err instanceof Anthropic.AuthenticationError) throw new AIError("Anthropic authentication failed (check your API key).");
      if (err instanceof Anthropic.RateLimitError) throw new AIError("Anthropic rate limit reached; try again later.");
      if (err instanceof Anthropic.APIError) throw new AIError(`Anthropic API error ${err.status ?? ""}: ${err.message}`);
      throw new AIError(`Anthropic request failed: ${(err as Error).message}`);
    }
  }
}

/** Any OpenAI-compatible chat endpoint — notably local servers such as Ollama or llama.cpp. */
export class OpenAICompatibleProvider implements AIProvider {
  readonly name = "openai-compatible";
  constructor(
    readonly model: string,
    private readonly baseURL: string,
    private readonly apiKeyEnv: string | undefined,
    private readonly timeoutMs: number,
  ) {}

  async complete(system: string, prompt: string): Promise<string> {
    const key = this.apiKeyEnv ? process.env[this.apiKeyEnv] : undefined;
    if (this.apiKeyEnv && !key) throw new AIError(`Environment variable ${this.apiKeyEnv} is not set.`);
    const res = await fetch(`${this.baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((err: Error) => {
      throw new AIError(`Request to ${this.baseURL} failed: ${err.message}`);
    });
    if (!res.ok) throw new AIError(`${this.baseURL} returned HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
    const text = body?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new AIError("Malformed response: no choices[0].message.content");
    return text;
  }
}

/** Pipes the prompt to a user-configured command (e.g. `claude -p`, `llm`, `ollama run …`). */
export class CommandProvider implements AIProvider {
  readonly name = "command";
  constructor(
    private readonly command: string,
    private readonly timeoutMs: number,
  ) {}

  get model(): string {
    return this.command;
  }

  complete(system: string, prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new AIError(`AI command timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new AIError(`AI command failed to start: ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new AIError(`AI command exited with ${code}: ${stderr.trim().slice(0, 300)}`));
        if (!stdout.trim()) return reject(new AIError("AI command produced no output"));
        resolve(stdout.trim());
      });
      child.stdin.end(`${system}\n\n${prompt}`);
    });
  }
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";

/** Builds the configured provider, or null when AI is disabled. */
export function providerFromConfig(cfg: Config["ai"]): AIProvider | null {
  switch (cfg.provider) {
    case "anthropic":
      return new AnthropicProvider(cfg.model ?? DEFAULT_ANTHROPIC_MODEL, cfg.api_key_env, cfg.timeout_ms, cfg.base_url);
    case "openai-compatible":
      if (!cfg.base_url || !cfg.model) throw new AIError("ai.provider openai-compatible needs ai.base_url and ai.model");
      return new OpenAICompatibleProvider(cfg.model, cfg.base_url, cfg.api_key_env, cfg.timeout_ms);
    case "command":
      if (!cfg.command) throw new AIError("ai.provider command needs ai.command");
      return new CommandProvider(cfg.command, cfg.timeout_ms);
    default:
      return null;
  }
}

/** Extracts the first JSON object/array from model output (models sometimes wrap JSON in prose or fences). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  const open = candidate[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      try {
        return JSON.parse(candidate.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}
