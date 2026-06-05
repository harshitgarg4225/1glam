import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars-xxxxx";

const { fetchWithTimeout, fetchWithRetry } = await import("../src/services/http.ts");

// Spins up a throwaway local server whose behavior is controlled per-test.
function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

test("fetchWithTimeout returns the response for a fast endpoint", async () => {
  const srv = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  try {
    const res = await fetchWithTimeout(srv.url, {}, 1000);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  } finally {
    srv.close();
  }
});

test("fetchWithTimeout aborts and throws a timeout error for a slow endpoint", async () => {
  const srv = await startServer((_req, res) => {
    // Never respond within the timeout window.
    setTimeout(() => res.end("late"), 2000).unref();
  });
  try {
    await assert.rejects(
      () => fetchWithTimeout(srv.url, {}, 100),
      /timed out after 100ms/,
    );
  } finally {
    srv.close();
  }
});

test("fetchWithRetry retries on 5xx and eventually succeeds", async () => {
  let calls = 0;
  const srv = await startServer((_req, res) => {
    calls += 1;
    if (calls < 3) {
      res.writeHead(503);
      res.end("try later");
    } else {
      res.writeHead(200);
      res.end("recovered");
    }
  });
  try {
    const res = await fetchWithRetry(srv.url, {}, { retries: 3, baseDelayMs: 1, timeoutMs: 1000 });
    assert.equal(res.status, 200);
    assert.equal(calls, 3, "should have retried twice before the success");
  } finally {
    srv.close();
  }
});
