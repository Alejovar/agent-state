import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Project } from "../src/core/project.js";
import { ClaudeHookHandler, type ClaudeHookInput } from "../src/adapters/claude-hooks.js";

process.env.NO_COLOR = "1";

export const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

export interface Repo {
  root: string;
  write(path: string, content: string): void;
  git(...args: string[]): string;
  commit(msg?: string): void;
  cleanup(): void;
}

export function makeRepo(files: Record<string, string> = {}, opts: { git?: boolean } = {}): Repo {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-state-test-")));
  const write = (path: string, content: string) => {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  for (const [p, c] of Object.entries(files)) write(p, c);
  if (opts.git !== false) {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    // Byte-exact fixtures on every platform (Windows defaults may rewrite line endings).
    git("config", "core.autocrlf", "false");
    if (Object.keys(files).length) {
      git("add", "-A");
      git("commit", "-qm", "initial");
    }
  }
  return {
    root,
    write,
    git,
    commit(msg = "change") {
      git("add", "-A");
      git("commit", "-qm", msg);
    },
    cleanup() {
      // Best effort: on Windows an open handle (e.g. after a failed assertion)
      // makes rm throw, which would hide the real test failure.
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        // leave it for the OS temp cleaner
      }
    },
  };
}

/** Realistic fixture: a small TypeScript web app with auth. */
export const AUTH_APP: Record<string, string> = {
  "package.json": JSON.stringify({ name: "shop", main: "src/index.ts", scripts: { test: "vitest run", build: "tsc" }, dependencies: { express: "^4.19.0", ioredis: "^5.0.0" }, devDependencies: { vitest: "^2.0.0" } }, null, 2),
  "pnpm-lock.yaml": "lockfileVersion: 9\n",
  "src/index.ts": `import express from "express";\nimport { router } from "./routes/private";\nimport { login } from "./routes/login";\nconst app = express();\napp.use(router);\napp.post("/login", login);\nexport default app;\n`,
  "src/auth/session.ts": `import Redis from "ioredis";\nconst redis = new Redis();\nexport async function createSession(user: string) { return redis.set(user, "1"); }\nexport function destroySession() {}\n`,
  "src/auth/google.ts": `import { createSession } from "./session.js";\nexport async function googleLogin(code: string) { return createSession(code); }\n`,
  "src/middleware/auth.ts": `import { createSession } from "../auth/session";\nexport function requireAuth() { return createSession; }\n`,
  "src/routes/private.ts": `import { requireAuth } from "../middleware/auth";\nimport { Router } from "express";\nexport const router = Router();\nrouter.get("/account", requireAuth());\n`,
  "src/routes/login.ts": `import { googleLogin } from "../auth/google";\nexport const login = (req: any) => googleLogin(req.query.code);\n`,
  "tests/auth/session.test.ts": `import { createSession } from "../../src/auth/session";\nimport { test } from "vitest";\ntest("session", () => { createSession("a"); });\n`,
  "docs/architecture.md": "# Architecture\n\nAuthentication uses JWT tokens signed with a shared secret.\nSessions live in `src/auth/session.ts`.\n",
  "README.md": "# Shop\n\nRun `pnpm run build` then `pnpm test`.\n",
};

export function initProject(repo: Repo): Project {
  const { project } = Project.init(repo.root);
  return project;
}

export function hook(project: Project, input: Partial<ClaudeHookInput> & { hook_event_name: string }) {
  return new ClaudeHookHandler(project).handle({ session_id: "sess-1", cwd: project.root, ...input } as ClaudeHookInput);
}

export function cli(cwd: string, args: string[], input?: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", input, env: { ...process.env, NO_COLOR: "1", ...env } });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/**
 * A shell command that runs the given JavaScript with node: portable across
 * sh and cmd.exe (no quoting of the script body on the command line).
 */
export function nodeCommand(js: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-state-cmd-")));
  const file = join(dir, `cmd-${randomBytes(4).toString("hex")}.mjs`);
  writeFileSync(file, js);
  return `"${process.execPath}" "${file}"`;
}
