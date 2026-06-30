import { appConfig } from "../config.js";
import * as Sentry from "@sentry/node";

// Lightweight structured logger. Emits one JSON object per line so log
// aggregators (Railway, Datadog, etc.) can parse fields out of the box, while
// staying dependency-free. In development it prints a compact human-readable
// line instead of JSON.
//
// captureException() is the single seam for error tracking: it always emits a
// structured "error" log, and additionally forwards to Sentry when SENTRY_DSN
// is configured. Sentry is initialised lazily and is a no-op otherwise, so it
// adds zero cost and zero config burden until you opt in.

let sentryReady = false;
if (appConfig.sentryDsn) {
  try {
    Sentry.init({
      dsn: appConfig.sentryDsn,
      environment: appConfig.appEnv,
      tracesSampleRate: 0,
    });
    sentryReady = true;
  } catch {
    // Bad DSN shouldn't take the app down — fall back to log-only.
    sentryReady = false;
  }
}

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function enabled(level: Level): boolean {
  return LEVELS[level] >= LEVELS[appConfig.logLevel as Level];
}

// Privacy: structured logs are retained by aggregators, so client PII and any
// secret that slips into a context field must not land there in the clear.
// We mask emails (a***@domain), keep only the last 4 digits of phone-like
// numbers, and fully redact anything whose key looks like a credential.
const SECRET_KEY = /(token|secret|key|password|authorization|cookie|otp)/i;
function scrubValue(key: string, value: unknown): unknown {
  if (value == null) return value;
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    let out = value.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+)/g, "$1***$2");
    out = out.replace(/(\+?\d[\d\s-]{6,}\d)/g, (m) => {
      const digits = m.replace(/\D/g, "");
      return digits.length >= 7 ? `***${digits.slice(-4)}` : m;
    });
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => scrubValue(key, v));
  if (typeof value === "object") return scrubFields(value as Record<string, unknown>);
  return value;
}
export function scrubFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = scrubValue(k, v);
  return out;
}

function emit(level: Level, message: string, rawFields?: Record<string, unknown>) {
  if (!enabled(level)) return;
  const fields = rawFields ? scrubFields(rawFields) : rawFields;
  const record = {
    ts: new Date().toISOString(),
    level,
    env: appConfig.appEnv,
    message,
    ...fields,
  };

  const line =
    appConfig.appEnv === "development"
      ? `[${level}] ${message}${fields ? " " + JSON.stringify(fields) : ""}`
      : JSON.stringify(record);

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => emit("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit("error", message, fields),
};

// Normalises an unknown thrown value and records it as a structured error.
// Returns nothing; safe to call from anywhere (never throws).
export function captureException(error: unknown, context?: Record<string, unknown>) {
  const err = error instanceof Error ? error : new Error(String(error));
  emit("error", err.message, {
    ...context,
    errorName: err.name,
    stack: err.stack,
    sentry: sentryReady ? "sent" : undefined,
  });
  if (sentryReady) {
    Sentry.captureException(err, context ? { extra: context } : undefined);
  }
}
