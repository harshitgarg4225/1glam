import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

// Boot the fully-wired Express app on an ephemeral port (file-storage mode, no
// DATABASE_URL) and exercise the real request pipeline: security headers, the
// /api auth guard, the public allowlist, the signed document route, and the
// legal pages. This catches wiring regressions that unit tests can't.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "integration-secret-32-chars-xxxxxx";
process.env.APP_BASE_URL = "http://localhost:0";

const { app } = await import("../src/index.ts");

let server: Server;
let base: string;

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(() => {
  server?.close();
});

test("GET /api/health is public and reports app status", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; checks: Record<string, string> };
  assert.equal(body.ok, true);
  assert.equal(body.checks.app, "ok");
});

test("security headers are applied", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.match(res.headers.get("content-security-policy") || "", /default-src 'self'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.ok(res.headers.get("x-request-id"), "x-request-id should be set");
});

test("authenticated API routes are blocked without a session", async () => {
  for (const path of ["/api/leads", "/api/analytics", "/api/wallet", "/api/team"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 401, `${path} should be 401 without a session`);
  }
});

test("public API routes are not blocked by the auth guard", async () => {
  // Unknown workspace → 404 from the handler, but crucially NOT 401 from the guard.
  const res = await fetch(`${base}/api/public/does-not-exist/profile`);
  assert.notEqual(res.status, 401);
});

test("signed document route rejects a bad signature", async () => {
  const res = await fetch(`${base}/d/quote/ws1/lead1?sig=tampered`);
  assert.equal(res.status, 404);
});

test("legal pages render", async () => {
  for (const [path, needle] of [
    ["/legal/privacy", "Privacy Policy"],
    ["/legal/terms", "Terms of Service"],
    ["/legal/data-deletion", "Data Deletion"],
  ] as const) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), new RegExp(needle));
  }
});
