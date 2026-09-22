import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeRepo, initProject } from "./helpers.js";
import { Project } from "../src/core/project.js";

test("events are appended as JSONL and projected incrementally", () => {
  const repo = makeRepo();
  try {
    const p = initProject(repo);
    p.emit({ type: "NOTE_RECORDED", task_id: "task_1", payload: { kind: "context", text: "hello world" } });
    assert.equal(p.db().count(), 1);
    p.emit({ type: "NOTE_RECORDED", task_id: "task_1", payload: { kind: "context", text: "second" } });
    assert.equal(p.db().count(), 2);
    assert.equal(p.db().query({ text: "second" }).length, 1);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("redacts secrets before they reach disk", () => {
  const repo = makeRepo();
  try {
    const p = initProject(repo);
    p.emit({ type: "COMMAND_EXECUTED", payload: { command: "curl -H 'Authorization: Bearer abcdefghijklmnop123' https://api", output_tail: "sk-ant-api03-zzzzzzzzzzzzzzzzzzzz" } });
    const raw = readdirSync(p.paths.events).map((f) => readFileSync(join(p.paths.events, f), "utf8")).join("");
    assert.ok(!raw.includes("abcdefghijklmnop123"));
    assert.ok(!raw.includes("zzzzzzzzzzzzzzzzzzzz"));
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("tolerates partial and corrupted lines", () => {
  const repo = makeRepo();
  try {
    const p = initProject(repo);
    p.emit({ type: "NOTE_RECORDED", payload: { kind: "context", text: "ok" } });
    const file = join(p.paths.events, "_project.jsonl");
    appendFileSync(file, "{not json}\n");
    appendFileSync(file, '{"v":1,"id":"evt_partial"'); // writer still in progress
    assert.equal(p.db().count(), 1);
    appendFileSync(file, ',"ts":"2026-01-01T00:00:00.000Z","type":"NOTE_RECORDED","agent_id":"cli","session_id":null,"task_id":null,"payload":{}}\n');
    assert.equal(p.db().count(), 2);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("the database is rebuildable from the event log", () => {
  const repo = makeRepo();
  try {
    const p = initProject(repo);
    for (let i = 0; i < 25; i++) p.emit({ type: "NOTE_RECORDED", payload: { kind: "context", text: `n${i}` } });
    assert.equal(p.db().count(), 25);
    assert.equal(p.store.rebuild(), 25);
    p.close();
    const again = Project.open(repo.root);
    assert.equal(again.db().count(), 25);
    again.close();
  } finally {
    repo.cleanup();
  }
});

test("concurrent writers (parallel hooks) never lose or interleave events", () => {
  const repo = makeRepo();
  try {
    const p = initProject(repo);
    p.close();
    const script = `
      import { Project } from ${JSON.stringify(new URL("../src/core/project.js", import.meta.url).href)};
      const p = Project.open(process.argv[1]);
      for (let i = 0; i < 100; i++) p.emit({ type: "NOTE_RECORDED", session_id: "shared", payload: { kind: "context", text: "x".repeat(500) + i } });
    `;
    const procs = Array.from({ length: 4 }, () =>
      spawnSync(process.execPath, ["--input-type=module", "-e", script, repo.root], { encoding: "utf8" }),
    );
    for (const r of procs) assert.equal(r.status, 0, r.stderr);
    const again = Project.open(repo.root);
    assert.equal(again.db().count(), 400);
    again.close();
  } finally {
    repo.cleanup();
  }
});
