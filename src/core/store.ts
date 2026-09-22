import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { newId, nowIso } from "./ids.js";
import type { AgentEvent, EventType } from "./events.js";
import { Redactor } from "./redact.js";
import { openDb, type Db } from "./db.js";
import type { ProjectPaths } from "./paths.js";

export interface EmitInput {
  type: EventType;
  agent_id?: string;
  session_id?: string | null;
  task_id?: string | null;
  parent_task_id?: string | null;
  payload?: Record<string, unknown>;
  ts?: string;
}

/**
 * Append-only JSONL event log (source of truth) plus a SQLite projection that
 * is updated lazily and can always be rebuilt from the log.
 *
 * Hooks only append; they never touch SQLite. That keeps them fast and safe
 * when an agent runs tools in parallel.
 */
export class EventStore {
  private db: Db | null = null;

  constructor(
    readonly paths: ProjectPaths,
    private readonly redactor: Redactor,
  ) {}

  private fileFor(sessionId: string | null): string {
    const name = sessionId ? sessionId.replace(/[^A-Za-z0-9_.-]/g, "_") : "_project";
    return join(this.paths.events, `${name}.jsonl`);
  }

  append(input: EmitInput): AgentEvent {
    const id = newId("evt");
    const event: AgentEvent = {
      v: 1,
      id,
      ts: input.ts ?? nowIso(),
      type: input.type,
      agent_id: input.agent_id ?? "cli",
      session_id: input.session_id ?? null,
      task_id: input.task_id ?? null,
      ...(input.parent_task_id ? { parent_task_id: input.parent_task_id } : {}),
      payload: this.redactor.redactValue(input.payload ?? {}),
    };
    mkdirSync(this.paths.events, { recursive: true });
    // One write() per event; O_APPEND keeps concurrent writers from interleaving lines.
    appendFileSync(this.fileFor(event.session_id), JSON.stringify(event) + "\n");
    return event;
  }

  /** Opens the projection and ingests any events appended since the last sync. */
  sync(): Db {
    if (!this.db) this.db = openDb(this.paths.db);
    const db = this.db;
    if (!existsSync(this.paths.events)) return db;
    const offsets = db.getOffsets();
    const files = readdirSync(this.paths.events).filter((f) => f.endsWith(".jsonl"));
    const batch: AgentEvent[] = [];
    const newOffsets: Record<string, number> = {};
    for (const f of files) {
      const full = join(this.paths.events, f);
      const start = offsets[f] ?? 0;
      const { events, end } = readFrom(full, start);
      if (end !== start) newOffsets[f] = end;
      batch.push(...events);
    }
    if (batch.length || Object.keys(newOffsets).length) db.ingest(batch, newOffsets);
    return db;
  }

  /** Drops the projection and rebuilds it from the event log. */
  rebuild(): number {
    this.close();
    this.db = openDb(this.paths.db);
    this.db.reset();
    this.sync();
    return this.db.count();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

/** Reads complete JSONL lines starting at a byte offset. A trailing partial line is left for later. */
function readFrom(file: string, start: number): { events: AgentEvent[]; end: number } {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= start) return { events: [], end: size < start ? 0 : start };
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return { events: [], end: start };
    const text = buf.subarray(0, lastNl).toString("utf8");
    const events: AgentEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as AgentEvent);
      } catch {
        // A corrupted line must not poison the whole log.
      }
    }
    return { events, end: start + lastNl + 1 };
  } finally {
    closeSync(fd);
  }
}

// ---- small JSON helpers shared by stateful modules ----

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Atomic write via rename so readers never observe half-written files. */
export function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

export function writeText(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
