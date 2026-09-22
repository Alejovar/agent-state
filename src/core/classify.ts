/** Deterministic classification of repository paths by role. */

export type FileRole = "test" | "config" | "infrastructure" | "documentation" | "dependency" | "source" | "other";

const TEST = [
  /(^|\/)(__tests__|tests?|spec|specs|e2e|integration-tests?)\//i,
  /\.(test|spec|e2e)\.[cm]?[jt]sx?$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /_test\.(py|go|rb|exs?)$/i,
  /Tests?\.(cs|java|kt|swift)$/,
  /_spec\.rb$/,
];

const DEPENDENCY = [
  /(^|\/)package\.json$/,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json)$/,
  /(^|\/)requirements[^/]*\.txt$/,
  /(^|\/)(pyproject\.toml|Pipfile(\.lock)?|poetry\.lock|uv\.lock|setup\.py|setup\.cfg)$/,
  /(^|\/)go\.(mod|sum)$/,
  /(^|\/)Cargo\.(toml|lock)$/,
  /(^|\/)Gemfile(\.lock)?$/,
  /(^|\/)composer\.(json|lock)$/,
  /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/,
  /(^|\/)(mix\.exs|mix\.lock|pubspec\.yaml|Package\.swift|deno\.json)$/,
];

const INFRA = [
  /(^|\/)Dockerfile[^/]*$/i,
  /(^|\/)(docker-)?compose[^/]*\.ya?ml$/i,
  /(^|\/)\.github\/workflows\//,
  /(^|\/)\.gitlab-ci\.yml$/,
  /(^|\/)(terraform|infra|infrastructure|deploy|deployment|k8s|kubernetes|helm|charts|ansible|pulumi)\//i,
  /\.(tf|tfvars|hcl)$/,
  /(^|\/)(Procfile|fly\.toml|vercel\.json|netlify\.toml|render\.yaml|app\.yaml|serverless\.ya?ml|Jenkinsfile)$/,
];

const CONFIG = [
  /(^|\/)\.env(\.[^/]*)?$/,
  /(^|\/)\.[^/]*rc(\.[cm]?js|\.json|\.ya?ml)?$/,
  /(^|\/)[^/]*\.config\.[cm]?[jt]s$/,
  /(^|\/)(tsconfig[^/]*\.json|jsconfig\.json|\.editorconfig|\.gitignore|\.gitattributes|\.prettierrc|biome\.json|\.eslintrc[^/]*)$/,
  /(^|\/)(config|conf|settings)\//i,
  /\.(ini|cfg|conf|toml|properties)$/,
  /(^|\/)(CLAUDE|AGENTS)\.md$/,
  /(^|\/)\.claude\//,
];

const DOCS = [/\.(md|mdx|rst|adoc|txt)$/i, /(^|\/)docs?\//i, /(^|\/)(README|CHANGELOG|LICENSE|CONTRIBUTING)[^/]*$/i];

export function classify(path: string): FileRole {
  if (TEST.some((r) => r.test(path))) return "test";
  if (DEPENDENCY.some((r) => r.test(path))) return "dependency";
  if (INFRA.some((r) => r.test(path))) return "infrastructure";
  if (CONFIG.some((r) => r.test(path))) return "config";
  if (DOCS.some((r) => r.test(path))) return "documentation";
  if (/\.[A-Za-z0-9]+$/.test(path)) return "source";
  return "other";
}

export function isTestPath(path: string): boolean {
  return TEST.some((r) => r.test(path));
}
