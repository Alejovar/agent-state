import { existsSync } from "node:fs";
import { Project } from "../core/project.js";
import { checkPath, contractPath, effectivePolicy, loadContract, saveContract, unexpectedFiles, type TaskContract } from "../core/scope.js";
import type { ScopePolicy } from "../core/config.js";
import { toProjectPath } from "../core/paths.js";
import { c } from "../ui/term.js";
import { type Command, parse, out, json, UsageError } from "./types.js";
import { resolveTask } from "./context.js";

const POLICIES: ScopePolicy[] = ["warn", "confirm", "block"];

export const scope: Command = {
  name: "scope",
  aliases: ["intent"],
  group: "Control",
  summary: "Task contract (intent ledger): declare allowed/restricted paths, detect scope expansion",
  usage: `agent-state scope                                  show the contract and check current changes
agent-state scope init [--allow <glob>]... [--restrict <glob>]... [--expect "<item>"]... [--policy warn|confirm|block]
agent-state scope allow <glob>...                  add allowed globs
agent-state scope restrict <glob>...               add restricted globs
agent-state scope policy <warn|confirm|block>      what happens when an agent edits outside scope
agent-state scope check [file...] [--strict]       exit 1 on violations (for CI / pre-commit)
Options: --task <id>, --json

Policies apply to Claude Code edits via the PreToolUse hook: warn shows a message,
confirm asks you, block denies the edit. The contract lives in .agent-state/tasks/task-<n>.yaml.`,
  run(argv) {
    const { values, positionals } = parse(argv, {
      allow: { type: "string", multiple: true },
      restrict: { type: "string", multiple: true },
      expect: { type: "string", multiple: true },
      policy: { type: "string" },
      task: { type: "string" },
      json: { type: "boolean" },
      strict: { type: "boolean" },
    });
    const [sub = "show", ...args] = positionals;
    const project = Project.open();
    const t = resolveTask(project, values.task)!;
    const existing = loadContract(project, t.number);
    const base: TaskContract = existing ?? { task: { id: t.number, goal: t.goal }, scope: { allowed: [], restricted: [] }, expected: [] };
    const checkPolicy = (p: string | undefined): ScopePolicy | undefined => {
      if (p === undefined) return undefined;
      if (!POLICIES.includes(p as ScopePolicy)) throw new UsageError(`Policy must be one of: ${POLICIES.join(", ")}`);
      return p as ScopePolicy;
    };

    switch (sub) {
      case "init":
      case "set": {
        const policy = checkPolicy(values.policy);
        const contract: TaskContract = {
          task: { id: t.number, goal: t.goal },
          scope: { allowed: values.allow ?? base.scope.allowed, restricted: values.restrict ?? base.scope.restricted },
          expected: values.expect ?? base.expected,
          ...(policy ? { policy } : base.policy ? { policy: base.policy } : {}),
        };
        const p = saveContract(project, contract);
        out(`${c.green("✓")} Task contract ${existing ? "updated" : "created"}: ${toProjectPath(project.root, p)}`);
        return showContract(project, t.number, contract, values.json);
      }
      case "allow":
      case "restrict": {
        if (!args.length) throw new UsageError(`Usage: agent-state scope ${sub} <glob>...`);
        const key = sub === "allow" ? "allowed" : "restricted";
        base.scope[key] = [...new Set([...base.scope[key], ...args])];
        saveContract(project, base);
        out(`${c.green("✓")} ${sub === "allow" ? "Allowed" : "Restricted"}: ${args.join(", ")}`);
        return 0;
      }
      case "policy": {
        const policy = checkPolicy(args[0]);
        if (!policy) throw new UsageError("Usage: agent-state scope policy <warn|confirm|block>");
        base.policy = policy;
        saveContract(project, base);
        out(`${c.green("✓")} Scope policy for task #${t.number}: ${policy}`);
        return 0;
      }
      case "check": {
        if (!existing) {
          out(c.dim(`Task #${t.number} has no contract; nothing to check.`));
          return 0;
        }
        const files = args.length ? args.map((a) => toProjectPath(project.root, a, process.cwd()) ?? a) : unexpectedFiles(project, t);
        const bad = files.filter((f) => {
          const v = checkPath(existing, f);
          return v.status === "outside" || v.status === "restricted";
        });
        if (values.json) return json({ task: t.number, violations: bad }), bad.length && (values.strict || effectivePolicy(project, existing) === "block") ? 1 : 0;
        if (!bad.length) {
          out(`${c.green("✓")} All changes are within the declared scope of task #${t.number}.`);
          return 0;
        }
        printViolations(t.number, existing, bad);
        return values.strict || effectivePolicy(project, existing) === "block" ? 1 : 0;
      }
      case "show":
        if (!existing) {
          out(c.dim(`Task #${t.number} has no contract yet.`));
          out(`Create one: ${c.cyan(`agent-state scope init --allow "src/auth/**" --restrict "database/**" --expect "OAuth login"`)}`);
          return 0;
        }
        return showContract(project, t.number, existing, values.json);
      default:
        throw new UsageError(`Unknown subcommand "scope ${sub}".\n\n${scope.usage}`);
    }
  },
};

function showContract(project: Project, n: number, contract: TaskContract, asJson?: boolean): number {
  const t = resolveTask(project, String(n))!;
  const bad = unexpectedFiles(project, t);
  if (asJson) return json({ contract, policy: effectivePolicy(project, contract), unexpected: bad, path: contractPath(project, n), exists: existsSync(contractPath(project, n)) }), 0;
  out("");
  out(c.bold(`Task #${n}: ${contract.task.goal}`));
  out(`${c.dim("Allowed:   ")} ${contract.scope.allowed.join(", ") || c.dim("(anything not restricted)")}`);
  out(`${c.dim("Restricted:")} ${contract.scope.restricted.join(", ") || c.dim("—")}`);
  if (contract.expected.length) out(`${c.dim("Expected:  ")} ${contract.expected.join("; ")}`);
  out(`${c.dim("Policy:    ")} ${effectivePolicy(project, contract)}`);
  if (bad.length) {
    out("");
    printViolations(n, contract, bad);
  } else out(`\n${c.green("✓")} Current changes are within scope.`);
  return 0;
}

function printViolations(n: number, contract: TaskContract, files: string[]): void {
  out(c.yellow("⚠ SCOPE EXPANSION DETECTED"));
  out("");
  out(`Task:\n  #${n}`);
  out("");
  out("Unexpected files:");
  for (const f of files) {
    const v = checkPath(contract, f);
    out(`  ${f}${v.status === "restricted" ? c.red(`  (restricted by ${v.rule})`) : ""}`);
  }
  out("");
  out(c.dim("Declared scope did not include these files. Allow them with: agent-state scope allow <glob>"));
}
