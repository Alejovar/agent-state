/** Minimal glob → RegExp for scope rules: `**`, `*`, `?`, `{a,b}`; POSIX separators. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, "");
  if (g.endsWith("/")) g += "**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += "(?:" + g.slice(i + 1, end).split(",").map(escape).join("|") + ")";
        i = end;
      }
    } else re += escape(c);
  }
  // A bare directory name matches everything below it.
  const dirLike = !/[*?{]/.test(g) && !/\.[^/]+$/.test(g);
  return new RegExp(`^${re}${dirLike ? "(?:/.*)?" : ""}$`);
}

function escape(s: string): string {
  return s.replace(/[.+^$()|[\]\\]/g, "\\$&");
}

export function matchesAny(path: string, globs: string[]): string | null {
  for (const g of globs) if (globToRegExp(g).test(path)) return g;
  return null;
}
