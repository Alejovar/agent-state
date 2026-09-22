/** Recognizes test commands and extracts pass/fail counts from their output. Deterministic. */

const RUNNERS: [string, RegExp][] = [
  ["vitest", /\bvitest\b/],
  ["jest", /\bjest\b/],
  ["mocha", /\bmocha\b/],
  ["playwright", /\bplaywright\s+test\b/],
  ["cypress", /\bcypress\s+run\b/],
  ["node:test", /\bnode\b[^|;&]*\s--test\b/],
  ["bun", /\bbun\s+test\b/],
  ["deno", /\bdeno\s+test\b/],
  ["pytest", /\b(?:pytest|py\.test)\b|python3?\s+-m\s+pytest\b/],
  ["unittest", /python3?\s+-m\s+unittest\b/],
  ["tox", /\btox\b/],
  ["go", /\bgo\s+test\b/],
  ["cargo", /\bcargo\s+(?:test|nextest)\b/],
  ["rspec", /\brspec\b/],
  ["rails", /\brails\s+test\b/],
  ["phpunit", /\bphpunit\b/],
  ["dotnet", /\bdotnet\s+test\b/],
  ["gradle", /\bgradlew?\b[^|;&]*\btest\b/],
  ["maven", /\bmvnw?\b[^|;&]*\btest\b/],
  ["mix", /\bmix\s+test\b/],
  ["swift", /\bswift\s+test\b/],
  ["make", /\bmake\s+(?:test|check)\b/],
  ["npm", /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w:-]+)?\b/],
];

export function detectTestRunner(command: string, extra: string[] = []): string | null {
  for (const [name, re] of RUNNERS) if (re.test(command)) return name;
  for (const src of extra) {
    try {
      if (new RegExp(src).test(command)) return "custom";
    } catch {
      // ignore invalid user regex
    }
  }
  return null;
}

export interface TestCounts {
  passed: number | null;
  failed: number | null;
  skipped: number | null;
}

/** Best-effort parse of common test-runner summaries. Returns nulls when unknown. */
export function parseTestOutput(output: string): TestCounts {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  let passed: number | null = null;
  let failed: number | null = null;
  let skipped: number | null = null;
  const num = (re: RegExp): number | null => {
    let last: number | null = null;
    for (const m of text.matchAll(re)) last = Number(m[1]);
    return last;
  };
  // jest: "Tests:       1 failed, 22 passed, 23 total"; vitest: "Tests  2 failed | 21 passed (23)"
  const jest = /Tests:?\s+(.*)/g;
  for (const m of text.matchAll(jest)) {
    const line = m[1] ?? "";
    const p = /(\d+)\s+passed/.exec(line);
    const f = /(\d+)\s+failed/.exec(line);
    const s = /(\d+)\s+(?:skipped|todo|pending)/.exec(line);
    if (p || f) {
      passed = p ? Number(p[1]) : 0;
      failed = f ? Number(f[1]) : 0;
      skipped = s ? Number(s[1]) : skipped;
    }
  }
  if (passed === null && failed === null) {
    // pytest: "=== 3 failed, 20 passed, 1 skipped in 1.2s ==="
    const py = /=+\s*(.*?\b(?:passed|failed|error)\b.*?)\s+in\s+[\d.]+s/g;
    for (const m of text.matchAll(py)) {
      const line = m[1] ?? "";
      passed = Number(/(\d+) passed/.exec(line)?.[1] ?? 0);
      failed = Number(/(\d+) failed/.exec(line)?.[1] ?? 0) + Number(/(\d+) errors?/.exec(line)?.[1] ?? 0);
      skipped = Number(/(\d+) skipped/.exec(line)?.[1] ?? 0);
    }
  }
  if (passed === null && failed === null) {
    // node:test / tap: "# pass 12" "# fail 0"
    passed = num(/^#\s*pass\s+(\d+)/gm) ?? num(/^ℹ\s*pass\s+(\d+)/gm);
    failed = num(/^#\s*fail\s+(\d+)/gm) ?? num(/^ℹ\s*fail\s+(\d+)/gm);
    skipped = num(/^#\s*skip\s+(\d+)/gm) ?? num(/^ℹ\s*skipped\s+(\d+)/gm);
  }
  if (passed === null && failed === null) {
    // cargo: "test result: ok. 12 passed; 0 failed; 1 ignored"
    const cargo = [...text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
    if (cargo.length) {
      passed = cargo.reduce((a, m) => a + Number(m[1]), 0);
      failed = cargo.reduce((a, m) => a + Number(m[2]), 0);
      skipped = cargo.reduce((a, m) => a + Number(m[3]), 0);
    }
  }
  if (passed === null && failed === null) {
    // go: count "--- FAIL" / "--- PASS" lines; "ok  pkg" / "FAIL pkg"
    const gp = [...text.matchAll(/^\s*--- PASS/gm)].length;
    const gf = [...text.matchAll(/^\s*--- FAIL/gm)].length;
    if (gp || gf) (passed = gp), (failed = gf);
  }
  if (passed === null && failed === null) {
    // mocha: "  12 passing" "  2 failing"; rspec: "10 examples, 2 failures"
    const mp = num(/(\d+) passing/g);
    const mf = num(/(\d+) failing/g);
    if (mp !== null || mf !== null) (passed = mp ?? 0), (failed = mf ?? 0);
    const rs = /(\d+) examples?, (\d+) failures?/.exec(text);
    if (rs) (passed = Number(rs[1]) - Number(rs[2])), (failed = Number(rs[2]));
  }
  return { passed, failed, skipped };
}

/** Heuristic success from output when no exit code is available. */
export function outputLooksFailed(output: string): boolean | null {
  const c = parseTestOutput(output);
  if (c.failed !== null) return c.failed > 0;
  if (/\b(FAIL|FAILED|Error:|failures?:\s*[1-9])\b/.test(output)) return true;
  return null;
}
