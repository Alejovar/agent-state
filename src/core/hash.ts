import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Short content hash of a file, or null if it cannot be read (missing/deleted). */
export function hashFile(path: string): string | null {
  try {
    return createHash("sha1").update(readFileSync(path)).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}
