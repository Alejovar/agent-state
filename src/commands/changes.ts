import { Project } from "../core/project.js";
import { buildChangeMap, type ChangedFile } from "../core/changes.js";
import { reduceState } from "../core/state.js";
import { unexpectedFiles } from "../core/scope.js";
import { c } from "../ui/term.js";
import { type Command, parse, out, json } from "./types.js";
import { resolveTask } from "./context.js";
import { ProjectIndex } from "../index/indexer.js";

export const changes: Command = {
  name: "changes",
  group: "Intelligence",
  summary: "Change map of the task: direct, created, deleted, indirectly affected, tests, config, deps",
  usage: "agent-state changes [task-id] [--json] [--no-indirect]",
  run(argv) {
    const { values, positionals } = parse(argv, { json: { type: "boolean" }, "no-indirect": { type: "boolean" } });
    const project = Project.open();
    const t = resolveTask(project, positionals[0], { required: false });
    const ws = t ? reduceState(t.id, project.db().query({ task_id: t.id })) : null;
    const map = buildChangeMap(project, t, ws);
    const unexpected = t ? new Set(unexpectedFiles(project, t)) : new Set<string>();

    let indirect: { path: string; via: string }[] = [];
    if (!values["no-indirect"]) {
      const idx = new ProjectIndex(project);
      idx.update();
      const direct = new Set(map.files.map((f) => f.path));
      const seen = new Set<string>();
      for (const f of map.files) {
        if (f.role === "test" || f.role === "documentation") continue;
        for (const dep of idx.importers(f.path)) {
          if (direct.has(dep) || seen.has(dep)) continue;
          seen.add(dep);
          indirect.push({ path: dep, via: f.path });
        }
      }
      indirect = indirect.sort((a, b) => a.path.localeCompare(b.path));
    }

    if (values.json) return json({ ...map, indirect, unexpected: [...unexpected] }), 0;

    out(c.bold(t ? `TASK #${t.number}` : "WORKING TREE") + (t ? c.dim(`  ${t.goal}`) : ""));
    if (map.is_git) out(c.dim(`${map.branch ?? "detached"} @ ${map.head?.slice(0, 7) ?? "—"}${map.base_head ? ` · since ${map.base_head.slice(0, 7)}` : ""}${map.commits.length ? ` · ${map.commits.length} commit(s)` : ""}`));
    if (!map.files.length) {
      out("");
      out(c.dim("No changes."));
      return 0;
    }
    const by = (pred: (f: ChangedFile) => boolean) => map.files.filter(pred);
    const src = (f: ChangedFile) => f.role === "source" || f.role === "other";
    const section = (title: string, files: ChangedFile[]) => {
      if (!files.length) return;
      out("");
      out(`${title}:`);
      for (const f of files) {
        const flag = unexpected.has(f.path) ? c.yellow("  ⚠ outside scope") : "";
        const from = f.from ? c.dim(` (from ${f.from})`) : "";
        const ev = f.evidence === "events" ? c.dim(" (recorded)") : "";
        out(`  ${f.path}${from}${ev}${flag}`);
      }
    };
    section("Direct changes", by((f) => src(f) && (f.kind === "modified" || f.kind === "renamed")));
    section("Created", by((f) => src(f) && f.kind === "created"));
    section("Deleted", by((f) => f.kind === "deleted" && f.role !== "test"));
    if (indirect.length) {
      out("");
      out("Indirectly affected:");
      for (const i of indirect.slice(0, 30)) out(`  ${i.path} ${c.dim(`← ${i.via}`)}`);
      if (indirect.length > 30) out(c.dim(`  … ${indirect.length - 30} more`));
    }
    section("Tests", by((f) => f.role === "test"));
    section("Configuration", by((f) => f.role === "config"));
    section("Infrastructure", by((f) => f.role === "infrastructure"));
    section("Documentation", by((f) => f.role === "documentation"));
    section("Dependency manifests", by((f) => f.role === "dependency"));
    if (map.dependencies.length) {
      out("");
      out("Dependencies:");
      for (const d of map.dependencies) {
        for (const a of d.added) out(`  ${c.green("+")} ${a} ${c.dim(d.manifest)}`);
        for (const r of d.removed) out(`  ${c.red("-")} ${r} ${c.dim(d.manifest)}`);
        for (const ch of d.changed) out(`  ${c.yellow("~")} ${ch} ${c.dim(d.manifest)}`);
      }
    }
    if (unexpected.size) {
      out("");
      out(c.yellow(`⚠ SCOPE EXPANSION: ${unexpected.size} file(s) outside the declared scope of task #${t!.number}`));
    }
    return 0;
  },
};
