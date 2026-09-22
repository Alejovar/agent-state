import { Project } from "../core/project.js";
import { EVENT_TYPES, type AgentEvent, type DecisionPayload } from "../core/events.js";
import { TaskService } from "../core/tasks.js";
import { toProjectPath } from "../core/paths.js";
import { c, ago } from "../ui/term.js";
import { type Command, parse, out, json, UsageError } from "./types.js";
import { resolveTask } from "./context.js";

/** One-line human description of an event. */
export function describe(e: AgentEvent): string {
  const p = e.payload as Record<string, unknown>;
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  const clip = (x: string, n = 100) => (x.length > n ? x.slice(0, n - 1) + "…" : x).replace(/\s+/g, " ");
  switch (e.type) {
    case "USER_REQUEST":
      return `request: ${clip(s("text"), 120)}`;
    case "FILE_CREATED":
      return `created ${s("path")}`;
    case "FILE_MODIFIED":
      return `modified ${s("path")}`;
    case "FILE_DELETED":
      return `deleted ${s("path")}`;
    case "COMMAND_EXECUTED":
      return `$ ${clip(s("command"))}${p.ok === false ? c.red(" ✗") : p.ok === true ? "" : c.dim(" ?")}`;
    case "TEST_FINISHED":
      return `test ${clip(s("command"), 60)} ${p.ok === true ? c.green("passed") : p.ok === false ? c.red("FAILED") : c.yellow("unknown")}${p.passed != null || p.failed != null ? c.dim(` (${p.passed ?? "?"}✓ ${p.failed ?? "?"}✗)`) : ""}`;
    case "DECISION_RECORDED": {
      const d = p as unknown as DecisionPayload;
      return `decision #${d.number}: ${clip(d.decision)}`;
    }
    case "NOTE_RECORDED":
      return `${String(p.kind).replace("_", " ")}: ${clip(s("text"))}`;
    case "TODOS_UPDATED": {
      const items = (p.items as { status: string }[]) ?? [];
      return `todo list: ${items.filter((i) => i.status === "completed").length}/${items.length} done`;
    }
    case "TASK_CREATED":
      return `task #${p.number} created: ${clip(s("goal"))}`;
    case "TASK_UPDATED":
      return `task ${p.status ? `→ ${p.status}` : ""}${p.goal ? ` renamed: ${clip(s("goal"))}` : ""}${p.reason ? c.dim(` (${s("reason")})`) : ""}`;
    case "SESSION_STARTED":
      return `session started${p.source ? ` (${s("source")})` : ""}`;
    case "SESSION_ENDED":
      return `session ended${p.reason ? ` (${s("reason")})` : ""}`;
    case "CHECKPOINT_CREATED":
      return `checkpoint ${s("name")}`;
    case "CHECKPOINT_RESTORED":
      return `restored checkpoint ${s("name")}`;
    case "RECOVERY_GENERATED":
      return `recovery state ${p.injected ? "injected into agent" : "generated"}${p.bytes ? c.dim(` (${p.bytes} B)`) : ""}`;
    case "CONTEXT_PRESSURE":
      return `context ~${Math.round(Number(p.ratio) * 100)}% (estimated)`;
    case "CONTEXT_COMPACTED":
      return `agent compacted its context (${s("trigger")})`;
    case "SCOPE_VIOLATION":
      return c.yellow(`scope ${s("verdict")}: ${s("path")} (${s("policy")})`);
    case "SUBAGENT_STARTED":
      return `subagent started${p.agent_type ? `: ${s("agent_type")}` : ""}`;
    case "SUBAGENT_FINISHED":
      return `subagent finished${p.agent_type ? `: ${s("agent_type")}` : ""}`;
    case "TOOL_STARTED":
    case "TOOL_FINISHED":
      return `${s("tool") || "tool"}${p.summary ? `: ${clip(s("summary"))}` : ""}`;
    default:
      return e.type;
  }
}

const TYPE_ALIASES: Record<string, AgentEvent["type"][]> = {
  request: ["USER_REQUEST"],
  file: ["FILE_CREATED", "FILE_MODIFIED", "FILE_DELETED"],
  command: ["COMMAND_EXECUTED"],
  test: ["TEST_FINISHED"],
  decision: ["DECISION_RECORDED"],
  note: ["NOTE_RECORDED"],
  task: ["TASK_CREATED", "TASK_UPDATED"],
  session: ["SESSION_STARTED", "SESSION_ENDED"],
  checkpoint: ["CHECKPOINT_CREATED", "CHECKPOINT_RESTORED"],
  scope: ["SCOPE_VIOLATION"],
};

function parseDate(s: string, end = false): string {
  const rel = /^(\d+)([hdwm])$/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const ms = { h: 3600e3, d: 86400e3, w: 604800e3, m: 2592000e3 }[rel[2] as "h" | "d" | "w" | "m"];
    return new Date(Date.now() - n * ms).toISOString();
  }
  if (s === "today") return new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const d = new Date(s.length === 10 && end ? `${s}T23:59:59.999` : s);
  if (Number.isNaN(d.getTime())) throw new UsageError(`Invalid date "${s}". Use YYYY-MM-DD, "today", or 3h/2d/1w.`);
  return d.toISOString();
}

export const history: Command = {
  name: "history",
  aliases: ["log"],
  group: "Intelligence",
  summary: "Search agent activity by keyword, file, task, session, date, type",
  usage: `agent-state history [keyword...] [--file <path>] [--task <id>] [--session <id>]
                     [--type request|file|command|test|decision|note|task|session|checkpoint|scope]
                     [--since <date|3h|2d|1w>] [--until <date>] [--limit N] [--all] [--json]`,
  run(argv) {
    const { values, positionals } = parse(argv, {
      file: { type: "string" },
      task: { type: "string" },
      session: { type: "string" },
      type: { type: "string", multiple: true },
      since: { type: "string" },
      until: { type: "string" },
      limit: { type: "string" },
      all: { type: "boolean" },
      json: { type: "boolean" },
    });
    const project = Project.open();
    const types = (values.type ?? []).flatMap((t) => {
      const alias = TYPE_ALIASES[t.toLowerCase()];
      if (alias) return alias;
      const upper = t.toUpperCase() as AgentEvent["type"];
      if (!EVENT_TYPES.includes(upper)) throw new UsageError(`Unknown type "${t}". Use ${Object.keys(TYPE_ALIASES).join(", ")} or an event type.`);
      return [upper];
    });
    const taskId = values.task ? resolveTask(project, values.task)!.id : undefined;
    let sessionId = values.session;
    const svc = new TaskService(project);
    const { sessions } = svc.load();
    if (sessionId && !sessions.has(sessionId)) {
      // Accept labels like "#184-A" or native ids.
      const byLabel = [...sessions.values()].find((s) => s.label === sessionId || s.label === `#${sessionId}` || s.native_session_id === sessionId || s.id.endsWith(sessionId!));
      if (byLabel) sessionId = byLabel.id;
    }
    const file = values.file ? toProjectPath(project.root, values.file, process.cwd()) ?? values.file : undefined;
    const limit = values.all ? undefined : Number(values.limit ?? 50);
    const events = project
      .db()
      .query({
        ...(taskId ? { task_id: taskId } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(types.length ? { types } : {}),
        ...(file ? { path: file } : {}),
        ...(positionals.length ? { text: positionals.join(" ") } : {}),
        ...(values.since ? { since: parseDate(values.since) } : {}),
        ...(values.until ? { until: parseDate(values.until, true) } : {}),
        order: "desc",
        ...(limit ? { limit } : {}),
      })
      .reverse();
    if (values.json) return json(events), 0;
    if (!events.length) return out(c.dim("No matching events.")), 0;
    const labels = new Map([...sessions.values()].map((s) => [s.id, s.label]));
    let lastDay = "";
    for (const e of events) {
      const day = e.ts.slice(0, 10);
      if (day !== lastDay) {
        out(c.bold(day));
        lastDay = day;
      }
      const who = e.session_id ? labels.get(e.session_id) ?? e.session_id.slice(0, 10) : e.agent_id;
      const task = e.task_id ? `#${e.task_id.replace("task_", "")}` : "";
      out(`  ${c.dim(e.ts.slice(11, 19))} ${c.dim(String(who).padEnd(7))} ${c.dim(task.padEnd(5))} ${describe(e)}`);
    }
    if (limit && events.length === limit) out(c.dim(`(showing last ${limit}; use --limit or --all)`));
    return 0;
  },
};

export const decisions: Command = {
  name: "decisions",
  group: "Intelligence",
  summary: "List recorded architectural decisions",
  usage: "agent-state decisions [keyword...] [--task <id>] [--json]",
  run(argv) {
    const { values, positionals } = parse(argv, { task: { type: "string" }, json: { type: "boolean" } });
    const project = Project.open();
    const taskId = values.task ? resolveTask(project, values.task)!.id : undefined;
    const events = project.db().query({ types: ["DECISION_RECORDED"], ...(taskId ? { task_id: taskId } : {}), ...(positionals.length ? { text: positionals.join(" ") } : {}) });
    const list = events.map((e) => ({ ...(e.payload as unknown as DecisionPayload), task_id: e.task_id, ts: e.ts }));
    if (values.json) return json(list), 0;
    if (!list.length) return out(c.dim('No decisions recorded. Record one: agent-state decide "<decision>" --reason "<why>"')), 0;
    for (const d of list) {
      out(c.bold(`Decision #${d.number}`) + c.dim(`  ${d.ts.slice(0, 10)}${d.task_id ? ` · task #${d.task_id.replace("task_", "")}` : ""}`));
      out(`  ${d.decision}`);
      if (d.reason) out(`  ${c.dim("Reason:")} ${d.reason}`);
      if (d.alternatives?.length) out(`  ${c.dim("Rejected:")} ${d.alternatives.join(", ")}`);
      if (d.files?.length) out(`  ${c.dim("Files:")} ${d.files.join(", ")}`);
      out("");
    }
    return 0;
  },
};

export const why: Command = {
  name: "why",
  group: "Intelligence",
  summary: "Why did this file change? Decisions, tasks, requests and commits that touched it",
  usage: "agent-state why <file> [--json]",
  run(argv) {
    const { values, positionals } = parse(argv, { json: { type: "boolean" } });
    if (!positionals[0]) throw new UsageError(why.usage);
    const project = Project.open();
    const path = toProjectPath(project.root, positionals[0], process.cwd());
    if (!path) throw new UsageError(`${positionals[0]} is outside the project.`);
    const db = project.db();
    const fileEvents = db.query({ types: ["FILE_CREATED", "FILE_MODIFIED", "FILE_DELETED"], path });
    const taskIds = [...new Set(fileEvents.map((e) => e.task_id).filter((x): x is string => !!x))];
    const svc = new TaskService(project);
    const tasks = taskIds.map((id) => svc.get(id)).filter((t) => !!t);
    const allDecisions = db.query({ types: ["DECISION_RECORDED"] });
    const stem = path.split("/").pop()!.replace(/\.[^.]+$/, "").toLowerCase();
    const related = allDecisions
      .map((e) => {
        const d = e.payload as unknown as DecisionPayload;
        let why = "";
        if (d.files?.includes(path)) why = "names this file";
        else if (e.task_id && taskIds.includes(e.task_id)) why = "same task";
        else if (stem.length > 3 && `${d.decision} ${d.reason ?? ""}`.toLowerCase().includes(stem)) why = `mentions "${stem}"`;
        return why ? { ...d, task_id: e.task_id, why } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    const requests = taskIds.flatMap((id) => db.query({ task_id: id, types: ["USER_REQUEST"] }).slice(0, 3).map((e) => ({ task_id: id, text: String(e.payload.text) })));
    const notes = db.query({ types: ["NOTE_RECORDED"], path });
    const commits = project.git.isRepo() ? project.git.logForFile(path, 8) : [];
    const result = { path, tasks: tasks.map((t) => ({ number: t.number, goal: t.goal, status: t.status })), decisions: related, requests, notes: notes.map((n) => n.payload), commits, edits: fileEvents.length };
    if (values.json) return json(result), 0;

    out(c.bold(path));
    if (!tasks.length && !related.length && !commits.length) {
      out(c.dim("No recorded tasks, decisions or commits reference this file."));
      return 0;
    }
    if (related.length) {
      out("");
      out("Decisions:");
      for (const d of related) {
        out(`  #${d.number} ${d.decision} ${c.dim(`(${d.why})`)}`);
        if (d.reason) out(`     ${c.dim("because")} ${d.reason}`);
      }
    }
    if (tasks.length) {
      out("");
      out("Changed by tasks:");
      for (const t of tasks) out(`  #${t.number} ${t.goal} ${c.dim(`[${t.status}]`)}`);
    }
    if (requests.length) {
      out("");
      out("Originating requests:");
      for (const r of requests) out(`  #${r.task_id.replace("task_", "")} ${c.dim(">")} ${r.text.slice(0, 140).replace(/\s+/g, " ")}`);
    }
    if (notes.length) {
      out("");
      out("Notes:");
      for (const n of notes) out(`  ${String(n.payload.kind)}: ${String(n.payload.text)}`);
    }
    if (commits.length) {
      out("");
      out("Commits:");
      for (const cm of commits) out(`  ${c.dim(cm.sha)} ${cm.date} ${cm.subject}`);
    }
    out("");
    out(c.dim(`${fileEvents.length} recorded agent edit(s); last ${fileEvents.length ? ago(fileEvents.at(-1)!.ts) : "—"}`));
    return 0;
  },
};
