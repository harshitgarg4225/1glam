// Shared fetch wrapper with a hard timeout so a hung upstream (Google, Meta,
// Grok, Razorpay, Leegality, Maps) can never block a request — and therefore a
// worker — indefinitely. Uses AbortController under the hood. On timeout it
// throws a clear, user-safe Error rather than leaving the promise pending.
//
// fetchWithRetry adds a small bounded retry for transient failures (network
// errors, timeouts, 429/5xx). Only use it for idempotent calls (GETs, or
// providers that dedupe by an idempotency key) — never for raw POSTs that could
// double-charge or double-send.

const DEFAULT_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request to ${safeHost(url)} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: { timeoutMs?: number; retries?: number; baseDelayMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 2, baseDelayMs = 300 } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, init, timeoutMs);
      // Retry only on transient upstream conditions.
      if (response.status === 429 || response.status >= 500) {
        if (attempt < retries) {
          await delay(baseDelayMs * 2 ** attempt);
          continue;
        }
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await delay(baseDelayMs * 2 ** attempt);
        continue;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Upstream request failed.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "upstream";
  }
}
