import { parseArgs, type ParseArgsConfig } from "node:util";

export class UsageError extends Error {}

export interface Command {
  name: string;
  aliases?: string[];
  summary: string;
  usage: string;
  /** Grouping for help output. */
  group: "Core" | "Recovery" | "Checkpoints" | "Intelligence" | "Control" | "Integration";
  run(argv: string[]): Promise<number> | number;
}

export type Options = NonNullable<ParseArgsConfig["options"]>;

export function parse<O extends Options>(argv: string[], options: O, allowPositionals = true) {
  try {
    return parseArgs({ args: argv, options, allowPositionals, strict: true });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

export function out(s = ""): void {
  process.stdout.write(s + "\n");
}

export function err(s = ""): void {
  process.stderr.write(s + "\n");
}

export function json(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}
