import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, cli, AUTH_APP } from "./helpers.js";
import { detectAgents } from "../src/integrations/detect.js";

test("detectAgents finds agents by their config directory", () => {
  const repo = makeRepo({}, { git: false });
  try {
    mkdirSync(join(repo.root, ".gemini"));
    const found = detectAgents(repo.root);
    const gemini = found.find((a) => a.id === "gemini-cli");
    assert.ok(gemini, JSON.stringify(found));
  } finally {
    repo.cleanup();
  }
});

test("init with flags installs only what was asked; bare command shows status; uninstall keeps user config", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const r = repo.root;
    mkdirSync(join(r, ".claude"), { recursive: true });
    writeFileSync(join(r, ".claude/settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "my-notifier" }] }] } }));
    const init = cli(r, ["init", "--claude"]);
    assert.equal(init.code, 0, init.stderr);
    assert.match(init.stdout, /What happens now/);
    assert.ok(!existsSync(join(r, ".cursor/hooks.json")), "only the requested agent");
    const settings = JSON.parse(readFileSync(join(r, ".claude/settings.local.json"), "utf8"));
    assert.ok(settings.permissions.allow.some((a: string) => / decide:\*\)$/.test(a)));

    const bare = cli(r, []);
    assert.match(bare.stdout, /AGENT STATE/);
    assert.match(bare.stdout, /starts by itself with your first request/);

    assert.equal(cli(r, ["doctor"]).code, 0);

    const un = cli(r, ["uninstall"]);
    assert.equal(un.code, 0);
    const after = JSON.parse(readFileSync(join(r, ".claude/settings.local.json"), "utf8"));
    assert.deepEqual(after, { permissions: { allow: ["Bash(ls:*)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "my-notifier" }] }] } });
    assert.ok(!existsSync(join(r, ".claude/commands/recover.md")));
    assert.ok(existsSync(join(r, ".agent-state")), "memory kept without --purge");
    assert.equal(cli(r, ["uninstall", "--purge", "--yes"]).code, 0);
    assert.ok(!existsSync(join(r, ".agent-state")));
  } finally {
    repo.cleanup();
  }
});

test("doctor reports hooks that point at a missing script", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const r = repo.root;
    cli(r, ["init", "--no-hooks"]);
    mkdirSync(join(r, ".cursor"), { recursive: true });
    writeFileSync(join(r, ".cursor/hooks.json"), JSON.stringify({ version: 1, hooks: { stop: [{ command: 'node "/nonexistent/agent-state/dist/cli.js" hook cursor' }] } }));
    const d = cli(r, ["doctor"]);
    assert.equal(d.code, 1);
    assert.match(d.stdout, /Cursor hooks call \/nonexistent\/agent-state\/dist\/cli\.js, which no longer exists/);
  } finally {
    repo.cleanup();
  }
});

test("bare command outside a project points to init", () => {
  const repo = makeRepo({}, { git: false });
  try {
    const out = cli(repo.root, []);
    assert.equal(out.code, 0);
    assert.match(out.stdout, /Get started: agent-state init/);
  } finally {
    repo.cleanup();
  }
});
