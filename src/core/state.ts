import type {
  AgentEvent,
  CommandPayload,
  DecisionPayload,
  NotePayload,
  TestFinishedPayload,
  TodoItem,
} from "./events.js";

/**
 * The task's *recorded* working state, folded from its events. This is what
 * the agent and user said/did; compaction later verifies it against the repo.
 */
export interface WorkingState {
  task_id: string;
  requests: { text: string; ts: string; session_id: string | null }[];
  todos: { items: TodoItem[]; ts: string; agent_id: string } | null;
  manual: { kind: "done" | "pending" | "blocked"; text: string; ts: string }[];
  decisions: (DecisionPayload & { ts: string; id: string })[];
  issues: { text: string; ts: string; files: string[]; resolved: boolean }[];
  failed_attempts: { text: string; ts: string }[];
  context_notes: { text: string; ts: string }[];
  next: { text: string; ts: string } | null;
  files: Map<string, { last: "created" | "modified" | "deleted"; count: number; ts: string }>;
  commands: { failing: (CommandPayload & { ts: string })[]; total: number };
  tests: (TestFinishedPayload & { ts: string })[];
  subagents: { id: string; description: string; ts: string; finished: boolean }[];
  checkpoints: { name: string; ts: string }[];
  compactions: number;
  first_ts: string | null;
  last_ts: string | null;
  event_count: number;
}

export function emptyState(taskId: string): WorkingState {
  return {
    task_id: taskId,
    requests: [],
    todos: null,
    manual: [],
    decisions: [],
    issues: [],
    failed_attempts: [],
    context_notes: [],
    next: null,
    files: new Map(),
    commands: { failing: [], total: 0 },
    tests: [],
    subagents: [],
    checkpoints: [],
    compactions: 0,
    first_ts: null,
    last_ts: null,
    event_count: 0,
  };
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

export function reduceState(taskId: string, events: AgentEvent[]): WorkingState {
  const st = emptyState(taskId);
  const lastCommand = new Map<string, CommandPayload & { ts: string }>();
  const lastTest = new Map<string, TestFinishedPayload & { ts: string }>();
  for (const e of events) {
    st.event_count++;
    st.first_ts ??= e.ts;
    st.last_ts = e.ts;
    const p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case "USER_REQUEST":
        if (typeof p.text === "string" && p.text.trim()) st.requests.push({ text: p.text, ts: e.ts, session_id: e.session_id });
        break;
      case "TODOS_UPDATED":
        if (Array.isArray(p.items)) st.todos = { items: p.items as TodoItem[], ts: e.ts, agent_id: e.agent_id };
        break;
      case "DECISION_RECORDED":
        st.decisions.push({ ...(p as unknown as DecisionPayload), ts: e.ts, id: e.id });
        break;
      case "NOTE_RECORDED": {
        const n = p as unknown as NotePayload;
        switch (n.kind) {
          case "issue":
            st.issues.push({ text: n.text, ts: e.ts, files: n.files ?? [], resolved: false });
            break;
          case "resolved": {
            const ref = norm(n.ref ?? n.text);
            for (const i of st.issues) if (!i.resolved && (norm(i.text).includes(ref) || ref.includes(norm(i.text)))) i.resolved = true;
            break;
          }
          case "failed_attempt":
            st.failed_attempts.push({ text: n.text, ts: e.ts });
            break;
          case "next":
            st.next = { text: n.text, ts: e.ts };
            break;
          case "context":
            st.context_notes.push({ text: n.text, ts: e.ts });
            break;
          case "done":
          case "pending":
          case "blocked": {
            // Marking an item done/pending/blocked supersedes earlier notes about the same item.
            const key = norm(n.text);
            st.manual = st.manual.filter((m) => norm(m.text) !== key);
            st.manual.push({ kind: n.kind, text: n.text, ts: e.ts });
            if (n.kind === "done" && st.next && norm(st.next.text) === key) st.next = null;
            break;
          }
        }
        break;
      }
      case "FILE_CREATED":
      case "FILE_MODIFIED":
      case "FILE_DELETED": {
        const path = p.path as string;
        if (!path) break;
        const kind = e.type === "FILE_CREATED" ? "created" : e.type === "FILE_DELETED" ? "deleted" : "modified";
        const prev = st.files.get(path);
        st.files.set(path, {
          last: prev?.last === "created" && kind === "modified" ? "created" : kind,
          count: (prev?.count ?? 0) + 1,
          ts: e.ts,
        });
        break;
      }
      case "COMMAND_EXECUTED": {
        st.commands.total++;
        const c = p as unknown as CommandPayload;
        lastCommand.set(norm(c.command), { ...c, ts: e.ts });
        break;
      }
      case "TEST_FINISHED": {
        const t = p as unknown as TestFinishedPayload;
        lastTest.set(norm(t.command), { ...t, ts: e.ts });
        lastCommand.set(norm(t.command), { ...t, ts: e.ts });
        break;
      }
      case "SUBAGENT_STARTED":
        st.subagents.push({ id: String(p.id ?? e.id), description: String(p.description ?? ""), ts: e.ts, finished: false });
        break;
      case "SUBAGENT_FINISHED": {
        const s = st.subagents.find((x) => x.id === p.id) ?? st.subagents.find((x) => !x.finished);
        if (s) s.finished = true;
        break;
      }
      case "CHECKPOINT_CREATED":
        st.checkpoints.push({ name: String(p.name), ts: e.ts });
        break;
      case "CONTEXT_COMPACTED":
        st.compactions++;
        break;
    }
  }
  // A command is "currently failing" if its most recent run failed.
  st.commands.failing = [...lastCommand.values()].filter((c) => c.ok === false).sort((a, b) => a.ts.localeCompare(b.ts));
  st.tests = [...lastTest.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  return st;
}
