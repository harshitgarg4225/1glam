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
      throw new Error(`Request to ${safeHost(url)} timed out after ${timeoutMs}ms.`, {
        cause: error,
      });
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

// SSRF guard for fetching user-supplied URLs (e.g. an artist's logo URL embedded
// in a PDF). Rejects anything that isn't a plain http(s) URL pointing at a public
// host — blocking loopback, link-local (incl. the 169.254.169.254 cloud metadata
// endpoint) and RFC1918 private ranges. Hostnames that aren't IP literals are
// allowed (we don't resolve DNS here); this stops the trivial, high-impact cases.
// True when an IP string is loopback / private / link-local / cloud-metadata /
// multicast-reserved — i.e. must never be reachable via a user-supplied URL.
export function isPrivateIp(ip: string): boolean {
  const host = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    return true;
  }
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a >= 224) return true; // multicast / reserved
  }
  return false;
}

export function isPublicHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return false;
  }
  return !isPrivateIp(host); // rejects IP-LITERAL private hosts
}

// SSRF-hardened variant: the sync check only catches IP-literal hosts, so a
// domain that RESOLVES to a private/metadata IP (DNS-rebinding, internal DNS)
// would slip through. This resolves the hostname and rejects if ANY resolved
// address is private. Fails closed on a DNS error. (A rebind race between this
// check and the actual fetch remains — pin to the validated IP if that matters.)
export async function isPublicHttpUrlResolved(raw: string): Promise<boolean> {
  if (!isPublicHttpUrl(raw)) return false;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return true; // IP literal, already covered
  try {
    const { lookup } = await import("node:dns/promises");
    const results = await lookup(host, { all: true });
    if (!results.length) return false;
    return results.every((r) => !isPrivateIp(r.address));
  } catch {
    return false;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "upstream";
  }
}
