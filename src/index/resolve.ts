import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { join } from "node:path";

/** Resolves raw import specifiers to project files. Unresolvable/external specifiers return null. */
export class Resolver {
  private readonly files: Set<string>;
  private readonly dirs = new Map<string, string[]>();
  private goModule: string | null = null;
  private tsPaths: { prefix: string; targets: string[] }[] = [];
  private tsBase = "";
  private pyRoots: string[] = [""];

  constructor(root: string, files: Iterable<string>) {
    this.files = new Set(files);
    for (const f of this.files) {
      const d = posix.dirname(f);
      const list = this.dirs.get(d) ?? [];
      list.push(f);
      this.dirs.set(d, list);
    }
    const gomod = join(root, "go.mod");
    if (existsSync(gomod)) this.goModule = /^module\s+(\S+)/m.exec(readFileSync(gomod, "utf8"))?.[1] ?? null;
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const p = join(root, name);
      if (!existsSync(p)) continue;
      try {
        const raw = readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1");
        const cfg = JSON.parse(raw) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
        this.tsBase = posix.normalize(cfg.compilerOptions?.baseUrl ?? ".").replace(/^\.$/, "");
        for (const [k, v] of Object.entries(cfg.compilerOptions?.paths ?? {})) {
          this.tsPaths.push({ prefix: k.replace(/\*$/, ""), targets: v.map((t) => t.replace(/\*$/, "")) });
        }
      } catch {
        // tolerate unusual tsconfig syntax
      }
      break;
    }
    if (this.files.has("src/__init__.py") === false && [...this.dirs.keys()].some((d) => d.startsWith("src/"))) this.pyRoots.push("src");
  }

  private tryFile(base: string, exts: string[]): string | null {
    const b = posix.normalize(base).replace(/^\.\//, "");
    if (this.files.has(b)) return b;
    for (const e of exts) if (this.files.has(b + e)) return b + e;
    for (const e of exts) if (this.files.has(`${b}/index${e}`)) return `${b}/index${e}`;
    return null;
  }

  resolve(from: string, spec: string, lang: string): string[] {
    const dir = posix.dirname(from);
    switch (lang) {
      case "typescript":
      case "javascript":
      case "vue":
      case "svelte": {
        const exts = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".json", ".d.ts"];
        const candidates: string[] = [];
        if (spec.startsWith(".")) candidates.push(posix.join(dir, spec));
        else {
          for (const p of this.tsPaths) {
            if (spec.startsWith(p.prefix)) for (const t of p.targets) candidates.push(posix.join(this.tsBase, t + spec.slice(p.prefix.length)));
          }
          if (this.tsBase && !spec.startsWith("@") ) candidates.push(posix.join(this.tsBase, spec));
        }
        for (const cand of candidates) {
          const hit = this.tryFile(cand, exts) ?? this.tryFile(cand.replace(/\.(m|c)?js$/, ""), exts);
          if (hit) return [hit];
        }
        return [];
      }
      case "python": {
        if (spec.startsWith(".")) {
          const dots = /^\.+/.exec(spec)![0].length;
          let base = dir;
          for (let i = 1; i < dots; i++) base = posix.dirname(base);
          const rest = spec.slice(dots).replace(/\./g, "/");
          const p = rest ? posix.join(base, rest) : base;
          const hit = this.tryFile(p, [".py"]) ?? this.tryFile(`${p}/__init__`, [".py"]);
          return hit ? [hit] : [];
        }
        const rel = spec.replace(/\./g, "/");
        for (const r of this.pyRoots) {
          const p = r ? `${r}/${rel}` : rel;
          const hit = this.tryFile(p, [".py"]) ?? this.tryFile(`${p}/__init__`, [".py"]);
          if (hit) return [hit];
        }
        return [];
      }
      case "go": {
        if (!this.goModule || !spec.startsWith(this.goModule)) return [];
        const d = spec.slice(this.goModule.length).replace(/^\//, "") || ".";
        return (this.dirs.get(d === "." ? "." : d) ?? []).filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"));
      }
      case "rust": {
        if (spec.startsWith("mod:")) {
          const name = spec.slice(4);
          const stem = posix.basename(from, ".rs");
          const base = ["main", "lib", "mod"].includes(stem) ? dir : posix.join(dir, stem);
          const hit = this.tryFile(posix.join(base, name), [".rs"]) ?? this.tryFile(posix.join(base, name, "mod"), [".rs"]);
          return hit ? [hit] : [];
        }
        const parts = spec.split("::");
        const head = parts.shift();
        let base = head === "crate" ? this.crateRoot(from) : head === "super" ? posix.dirname(dir) : dir;
        let best: string | null = null;
        for (const part of parts) {
          base = posix.join(base, part);
          const hit = this.tryFile(base, [".rs"]) ?? this.tryFile(posix.join(base, "mod"), [".rs"]);
          if (hit) best = hit;
          else break;
        }
        return best ? [best] : [];
      }
      case "java":
      case "kotlin": {
        if (!spec.startsWith("jvm:")) return [];
        const path = spec.slice(4).replace(/\./g, "/");
        for (const f of this.files) if (f.endsWith(`${path}.java`) || f.endsWith(`${path}.kt`)) return [f];
        return [];
      }
      default: {
        if (!spec.startsWith(".")) return [];
        const hit = this.tryFile(posix.join(dir, spec), [".rb", ".php", ".h", ".hpp"]);
        return hit ? [hit] : [];
      }
    }
  }

  private crateRoot(from: string): string {
    const idx = from.indexOf("src/");
    return idx >= 0 ? from.slice(0, idx + 3) : "src";
  }
}
