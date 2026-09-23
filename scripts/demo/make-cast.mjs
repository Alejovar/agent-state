import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const [cwd, outFile] = process.argv.slice(2);
const CLI = new URL("../../dist/cli.js", import.meta.url).pathname;
const W = 120, H = 43;
const events = [];
let t = 0.3;
const emit = (s) => events.push([+t.toFixed(3), "o", s.replace(/\n/g, "\r\n")]);
const wait = (s) => (t += s);
const clear = () => emit("\x1b[2J\x1b[H");
const comment = (s) => { emit(`\x1b[90m# ${s}\x1b[0m\n`); wait(0.9); };
const type = (cmd) => {
  emit("\x1b[32m❯\x1b[0m ");
  wait(0.3);
  for (const ch of cmd) { emit(ch); wait(0.035 + Math.random() * 0.03); }
  wait(0.35);
  emit("\n");
};
const run = (args, { pause = 3, lineDelay = 0.025, filter } = {}) => {
  let out = execFileSync("node", [CLI, ...args], { cwd, encoding: "utf8", env: (({ NO_COLOR, ...e }) => ({ ...e, FORCE_COLOR: "1" }))(process.env) });
  if (filter) out = filter(out);
  // Box-drawing glyph widths vary between viewer fonts; ASCII stays aligned everywhere.
  out = out.replace(/[╭╮╰╯├┤]/g, "+").replace(/─/g, "-").replace(/│/g, "|");
  for (const line of out.replace(/\n$/, "").split("\n")) { emit(line + "\n"); wait(lineDelay); }
  wait(pause);
};

// Scene 1: the moment of truth
clear();
comment("Claude Code has been working on a task for hours. The context window is full…");
comment("agent-state has been recording the useful state through hooks the whole time.");
type("agent-state status");
run(["status"], { pause: 3.2 });

// Scene 2: compaction → verified recovery, injected automatically
clear();
comment("Claude compacts (or you open a new session). This is what gets re-injected:");
type("agent-state recover --raw");
run(["recover", "--raw", "--max-bytes", "1500"], {
  pause: 6,
  lineDelay: 0.03,
  filter: (o) => o.split("\n").filter((l) => !l.includes("<sub>")).join("\n").replace(/\n---\n[\s\S]*$/, "\n").replace(/\n{3,}/g, "\n\n"),
});

// Scene 3: safety
clear();
comment("Before a risky refactor: a checkpoint that never touches your files");
type("agent-state checkpoint before-refactor");
run(["checkpoint", "before-refactor"], { pause: 1.5 });
comment("…the refactor goes wrong. Preview first, restore safely (with automatic backup):");
execFileSync("sh", ["-c", "echo 'export const broken = true;' > src/auth/session.ts && rm src/routes/oauth.ts"], { cwd });
type("agent-state restore before-refactor --dry-run");
run(["restore", "before-refactor", "--dry-run"], { pause: 3.5 });
// Apply the restore off-camera so the next scene analyzes the real module.
execFileSync("node", [CLI, "restore", "before-refactor", "--yes", "--no-backup"], { cwd, stdio: "ignore" });

// Scene 4: understanding
clear();
comment("What breaks if I change the session module?");
type("agent-state impact src/auth/session.ts");
run(["impact", "src/auth/session.ts"], { pause: 4.5 });

clear();
emit("\n\n   \x1b[1magent-state\x1b[0m — lose the session, not the work.\n\n");
emit("   \x1b[36mnpm i -g agent-state && agent-state init --claude\x1b[0m   \x1b[90m(also --cursor, --gemini)\x1b[0m\n\n");
emit("   \x1b[90mgithub.com/Alejovar/agent-state\x1b[0m\n");
wait(4);
emit("");
const header = { version: 2, width: W, height: H, timestamp: Math.floor(Date.now() / 1000), env: { TERM: "xterm-256color", SHELL: "/bin/bash" } };
writeFileSync(outFile, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join("\n") + "\n");
console.log(`cast: ${events.length} events, ${t.toFixed(1)}s`);
