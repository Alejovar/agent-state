import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { Project } from "./project.js";
import type { Task } from "./tasks.js";
import { matchesAny } from "./glob.js";
import { hashFile } from "./hash.js";
import type { ScopePolicy } from "./config.js";

/** Machine-readable task contract (intent ledger entry). */
export interface TaskContract {
  task: { id: number; goal: string };
  scope: { allowed: string[]; restricted: string[] };
  expected: string[];
  policy?: ScopePolicy;
}

export type ScopeVerdict =
  | { status: "ok"; rule: string | null }
  | { status: "restricted"; rule: string }
  | { status: "outside"; rule: null }
  | { status: "no-contract" };

export function contractPath(project: Project, taskNumber: number): string {
  return join(project.paths.tasks, `task-${taskNumber}.yaml`);
}

export function loadContract(project: Project, taskNumber: number): TaskContract | null {
  const p = contractPath(project, taskNumber);
  if (!existsSync(p)) return null;
  const raw = YAML.parse(readFileSync(p, "utf8")) as Partial<TaskContract> | null;
  if (!raw) return null;
  return {
    task: { id: Number(raw.task?.id ?? taskNumber), goal: String(raw.task?.goal ?? "") },
    scope: {
      allowed: (raw.scope?.allowed ?? []).map(String),
      restricted: (raw.scope?.restricted ?? []).map(String),
    },
    expected: (raw.expected ?? []).map(String),
    ...(raw.policy ? { policy: raw.policy } : {}),
  };
}

export function saveContract(project: Project, contract: TaskContract): string {
  const p = contractPath(project, contract.task.id);
  writeFileSync(p, `# Task contract (intent ledger). Edit freely; agent-state checks changes against it.\n${YAML.stringify(contract)}`);
  return p;
}

/** Paths that are always fine to touch regardless of scope. */
const ALWAYS_ALLOWED = [".agent-state/**"];

export function checkPath(contract: TaskContract | null, path: string): ScopeVerdict {
  if (!contract) return { status: "no-contract" };
  if (matchesAny(path, ALWAYS_ALLOWED)) return { status: "ok", rule: null };
  const restricted = matchesAny(path, contract.scope.restricted);
  if (restricted) return { status: "restricted", rule: restricted };
  if (!contract.scope.allowed.length) return { status: "ok", rule: null };
  const allowed = matchesAny(path, contract.scope.allowed);
  return allowed ? { status: "ok", rule: allowed } : { status: "outside", rule: null };
}

export function effectivePolicy(project: Project, contract: TaskContract | null): ScopePolicy {
  return contract?.policy ?? project.config.scope.policy;
}

/** Changed files (per git + events) that fall outside the task contract. */
export function unexpectedFiles(project: Project, task: Task): string[] {
  const contract = loadContract(project, task.number);
  if (!contract) return [];
  const out: string[] = [];
  const git = project.git;
  const paths = new Set<string>();
  if (git.isRepo()) {
    for (const c of git.changes(task.base_head)) {
      if (c.path in task.base_dirty && hashFile(join(project.root, c.path)) === task.base_dirty[c.path]) continue;
      paths.add(c.path);
    }
  }
  for (const e of project.db().query({ task_id: task.id, types: ["FILE_CREATED", "FILE_MODIFIED", "FILE_DELETED"] })) {
    if (typeof e.payload.path === "string" && !git.isRepo()) paths.add(e.payload.path);
  }
  for (const p of paths) {
    const v = checkPath(contract, p);
    if (v.status === "restricted" || v.status === "outside") out.push(p);
  }
  return out.sort();
}
