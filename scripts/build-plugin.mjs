// Generates the Claude Code plugin (plugins/agent-state) from the same source
// of truth used by `agent-state init --claude`, so both stay in sync.
import { mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hookConfig, SLASH_COMMANDS, slashCommandFile } from "../dist/integrations/claude.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = (await import("../package.json", { with: { type: "json" } })).default;
const dir = join(root, "plugins", "agent-state");
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
mkdirSync(join(dir, "hooks"), { recursive: true });
mkdirSync(join(dir, "commands"), { recursive: true });
mkdirSync(join(dir, "bin"), { recursive: true });

writeFileSync(
  join(dir, ".claude-plugin", "plugin.json"),
  JSON.stringify(
    {
      name: "agent-state",
      description: "Never lose a coding session: verified task memory, automatic recovery after compaction, checkpoints, change maps and scope control. Local-first.",
      version: pkg.version,
      author: { name: "Alejovar" },
      homepage: "https://github.com/Alejovar/agent-state",
      repository: "https://github.com/Alejovar/agent-state",
      license: "MIT",
      keywords: ["memory", "context", "recovery", "checkpoint", "handoff"],
    },
    null,
    2,
  ) + "\n",
);

// The wrapper keeps the plugin harmless when the CLI is not installed yet.
writeFileSync(
  join(dir, "bin", "agent-state-hook"),
  `#!/bin/sh
# Forwards Claude Code hook payloads to the agent-state CLI when it is installed.
# Projects without .agent-state/ are ignored by the CLI itself.
if command -v agent-state >/dev/null 2>&1; then
  exec agent-state hook claude-code
fi
exit 0
`,
);
chmodSync(join(dir, "bin", "agent-state-hook"), 0o755);

const hooks = hookConfig("__CMD__");
const json = JSON.stringify({ hooks }, null, 2).replaceAll('"__CMD__ hook claude-code"', '"\\"${CLAUDE_PLUGIN_ROOT}\\"/bin/agent-state-hook"');
writeFileSync(join(dir, "hooks", "hooks.json"), json + "\n");

for (const [name, spec] of Object.entries(SLASH_COMMANDS)) {
  writeFileSync(join(dir, "commands", `${name}.md`), slashCommandFile("agent-state", spec));
}
console.log(`plugin written to ${dir}`);
