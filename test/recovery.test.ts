import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, initProject, hook, AUTH_APP } from "./helpers.js";
import { TaskService } from "../src/core/tasks.js";
import { compactTask, recoverTask } from "../src/core/compact.js";
import { renderMarkdown } from "../src/core/render.js";
import { reduceState } from "../src/core/state.js";

function session(repo: ReturnType<typeof makeRepo>) {
  const p = initProject(repo);
  hook(p, { hook_event_name: "SessionStart", source: "startup" });
  hook(p, { hook_event_name: "UserPromptSubmit", prompt: "Implement Google OAuth authentication\nuse the existing Redis sessions" });
  repo.write("src/auth/callback.ts", 'import { createSession } from "./session";\nexport const callback = () => createSession("x");\n');
  hook(p, { hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: "w1", tool_input: { file_path: join(repo.root, "src/auth/callback.ts") } });
  hook(p, { hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: "w1", tool_input: { file_path: join(repo.root, "src/auth/callback.ts") }, tool_response: {} });
  repo.write("src/auth/google.ts", AUTH_APP["src/auth/google.ts"] + "// provider config\n");
  hook(p, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "e1", tool_input: { file_path: join(repo.root, "src/auth/google.ts") }, tool_response: {} });
  hook(p, {
    hook_event_name: "PostToolUse",
    tool_name: "TodoWrite",
    tool_use_id: "t1",
    tool_input: {
      todos: [
        { content: "OAuth provider integration", status: "completed" },
        { content: "Callback endpoint", status: "completed" },
        { content: "OAuth state expiration handling", status: "in_progress" },
        { content: "Integration tests", status: "pending" },
      ],
    },
  });
  hook(p, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "pnpm test" } });
  hook(p, { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "pnpm test" }, error: "FAIL tests/auth/callback.test.ts\nTests  1 failed | 22 passed (23)\nError: state expired" });
  p.emit({ type: "DECISION_RECORDED", task_id: "task_1", payload: { number: 1, decision: "Use existing Redis session infrastructure", reason: "Redis already deployed", alternatives: ["JWT"], files: ["src/auth/session.ts"] } });
  p.emit({ type: "NOTE_RECORDED", task_id: "task_1", payload: { kind: "issue", text: "OAuth callback fails when OAuth state expires" } });
  p.emit({ type: "NOTE_RECORDED", task_id: "task_1", payload: { kind: "failed_attempt", text: "Storing state in a signed cookie broke on Safari" } });
  return p;
}

test("compaction preserves the minimum sufficient state with evidence levels", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = session(repo);
    const task = new TaskService(p).get("task_1")!;
    assert.equal(task.goal, "Implement Google OAuth authentication");
    const r = compactTask(p, task);
    const s = r.state;
    assert.equal(s.objective.text, "Implement Google OAuth authentication");
    assert.deepEqual(s.completed.map((c) => c.text), ["OAuth provider integration", "Callback endpoint"]);
    assert.deepEqual(s.in_progress.map((c) => c.text), ["OAuth state expiration handling"]);
    assert.deepEqual(s.pending.map((c) => c.text), ["Integration tests"]);
    assert.equal(s.decisions[0]!.decision, "Use existing Redis session infrastructure");
    assert.ok(s.issues.some((i) => i.text.includes("state expires")));
    assert.ok(s.issues.some((i) => i.text.includes("Tests failing")));
    assert.equal(s.failed_attempts.length, 1);
    const files = Object.fromEntries(s.files.map((f) => [f.path, f]));
    assert.equal(files["src/auth/callback.ts"]!.kind, "created");
    assert.equal(files["src/auth/callback.ts"]!.evidence, "git");
    assert.equal(files["src/auth/google.ts"]!.kind, "modified");
    assert.equal(s.tests[0]!.ok, false);
    assert.equal(s.tests[0]!.failed, 1);
    assert.equal(s.next_action.text, "Continue: OAuth state expiration handling");
    assert.equal(s.next_action.evidence, "inferred");
    assert.equal(s.task.status, "COMPACTED");
    // Persisted in both forms.
    assert.ok(existsSync(r.paths.md) && existsSync(r.paths.json));
    const md = readFileSync(r.paths.md, "utf8");
    assert.match(md, /RECOVERY CONTEXT — Task #1/);
    assert.match(md, /Next recommended action/);
    assert.match(md, /✓ A src\/auth\/callback\.ts/);
    assert.match(md, /Rejected: JWT/);
    assert.ok(md.length < 6000);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("explicit next action wins; done notes supersede pending ones", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = session(repo);
    p.emit({ type: "NOTE_RECORDED", task_id: "task_1", payload: { kind: "pending", text: "Write docs" } });
    p.emit({ type: "NOTE_RECORDED", task_id: "task_1", payload: { kind: "done", text: "Write docs" } });
    p.emit({ type: "NOTE_RECORDED", task_id: "task_1", payload: { kind: "next", text: "Add TTL to OAuth state in Redis" } });
    p.emit({ type: "NOTE_RECORDED", task_id: "task_1", payload: { kind: "resolved", text: "OAuth callback fails" } });
    const s = recoverTask(p, new TaskService(p).get("task_1")!).state;
    assert.equal(s.next_action.text, "Add TTL to OAuth state in Redis");
    assert.equal(s.next_action.evidence, "recorded");
    assert.ok(s.completed.some((c) => c.text === "Write docs"));
    assert.ok(!s.pending.some((c) => c.text === "Write docs"));
    assert.ok(!s.issues.some((i) => i.text.includes("callback fails")), "resolved issue is gone");
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("recovery reports conflicts: repository wins over the saved state", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = session(repo);
    const task = new TaskService(p).get("task_1")!;
    compactTask(p, task);
    // Reality diverges after compaction.
    rmSync(join(repo.root, "src/auth/callback.ts"));
    repo.write("src/auth/google.ts", "// rewritten\n");
    repo.git("checkout", "-q", "-b", "feature/other");
    repo.git("add", "src/auth/google.ts");
    repo.git("commit", "-qm", "rewrite google");
    const r = recoverTask(p, new TaskService(p).get("task_1")!);
    const kinds = r.state.conflicts.map((c) => c.kind);
    assert.ok(kinds.includes("missing_file"), JSON.stringify(r.state.conflicts));
    assert.ok(kinds.includes("branch_changed"));
    assert.ok(kinds.includes("head_moved"));
    assert.ok(r.state.conflicts.some((c) => c.message.includes("rewrite google")));
    assert.match(r.markdown, /Recovery state conflicts \(repository is the source of truth\)/);
    // The removed file is no longer claimed as a change.
    assert.ok(!r.state.files.some((f) => f.path === "src/auth/callback.ts" && f.exists));
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("rendered recovery respects the byte budget and never drops critical sections", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = session(repo);
    for (let i = 0; i < 120; i++) {
      p.emit({ type: "NOTE_RECORDED", task_id: "task_1", payload: { kind: "pending", text: `Pending item number ${i} with a reasonably long description to take space` } });
      p.emit({ type: "NOTE_RECORDED", task_id: "task_1", payload: { kind: "done", text: `Completed thing ${i} with plenty of words in it to make it long` } });
    }
    const r = recoverTask(p, new TaskService(p).get("task_1")!, { maxBytes: 2500 });
    assert.ok(Buffer.byteLength(r.markdown) <= 2500, `size ${Buffer.byteLength(r.markdown)}`);
    assert.match(r.markdown, /Objective/);
    assert.match(r.markdown, /Next recommended action/);
    assert.ok(r.state.stats.truncated.includes("completed"));
    const { markdown: big } = renderMarkdown(r.state, { maxBytes: 100_000 });
    assert.ok(big.length > r.markdown.length);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("works without git: changes come from recorded events and are labelled", () => {
  const repo = makeRepo({ "a.txt": "x" }, { git: false });
  try {
    const p = initProject(repo);
    const t = new TaskService(p).create("No-git task");
    repo.write("b.ts", "export const b = 1;\n");
    p.emit({ type: "FILE_CREATED", task_id: t.id, payload: { path: "b.ts" } });
    const s = recoverTask(p, new TaskService(p).get(t.id)!).state;
    assert.equal(s.repository.is_git, false);
    assert.equal(s.files[0]!.evidence, "events");
    assert.ok(s.unknowns.some((u) => u.includes("Not a git repository")));
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("working state reducer: latest todo snapshot, failing commands clear when they pass", () => {
  const e = (type: string, payload: Record<string, unknown>, ts: string) => ({ v: 1 as const, id: ts, ts, type, agent_id: "a", session_id: null, task_id: "task_1", payload }) as never;
  const s = reduceState("task_1", [
    e("COMMAND_EXECUTED", { command: "pnpm build", ok: false }, "2026-01-01T00:00:01Z"),
    e("COMMAND_EXECUTED", { command: "pnpm lint", ok: false }, "2026-01-01T00:00:02Z"),
    e("COMMAND_EXECUTED", { command: "pnpm build", ok: true }, "2026-01-01T00:00:03Z"),
    e("TODOS_UPDATED", { items: [{ content: "a", status: "pending" }] }, "2026-01-01T00:00:04Z"),
    e("TODOS_UPDATED", { items: [{ content: "a", status: "completed" }] }, "2026-01-01T00:00:05Z"),
  ]);
  assert.deepEqual(s.commands.failing.map((c) => c.command), ["pnpm lint"]);
  assert.equal(s.todos!.items[0]!.status, "completed");
});
