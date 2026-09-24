/**
 * Lightweight static analysis: import specifiers, exported/top-level symbols
 * and HTTP routes, extracted with language-aware patterns (comments and
 * strings are stripped first). No external parsers, no LLM.
 */

export type Lang =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "ruby"
  | "java"
  | "kotlin"
  | "csharp"
  | "php"
  | "swift"
  | "c"
  | "cpp"
  | "elixir"
  | "shell"
  | "sql"
  | "markdown"
  | "yaml"
  | "json"
  | "toml"
  | "html"
  | "css"
  | "vue"
  | "svelte"
  | "other";

const EXT: Record<string, Lang> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python",
  go: "go", rs: "rust", rb: "ruby", java: "java", kt: "kotlin", kts: "kotlin",
  cs: "csharp", php: "php", swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cxx: "cpp",
  ex: "elixir", exs: "elixir", sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  sql: "sql", md: "markdown", mdx: "markdown", yml: "yaml", yaml: "yaml", json: "json", toml: "toml",
  html: "html", htm: "html", css: "css", scss: "css", sass: "css", less: "css", vue: "vue", svelte: "svelte",
};

export function langOf(path: string): Lang {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return (m && EXT[m[1]!.toLowerCase()]) || "other";
}

export const CODE_LANGS = new Set<Lang>(["typescript", "javascript", "python", "go", "rust", "ruby", "java", "kotlin", "csharp", "php", "swift", "c", "cpp", "elixir", "vue", "svelte"]);

export interface Route {
  method: string;
  path: string;
}

export interface ParseResult {
  imports: string[];
  symbols: string[];
  routes: Route[];
  /** Go: `package` name; used to detect entrypoints. */
  package?: string;
}

/** Removes comments while keeping string literals (imports live in strings). */
function stripComments(src: string, style: "c" | "hash"): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      let j = i + 1;
      while (j < n && src[j] !== q) {
        if (src[j] === "\\") j++;
        if (src[j] === "\n" && q !== "`") break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (style === "c" && ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (style === "c" && ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const block = src.slice(i, end < 0 ? n : end + 2);
      out += block.replace(/[^\n]/g, " ");
      i = end < 0 ? n : end + 2;
    } else if (style === "hash" && ch === "#") {
      while (i < n && src[i] !== "\n") i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

const uniq = <T>(a: T[]): T[] => [...new Set(a)];

function parseJs(src: string): ParseResult {
  const s = stripComments(src, "c");
  const imports: string[] = [];
  for (const m of s.matchAll(/\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"'\n]+)["']/g)) imports.push(m[1]!);
  for (const m of s.matchAll(/\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*["']([^"'\n]+)["']/g)) imports.push(m[1]!);
  for (const m of s.matchAll(/\b(?:require|import)\s*\(\s*["']([^"'\n]+)["']\s*\)/g)) imports.push(m[1]!);
  const symbols: string[] = [];
  for (const m of s.matchAll(/^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm)) symbols.push(m[1]!);
  for (const m of s.matchAll(/^(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) symbols.push(m[1]!);
  for (const m of s.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) symbols.push(name);
    }
  }
  const routes: Route[] = [];
  for (const m of s.matchAll(/\b(?:app|router|server|api|route|fastify|r)\s*\.\s*(get|post|put|patch|delete|all|head|options)\s*\(\s*["'`](\/[^"'`\n]*)["'`]/gi)) {
    routes.push({ method: m[1]!.toUpperCase(), path: m[2]! });
  }
  for (const m of s.matchAll(/@(Get|Post|Put|Patch|Delete)\s*\(\s*["'`]([^"'`\n]*)["'`]?\s*\)/g)) routes.push({ method: m[1]!.toUpperCase(), path: "/" + m[2]!.replace(/^\//, "") });
  for (const m of s.matchAll(/^\s*export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/gm)) routes.push({ method: m[1]!, path: "(file route)" });
  return { imports: uniq(imports), symbols: uniq(symbols), routes };
}

/** Blanks triple-quoted strings (docstrings) but keeps line numbers. */
function stripPyTripleQuoted(src: string): string {
  return src.replace(/("""|\'\'\')[\s\S]*?\1/g, (m) => m.replace(/[^\n]/g, " "));
}

function parsePython(src: string): ParseResult {
  const s = stripComments(stripPyTripleQuoted(src), "hash");
  const imports: string[] = [];
  for (const m of s.matchAll(/^\s*from\s+(\.*[\w.]*)\s+import\s+(\([^)]*\)|[^\n]+)/gm)) {
    const mod = m[1]!;
    const names = m[2]!.replace(/[()\n]/g, " ").split(",").map((x) => x.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
    // `from . import x` / `from pkg import submodule`: submodules resolve like modules.
    if (/^\.+$/.test(mod)) for (const n of names) imports.push(mod + n);
    else {
      imports.push(mod);
      for (const n of names) if (n !== "*") imports.push(`${mod}${mod.endsWith(".") ? "" : "."}${n}`);
    }
  }
  for (const m of s.matchAll(/^\s*import\s+([^\n]+)/gm)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (/^[\w.]+$/.test(name)) imports.push(name);
    }
  }
  const symbols: string[] = [];
  for (const m of s.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm)) symbols.push(m[1]!);
  for (const m of s.matchAll(/^([A-Z][A-Z0-9_]+)\s*=/gm)) symbols.push(m[1]!);
  const routes: Route[] = [];
  for (const m of s.matchAll(/@\w+(?:\.\w+)*\.(get|post|put|patch|delete|route|api_route|websocket)\s*\(\s*["']([^"'\n]*)["']/gi)) {
    routes.push({ method: m[1]!.toLowerCase() === "route" ? "ANY" : m[1]!.toUpperCase(), path: m[2]! });
  }
  for (const m of s.matchAll(/\b(?:re_)?path\s*\(\s*r?["']([^"'\n]*)["']/g)) routes.push({ method: "ANY", path: "/" + m[1]!.replace(/^\^?\/?/, "") });
  return { imports: uniq(imports), symbols: uniq(symbols), routes };
}

function parseGo(src: string): ParseResult {
  const s = stripComments(src, "c");
  const imports: string[] = [];
  for (const m of s.matchAll(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) imports.push(m[1]!);
  for (const m of s.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) for (const i of m[1]!.matchAll(/"([^"]+)"/g)) imports.push(i[1]!);
  const symbols: string[] = [];
  for (const m of s.matchAll(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm)) symbols.push(m[1]!);
  for (const m of s.matchAll(/^type\s+([A-Za-z_]\w*)/gm)) symbols.push(m[1]!);
  const routes: Route[] = [];
  for (const m of s.matchAll(/\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|HandleFunc|Handle)\s*\(\s*"(\/[^"\n]*)"/g)) {
    const method = /^Handle/.test(m[1]!) ? "ANY" : m[1]!.toUpperCase();
    routes.push({ method, path: m[2]!.replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/, "") });
  }
  const pkg = /^package\s+(\w+)/m.exec(s)?.[1];
  return { imports: uniq(imports), symbols: uniq(symbols), routes, ...(pkg ? { package: pkg } : {}) };
}

function parseRust(src: string): ParseResult {
  const s = stripComments(src, "c");
  const imports: string[] = [];
  for (const m of s.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) imports.push(`mod:${m[1]}`);
  for (const m of s.matchAll(/^\s*(?:pub\s+)?use\s+((?:crate|super|self)::[\w:]+)/gm)) imports.push(m[1]!);
  const symbols: string[] = [];
  for (const m of s.matchAll(/^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\s+([A-Za-z_]\w*)/gm)) symbols.push(m[1]!);
  const routes: Route[] = [];
  for (const m of s.matchAll(/#\[(get|post|put|patch|delete)\s*\(\s*"([^"\n]*)"/g)) routes.push({ method: m[1]!.toUpperCase(), path: m[2]! });
  for (const m of s.matchAll(/\.route\s*\(\s*"(\/[^"\n]*)"\s*,\s*(get|post|put|patch|delete)/g)) routes.push({ method: m[2]!.toUpperCase(), path: m[1]! });
  return { imports: uniq(imports), symbols: uniq(symbols), routes };
}

function parseRuby(src: string): ParseResult {
  const s = stripComments(src, "hash");
  const imports: string[] = [];
  for (const m of s.matchAll(/\brequire_relative\s+["']([^"']+)["']/g)) imports.push(`./${m[1]}`);
  const symbols: string[] = [];
  for (const m of s.matchAll(/^\s*(?:class|module|def)\s+(?:self\.)?([A-Za-z_][\w?!]*)/gm)) symbols.push(m[1]!);
  const routes: Route[] = [];
  for (const m of s.matchAll(/^\s*(get|post|put|patch|delete)\s+["'](\/[^"'\n]*)["']/gm)) routes.push({ method: m[1]!.toUpperCase(), path: m[2]! });
  return { imports: uniq(imports), symbols: uniq(symbols), routes };
}

function parseJvm(src: string): ParseResult {
  const s = stripComments(src, "c");
  const imports: string[] = [];
  for (const m of s.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;?/gm)) imports.push(`jvm:${m[1]}`);
  const symbols: string[] = [];
  for (const m of s.matchAll(/\b(?:class|interface|enum|record|object)\s+([A-Z]\w*)/g)) symbols.push(m[1]!);
  const routes: Route[] = [];
  for (const m of s.matchAll(/@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"\n]*)"/g)) {
    routes.push({ method: m[1] === "Request" ? "ANY" : m[1]!.toUpperCase(), path: m[2]! });
  }
  return { imports: uniq(imports), symbols: uniq(symbols), routes };
}

function parsePhp(src: string): ParseResult {
  const s = stripComments(src, "c");
  const symbols: string[] = [];
  for (const m of s.matchAll(/\b(?:class|interface|trait|function)\s+([A-Za-z_]\w*)/g)) symbols.push(m[1]!);
  const routes: Route[] = [];
  for (const m of s.matchAll(/Route::(get|post|put|patch|delete|any)\s*\(\s*["']([^"'\n]*)["']/g)) routes.push({ method: m[1]!.toUpperCase(), path: m[2]! });
  const imports: string[] = [];
  for (const m of s.matchAll(/\b(?:require|include)(?:_once)?\s*\(?\s*["']([^"']+)["']/g)) imports.push(m[1]!.startsWith(".") ? m[1]! : `./${m[1]}`);
  return { imports: uniq(imports), symbols: uniq(symbols), routes };
}

function parseCish(src: string): ParseResult {
  const s = stripComments(src, "c");
  const imports: string[] = [];
  for (const m of s.matchAll(/^\s*#\s*include\s+"([^"]+)"/gm)) imports.push(`./${m[1]}`);
  const symbols: string[] = [];
  for (const m of s.matchAll(/^(?:[\w:*&<>\s]+?)\s+\**([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/gm)) symbols.push(m[1]!);
  return { imports: uniq(imports), symbols: uniq(symbols), routes: [] };
}

function parseVueSvelte(src: string): ParseResult {
  const scripts = [...src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  return parseJs(scripts);
}

export function parseFile(path: string, content: string): ParseResult {
  switch (langOf(path)) {
    case "typescript":
    case "javascript":
      return parseJs(content);
    case "vue":
    case "svelte":
      return parseVueSvelte(content);
    case "python":
      return parsePython(content);
    case "go":
      return parseGo(content);
    case "rust":
      return parseRust(content);
    case "ruby":
      return parseRuby(content);
    case "java":
    case "kotlin":
      return parseJvm(content);
    case "php":
      return parsePhp(content);
    case "c":
    case "cpp":
      return parseCish(content);
    default:
      return { imports: [], symbols: [], routes: [] };
  }
}
