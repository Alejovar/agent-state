import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, relative, sep, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";

export const STATE_DIR = ".agent-state";

export interface ProjectPaths {
  root: string;
  state: string;
  config: string;
  db: string;
  events: string;
  checkpoints: string;
  sessions: string;
  decisions: string;
  index: string;
  recovery: string;
  reports: string;
  tasks: string;
  current: string;
}

export function pathsFor(root: string): ProjectPaths {
  const state = join(root, STATE_DIR);
  return {
    root,
    state,
    config: join(state, "config.yaml"),
    db: join(state, "state.db"),
    events: join(state, "events"),
    checkpoints: join(state, "checkpoints"),
    sessions: join(state, "sessions"),
    decisions: join(state, "decisions"),
    index: join(state, "index"),
    recovery: join(state, "recovery"),
    reports: join(state, "reports"),
    tasks: join(state, "tasks"),
    current: join(state, "current.json"),
  };
}

/** Walks up from `start` looking for an initialized `.agent-state` directory. */
export function findStateRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, STATE_DIR);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function gitToplevel(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Canonical absolute path: symlinks resolved and, on Windows, 8.3 short names
 * (RUNNER~1) expanded, so the same location always compares equal no matter
 * which form git or the agent reported. Works for paths that don't exist yet.
 */
export function canonicalPath(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/** Project-relative POSIX path, or null when `file` lies outside the project. */
export function toProjectPath(root: string, file: string, cwd: string = root): string | null {
  const abs = canonicalPath(isAbsolute(file) ? file : resolve(cwd, file));
  const rel = relative(canonicalPath(root), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}
