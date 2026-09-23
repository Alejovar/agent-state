import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, initProject, hook, cli, AUTH_APP } from "./helpers.js";
import { Project } from "../src/core/project.js";
import { TaskService } from "../src/core/tasks.js";

test("a malformed config.yaml pauses recording (never records with the wrong rules) and says so", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    initProject(repo).close();
    const cfg = join(repo.root, ".agent-state/config.yaml");
    const good = readFileSync(cfg, "utf8");
    writeFileSync(cfg, "privacy:\n  record_prompts: [unclosed\n");
    const r = cli(repo.root, ["hook", "claude-code"], JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: repo.root, prompt: "Fix the login bug" }));
    assert.equal(r.code, 0, "the agent is never broken");
    assert.match(JSON.parse(r.stdout).systemMessage, /agent-state is paused: .*config\.yaml has an error/);
    const status = cli(repo.root, ["status"]);
    assert.equal(status.code, 0, "read-only commands still work");
    assert.match(status.stderr, /not recording until it is fixed/);
    assert.doesNotMatch(status.stdout, /Fix the login bug/, "nothing was recorded");
    assert.equal(cli(repo.root, ["note", "context", "x", "--task", "1"]).code !== 0, true, "writes are refused");
    assert.match(cli(repo.root, ["doctor"]).stdout, /nothing is being recorded/);
    writeFileSync(cfg, good);
    cli(repo.root, ["hook", "claude-code"], JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: repo.root, prompt: "Fix the login bug" }));
    assert.match(cli(repo.root, ["status"]).stdout, /Fix the login bug/, "recording resumes once fixed");
  } finally {
    repo.cleanup();
  }
});

test("a corrupted state.db is rebuilt from the event log", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    new TaskService(p).create("Keep history");
    p.emit({ type: "NOTE_RECORDED", task_id: "task_1", payload: { kind: "next", text: "ship it" } });
    p.close();
    const db = join(repo.root, ".agent-state/state.db");
    for (const suffix of ["-wal", "-shm"]) if (existsSync(db + suffix)) writeFileSync(db + suffix, "");
    writeFileSync(db, "this is not a sqlite database at all".repeat(200));
    const r = cli(repo.root, ["recover", "--raw"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /rebuilt it from the event log/);
    assert.match(r.stdout, /ship it/);
    assert.ok(readdirSync(join(repo.root, ".agent-state")).some((f) => f.startsWith("state.db.corrupt-")), "old file kept aside");
  } finally {
    repo.cleanup();
  }
});

test("doctor flags hooks installed by an older version", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    cli(repo.root, ["init", "--claude"]);
    const file = join(repo.root, ".claude/settings.local.json");
    const s = JSON.parse(readFileSync(file, "utf8"));
    delete s.hooks.StopFailure;
    writeFileSync(file, JSON.stringify(s));
    const d = cli(repo.root, ["doctor"]);
    assert.equal(d.code, 1);
    assert.match(d.stdout, /Claude Code hooks are from an older agent-state \(missing: StopFailure\)/);
    cli(repo.root, ["init", "--claude"]);
    assert.doesNotMatch(cli(repo.root, ["doctor"]).stdout, /older agent-state/, "re-running init updates them");
  } finally {
    repo.cleanup();
  }
});

test("current-task lookup reads only that task's events (flat cost on large histories)", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    const svc = new TaskService(p);
    for (let i = 0; i < 30; i++) svc.create(`old task ${i}`);
    for (let i = 0; i < 3000; i++) p.emit({ type: "USER_REQUEST", session_id: `s${i % 20}`, task_id: `task_${1 + (i % 30)}`, payload: { text: `prompt ${i}` } });
    const current = svc.create("current");
    p.db();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 50; i++) assert.equal(svc.currentTask()!.id, current.id);
    const perCall = Number(process.hrtime.bigint() - t0) / 50 / 1e6;
    assert.ok(perCall < 5, `currentTask took ${perCall.toFixed(2)} ms`);
    // latestUnfinished still sees activity-driven ordering.
    assert.equal(svc.latestUnfinished()!.id, current.id);
    p.close();
    assert.ok(Project.open(repo.root));
  } finally {
    repo.cleanup();
  }
});

test("pressure is checked on prompts and turn ends, not on every tool call", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    const transcript = join(repo.root, "t.jsonl");
    writeFileSync(transcript, JSON.stringify({ message: { usage: { input_tokens: 0, cache_read_input_tokens: 150_000 } } }) + "\n");
    hook(p, { hook_event_name: "UserPromptSubmit", prompt: "Big refactor of sessions" });
    const edit = hook(p, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "1", tool_input: { file_path: join(repo.root, "src/auth/session.ts") }, tool_response: {}, transcript_path: transcript });
    assert.equal(edit.stdout, undefined);
    assert.match(JSON.parse(hook(p, { hook_event_name: "Stop", transcript_path: transcript }).stdout!).systemMessage, /state saved/);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("small talk doesn't create tasks; real requests do", async () => {
  const { describesWork } = await import("../src/adapters/session-core.js");
  for (const p of ["hola", "ok gracias", "Continue", "hi, thanks!", "/help", "", "sí, por favor"]) assert.equal(describesWork(p), false, p);
  for (const p of ["Fix build", "Add OAuth", "Refactor sessions", "arregla el login", "¿por qué falla el test de pagos?", "implementation"]) {
    assert.equal(describesWork(p), p !== "implementation", p);
  }
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    hook(p, { hook_event_name: "UserPromptSubmit", prompt: "hola" });
    assert.equal(new TaskService(p).list().length, 0);
    hook(p, { hook_event_name: "UserPromptSubmit", prompt: "Add rate limiting to login" });
    assert.equal(new TaskService(p).list()[0]!.goal, "Add rate limiting to login");
    assert.equal(p.db().query({ types: ["USER_REQUEST"] }).length, 2, "every prompt is still recorded");
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("a new session after days away starts fresh instead of joining the stale task", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
    p.emit({ type: "TASK_CREATED", task_id: "task_1", ts: old, payload: { number: 1, goal: "Old login work", base_head: null, base_branch: null } });
    p.emit({ type: "TASK_UPDATED", task_id: "task_1", ts: old, payload: { status: "ACTIVE" } });
    p.setCurrent({ task_id: "task_1" });
    const out = hook(p, { hook_event_name: "SessionStart", session_id: "new", source: "startup" }).stdout!;
    assert.match(out, /#1 "Old login work", was last active 5 day\(s\) ago, so this session starts fresh/);
    assert.match(out, /agent-state task switch 1/);
    hook(p, { hook_event_name: "UserPromptSubmit", session_id: "new", prompt: "Build the billing page" });
    const tasks = new TaskService(p).list();
    assert.equal(tasks[0]!.goal, "Build the billing page");
    assert.equal(tasks.length, 2);
    // Resuming (not a fresh start) still restores the old task.
    p.setCurrent({ task_id: "task_1" });
    assert.match(hook(p, { hook_event_name: "SessionStart", session_id: "old", source: "resume" }).stdout!, /Old login work/);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("a long-running session keeps its task fresh: activity, not just lifecycle, counts", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    const day = 86_400_000;
    const created = new Date(Date.now() - 5 * day).toISOString();
    p.emit({ type: "TASK_CREATED", task_id: "task_1", ts: created, payload: { number: 1, goal: "Long migration", base_head: null, base_branch: null } });
    p.emit({ type: "TASK_UPDATED", task_id: "task_1", ts: created, payload: { status: "ACTIVE" } });
    p.emit({ type: "USER_REQUEST", task_id: "task_1", session_id: "cc_a", ts: new Date(Date.now() - 60_000).toISOString(), payload: { text: "keep going" } });
    p.setCurrent({ task_id: "task_1", session_id: "cc_a" });
    const t = new TaskService(p).get("task_1")!;
    assert.ok(Date.now() - Date.parse(t.updated_at) < 5 * 60_000, "updated_at reflects the latest prompt");
    const out = hook(p, { hook_event_name: "SessionStart", session_id: "b", source: "startup" }).stdout ?? "";
    assert.doesNotMatch(out, /starts fresh/);
    assert.equal(new TaskService(p).currentTask()!.id, "task_1", "the working session is not detached");
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("instructions to the agent use the command that works on this machine", async () => {
  const { withCli, cliCommand } = await import("../src/core/invocation.js");
  const cmd = cliCommand();
  const text = withCli('run `agent-state decide "x"` and `agent-state note tried "y"`; the agent-state project');
  if (cmd === "agent-state") assert.match(text, /`agent-state decide/);
  else {
    assert.ok(text.includes("`" + cmd + " decide"), text);
    assert.ok(text.includes("`" + cmd + " note tried"), text);
    assert.match(text, /the agent-state project/, "prose mentions are left alone");
  }
  // End to end: a hook run through the CLI tells the agent a runnable command.
  const repo = makeRepo(AUTH_APP);
  try {
    initProject(repo).close();
    const out = cli(repo.root, ["hook", "claude-code"], JSON.stringify({ hook_event_name: "SessionStart", session_id: "s", cwd: repo.root, source: "startup" })).stdout;
    const m = /run `(.+?) decide "/.exec(out);
    assert.ok(m, out);
    const runnable = m![1]!;
    assert.ok(runnable === "agent-state" || /^node ".+cli\.js"$/.test(runnable), runnable);
  } finally {
    repo.cleanup();
  }
});
