import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, initProject, AUTH_APP } from "./helpers.js";
import { Checkpoints, CheckpointError } from "../src/core/checkpoint.js";
import { Git } from "../src/core/git.js";

test("git status parsing: clean, staged, unstaged, untracked, renamed, branch", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const g = new Git(repo.root);
    assert.equal(g.status().entries.length, 0);
    assert.equal(g.branch(), "main");
    repo.write("src/auth/session.ts", "changed\n");
    repo.write("new file.ts", "x\n");
    repo.git("mv", "src/auth/google.ts", "src/auth/google-oauth.ts");
    repo.write("README.md", "staged\n");
    repo.git("add", "README.md");
    const byPath = Object.fromEntries(g.changes().map((c) => [c.path, c]));
    assert.equal(byPath["src/auth/session.ts"]!.kind, "modified");
    assert.equal(byPath["src/auth/session.ts"]!.unstaged, true);
    assert.equal(byPath["new file.ts"]!.kind, "created");
    assert.equal(byPath["src/auth/google-oauth.ts"]!.kind, "renamed");
    assert.equal(byPath["src/auth/google-oauth.ts"]!.from, "src/auth/google.ts");
    assert.equal(byPath["README.md"]!.staged, true);
    repo.git("checkout", "-q", "-b", "feature");
    assert.equal(g.branch(), "feature");
  } finally {
    repo.cleanup();
  }
});

test("changes relative to a base include committed work", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const g = new Git(repo.root);
    const base = g.head()!;
    repo.write("src/new.ts", "x\n");
    repo.commit("add new");
    rmSync(join(repo.root, "src/routes/login.ts"));
    repo.commit("remove login");
    const byPath = Object.fromEntries(g.changes(base).map((c) => [c.path, c.kind]));
    assert.equal(byPath["src/new.ts"], "created");
    assert.equal(byPath["src/routes/login.ts"], "deleted");
    assert.equal(g.commitsSince(base).length, 2);
  } finally {
    repo.cleanup();
  }
});

test("checkpoint captures tree + index without touching the working tree, index or HEAD", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    repo.write("src/auth/session.ts", "staged version\n");
    repo.git("add", "src/auth/session.ts");
    repo.write("src/auth/session.ts", "worktree version\n");
    repo.write("untracked.ts", "u\n");
    const statusBefore = repo.git("status", "--porcelain");
    const headBefore = repo.git("rev-parse", "HEAD");
    const cp = new Checkpoints(p).create("before-refactor");
    assert.equal(repo.git("status", "--porcelain"), statusBefore);
    assert.equal(repo.git("rev-parse", "HEAD"), headBefore);
    assert.ok(cp.changed_files.includes("untracked.ts"));
    assert.deepEqual(cp.staged_files, ["src/auth/session.ts"]);
    assert.equal(repo.git("rev-parse", "refs/agent-state/checkpoints/before-refactor").trim(), cp.commit);
    assert.throws(() => new Checkpoints(p).create("before-refactor"), CheckpointError);
    assert.throws(() => new Checkpoints(p).create("bad name!"), CheckpointError);
    assert.equal(new Checkpoints(p).list()[0]!.name, "before-refactor");
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("restore: dry-run plan reports conflicts; restore brings back files and staging, with a backup", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    const cps = new Checkpoints(p);
    repo.write("src/auth/session.ts", "staged version\n");
    repo.git("add", "src/auth/session.ts");
    repo.write("wip.ts", "wip\n");
    cps.create("cp1");
    // Diverge.
    repo.write("src/auth/session.ts", "broken\n");
    rmSync(join(repo.root, "wip.ts"));
    repo.write("scratch.ts", "junk\n");
    const plan = cps.plan("cp1");
    assert.deepEqual(plan.create, ["wip.ts"]);
    assert.deepEqual(plan.modify, ["src/auth/session.ts"]);
    assert.deepEqual(plan.delete, ["scratch.ts"]);
    assert.deepEqual(plan.conflicts.sort(), ["scratch.ts", "src/auth/session.ts"]);
    assert.ok(plan.head_matches);
    // Dry run changes nothing.
    assert.equal(readFileSync(join(repo.root, "src/auth/session.ts"), "utf8"), "broken\n");

    const res = cps.restore("cp1");
    assert.ok(res.backup && res.backup.startsWith("pre-restore-"));
    assert.equal(readFileSync(join(repo.root, "src/auth/session.ts"), "utf8"), "staged version\n");
    assert.ok(existsSync(join(repo.root, "wip.ts")));
    assert.ok(!existsSync(join(repo.root, "scratch.ts")));
    assert.ok(res.index_restored);
    assert.match(repo.git("status", "--porcelain"), /^M  src\/auth\/session\.ts$/m);

    // The backup allows undoing the restore.
    cps.restore(res.backup!, { backup: false });
    assert.equal(readFileSync(join(repo.root, "src/auth/session.ts"), "utf8"), "broken\n");
    assert.ok(existsSync(join(repo.root, "scratch.ts")));
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("restore across a different HEAD restores files but leaves HEAD and index alone", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    const cps = new Checkpoints(p);
    repo.write("a.ts", "checkpointed\n");
    cps.create("cp");
    repo.commit("move on");
    repo.write("a.ts", "later\n");
    const head = repo.git("rev-parse", "HEAD");
    const plan = cps.plan("cp");
    assert.equal(plan.head_matches, false);
    const res = cps.restore("cp", { backup: false });
    assert.equal(res.index_restored, false);
    assert.equal(readFileSync(join(repo.root, "a.ts"), "utf8"), "checkpointed\n");
    assert.equal(repo.git("rev-parse", "HEAD"), head);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("checkpoints require git and say so", () => {
  const repo = makeRepo({ "a.txt": "x" }, { git: false });
  try {
    const p = initProject(repo);
    assert.throws(() => new Checkpoints(p).create("x"), /require a git repository/);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("restore treats file names literally (no pathspec globbing)", { skip: process.platform === "win32" && "Windows does not allow * in file names" }, () => {
  const repo = makeRepo({ "a.ts": "a\n", "b.ts": "b\n" });
  try {
    const p = initProject(repo);
    const cps = new Checkpoints(p);
    repo.write("*.ts", "star\n");
    cps.create("cp");
    repo.write("*.ts", "changed\n");
    repo.write("a.ts", "keep my edit\n");
    cps.restore("cp", { backup: false });
    assert.equal(readFileSync(join(repo.root, "*.ts"), "utf8"), "star\n");
    assert.equal(readFileSync(join(repo.root, "a.ts"), "utf8"), "a\n", "a.ts differs from checkpoint, so it is restored too");
    assert.equal(readFileSync(join(repo.root, "b.ts"), "utf8"), "b\n");
    p.close();
  } finally {
    repo.cleanup();
  }
});
