import { AUTH_APP, makeRepo } from "../../build-test/test/helpers.js";
import { Project } from "../../build-test/src/core/project.js";
import { ClaudeHookHandler } from "../../build-test/src/adapters/claude-hooks.js";
import { renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const dest = process.argv[2];
rmSync(dest, { recursive: true, force: true });
const files = { ...AUTH_APP, "package.json": JSON.stringify({ name: "shop", scripts: { test: "vitest run" }, dependencies: { express: "^4", ioredis: "^5", "connect-redis": "^7" }, devDependencies: { vitest: "^2" } }, null, 2) };
const repo = makeRepo(files);
renameSync(repo.root, dest);
const { project } = Project.init(dest);
const h = (i) => new ClaudeHookHandler(project).handle({ session_id: "7f3a9c", cwd: dest, ...i });
h({ hook_event_name: "SessionStart", source: "startup" });
h({ hook_event_name: "UserPromptSubmit", prompt: "Add Google OAuth login using our existing Redis sessions" });
const w = (p, c) => { mkdirSync(join(dest, p, ".."), { recursive: true }); writeFileSync(join(dest, p), c); };
for (const [id, p, c] of [["1", "src/auth/oauth.ts", 'import { createSession } from "./session";\nexport const googleCallback = (code: string) => createSession(code);\n'], ["2", "src/routes/oauth.ts", 'import { googleCallback } from "../auth/oauth";\nexport const cb = googleCallback;\n']]) {
  h({ hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: id, tool_input: { file_path: join(dest, p) } });
  w(p, c);
  h({ hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: id, tool_input: { file_path: join(dest, p) }, tool_response: {} });
}
w("src/auth/session.ts", files["src/auth/session.ts"] + "export const OAUTH_STATE_TTL = 600;\n");
h({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "3", tool_input: { file_path: join(dest, "src/auth/session.ts") }, tool_response: {} });
h({ hook_event_name: "PostToolUse", tool_name: "TodoWrite", tool_use_id: "4", tool_input: { todos: [
  { content: "Google provider + callback route", status: "completed" },
  { content: "Store OAuth state in Redis", status: "completed" },
  { content: "Handle expired OAuth state", status: "in_progress" },
  { content: "Integration tests", status: "pending" } ] } });
h({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "5", tool_input: { command: "npm test" } });
h({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "5", tool_input: { command: "npm test" }, error: "FAIL tests/auth/oauth.test.ts > rejects expired state\nTests  1 failed | 22 passed (23)\nExit code 1" });
const emit = (type, payload) => project.emit({ type, agent_id: "claude-code", session_id: "cc_7f3a9c", task_id: "task_1", payload });
emit("DECISION_RECORDED", { number: 1, decision: "Reuse Redis sessions instead of JWT", reason: "Redis is already deployed; no token revocation problem", alternatives: ["JWT", "DB sessions"], files: ["src/auth/session.ts"] });
emit("NOTE_RECORDED", { kind: "failed_attempt", text: "Signed-cookie OAuth state broke on Safari (ITP)" });
h({ hook_event_name: "PreCompact", trigger: "auto" });
project.close();
