import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

let lastTime = 0;
let counter = 0;

function encode(n: number, len: number): string {
  let s = "";
  let v = n;
  for (let i = 0; i < len; i++) {
    s = ALPHABET[v % 32] + s;
    v = Math.floor(v / 32);
  }
  return s;
}

/**
 * Time-sortable, collision-resistant identifier: `<prefix>_<time><seq><random>`.
 * Monotonic within a process: ids created in the same millisecond still sort in
 * creation order, so causally ordered events (task created → task activated)
 * never swap places.
 */
export function newId(prefix: string, now: number = Date.now()): string {
  if (now <= lastTime) {
    now = lastTime;
    counter++;
  } else {
    lastTime = now;
    counter = 0;
  }
  const bytes = randomBytes(6);
  let rand = "";
  for (const b of bytes) rand += ALPHABET[b % 32];
  return `${prefix}_${encode(now, 9)}${encode(counter, 3)}${rand}`;
}

/** Monotonic ISO timestamp paired with newId's clock. */
export function nowIso(): string {
  return new Date(Math.max(Date.now(), lastTime)).toISOString();
}

/** Converts a session index within a task (0, 1, 2…) to a letter suffix (A, B, … Z, AA …). */
export function sessionLetter(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}
