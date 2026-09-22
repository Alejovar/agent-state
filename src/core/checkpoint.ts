import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Project } from "./project.js";
import { readJson, writeJson } from "./store.js";
import { GitError } from "./git.js";

export interface CheckpointMeta {
  name: string;
  created_at: string;
  head: string | null;
  branch: string | null;
  /** Commit whose tree is the full working tree (tracked + untracked, respecting .gitignore). */
  commit: string;
  worktree_tree: string;
  index_tree: string;
  task_id: string | null;
  session_id: string | null;
  changed_files: string[];
  staged_files: string[];
  message?: string;
  auto?: boolean;
}

export interface RestorePlan {
  checkpoint: CheckpointMeta;
  current_head: string | null;
  head_matches: boolean;
  /** Paths restore would write, create or delete. */
  create: string[];
  modify: string[];
  delete: string[];
  /** Files with uncommitted work right now. */
  current_changes: string[];
  /** Files with uncommitted work that restore would overwrite or delete. */
  conflicts: string[];
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REF_PREFIX = "refs/agent-state/checkpoints/";

const IDENTITY = {
  GIT_AUTHOR_NAME: "agent-state",
  GIT_AUTHOR_EMAIL: "agent-state@localhost",
  GIT_COMMITTER_NAME: "agent-state",
  GIT_COMMITTER_EMAIL: "agent-state@localhost",
};

export class CheckpointError extends Error {}

export class Checkpoints {
  constructor(private readonly project: Project) {}

  private metaPath(name: string): string {
    return join(this.project.paths.checkpoints, `${name}.json`);
  }

  private requireGit(): void {
    if (!this.project.git.isRepo()) {
      throw new CheckpointError("Checkpoints require a git repository (they are stored as private git objects under refs/agent-state/).");
    }
  }

  /**
   * Snapshots the complete working tree into a tree object using a temporary
   * index, so the user's real index and working tree are never modified.
   */
  private snapshotTree(): string {
    const git = this.project.git;
    const realIndex = git.run(["rev-parse", "--git-path", "index"]).trim();
    const realIndexAbs = isAbsolute(realIndex) ? realIndex : resolve(this.project.root, realIndex);
    const dir = mkdtempSync(join(tmpdir(), "agent-state-"));
    const tmpIndex = join(dir, "index");
    try {
      if (existsSync(realIndexAbs)) copyFileSync(realIndexAbs, tmpIndex);
      const env = { GIT_INDEX_FILE: tmpIndex };
      git.run(["add", "-A"], { env });
      // Never snapshot agent-state's own data, even if the user chose not to gitignore it.
      git.run(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".agent-state"], { env });
      return git.run(["write-tree"], { env }).trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private indexTree(): string {
    try {
      return this.project.git.run(["write-tree"]).trim();
    } catch (err) {
      throw new CheckpointError(`Cannot capture the index (unresolved merge conflicts?): ${(err as Error).message}`);
    }
  }

  create(name: string, opts: { message?: string; force?: boolean; auto?: boolean; task_id?: string | null; session_id?: string | null } = {}): CheckpointMeta {
    this.requireGit();
    if (!NAME_RE.test(name)) throw new CheckpointError(`Invalid checkpoint name "${name}". Use letters, digits, ".", "_" or "-".`);
    if (existsSync(this.metaPath(name)) && !opts.force) {
      throw new CheckpointError(`Checkpoint "${name}" already exists. Use --force to overwrite it.`);
    }
    const git = this.project.git;
    const head = git.head();
    const branch = git.branch();
    const indexTree = this.indexTree();
    const wtTree = this.snapshotTree();
    const parents = head ? ["-p", head] : [];
    const indexCommit = git
      .run(["commit-tree", indexTree, ...parents, "-m", `agent-state index: ${name}`], { env: IDENTITY })
      .trim();
    const commit = git
      .run(["commit-tree", wtTree, ...parents, "-p", indexCommit, "-m", `agent-state checkpoint: ${name}${opts.message ? `\n\n${opts.message}` : ""}`], {
        env: IDENTITY,
      })
      .trim();
    git.run(["update-ref", `${REF_PREFIX}${name}`, commit]);

    const status = git.status();
    const meta: CheckpointMeta = {
      name,
      created_at: new Date().toISOString(),
      head,
      branch,
      commit,
      worktree_tree: wtTree,
      index_tree: indexTree,
      task_id: opts.task_id ?? null,
      session_id: opts.session_id ?? null,
      changed_files: status.entries.filter((e) => !e.path.startsWith(".agent-state/")).map((e) => e.path),
      staged_files: status.entries.filter((e) => !e.untracked && e.index !== ".").map((e) => e.path),
      ...(opts.message ? { message: opts.message } : {}),
      ...(opts.auto ? { auto: true } : {}),
    };
    writeJson(this.metaPath(name), meta);
    this.project.emit({
      type: "CHECKPOINT_CREATED",
      task_id: meta.task_id,
      session_id: meta.session_id,
      payload: { name, head, branch, commit, files: meta.changed_files.length, auto: !!opts.auto },
    });
    return meta;
  }

  list(): CheckpointMeta[] {
    if (!existsSync(this.project.paths.checkpoints)) return [];
    return readdirSync(this.project.paths.checkpoints)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".recovery.json"))
      .map((f) => readJson<CheckpointMeta | null>(join(this.project.paths.checkpoints, f), null))
      .filter((m): m is CheckpointMeta => !!m && typeof m.commit === "string")
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  get(name: string): CheckpointMeta | null {
    const m = readJson<CheckpointMeta | null>(this.metaPath(name), null);
    return m && typeof m.commit === "string" ? m : null;
  }

  remove(name: string): void {
    this.requireGit();
    const m = this.get(name);
    if (!m) throw new CheckpointError(`No checkpoint named "${name}".`);
    this.project.git.run(["update-ref", "-d", `${REF_PREFIX}${name}`], { allowFail: true });
    unlinkSync(this.metaPath(name));
  }

  plan(name: string): RestorePlan {
    this.requireGit();
    const cp = this.get(name);
    if (!cp) throw new CheckpointError(`No checkpoint named "${name}". See \`agent-state checkpoints\`.`);
    const git = this.project.git;
    if (!git.hasCommit(cp.commit)) throw new CheckpointError(`Checkpoint "${name}" points to a missing git object (${cp.commit.slice(0, 10)}).`);
    const currentTree = this.snapshotTree();
    const head = git.head();
    const create: string[] = [];
    const modify: string[] = [];
    const del: string[] = [];
    const out = git.run(["diff-tree", "-r", "-z", "--no-renames", "--name-status", currentTree, cp.worktree_tree]);
    const parts = out.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i];
      if (!code) continue;
      const path = parts[++i]!;
      if (code === "A") create.push(path);
      else if (code === "D") del.push(path);
      else modify.push(path);
    }
    const current_changes = git
      .status()
      .entries.map((e) => e.path)
      .filter((p) => !p.startsWith(".agent-state/"));
    // Uncommitted work is at risk only if restore touches that path AND the
    // content differs from what the checkpoint recorded for it.
    const touched = new Set([...create, ...modify, ...del]);
    const conflicts = current_changes.filter((p) => touched.has(p));
    return { checkpoint: cp, current_head: head, head_matches: head === cp.head, create, modify, delete: del, current_changes, conflicts };
  }

  /**
   * Restores the working tree (and the index, when HEAD matches) to the
   * checkpoint. A safety checkpoint of the current state is taken first so a
   * restore can itself be undone. HEAD and branches are never moved.
   */
  restore(name: string, opts: { backup?: boolean; task_id?: string | null } = {}): { plan: RestorePlan; backup: string | null; index_restored: boolean } {
    const plan = this.plan(name);
    let backup: string | null = null;
    if (opts.backup !== false) {
      backup = `pre-restore-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}`;
      this.create(backup, { force: true, auto: true, message: `automatic backup before restoring ${name}`, task_id: opts.task_id ?? null });
    }
    const git = this.project.git;
    const write = [...plan.create, ...plan.modify];
    if (write.length) {
      git.run(["restore", `--source=${plan.checkpoint.commit}`, "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        input: write.join("\0") + "\0",
        // File names are data, never pathspec patterns (a file named "*.ts" must not match everything).
        env: { GIT_LITERAL_PATHSPECS: "1" },
      });
    }
    for (const p of plan.delete) {
      try {
        rmSync(join(this.project.root, p), { force: true });
      } catch (err) {
        throw new GitError(`Could not delete ${p}: ${(err as Error).message}`);
      }
    }
    let index_restored = false;
    if (plan.head_matches) {
      git.run(["read-tree", plan.checkpoint.index_tree]);
      git.run(["update-index", "-q", "--refresh"], { allowFail: true });
      index_restored = true;
    }
    this.project.emit({
      type: "CHECKPOINT_RESTORED",
      task_id: opts.task_id ?? plan.checkpoint.task_id,
      payload: { name, backup, files: write.length + plan.delete.length, index_restored },
    });
    return { plan, backup, index_restored };
  }
}
