/**
 * Secret redaction. Every string that reaches the event store passes through here.
 *
 * The goal is to never persist credentials by accident. False positives are
 * acceptable; false negatives are not, so patterns lean aggressive.
 */

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  /** Replacement; `$1`-style groups are supported to keep non-secret prefixes. */
  replace?: string;
}

const R = "[REDACTED]";

export const BUILTIN_RULES: RedactionRule[] = [
  {
    name: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: `[REDACTED PRIVATE KEY]`,
  },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "openai-key", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { name: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { name: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { name: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "stripe-key", pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "huggingface-token", pattern: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { name: "sendgrid-key", pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    name: "bearer-token",
    pattern: /\b(Bearer|Token|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: `$1 ${R}`,
  },
  {
    name: "url-credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi,
    replace: `$1$2:${R}@`,
  },
  {
    // KEY=value / KEY: value where KEY looks sensitive (env files, CLI flags, YAML).
    name: "sensitive-assignment",
    pattern:
      /\b([A-Za-z0-9_.-]*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?|AUTH|SESSION[_-]?KEY|CLIENT[_-]?SECRET|DATABASE_URL|DB_URL|CONNECTION_STRING|DSN)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)(?!\[REDACTED|(?:Bearer|Basic|Token)\b)([^\s"'`,;]{3,})\3/gi,
    replace: `$1$2$3${R}$3`,
  },
  {
    // "password": "…" in JSON / JS objects
    name: "json-sensitive-field",
    pattern: /("(?:[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)[A-Za-z0-9_.-]*)"\s*:\s*")([^"]{3,})"/gi,
    replace: `$1${R}"`,
  },
  {
    // curl -u user:password / --user user:password
    name: "curl-user",
    pattern: /((?:^|\s)(?:-u|--user)[\s=]+["']?[^\s:"']+:)([^\s"']+)/g,
    replace: `$1${R}`,
  },
  {
    // https://<token>@host (token used as the whole userinfo)
    name: "url-token",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([A-Za-z0-9_\-]{20,})@/gi,
    replace: `$1${R}@`,
  },
  {
    // registry logins: docker/podman/helm/oras/nerdctl … login -p|--password <secret>
    name: "registry-login",
    pattern: /(\b(?:docker|podman|nerdctl|helm|oras|skopeo)\b[^\n|;&]*\blogin\b[^\n|;&]*?\s(?:-p|--password)[\s=]+)(["']?)[^\s"']+\2/g,
    replace: `$1$2${R}$2`,
  },
  {
    // sshpass -p <password>, az login … -p <password>, redis-cli -a <password>
    name: "cli-password",
    pattern: /(\bsshpass\s+-p\s*|\baz\b[^\n|;&]*\blogin\b[^\n|;&]*?\s-p\s+|\bredis-cli\b[^\n|;&]*?\s-a\s+)(["']?)[^\s"']+\2/g,
    replace: `$1$2${R}$2`,
  },
  {
    name: "password-flag",
    pattern: /(--?(?:password|passwd|token|secret|api-key|apikey)(?:=|\s+))(["']?)[^\s"']+\2/gi,
    replace: `$1$2${R}$2`,
  },
  {
    // mysql -pSECRET style
    name: "mysql-inline-password",
    pattern: /(\bmysql(?:dump|admin)?\b[^\n]*?\s-p)(?!\s)([^\s]+)/g,
    replace: `$1${R}`,
  },
];

export class Redactor {
  private readonly rules: RedactionRule[];

  constructor(customPatterns: string[] = []) {
    const custom: RedactionRule[] = [];
    for (const [i, src] of customPatterns.entries()) {
      try {
        custom.push({ name: `custom-${i}`, pattern: new RegExp(src, "g") });
      } catch {
        // An invalid user pattern must not disable redaction as a whole.
      }
    }
    this.rules = [...BUILTIN_RULES, ...custom];
  }

  redact(input: string): string {
    let out = input;
    for (const rule of this.rules) {
      rule.pattern.lastIndex = 0;
      out = out.replace(rule.pattern, rule.replace ?? R);
    }
    return out;
  }

  /** Deep-redacts every string in a JSON-compatible value. Keys with sensitive names are fully masked. */
  redactValue<T>(value: T): T {
    return this.walk(value, undefined) as T;
  }

  private walk(value: unknown, key: string | undefined): unknown {
    if (typeof value === "string") {
      if (key && SENSITIVE_KEY.test(key) && value.length > 0) return R;
      return this.redact(value);
    }
    if (Array.isArray(value)) return value.map((v) => this.walk(v, undefined));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.walk(v, k);
      return out;
    }
    return value;
  }
}

const SENSITIVE_KEY = /^(?:password|passwd|secret|token|api_?key|access_?token|refresh_?token|client_?secret|private_?key|authorization|cookie)$/i;

/** True if the path usually holds secrets; such files' contents are never recorded. */
export function isSensitivePath(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? path;
  return (
    /^\.env(?:\..*)?$/i.test(base) && !/\.(?:example|sample|template|dist)$/i.test(base)
  ) || /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(base) || /^(?:id_rsa|id_ed25519|id_ecdsa|credentials|\.npmrc|\.pypirc|\.netrc)$/i.test(base);
}
