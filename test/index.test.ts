import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, initProject, AUTH_APP } from "./helpers.js";
import { parseFile } from "../src/index/parsers.js";
import { ProjectIndex } from "../src/index/indexer.js";
import { impact, overview, search, expandQuery } from "../src/index/analysis.js";
import { globToRegExp, matchesAny } from "../src/core/glob.js";
import { classify } from "../src/core/classify.js";

test("JS/TS parser: imports, re-exports, requires, symbols, routes; ignores comments", () => {
  const r = parseFile(
    "a.ts",
    `import x from "./x";\nimport type { T } from '../types';\nimport "./side";\nexport * from "./all";\nconst y = require("./y");\nconst z = await import("./z");\n// import nope from "./commented";\n/* import no from "./block" */\nexport async function handler() {}\nexport class Service {}\nexport const VALUE = 1;\nexport { a as b };\napp.get("/users/:id", handler);\nrouter.post('/login', h);\n`,
  );
  assert.deepEqual(r.imports.sort(), ["../types", "./all", "./side", "./x", "./y", "./z"]);
  assert.ok(["handler", "Service", "VALUE", "b"].every((s) => r.symbols.includes(s)));
  assert.deepEqual(r.routes, [{ method: "GET", path: "/users/:id" }, { method: "POST", path: "/login" }]);
});

test("Python, Go and Rust parsers", () => {
  const py = parseFile("app/views.py", `from .models import User, Order\nfrom . import utils\nimport os, app.services.billing as b\n# import commented\n@app.get("/orders")\ndef list_orders():\n    pass\nclass Checkout:\n    pass\n`);
  assert.ok(py.imports.includes(".models") && py.imports.includes(".utils") && py.imports.includes("app.services.billing"));
  assert.deepEqual(py.symbols, ["list_orders", "Checkout"]);
  assert.deepEqual(py.routes, [{ method: "GET", path: "/orders" }]);
  const go = parseFile("cmd/main.go", `package main\nimport (\n  "fmt"\n  "example.com/shop/internal/auth"\n)\nfunc main() {}\nfunc (s *Server) Handle() {}\ntype Server struct{}\nr.GET("/health", h)\n`);
  assert.deepEqual(go.imports, ["fmt", "example.com/shop/internal/auth"]);
  assert.equal(go.package, "main");
  assert.ok(go.symbols.includes("Handle") && go.symbols.includes("Server"));
  const rs = parseFile("src/lib.rs", `mod auth;\npub mod db;\nuse crate::auth::session;\npub fn run() {}\npub struct App;\n#[get("/ping")]\nfn ping() {}\n`);
  assert.deepEqual(rs.imports, ["mod:auth", "mod:db", "crate::auth::session"]);
  assert.deepEqual(rs.routes, [{ method: "GET", path: "/ping" }]);
});

test("index resolves imports (relative, extensionless, .js→.ts, tsconfig paths) and updates incrementally", () => {
  const repo = makeRepo({
    ...AUTH_APP,
    "tsconfig.json": `{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }`,
    "src/routes/admin.ts": `import { requireAuth } from "@/middleware/auth";\nexport const admin = requireAuth;\n`,
  });
  try {
    const p = initProject(repo);
    const idx = new ProjectIndex(p);
    const first = idx.update();
    assert.ok(first.parsed >= 10);
    assert.deepEqual(idx.imports("src/auth/google.ts"), ["src/auth/session.ts"], ".js specifier resolves to .ts");
    assert.deepEqual(idx.importers("src/middleware/auth.ts"), ["src/routes/admin.ts", "src/routes/private.ts"]);
    const second = idx.update();
    assert.equal(second.parsed, 0, "nothing re-parsed when nothing changed");
    repo.write("src/auth/token.ts", `import { createSession } from "./session";\nexport const t = createSession;\n`);
    rmSync(join(repo.root, "src/routes/login.ts"));
    const third = idx.update();
    assert.equal(third.parsed, 1);
    assert.equal(third.removed, 1);
    assert.ok(idx.importers("src/auth/session.ts").includes("src/auth/token.ts"));
    assert.ok(!idx.importers("src/auth/google.ts").includes("src/routes/login.ts"));
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("impact analysis: transitive importers, tests, routes, areas", () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    const idx = new ProjectIndex(p);
    idx.update();
    const r = impact(p, idx, "src/auth/session.ts");
    const users = Object.fromEntries(r.used_by.map((u) => [u.path, u.depth]));
    assert.equal(users["src/middleware/auth.ts"], 1);
    assert.equal(users["src/auth/google.ts"], 1);
    assert.equal(users["src/routes/private.ts"], 2);
    assert.equal(users["src/index.ts"], 3);
    assert.deepEqual(r.tests, ["tests/auth/session.test.ts"]);
    assert.ok(r.routes.some((x) => x.path === "/account"));
    assert.ok(r.areas.includes("auth"));
    assert.ok(r.symbols.includes("createSession"));
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("overview and concept search", () => {
  const repo = makeRepo({ ...AUTH_APP, "docker-compose.yml": "services:\n  api:\n    build: .\n  redis:\n    image: redis\n" });
  try {
    const p = initProject(repo);
    const idx = new ProjectIndex(p);
    idx.update();
    const ov = overview(p, idx);
    assert.equal(ov.languages[0]!.lang, "typescript");
    assert.ok(ov.frameworks.includes("Express") && ov.frameworks.includes("Vitest"));
    assert.ok(ov.databases.includes("Redis"));
    assert.ok(ov.entrypoints.includes("src/index.ts"));
    assert.ok(ov.services.some((s) => s.startsWith("redis")));
    assert.ok(ov.apis.some((a) => a.method === "POST" && a.path === "/login"));
    assert.ok(expandQuery("authentication").includes("session"));
    const hits = search(idx, "authentication");
    assert.ok(hits.slice(0, 4).some((h) => h.path === "src/auth/session.ts"), JSON.stringify(hits.slice(0, 5)));
    assert.equal(search(idx, "zzzz-nothing").length, 0);
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("globs and path classification", () => {
  assert.ok(globToRegExp("src/auth/**").test("src/auth/a/b.ts"));
  assert.ok(globToRegExp("src/auth/**").test("src/auth/x.ts"));
  assert.ok(!globToRegExp("src/auth/**").test("src/authz/x.ts"));
  assert.ok(globToRegExp("**/*.test.ts").test("a/b/c.test.ts"));
  assert.ok(globToRegExp("**/*.test.ts").test("c.test.ts"));
  assert.ok(globToRegExp("database").test("database/schema.sql"));
  assert.ok(globToRegExp("*.{yml,yaml}").test("compose.yaml"));
  assert.equal(matchesAny("infra/main.tf", ["src/**", "infra/**"]), "infra/**");
  assert.equal(classify("tests/auth/google.test.ts"), "test");
  assert.equal(classify("package.json"), "dependency");
  assert.equal(classify("docker-compose.yml"), "infrastructure");
  assert.equal(classify(".env.example"), "config");
  assert.equal(classify("docs/architecture.md"), "documentation");
  assert.equal(classify("src/auth/session.ts"), "source");
});

test("scope globs follow .gitignore conventions", () => {
  const cases: [string, string, boolean][] = [
    ["/src/**", "src/a.ts", true],
    ["src\\auth\\**", "src/auth/x.ts", true],
    ["*.md", "docs/x.md", true],
    ["/*.md", "docs/x.md", false],
    ["/*.md", "README.md", true],
    ["database", "database/schema.sql", true],
    ["database", "src/database/x.ts", true],
    ["database", "databases/x.ts", false],
    ["src/auth/", "src/authz/x.ts", false],
    [".env", "config/.env", true],
  ];
  for (const [g, p, want] of cases) assert.equal(globToRegExp(g).test(p), want, `${g} vs ${p}`);
});

test("python docstrings are not imports; a symlinked directory doesn't break indexing", async () => {
  const py = parseFile("pkg/m.py", 'from .. import util\n"""\nimport fake_in_docstring\n"""\nimport real\n');
  assert.deepEqual(py.imports.sort(), ["..util", "real"]);
  const { symlinkSync } = await import("node:fs");
  const repo = makeRepo({ "src/a.ts": "export const a = 1;\n", "vendor/lib/x.ts": "export {}\n" });
  try {
    if (process.platform !== "win32") {
      symlinkSync("vendor/lib", join(repo.root, "linked.ts"));
      repo.commit("symlink");
    }
    const p = initProject(repo);
    const idx = new ProjectIndex(p);
    assert.doesNotThrow(() => idx.update());
    assert.ok(idx.file("src/a.ts"));
    p.close();
  } finally {
    repo.cleanup();
  }
});
