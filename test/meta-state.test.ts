import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

// Config reads env at import time, so set required vars before importing.
const SESSION_SECRET = "test-session-secret-32chars-xxxxx";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || SESSION_SECRET;
process.env.APP_BASE_URL = "https://app.example.com";
process.env.META_APP_ID = "test-meta-app-id";
process.env.META_APP_SECRET = "test-meta-app-secret";

const { getMetaConnectUrl, parseMetaState } = await import("../src/services/meta.ts");

const SECRET = process.env.SESSION_SECRET as string;

function stateFromConnectUrl(input: { workspaceEmail: string; channel: "instagram" | "whatsapp" }): string {
  const url = new URL(getMetaConnectUrl(input));
  return url.searchParams.get("state") || "";
}

// Mirror the server's signing so the test can craft both valid and malicious states.
function sign(payloadB64: string): string {
  return createHmac("sha256", SECRET).update(payloadB64).digest("base64url");
}
function encode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

test("a freshly built Meta state round-trips back to its email and channel", () => {
  const state = stateFromConnectUrl({ workspaceEmail: "artist@example.com", channel: "whatsapp" });
  const parsed = parseMetaState(state);
  assert.equal(parsed.workspaceEmail, "artist@example.com");
  assert.equal(parsed.channel, "whatsapp");
});

test("a state with the email tampered (but old signature) is rejected", () => {
  const state = stateFromConnectUrl({ workspaceEmail: "victim@example.com", channel: "instagram" });
  const [payload, sig] = state.split(".");
  // Swap the email in the payload but keep the original signature.
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const forgedPayload = encode({ ...decoded, workspaceEmail: "attacker@example.com" });
  assert.throws(() => parseMetaState(`${forgedPayload}.${sig}`), /signature/i);
});

test("an unsigned (legacy-style) state is rejected", () => {
  const bare = encode({ workspaceEmail: "attacker@example.com", channel: "whatsapp", ts: Date.now() });
  assert.throws(() => parseMetaState(bare), /Invalid Meta state/);
});

test("a correctly signed but expired state is rejected", () => {
  const stalePayload = encode({
    workspaceEmail: "artist@example.com",
    channel: "whatsapp",
    ts: Date.now() - 16 * 60 * 1000, // 16 min ago, outside the 15-min window
  });
  const validlySignedButStale = `${stalePayload}.${sign(stalePayload)}`;
  assert.throws(() => parseMetaState(validlySignedButStale), /expired/i);
});

test("a self-signed fresh state forged with the real secret still parses (sanity check on the test's signer)", () => {
  const payload = encode({ workspaceEmail: "artist@example.com", channel: "instagram", ts: Date.now() });
  const parsed = parseMetaState(`${payload}.${sign(payload)}`);
  assert.equal(parsed.workspaceEmail, "artist@example.com");
});
