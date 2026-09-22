import { existsSync } from "node:fs";
import { join } from "node:path";
import { Project } from "../core/project.js";
import { TaskService, type Session } from "../core/tasks.js";
import { readJson } from "../core/store.js";
import type { AgentEvent } from "../core/events.js";
import { c, ago } from "../ui/term.js";
import { type Command, parse, out, json, UsageError } from "./types.js";
import { describe } from "./history.js";
import { STATE_DIR } from "../core/paths.js";
import type { CurrentPointer } from "../core/project.js";

function findSession(sessions: Map<string, Session>, ref: string): Session | null {
  if (sessions.has(ref)) return sessions.get(ref)!;
  const r = ref.replace(/^#/, "");
  return (
    [...sessions.values()].find((s) => s.label === `#${r}` || s.native_session_id === ref || s.id.endsWith(ref) || s.id.startsWith(ref)) ?? null
  );
}

export const replay: Command = {
  name: "replay",
  group: "Intelligence",
  summary: "Reconstruct what happened in a session: requests → actions → files → tests → decisions → result",
  usage: `agent-state replay <session> [--verbose] [--json]
  <session> accepts a label (#184-A), an agent-state id, or the agent's native session id.
  Replay is observational: it never executes commands.`,
  run(argv) {
    const { values, positionals } = parse(argv, { verbose: { type: "boolean", short: "v" }, json: { type: "boolean" } });
    const project = Project.open();
    const { sessions } = new TaskService(project).load();
    const ref = positionals[0] ?? project.current().session_id;
    if (!ref) throw new UsageError(replay.usage);
    const s = findSession(sessions, ref);
    if (!s) throw new UsageError(`Unknown session "${ref}". See \`agent-state sessions\`.`);
    const events = project.db().query({ session_id: s.id });
    if (values.json) return json({ session: s, events }), 0;

    out(c.bold(`SESSION ${s.label}`) + c.dim(`  ${s.agent_id} · ${s.started_at.slice(0, 16).replace("T", " ")} → ${s.ended_at ? s.ended_at.slice(0, 16).replace("T", " ") : "open"}${s.task_id ? ` · task #${s.task_id.replace("task_", "")}` : ""}`));
    // Group into turns: each user request starts a new turn.
    const turns: { request: AgentEvent | null; events: AgentEvent[] }[] = [{ request: null, events: [] }];
    for (const e of events) {
      if (e.type === "USER_REQUEST") turns.push({ request: e, events: [] });
      else turns.at(-1)!.events.push(e);
    }
    const files = new Map<string, string>();
    let tests = 0;
    let testsFailed = 0;
    let commands = 0;
    let decisions = 0;
    for (const t of turns) {
      if (!t.request && !t.events.length) continue;
      out("");
      if (t.request) out(`${c.cyan("▸ User request")} ${c.dim(t.request.ts.slice(11, 19))}\n  ${String(t.request.payload.text).replace(/\s+/g, " ").slice(0, 300)}`);
      else out(c.cyan("▸ Session start"));
      const shown = values.verbose ? t.events : t.events.filter((e) => !["TOOL_STARTED"].includes(e.type));
      for (const e of shown) {
        if (e.type === "FILE_CREATED" || e.type === "FILE_MODIFIED" || e.type === "FILE_DELETED") files.set(String(e.payload.path), e.type.slice(5).toLowerCase());
        if (e.type === "TEST_FINISHED") (tests++, e.payload.ok === false && testsFailed++);
        if (e.type === "COMMAND_EXECUTED") commands++;
        if (e.type === "DECISION_RECORDED") decisions++;
        out(`  ${c.dim(e.ts.slice(11, 19))} ${describe(e)}`);
      }
    }
    out("");
    out(c.bold("Result"));
    out(`  Files changed: ${files.size}${files.size ? c.dim(` (${[...files.keys()].slice(0, 6).join(", ")}${files.size > 6 ? ", …" : ""})`) : ""}`);
    out(`  Commands: ${commands} · Tests: ${tests}${testsFailed ? c.red(` (${testsFailed} failed)`) : ""} · Decisions: ${decisions}`);
    const last = events.at(-1);
    out(`  ${s.ended_at ? `Ended ${ago(s.ended_at)}` : `Still open; last activity ${ago(last?.ts)}`}`);
    return 0;
  },
};

export const sessionsCmd: Command = {
  name: "sessions",
  group: "Intelligence",
  summary: "List agent sessions (all agents, subagents, tasks)",
  usage: "agent-state sessions [--task <id>] [--agent <id>] [--json]",
  run(argv) {
    const { values } = parse(argv, { task: { type: "string" }, agent: { type: "string" }, json: { type: "boolean" } }, false);
    const project = Project.open();
    const svc = new TaskService(project);
    let list = [...svc.load().sessions.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
    if (values.task) list = list.filter((s) => s.task_id === `task_${values.task!.replace(/^#|^task_/, "")}`);
    if (values.agent) list = list.filter((s) => s.agent_id.startsWith(values.agent!));
    const db = project.db();
    const rows = list.map((s) => {
      const evs = db.query({ session_id: s.id, types: ["SUBAGENT_STARTED", "FILE_CREATED", "FILE_MODIFIED", "FILE_DELETED", "USER_REQUEST"] });
      return {
        ...s,
        subagents: evs.filter((e) => e.type === "SUBAGENT_STARTED").length,
        files: new Set(evs.filter((e) => e.type.startsWith("FILE_")).map((e) => e.payload.path)).size,
        requests: evs.filter((e) => e.type === "USER_REQUEST").length,
      };
    });
    if (values.json) return json(rows), 0;
    if (!rows.length) return out(c.dim("No sessions recorded.")), 0;
    for (const r of rows) {
      out(
        `${(r.ended_at ? c.dim("○") : c.green("●"))} ${r.label.padEnd(8)} ${r.agent_id.padEnd(13)} ${c.dim(r.started_at.slice(0, 16).replace("T", " "))}  ${String(r.requests).padStart(3)} req ${String(r.files).padStart(3)} files${r.subagents ? ` ${r.subagents} subagent(s)` : ""} ${c.dim(r.id)}`,
      );
    }
    return 0;
  },
};

export const worktrees: Command = {
  name: "worktrees",
  group: "Intelligence",
  summary: "Git worktrees and the agent-state task active in each (parallel agents)",
  usage: "agent-state worktrees [--json]",
  run(argv) {
    const { values } = parse(argv, { json: { type: "boolean" } }, false);
    const project = Project.open();
    const list = project.git.worktrees().map((w) => {
      const state = join(w.path, STATE_DIR);
      const cur = existsSync(state) ? readJson<CurrentPointer | null>(join(state, "current.json"), null) : null;
      let task: { number: number; goal: string; status: string } | null = null;
      if (cur?.task_id) {
        const p = Project.tryOpen(w.path);
        const t = p ? new TaskService(p).get(cur.task_id) : null;
        if (t) task = { number: t.number, goal: t.goal, status: t.status };
        p?.close();
      }
      return { ...w, initialized: existsSync(state), current: w.path === project.root, task, agent: cur?.agent_id ?? null, last_activity: cur?.updated_at ?? null };
    });
    if (values.json) return json(list), 0;
    for (const w of list) {
      out(`${w.current ? c.green("▸") : " "} ${w.path}`);
      out(`    ${c.dim("branch")} ${w.branch ?? "(detached)"}  ${c.dim("head")} ${w.head?.slice(0, 7) ?? "—"}`);
      if (!w.initialized) out(c.dim("    agent-state not initialized"));
      else out(`    ${w.task ? `task #${w.task.number} ${w.task.goal.slice(0, 60)} [${w.task.status}]` : c.dim("no active task")}${w.agent ? c.dim(` · ${w.agent} ${ago(w.last_activity)}`) : ""}`);
    }
    return 0;
  },
};
