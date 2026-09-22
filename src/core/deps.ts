/** Extracts declared dependencies from common manifests so changes can be diffed deterministically. */

export type DepMap = Map<string, string>;

export const MANIFESTS = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|composer\.json)$/;

export function parseManifest(path: string, content: string): DepMap {
  const deps: DepMap = new Map();
  const base = path.split("/").pop() ?? path;
  try {
    if (base === "package.json" || base === "composer.json") {
      const j = JSON.parse(content) as Record<string, Record<string, string> | undefined>;
      for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "require", "require-dev"]) {
        for (const [k, v] of Object.entries(j[section] ?? {})) deps.set(k, String(v));
      }
    } else if (base.startsWith("requirements")) {
      for (const raw of content.split("\n")) {
        const line = raw.replace(/#.*/, "").trim();
        if (!line || line.startsWith("-")) continue;
        const m = /^([A-Za-z0-9_.\-[\]]+)\s*(.*)$/.exec(line);
        if (m) deps.set(m[1]!.toLowerCase(), m[2]!.trim() || "*");
      }
    } else if (base === "pyproject.toml") {
      const arr = /\bdependencies\s*=\s*\[([\s\S]*?)\]/g;
      for (const m of content.matchAll(arr)) {
        for (const s of m[1]!.matchAll(/["']([A-Za-z0-9_.\-[\]]+)\s*([^"']*)["']/g)) deps.set(s[1]!.toLowerCase(), s[2]!.trim() || "*");
      }
      const poetry = /\[tool\.poetry\.(?:dev-)?dependencies\]([\s\S]*?)(?=\n\[|$)/g;
      for (const m of content.matchAll(poetry)) {
        for (const s of m[1]!.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+)$/gm)) if (s[1] !== "python") deps.set(s[1]!.toLowerCase(), s[2]!.trim());
      }
    } else if (base === "go.mod") {
      for (const m of content.matchAll(/^\s*(?:require\s+)?([a-z0-9.\-]+\.[a-z]{2,}\/[^\s]+)\s+(v[^\s]+)/gm)) deps.set(m[1]!, m[2]!);
    } else if (base === "Cargo.toml") {
      const sec = /\[(?:dev-|build-)?dependencies\]([\s\S]*?)(?=\n\[|$)/g;
      for (const m of content.matchAll(sec)) {
        for (const s of m[1]!.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+)$/gm)) deps.set(s[1]!, s[2]!.trim());
      }
    } else if (base === "Gemfile") {
      for (const m of content.matchAll(/^\s*gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/gm)) deps.set(m[1]!, m[2] ?? "*");
    }
  } catch {
    // Malformed manifest: report nothing rather than guess.
  }
  return deps;
}

export interface DepDiff {
  manifest: string;
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffDeps(manifest: string, before: string | null, after: string | null): DepDiff | null {
  const a = before ? parseManifest(manifest, before) : new Map<string, string>();
  const b = after ? parseManifest(manifest, after) : new Map<string, string>();
  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const changed = [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k)).map((k) => `${k} ${a.get(k)} → ${b.get(k)}`);
  if (!added.length && !removed.length && !changed.length) return null;
  return { manifest, added, removed, changed };
}
