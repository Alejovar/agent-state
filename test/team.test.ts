import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRepo, cli, AUTH_APP } from "./helpers.js";

test("team: share → team → recover --from, through a git remote; prompts and events never leave", () => {
  const remote = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-state-remote-")));
  execFileSync("git", ["init", "-q", "--bare", remote]);
  const alex = makeRepo(AUTH_APP);
  let beaCleanup: (() => void) | null = null;
  try {
    alex.git("config", "user.email", "alex@example.com");
    alex.git("remote", "add", "origin", remote);
    alex.git("push", "-q", "origin", "main");
    cli(alex.root, ["init", "--no-hooks"]);
    cli(alex.root, ["task", "new", "Migrate sessions to Redis cluster"]);
    cli(alex.root, ["note", "next", "Switch reads to the cluster client"]);
    cli(alex.root, ["decide", "Use ioredis Cluster", "--reason", "already a dependency"]);
    cli(alex.root, ["hook", "claude-code"], JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: alex.root, prompt: "my password is hunter2 please migrate" }));

    const dry = cli(alex.root, ["share", "--dry-run"]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /Share as "alex"/);
    assert.match(dry.stdout, /tasks\/task-1\.md/);
    assert.match(dry.stdout, /Dry run: nothing was sent/);
    assert.equal(execFileSync("git", ["-C", remote, "for-each-ref", "refs/agent-state"], { encoding: "utf8" }), "", "dry run pushed nothing");
    assert.equal(cli(alex.root, ["share"]).code, 1, "non-interactive share needs --yes");
    const sent = cli(alex.root, ["share", "--yes"]);
    assert.equal(sent.code, 0, sent.stderr);
    assert.match(execFileSync("git", ["-C", remote, "for-each-ref", "refs/agent-state"], { encoding: "utf8" }), /refs\/agent-state\/shared\/alex/);

    // Bea clones the project and looks at what the team shared.
    const beaRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-state-bea-")));
    rmSync(beaRoot, { recursive: true });
    execFileSync("git", ["clone", "-q", remote, beaRoot]);
    beaCleanup = () => rmSync(beaRoot, { recursive: true, force: true });
    cli(beaRoot, ["init", "--no-hooks"]);
    const list = cli(beaRoot, ["team"]);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /alex\s+#1\s+Migrate sessions to Redis cluster/);
    const rec = cli(beaRoot, ["recover", "--from", "alex", "1"]);
    assert.match(rec.stdout, /picking up task #1 from your teammate alex/);
    assert.match(rec.stdout, /Switch reads to the cluster client/);
    assert.match(rec.stdout, /Use ioredis Cluster/);
    // Privacy: no verbatim prompts, no secrets, no event log.
    const everything = execFileSync("git", ["-C", beaRoot, "grep", "-I", "-e", ".", "refs/agent-state/team/alex"], { encoding: "utf8" });
    assert.ok(!everything.includes("hunter2"));
    assert.ok(!everything.includes("please migrate"));
    assert.ok(!/events\/|\.jsonl/.test(execFileSync("git", ["-C", beaRoot, "ls-tree", "-r", "--name-only", "refs/agent-state/team/alex"], { encoding: "utf8" })));
    // Sharing again updates the same ref.
    cli(alex.root, ["note", "done", "Switch reads to the cluster client"]);
    assert.equal(cli(alex.root, ["share", "--yes"]).code, 0);
    cli(beaRoot, ["team"]);
    assert.match(cli(beaRoot, ["team", "show", "alex", "1"]).stdout, /- \[x\] Switch reads to the cluster client/);
  } finally {
    alex.cleanup();
    beaCleanup?.();
    rmSync(remote, { recursive: true, force: true });
  }
});

test("share refuses without a usable remote", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    cli(repo.root, ["init", "--no-hooks"]);
    const r = cli(repo.root, ["share", "--dry-run"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /No git remote named "origin"/);
  } finally {
    repo.cleanup();
  }
});
