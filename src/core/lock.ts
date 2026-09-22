import { closeSync, openSync, rmSync, statSync, writeSync } from "node:fs";

/**
 * Cross-process mutex using an exclusively-created lock file. Used for the few
 * read-modify-write operations (task numbering, current pointer) that hooks can
 * race on. Stale locks (older than `staleMs`) are broken.
 */
export function withLock<T>(path: string, fn: () => T, { timeoutMs = 5000, staleMs = 15000 } = {}): T {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) rmSync(path, { force: true });
      } catch {
        // Lock vanished between checks; retry.
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${path}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(path, { force: true });
  }
}
