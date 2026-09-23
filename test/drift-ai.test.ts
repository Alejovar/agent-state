import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, initProject, AUTH_APP, nodeCommand } from "./helpers.js";
import { ProjectIndex } from "../src/index/indexer.js";
import { overview } from "../src/index/analysis.js";
import { detectDrift } from "../src/core/drift.js";
import { CommandProvider, extractJson, providerFromConfig, AIError } from "../src/ai/provider.js";
import { aiDrift } from "../src/ai/drift.js";
import { aiSummary } from "../src/ai/enhance.js";
import { TaskService } from "../src/core/tasks.js";
import { recoverTask } from "../src/core/compact.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";

test("drift: technology contradiction with competing evidence, missing paths/scripts, package manager", () => {
  const repo = makeRepo({
    ...AUTH_APP,
    "package.json": JSON.stringify({ name: "shop", scripts: { test: "vitest run" }, dependencies: { express: "4", "connect-redis": "7", ioredis: "5" } }),
    "CLAUDE.md": "# Notes\nWe use JWT for authentication.\nWe do not use MongoDB.\nSee `src/auth/jwt.ts` and `src/auth/session.ts`.\nRun `npm run lint` and `npm install`.\n```\nMongoDB example in code block\n```\n",
  });
  try {
    const p = initProject(repo);
    const idx = new ProjectIndex(p);
    idx.update();
    const f = detectDrift(p, idx);
    const tech = f.find((x) => x.kind === "technology" && x.claim.includes("JWT"))!;
    assert.ok(tech, JSON.stringify(f, null, 2));
    assert.match(tech.observed, /server-side sessions/);
    assert.ok(tech.confidence >= 0.9);
    assert.ok(!f.some((x) => x.claim.includes("MongoDB")), "negated and code-block mentions are ignored");
    assert.ok(f.some((x) => x.kind === "missing_path" && x.claim.includes("src/auth/jwt.ts")));
    assert.ok(!f.some((x) => x.claim.includes("src/auth/session.ts")));
    assert.ok(f.some((x) => x.kind === "missing_script" && x.claim.includes("lint")));
    assert.ok(f.some((x) => x.kind === "package_manager" && x.observed.includes("pnpm")));
    // docs/architecture.md claims JWT too.
    assert.ok(f.some((x) => x.doc === "docs/architecture.md" && x.kind === "technology"));
    assert.ok(f.every((x) => x.evidence === "verified"));
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("AI provider abstraction: none, command success, command failure, timeouts", async () => {
  assert.equal(providerFromConfig(DEFAULT_CONFIG.ai), null);
  assert.throws(() => providerFromConfig({ ...DEFAULT_CONFIG.ai, provider: "command" }), AIError);
  assert.throws(() => providerFromConfig({ ...DEFAULT_CONFIG.ai, provider: "openai-compatible" }), AIError);
  const echo = new CommandProvider(nodeCommand("process.stdin.pipe(process.stdout);"), 5000);
  assert.match(await echo.complete("SYS", "hello"), /SYS\s+hello/);
  await assert.rejects(new CommandProvider(nodeCommand("process.exit(3);"), 5000).complete("s", "p"), /exited with 3/);
  await assert.rejects(new CommandProvider(nodeCommand("setTimeout(() => {}, 5000);"), 300).complete("s", "p"), /timed out/);
});

test("extractJson tolerates prose and code fences; rejects garbage", () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"findings":[{"a":"}"}]}\n```'), { findings: [{ a: "}" }] });
  assert.deepEqual(extractJson('prefix {"x": [1,2]} suffix'), { x: [1, 2] });
  assert.equal(extractJson("no json here"), null);
  assert.equal(extractJson("{broken"), null);
});

test("AI features degrade gracefully: malformed output, failing provider, no provider", async () => {
  const repo = makeRepo(AUTH_APP);
  try {
    const p = initProject(repo);
    const idx = new ProjectIndex(p);
    idx.update();
    const ov = overview(p, idx);
    const silence = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      // No provider configured.
      assert.deepEqual(await aiDrift(p, ["docs/architecture.md"], ov, []), []);
      // Malformed provider output.
      p.config.ai.provider = "command";
      p.config.ai.command = nodeCommand("console.log('I think it is fine');");
      assert.deepEqual(await aiDrift(p, ["docs/architecture.md"], ov, []), []);
      // Valid output is parsed, clamped and labelled as AI.
      p.config.ai.command = nodeCommand(`console.log(${JSON.stringify(JSON.stringify({ findings: [{ claim: "uses JWT", observed: "ioredis sessions", confidence: 7, files: ["docs/architecture.md"] }] }))});`);
      const found = await aiDrift(p, ["docs/architecture.md"], ov, []);
      assert.equal(found.length, 1);
      assert.equal(found[0]!.evidence, "ai");
      assert.equal(found[0]!.confidence, 1);
      // Failing provider never breaks recovery.
      const t = new TaskService(p).create("Task");
      const state = recoverTask(p, t).state;
      p.config.ai.command = nodeCommand("process.exit(1);");
      assert.equal(await aiSummary(p, state, "recovery"), null);
      p.config.ai.command = nodeCommand("console.log('Summary: continue with state expiry');");
      const ok = await aiSummary(p, state, "recovery");
      assert.equal(ok!.text, "Summary: continue with state expiry");
      assert.equal(ok!.provider, "command");
    } finally {
      process.stderr.write = silence;
    }
    p.close();
  } finally {
    repo.cleanup();
  }
});

test("drift ignores examples, enumerations, quotes and bare file names", () => {
  const repo = makeRepo({
    ...AUTH_APP,
    "docs/architecture.md": "# Notes\nFor example, a repo that uses MongoDB.\nRedaction covers keys (Stripe, Slack, AWS, Google, npm).\nThe `drift` command flags \"uses JWT\" claims.\nSee `session.ts` for details.\n",
  });
  try {
    const p = initProject(repo);
    const idx = new ProjectIndex(p);
    idx.update();
    assert.deepEqual(detectDrift(p, idx, "docs/architecture.md"), []);
    p.close();
  } finally {
    repo.cleanup();
  }
});
