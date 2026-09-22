import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import YAML from "yaml";
import type { Project } from "../core/project.js";
import { parseManifest } from "../core/deps.js";
import type { IndexedFile, ProjectIndex } from "./indexer.js";
import type { Route } from "./parsers.js";

// ---------------------------------------------------------------------------
// Project overview
// ---------------------------------------------------------------------------

const FRAMEWORKS: [string, RegExp][] = [
  ["Next.js", /^next$/], ["React", /^react$/], ["Vue", /^vue$/], ["Nuxt", /^nuxt$/], ["Svelte", /^svelte$/], ["SvelteKit", /^@sveltejs\/kit$/],
  ["Angular", /^@angular\/core$/], ["Astro", /^astro$/], ["Remix", /^@remix-run\//], ["Express", /^express$/], ["Fastify", /^fastify$/],
  ["NestJS", /^@nestjs\/core$/], ["Koa", /^koa$/], ["Hono", /^hono$/], ["Electron", /^electron$/], ["tRPC", /^@trpc\/server$/],
  ["GraphQL", /^(graphql|@apollo\/server|apollo-server)$/], ["Django", /^django$/], ["Flask", /^flask$/], ["FastAPI", /^fastapi$/],
  ["Rails", /^rails$/], ["Sinatra", /^sinatra$/], ["Laravel", /^laravel\/framework$/], ["Symfony", /^symfony\//],
  ["Gin", /gin-gonic\/gin$/], ["Echo", /labstack\/echo/], ["Fiber", /gofiber\/fiber/], ["Chi", /go-chi\/chi/],
  ["Actix", /^actix-web$/], ["Axum", /^axum$/], ["Rocket", /^rocket$/], ["Tokio", /^tokio$/],
  ["Jest", /^jest$/], ["Vitest", /^vitest$/], ["Playwright", /^@playwright\/test$/], ["pytest", /^pytest$/],
];

const DATABASES: [string, RegExp][] = [
  ["PostgreSQL", /^(pg|postgres|psycopg2?(-binary)?|asyncpg|github\.com\/lib\/pq|github\.com\/jackc\/pgx.*|tokio-postgres|sqlx)$/],
  ["MySQL", /^(mysql2?|pymysql|mysqlclient|github\.com\/go-sql-driver\/mysql)$/],
  ["SQLite", /^(sqlite3?|better-sqlite3|github\.com\/mattn\/go-sqlite3|rusqlite)$/],
  ["MongoDB", /^(mongodb|mongoose|pymongo|motor|go\.mongodb\.org\/mongo-driver)$/],
  ["Redis", /^(redis|ioredis|github\.com\/redis\/go-redis.*|github\.com\/go-redis\/redis.*)$/],
  ["Prisma", /^(prisma|@prisma\/client)$/], ["Drizzle", /^drizzle-orm$/], ["TypeORM", /^typeorm$/], ["Sequelize", /^sequelize$/],
  ["SQLAlchemy", /^sqlalchemy$/], ["Django ORM", /^django$/], ["GORM", /gorm\.io\/gorm/], ["Diesel", /^diesel$/],
  ["Elasticsearch", /elasticsearch/], ["DynamoDB", /(dynamodb|@aws-sdk\/client-dynamodb)/], ["Supabase", /^@supabase\/supabase-js$/], ["Firebase", /^firebase(-admin)?$/],
];

export interface Overview {
  name: string;
  files: number;
  languages: { lang: string; files: number }[];
  frameworks: string[];
  databases: string[];
  packages: { name: string; path: string }[];
  services: string[];
  entrypoints: string[];
  modules: { path: string; files: number }[];
  apis: { method: string; path: string; file: string }[];
  infrastructure: string[];
  tests: { files: number; dirs: string[] };
  documentation: string[];
}

export function overview(project: Project, idx: ProjectIndex): Overview {
  const files = idx.all();
  const indexed = new Set(files.map((f) => f.path));
  const langCount = new Map<string, number>();
  for (const f of files) if (f.lang !== "other") langCount.set(f.lang, (langCount.get(f.lang) ?? 0) + 1);

  const deps = new Set<string>();
  const packages: { name: string; path: string }[] = [];
  for (const f of files) {
    if (!/(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|composer\.json)$/.test(f.path)) continue;
    if (f.path.includes("node_modules/")) continue;
    let content = "";
    try {
      content = readFileSync(join(project.root, f.path), "utf8");
    } catch {
      continue;
    }
    for (const k of parseManifest(f.path, content).keys()) deps.add(k);
    const name =
      f.path.endsWith("package.json") ? tryJson(content)?.name
      : f.path.endsWith("go.mod") ? /^module\s+(\S+)/m.exec(content)?.[1]
      : f.path.endsWith("Cargo.toml") ? /^\s*name\s*=\s*"([^"]+)"/m.exec(content)?.[1]
      : f.path.endsWith("pyproject.toml") ? /^\s*name\s*=\s*"([^"]+)"/m.exec(content)?.[1]
      : undefined;
    if (typeof name === "string") packages.push({ name, path: posix.dirname(f.path) });
  }
  const match = (table: [string, RegExp][]) => [...new Set(table.filter(([, re]) => [...deps].some((d) => re.test(d))).map(([n]) => n))];
  const databases = match(DATABASES);
  if (files.some((f) => /(^|\/)schema\.prisma$/.test(f.path)) && !databases.includes("Prisma")) databases.push("Prisma");
  if (files.some((f) => /(^|\/)migrations?\//.test(f.path))) databases.push("(migrations present)");

  const services: string[] = [];
  for (const f of files.filter((x) => /(^|\/)(docker-)?compose[^/]*\.ya?ml$/.test(x.path))) {
    try {
      const doc = YAML.parse(readFileSync(join(project.root, f.path), "utf8")) as { services?: Record<string, unknown> } | null;
      for (const s of Object.keys(doc?.services ?? {})) services.push(`${s} (${f.path})`);
    } catch {
      // ignore malformed compose files
    }
  }

  const entrypoints = new Set<string>();
  for (const p of packages) {
    const pj = files.find((f) => f.path === (p.path === "." ? "package.json" : `${p.path}/package.json`));
    if (!pj) continue;
    const j = tryJson(readFileSync(join(project.root, pj.path), "utf8")) as { main?: string; bin?: string | Record<string, string>; module?: string } | null;
    const base = p.path === "." ? "" : p.path + "/";
    for (const e of [j?.main, j?.module, ...(typeof j?.bin === "string" ? [j.bin] : Object.values(j?.bin ?? {}))]) if (e) entrypoints.add(posix.normalize(base + e));
  }
  const ENTRY = /(^|\/)(main\.(go|rs|py|ts|js|kt|java|swift|c|cpp)|index\.(ts|js|tsx|jsx)|app\.(py|ts|js)|server\.(ts|js|py|go)|cli\.(ts|js|py)|__main__\.py|manage\.py|wsgi\.py|asgi\.py|Program\.cs)$/;
  for (const f of files) {
    if (f.role === "test") continue;
    if (ENTRY.test(f.path) && f.path.split("/").length <= 4) entrypoints.add(f.path);
    if (f.lang === "go" && f.pkg === "main") entrypoints.add(f.path);
  }

  const modCount = new Map<string, number>();
  for (const f of files) {
    if (f.role !== "source" || !CODEISH.test(f.path)) continue;
    const parts = f.path.split("/");
    const key = parts.length > 2 && ["src", "lib", "app", "pkg", "internal", "packages", "apps", "cmd"].includes(parts[0]!) ? parts.slice(0, 2).join("/") : parts.length > 1 ? parts[0]! : ".";
    modCount.set(key, (modCount.get(key) ?? 0) + 1);
  }

  const apis: Overview["apis"] = [];
  for (const f of files) {
    if (f.role === "test") continue;
    for (const r of f.routes) apis.push({ method: r.method, path: r.path === "(file route)" ? fileRoute(f.path) : r.path, file: f.path });
    if (/(^|\/)pages\/api\/.+\.(t|j)sx?$/.test(f.path)) apis.push({ method: "ANY", path: fileRoute(f.path), file: f.path });
  }
  for (const f of files) if (/(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i.test(f.path)) apis.push({ method: "SPEC", path: f.path, file: f.path });

  const tests = files.filter((f) => f.role === "test");
  const testDirs = [...new Set(tests.map((t) => t.path.split("/").slice(0, -1).slice(0, 2).join("/") || "."))].slice(0, 10);

  return {
    name: project.name,
    files: files.length,
    languages: [...langCount.entries()].sort((a, b) => b[1] - a[1]).map(([lang, n]) => ({ lang, files: n })),
    frameworks: match(FRAMEWORKS),
    databases,
    packages,
    services,
    entrypoints: [...entrypoints].filter((e) => indexed.has(e)).sort().slice(0, 20),
    modules: [...modCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([path, n]) => ({ path, files: n })),
    apis: dedupeRoutes(apis).slice(0, 100),
    infrastructure: files.filter((f) => f.role === "infrastructure").map((f) => f.path).slice(0, 40),
    tests: { files: tests.length, dirs: testDirs },
    documentation: files.filter((f) => (f.role === "documentation" || /(^|\/)(CLAUDE|AGENTS)\.md$/.test(f.path)) && /\.(md|mdx|rst|adoc)$/i.test(f.path)).map((f) => f.path).slice(0, 40),
  };
}

const CODEISH = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|cs|php|swift|c|cc|cpp|h|hpp|ex|exs|vue|svelte)$/;

function fileRoute(path: string): string {
  return (
    "/" +
    path
      .replace(/^.*?(?:^|\/)(?:app|pages)\//, "")
      .replace(/\/?route\.(t|j)sx?$/, "")
      .replace(/\.(t|j)sx?$/, "")
      .replace(/\/index$/, "")
  );
}

function dedupeRoutes<T extends { method: string; path: string; file: string }>(r: T[]): T[] {
  const seen = new Set<string>();
  return r.filter((x) => {
    const k = `${x.method} ${x.path} ${x.file}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function tryJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Small concept map so "authentication" also finds auth/login/session code. Deterministic. */
const CONCEPTS: Record<string, string[]> = {
  authentication: ["auth", "login", "logout", "signin", "signup", "session", "jwt", "oauth", "token", "passport", "credential", "password"],
  authorization: ["authz", "permission", "role", "rbac", "policy", "acl", "guard"],
  payments: ["payment", "billing", "stripe", "checkout", "invoice", "subscription", "charge"],
  database: ["db", "model", "schema", "migration", "repository", "orm", "query", "sql"],
  api: ["route", "router", "controller", "handler", "endpoint", "api"],
  testing: ["test", "spec", "fixture", "mock"],
  config: ["config", "settings", "env"],
  logging: ["log", "logger", "logging", "telemetry", "metrics", "trace"],
  cache: ["cache", "redis", "memo"],
  email: ["email", "mail", "smtp", "notification"],
  upload: ["upload", "file", "storage", "s3", "blob"],
};

export interface SearchHit {
  path: string;
  score: number;
  reasons: string[];
}

export function expandQuery(q: string): string[] {
  const words = q.toLowerCase().split(/[\s,/]+/).filter((w) => w.length > 1);
  const out = new Set(words);
  for (const w of words) {
    for (const [concept, syn] of Object.entries(CONCEPTS)) {
      if (concept.startsWith(w) || w.startsWith(concept.slice(0, 5)) || syn.includes(w)) {
        out.add(concept);
        for (const s of syn) out.add(s);
      }
    }
  }
  return [...out];
}

export function search(idx: ProjectIndex, query: string, limit = 25): SearchHit[] {
  const terms = expandQuery(query);
  const direct = new Set(query.toLowerCase().split(/[\s,/]+/).filter(Boolean));
  const hits: SearchHit[] = [];
  for (const f of idx.all()) {
    let score = 0;
    const reasons: string[] = [];
    const pathLower = f.path.toLowerCase();
    const segments = pathLower.split(/[/._-]+/);
    for (const t of terms) {
      const w = direct.has(t) ? 2 : 1;
      if (segments.includes(t)) (score += 4 * w), reasons.push(`path:${t}`);
      else if (t.length >= 4 && pathLower.includes(t)) (score += 2 * w), reasons.push(`path~${t}`);
      for (const s of f.symbols) {
        const sl = s.toLowerCase();
        if (sl === t) (score += 5 * w), reasons.push(`symbol:${s}`);
        else if (t.length >= 4 && sl.includes(t)) (score += 2 * w), reasons.push(`symbol~${s}`);
      }
      for (const r of f.routes) if (r.path.toLowerCase().includes(t)) (score += 3 * w), reasons.push(`route:${r.method} ${r.path}`);
    }
    if (score > 0) {
      if (f.role === "test") score *= 0.6;
      if (f.role === "documentation") score *= 0.7;
      hits.push({ path: f.path, score, reasons: [...new Set(reasons)].slice(0, 5) });
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Impact analysis
// ---------------------------------------------------------------------------

export interface Impact {
  path: string;
  exists: boolean;
  indexed: boolean;
  role: string;
  symbols: string[];
  imports: string[];
  used_by: { path: string; depth: number }[];
  tests: string[];
  routes: { method: string; path: string; file: string }[];
  config: string[];
  areas: string[];
  packages: string[];
}

const NOISE = new Set(["src", "lib", "app", "index", "main", "utils", "util", "helpers", "common", "shared", "core", "internal", "pkg", "test", "tests", "spec", "__init__", "mod", "js", "ts", "py", "go", "rs", "components", "packages", "apps"]);

export function impact(project: Project, idx: ProjectIndex, path: string): Impact {
  const f = idx.file(path);
  const deps = idx.dependents(path, 3);
  const used_by = [...deps.entries()].map(([p, depth]) => ({ path: p, depth })).sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
  const tests = idx.testsFor(path);
  const routes: Impact["routes"] = [];
  for (const p of [path, ...used_by.filter((u) => u.depth <= 2).map((u) => u.path)]) {
    const g: IndexedFile | null = idx.file(p);
    for (const r of g?.routes ?? []) routes.push({ ...(r as Route), file: p });
  }
  // Config files that mention this module by name (e.g. env keys, route tables) — cheap text scan of small config files.
  const stem = posix.basename(path).replace(/\.[^.]+$/, "");
  const config: string[] = [];
  if (stem.length > 3 && !NOISE.has(stem.toLowerCase())) {
    const ref = new RegExp(`[/'"\`]${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.[a-z]+)?\\b`);
    for (const c of idx.all().filter((x) => (x.role === "config" || x.role === "infrastructure") && x.size < 200_000 && !/(^|\/)\.(git|docker)ignore$|\.md$/.test(x.path))) {
      try {
        if (ref.test(readFileSync(join(project.root, c.path), "utf8"))) config.push(c.path);
      } catch {
        // unreadable
      }
      if (config.length >= 10) break;
    }
  }
  const areaCount = new Map<string, number>();
  const addArea = (p: string, weight: number) => {
    for (const seg of p.replace(/\.[^.]+$/, "").split(/[/._-]+/)) {
      const s = seg.toLowerCase();
      if (s.length < 3 || NOISE.has(s) || /^\d+$/.test(s)) continue;
      areaCount.set(s, (areaCount.get(s) ?? 0) + weight);
    }
  };
  addArea(path, 2);
  for (const u of used_by) addArea(u.path, u.depth === 1 ? 2 : 1);
  for (const r of routes) addArea(r.path, 1);
  const areas = [...areaCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([a]) => a);
  const pkgs = new Set<string>();
  for (const u of [path, ...used_by.map((x) => x.path)]) {
    const parts = u.split("/");
    if (["packages", "apps", "services"].includes(parts[0]!) && parts[1]) pkgs.add(`${parts[0]}/${parts[1]}`);
  }
  return {
    path,
    exists: existsSync(join(project.root, path)),
    indexed: !!f,
    role: f?.role ?? "unknown",
    symbols: f?.symbols ?? [],
    imports: idx.imports(path),
    used_by,
    tests,
    routes: dedupeRoutes(routes),
    config,
    areas,
    packages: [...pkgs],
  };
}
