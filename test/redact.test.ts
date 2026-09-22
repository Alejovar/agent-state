import { test } from "node:test";
import assert from "node:assert/strict";
import { Redactor, isSensitivePath } from "../src/core/redact.js";

const r = new Redactor();

test("redacts common API keys and tokens", () => {
  const cases = [
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
    "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789abcdef",
    "xoxb-1234567890-abcdefghij",
    "sk_live_abcdefghijklmnop1234",
    "AKIAABCDEFGHIJKLMNOP",
    "AIzaSyA1234567890abcdefghijklmnopqrstuv",
    "npm_abcdefghijklmnopqrstuvwxyz0123456789",
    "glpat-abcdefghijklmnopqrst",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ];
  for (const secret of cases) {
    const out = r.redact(`value ${secret} end`);
    assert.ok(!out.includes(secret), `leaked: ${secret} -> ${out}`);
    assert.ok(out.includes("[REDACTED"), out);
  }
});

test("redacts private keys, including truncated ones", () => {
  const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----";
  assert.equal(r.redact(`x ${key} y`), "x [REDACTED PRIVATE KEY] y");
  assert.equal(r.redact("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA"), "[REDACTED PRIVATE KEY]");
});

test("redacts bearer tokens, URL credentials and connection strings", () => {
  assert.equal(r.redact("curl -H 'Authorization: Bearer abcdef123456789xyz'"), "curl -H 'Authorization: Bearer [REDACTED]'");
  assert.equal(r.redact("postgres://admin:hunter2@db.example.com:5432/app"), "postgres://admin:[REDACTED]@db.example.com:5432/app");
  assert.ok(!r.redact("DATABASE_URL=mysql://u:p4ss@h/db").includes("p4ss"));
});

test("redacts sensitive environment assignments and flags", () => {
  assert.equal(r.redact("export STRIPE_SECRET=abc123def"), "export STRIPE_SECRET=[REDACTED]");
  assert.equal(r.redact('DB_PASSWORD="s3cr3t!"'), 'DB_PASSWORD="[REDACTED]"');
  assert.equal(r.redact("api_key: qwertyuiop"), "api_key: [REDACTED]");
  assert.ok(!r.redact("mysql -u root -pS3cret db").includes("S3cret"));
  assert.ok(!r.redact("tool --password hunter22 --verbose").includes("hunter22"));
  assert.ok(!r.redact("login --token=abcd1234").includes("abcd1234"));
});

test("leaves ordinary text alone", () => {
  const text = "Implement Google OAuth; run npm test; edit src/auth/session.ts (token expiry logic)";
  assert.equal(r.redact(text), text);
});

test("deep-redacts objects and masks sensitive keys", () => {
  const out = r.redactValue({ command: "echo sk-ant-abcdefghijklmnopqrstuv", nested: [{ password: "plain" }], n: 3 });
  assert.equal(out.nested[0]!.password, "[REDACTED]");
  assert.ok(!JSON.stringify(out).includes("sk-ant-abcdef"));
  assert.equal(out.n, 3);
});

test("custom patterns are applied; invalid ones are ignored", () => {
  const cr = new Redactor(["acme_[a-z0-9]{8}", "(unclosed"]);
  assert.equal(cr.redact("key acme_abcd1234 here"), "key [REDACTED] here");
  assert.ok(!cr.redact("sk-ant-abcdefghijklmnopqrstuv").includes("sk-ant-abcdefghijklmnop"));
});

test("identifies sensitive files", () => {
  assert.ok(isSensitivePath(".env"));
  assert.ok(isSensitivePath("config/.env.production"));
  assert.ok(isSensitivePath("certs/server.key"));
  assert.ok(!isSensitivePath(".env.example"));
  assert.ok(!isSensitivePath("src/env.ts"));
});
