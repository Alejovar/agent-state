import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, type FileRole } from "./classify.js";
import { hashFile } from "./hash.js";
import { diffDeps, MANIFESTS, type DepDiff } from "./deps.js";
import type { Project } from "./project.js";
import type { Task } from "./tasks.js";
import type { WorkingState } from "./state.js";

export interface ChangedFile {
  path: string;
  kind: "created" | "modified" | "deleted" | "renamed";
  from?: string;
  role: FileRole;
  exists: boolean;
  staged: boolean;
  /** git = observed in git now; events = only seen in recorded agent events. */
  evidence: "git" | "events";
  edits: number;
}

export interface ChangeMap {
  task_id: string | null;
  base_head: string | null;
  head: string | null;
  branch: string | null;
  is_git: boolean;
  files: ChangedFile[];
  dependencies: DepDiff[];
  commits: { sha: string; subject: string }[];
}

/**
 * Deterministic change map for a task: git state relative to the task's base
 * commit, merged with file events the agent reported.
 */
export function buildChangeMap(project: Project, task: Task | null, state: WorkingState | null): ChangeMap {
  const git = project.git;
  const isGit = git.isRepo();
  const base = task?.base_head ?? null;
  const files = new Map<string, ChangedFile>();
  let head: string | null = null;
  let branch: string | null = null;
  let commits: { sha: string; subject: string }[] = [];

  if (isGit) {
    head = git.head();
    branch = git.branch();
    const baseDirty = task?.base_dirty ?? {};
    for (const c of git.changes(base)) {
      if (c.path.startsWith(".agent-state/")) continue;
      if (c.path in baseDirty && hashFile(join(project.root, c.path)) === baseDirty[c.path]) continue;
      files.set(c.path, {
        path: c.path,
        kind: c.kind,
        ...(c.from ? { from: c.from } : {}),
        role: classify(c.path),
        exists: existsSync(join(project.root, c.path)),
        staged: c.staged,
        evidence: "git",
        edits: state?.files.get(c.path)?.count ?? 0,
      });
    }
    if (base && head && base !== head) commits = git.commitsSince(base);
  }

  if (state) {
    for (const [path, f] of state.files) {
      if (files.has(path)) continue;
      // In a git repo, git is authoritative: a file the agent touched that shows no
      // net change relative to the task base was reverted, so it is not a change.
      if (isGit) continue;
      const exists = existsSync(join(project.root, path));
      files.set(path, {
        path,
        kind: exists ? (f.last === "deleted" ? "modified" : f.last) : "deleted",
        role: classify(path),
        exists,
        staged: false,
        evidence: "events",
        edits: f.count,
      });
    }
  }

  const dependencies: DepDiff[] = [];
  if (isGit) {
    for (const f of files.values()) {
      if (!MANIFESTS.test(f.path)) continue;
      const before = base ? git.fileAt(base, f.path) : git.fileAt("HEAD", f.path);
      const full = join(project.root, f.path);
      const after = existsSync(full) ? readFileSync(full, "utf8") : null;
      const d = diffDeps(f.path, before, after);
      if (d) dependencies.push(d);
    }
  }

  return {
    task_id: task?.id ?? null,
    base_head: base,
    head,
    branch,
    is_git: isGit,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    dependencies,
    commits,
  };
}
