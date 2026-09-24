import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, initProject, cli, AUTH_APP } from "./helpers.js";
import { importAiderHistory, aider } from "../src/adapters/aider.js";
import { TaskService } from "../src/core/tasks.js";

// Exactly what aider/io.py writes (user_input / append_chat_history / tool_output).
const SESSION_1 = `
# aider chat started at 2026-09-23 10:00:00

> Aider v0.86.0
> Model: sonnet with diff edit format

#### Add rate limiting to the login route  
#### keep the existing Redis client  

I'll add a small limiter using the Redis client you already have.

src/routes/login.ts
<<<<<<< SEARCH
=======
>>>>>>> REPLACE

> Applied edit to src/routes/login.ts  
> Commit 1a2b3c4 feat: add login rate limiting  

#### run the tests  

> Running npm test  
> Added 12 lines of output to the chat.  
`;

test("aider: chat history becomes a session, a task, requests, edits and commands", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    const hist = join(repo.root, ".aider.chat.history.md");
    writeFileSync(hist, SESSION_1);
    const r = importAiderHistory(p);
    assert.deepEqual(r, { sessions: 1, requests: 2, edits: 1, commands: 1 });
    const [t] = new TaskService(p).list();
    assert.equal(t!.goal, "Add rate limiting to the login route");
    assert.equal(t!.sessions[0]!.agent_id, "aider");
    const reqs = p.db().query({ types: ["USER_REQUEST"] }).map((e) => e.payload.text);
    assert.deepEqual(reqs, ["Add rate limiting to the login route\nkeep the existing Redis client", "run the tests"]);
    const files = p.db().query({ types: ["FILE_MODIFIED"] }).map((e) => e.payload.path);
    assert.deepEqual(files, ["src/routes/login.ts"]);
    const cmd = p.db().query({ types: ["TEST_FINISHED", "COMMAND_EXECUTED"] })[0]!;
    assert.equal(cmd.payload.command, "npm test");
    assert.equal(cmd.payload.ok, null, "aider doesn't log exit codes: unknown, not guessed");

    // Incremental: nothing new → nothing imported; appended turns are picked up.
    assert.deepEqual(importAiderHistory(p), { sessions: 0, requests: 0, edits: 0, commands: 0 });
    appendFileSync(hist, "#### now handle the 429 response  \n\n> Applied edit to src/auth/session.ts  \n");
    assert.deepEqual(importAiderHistory(p), { sessions: 0, requests: 1, edits: 1, commands: 0 });
    // A partially written line waits for the next import.
    appendFileSync(hist, "#### half-writ");
    assert.equal(importAiderHistory(p).requests, 0);
    appendFileSync(hist, "ten line  \n");
    assert.equal(importAiderHistory(p).requests, 1);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("aider: history is imported automatically by any command; continue passes the context as a read-only file", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    initProject(repo).close();
    writeFileSync(join(repo.root, ".aider.chat.history.md"), SESSION_1);
    const status = cli(repo.root, ["status"]);
    assert.match(status.stdout, /Add rate limiting to the login route/);
    const launch = aider.launchCommand!("CONTEXT BODY")!;
    assert.equal(launch.cmd, "aider");
    assert.equal(launch.args[0], "--read");
    assert.equal(readFileSync(launch.args[1]!, "utf8"), "CONTEXT BODY");
    assert.match(cli(repo.root, ["continue", "--print", "--agent", "aider"]).stdout, /RECOVERY CONTEXT/);
  } finally {
    repo.cleanup();
  }
});

test("aider: a replaced/truncated history starts over without crashing", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    const hist = join(repo.root, ".aider.chat.history.md");
    writeFileSync(hist, SESSION_1);
    importAiderHistory(p);
    writeFileSync(hist, "\n# aider chat started at 2026-09-24 09:00:00\n\n#### write docs for the API  \n");
    const r = importAiderHistory(p);
    assert.equal(r.sessions, 1);
    assert.equal(r.requests, 1);
    p.close();
  } finally {
    repo.cleanup();
  }
});
