import { writeFileSync } from "node:fs";
import { Project } from "../core/project.js";
import { buildReview, renderReview } from "../core/review.js";
import { toProjectPath } from "../core/paths.js";
import { c } from "../ui/term.js";
import { type Command, parse, out, json } from "./types.js";
import { resolveTask } from "./context.js";

export const review: Command = {
  name: "review",
  aliases: ["brief"],
  group: "Intelligence",
  summary: "Review brief of the agent's work: what was asked, what changed, why, how it was verified, where to look",
  usage: `agent-state review [task-id] [--out <file>] [--json]

  Deterministic (git + recorded activity). Flags skipped/focused tests, silenced
  type checkers and linters, swallowed errors, hardcoded credentials, new
  dependencies, infra/config changes, scope violations, untested or widely used
  code, and failing or stale test runs, then suggests a review order.
  --out writes Markdown you can paste into a pull request.`,
  run(argv) {
    const { values, positionals } = parse(argv, { out: { type: "string", short: "o" }, json: { type: "boolean" } });
    const project = Project.open();
    const t = resolveTask(project, positionals[0])!;
    const brief = buildReview(project, t);
    if (values.json) return json(brief), 0;
    const md = renderReview(brief);
    if (values.out) {
      writeFileSync(values.out, md);
      out(`${c.green("✓")} Review brief written to ${toProjectPath(project.root, values.out, process.cwd()) ?? values.out}`);
      return 0;
    }
    process.stdout.write(md);
    return 0;
  },
};
