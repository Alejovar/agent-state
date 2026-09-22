import type { AgentEvent, SessionStartedPayload, TaskCreatedPayload, TaskStatus, TaskUpdatedPayload } from "./events.js";
import { sessionLetter } from "./ids.js";
import { withLock } from "./lock.js";
import { hashFile } from "./hash.js";
import { join } from "node:path";
import type { Project } from "./project.js";

export interface Session {
  id: string;
  agent_id: string;
  task_id: string | null;
  native_session_id?: string;
  source?: string;
  label: string;
  started_at: string;
  ended_at: string | null;
  last_event_at: string;
  parent_task_id?: string | null;
}

export interface Task {
  id: string;
  number: number;
  goal: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  base_head: string | null;
  base_branch: string | null;
  parent_task_id: string | null;
  base_dirty: Record<string, string | null>;
  sessions: Session[];
}

export function taskIdFor(n: number): string {
  return `task_${n}`;
}

/** Accepts "184", "#184", "task_184". */
export function parseTaskRef(ref: string): string | null {
  const m = /^(?:#|task_)?(\d+)$/.exec(ref.trim());
  return m ? taskIdFor(Number(m[1])) : null;
}

/** Folds task/session lifecycle events into the current task list. Pure. */
export function reduceTasks(events: AgentEvent[]): { tasks: Map<string, Task>; sessions: Map<string, Session> } {
  const tasks = new Map<string, Task>();
  const sessions = new Map<string, Session>();
  for (const e of events) {
    switch (e.type) {
      case "TASK_CREATED": {
        const p = e.payload as unknown as TaskCreatedPayload;
        if (!e.task_id || tasks.has(e.task_id)) break;
        tasks.set(e.task_id, {
          id: e.task_id,
          number: p.number,
          goal: p.goal,
          status: "NEW",
          created_at: e.ts,
          updated_at: e.ts,
          base_head: p.base_head,
          base_branch: p.base_branch,
          parent_task_id: p.parent_task_id ?? null,
          base_dirty: p.base_dirty ?? {},
          sessions: [],
        });
        break;
      }
      case "TASK_UPDATED": {
        const t = e.task_id ? tasks.get(e.task_id) : undefined;
        if (!t) break;
        const p = e.payload as TaskUpdatedPayload;
        if (p.status) t.status = p.status;
        if (p.goal) t.goal = p.goal;
        t.updated_at = e.ts;
        break;
      }
      case "SESSION_STARTED": {
        if (!e.session_id) break;
        const p = e.payload as SessionStartedPayload;
        let s = sessions.get(e.session_id);
        if (!s) {
          s = {
            id: e.session_id,
            agent_id: e.agent_id,
            task_id: e.task_id,
            native_session_id: p.native_session_id,
            source: p.source,
            label: e.session_id,
            started_at: e.ts,
            ended_at: null,
            last_event_at: e.ts,
            parent_task_id: e.parent_task_id ?? null,
          };
          sessions.set(e.session_id, s);
        } else {
          // Resumed session: reopen it and possibly attach it to a task.
          s.ended_at = null;
          s.last_event_at = e.ts;
          if (!s.task_id && e.task_id) s.task_id = e.task_id;
        }
        break;
      }
      case "SESSION_ENDED": {
        const s = e.session_id ? sessions.get(e.session_id) : undefined;
        if (s) (s.ended_at = e.ts), (s.last_event_at = e.ts);
        break;
      }
      default: {
        const s = e.session_id ? sessions.get(e.session_id) : undefined;
        if (s) {
          s.last_event_at = e.ts;
          // A session may start before its task exists; it joins the first task it reports.
          if (!s.task_id && e.task_id) s.task_id = e.task_id;
        }
        const t = e.task_id ? tasks.get(e.task_id) : undefined;
        if (t && e.ts > t.updated_at) t.updated_at = e.ts;
      }
    }
  }
  for (const s of sessions.values()) {
    const t = s.task_id ? tasks.get(s.task_id) : undefined;
    if (t) t.sessions.push(s);
  }
  for (const t of tasks.values()) {
    t.sessions.sort((a, b) => a.started_at.localeCompare(b.started_at));
    t.sessions.forEach((s, i) => (s.label = `#${t.number}-${sessionLetter(i)}`));
  }
  return { tasks, sessions };
}

const LIFECYCLE_TYPES = [
  "TASK_CREATED",
  "TASK_UPDATED",
  "SESSION_STARTED",
  "SESSION_ENDED",
  "USER_REQUEST",
] as const;

export class TaskService {
  constructor(private readonly project: Project) {}

  load(): { tasks: Map<string, Task>; sessions: Map<string, Session> } {
    const events = this.project.db().query({ types: [...LIFECYCLE_TYPES] });
    return reduceTasks(events);
  }

  list(): Task[] {
    return [...this.load().tasks.values()].sort((a, b) => b.number - a.number);
  }

  get(taskId: string): Task | null {
    return this.load().tasks.get(taskId) ?? null;
  }

  /** The task agent activity should be attributed to right now. */
  currentTask(): Task | null {
    const cur = this.project.current();
    const { tasks } = this.load();
    if (cur.task_id) {
      const t = tasks.get(cur.task_id);
      if (t && t.status !== "COMPLETED" && t.status !== "ABANDONED") return t;
    }
    return null;
  }

  /** Latest task that is not completed/abandoned — what `continue` resumes. */
  latestUnfinished(): Task | null {
    const open = this.list().filter((t) => t.status !== "COMPLETED" && t.status !== "ABANDONED");
    open.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return open[0] ?? null;
  }

  create(goal: string, opts: { agent_id?: string; session_id?: string | null; parent_task_id?: string | null } = {}): Task {
    return withLock(this.project.lockPath("tasks"), () => {
      const existing = this.list();
      const number = existing.reduce((m, t) => Math.max(m, t.number), 0) + 1;
      const id = taskIdFor(number);
      const git = this.project.git;
      const isRepo = git.isRepo();
      // Pre-existing uncommitted work is not the task's doing; remember it so it
      // is not reported as a task change unless the task touches it again.
      const base_dirty: Record<string, string | null> = {};
      if (isRepo) {
        for (const c of git.changes().slice(0, 500)) {
          if (c.path.startsWith(".agent-state/")) continue;
          base_dirty[c.path] = hashFile(join(this.project.root, c.path));
        }
      }
      this.project.emit({
        type: "TASK_CREATED",
        agent_id: opts.agent_id,
        session_id: opts.session_id ?? null,
        task_id: id,
        parent_task_id: opts.parent_task_id ?? null,
        payload: {
          number,
          goal: goal.trim(),
          base_head: isRepo ? git.head() : null,
          base_branch: isRepo ? git.branch() : null,
          parent_task_id: opts.parent_task_id ?? null,
          base_dirty,
        } satisfies TaskCreatedPayload as unknown as Record<string, unknown>,
      });
      this.setStatus(id, "ACTIVE", { agent_id: opts.agent_id, session_id: opts.session_id });
      this.project.setCurrent({ task_id: id });
      return this.get(id)!;
    });
  }

  setStatus(taskId: string, status: TaskStatus, opts: { agent_id?: string; session_id?: string | null; reason?: string } = {}): void {
    this.project.emit({
      type: "TASK_UPDATED",
      agent_id: opts.agent_id,
      session_id: opts.session_id ?? null,
      task_id: taskId,
      payload: { status, ...(opts.reason ? { reason: opts.reason } : {}) },
    });
  }

  rename(taskId: string, goal: string): void {
    this.project.emit({ type: "TASK_UPDATED", task_id: taskId, payload: { goal } });
  }

  switchTo(taskId: string): void {
    const t = this.get(taskId);
    if (!t) throw new Error(`Unknown task ${taskId}`);
    const cur = this.currentTask();
    if (cur && cur.id !== taskId && cur.status === "ACTIVE") this.setStatus(cur.id, "PAUSED", { reason: `switched to #${t.number}` });
    if (t.status !== "ACTIVE") this.setStatus(taskId, "ACTIVE");
    this.project.setCurrent({ task_id: taskId });
  }
}
