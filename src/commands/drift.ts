import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Project } from "../core/project.js";
import { DOC_CANDIDATES, detectDrift, type DriftFinding } from "../core/drift.js";
import { ProjectIndex } from "../index/indexer.js";
import { overview } from "../index/analysis.js";
import { aiDrift } from "../ai/drift.js";
import { toProjectPath } from "../core/paths.js";
import { c } from "../ui/term.js";
import { type Command, parse, out, json, UsageError } from "./types.js";

export const drift: Command = {
  name: "drift",
  group: "Intelligence",
  summary: "Detect contradictions between CLAUDE.md/docs/config and the actual code",
  usage: `agent-state drift [doc] [--ai] [--min-confidence 0.7] [--json]

  Deterministic checks: referenced paths that no longer exist, scripts/make targets
  that do not exist, package-manager mismatches, technology claims with no evidence
  (or with a competing technology in use). --ai adds semantic comparison using the
  configured provider. Documentation is never rewritten.`,
  async run(argv) {
    const { values, positionals } = parse(argv, { ai: { type: "boolean" }, json: { type: "boolean" }, "min-confidence": { type: "string" } });
    const project = Project.open();
    const idx = new ProjectIndex(project);
    idx.update();
    const only = positionals[0] ? toProjectPath(project.root, positionals[0], process.cwd()) ?? undefined : undefined;
    if (positionals[0] && !only) throw new UsageError(`${positionals[0]} is outside the project.`);
    let findings: DriftFinding[] = detectDrift(project, idx, only);
    if (values.ai) {
      const docs = only ? [only] : idx.all().map((f) => f.path).filter((f) => DOC_CANDIDATES.test(f)).slice(0, 8);
      findings = [...findings, ...(await aiDrift(project, docs, overview(project, idx), findings))];
    }
    const min = Number(values["min-confidence"] ?? 0);
    findings = findings.filter((f) => f.confidence >= min);
    const report = join(project.paths.reports, "drift.json");
    writeFileSync(report, JSON.stringify({ generated_at: new Date().toISOString(), findings }, null, 2));
    if (values.json) return json(findings), 0;
    if (!findings.length) {
      out(`${c.green("✓")} No context drift detected${only ? ` in ${only}` : ""}.`);
      return 0;
    }
    for (const f of findings) {
      out(c.yellow("CONTEXT DRIFT") + c.dim(`  [${f.kind}${f.evidence === "ai" ? ", AI-assessed" : ""}]`));
      out("");
      out(`${c.dim("Documentation:")}  ${f.claim}`);
      out(`${c.dim("Observed:")}       ${f.observed}`);
      out(`${c.dim("Confidence:")}     ${Math.round(f.confidence * 100)}%`);
      out(`${c.dim("Relevant files:")} ${[...new Set([f.line ? `${f.doc}:${f.line}` : f.doc, ...f.files.filter((x) => x !== f.doc)])].join(", ")}`);
      out("");
    }
    out(c.dim(`${findings.length} finding(s). Report: ${toProjectPath(project.root, report)}. Documentation was not modified.`));
    return 0;
  },
};
