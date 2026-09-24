import { test } from "node:test";
import assert from "node:assert/strict";
import { Redactor, isSensitivePath } from "../src/core/redact.js";

const r = new Redactor();

test("redacts common API keys and tokens", () => {
  // Fake credentials are assembled at runtime so secret scanners never see a
  // complete token in the source (these values are not real keys).
  const fake = (prefix: string, body: string) => prefix + body;
  const cases = [
    fake("sk-ant-", "api03-abcdefghijklmnopqrstuvwxyz0123"),
    fake("sk-" + "proj-", "abcdefghijklmnopqrstuvwxyz012345"),
    fake("gh" + "p_", "abcdefghijklmnopqrstuvwxyz0123456789"),
    fake("github" + "_pat_", "11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789abcdef"),
    fake("xo" + "xb-", "1234567890-abcdefghij"),
    fake("sk_" + "live_", "abcdefghijklmnop1234"),
    fake("AK" + "IA", "ABCDEFGHIJKLMNOP"),
    fake("AI" + "za", "SyA1234567890abcdefghijklmnopqrstuv"),
    fake("np" + "m_", "abcdefghijklmnopqrstuvwxyz0123456789"),
    fake("gl" + "pat-", "abcdefghijklmnopqrst"),
    fake("ey" + "JhbGciOiJIUzI1NiJ9.", "eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
  ];
  for (const secret of cases) {
    const out = r.redact(`value ${secret} end`);
    assert.ok(!out.includes(secret), `leaked: ${secret} -> ${out}`);
    assert.ok(out.includes("[REDACTED"), out);
  }
});

test("redacts private keys, including truncated ones", () => {
  const key = ["-----BEGIN RSA ", "PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA ", "PRIVATE KEY-----"].join("");
  assert.equal(r.redact(`x ${key} y`), "x [REDACTED PRIVATE KEY] y");
  assert.equal(r.redact("-----BEGIN OPENSSH " + "PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA"), "[REDACTED PRIVATE KEY]");
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
  const out = r.redactValue({ command: "echo " + "sk-" + "ant-abcdefghijklmnopqrstuv", nested: [{ password: "plain" }], n: 3 });
  assert.equal(out.nested[0]!.password, "[REDACTED]");
  assert.ok(!JSON.stringify(out).includes("sk-ant-abcdef"));
  assert.equal(out.n, 3);
});

test("custom patterns are applied; invalid ones are ignored", () => {
  const cr = new Redactor(["acme_[a-z0-9]{8}", "(unclosed"]);
  assert.equal(cr.redact("key acme_abcd1234 here"), "key [REDACTED] here");
  assert.ok(!cr.redact("sk-" + "ant-abcdefghijklmnopqrstuv").includes("sk-ant-abcdefghijklmnop"));
});

test("identifies sensitive files", () => {
  assert.ok(isSensitivePath(".env"));
  assert.ok(isSensitivePath("config/.env.production"));
  assert.ok(isSensitivePath("certs/server.key"));
  assert.ok(!isSensitivePath(".env.example"));
  assert.ok(!isSensitivePath("src/env.ts"));
});

test("real-world CLI and payload secrets are redacted", () => {
  const cases: [string, string][] = [
    ["curl -u admin:S3cretPass https://api.example.com", "S3cretPass"],
    ["git clone https://0123456789abcdef0123456789abcdef01234567@github.com/o/r.git", "0123456789abcdef0123456789abcdef01234567"],
    ["docker login -p hunter2hunter2 registry.io", "hunter2hunter2"],
    ['docker login --password="hunter2hunter2" r.io', "hunter2hunter2"],
    ['{"password": "hunter2", "user": "bob"}', "hunter2"],
    ["redis-cli -h h -a myRedisPass123 ping", "myRedisPass123"],
    ["sshpass -p MyPassw0rd ssh user@host", "MyPassw0rd"],
    ["az login --service-principal -u app -p Az5ecretValue --tenant t", "Az5ecretValue"],
    ["x-api-key: abcdef0123456789abcdef0123456789", "abcdef0123456789abcdef0123456789"],
  ];
  for (const [input, secret] of cases) {
    const out = r.redact(input);
    assert.ok(!out.includes(secret), `leaked ${secret}: ${out}`);
  }
});

test("common commands with -p / -u flags are left alone", () => {
  for (const c of ["mkdir -p src/auth", "docker run -p 8080:80 nginx", "ssh -p 2222 user@host", 'curl -u "$USER" https://x', "git clone https://github.com/o/r.git", "psql -U app -d prod", "npm install -D vitest"]) {
    assert.equal(r.redact(c), c);
  }
});
