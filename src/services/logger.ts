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

function emit(level: Level, message: string, fields?: Record<string, unknown>) {
  if (!enabled(level)) return;
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
