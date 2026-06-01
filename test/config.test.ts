import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars-xxxxx";

const { findDeploymentConfigErrors } = await import("../src/config.ts");

test("development never requires database or encryption key", () => {
  const errors = findDeploymentConfigErrors({
    appEnv: "development",
    databaseUrl: "",
    tokenEncryptionKey: "",
  });
  assert.deepEqual(errors, []);
});

test("production with full config is valid", () => {
  const errors = findDeploymentConfigErrors({
    appEnv: "production",
    databaseUrl: "postgres://x",
    tokenEncryptionKey: "k",
  });
  assert.deepEqual(errors, []);
});

test("production missing DATABASE_URL is fatal", () => {
  const errors = findDeploymentConfigErrors({
    appEnv: "production",
    databaseUrl: "",
    tokenEncryptionKey: "k",
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /DATABASE_URL/);
});

test("staging missing both keys reports both problems", () => {
  const errors = findDeploymentConfigErrors({
    appEnv: "staging",
    databaseUrl: "",
    tokenEncryptionKey: "",
  });
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => /DATABASE_URL/.test(e)));
  assert.ok(errors.some((e) => /TOKEN_ENCRYPTION_KEY/.test(e)));
});
