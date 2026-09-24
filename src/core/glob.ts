/**
 * Minimal glob → RegExp for scope rules: `**`, `*`, `?`, `{a,b}`. Follows
 * .gitignore conventions: "/" or "./" anchors to the root, a pattern without
 * "/" matches at any depth, a trailing "/" means "everything below".
 */
export function globToRegExp(glob: string): RegExp {
  // Accept Windows separators and a leading "/" or "./" (both mean "from the project root").
  let g = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const anchored = g.startsWith("/");
  g = g.replace(/^\/+/, "");
  if (g.endsWith("/")) g += "**";
  // A bare name without wildcards or extension ("database") means that directory and everything below.
  const dirLike = !/[*?{]/.test(g) && !/\.[^/]+$/.test(g);
  // Like .gitignore: a pattern with no "/" (e.g. "*.md", "database") matches at any depth.
  if (!anchored && !g.includes("/") && g !== "**") g = "**/" + g;
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
  return new RegExp(`^${re}${dirLike ? "(?:/.*)?" : ""}$`);
}

function escape(s: string): string {
  return s.replace(/[.+^$()|[\]\\]/g, "\\$&");
}

export function matchesAny(path: string, globs: string[]): string | null {
  for (const g of globs) if (globToRegExp(g).test(path)) return g;
  return null;
}
