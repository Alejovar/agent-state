import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Project } from "./project.js";
import { parseManifest } from "./deps.js";
import type { ProjectIndex } from "../index/indexer.js";

/**
 * Context drift: contradictions between what documentation / agent instructions
 * claim and what the repository shows. Evidence always comes from the repo;
 * wording checks are deterministic. AI may add semantic findings on top.
 */
export interface DriftFinding {
  kind: "missing_path" | "missing_script" | "technology" | "package_manager" | "semantic";
  doc: string;
  line: number;
  claim: string;
  observed: string;
  confidence: number;
  files: string[];
  evidence: "verified" | "ai";
}

export const DOC_CANDIDATES = /(^|\/)(CLAUDE|AGENTS|GEMINI|CONVENTIONS|ARCHITECTURE|CONTRIBUTING|README)[^/]*\.md$|(^|\/)docs?\/.*\.mdx?$|(^|\/)\.cursorrules$|(^|\/)\.cursor\/rules\/.*\.mdc?$|(^|\/)\.github\/copilot-instructions\.md$/i;

interface Tech {
  name: string;
  /** Word-boundary pattern that detects a claim in prose. */
  mention: RegExp;
  /** Dependencies proving usage. */
  deps: RegExp;
  /** Files proving usage. */
  files?: RegExp;
  group?: string;
}

const TECH: Tech[] = [
  { name: "JWT", mention: /\bJWTs?\b|\bJSON Web Tokens?\b/i, deps: /^(jsonwebtoken|jose|@nestjs\/jwt|passport-jwt|express-jwt|pyjwt|python-jose|djangorestframework-simplejwt|github\.com\/golang-jwt\/jwt.*|jsonwebtoken-rs|jwt)$/i, group: "auth-token" },
  { name: "server-side sessions", mention: /\bsession (store|cookies?)\b|\bserver[- ]side sessions?\b/i, deps: /^(express-session|connect-redis|iron-session|cookie-session|next-auth|@fastify\/session|flask-session|django)$/i, group: "auth-token" },
  { name: "Redis", mention: /\bRedis\b/, deps: /^(redis|ioredis|connect-redis|bullmq|bull|github\.com\/redis\/go-redis.*|github\.com\/go-redis\/redis.*|redis-py|aioredis)$/i, files: /redis/i },
  { name: "PostgreSQL", mention: /\bPostgres(QL)?\b/i, deps: /^(pg|postgres|psycopg2?(-binary)?|asyncpg|github\.com\/lib\/pq|github\.com\/jackc\/pgx.*|tokio-postgres|@neondatabase\/serverless|@vercel\/postgres)$/i, files: /postgres|\.sql$/i, group: "db" },
  { name: "MySQL", mention: /\bMySQL\b|\bMariaDB\b/i, deps: /^(mysql2?|pymysql|mysqlclient|github\.com\/go-sql-driver\/mysql)$/i, group: "db" },
  { name: "SQLite", mention: /\bSQLite\b/i, deps: /^(sqlite3?|better-sqlite3|rusqlite|github\.com\/mattn\/go-sqlite3|@libsql\/client)$/i, files: /\.(sqlite|db)$/, group: "db" },
  { name: "MongoDB", mention: /\bMongo(DB)?\b|\bMongoose\b/i, deps: /^(mongodb|mongoose|pymongo|motor|go\.mongodb\.org\/mongo-driver)$/i, group: "db" },
  { name: "Prisma", mention: /\bPrisma\b/, deps: /^(prisma|@prisma\/client)$/, files: /schema\.prisma$/ },
  { name: "Drizzle", mention: /\bDrizzle\b/, deps: /^drizzle-orm$/ },
  { name: "GraphQL", mention: /\bGraphQL\b/, deps: /^(graphql|@apollo\/server|apollo-server.*|graphql-yoga|strawberry-graphql|graphene|async-graphql|github\.com\/99designs\/gqlgen)$/i, files: /\.(graphql|gql)$/ },
  { name: "tRPC", mention: /\btRPC\b/, deps: /^@trpc\// },
  { name: "Express", mention: /\bExpress(\.js)?\b(?!\s+(?:checkout|delivery|mode))/, deps: /^express$/, group: "http" },
  { name: "Fastify", mention: /\bFastify\b/, deps: /^fastify$/, group: "http" },
  { name: "Hono", mention: /\bHono\b/, deps: /^hono$/, group: "http" },
  { name: "NestJS", mention: /\bNest(JS)?\b/, deps: /^@nestjs\/core$/, group: "http" },
  { name: "Django", mention: /\bDjango\b/, deps: /^django$/i, group: "pyweb" },
  { name: "Flask", mention: /\bFlask\b/, deps: /^flask$/i, group: "pyweb" },
  { name: "FastAPI", mention: /\bFastAPI\b/, deps: /^fastapi$/i, group: "pyweb" },
  { name: "React", mention: /\bReact\b(?!\s+Native)/, deps: /^react$/, group: "ui" },
  { name: "Vue", mention: /\bVue(\.js)?\b/, deps: /^vue$/, group: "ui" },
  { name: "Svelte", mention: /\bSvelte(Kit)?\b/, deps: /^(svelte|@sveltejs\/kit)$/, group: "ui" },
  { name: "Angular", mention: /\bAngular\b/, deps: /^@angular\/core$/, group: "ui" },
  { name: "Next.js", mention: /\bNext\.?js\b/i, deps: /^next$/ },
  { name: "Tailwind", mention: /\bTailwind(CSS)?\b/i, deps: /^tailwindcss$/ },
  { name: "Jest", mention: /\bJest\b/, deps: /^jest$/, group: "test" },
  { name: "Vitest", mention: /\bVitest\b/, deps: /^vitest$/, group: "test" },
  { name: "Mocha", mention: /\bMocha\b/, deps: /^mocha$/, group: "test" },
  { name: "pytest", mention: /\bpytest\b/, deps: /^pytest$/i, files: /(^|\/)(conftest\.py|pytest\.ini)$/ },
  { name: "Playwright", mention: /\bPlaywright\b/, deps: /^(@playwright\/test|playwright)$/ },
  { name: "Webpack", mention: /\bWebpack\b/i, deps: /^webpack$/, group: "bundler" },
  { name: "Vite", mention: /\bVite\b/, deps: /^vite$/, group: "bundler" },
  { name: "Docker", mention: /\bDocker(file)?\b/, deps: /^$/, files: /(^|\/)Dockerfile|compose[^/]*\.ya?ml$/i },
  { name: "Kubernetes", mention: /\bKubernetes\b|\bk8s\b/i, deps: /^$/, files: /(^|\/)(k8s|kubernetes|helm|charts)\//i },
  { name: "Terraform", mention: /\bTerraform\b/, deps: /^$/, files: /\.tf$/ },
  { name: "Stripe", mention: /\bStripe\b/, deps: /^(stripe|@stripe\/.*)$/i },
  { name: "OAuth", mention: /\bOAuth\s*2?\b/i, deps: /(oauth|passport-google|passport-github|next-auth|@auth\/|authlib|openid|oidc|arctic)/i, files: /oauth/i },
  { name: "Zod", mention: /\bZod\b/, deps: /^zod$/ },
  { name: "Tokio", mention: /\bTokio\b/, deps: /^tokio$/ },
];

const NEGATION = /\b(not|no longer|never|don't|do not|doesn't|instead of|rather than|replaced|removed|migrat\w* (away )?from|deprecated|avoid|without|legacy|previously|used to|was using|TODO|planned|will|could|may|might|consider)\b/i;
const EXAMPLE = /\b(e\.g\.|for example|such as|example|contradict\w*|drift)\b/i;
const USAGE = /\b(uses?|using|built (on|with)|powered by|backed by|stores?|persist\w*|based on|relies on|via|with|runs? on|implemented (with|using)|we use|stack|database|auth\w*|sessions?)\b/i;

function loadDeps(project: Project, files: string[]): Set<string> {
  const deps = new Set<string>();
  for (const f of files) {
    if (!/(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|composer\.json)$/.test(f) || f.includes("node_modules/")) continue;
    try {
      for (const k of parseManifest(f, readFileSync(join(project.root, f), "utf8")).keys()) deps.add(k);
    } catch {
      // unreadable
    }
  }
  return deps;
}

function techEvidence(t: Tech, deps: Set<string>, files: string[]): string[] {
  const out: string[] = [];
  for (const d of deps) if (t.deps.source !== "^$" && t.deps.test(d)) out.push(`dependency ${d}`);
  if (t.files) for (const f of files) if (t.files.test(f) && !DOC_CANDIDATES.test(f)) out.push(f);
  return out.slice(0, 5);
}

/** Splits markdown into (line, text) pairs, skipping fenced code blocks for prose checks. */
function lines(md: string): { n: number; text: string; code: boolean }[] {
  const out: { n: number; text: string; code: boolean }[] = [];
  let fence = false;
  md.split("\n").forEach((text, i) => {
    if (/^\s*(```|~~~)/.test(text)) {
      fence = !fence;
      return;
    }
    out.push({ n: i + 1, text, code: fence });
  });
  return out;
}

const PATHLIKE = /`([^`\s]+)`|\]\(([^)\s#]+)(?:#[^)]*)?\)/g;

function looksLikeRepoPath(s: string): boolean {
  if (/^(https?:|mailto:|#|\/\/|~|\$|<|\{)/.test(s)) return false;
  if (/[*?<>{}|]|\s|^-|\.\.\.$|^\.\/?$/.test(s)) return false;
  if (s.includes("node_modules")) return false;
  if (/^[A-Z_]+=/.test(s)) return false;
  const hasSlash = s.includes("/");
  const hasExt = /\.[a-z0-9]{1,6}$/i.test(s) && !/^\d+(\.\d+)+$/.test(s) && !/^[a-z]+\.[a-z]+\(/.test(s);
  if (!hasSlash && !hasExt) return false;
  if (/^@?[\w-]+\/[\w-]+$/.test(s) && !hasExt) return false; // npm scope / owner/repo
  if (/^[\w.-]+\.(com|org|io|dev|net|ai|app)(\/|$)/.test(s)) return false;
  if (/^\w+\.\w+$/.test(s) && !/\.(md|ts|tsx|js|jsx|py|go|rs|json|ya?ml|toml|sh|sql|css|html|env|lock|txt)$/i.test(s)) return false;
  return true;
}

export function detectDrift(project: Project, idx: ProjectIndex, only?: string): DriftFinding[] {
  const files = idx.all().map((f) => f.path);
  const fileSet = new Set(files);
  const dirSet = new Set<string>();
  for (const f of files) {
    let d = posix.dirname(f);
    while (d && d !== ".") (dirSet.add(d), (d = posix.dirname(d)));
  }
  const docs = only ? [only] : files.filter((f) => DOC_CANDIDATES.test(f) && !f.includes("node_modules/") && !f.startsWith("CHANGELOG"));
  const deps = loadDeps(project, files);
  const pkgJson = files.includes("package.json") ? (JSON.parse(readFileSync(join(project.root, "package.json"), "utf8")) as { scripts?: Record<string, string> }) : null;
  const scripts = new Set(Object.keys(pkgJson?.scripts ?? {}));
  const makefile = files.find((f) => f === "Makefile");
  const makeTargets = new Set(makefile ? [...readFileSync(join(project.root, makefile), "utf8").matchAll(/^([A-Za-z0-9_.-]+)\s*:/gm)].map((m) => m[1]!) : []);
  const lockfiles = {
    npm: files.includes("package-lock.json"),
    pnpm: files.includes("pnpm-lock.yaml"),
    yarn: files.includes("yarn.lock"),
    bun: files.includes("bun.lockb") || files.includes("bun.lock"),
  };
  const findings: DriftFinding[] = [];

  for (const doc of docs) {
    const abs = join(project.root, doc);
    if (!existsSync(abs)) continue;
    const md = readFileSync(abs, "utf8");
    const docDir = posix.dirname(doc);
    const reportedTech = new Set<string>();
    const reportedPaths = new Set<string>();
    for (const { n, text, code } of lines(md)) {
      // 1. Paths that no longer exist.
      for (const m of text.matchAll(PATHLIKE)) {
        const raw = (m[1] ?? m[2] ?? "").replace(/^\.\//, "").replace(/[),.:;]+$/, "").replace(/:\d+(:\d+)?$/, "");
        if (!raw || !looksLikeRepoPath(raw) || reportedPaths.has(raw)) continue;
        const candidates = [raw, posix.normalize(posix.join(docDir, raw)), raw.replace(/\/$/, "")];
        if (candidates.some((c) => fileSet.has(c) || dirSet.has(c) || existsSync(join(project.root, c)))) continue;
        // Only flag repo-relative paths whose first segment exists: bare file names and
        // unanchored paths are usually examples, not references.
        if (!raw.includes("/")) continue;
        const first = raw.split("/")[0]!;
        if (!dirSet.has(first) && !fileSet.has(first)) continue;
        reportedPaths.add(raw);
        findings.push({ kind: "missing_path", doc, line: n, claim: `References \`${raw}\``, observed: "Path does not exist in the repository", confidence: 0.9, files: [doc], evidence: "verified" });
      }
      // 2. Scripts / make targets that do not exist.
      for (const m of text.matchAll(/\b(npm run|pnpm(?: run)?|yarn(?: run)?|bun run)\s+([a-z][\w:.-]*)/g)) {
        const script = m[2]!;
        if (["install", "add", "remove", "dlx", "exec", "create", "init", "i", "x", "why", "link", "publish", "test", "start"].includes(script) && m[1] !== "npm run") continue;
        if (!pkgJson || scripts.has(script)) continue;
        findings.push({ kind: "missing_script", doc, line: n, claim: `\`${m[0]}\``, observed: `package.json has no "${script}" script (available: ${[...scripts].slice(0, 8).join(", ") || "none"})`, confidence: 0.9, files: [doc, "package.json"], evidence: "verified" });
      }
      for (const m of text.matchAll(/\bmake\s+([a-z][\w.-]*)/g)) {
        if (!makefile || makeTargets.has(m[1]!)) continue;
        findings.push({ kind: "missing_script", doc, line: n, claim: `\`make ${m[1]}\``, observed: `Makefile has no "${m[1]}" target`, confidence: 0.85, files: [doc, "Makefile"], evidence: "verified" });
      }
      // 3. Package manager.
      const pm = /\b(npm (?:install|ci|i)\b|pnpm (?:install|i)\b|yarn(?: install)?\b|bun install\b)/.exec(text)?.[1]?.split(" ")[0] as keyof typeof lockfiles | undefined;
      if (pm && !lockfiles[pm] && Object.values(lockfiles).some(Boolean) && !reportedTech.has(`pm:${pm}`)) {
        const actual = (Object.keys(lockfiles) as (keyof typeof lockfiles)[]).filter((k) => lockfiles[k]);
        reportedTech.add(`pm:${pm}`);
        findings.push({ kind: "package_manager", doc, line: n, claim: `Instructions use ${pm}`, observed: `Lockfile indicates ${actual.join("/")}`, confidence: 0.75, files: [doc], evidence: "verified" });
      }
      // 4. Technology claims without evidence (prose only, affirmative sentences).
      if (code || NEGATION.test(text)) continue;
      // Quoted text is an example, not a claim; lines listing many technologies are lists, not claims.
      const prose = text.replace(/"[^"]*"|“[^”]*”|`[^`]*`/g, " ");
      if (TECH.filter((t) => t.mention.test(prose)).length >= 3 || (prose.match(/,/g)?.length ?? 0) >= 4 || EXAMPLE.test(prose)) continue;
      for (const t of TECH) {
        if (reportedTech.has(t.name) || !t.mention.test(prose) || !USAGE.test(prose)) continue;
        const ev = techEvidence(t, deps, files);
        if (ev.length) continue;
        // Competing technology in the same group strengthens the finding.
        const rivals = TECH.filter((o) => o.group && o.group === t.group && o.name !== t.name)
          .map((o) => ({ o, ev: techEvidence(o, deps, files) }))
          .filter((x) => x.ev.length);
        const deterministicOnly = t.deps.source === "^$" && !t.files;
        if (deterministicOnly) continue;
        reportedTech.add(t.name);
        const sentence = text.replace(/^[\s>*#-]+/, "").trim();
        findings.push({
          kind: "technology",
          doc,
          line: n,
          claim: sentence.length > 160 ? sentence.slice(0, 159) + "…" : sentence,
          observed: rivals.length
            ? `No ${t.name} dependency or files found; repository uses ${rivals.map((r) => `${r.o.name} (${r.ev[0]})`).join(", ")}`
            : `No ${t.name} dependency or files found`,
          confidence: rivals.length ? 0.9 : 0.6,
          files: [doc, ...rivals.flatMap((r) => r.ev.filter((e) => !e.startsWith("dependency ")))].slice(0, 5),
          evidence: "verified",
        });
      }
    }
  }
  return findings.sort((a, b) => b.confidence - a.confidence || a.doc.localeCompare(b.doc) || a.line - b.line);
}
