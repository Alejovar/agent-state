import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, cli, AUTH_APP } from "./helpers.js";

test("end-to-end CLI workflow: init → task → notes → compact → recover → checkpoint → restore", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const r = repo.root;
    assert.equal(cli(r, ["status"]).code, 1, "not initialized yet");
    const init = cli(r, ["init", "--claude"]);
    assert.equal(init.code, 0, init.stderr);
    assert.match(readFileSync(join(r, ".gitignore"), "utf8"), /^\.agent-state\/$/m);
    const settings = JSON.parse(readFileSync(join(r, ".claude/settings.local.json"), "utf8"));
    assert.ok(settings.hooks.PreCompact);
    assert.ok(existsSync(join(r, ".claude/commands/recover.md")));

    assert.equal(cli(r, ["task", "new", "Implement", "Google", "OAuth"]).code, 0);
    assert.equal(cli(r, ["note", "done", "Provider integration"]).code, 0);
    assert.equal(cli(r, ["note", "pending", "Integration tests"]).code, 0);
    assert.equal(cli(r, ["note", "next", "Handle expired OAuth state"]).code, 0);
    assert.equal(cli(r, ["decide", "Use Redis sessions", "--reason", "Already deployed", "--rejected", "JWT"]).code, 0);
    assert.equal(cli(r, ["note", "bogus", "x"]).code, 2);
    repo.write("src/auth/callback.ts", "export const cb = 1;\n");

    const status = JSON.parse(cli(r, ["status", "--json"]).stdout);
    assert.equal(status.task.number, 1);
    assert.equal(status.changes, 1, "only callback.ts: .gitignore/.claude changes predate the task");

    const compact = cli(r, ["compact"]);
    assert.equal(compact.code, 0, compact.stderr);
    assert.match(compact.stdout, /Recovery state generated/);
    const rec = cli(r, ["recover", "1"]);
    assert.match(rec.stdout, /You are resuming task #1/);
    assert.match(rec.stdout, /Handle expired OAuth state/);
    const recJson = JSON.parse(cli(r, ["recover", "--json"]).stdout);
    assert.equal(recJson.schema, "agent-state/recovery@1");
    assert.match(cli(r, ["continue", "--print"]).stdout, /RECOVERY CONTEXT/);
    assert.match(cli(r, ["handoff", "--stdout"]).stdout, /HANDOFF — Task #1/);

    assert.equal(cli(r, ["checkpoint", "cp1"]).code, 0);
    repo.write("src/auth/callback.ts", "broken\n");
    const dry = cli(r, ["restore", "cp1", "--dry-run"]);
    assert.match(dry.stdout, /Dry run — nothing was changed/);
    assert.equal(readFileSync(join(r, "src/auth/callback.ts"), "utf8"), "broken\n");
    const refused = cli(r, ["restore", "cp1"]);
    assert.equal(refused.code, 1, "non-interactive restore without --yes is refused");
    assert.equal(readFileSync(join(r, "src/auth/callback.ts"), "utf8"), "broken\n");
    assert.equal(cli(r, ["restore", "cp1", "--yes"]).code, 0);
    assert.equal(readFileSync(join(r, "src/auth/callback.ts"), "utf8"), "export const cb = 1;\n");

    assert.match(cli(r, ["decisions"]).stdout, /Use Redis sessions/);
    assert.match(cli(r, ["history", "OAuth"]).stdout, /Implement Google OAuth/);
    assert.match(cli(r, ["impact", "src/auth/session.ts"]).stdout, /src\/middleware\/auth\.ts/);
    assert.match(cli(r, ["drift"]).stdout, /CONTEXT DRIFT/);
    assert.equal(cli(r, ["scope", "init", "--allow", "src/auth/**"]).code, 0);
    assert.equal(cli(r, ["scope", "check", "--strict"]).code, 0);
    repo.write("docker-compose.yml", "services: {}\n");
    const check = cli(r, ["scope", "check", "--strict"]);
    assert.equal(check.code, 1);
    assert.match(check.stdout, /SCOPE EXPANSION DETECTED[\s\S]*docker-compose\.yml/);
    assert.equal(cli(r, ["task", "done"]).code, 0);
    assert.match(cli(r, ["task", "list", "--all"]).stdout, /COMPLETED/);
    assert.equal(cli(r, ["rebuild"]).code, 0);
  } finally {
    repo.cleanup();
  }
});

test("usage errors and unknown commands", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    assert.equal(cli(repo.root, ["nope"]).code, 2);
    assert.match(cli(repo.root, ["--help"]).stdout, /agent-state/);
    assert.match(cli(repo.root, ["restore", "--help"]).stdout, /dry-run/);
    cli(repo.root, ["init"]);
    const r = cli(repo.root, ["recover"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /No active task/);
    assert.equal(cli(repo.root, ["checkpoint", "x", "--bogus"]).code, 2);
    assert.match(cli(repo.root, ["restore", "missing"]).stderr, /No checkpoint named "missing"/);
  } finally {
    repo.cleanup();
  }
});
