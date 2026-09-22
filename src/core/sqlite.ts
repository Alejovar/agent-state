import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const require = createRequire(import.meta.url);

let loaded: typeof DatabaseSyncType | null = null;

/**
 * Loads node:sqlite lazily and silences its one-time ExperimentalWarning so CLI
 * and hook output stays clean. Other warnings are left untouched.
 */
export function sqlite(): typeof DatabaseSyncType {
  if (loaded) return loaded;
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === "string" ? warning : warning?.message;
    if (msg && msg.includes("SQLite")) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    loaded = (require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType }).DatabaseSync;
  } finally {
    process.emitWarning = original;
  }
  return loaded;
}
