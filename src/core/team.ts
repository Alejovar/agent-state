import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "./project.js";
import { TaskService } from "./tasks.js";
import { recoverTask } from "./compact.js";
import { renderMarkdown } from "./render.js";
import type { RecoveryState } from "./recovery.js";

/**
 * Opt-in team sharing of recovery states, through the project's own git
 * remote. Nothing is automatic: `share` shows exactly what will be sent and
 * pushes one private ref per person (refs/agent-state/shared/<name>). Only
 * recovery states and decisions are shared: never the raw event log and never
 * verbatim prompts.
 */

const SHARED_PREFIX = "refs/agent-state/shared/";
const REMOTE_PREFIX = "refs/agent-state/team/";
const IDENTITY = { GIT_AUTHOR_NAME: "agent-state", GIT_AUTHOR_EMAIL: "agent-state@localhost", GIT_COMMITTER_NAME: "agent-state", GIT_COMMITTER_EMAIL: "agent-state@localhost" };

export interface SharedFile {
  path: string;
  bytes: number;
}

export interface SharePlan {
  member: string;
  ref: string;
  files: SharedFile[];
  tasks: { number: number; goal: string; status: string }[];
  dir: string;
}

export interface TeamTask {
  member: string;
  number: number;
  goal: string;
  status: string;
  shared_at: string;
}

/** Stable, ref-safe name for the current person (config `sync.name`, else git user). */
export function memberName(project: Project): string {
  const configured = project.config.sync.name;
  const fromGit = (project.git.tryRun(["config", "user.email"]) ?? "").trim().split("@")[0] || (project.git.tryRun(["config", "user.name"]) ?? "").trim();
  const raw = configured || fromGit || "me";
  return raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 40) || "me";
}

/** What a teammate is allowed to see: the recovery state minus verbatim prompts and free-form notes. */
function shareable(state: RecoveryState): RecoveryState {
  return { ...state, recent_requests: [], context: [], snapshot: {} };
}

/** Builds (but does not send) the files to share, in a temporary directory. */
export function planShare(project: Project, taskRefs: string[] | "all-unfinished"): SharePlan {
  const svc = new TaskService(project);
  const tasks =
    taskRefs === "all-unfinished"
      ? svc.list().filter((t) => t.status !== "COMPLETED" && t.status !== "ABANDONED")
      : taskRefs.map((ref) => {
          const t = svc.get(`task_${ref.replace(/^#|^task_/, "")}`);
          if (!t) throw new Error(`Task ${ref} does not exist.`);
          return t;
        });
  const dir = mkdtempSync(join(tmpdir(), "agent-state-share-"));
  const files: SharedFile[] = [];
  const write = (rel: string, content: string) => {
    const safe = project.redactor.redact(content); // belt and braces: events were already redacted
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), safe);
    files.push({ path: rel, bytes: Buffer.byteLength(safe) });
  };
  for (const t of tasks) {
    const state = shareable(recoverTask(project, t).state);
    const { markdown } = renderMarkdown(state, { maxBytes: project.config.recovery.max_bytes });
    write(`tasks/task-${t.number}.md`, markdown);
    write(`tasks/task-${t.number}.json`, JSON.stringify(state, null, 2) + "\n");
  }
  if (existsSync(project.paths.decisions)) {
    for (const f of readdirSync(project.paths.decisions).filter((x) => x.endsWith(".md"))) {
      write(`decisions/${f}`, readFileSync(join(project.paths.decisions, f), "utf8"));
    }
  }
  const member = memberName(project);
  const manifest = { member, shared_at: new Date().toISOString(), tasks: tasks.map((t) => ({ number: t.number, goal: t.goal, status: t.status })) };
  write("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  return { member, ref: `${SHARED_PREFIX}${member}`, files, tasks: manifest.tasks, dir };
}

/** Commits the planned files to the member's shared ref and pushes it. */
export function pushShare(project: Project, plan: SharePlan, remote: string): string {
  const git = project.git;
  const idx = join(mkdtempSync(join(tmpdir(), "agent-state-share-idx-")), "index");
  try {
    const env = { GIT_INDEX_FILE: idx, GIT_WORK_TREE: plan.dir };
    git.run(["add", "-A", "."], { env: { ...env } });
    const tree = git.run(["write-tree"], { env }).trim();
    const parent = git.tryRun(["rev-parse", "--verify", "-q", plan.ref])?.trim();
    const commit = git.run(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `agent-state share: ${plan.member}`], { env: IDENTITY }).trim();
    git.run(["update-ref", plan.ref, commit]);
    git.run(["push", "--quiet", remote, `+${plan.ref}:${plan.ref}`]);
    return commit;
  } finally {
    rmSync(join(idx, ".."), { recursive: true, force: true });
    rmSync(plan.dir, { recursive: true, force: true });
  }
}

/** Fetches everyone's shared refs into refs/agent-state/team/*. */
export function fetchTeam(project: Project, remote: string): void {
  project.git.run(["fetch", "--quiet", remote, `+${SHARED_PREFIX}*:${REMOTE_PREFIX}*`]);
}

export function teamTasks(project: Project): TeamTask[] {
  const refs = (project.git.tryRun(["for-each-ref", "--format=%(refname)", REMOTE_PREFIX]) ?? "").split("\n").filter(Boolean);
  const out: TeamTask[] = [];
  for (const ref of refs) {
    const raw = project.git.tryRun(["show", `${ref}:manifest.json`]);
    if (!raw) continue;
    try {
      const m = JSON.parse(raw) as { member: string; shared_at: string; tasks: { number: number; goal: string; status: string }[] };
      for (const t of m.tasks) out.push({ member: m.member, shared_at: m.shared_at, ...t });
    } catch {
      // malformed share from someone else: skip it
    }
  }
  return out.sort((a, b) => b.shared_at.localeCompare(a.shared_at));
}

/** A teammate's shared recovery context (read-only). */
export function teammateRecovery(project: Project, member: string, taskNumber: number): string | null {
  return project.git.tryRun(["show", `${REMOTE_PREFIX}${member}:tasks/task-${taskNumber}.md`]);
}
