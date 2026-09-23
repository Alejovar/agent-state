import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, initProject, hook, AUTH_APP } from "./helpers.js";
import { loadConfig } from "../src/core/config.js";
import { allowMemoryCommands } from "../src/integrations/claude.js";

test("reminders: decisions and failed approaches surface right before editing a related file, once per context", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    hook(p, { hook_event_name: "UserPromptSubmit", prompt: "Add OAuth" });
    p.emit({ type: "DECISION_RECORDED", task_id: "task_1", payload: { number: 1, decision: "Reuse Redis sessions instead of JWT", reason: "Redis is already deployed", alternatives: ["JWT"], files: ["src/auth/session.ts"] } });
    p.emit({ type: "DECISION_RECORDED", task_id: "task_1", payload: { number: 2, decision: "Keep google.ts free of framework imports" } });
    p.emit({ type: "NOTE_RECORDED", task_id: "task_1", payload: { kind: "failed_attempt", text: "Signed-cookie state broke on Safari", files: ["src/auth/"] } });
    p.emit({ type: "DECISION_RECORDED", task_id: "task_1", payload: { number: 3, decision: "Use pnpm", files: ["package.json"] } });

    const edit = (path: string, id: string) =>
      hook(p, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: id, tool_input: { file_path: join(repo.root, path) } });

    const first = JSON.parse(edit("src/auth/session.ts", "e1").stdout!);
    const ctx = first.hookSpecificOutput.additionalContext as string;
    assert.equal(first.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(first.hookSpecificOutput.permissionDecision, undefined, "reminders never block");
    assert.match(ctx, /before editing src\/auth\/session\.ts/);
    assert.match(ctx, /decision #1: Reuse Redis sessions instead of JWT \(because Redis is already deployed\)\. Rejected: JWT\./);
    assert.match(ctx, /already tried and failed: Signed-cookie state broke on Safari/, "directory links apply to files inside");
    assert.doesNotMatch(ctx, /decision #3|decision #2/, "unrelated decisions stay out");

    assert.equal(edit("src/auth/session.ts", "e2").stdout, undefined, "not repeated within the same context");
    const other = JSON.parse(edit("src/auth/google.ts", "e3").stdout!).hookSpecificOutput.additionalContext;
    assert.match(other, /decision #2/, "a mention of the file name links it");
    assert.doesNotMatch(other, /Safari/, "already delivered in this context");
    assert.equal(edit("README.md", "e4").stdout, undefined);

    // After compaction the context no longer holds them: remind again.
    hook(p, { hook_event_name: "PreCompact", trigger: "auto" });
    assert.match(JSON.parse(edit("src/auth/session.ts", "e5").stdout!).hookSpecificOutput.additionalContext, /decision #1/);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("reminders: rerunning a command that failed last time", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    hook(p, { hook_event_name: "UserPromptSubmit", prompt: "Fix build" });
    hook(p, { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "pnpm build" }, error: "src/a.ts(3,1): error TS2304: Cannot find name 'foo'\nExit code 2" });
    const r = JSON.parse(hook(p, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b2", tool_input: { command: "pnpm  build" } }).stdout!);
    assert.match(r.hookSpecificOutput.additionalContext, /`pnpm build` failed last time: .*TS2304/);
    // Once it passes, no more reminders.
    hook(p, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "b2", tool_input: { command: "pnpm build" }, tool_response: { stdout: "ok" } });
    hook(p, { hook_event_name: "PreCompact", trigger: "manual" });
    assert.equal(hook(p, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b3", tool_input: { command: "pnpm build" } }).stdout, undefined);
    assert.equal(hook(p, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b4", tool_input: { command: "ls" } }).stdout, undefined);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("reminders can be disabled; blocked edits get no reminder", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    hook(p, { hook_event_name: "UserPromptSubmit", prompt: "Auth" });
    p.emit({ type: "DECISION_RECORDED", task_id: "task_1", payload: { number: 1, decision: "x", files: ["src/auth/session.ts"] } });
    p.config.reminders.enabled = false;
    assert.equal(hook(p, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "1", tool_input: { file_path: join(repo.root, "src/auth/session.ts") } }).stdout, undefined);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("fresh start: at fresh_at the state is saved and /clear is suggested; /clear restores it", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    const transcript = join(repo.root, "t.jsonl");
    const usage = (n: number) => JSON.stringify({ message: { usage: { input_tokens: 0, cache_read_input_tokens: n } } }) + "\n";
    writeFileSync(transcript, usage(50_000));
    hook(p, { hook_event_name: "UserPromptSubmit", prompt: "Long task", transcript_path: transcript });
    writeFileSync(transcript, usage(125_000));
    const msg = JSON.parse(hook(p, { hook_event_name: "Stop", transcript_path: transcript }).stdout!).systemMessage as string;
    assert.match(msg, /context usage ~63% \(estimated\)\. Task #1 state saved \(\d+ B\)\. To keep quality high, type \/clear/);
    const start = hook(p, { hook_event_name: "SessionStart", session_id: "sess-2", source: "clear" }).stdout!;
    assert.match(start, /RECOVERY CONTEXT — Task #1/);
    assert.match(start, /Long task/);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("config: legacy warn_at maps to fresh_at; installer allows only the memory commands", () => {
  const repo = makeRepo({ "a.txt": "x" });
  try {
    const f = join(repo.root, "c.yaml");
    writeFileSync(f, "context:\n  warn_at: 0.7\n");
    assert.equal(loadConfig(f).context.fresh_at, 0.7);
    writeFileSync(f, "context:\n  fresh_at: 0.5\n  warn_at: 0.7\n");
    assert.equal(loadConfig(f).context.fresh_at, 0.5);
  } finally {
    repo.cleanup();
  }
  const s = allowMemoryCommands({ permissions: { allow: ["Bash(ls:*)"], deny: ["Bash(rm:*)"] } }, "agent-state") as { permissions: { allow: string[]; deny: string[] } };
  assert.deepEqual(s.permissions.allow, ["Bash(ls:*)", "Bash(agent-state decide:*)", "Bash(agent-state note:*)"]);
  assert.deepEqual(s.permissions.deny, ["Bash(rm:*)"]);
  assert.equal((allowMemoryCommands(s, "agent-state") as typeof s).permissions.allow.length, 3, "idempotent");
});
