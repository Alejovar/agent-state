import { execFileSync, spawnSync } from "node:child_process";

export class GitError extends Error {}

export interface StatusEntry {
  path: string;
  /** Original path for renames/copies. */
  from?: string;
  /** Index (staged) status letter, "." when unchanged. */
  index: string;
  /** Worktree (unstaged) status letter, "." when unchanged. */
  worktree: string;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitStatus {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: StatusEntry[];
}

export type ChangeKind = "created" | "modified" | "deleted" | "renamed";

export interface FileChange {
  path: string;
  kind: ChangeKind;
  from?: string;
  staged: boolean;
  unstaged: boolean;
}

/** Thin, synchronous wrapper around the git CLI. Never runs destructive commands on its own. */
export class Git {
  constructor(readonly cwd: string) {}

  run(args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string; allowFail?: boolean } = {}): string {
    const res = spawnSync("git", args, {
      cwd: this.cwd,
      encoding: "utf8",
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      input: opts.input,
      maxBuffer: 256 * 1024 * 1024,
    });
    if (res.error) throw new GitError(res.error.message);
    if (res.status !== 0 && !opts.allowFail) {
      throw new GitError(`git ${args.join(" ")} failed: ${res.stderr.trim()}`);
    }
    return res.stdout;
  }

  tryRun(args: string[]): string | null {
    try {
      return this.run(args);
    } catch {
      return null;
    }
  }

  isRepo(): boolean {
    return this.tryRun(["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
  }

  head(): string | null {
    return this.tryRun(["rev-parse", "--verify", "-q", "HEAD"])?.trim() || null;
  }

  shortHead(): string | null {
    return this.tryRun(["rev-parse", "--short", "--verify", "-q", "HEAD"])?.trim() || null;
  }

  branch(): string | null {
    const b = this.tryRun(["symbolic-ref", "--short", "-q", "HEAD"])?.trim();
    return b || null;
  }

  status(): GitStatus {
    const out = this.run(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
    const st: GitStatus = { branch: null, head: null, upstream: null, ahead: 0, behind: 0, entries: [] };
    const parts = out.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      if (!line) continue;
      if (line.startsWith("# branch.oid ")) {
        const oid = line.slice(13);
        st.head = oid === "(initial)" ? null : oid;
      } else if (line.startsWith("# branch.head ")) {
        const b = line.slice(14);
        st.branch = b === "(detached)" ? null : b;
      } else if (line.startsWith("# branch.upstream ")) {
        st.upstream = line.slice(18);
      } else if (line.startsWith("# branch.ab ")) {
        const m = /\+(\d+) -(\d+)/.exec(line);
        if (m) (st.ahead = Number(m[1])), (st.behind = Number(m[2]));
      } else if (line.startsWith("1 ")) {
        const f = line.split(" ");
        const xy = f[1] ?? "..";
        st.entries.push(entry(f.slice(8).join(" "), xy));
      } else if (line.startsWith("2 ")) {
        const f = line.split(" ");
        const xy = f[1] ?? "..";
        const from = parts[++i];
        st.entries.push({ ...entry(f.slice(9).join(" "), xy), from });
      } else if (line.startsWith("u ")) {
        const f = line.split(" ");
        st.entries.push({ ...entry(f.slice(10).join(" "), f[1] ?? "UU"), conflicted: true });
      } else if (line.startsWith("? ")) {
        st.entries.push({ path: line.slice(2), index: "?", worktree: "?", untracked: true, conflicted: false });
      }
    }
    return st;
  }

  /** Changes in the working tree + index relative to HEAD (or to `base` when given). */
  changes(base?: string | null): FileChange[] {
    const st = this.status();
    const byPath = new Map<string, FileChange>();
    for (const e of st.entries) {
      byPath.set(e.path, {
        path: e.path,
        kind: kindOf(e),
        ...(e.from ? { from: e.from } : {}),
        staged: !e.untracked && e.index !== ".",
        unstaged: e.untracked || e.worktree !== ".",
      });
    }
    if (base && st.head && base !== st.head && this.hasCommit(base)) {
      const out = this.run(["diff", "--name-status", "-z", "-M", base, "HEAD"]);
      const p = out.split("\0");
      for (let i = 0; i < p.length; i++) {
        const code = p[i];
        if (!code) continue;
        if (code.startsWith("R") || code.startsWith("C")) {
          const from = p[++i]!;
          const to = p[++i]!;
          if (!byPath.has(to)) byPath.set(to, { path: to, from, kind: "renamed", staged: false, unstaged: false });
        } else {
          const path = p[++i]!;
          if (byPath.has(path)) continue;
          const kind: ChangeKind = code === "A" ? "created" : code === "D" ? "deleted" : "modified";
          byPath.set(path, { path, kind, staged: false, unstaged: false });
        }
      }
    }
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  hasCommit(ref: string): boolean {
    return this.tryRun(["cat-file", "-e", `${ref}^{commit}`]) !== null;
  }

  /** Commits reachable from HEAD but not from `base`. */
  commitsSince(base: string, limit = 50): { sha: string; subject: string }[] {
    if (!this.hasCommit(base)) return [];
    const out = this.tryRun(["log", "--format=%h%x09%s", `-n${limit}`, `${base}..HEAD`]) ?? "";
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, ...rest] = l.split("\t");
        return { sha: sha ?? "", subject: rest.join("\t") };
      });
  }

  fileAt(ref: string, path: string): string | null {
    return this.tryRun(["show", `${ref}:${path}`]);
  }

  logForFile(path: string, limit = 10): { sha: string; date: string; subject: string }[] {
    const out = this.tryRun(["log", "--follow", "--format=%h%x09%as%x09%s", `-n${limit}`, "--", path]) ?? "";
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha = "", date = "", ...rest] = l.split("\t");
        return { sha, date, subject: rest.join("\t") };
      });
  }

  worktrees(): { path: string; head: string | null; branch: string | null }[] {
    const out = this.tryRun(["worktree", "list", "--porcelain"]) ?? "";
    const list: { path: string; head: string | null; branch: string | null }[] = [];
    let cur: { path: string; head: string | null; branch: string | null } | null = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        cur = { path: line.slice(9), head: null, branch: null };
        list.push(cur);
      } else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5);
      else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    }
    return list;
  }
}

function entry(path: string, xy: string): StatusEntry {
  return { path, index: xy[0] ?? ".", worktree: xy[1] ?? ".", untracked: false, conflicted: false };
}

function kindOf(e: StatusEntry): ChangeKind {
  if (e.untracked) return "created";
  const codes = e.index + e.worktree;
  if (codes.includes("R") || codes.includes("C")) return "renamed";
  if (codes.includes("A")) return "created";
  if (codes.includes("D")) return "deleted";
  return "modified";
}

export function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
