import { rmSync } from "node:fs";
import { Project } from "../core/project.js";
import { fetchTeam, planShare, pushShare, teamTasks, teammateRecovery } from "../core/team.js";
import { c, confirm, ago, formatBytes } from "../ui/term.js";
import { type Command, parse, out, err, json, UsageError } from "./types.js";

export const share: Command = {
  name: "share",
  group: "Integration",
  summary: "Share your tasks' recovery states and decisions with your team through the git remote (opt-in)",
  usage: `agent-state share [task-id...] [--dry-run] [--yes] [--remote <name>]

  Pushes a private ref (refs/agent-state/shared/<you>) to the project's git
  remote. It contains the recovery state of your unfinished tasks (or the ones
  given) and your decisions. It never contains the event log or your verbatim
  prompts. You see the exact file list before anything is sent.`,
  async run(argv) {
    const { values, positionals } = parse(argv, { "dry-run": { type: "boolean", short: "n" }, yes: { type: "boolean", short: "y" }, remote: { type: "string" } });
    const project = Project.open();
    if (!project.git.isRepo()) throw new UsageError("Sharing works through git: this project is not a git repository.");
    const remote = values.remote ?? project.config.sync.remote;
    if (!project.git.tryRun(["remote", "get-url", remote])) throw new UsageError(`No git remote named "${remote}". Use --remote <name> or set sync.remote in config.yaml.`);
    const plan = planShare(project, positionals.length ? positionals : "all-unfinished");
    try {
      out(c.bold(`Share as "${plan.member}" → ${remote} (${plan.ref})`));
      out("");
      if (!plan.tasks.length) out(c.dim("No unfinished tasks; only decisions would be shared."));
      for (const t of plan.tasks) out(`  #${t.number} ${t.goal} ${c.dim(`[${t.status}]`)}`);
      out("");
      out("Files that will be sent:");
      for (const f of plan.files) out(`  ${f.path} ${c.dim(formatBytes(f.bytes))}`);
      out(c.dim("Never sent: the event log, verbatim prompts, free-form context notes."));
      if (values["dry-run"]) {
        out("");
        out(c.dim("Dry run: nothing was sent."));
        rmSync(plan.dir, { recursive: true, force: true });
        return 0;
      }
      if (!values.yes) {
        if (!process.stdin.isTTY) {
          err("Refusing to share without confirmation in a non-interactive shell. Re-run with --yes, or preview with --dry-run.");
          rmSync(plan.dir, { recursive: true, force: true });
          return 1;
        }
        if (!(await confirm("Send these files to the remote?"))) {
          out("Nothing was sent.");
          rmSync(plan.dir, { recursive: true, force: true });
          return 1;
        }
      }
      const commit = pushShare(project, plan, remote);
      out(`${c.green("✓")} Shared ${plan.files.length} file(s) (${commit.slice(0, 7)}). Teammates see it with: agent-state team`);
      return 0;
    } catch (e) {
      rmSync(plan.dir, { recursive: true, force: true });
      throw e;
    }
  },
};

export const team: Command = {
  name: "team",
  group: "Integration",
  summary: "See the tasks your teammates shared; recover one with `recover --from <name> <task>`",
  usage: `agent-state team [--no-fetch] [--remote <name>] [--json]
agent-state team show <name> <task-id>     print a teammate's shared recovery context`,
  run(argv) {
    const { values, positionals } = parse(argv, { "no-fetch": { type: "boolean" }, remote: { type: "string" }, json: { type: "boolean" } });
    const project = Project.open();
    const remote = values.remote ?? project.config.sync.remote;
    if (!values["no-fetch"]) {
      try {
        fetchTeam(project, remote);
      } catch (e) {
        err(c.yellow(`⚠ Could not fetch from "${remote}": ${(e as Error).message.split("\n")[0]}. Showing what was fetched before.`));
      }
    }
    if (positionals[0] === "show") {
      const [, member, task] = positionals;
      if (!member || !task) throw new UsageError("Usage: agent-state team show <name> <task-id>");
      const md = teammateRecovery(project, member, Number(task.replace(/^#|^task_/, "")));
      if (!md) throw new UsageError(`${member} has not shared task ${task}. See: agent-state team`);
      process.stdout.write(md);
      return 0;
    }
    const tasks = teamTasks(project);
    if (values.json) return json(tasks), 0;
    if (!tasks.length) {
      out(c.dim("Nobody has shared anything yet. Share yours with: agent-state share"));
      return 0;
    }
    for (const t of tasks) out(`${c.bold(t.member.padEnd(16))} #${String(t.number).padEnd(4)} ${t.goal} ${c.dim(`[${t.status}] shared ${ago(t.shared_at)}`)}`);
    out("");
    out(c.dim("Read one: agent-state team show <name> <task-id>  ·  hand it to your agent: agent-state recover --from <name> <task-id>"));
    return 0;
  },
};
