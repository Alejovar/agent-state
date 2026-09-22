import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Project } from "../core/project.js";
import { TaskService } from "../core/tasks.js";
import type { NoteKind, DecisionPayload } from "../core/events.js";
import { withLock } from "../core/lock.js";
import { toProjectPath } from "../core/paths.js";
import { c, ago, kv } from "../ui/term.js";
import { type Command, parse, out, json, UsageError } from "./types.js";
import { cliAttribution, resolveTask } from "./context.js";

export const task: Command = {
  name: "task",
  group: "Core",
  summary: "Create, list, switch and finish tasks (a task can span many sessions)",
  usage: `agent-state task new "<goal>" [--parent <id>]
agent-state task list [--all] [--json]
agent-state task show [id] [--json]
agent-state task switch <id>
agent-state task done [id]
agent-state task abandon [id]
agent-state task rename [id] "<goal>"`,
  run(argv) {
    const [sub = "show", ...rest] = argv;
    const project = Project.open();
    const svc = new TaskService(project);
    const who = cliAttribution(project);
    switch (sub) {
      case "new":
      case "start": {
        const { values, positionals } = parse(rest, { parent: { type: "string" } });
        const goal = positionals.join(" ").trim();
        if (!goal) throw new UsageError('Usage: agent-state task new "<goal>"');
        const parent = values.parent ? resolveTask(project, values.parent)!.id : null;
        const prev = svc.currentTask();
        if (prev && prev.status === "ACTIVE") svc.setStatus(prev.id, "PAUSED", { ...who, reason: "new task started" });
        const t = svc.create(goal, { ...who, parent_task_id: parent });
        out(`${c.green("✓")} Task #${t.number} created and active: ${t.goal}`);
        if (t.base_head) out(c.dim(`  base: ${t.base_branch ?? "detached"} @ ${t.base_head.slice(0, 7)}`));
        return 0;
      }
      case "list":
      case "ls": {
        const { values } = parse(rest, { all: { type: "boolean" }, json: { type: "boolean" } }, false);
        const tasks = svc.list().filter((t) => values.all || (t.status !== "COMPLETED" && t.status !== "ABANDONED"));
        if (values.json) return json(tasks), 0;
        if (!tasks.length) return out(c.dim(values.all ? "No tasks yet." : "No unfinished tasks. Use --all to include finished ones.")), 0;
        const cur = project.current().task_id;
        for (const t of tasks) {
          const mark = t.id === cur ? c.green("●") : " ";
          out(`${mark} #${String(t.number).padEnd(4)} ${statusColor(t.status)(t.status.padEnd(10))} ${t.goal.slice(0, 70)} ${c.dim(`· ${t.sessions.length} session(s) · ${ago(t.updated_at)}`)}`);
        }
        return 0;
      }
      case "show": {
        const { values, positionals } = parse(rest, { json: { type: "boolean" } });
        const t = resolveTask(project, positionals[0])!;
        if (values.json) return json(t), 0;
        out(c.bold(`Task #${t.number}: ${t.goal}`));
        out(kv("Status", statusColor(t.status)(t.status)));
        out(kv("Created", `${t.created_at} (${ago(t.created_at)})`));
        if (t.base_head) out(kv("Base", `${t.base_branch ?? "detached"} @ ${t.base_head.slice(0, 7)}`));
        if (t.parent_task_id) out(kv("Parent", `#${t.parent_task_id.replace("task_", "")}`));
        out(kv("Sessions", t.sessions.length ? "" : c.dim("none")));
        for (const s of t.sessions) out(`  ${s.label.padEnd(8)} ${s.agent_id.padEnd(14)} ${c.dim(`${s.started_at.slice(0, 16)} → ${s.ended_at ? s.ended_at.slice(0, 16) : "open"}`)}`);
        return 0;
      }
      case "switch":
      case "resume": {
        const t = resolveTask(project, rest[0] ?? "")!;
        svc.switchTo(t.id);
        out(`${c.green("✓")} Switched to task #${t.number}: ${t.goal}`);
        return 0;
      }
      case "done":
      case "complete":
      case "abandon": {
        const t = resolveTask(project, rest[0])!;
        const status = sub === "abandon" ? "ABANDONED" : "COMPLETED";
        svc.setStatus(t.id, status, who);
        if (project.current().task_id === t.id) project.setCurrent({ task_id: null });
        out(`${c.green("✓")} Task #${t.number} ${status.toLowerCase()}.`);
        return 0;
      }
      case "rename": {
        const maybeRef = rest[0] && /^#?\d+$/.test(rest[0]) ? rest[0] : undefined;
        const goal = (maybeRef ? rest.slice(1) : rest).join(" ").trim();
        if (!goal) throw new UsageError('Usage: agent-state task rename [id] "<goal>"');
        const t = resolveTask(project, maybeRef)!;
        svc.rename(t.id, goal);
        out(`${c.green("✓")} Task #${t.number}: ${goal}`);
        return 0;
      }
      default:
        throw new UsageError(`Unknown subcommand "task ${sub}".\n\n${task.usage}`);
    }
  },
};

export function statusColor(s: string): (x: string) => string {
  if (s === "ACTIVE" || s === "RECOVERED") return c.green;
  if (s === "COMPLETED") return c.blue;
  if (s === "ABANDONED") return c.gray;
  return c.yellow;
}

const NOTE_KINDS: Record<string, NoteKind> = {
  done: "done",
  pending: "pending",
  todo: "pending",
  blocked: "blocked",
  issue: "issue",
  bug: "issue",
  resolved: "resolved",
  fixed: "resolved",
  tried: "failed_attempt",
  failed: "failed_attempt",
  next: "next",
  context: "context",
  note: "context",
};

export const note: Command = {
  name: "note",
  group: "Recovery",
  summary: "Record progress for recovery: done, pending, blocked, issue, resolved, tried, next, context",
  usage: `agent-state note <kind> "<text>" [--file <path>]... [--task <id>]

kinds:
  done      a completed item              pending   remaining work (alias: todo)
  blocked   blocked work                  issue     a known problem / current error
  resolved  resolves a matching issue     tried     an approach that failed (alias: failed)
  next      the recommended next action   context   anything the next session must know`,
  run(argv) {
    const { values, positionals } = parse(argv, { file: { type: "string", multiple: true }, task: { type: "string" } });
    const [kindArg, ...words] = positionals;
    const kind = kindArg ? NOTE_KINDS[kindArg] : undefined;
    const text = words.join(" ").trim();
    if (!kind || !text) throw new UsageError(note.usage);
    const project = Project.open();
    const t = resolveTask(project, values.task)!;
    const files = (values.file ?? []).map((f) => toProjectPath(project.root, f, process.cwd()) ?? f);
    project.emit({
      type: "NOTE_RECORDED",
      ...cliAttribution(project),
      task_id: t.id,
      payload: { kind, text, ...(files.length ? { files } : {}), ...(kind === "resolved" ? { ref: text } : {}) },
    });
    out(`${c.green("✓")} ${kind.replace("_", " ")} recorded on task #${t.number}`);
    return 0;
  },
};

export const decide: Command = {
  name: "decide",
  aliases: ["decision"],
  group: "Recovery",
  summary: "Record an architectural decision (decision ledger)",
  usage: `agent-state decide "<decision>" [--reason "<why>"] [--rejected "<alternative>"]... [--file <path>]... [--task <id>]`,
  run(argv) {
    const { values, positionals } = parse(argv, {
      reason: { type: "string", short: "r" },
      rejected: { type: "string", multiple: true },
      file: { type: "string", multiple: true },
      task: { type: "string" },
    });
    const text = positionals.join(" ").trim();
    if (!text) throw new UsageError(decide.usage);
    const project = Project.open();
    const t = resolveTask(project, values.task, { required: false });
    const files = (values.file ?? []).map((f) => toProjectPath(project.root, f, process.cwd()) ?? f);
    const number = withLock(project.lockPath("decisions"), () => {
      const n = project.db().query({ types: ["DECISION_RECORDED"] }).length + 1;
      const payload: DecisionPayload = {
        number: n,
        decision: text,
        ...(values.reason ? { reason: values.reason } : {}),
        ...(values.rejected?.length ? { alternatives: values.rejected } : {}),
        ...(files.length ? { files } : {}),
      };
      project.emit({ type: "DECISION_RECORDED", ...cliAttribution(project), task_id: t?.id ?? null, payload: payload as unknown as Record<string, unknown> });
      return n;
    });
    writeDecisionFile(project, number, text, values.reason, values.rejected ?? [], files, t?.number ?? null);
    out(`${c.green("✓")} Decision #${number} recorded${t ? ` on task #${t.number}` : ""}`);
    return 0;
  },
};

function writeDecisionFile(project: Project, n: number, decision: string, reason: string | undefined, rejected: string[], files: string[], taskNumber: number | null): void {
  const dir = project.paths.decisions;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lines = [
    `# Decision #${n}`,
    "",
    `**Decision:** ${decision}`,
    "",
    ...(reason ? [`**Reason:** ${reason}`, ""] : []),
    ...(rejected.length ? ["**Alternatives rejected:**", ...rejected.map((r) => `- ${r}`), ""] : []),
    ...(files.length ? ["**Files:**", ...files.map((f) => `- ${f}`), ""] : []),
    ...(taskNumber ? [`**Task:** #${taskNumber}`, ""] : []),
    `_Recorded ${new Date().toISOString()}_`,
    "",
  ];
  writeFileSync(join(dir, `decision-${String(n).padStart(4, "0")}.md`), project.redactor.redact(lines.join("\n")));
}
