import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { Project } from "../core/project.js";
import { classify, isTestPath, type FileRole } from "../core/classify.js";
import { CODE_LANGS, langOf, parseFile, type Route } from "./parsers.js";
import { Resolver } from "./resolve.js";

const MAX_FILE_BYTES = 1_000_000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".agent-state", "dist", "build", "out", "target", ".next", ".nuxt", "vendor", "__pycache__", ".venv", "venv", ".tox", "coverage", ".cache", ".turbo", ".idea", ".vscode"]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS idx_files (
  path TEXT PRIMARY KEY,
  lang TEXT NOT NULL,
  role TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime REAL NOT NULL,
  hash TEXT NOT NULL,
  imports TEXT NOT NULL,
  symbols TEXT NOT NULL,
  routes TEXT NOT NULL,
  pkg TEXT
);
CREATE TABLE IF NOT EXISTS idx_edges (src TEXT NOT NULL, dst TEXT NOT NULL, PRIMARY KEY (src, dst));
CREATE INDEX IF NOT EXISTS idx_edges_dst ON idx_edges(dst);
`;

export interface IndexedFile {
  path: string;
  lang: string;
  role: FileRole;
  size: number;
  symbols: string[];
  routes: Route[];
  imports: string[];
  pkg: string | null;
}

export interface UpdateStats {
  total: number;
  parsed: number;
  removed: number;
  unchanged: number;
  ms: number;
}

export class ProjectIndex {
  constructor(private readonly project: Project) {
    this.db.exec(SCHEMA);
  }

  private get db() {
    return this.project.db().raw;
  }

  /** Lists project files: git-tracked + untracked-not-ignored, or a filtered walk outside git. */
  listFiles(): string[] {
    const git = this.project.git;
    if (git.isRepo()) {
      const out = git.run(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
      return [...new Set(out.split("\0").filter(Boolean))].filter((p) => !p.startsWith(".agent-state/") && existsSync(join(this.project.root, p)));
    }
    const files: string[] = [];
    const walk = (rel: string): void => {
      const abs = join(this.project.root, rel);
      for (const ent of readdirSync(abs, { withFileTypes: true })) {
        if (ent.name.startsWith(".") && ent.name !== ".github" && ent.name !== ".env.example") continue;
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          if (!SKIP_DIRS.has(ent.name)) walk(r);
        } else if (ent.isFile()) files.push(r);
        if (files.length > 50_000) return;
      }
    };
    walk("");
    return files;
  }

  /** Incremental update: only files whose size/mtime changed are re-read, only changed content is re-parsed. */
  update(): UpdateStats {
    const t0 = Date.now();
    const files = this.listFiles();
    const current = new Set(files);
    const known = new Map<string, { size: number; mtime: number; hash: string }>();
    for (const r of this.db.prepare("SELECT path, size, mtime, hash FROM idx_files").all() as { path: string; size: number; mtime: number; hash: string }[]) {
      known.set(r.path, r);
    }
    let parsed = 0;
    let removed = 0;
    let unchanged = 0;
    const upsert = this.db.prepare(
      `INSERT INTO idx_files (path, lang, role, size, mtime, hash, imports, symbols, routes, pkg) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET lang=excluded.lang, role=excluded.role, size=excluded.size, mtime=excluded.mtime,
       hash=excluded.hash, imports=excluded.imports, symbols=excluded.symbols, routes=excluded.routes, pkg=excluded.pkg`,
    );
    const touchStat = this.db.prepare("UPDATE idx_files SET size = ?, mtime = ? WHERE path = ?");
    const del = this.db.prepare("DELETE FROM idx_files WHERE path = ?");
    let structureChanged = false;
    this.db.exec("BEGIN");
    try {
      for (const path of files) {
        let st;
        try {
          st = statSync(join(this.project.root, path));
        } catch {
          continue;
        }
        const prev = known.get(path);
        if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) {
          unchanged++;
          continue;
        }
        const lang = langOf(path);
        const role = classify(path);
        let content = "";
        let hash = `size:${st.size}`;
        if (st.size <= MAX_FILE_BYTES && (CODE_LANGS.has(lang) || role !== "other")) {
          const buf = readFileSync(join(this.project.root, path));
          hash = createHash("sha1").update(buf).digest("hex").slice(0, 16);
          if (prev && prev.hash === hash) {
            touchStat.run(st.size, st.mtimeMs, path);
            unchanged++;
            continue;
          }
          if (!buf.subarray(0, 8000).includes(0)) content = buf.toString("utf8");
        }
        const res = CODE_LANGS.has(lang) && content ? parseFile(path, content) : { imports: [], symbols: [], routes: [] as Route[] };
        upsert.run(path, lang, role, st.size, st.mtimeMs, hash, JSON.stringify(res.imports), JSON.stringify(res.symbols), JSON.stringify(res.routes), (res as { package?: string }).package ?? null);
        parsed++;
        structureChanged = true;
      }
      for (const path of known.keys()) {
        if (!current.has(path)) {
          del.run(path);
          removed++;
          structureChanged = true;
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    if (structureChanged || (this.db.prepare("SELECT COUNT(*) n FROM idx_edges").get() as { n: number }).n === 0) this.rebuildEdges(files);
    return { total: files.length, parsed, removed, unchanged, ms: Date.now() - t0 };
  }

  /** Resolution depends on the whole file set, so edges are recomputed from stored imports (cheap: no file IO). */
  private rebuildEdges(files: string[]): void {
    const resolver = new Resolver(this.project.root, files);
    const rows = this.db.prepare("SELECT path, lang, imports FROM idx_files WHERE imports != '[]'").all() as { path: string; lang: string; imports: string }[];
    const ins = this.db.prepare("INSERT OR IGNORE INTO idx_edges (src, dst) VALUES (?, ?)");
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM idx_edges");
      for (const r of rows) {
        for (const spec of JSON.parse(r.imports) as string[]) {
          for (const dst of resolver.resolve(r.path, spec, r.lang)) if (dst !== r.path) ins.run(r.path, dst);
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  file(path: string): IndexedFile | null {
    const r = this.db.prepare("SELECT * FROM idx_files WHERE path = ?").get(path) as Record<string, unknown> | undefined;
    return r ? rowToFile(r) : null;
  }

  all(): IndexedFile[] {
    return (this.db.prepare("SELECT * FROM idx_files ORDER BY path").all() as Record<string, unknown>[]).map(rowToFile);
  }

  imports(path: string): string[] {
    return (this.db.prepare("SELECT dst FROM idx_edges WHERE src = ? ORDER BY dst").all(path) as { dst: string }[]).map((r) => r.dst);
  }

  importers(path: string): string[] {
    return (this.db.prepare("SELECT src FROM idx_edges WHERE dst = ? ORDER BY src").all(path) as { src: string }[]).map((r) => r.src);
  }

  /** Breadth-first reverse dependencies with their distance. */
  dependents(path: string, maxDepth = 3): Map<string, number> {
    const dist = new Map<string, number>();
    let frontier = [path];
    for (let d = 1; d <= maxDepth && frontier.length; d++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const imp of this.importers(f)) {
          if (imp === path || dist.has(imp)) continue;
          dist.set(imp, d);
          next.push(imp);
        }
      }
      frontier = next;
    }
    return dist;
  }

  stats(): { files: number; edges: number } {
    const files = (this.db.prepare("SELECT COUNT(*) n FROM idx_files").get() as { n: number }).n;
    const edges = (this.db.prepare("SELECT COUNT(*) n FROM idx_edges").get() as { n: number }).n;
    return { files, edges };
  }

  testsFor(path: string): string[] {
    const tests = new Set<string>();
    for (const [dep] of this.dependents(path, 4)) if (isTestPath(dep)) tests.add(dep);
    const stem = posix.basename(path).replace(/\.[^.]+$/, "").replace(/\.(test|spec)$/, "");
    if (stem.length > 2 && stem !== "index" && stem !== "__init__" && stem !== "mod") {
      for (const f of this.db.prepare("SELECT path FROM idx_files WHERE role = 'test' AND path LIKE ?").all(`%${stem}%`) as { path: string }[]) {
        const b = posix.basename(f.path);
        if (new RegExp(`(^|[._-])${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([._-]|$)`, "i").test(b)) tests.add(f.path);
      }
    }
    return [...tests].sort();
  }
}

function rowToFile(r: Record<string, unknown>): IndexedFile {
  return {
    path: r.path as string,
    lang: r.lang as string,
    role: r.role as FileRole,
    size: r.size as number,
    symbols: JSON.parse(r.symbols as string) as string[],
    routes: JSON.parse(r.routes as string) as Route[],
    imports: JSON.parse(r.imports as string) as string[],
    pkg: (r.pkg as string | null) ?? null,
  };
}
