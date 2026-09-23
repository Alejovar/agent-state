import type { Project } from "./project.js";

/** How long a usage-limit stop is considered current (Claude's windows reset within hours). */
export const LIMIT_WINDOW_MS = 5 * 60 * 60 * 1000;

export interface LimitInfo {
  agent_id: string;
  ts: string;
  error_type: string;
  message: string;
  task_id: string | null;
}

/**
 * The most recent usage-limit stop per agent, if it is still within the reset
 * window and the agent has not produced activity since (which would mean the
 * limit already reset).
 */
export function activeLimits(project: Project, now = Date.now()): LimitInfo[] {
  const db = project.db();
  const since = new Date(now - LIMIT_WINDOW_MS).toISOString();
  const hits = db.query({ types: ["AGENT_LIMIT_REACHED"], since });
  const latest = new Map<string, LimitInfo>();
  for (const e of hits) {
    const agent = e.agent_id.split(":")[0]!;
    latest.set(agent, { agent_id: agent, ts: e.ts, error_type: String(e.payload.error_type ?? ""), message: String(e.payload.message ?? ""), task_id: e.task_id });
  }
  const out: LimitInfo[] = [];
  for (const info of latest.values()) {
    const after = db.query({ since: info.ts, types: ["USER_REQUEST", "FILE_MODIFIED", "FILE_CREATED", "COMMAND_EXECUTED", "TEST_FINISHED"] });
    const resumed = after.some((e) => e.ts > info.ts && e.agent_id.split(":")[0] === info.agent_id);
    if (!resumed) out.push(info);
  }
  return out;
}
