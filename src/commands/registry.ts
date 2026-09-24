import type { Command } from "./types.js";
import { init, status, rebuild, doctor, uninstall } from "./core.js";
import { task, note, decide } from "./task.js";
import { compact, recover, handoff, cont, adaptersCmd } from "./recovery.js";
import { checkpoint, checkpoints, restore } from "./checkpoints.js";
import { changes } from "./changes.js";
import { index, impactCmd } from "./intelligence.js";
import { hook, event, integrate } from "./hook.js";
import { history, decisions, why } from "./history.js";
import { scope } from "./scope.js";
import { review } from "./review.js";
import { share, team } from "./team.js";
import { drift } from "./drift.js";
import { replay, sessionsCmd, worktrees } from "./replay.js";

export const COMMANDS: Command[] = [
  init,
  status,
  task,
  changes,
  review,
  impactCmd,
  index,
  checkpoint,
  checkpoints,
  restore,
  compact,
  recover,
  cont,
  handoff,
  note,
  decide,
  history,
  decisions,
  why,
  drift,
  replay,
  sessionsCmd,
  worktrees,
  scope,
  integrate,
  share,
  team,
  hook,
  event,
  adaptersCmd,
  rebuild,
  doctor,
  uninstall,
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}
