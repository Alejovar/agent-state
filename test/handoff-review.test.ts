import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, initProject, hook, cli, AUTH_APP } from "./helpers.js";
import { activeLimits } from "../src/core/limits.js";
import { buildReview, renderReview } from "../src/core/review.js";
import { notifySequence } from "../src/adapters/claude-hooks.js";
import { TaskService } from "../src/core/tasks.js";
import { hookConfig } from "../src/integrations/claude.js";

test("usage limit: StopFailure(rate_limit) saves state, notifies, and marks the limit active until activity resumes", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    hook(p, { hook_event_name: "UserPromptSubmit", prompt: "Build OAuth" });
    assert.equal(hook(p, { hook_event_name: "StopFailure", error_type: "overloaded", error_message: "busy" } as never).stdout, undefined, "only usage limits trigger a handoff");
    const r = hook(p, { hook_event_name: "StopFailure", error_type: "rate_limit", error_message: "Rate limit exceeded" } as never);
    const out = JSON.parse(r.stdout!);
    assert.deepEqual(Object.keys(out), ["terminalSequence"], "StopFailure output is discarded except terminalSequence");
    assert.match(out.terminalSequence, /^\x1b\]9;Claude hit its usage limit\. Task #1 saved - run: agent-state continue\x07/);
    assert.ok(!/\x1b\[/.test(out.terminalSequence), "only allowlisted OSC sequences (no CSI)");
    const limits = activeLimits(p);
    assert.equal(limits.length, 1);
    assert.equal(limits[0]!.agent_id, "claude-code");
    // A recovery state exists for the next agent.
    assert.match(cli(repo.root, ["recover", "--raw"]).stdout, /Build OAuth/);
    // The limit reset once Claude works again.
    hook(p, { hook_event_name: "UserPromptSubmit", prompt: "back again" });
    assert.equal(activeLimits(p).length, 0);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("continue hands the task to another agent when Claude is limited", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    hook(p, { hook_event_name: "UserPromptSubmit", prompt: "Build OAuth" });
    hook(p, { hook_event_name: "StopFailure", error_type: "rate_limit", error_message: "limit" } as never);
    p.close();
    const printed = cli(repo.root, ["continue", "--print", "--agent", "codex"]);
    assert.match(printed.stdout, /previous agent \(Claude Code\) stopped because it reached its usage limit/);
    assert.match(printed.stdout, /RECOVERY CONTEXT — Task #1/);
    const status = cli(repo.root, ["status"]);
    assert.match(status.stdout, /claude-code hit its usage limit/);
    assert.match(status.stdout, /agent-state continue/);
  } finally {
    repo.cleanup();
  }
});

test("notify sequence strips control characters and separators", () => {
  const s = notifySequence("a;b", "line\nwith;semi\x1b[31m");
  assert.ok(!s.includes("\n"));
  assert.ok(!/\x1b\[/.test(s));
  assert.match(s, /\x1b\]777;notify;a b;line with semi \[31m\x07/);
  assert.deepEqual(hookConfig("agent-state").StopFailure![0]!.matcher, "rate_limit");
});

test("review brief: flags risky changes, explains why, suggests an order", () => {
  const repo = makeRepo({ ...AUTH_APP, "tests/auth/google.test.ts": 'import { googleLogin } from "../../src/auth/google";\ntest("a", () => {});\ntest("b", () => {});\ntest("c", () => {});\ntest("d", () => {});\ntest("e", () => {});\ntest("f", () => {});\ntest("g", () => {});\n' });
  try {
    const p = initProject(repo);
    hook(p, { hook_event_name: "UserPromptSubmit", prompt: "Make login faster" });
    repo.write("src/auth/session.ts", AUTH_APP["src/auth/session.ts"] + "// @ts-ignore\nexport const cache: any = {};\ntry { warm(); } catch (e) {}\nconst apiKey = \"abcd1234efgh\";\n");
    repo.write("tests/auth/session.test.ts", AUTH_APP["tests/auth/session.test.ts"]!.replace('test("session"', 'test.skip("session"'));
    rmSync(join(repo.root, "tests/auth/google.test.ts"));
    repo.write(".github/workflows/ci.yml", "on: push\n");
    repo.write("package.json", JSON.stringify({ name: "shop", dependencies: { express: "^4.19.0", ioredis: "^5.0.0", "left-pad": "1.0.0" } }));
    p.emit({ type: "DECISION_RECORDED", task_id: "task_1", payload: { number: 1, decision: "Cache sessions in memory", reason: "Redis round-trips dominate latency" } });
    hook(p, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t", tool_input: { command: "pnpm test" }, tool_response: { stdout: "Tests  12 passed (12)" } });

    const b = buildReview(p, new TaskService(p).get("task_1")!);
    const msgs = b.flags.map((f) => `${f.severity} ${f.file ?? "-"} ${f.message}`);
    const has = (re: RegExp) => assert.ok(msgs.some((m) => re.test(m)), `missing ${re}\n${msgs.join("\n")}`);
    has(/^high tests\/auth\/session\.test\.ts skips a test/);
    has(/^high tests\/auth\/google\.test\.ts deletes a test file/);
    has(/^high src\/auth\/session\.ts hardcodes something that looks like a credential/);
    has(/^medium src\/auth\/session\.ts silences the TypeScript compiler/);
    has(/^medium src\/auth\/session\.ts swallows an error silently/);
    has(/^medium \.github\/workflows\/ci\.yml changes infrastructure/);
    has(/^medium package\.json adds dependencies: left-pad/);
    assert.equal(b.flags[0]!.severity, "high", "most severe first");
    assert.equal(b.review_order[0], "src/auth/session.ts", "riskiest file first");
    assert.deepEqual(b.requests, ["Make login faster"]);
    const md = renderReview(b);
    assert.match(md, /# Review brief — Task #1: Make login faster/);
    assert.match(md, /Decision #1: Cache sessions in memory — Redis round-trips dominate latency/);
    assert.match(md, /`pnpm test` passed \(12 passed, 0 failed\)/);
    assert.match(md, /## Suggested review order\n1\. `src\/auth\/session\.ts`/);
    // The secret itself never appears in the brief.
    assert.ok(!md.includes("abcd1234efgh"));
    assert.match(cli(repo.root, ["review"]).stdout, /Look closely at/);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("review brief: a clean change says so", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    hook(p, { hook_event_name: "UserPromptSubmit", prompt: "Rename helper" });
    repo.write("src/auth/google.ts", AUTH_APP["src/auth/google.ts"] + "export const provider = \"google\";\n");
    hook(p, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t", tool_input: { command: "pnpm test" }, tool_response: { stdout: "Tests  3 passed (3)" } });
    const md = renderReview(buildReview(p, new TaskService(p).get("task_1")!));
    assert.match(md, /nothing high-risk/);
    p.close();
  } finally {
    repo.cleanup();
  }
});
