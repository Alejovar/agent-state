import { Project } from "../core/project.js";
import { toProjectPath } from "../core/paths.js";
import { ProjectIndex } from "../index/indexer.js";
import { impact as analyzeImpact, overview, search } from "../index/analysis.js";
import { c } from "../ui/term.js";
import { type Command, parse, out, json, UsageError } from "./types.js";

export const index: Command = {
  name: "index",
  group: "Intelligence",
  summary: "Incremental project index: overview, search (`index <query>`), impact (`index impact <file>`)",
  usage: `agent-state index                       update the index and show the project overview
agent-state index <query>               find files by concept/path/symbol/route (e.g. "authentication")
agent-state index impact <file>         same as \`agent-state impact <file>\`
agent-state index --rebuild             drop and rebuild the index
Options: --json`,
  run(argv) {
    const { values, positionals } = parse(argv, { json: { type: "boolean" }, rebuild: { type: "boolean" }, limit: { type: "string" } });
    const project = Project.open();
    const idx = new ProjectIndex(project);
    if (values.rebuild) project.db().raw.exec("DELETE FROM idx_files; DELETE FROM idx_edges;");
    const st = idx.update();
    if (positionals[0] === "impact") return impactCmd.run([...positionals.slice(1), ...(values.json ? ["--json"] : [])]);
    if (positionals.length) {
      const hits = search(idx, positionals.join(" "), Number(values.limit ?? 25));
      if (values.json) return json(hits), 0;
      if (!hits.length) return out(c.dim(`No matches for "${positionals.join(" ")}".`)), 0;
      for (const h of hits) out(`${h.path.padEnd(50)} ${c.dim(h.reasons.join(", "))}`);
      return 0;
    }
    const ov = overview(project, idx);
    if (values.json) return json({ ...ov, update: st, ...idx.stats() }), 0;
    const { edges } = idx.stats();
    out(c.bold(`Project: ${ov.name}`) + c.dim(`  ${ov.files} files · ${edges} import edges · updated ${st.parsed} parsed, ${st.removed} removed, ${st.unchanged} unchanged in ${st.ms} ms`));
    const line = (k: string, v: string) => out(`${c.dim(k.padEnd(15))} ${v}`);
    line("Languages", ov.languages.slice(0, 8).map((l) => `${l.lang} (${l.files})`).join(", ") || c.dim("—"));
    line("Frameworks", ov.frameworks.join(", ") || c.dim("—"));
    line("Databases", ov.databases.join(", ") || c.dim("—"));
    if (ov.packages.length > 1) line("Packages", ov.packages.map((p) => `${p.name} (${p.path})`).slice(0, 10).join(", "));
    if (ov.services.length) line("Services", ov.services.slice(0, 10).join(", "));
    line("Entrypoints", ov.entrypoints.slice(0, 8).join(", ") || c.dim("—"));
    line("Modules", ov.modules.slice(0, 8).map((m) => `${m.path} (${m.files})`).join(", ") || c.dim("—"));
    line("APIs", ov.apis.length ? `${ov.apis.length} route(s): ${ov.apis.slice(0, 5).map((a) => `${a.method} ${a.path}`).join(", ")}${ov.apis.length > 5 ? ", …" : ""}` : c.dim("—"));
    line("Infrastructure", ov.infrastructure.slice(0, 6).join(", ") || c.dim("—"));
    line("Tests", ov.tests.files ? `${ov.tests.files} file(s) in ${ov.tests.dirs.join(", ")}` : c.dim("—"));
    line("Docs", ov.documentation.slice(0, 6).join(", ") || c.dim("—"));
    return 0;
  },
};

export const impactCmd: Command = {
  name: "impact",
  group: "Intelligence",
  summary: "What depends on a file: importers, tests, routes, config, affected areas",
  usage: "agent-state impact <file> [--json]",
  run(argv) {
    const { values, positionals } = parse(argv, { json: { type: "boolean" } });
    if (!positionals[0]) throw new UsageError(impactCmd.usage);
    const project = Project.open();
    const path = toProjectPath(project.root, positionals[0], process.cwd());
    if (!path) throw new UsageError(`${positionals[0]} is outside the project.`);
    const idx = new ProjectIndex(project);
    idx.update();
    const r = analyzeImpact(project, idx, path);
    if (values.json) return json(r), 0;
    if (!r.exists && !r.indexed) throw new UsageError(`${path} does not exist in the project.`);
    out(c.bold(path) + c.dim(`  [${r.role}]${r.symbols.length ? ` defines ${r.symbols.slice(0, 6).join(", ")}${r.symbols.length > 6 ? ", …" : ""}` : ""}`));
    out("");
    out("Used by:");
    if (!r.used_by.length) out(c.dim("  (no importers found)"));
    for (const u of r.used_by.slice(0, 30)) out(`  ${"  ".repeat(u.depth - 1)}${u.path}${u.depth > 1 ? c.dim(` (indirect, depth ${u.depth})`) : ""}`);
    if (r.used_by.length > 30) out(c.dim(`  … ${r.used_by.length - 30} more`));
    if (r.imports.length) {
      out("");
      out("Imports:");
      for (const i of r.imports.slice(0, 15)) out(`  ${i}`);
    }
    out("");
    out("Tests:");
    if (!r.tests.length) out(c.yellow("  none found — changes here are not covered by any test that imports it"));
    for (const t of r.tests) out(`  ${t}`);
    if (r.routes.length) {
      out("");
      out("Routes:");
      for (const rt of r.routes.slice(0, 15)) out(`  ${rt.method.padEnd(6)} ${rt.path} ${c.dim(rt.file)}`);
    }
    if (r.config.length) {
      out("");
      out("Configuration:");
      for (const cf of r.config) out(`  ${cf}`);
    }
    if (r.packages.length) {
      out("");
      out(`Packages: ${r.packages.join(", ")}`);
    }
    out("");
    out("Potential impact " + c.dim("(inferred from dependents' paths and routes):"));
    for (const a of r.areas) out(`  ${a}`);
    return 0;
  },
};
