import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { langOf } from "./parsers.js";
import { Resolver } from "./resolve.js";

/**
 * Symbol-level impact: which functions in other files use the names a file
 * exports, and where. Two engines:
 *  - tree-sitter (optional): exact syntax trees, used when the user installed
 *    `@vscode/tree-sitter-wasm` (it is ~22 MB, so it is never a dependency);
 *  - built-in: comment/string-aware scanning, always available.
 */

export interface SymbolUsage {
  /** Name as exported by the target file ("default" / "*" for default and namespace imports). */
  symbol: string;
  file: string;
  line: number;
  /** Enclosing function/method, or null at module level. */
  in: string | null;
}

export type Engine = "tree-sitter" | "built-in";

interface Binding {
  /** Local name in the importing file. */
  local: string;
  /** Name exported by the target ("default", "*" for namespaces). */
  imported: string;
}

const JS_LANGS = new Set(["typescript", "javascript"]);

// ---------------------------------------------------------------- bindings

/** Blanks comments and string contents (keeps quotes and line structure) so scans only see code. */
function codeOnly(src: string, hash: boolean): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (hash ? ch === "#" : ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (!hash && ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      const triple = hash && src.startsWith(ch.repeat(3), i);
      const close = triple ? ch.repeat(3) : ch;
      let j = i + close.length;
      while (j < src.length && !src.startsWith(close, j)) {
        if (src[j] === "\\") j++;
        if (!triple && ch !== "`" && src[j] === "\n") break;
        j++;
      }
      const stop = Math.min(src.length, j + close.length);
      out += close + src.slice(i + close.length, j).replace(/[^\n]/g, " ") + (j < src.length ? close : "");
      i = stop;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Names the importer binds from `specs` (the specifiers that resolve to the target). */
function bindingsFor(src: string, lang: string, specs: Set<string>): Binding[] {
  const out: Binding[] = [];
  const add = (local: string, imported: string) => {
    if (/^[A-Za-z_$][\w$]*$/.test(local)) out.push({ local, imported });
  };
  if (JS_LANGS.has(lang) || lang === "vue" || lang === "svelte") {
    const importRe = /\bimport\s+(?:type\s+)?([\s\S]*?)\s+from\s*["']([^"'\n]+)["']/g;
    for (const m of src.matchAll(importRe)) {
      if (!specs.has(m[2]!)) continue;
      const clause = m[1]!;
      const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause.trim());
      if (def) add(def[1]!, "default");
      const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
      if (ns) add(ns[1]!, "*");
      const named = /\{([^}]*)\}/.exec(clause);
      if (named) {
        for (const part of named[1]!.split(",")) {
          const [imp, loc] = part.replace(/\btype\s+/, "").trim().split(/\s+as\s+/);
          if (imp) add((loc ?? imp).trim(), imp.trim());
        }
      }
    }
    const reqRe = /\b(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']([^"'\n]+)["']\s*\)/g;
    for (const m of src.matchAll(reqRe)) {
      if (!specs.has(m[2]!)) continue;
      if (m[1]!.startsWith("{")) {
        for (const part of m[1]!.slice(1, -1).split(",")) {
          const [imp, loc] = part.trim().split(/\s*:\s*/);
          if (imp) add((loc ?? imp).trim(), imp.trim());
        }
      } else add(m[1]!, "*");
    }
  } else if (lang === "python") {
    for (const m of src.matchAll(/^\s*from\s+(\.*[\w.]*)\s+import\s+(\([^)]*\)|[^\n]+)/gm)) {
      const mod = m[1]!;
      for (const part of m[2]!.replace(/[()\n]/g, " ").split(",")) {
        const [imp, loc] = part.trim().split(/\s+as\s+/);
        if (!imp || imp === "*") continue;
        // `from pkg import module` binds the module; `from module import name` binds a name.
        if (specs.has(`${mod}${mod.endsWith(".") ? "" : "."}${imp}`)) add((loc ?? imp).trim(), "*");
        else if (specs.has(mod)) add((loc ?? imp).trim(), imp.trim());
      }
    }
    for (const m of src.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?\s*$/gm)) {
      if (specs.has(m[1]!)) add(m[2] ?? m[1]!.split(".")[0]!, "*");
    }
  }
  return out;
}

// ---------------------------------------------------------------- built-in engine

const FN_DECL = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*(?:(?:public|private|protected|static|async|get|set|override|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
];
const NOT_FN = new Set(["if", "for", "while", "switch", "catch", "with", "return", "function", "constructor"]);

function enclosingByScan(lines: string[], row: number): string | null {
  const indent = (s: string) => /^\s*/.exec(s)![0].length;
  const here = indent(lines[row] ?? "");
  for (let r = row; r >= 0; r--) {
    const l = lines[r]!;
    if (r < row && l.trim() && indent(l) >= here && r !== row) continue;
    for (const re of FN_DECL) {
      const m = re.exec(l);
      if (m && !NOT_FN.has(m[1]!)) return m[1]!;
    }
  }
  return null;
}

function usagesBuiltIn(src: string, lang: string, file: string, bindings: Binding[]): SymbolUsage[] {
  const code = codeOnly(src, lang === "python").split("\n");
  const out: SymbolUsage[] = [];
  const importLine = lang === "python" ? /^\s*(from|import)\b/ : /^\s*(import|export\s+\{|export\s+\*)\b|\brequire\s*\(/;
  for (const b of bindings) {
    const word = new RegExp(`(?<![\\w$.])${b.local.replace(/\$/g, "\\$")}(?![\\w$])(\\s*\\.\\s*([A-Za-z_$][\\w$]*))?`, "g");
    code.forEach((line, row) => {
      if (importLine.test(line)) return;
      for (const m of line.matchAll(word)) {
        const symbol = b.imported === "*" ? (m[2] ?? "*") : b.imported;
        out.push({ symbol, file, line: row + 1, in: enclosingByScan(code, row) });
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------- tree-sitter engine (optional)

interface TSModule {
  Parser: { new (): TSParser; init(opts: object): Promise<void> };
  Language: { load(path: string): Promise<unknown> };
}
interface TSParser {
  setLanguage(l: unknown): void;
  parse(src: string): { rootNode: TSNode };
}
interface TSNode {
  type: string;
  text: string;
  parent: TSNode | null;
  startPosition: { row: number };
  namedChildren: TSNode[];
  childForFieldName(name: string): TSNode | null;
}

const GRAMMAR: Record<string, string> = { typescript: "tree-sitter-typescript.wasm", javascript: "tree-sitter-javascript.wasm", python: "tree-sitter-python.wasm" };
const FUNCTION_NODES = new Set(["function_declaration", "generator_function_declaration", "method_definition", "function_definition", "function_expression", "arrow_function", "function"]);

let tsLoaded: Promise<{ mod: TSModule; base: string } | null> | null = null;

/** Finds `@vscode/tree-sitter-wasm` next to agent-state (global install) or in the project. */
function loadTreeSitter(projectRoot: string): Promise<{ mod: TSModule; base: string } | null> {
  if (tsLoaded) return tsLoaded;
  tsLoaded = (async () => {
    if (process.env.AGENT_STATE_NO_TREE_SITTER) return null;
    for (const from of [import.meta.url, join(projectRoot, "package.json")]) {
      try {
        const req = createRequire(from);
        const base = req.resolve("@vscode/tree-sitter-wasm/package.json").replace(/package\.json$/, "wasm/");
        const mod = req(base + "tree-sitter.js") as TSModule;
        await mod.Parser.init({ locateFile: () => base + "tree-sitter.wasm" });
        return { mod, base };
      } catch {
        // not installed there
      }
    }
    return null;
  })();
  return tsLoaded;
}

const languages = new Map<string, unknown>();

async function usagesTreeSitter(ts: { mod: TSModule; base: string }, src: string, lang: string, file: string, bindings: Binding[]): Promise<SymbolUsage[] | null> {
  const grammar = file.endsWith(".tsx") ? "tree-sitter-tsx.wasm" : GRAMMAR[lang];
  if (!grammar) return null;
  let language = languages.get(grammar);
  if (!language) {
    language = await ts.mod.Language.load(ts.base + grammar);
    languages.set(grammar, language);
  }
  const parser = new ts.mod.Parser();
  parser.setLanguage(language);
  const root = parser.parse(src).rootNode;
  const byLocal = new Map(bindings.map((b) => [b.local, b]));
  const out: SymbolUsage[] = [];
  const enclosing = (n: TSNode): string | null => {
    for (let p = n.parent; p; p = p.parent) {
      if (!FUNCTION_NODES.has(p.type)) continue;
      const name = p.childForFieldName("name")?.text;
      if (name) return name;
      // `const f = () => …` / `f: function () {…}`
      const holder = p.parent;
      const alias = holder?.childForFieldName("name")?.text ?? holder?.childForFieldName("key")?.text;
      if (alias) return alias;
    }
    return null;
  };
  const inImport = (n: TSNode): boolean => {
    for (let p = n.parent; p; p = p.parent) if (/^(import_statement|import_from_statement|import_clause|export_statement)$/.test(p.type) && /import|from/.test(p.type)) return true;
    return false;
  };
  const walk = (n: TSNode) => {
    if (n.type === "identifier" || n.type === "type_identifier" || n.type === "shorthand_property_identifier") {
      const b = byLocal.get(n.text);
      if (b && !inImport(n)) {
        let symbol = b.imported;
        if (symbol === "*") {
          const parent = n.parent;
          const prop = parent && /member_expression|attribute/.test(parent.type) ? (parent.childForFieldName("property") ?? parent.childForFieldName("attribute"))?.text : null;
          symbol = prop ?? "*";
        }
        out.push({ symbol, file, line: n.startPosition.row + 1, in: enclosing(n) });
      }
    }
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------- public API

/**
 * Where the names exported by `target` are used across `importers`.
 * Uses tree-sitter when available (JS/TS/Python), the built-in scanner otherwise.
 */
export async function symbolUsages(
  projectRoot: string,
  target: string,
  importers: { path: string; imports: string[] }[],
  allFiles: string[],
): Promise<{ engine: Engine; usages: SymbolUsage[] }> {
  const resolver = new Resolver(projectRoot, allFiles);
  const ts = await loadTreeSitter(projectRoot);
  let engine: Engine = "built-in";
  const usages: SymbolUsage[] = [];
  for (const imp of importers) {
    const lang = langOf(imp.path);
    const specs = new Set(imp.imports.filter((spec) => resolver.resolve(imp.path, spec, lang).includes(target)));
    if (!specs.size) continue;
    let src: string;
    try {
      src = readFileSync(join(projectRoot, imp.path), "utf8");
    } catch {
      continue;
    }
    const bindings = bindingsFor(src, lang, specs);
    if (!bindings.length) continue;
    const viaTs = ts ? await usagesTreeSitter(ts, src, lang, imp.path, bindings).catch(() => null) : null;
    if (viaTs) engine = "tree-sitter";
    usages.push(...(viaTs ?? usagesBuiltIn(src, lang, imp.path, bindings)));
  }
  usages.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.file.localeCompare(b.file) || a.line - b.line);
  return { engine, usages };
}

/** Whether the optional tree-sitter engine is installed (for `doctor`). */
export async function treeSitterAvailable(projectRoot: string): Promise<boolean> {
  return (await loadTreeSitter(projectRoot)) !== null;
}
