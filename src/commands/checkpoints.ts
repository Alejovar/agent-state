import { Project } from "../core/project.js";
import { Checkpoints, CheckpointError } from "../core/checkpoint.js";
import { compactTask } from "../core/compact.js";
import { writeJson } from "../core/store.js";
import { join } from "node:path";
import { c, ago, confirm } from "../ui/term.js";
import { type Command, parse, out, err, json, UsageError } from "./types.js";
import { cliAttribution, resolveTask } from "./context.js";

export const checkpoint: Command = {
  name: "checkpoint",
  aliases: ["cp"],
  group: "Checkpoints",
  summary: "Snapshot working tree, index, task and recovery state (never touches your files)",
  usage: `agent-state checkpoint <name> [-m "<message>"] [--force]

  Stores the full working tree (tracked + untracked, respecting .gitignore) and
  the index as private git objects under refs/agent-state/checkpoints/<name>,
  plus the task's recovery state. Your branch, index and files are untouched.`,
  run(argv) {
    const { values, positionals } = parse(argv, { message: { type: "string", short: "m" }, force: { type: "boolean", short: "f" } });
    const name = positionals[0];
    if (!name) throw new UsageError(checkpoint.usage);
    const project = Project.open();
    const t = resolveTask(project, undefined, { required: false });
    const who = cliAttribution(project);
    const meta = new Checkpoints(project).create(name, {
      ...(values.message ? { message: values.message } : {}),
      force: values.force,
      task_id: t?.id ?? null,
      session_id: who.session_id,
    });
    let recovery = "none (no active task)";
    if (t) {
      const r = compactTask(project, t, { ...who, status: false });
      writeJson(join(project.paths.checkpoints, `${name}.recovery.json`), r.state);
      recovery = "saved";
    }
    out(c.bold("Checkpoint created:"));
    out("");
    out(`Name:           ${meta.name}`);
    out(`Git:            ${meta.head?.slice(0, 7) ?? "(no commits)"}${meta.branch ? c.dim(` on ${meta.branch}`) : ""}`);
    out(`Files changed:  ${meta.changed_files.length}${meta.staged_files.length ? c.dim(` (${meta.staged_files.length} staged)`) : ""}`);
    out(`Task:           ${t ? `#${t.number}` : "—"}`);
    out(`Recovery state: ${recovery}`);
    out("");
    out(`${c.green("✓")} Checkpoint created ${c.dim(`(restore with: agent-state restore ${name} --dry-run)`)}`);
    return 0;
  },
};

export const checkpoints: Command = {
  name: "checkpoints",
  group: "Checkpoints",
  summary: "List checkpoints",
  usage: "agent-state checkpoints [--json] [--delete <name>]",
  run(argv) {
    const { values } = parse(argv, { json: { type: "boolean" }, delete: { type: "string" } }, false);
    const project = Project.open();
    const cps = new Checkpoints(project);
    if (values.delete) {
      cps.remove(values.delete);
      out(`${c.green("✓")} Deleted checkpoint ${values.delete}`);
      return 0;
    }
    const list = cps.list();
    if (values.json) return json(list), 0;
    if (!list.length) return out(c.dim("No checkpoints. Create one with: agent-state checkpoint <name>")), 0;
    for (const m of list) {
      out(
        `${m.auto ? c.dim("◦") : "●"} ${m.name.padEnd(28)} ${c.dim((m.head?.slice(0, 7) ?? "-------").padEnd(8))} ${String(m.changed_files.length).padStart(3)} files  ${m.task_id ? `#${m.task_id.replace("task_", "")}`.padEnd(6) : "      "} ${c.dim(ago(m.created_at))}${m.message ? c.dim(` — ${m.message}`) : ""}`,
      );
    }
    return 0;
  },
};

export const restore: Command = {
  name: "restore",
  group: "Checkpoints",
  summary: "Safely restore a checkpoint (dry-run preview, conflict report, automatic backup)",
  usage: `agent-state restore <name> [--dry-run] [--yes] [--no-backup]

  Shows exactly which files would change and which uncommitted work would be
  overwritten, then asks for confirmation. Before writing anything, the current
  state is saved as a "pre-restore-…" checkpoint so the restore can be undone.
  HEAD and branches are never moved.`,
  async run(argv) {
    const { values, positionals } = parse(argv, { "dry-run": { type: "boolean", short: "n" }, yes: { type: "boolean", short: "y" }, "no-backup": { type: "boolean" } });
    const name = positionals[0];
    if (!name) throw new UsageError(restore.usage);
    const project = Project.open();
    const cps = new Checkpoints(project);
    const plan = cps.plan(name);
    const touched = plan.create.length + plan.modify.length + plan.delete.length;

    out(kv("Checkpoint", `${plan.checkpoint.name} ${c.dim(`(${plan.checkpoint.head?.slice(0, 7) ?? "no commits"}, ${ago(plan.checkpoint.created_at)})`)}`));
    out(kv("Current changes", `${plan.current_changes.length} file(s)`));
    out(kv("Checkpoint changes", `${plan.checkpoint.changed_files.length} file(s)`));
    out(kv("Restore would", `write ${plan.create.length + plan.modify.length}, delete ${plan.delete.length}`));
    out(kv("Potential conflicts", plan.conflicts.length ? c.yellow(String(plan.conflicts.length)) : c.green("0")));
    if (!plan.head_matches) {
      out(c.yellow(`⚠ HEAD differs: checkpoint at ${plan.checkpoint.head?.slice(0, 7) ?? "none"}, now ${plan.current_head?.slice(0, 7) ?? "none"}. Files will be restored; HEAD and the index will not.`));
    }
    if (touched) {
      out("");
      out("Files that may be affected:");
      const conflict = new Set(plan.conflicts);
      const show = (label: string, list: string[]) => {
        for (const p of list.slice(0, 40)) out(`  ${label} ${p}${conflict.has(p) ? c.yellow("  ⚠ uncommitted changes will be overwritten") : ""}`);
      };
      show(c.green("A"), plan.create);
      show(c.yellow("M"), plan.modify);
      show(c.red("D"), plan.delete);
      if (touched > 120) out(c.dim(`  … ${touched - 120} more`));
    }
    if (!touched) {
      out("");
      out(`${c.green("✓")} Working tree already matches the checkpoint. Nothing to restore.`);
      return 0;
    }
    if (values["dry-run"]) {
      out("");
      out(c.dim("Dry run — nothing was changed."));
      return 0;
    }
    out("");
    if (!values.yes) {
      if (!process.stdin.isTTY) {
        err("Refusing to restore without confirmation in a non-interactive shell. Re-run with --yes, or preview with --dry-run.");
        return 1;
      }
      if (!(await confirm("Proceed?"))) {
        out("Aborted. Nothing was changed.");
        return 1;
      }
    }
    const t = resolveTask(project, undefined, { required: false });
    const res = cps.restore(name, { backup: !values["no-backup"], task_id: t?.id ?? null });
    out(`${c.green("✓")} Restored ${touched} file(s) from ${name}${res.index_restored ? " (index restored too)" : ""}.`);
    if (res.backup) out(c.dim(`  Previous state saved as checkpoint "${res.backup}" — undo with: agent-state restore ${res.backup}`));
    return 0;
  },
};

function kv(k: string, v: string): string {
  return `${c.dim((k + ":").padEnd(21))}${v}`;
}

export { CheckpointError };
