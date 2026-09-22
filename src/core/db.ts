import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sqlite } from "./sqlite.js";
import type { AgentEvent, EventType } from "./events.js";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT,
  task_id TEXT,
  parent_task_id TEXT,
  path TEXT,
  text TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id, ts);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS events_type ON events(type, ts);
CREATE INDEX IF NOT EXISTS events_path ON events(path);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
`;

export interface EventQuery {
  task_id?: string;
  session_id?: string;
  types?: EventType[];
  path?: string;
  text?: string;
  since?: string;
  until?: string;
  limit?: number;
  order?: "asc" | "desc";
}

export class Db {
  constructor(readonly raw: DatabaseSync) {}

  getOffsets(): Record<string, number> {
    const row = this.raw.prepare("SELECT value FROM meta WHERE key = 'offsets'").get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Record<string, number>) : {};
  }

  ingest(events: AgentEvent[], offsets: Record<string, number>): void {
    const insert = this.raw.prepare(
      `INSERT OR IGNORE INTO events (id, ts, type, agent_id, session_id, task_id, parent_task_id, path, text, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      for (const e of events) {
        const payload = JSON.stringify(e.payload ?? {});
        const path = typeof e.payload?.path === "string" ? (e.payload.path as string) : null;
        insert.run(
          e.id,
          e.ts,
          e.type,
          e.agent_id,
          e.session_id,
          e.task_id,
          e.parent_task_id ?? null,
          path,
          searchableText(e).toLowerCase(),
          payload,
        );
      }
      const merged = { ...this.getOffsets(), ...offsets };
      this.raw
        .prepare("INSERT INTO meta (key, value) VALUES ('offsets', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(JSON.stringify(merged));
      this.raw.exec("COMMIT");
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  query(q: EventQuery = {}): AgentEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.task_id) (where.push("task_id = ?"), args.push(q.task_id));
    if (q.session_id) (where.push("session_id = ?"), args.push(q.session_id));
    if (q.types?.length) (where.push(`type IN (${q.types.map(() => "?").join(",")})`), args.push(...q.types));
    if (q.path) (where.push("(path = ? OR text LIKE ?)"), args.push(q.path, `%${q.path.toLowerCase()}%`));
    if (q.text) {
      for (const word of q.text.toLowerCase().split(/\s+/).filter(Boolean)) {
        where.push("text LIKE ?");
        args.push(`%${word}%`);
      }
    }
    if (q.since) (where.push("ts >= ?"), args.push(q.since));
    if (q.until) (where.push("ts <= ?"), args.push(q.until));
    const sql =
      `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ` +
      `ORDER BY ts ${q.order === "desc" ? "DESC" : "ASC"}, id ${q.order === "desc" ? "DESC" : "ASC"}` +
      (q.limit ? ` LIMIT ${Math.max(1, Math.floor(q.limit))}` : "");
    const rows = this.raw.prepare(sql).all(...args) as unknown as EventRow[];
    return rows.map(rowToEvent);
  }

  count(): number {
    return (this.raw.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  }

  reset(): void {
    this.raw.exec("DELETE FROM events; DELETE FROM meta WHERE key = 'offsets';");
  }

  close(): void {
    this.raw.close();
  }
}

interface EventRow {
  id: string;
  ts: string;
  type: EventType;
  agent_id: string;
  session_id: string | null;
  task_id: string | null;
  parent_task_id: string | null;
  payload: string;
}

function rowToEvent(r: EventRow): AgentEvent {
  return {
    v: 1,
    id: r.id,
    ts: r.ts,
    type: r.type,
    agent_id: r.agent_id,
    session_id: r.session_id,
    task_id: r.task_id,
    ...(r.parent_task_id ? { parent_task_id: r.parent_task_id } : {}),
    payload: JSON.parse(r.payload) as Record<string, unknown>,
  };
}

function searchableText(e: AgentEvent): string {
  const parts: string[] = [e.type];
  const walk = (v: unknown): void => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(e.payload);
  return parts.join(" ").slice(0, 20_000);
}

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const DatabaseSync = sqlite();
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  raw.exec(SCHEMA);
  const v = raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  if (!v) raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  return new Db(raw);
}
