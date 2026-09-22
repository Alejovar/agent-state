/** Tiny terminal helpers: colors (respecting NO_COLOR/FORCE_COLOR), boxes, prompts. */
import { createInterface } from "node:readline";

const enabled = (): boolean => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return !!process.stdout.isTTY;
};

const wrap = (open: number, close: number) => (s: string | number): string =>
  enabled() ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** Display width, counting common wide glyphs as 1 (good enough for box drawing). */
export function width(s: string): number {
  return [...s.replace(ANSI, "")].length;
}

export function pad(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - width(s)));
}

export function box(title: string, lines: string[], minWidth = 44): string {
  const inner = Math.max(minWidth, width(title) + 4, ...lines.map((l) => width(l) + 2));
  const top = `╭${"─".repeat(inner)}╮`;
  const t = Math.floor((inner - width(title)) / 2);
  const titleLine = `│${" ".repeat(t)}${c.bold(title)}${" ".repeat(inner - t - width(title))}│`;
  const sep = `├${"─".repeat(inner)}┤`;
  const body = lines.map((l) => `│ ${pad(l, inner - 2)} │`);
  const bottom = `╰${"─".repeat(inner)}╯`;
  return [top, titleLine, sep, ...body, bottom].join("\n");
}

export function heading(s: string): string {
  return c.bold(s);
}

export function kv(key: string, value: string, keyWidth = 14): string {
  return `${c.dim(pad(key, keyWidth))} ${value}`;
}

export function ago(ts: string | null | undefined, now = Date.now()): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(ts)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((res) => rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `, res));
  rl.close();
  const a = answer.trim().toLowerCase();
  if (!a) return defaultYes;
  return a === "y" || a === "yes";
}
