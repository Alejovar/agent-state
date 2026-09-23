// Builds the README demo as a story: work → context fills up → new session
// recovers everything → inspect. Claude Code screens are a re-creation (styled
// after its UI); every agent-state output shown is produced by the real CLI.
import { execFileSync } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const [cwd, outFile] = process.argv.slice(2);
const CLI = new URL("../../dist/cli.js", import.meta.url).pathname;
const W = 92, H = 30;
const events = [];
let t = 0.2;
const emit = (s) => events.push([+t.toFixed(3), "o", s.replace(/\n/g, "\r\n")]);
const wait = (s) => (t += s);

const C = { dim: "\x1b[90m", b: "\x1b[1m", g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", c: "\x1b[36m", m: "\x1b[35m", o: "\x1b[38;5;173m", x: "\x1b[0m" };
const clear = () => emit("\x1b[2J\x1b[H");
const line = (s = "", pause = 0.12) => { emit(s + "\n"); wait(pause); };
const title = (n, text, sub) => {
  clear();
  line();
  line(`  ${C.b}${C.c}${n}${C.x}  ${C.b}${text}${C.x}`, 0.2);
  if (sub) line(`     ${C.dim}${sub}${C.x}`, 0.2);
  line("", 0.9);
};
const typeln = (prefix, text, speed = 0.035) => {
  emit(prefix);
  for (const ch of text) { emit(ch); wait(speed + Math.random() * 0.02); }
  wait(0.3);
  emit("\n");
};
const real = (args, filter) => {
  const env = { ...process.env, FORCE_COLOR: "1", COLUMNS: String(W) };
  delete env.NO_COLOR;
  let out = execFileSync("node", [CLI, ...args], { cwd, encoding: "utf8", env });
  if (filter) out = filter(out);
  return out.replace(/[╭╮╰╯├┤]/g, "+").replace(/─/g, "-").replace(/│/g, "|").replace(/\n$/, "");
};
// Sends a real Claude Code hook payload to agent-state and returns its stdout.
const hook = (payload) =>
  execFileSync("node", [CLI, "hook", "claude-code"], {
    cwd,
    input: JSON.stringify({ session_id: "7f3a9c-resumed", cwd, ...payload }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
const print = (text, delay = 0.035, indent = "") => {
  for (const l of text.split("\n")) { emit(indent + l + "\n"); wait(delay); }
};
// Claude Code-style blocks (re-creation)
const user = (text) => { emit(`${C.dim}╭${"─".repeat(W - 4)}╮${C.x}\n`); typeln(`${C.dim}│${C.x} ${C.b}>${C.x} `, text); emit(`${C.dim}╰${"─".repeat(W - 4)}╯${C.x}\n`); wait(0.6); };
const tool = (name, arg, result, pause = 0.7) => {
  line(`${C.g}●${C.x} ${C.b}${name}${C.x}(${arg})`, 0.35);
  if (result) line(`  ${C.dim}⎿${C.x}  ${result}`, pause);
};
const say = (text, pause = 0.8) => line(`${C.o}●${C.x} ${text}`, pause);
const note = (text, pause = 0.8) => line(`  ${C.m}◆ agent-state:${C.x} ${C.dim}${text}${C.x}`, pause);

// ---------------------------------------------------------------- 1. work
title("1", "You work with Claude Code as usual", "agent-state records each step quietly through Claude Code's hooks");
user("Add Google OAuth login using our existing Redis sessions");
tool("Write", "src/auth/oauth.ts", "Created 12 lines", 0.4);
note("file created · recorded");
tool("Update", "src/auth/session.ts", "Added OAUTH_STATE_TTL", 0.4);
note("file modified · recorded");
tool("Bash", "npm test", `${C.r}1 failed${C.x}, 22 passed`, 0.4);
note("test run: FAILED (1/23) · recorded");
tool("Update Todos", "", "", 0.2);
line(`  ${C.dim}⎿${C.x}  ${C.g}☒${C.x} Google provider + callback   ${C.g}☒${C.x} Store OAuth state in Redis`, 0.15);
line(`     ${C.y}◻${C.x} Handle expired OAuth state    ◻ Integration tests`, 0.5);
note("task list · recorded", 0.4);
say(`We decided to ${C.b}reuse Redis sessions instead of JWT${C.x} — signed cookies broke on Safari.`, 0.3);
note("decision + failed approach · recorded", 3.2);

// ---------------------------------------------------------------- 2. context fills up
title("2", "Hours later, the context window is full", "Claude compacts its memory. Normally, details get lost here.");
line(`${C.y}⚠${C.x}  Context left until auto-compact: ${C.b}6%${C.x}`, 1.0);
const msg = real(["compact"], (o) => {
  const saved = /Saved: (\S+)/.exec(o.replace(/\x1b\[[0-9;]*m/g, ""))?.[1] ?? ".agent-state/recovery/task-1.md";
  return `recovery state saved → ${saved}`;
});
note(msg, 1.2);
line(`${C.dim}✻ Compacting conversation…${C.x}`, 1.4);
line();
line(`${C.dim}Without agent-state, the new context is just a lossy summary:${C.x}`, 0.2);
line(`${C.dim}  what was decided? what already failed? which test is broken? what's next?${C.x}`, 3.4);

// ---------------------------------------------------------------- 3. recovery
title("3", "The next session starts with everything it needs", "agent-state injects this automatically (real output, verified against git):");
// The exact text the SessionStart hook hands to Claude after compaction.
const injected = hook({ hook_event_name: "SessionStart", source: "compact" });
const keep = ["# RECOVERY", "**Objective", "## Next", "## In progress", "## Pending", "## Known issues", "## Important decisions", "## Failed approaches"];
const recovery = (() => {
  const out = [];
  let on = false;
  for (const l of injected.split("\n")) {
    if (l.startsWith("#") || l.startsWith("**")) on = keep.some((k) => l.startsWith(k));
    if (on && !l.includes("<sub>") && l.trim()) out.push(l.startsWith("##") ? `${C.c}${l}${C.x}` : l);
  }
  return out.join("\n");
})();
print(recovery, 0.06, "  ");
wait(4.5);

title("3", "…and Claude simply continues", "No re-explaining. Decisions and failed approaches are respected.");
user("continue");
hook({ hook_event_name: "UserPromptSubmit", prompt: "continue" });
say(`Resuming task #1. Next step: ${C.b}handle expired OAuth state${C.x}.`, 0.5);
say(`Keeping Redis sessions (decision #1) — not retrying signed cookies (failed on Safari).`, 0.6);
tool("Update", "src/auth/oauth.ts", "Reject callbacks whose state expired (TTL 600 s)", 0.5);
appendFileSync(join(cwd, "src/auth/oauth.ts"), "export const isExpired = (ts: number) => Date.now() - ts > 600_000;\n");
hook({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "e9", tool_input: { file_path: join(cwd, "src/auth/oauth.ts") }, tool_response: {} });
hook({ hook_event_name: "PostToolUse", tool_name: "TodoWrite", tool_use_id: "t9", tool_input: { todos: [
  { content: "Google provider + callback route", status: "completed" },
  { content: "Store OAuth state in Redis", status: "completed" },
  { content: "Handle expired OAuth state", status: "completed" },
  { content: "Integration tests", status: "in_progress" } ] } });
tool("Bash", "npm test", `${C.g}23 passed${C.x}`, 3.4);
hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b9", tool_input: { command: "npm test" } });
hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "b9", tool_input: { command: "npm test" }, tool_response: { stdout: "Tests  23 passed (23)" } });

// ---------------------------------------------------------------- 4. inspect
title("4", "You can always see where things stand", "and create safe checkpoints, check impact, search history…");
typeln(`${C.g}❯${C.x} `, "agent-state status");
print(real(["status"]), 0.03);
wait(4);

// ---------------------------------------------------------------- end card
clear();
line("\n\n");
line(`   ${C.b}agent-state${C.x} — lose the session, not the work.`, 0.3);
line();
line(`   ${C.c}agent-state init --claude${C.x}   ${C.dim}(or --cursor, --gemini) — then just keep working${C.x}`, 0.3);
line();
line(`   ${C.dim}github.com/Alejovar/agent-state${C.x}`, 4.5);
emit("");

const header = { version: 2, width: W, height: H, timestamp: Math.floor(Date.now() / 1000), env: { TERM: "xterm-256color", SHELL: "/bin/bash" } };
writeFileSync(outFile, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join("\n") + "\n");
console.log(`cast: ${events.length} events, ${t.toFixed(1)}s`);
