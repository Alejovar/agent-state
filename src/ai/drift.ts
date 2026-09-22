import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../core/project.js";
import type { DriftFinding } from "../core/drift.js";
import type { Overview } from "../index/analysis.js";
import { AIError, extractJson } from "./provider.js";
import { aiProvider } from "./enhance.js";
import { c } from "../ui/term.js";

const SYSTEM = `You compare project documentation against repository facts to find contradictions ("context drift").
You are given (1) documentation text and (2) a list of FACTS extracted deterministically from the repository.
Report only contradictions supported by the FACTS. Never report something as drift just because the facts do not mention it.
Respond with JSON only: {"findings":[{"claim":"<doc statement>","observed":"<contradicting fact>","confidence":0.0-1.0,"files":["<doc path>","<repo path>"]}]}`;

/** Semantic drift via the configured AI provider. Returns [] on any provider/format problem. */
export async function aiDrift(project: Project, docs: string[], ov: Overview, deterministic: DriftFinding[]): Promise<DriftFinding[]> {
  const facts = {
    languages: ov.languages.slice(0, 6),
    frameworks: ov.frameworks,
    databases: ov.databases,
    entrypoints: ov.entrypoints,
    modules: ov.modules.slice(0, 15),
    apis: ov.apis.slice(0, 30).map((a) => `${a.method} ${a.path} (${a.file})`),
    infrastructure: ov.infrastructure,
    tests: ov.tests,
    services: ov.services,
    already_found: deterministic.map((d) => d.claim),
  };
  const docText = docs
    .map((d) => {
      try {
        return `--- ${d} ---\n${readFileSync(join(project.root, d), "utf8").slice(0, 12_000)}`;
      } catch {
        return "";
      }
    })
    .join("\n\n");
  const prompt = project.redactor.redact(`FACTS:\n${JSON.stringify(facts)}\n\nDOCUMENTATION:\n${docText}`);
  const provider = aiProvider(project, "drift-analysis", Buffer.byteLength(prompt));
  if (!provider) return [];
  let raw: string;
  try {
    raw = await provider.complete(SYSTEM, prompt);
  } catch (err) {
    process.stderr.write(c.yellow(`⚠ AI drift analysis skipped: ${err instanceof AIError ? err.message : String(err)}\n`));
    return [];
  }
  const parsed = extractJson(raw) as { findings?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.findings)) {
    process.stderr.write(c.yellow("⚠ AI drift analysis returned malformed output; ignored.\n"));
    return [];
  }
  const out: DriftFinding[] = [];
  for (const f of parsed.findings as Record<string, unknown>[]) {
    if (typeof f?.claim !== "string" || typeof f?.observed !== "string") continue;
    const conf = typeof f.confidence === "number" ? Math.max(0, Math.min(1, f.confidence)) : 0.5;
    const files = Array.isArray(f.files) ? f.files.filter((x): x is string => typeof x === "string").slice(0, 5) : [];
    out.push({ kind: "semantic", doc: files[0] ?? docs[0] ?? "", line: 0, claim: f.claim.slice(0, 300), observed: f.observed.slice(0, 300), confidence: conf, files, evidence: "ai" });
  }
  return out;
}
