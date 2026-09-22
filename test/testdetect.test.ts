import { test } from "node:test";
import assert from "node:assert/strict";
import { detectTestRunner, parseTestOutput } from "../src/core/testdetect.js";

test("detects common test runners", () => {
  assert.equal(detectTestRunner("npm test"), "npm");
  assert.equal(detectTestRunner("pnpm run test:unit"), "npm");
  assert.equal(detectTestRunner("npx vitest run src"), "vitest");
  assert.equal(detectTestRunner("python -m pytest -q tests/"), "pytest");
  assert.equal(detectTestRunner("go test ./..."), "go");
  assert.equal(detectTestRunner("cargo test --all"), "cargo");
  assert.equal(detectTestRunner("node --test dist/"), "node:test");
  assert.equal(detectTestRunner("npm run build"), null);
  assert.equal(detectTestRunner("ls tests/"), null);
  assert.equal(detectTestRunner("./scripts/check.sh", ["check\\.sh"]), "custom");
});

test("parses jest/vitest summaries", () => {
  assert.deepEqual(parseTestOutput("Tests:       1 failed, 22 passed, 23 total"), { passed: 22, failed: 1, skipped: null });
  const v = parseTestOutput(" Tests  2 failed | 21 passed | 1 skipped (24)");
  assert.equal(v.failed, 2);
  assert.equal(v.passed, 21);
});

test("parses pytest, cargo, go, mocha, node:test", () => {
  assert.deepEqual(parseTestOutput("===== 3 failed, 20 passed, 1 skipped in 1.23s ====="), { passed: 20, failed: 3, skipped: 1 });
  assert.deepEqual(parseTestOutput("test result: ok. 12 passed; 0 failed; 1 ignored; 0 measured"), { passed: 12, failed: 0, skipped: 1 });
  const go = parseTestOutput("--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)\n--- PASS: TestC\nFAIL");
  assert.equal(go.passed, 2);
  assert.equal(go.failed, 1);
  assert.equal(parseTestOutput("  10 passing (20ms)\n  2 failing").failed, 2);
  const nt = parseTestOutput("# tests 5\n# pass 4\n# fail 1\n");
  assert.equal(nt.passed, 4);
  assert.equal(nt.failed, 1);
  assert.deepEqual(parseTestOutput("nothing here"), { passed: null, failed: null, skipped: null });
});
