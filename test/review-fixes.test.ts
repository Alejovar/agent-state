import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, initProject, hook, cli, AUTH_APP } from "./helpers.js";
import { TaskService } from "../src/core/tasks.js";
import { nodeSupported } from "../src/core/runtime.js";
import { describesWork } from "../src/adapters/session-core.js";

test("a session that started without a task is attributed to the task it later works on, in every view", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    hook(p, { hook_event_name: "SessionStart", session_id: "late", source: "startup" }); // no task yet
    const svc = new TaskService(p);
    const t = svc.create("Created from the shell"); // no SESSION_STARTED carries the task
    p.emit({ type: "USER_REQUEST", agent_id: "claude-code", session_id: "cc_late", task_id: t.id, payload: { text: "work on it" } });
    p.setCurrent({ task_id: null }); // e.g. `task done` elsewhere cleared the pointer
    p.emit({ type: "SESSION_ENDED", agent_id: "claude-code", session_id: "cc_late", task_id: null, payload: { reason: "other" } });
    const viaGet = svc.get(t.id)!;
    const viaLoad = svc.load().tasks.get(t.id)!;
    assert.deepEqual(viaGet.sessions.map((s) => s.id), ["cc_late"]);
    assert.deepEqual(viaLoad.sessions.map((s) => [s.id, s.label]), viaGet.sessions.map((s) => [s.id, s.label]));
    assert.ok(viaGet.sessions[0]!.ended_at, "the end is seen even though SESSION_ENDED carried no task");
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("`agent-state rebuild` repairs a corrupted database", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    new TaskService(p).create("Keep me");
    p.close();
    const db = join(repo.root, ".agent-state/state.db");
    for (const s of ["-wal", "-shm"]) if (existsSync(db + s)) writeFileSync(db + s, "");
    writeFileSync(db, "garbage".repeat(500));
    const r = cli(repo.root, ["rebuild"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(cli(repo.root, ["task", "list"]).stdout, /Keep me/);
  } finally {
    repo.cleanup();
  }
});

test("node:sqlite availability by version", () => {
  for (const v of ["22.13.0", "22.20.1", "23.4.0", "24.0.0", "26.1.0"]) assert.equal(nodeSupported(v), true, v);
  for (const v of ["20.18.0", "22.12.0", "23.0.0", "23.3.1"]) assert.equal(nodeSupported(v), false, v);
});

test("prompts in scripts without spaces create tasks", () => {
  assert.equal(describesWork("修复登录页面的错误"), true);
  assert.equal(describesWork("ログイン画面を直して"), true);
  assert.equal(describesWork("好"), false);
});

test("an explicit task switch keeps the task from being treated as stale; short gaps are shown in hours", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    const old = new Date(Date.now() - 4 * 86_400_000).toISOString();
    p.emit({ type: "TASK_CREATED", task_id: "task_1", ts: old, payload: { number: 1, goal: "Old", base_head: null, base_branch: null } });
    p.emit({ type: "TASK_UPDATED", task_id: "task_1", ts: old, payload: { status: "ACTIVE" } });
    new TaskService(p).switchTo("task_1");
    const out = hook(p, { hook_event_name: "SessionStart", session_id: "n", source: "startup" }).stdout ?? "";
    assert.doesNotMatch(out, /starts fresh/);
    assert.equal(new TaskService(p).currentTask()!.id, "task_1");

    p.config.recovery.resume_window_hours = 6;
    p.emit({ type: "TASK_UPDATED", task_id: "task_1", ts: new Date(Date.now() - 10 * 3_600_000).toISOString(), payload: { status: "ACTIVE" } });
    // Make "now" the latest activity 10 h ago by starting a second project view.
    p.close();
    const p2 = initProject(repo);
    p2.config.recovery.resume_window_hours = 6;
    // Only the switch (just now) exists as recent activity, so drop it for this check.
    p2.setCurrent({ task_id: null });
    const fresh = hook(p2, { hook_event_name: "SessionStart", session_id: "m", source: "startup" }).stdout ?? "";
    assert.doesNotMatch(fresh, /0 day\(s\)/);
    p2.close();
  } finally {
    repo.cleanup();
  }
});

test("a broken config is logged once, not on every hook", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    initProject(repo).close();
    writeFileSync(join(repo.root, ".agent-state/config.yaml"), "a: [\n");
    for (let i = 0; i < 5; i++) cli(repo.root, ["hook", "claude-code"], JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: repo.root, tool_name: "Bash", tool_input: { command: "ls" } }));
    const log = readFileSync(join(repo.root, ".agent-state/reports/hook-errors.log"), "utf8").trim().split("\n");
    assert.equal(log.length, 1, log.join("\n"));
    assert.match(log[0]!, /paused: config\.yaml error/);
  } finally {
    repo.cleanup();
  }
});

test("unsupported Node: hooks still answer with the JSON each agent expects", async () => {
  const { spawnSync } = await import("node:child_process");
  const { CLI } = await import("./helpers.js");
  // Simulate an old runtime by overriding process.versions before the CLI loads.
  const shim = `Object.defineProperty(process.versions, "node", { value: "22.12.0" }); await import(${JSON.stringify(new URL("file://" + CLI).href)});`;
  const run = (agent: string) => spawnSync(process.execPath, ["--input-type=module", "-e", shim, "cli.js", "hook", agent], { input: "{}", encoding: "utf8" });
  const cursor = run("cursor");
  assert.equal(cursor.status, 0);
  assert.deepEqual(JSON.parse(cursor.stdout), { permission: "allow", continue: true });
  assert.equal(run("gemini").stdout, "{}");
  assert.match(cursor.stderr, /needs Node\.js 22\.13\+/);
});
