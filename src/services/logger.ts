import { appConfig } from "../config.js";

// Lightweight structured logger. Emits one JSON object per line so log
// aggregators (Railway, Datadog, etc.) can parse fields out of the box, while
// staying dependency-free. In development it prints a compact human-readable
// line instead of JSON.
//
// captureException() is the single seam for error tracking: today it emits a
// structured "error" log; if SENTRY_DSN is set we tag the record so a future
// Sentry transport can be dropped in without touching call sites.

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
    sentry: appConfig.sentryDsn ? "configured" : undefined,
  });
}
