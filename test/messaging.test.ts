import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const { sendBusinessMessage } = await import("../src/services/messaging.ts");

type Captured = { url: string; body: any };

function mockFetch(): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: true, json: async () => ({}), text: async () => "" } as any;
  }) as any;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const connection: any = { channel: "whatsapp", status: "connected", accessToken: "TOK", phoneNumberId: "PN1" };

test("WhatsApp + configured template → sends via approved template", async () => {
  const fetchMock = mockFetch();
  try {
    const result = await sendBusinessMessage({
      workspace: {} as any,
      connection,
      channel: "WhatsApp",
      actorId: "+91 99999 99999",
      message: "free text fallback",
      template: { name: "send_quote", lang: "en", params: ["Aisha", "Bridal", "2026-06-15", "http://x/q"] },
    });
    assert.equal(result.via, "template");
    assert.equal(fetchMock.calls.length, 1);
    assert.match(fetchMock.calls[0].url, /PN1\/messages/);
    assert.equal(fetchMock.calls[0].body.type, "template");
    assert.equal(fetchMock.calls[0].body.template.name, "send_quote");
  } finally {
    fetchMock.restore();
  }
});

test("WhatsApp + no template → falls back to free text", async () => {
  const fetchMock = mockFetch();
  try {
    const result = await sendBusinessMessage({
      workspace: {} as any,
      connection,
      channel: "WhatsApp",
      actorId: "+919999999999",
      message: "here is your quote",
      template: { name: "", lang: "en", params: [] },
    });
    assert.equal(result.via, "freetext");
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(fetchMock.calls[0].body.type, "text");
    assert.equal(fetchMock.calls[0].body.text.body, "here is your quote");
  } finally {
    fetchMock.restore();
  }
});

test("Instagram always uses free text even when a template is given", async () => {
  const fetchMock = mockFetch();
  try {
    const igConnection: any = { channel: "instagram", status: "connected", accessToken: "TOK", instagramBusinessAccountId: "IG1", pageAccessToken: "PT" };
    const result = await sendBusinessMessage({
      workspace: {} as any,
      connection: igConnection,
      channel: "Instagram",
      actorId: "igsid-123",
      message: "hi there",
      template: { name: "send_quote", lang: "en", params: ["a"] },
    });
    assert.equal(result.via, "freetext");
    assert.equal(fetchMock.calls[0].body.message.text, "hi there");
  } finally {
    fetchMock.restore();
  }
});
