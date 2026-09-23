import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, initProject, cli, AUTH_APP } from "./helpers.js";
import { CursorHookHandler, type CursorHookInput } from "../src/adapters/cursor.js";
import { GeminiHookHandler, type GeminiHookInput } from "../src/adapters/gemini.js";
import { TaskService } from "../src/core/tasks.js";
import { saveContract } from "../src/core/scope.js";
import { mergeCursor, mergeGemini } from "../src/integrations/others.js";
import type { Project } from "../src/core/project.js";

const cur = (p: Project, input: Partial<CursorHookInput> & { hook_event_name: string }) => {
  const r = new CursorHookHandler(p).handle({ conversation_id: "conv-1", workspace_roots: [p.root], ...input } as CursorHookInput);
  return r.stdout ? JSON.parse(r.stdout) : null;
};
const gem = (p: Project, input: Partial<GeminiHookInput> & { hook_event_name: string }) => {
  const r = new GeminiHookHandler(p).handle({ session_id: "g-1", cwd: p.root, ...input } as GeminiHookInput);
  return r.stdout ? JSON.parse(r.stdout) : null;
};

test("cursor: prompt → task, tools, shell exit codes, compaction re-injection", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    assert.match(cur(p, { hook_event_name: "sessionStart", session_id: "conv-1", composer_mode: "agent" }).additional_context, /agent-state decide/);
    assert.deepEqual(cur(p, { hook_event_name: "beforeSubmitPrompt", prompt: "Add rate limiting to login" }), { continue: true });
    const [t] = new TaskService(p).list();
    assert.equal(t!.goal, "Add rate limiting to login");
    assert.equal(t!.sessions[0]!.agent_id, "cursor");

    const f = join(repo.root, "src/auth/limit.ts");
    assert.deepEqual(cur(p, { hook_event_name: "preToolUse", tool_name: "Write", tool_use_id: "w1", tool_input: { file_path: f } }), { permission: "allow" });
    writeFileSync(f, "x");
    cur(p, { hook_event_name: "postToolUse", tool_name: "Write", tool_use_id: "w1", tool_input: { file_path: f }, tool_output: "{}" });
    cur(p, { hook_event_name: "afterFileEdit", file_path: join(repo.root, "src/auth/session.ts"), edits: [] } as never);
    cur(p, { hook_event_name: "preToolUse", tool_name: "Shell", tool_use_id: "s1", tool_input: { command: "npm test" } });
    cur(p, { hook_event_name: "postToolUse", tool_name: "Shell", tool_use_id: "s1", tool_input: { command: "npm test" }, tool_output: JSON.stringify({ exitCode: 1, stdout: "Tests: 2 failed, 5 passed, 7 total" }) });
    cur(p, { hook_event_name: "postToolUseFailure", tool_name: "Shell", tool_use_id: "s2", tool_input: { command: "npm run build" }, error_message: "Command timed out after 30s", failure_type: "timeout" });
    cur(p, { hook_event_name: "subagentStart", subagent_id: "sa1", subagent_type: "generalPurpose", task: "Explore auth" });

    const ev = p.db().query({ task_id: t!.id });
    assert.deepEqual(ev.filter((e) => e.type.startsWith("FILE_")).map((e) => [e.type, e.payload.path]), [["FILE_CREATED", "src/auth/limit.ts"], ["FILE_MODIFIED", "src/auth/session.ts"]]);
    const test = ev.find((e) => e.type === "TEST_FINISHED")!;
    assert.equal(test.payload.ok, false);
    assert.equal(test.payload.exit_code, 1);
    assert.equal(test.payload.failed, 2);
    const build = ev.find((e) => e.type === "COMMAND_EXECUTED")!;
    assert.equal(build.payload.ok, false);
    assert.match(String(build.payload.output_tail), /timed out/);
    assert.equal(ev.filter((e) => e.type === "SUBAGENT_STARTED").length, 1);

    // preCompact saves state (with exact usage) and the next tool result carries it back.
    const pc = cur(p, { hook_event_name: "preCompact", trigger: "auto", context_usage_percent: 85, context_tokens: 108000 });
    assert.match(pc.user_message, /saved recovery state for task #1/);
    const pressure = p.db().query({ types: ["CONTEXT_PRESSURE"] })[0]!;
    assert.equal(pressure.payload.ratio, 0.85);
    assert.equal(pressure.payload.estimated, false);
    const next = cur(p, { hook_event_name: "postToolUse", tool_name: "Read", tool_use_id: "r1", tool_input: {} });
    assert.match(next.additional_context, /RECOVERY CONTEXT — Task #1/);
    assert.deepEqual(cur(p, { hook_event_name: "postToolUse", tool_name: "Read", tool_use_id: "r2", tool_input: {} }), {}, "injected once");

    cur(p, { hook_event_name: "sessionEnd", session_id: "conv-1", reason: "user_close" });
    assert.equal(new TaskService(p).get(t!.id)!.status, "PAUSED");
    // A new Cursor chat gets a brief notice about the unfinished task.
    const start = cur(p, { hook_event_name: "sessionStart", conversation_id: "conv-2", session_id: "conv-2" });
    assert.match(start.additional_context, /Unfinished task #1/);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("cursor: scope policies map to allow/deny; permission hooks always get valid JSON", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    cur(p, { hook_event_name: "beforeSubmitPrompt", prompt: "Auth work" });
    const edit = (path: string) => cur(p, { hook_event_name: "preToolUse", tool_name: "Write", tool_use_id: path, tool_input: { file_path: join(repo.root, path) } });
    saveContract(p, { task: { id: 1, goal: "x" }, scope: { allowed: ["src/auth/**"], restricted: [] }, expected: [], policy: "warn" });
    assert.deepEqual(edit("src/routes/login.ts"), { permission: "allow" });
    saveContract(p, { task: { id: 1, goal: "x" }, scope: { allowed: ["src/auth/**"], restricted: [] }, expected: [], policy: "block" });
    const deny = edit("src/routes/login.ts");
    assert.equal(deny.permission, "deny");
    assert.match(deny.agent_message, /outside the declared scope/);
    saveContract(p, { task: { id: 1, goal: "x" }, scope: { allowed: ["src/auth/**"], restricted: [] }, expected: [], policy: "confirm" });
    assert.match(edit("src/index.ts").user_message, /needs your confirmation/);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("gemini: session, prompt, tools, todos, exit codes, PreCompress re-injection, scope deny", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    assert.match(gem(p, { hook_event_name: "SessionStart", source: "startup" }).hookSpecificOutput.additionalContext, /agent-state decide/);
    assert.deepEqual(gem(p, { hook_event_name: "BeforeAgent", prompt: "Migrate sessions to Redis cluster" }), {});
    const f = join(repo.root, "src/auth/cluster.ts");
    gem(p, { hook_event_name: "BeforeTool", tool_name: "write_file", tool_input: { file_path: f, content: "x" } });
    writeFileSync(f, "x");
    gem(p, { hook_event_name: "AfterTool", tool_name: "write_file", tool_input: { file_path: f, content: "x" }, tool_response: { llmContent: "Successfully created" } });
    gem(p, { hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "pytest -q" } });
    gem(p, {
      hook_event_name: "AfterTool",
      tool_name: "run_shell_command",
      tool_input: { command: "pytest -q" },
      tool_response: { llmContent: "Output: ===== 1 failed, 9 passed in 0.5s =====\nExit Code: 1" },
    });
    gem(p, { hook_event_name: "AfterTool", tool_name: "write_todos", tool_input: { todos: [{ description: "Write migration", status: "completed" }, { description: "Old plan", status: "cancelled" }, { description: "Switch reads", status: "in_progress" }] } });
    const [t] = new TaskService(p).list();
    assert.equal(t!.goal, "Migrate sessions to Redis cluster");
    const ev = p.db().query({ task_id: t!.id });
    assert.deepEqual(ev.filter((e) => e.type.startsWith("FILE_")).map((e) => [e.type, e.payload.path]), [["FILE_CREATED", "src/auth/cluster.ts"]]);
    const tr = ev.find((e) => e.type === "TEST_FINISHED")!;
    assert.equal(tr.payload.ok, false);
    assert.equal(tr.payload.exit_code, 1);
    assert.equal(tr.payload.passed, 9);
    assert.deepEqual(ev.filter((e) => e.type === "TODOS_UPDATED").at(-1)!.payload.items, [
      { content: "Write migration", status: "completed" },
      { content: "Switch reads", status: "in_progress" },
    ]);

    const pc = gem(p, { hook_event_name: "PreCompress", trigger: "auto" });
    assert.match(pc.systemMessage, /saved recovery state/);
    const next = gem(p, { hook_event_name: "BeforeAgent", prompt: "continue" });
    assert.equal(next.hookSpecificOutput.hookEventName, "BeforeAgent");
    assert.match(next.hookSpecificOutput.additionalContext, /RECOVERY CONTEXT — Task #1/);

    saveContract(p, { task: { id: 1, goal: "x" }, scope: { allowed: ["src/auth/**"], restricted: ["infra/**"] }, expected: [], policy: "block" });
    const deny = gem(p, { hook_event_name: "BeforeTool", tool_name: "replace", tool_input: { file_path: join(repo.root, "infra/main.tf"), old_string: "a", new_string: "b" } });
    assert.equal(deny.decision, "deny");
    assert.match(deny.reason, /restricted scope "infra\/\*\*"/);

    // Resume re-injects the full context via SessionStart additionalContext.
    gem(p, { hook_event_name: "SessionEnd", reason: "exit" });
    const resume = gem(p, { hook_event_name: "SessionStart", source: "resume" });
    assert.match(resume.hookSpecificOutput.additionalContext, /RECOVERY CONTEXT/);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("installers merge with existing config and are idempotent; hook CLI routes by agent", () => {
  const cursorDoc = mergeCursor({ version: 1, hooks: { stop: [{ command: "./notify.sh" }] } }, "agent-state") as { hooks: Record<string, { command: string }[]> };
  assert.equal(cursorDoc.hooks.stop!.length, 2);
  assert.equal((mergeCursor(cursorDoc, "agent-state") as typeof cursorDoc).hooks.stop!.length, 2);
  const gemDoc = mergeGemini({ theme: "dark", hooks: { AfterTool: [{ matcher: "x", hooks: [{ type: "command", command: "lint" }] }] } }, "agent-state") as { theme: string; hooks: Record<string, unknown[]> };
  assert.equal(gemDoc.theme, "dark");
  assert.equal(gemDoc.hooks.AfterTool!.length, 2);
  assert.equal((mergeGemini(gemDoc, "agent-state") as typeof gemDoc).hooks.AfterTool!.length, 2);

  const repo = makeRepo(AUTH_APP);
  try {
    // Outside a project, Cursor permission hooks still get valid JSON.
    assert.equal(cli(repo.root, ["hook", "cursor"], JSON.stringify({ hook_event_name: "preToolUse", conversation_id: "c", workspace_roots: [repo.root] })).stdout, '{"permission":"allow"}');
    assert.equal(cli(repo.root, ["init", "--cursor", "--gemini"]).code, 0);
    assert.ok(readFileSync(join(repo.root, ".cursor/hooks.json"), "utf8").includes("hook cursor"));
    assert.ok(readFileSync(join(repo.root, ".gemini/settings.json"), "utf8").includes("hook gemini"));
    const r = cli("/", ["hook", "cursor"], JSON.stringify({ hook_event_name: "beforeSubmitPrompt", conversation_id: "c", workspace_roots: [repo.root], prompt: "Fix bug" }));
    assert.equal(r.stdout, '{"continue":true}');
    const g = cli(repo.root, ["hook", "gemini"], JSON.stringify({ hook_event_name: "BeforeAgent", session_id: "g", cwd: repo.root, prompt: "hi" }), { GEMINI_PROJECT_DIR: repo.root });
    assert.equal(g.stdout, "{}");
    assert.match(cli(repo.root, ["task", "list"]).stdout, /Fix bug/);
    assert.equal(cli(repo.root, ["integrate", "cursor", "--uninstall"]).code, 0);
    assert.ok(!readFileSync(join(repo.root, ".cursor/hooks.json"), "utf8").includes("hook cursor"));
    assert.ok(existsSync(join(repo.root, ".gemini/settings.json")));
  } finally {
    repo.cleanup();
  }
});

test("uninstall recognizes hooks installed via an absolute node path", async () => {
  const { mergeHooks, removeHooks, isOurHook } = await import("../src/integrations/claude.js");
  const cmd = 'node "/home/u/.npm/lib/node_modules/agent-state/dist/cli.js"';
  assert.ok(isOurHook(`${cmd} hook claude-code`));
  assert.ok(!isOurHook('"${CLAUDE_PLUGIN_ROOT}"/bin/agent-state-hook'));
  assert.ok(!isOurHook("my-linter hook cursor"));
  const merged = mergeHooks(mergeHooks({}, cmd), cmd) as { hooks: Record<string, unknown[]> };
  assert.equal(merged.hooks.Stop!.length, 1);
  assert.deepEqual(removeHooks(merged), {});
});
