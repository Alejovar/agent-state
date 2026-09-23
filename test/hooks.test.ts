import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, initProject, hook, cli, AUTH_APP } from "./helpers.js";
import { TaskService } from "../src/core/tasks.js";
import { saveContract } from "../src/core/scope.js";
import { mergeHooks, removeHooks } from "../src/integrations/claude.js";
import { handleCodexNotification } from "../src/adapters/codex.js";

test("a prompt creates a task; later sessions attach to it; compaction re-injects context", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    const first = hook(p, { hook_event_name: "SessionStart", source: "startup" }).stdout!;
    assert.match(first, /agent-state decide/, "no task yet → only the one-line guidance");
    assert.doesNotMatch(first, /RECOVERY CONTEXT|Unfinished task/);
    hook(p, { hook_event_name: "UserPromptSubmit", prompt: "/help" });
    assert.equal(new TaskService(p).list().length, 0, "slash commands do not create tasks");
    hook(p, { hook_event_name: "UserPromptSubmit", prompt: "Add password reset flow" });
    const [t] = new TaskService(p).list();
    assert.equal(t!.goal, "Add password reset flow");

    const pre = hook(p, { hook_event_name: "PreCompact", trigger: "auto" });
    assert.match(pre.stdout!, /saved recovery state for task #1/);
    assert.equal(new TaskService(p).get(t!.id)!.status, "COMPACTED");

    const start = hook(p, { hook_event_name: "SessionStart", source: "compact" });
    assert.match(start.stdout!, /RECOVERY CONTEXT — Task #1/);
    assert.match(start.stdout!, /Add password reset flow/);
    assert.equal(new TaskService(p).get(t!.id)!.status, "RECOVERED");

    hook(p, { hook_event_name: "UserPromptSubmit", prompt: "continue" });
    assert.equal(new TaskService(p).get(t!.id)!.status, "ACTIVE");

    // A brand-new session on startup gets a brief notice, not the full context.
    const brief = hook(p, { hook_event_name: "SessionStart", session_id: "sess-2", source: "startup" });
    assert.match(brief.stdout!, /Unfinished task #1/);
    assert.doesNotMatch(brief.stdout!, /RECOVERY CONTEXT/);
    const task = new TaskService(p).get(t!.id)!;
    assert.deepEqual(task.sessions.map((s) => s.label), ["#1-A", "#1-B"]);

    hook(p, { hook_event_name: "SessionEnd", session_id: "sess-2", reason: "prompt_input_exit" });
    assert.equal(new TaskService(p).get(t!.id)!.status, "PAUSED");
    assert.ok(existsSync(join(p.paths.recovery, "task-1.md")), "session end leaves a recovery state behind");
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("tool events: file create/modify, commands, tests, todos, subagents; trivial commands skipped", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    hook(p, { hook_event_name: "UserPromptSubmit", prompt: "Refactor sessions" });
    const f = join(repo.root, "src/auth/new.ts");
    hook(p, { hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: "1", tool_input: { file_path: f } });
    writeFileSync(f, "x");
    hook(p, { hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: "1", tool_input: { file_path: f }, tool_response: {} });
    hook(p, { hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: "2", tool_input: { file_path: f } });
    hook(p, { hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: "2", tool_input: { file_path: f }, tool_response: {} });
    hook(p, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "3", tool_input: { file_path: "/etc/hosts" }, tool_response: {} });
    hook(p, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "4", tool_input: { command: "ls -la" } });
    hook(p, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "4", tool_input: { command: "ls -la" }, tool_response: { stdout: "x" } });
    hook(p, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "5", tool_input: { command: "pnpm test" } });
    hook(p, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "5", tool_input: { command: "pnpm test" }, tool_response: { stdout: "Tests  23 passed (23)", stderr: "" } });
    hook(p, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "6", tool_input: { command: "pnpm build" }, tool_response: { stdout: "", stderr: "error TS2345", exit_code: 2 } });
    hook(p, { hook_event_name: "SubagentStart", agent_id: "sub1", agent_type: "Explore" });
    hook(p, { hook_event_name: "SubagentStop", agent_id: "sub1", agent_type: "Explore" });
    hook(p, { hook_event_name: "PostToolUse", tool_name: "TaskCreate", tool_use_id: "7", tool_input: { subject: "Write migration" }, tool_response: { id: "t1" } });
    hook(p, { hook_event_name: "PostToolUse", tool_name: "TaskUpdate", tool_use_id: "8", tool_input: { taskId: "t1", status: "completed" }, tool_response: {} });

    const events = p.db().query({ task_id: "task_1" });
    const files = events.filter((e) => e.type.startsWith("FILE_"));
    assert.deepEqual(files.map((e) => [e.type, e.payload.path]), [["FILE_CREATED", "src/auth/new.ts"], ["FILE_MODIFIED", "src/auth/new.ts"]]);
    const cmds = events.filter((e) => e.type === "COMMAND_EXECUTED");
    assert.deepEqual(cmds.map((e) => [e.payload.command, e.payload.ok]), [["pnpm build", false]]);
    assert.match(String(cmds[0]!.payload.output_tail), /TS2345/);
    const tests = events.filter((e) => e.type === "TEST_FINISHED");
    assert.equal(tests[0]!.payload.ok, true);
    assert.equal(tests[0]!.payload.passed, 23);
    assert.equal(events.filter((e) => e.type === "SUBAGENT_STARTED").length, 1);
    const todos = events.filter((e) => e.type === "TODOS_UPDATED").at(-1)!;
    assert.deepEqual(todos.payload.items, [{ content: "Write migration", status: "completed" }]);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("commands without a completion signal are recorded as unknown at Stop", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    hook(p, { hook_event_name: "UserPromptSubmit", prompt: "Run tests" });
    hook(p, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "x", tool_input: { command: "pytest" } });
    // Backdate the pending entry.
    const sessFile = join(p.paths.sessions, "cc_sess-1.json");
    const s = JSON.parse(readFileSync(sessFile, "utf8"));
    s.pending.x.ts = new Date(Date.now() - 120_000).toISOString();
    writeFileSync(sessFile, JSON.stringify(s));
    hook(p, { hook_event_name: "Stop" });
    const t = p.db().query({ types: ["TEST_FINISHED"] });
    assert.equal(t.length, 1);
    assert.equal(t[0]!.payload.ok, null);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("scope policies: warn, confirm, block", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    hook(p, { hook_event_name: "UserPromptSubmit", prompt: "Implement OAuth" });
    saveContract(p, { task: { id: 1, goal: "Implement OAuth" }, scope: { allowed: ["src/auth/**", "tests/auth/**"], restricted: ["database/**"] }, expected: [] });
    const edit = (path: string) => hook(p, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: path, tool_input: { file_path: join(repo.root, path) } });

    assert.equal(edit("src/auth/google.ts").stdout, undefined, "in scope → silent");
    const warn = JSON.parse(edit("docker-compose.yml").stdout!);
    assert.match(warn.systemMessage, /scope expansion/);

    saveContract(p, { task: { id: 1, goal: "x" }, scope: { allowed: ["src/auth/**"], restricted: ["database/**"] }, expected: [], policy: "confirm" });
    const ask = JSON.parse(edit("src/routes/login.ts").stdout!);
    assert.equal(ask.hookSpecificOutput.permissionDecision, "ask");

    saveContract(p, { task: { id: 1, goal: "x" }, scope: { allowed: ["src/auth/**"], restricted: ["database/**"] }, expected: [], policy: "block" });
    const deny = JSON.parse(edit("database/schema.sql").stdout!);
    assert.equal(deny.hookSpecificOutput.permissionDecision, "deny");
    assert.match(deny.hookSpecificOutput.permissionDecisionReason, /restricted scope "database\/\*\*"/);
    assert.equal(p.db().query({ types: ["SCOPE_VIOLATION"] }).length, 3);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("context pressure: warn once, then auto-generate recovery", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    const transcript = join(repo.root, "transcript.jsonl");
    const usage = (n: number) => JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 100, cache_read_input_tokens: n, cache_creation_input_tokens: 0 } } }) + "\n";
    writeFileSync(transcript, usage(10_000));
    hook(p, { hook_event_name: "UserPromptSubmit", prompt: "Big task", transcript_path: transcript });
    writeFileSync(transcript, usage(165_000));
    const warn = hook(p, { hook_event_name: "Stop", transcript_path: transcript });
    assert.match(JSON.parse(warn.stdout!).systemMessage, /context usage ~83% \(estimated\)/);
    assert.equal(hook(p, { hook_event_name: "Stop", transcript_path: transcript }).stdout, undefined, "not repeated");
    writeFileSync(transcript, usage(190_000));
    const compact = hook(p, { hook_event_name: "Stop", transcript_path: transcript });
    assert.match(JSON.parse(compact.stdout!).systemMessage, /recovery state has been generated: \.agent-state\/recovery\/task-1\.md/);
    assert.ok(existsSync(join(p.paths.recovery, "task-1.md")));
    // Malformed/missing transcripts degrade to unknown.
    writeFileSync(transcript, "garbage\n");
    assert.equal(hook(p, { hook_event_name: "Stop", transcript_path: transcript }).stdout, undefined);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("hook CLI is silent outside agent-state projects and never fails the agent", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const out = cli(repo.root, ["hook", "claude-code"], JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "x", prompt: "hi" }));
    assert.equal(out.code, 0);
    assert.equal(out.stdout, "");
    initProject(repo).close();
    const bad = cli(repo.root, ["hook", "claude-code"], "{not json");
    assert.equal(bad.code, 0);
    assert.ok(existsSync(join(repo.root, ".agent-state/reports/hook-errors.log")));
  } finally {
    repo.cleanup();
  }
});

test("installing hooks merges with existing settings and uninstall removes only ours", () => {
  const existing = { permissions: { allow: ["Bash(ls:*)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }] } };
  const merged = mergeHooks(existing, "agent-state") as { hooks: Record<string, { hooks: { command: string }[] }[]>; permissions: unknown };
  assert.deepEqual(merged.permissions, existing.permissions);
  assert.equal(merged.hooks.PreToolUse!.length, 2);
  assert.ok(merged.hooks.SessionStart![0]!.hooks[0]!.command.includes("agent-state hook claude-code"));
  const twice = mergeHooks(merged, "agent-state") as typeof merged;
  assert.equal(twice.hooks.PreToolUse!.length, 2, "idempotent");
  const removed = removeHooks(twice) as typeof merged;
  assert.deepEqual(removed.hooks, { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }] });
});

test("codex notify adapter records turns", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    handleCodexNotification(p, { type: "agent-turn-complete", "thread-id": "th1", "turn-id": "1", "input-messages": ["Fix flaky login test"], "last-assistant-message": "Stabilized the test by awaiting the redirect." });
    const [t] = new TaskService(p).list();
    assert.equal(t!.goal, "Fix flaky login test");
    assert.equal(t!.sessions[0]!.agent_id, "codex");
    assert.equal(p.db().query({ types: ["USER_REQUEST"] }).length, 1);
    handleCodexNotification(p, { type: "other" });
    p.close();
  } finally {
    repo.cleanup();
  }
});
