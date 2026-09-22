import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, initProject, AUTH_APP } from "./helpers.js";
import { TaskService, parseTaskRef, reduceTasks } from "../src/core/tasks.js";
import { sessionLetter } from "../src/core/ids.js";

test("task refs and session letters", () => {
  assert.equal(parseTaskRef("184"), "task_184");
  assert.equal(parseTaskRef("#7"), "task_7");
  assert.equal(parseTaskRef("task_3"), "task_3");
  assert.equal(parseTaskRef("abc"), null);
  assert.deepEqual([0, 1, 25, 26, 27].map(sessionLetter), ["A", "B", "Z", "AA", "AB"]);
});

test("a task spans multiple sessions and keeps its own lifecycle", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    const svc = new TaskService(p);
    const t = svc.create("Implement Google OAuth");
    assert.equal(t.number, 1);
    assert.equal(t.status, "ACTIVE");
    assert.equal(t.base_branch, "main");
    assert.ok(t.base_head);
    for (const sid of ["s-a", "s-b", "s-c"]) {
      p.emit({ type: "SESSION_STARTED", agent_id: "claude-code", session_id: sid, task_id: t.id, payload: {} });
      p.emit({ type: "SESSION_ENDED", agent_id: "claude-code", session_id: sid, task_id: t.id, payload: {} });
    }
    const loaded = svc.get(t.id)!;
    assert.deepEqual(loaded.sessions.map((s) => s.label), ["#1-A", "#1-B", "#1-C"]);
    svc.setStatus(t.id, "COMPACTED");
    svc.setStatus(t.id, "PAUSED");
    assert.equal(svc.get(t.id)!.status, "PAUSED");
    assert.equal(svc.latestUnfinished()!.id, t.id);
    const t2 = svc.create("Second task");
    assert.equal(t2.number, 2);
    svc.setStatus(t2.id, "COMPLETED");
    assert.equal(svc.latestUnfinished()!.id, t.id);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("session lifecycle is independent from task lifecycle (reducer)", () => {
  const ev = (type: string, extra: Record<string, unknown> = {}) => ({ v: 1 as const, id: `e${Math.random()}`, ts: new Date().toISOString(), agent_id: "x", session_id: null, task_id: null, payload: {}, type, ...extra });
  const { tasks, sessions } = reduceTasks([
    ev("TASK_CREATED", { task_id: "task_1", payload: { number: 1, goal: "g", base_head: null, base_branch: null } }),
    ev("SESSION_STARTED", { session_id: "s1" }),
    ev("USER_REQUEST", { session_id: "s1", task_id: "task_1", payload: { text: "hi" } }),
    ev("SESSION_ENDED", { session_id: "s1", task_id: "task_1" }),
  ] as never);
  assert.equal(sessions.get("s1")!.task_id, "task_1", "session joins the first task it reports");
  assert.ok(sessions.get("s1")!.ended_at);
  assert.equal(tasks.get("task_1")!.status, "NEW", "ending a session does not change the task status");
});
