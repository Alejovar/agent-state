import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, initProject, cli, AUTH_APP } from "./helpers.js";
import { ProjectIndex } from "../src/index/indexer.js";

const FILES = {
  ...AUTH_APP,
  "src/routes/api.ts": [
    'import { createSession as cs, destroySession } from "../auth/session";',
    'import * as sess from "../auth/session";',
    'const note = "createSession mentioned in a string";',
    "// cs() in a comment",
    "export class Api {",
    "  async refresh(user: string) {",
    "    return cs(user);",
    "  }",
    "}",
    'export const quick = () => cs("q");',
    "export function logout() { destroySession(); sess.destroySession(); }",
    "",
  ].join("\n"),
  "app/models.py": "def save(x):\n    return x\n",
  "app/views.py": 'from .models import save as persist\n"""\npersist in a docstring\n"""\ndef create(req):\n    return persist(req)\n',
};

for (const engine of ["tree-sitter", "built-in"] as const) {
  test(`symbol usages (${engine}): aliases, namespaces, methods, arrows; strings and comments ignored`, async () => {
    const prev = process.env.AGENT_STATE_NO_TREE_SITTER;
    if (engine === "built-in") process.env.AGENT_STATE_NO_TREE_SITTER = "1";
    const { symbolUsages: fresh } = await import(`../src/index/symbols.js?${engine}`);
    const repo = makeRepo(FILES);
    try {
      const p = initProject(repo);
      const idx = new ProjectIndex(p);
      idx.update();
      const target = "src/auth/session.ts";
      const direct = idx.importers(target).map((path) => ({ path, imports: idx.file(path)!.imports }));
      const r = await fresh(p.root, target, direct, idx.all().map((f) => f.path));
      assert.equal(r.engine, engine);
      const api = r.usages.filter((u: { file: string }) => u.file === "src/routes/api.ts").map((u: { symbol: string; line: number; in: string | null }) => `${u.symbol}:${u.line}:${u.in}`);
      assert.deepEqual(api.sort(), ["createSession:10:quick", "createSession:7:refresh", "destroySession:11:logout", "destroySession:11:logout"].sort());
      assert.ok(r.usages.some((u: { file: string; in: string | null }) => u.file === "src/auth/google.ts" && u.in === "googleLogin"));
      const py = await fresh(p.root, "app/models.py", idx.importers("app/models.py").map((path) => ({ path, imports: idx.file(path)!.imports })), idx.all().map((f) => f.path));
      assert.deepEqual(py.usages.map((u: { symbol: string; line: number; in: string | null }) => `${u.symbol}:${u.line}:${u.in}`), ["save:6:create"]);
      p.close();
    } finally {
      if (prev === undefined) delete process.env.AGENT_STATE_NO_TREE_SITTER;
      else process.env.AGENT_STATE_NO_TREE_SITTER = prev;
      repo.cleanup();
    }
  });
}

test("impact --symbol filters usages and reports the engine", () => {
  const repo = makeRepo(FILES);
  try {
    const out = cli(repo.root, ["init", "--no-hooks"]);
    assert.equal(out.code, 0);
    const r = cli(repo.root, ["impact", "src/auth/session.ts", "--symbol", "destroySession"]);
    assert.match(r.stdout, /Used where \((tree-sitter|built-in parser)\)/);
    assert.match(r.stdout, /destroySession/);
    assert.doesNotMatch(r.stdout.split("Used where")[1]!.split("\n\n")[0]!, /createSession/);
    const j = JSON.parse(cli(repo.root, ["impact", "src/auth/session.ts", "--json"]).stdout);
    assert.ok(j.symbol_usages.length >= 5);
  } finally {
    repo.cleanup();
  }
});
