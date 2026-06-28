import { test } from "node:test";
import assert from "node:assert/strict";

// reminders.ts → config.ts requires these at import time.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars-xxxxx";

const { daysSinceIso, statusAnchorIso } = await import("../src/services/reminders.ts");

const NOW = new Date("2026-06-20T12:00:00Z");

test("daysSinceIso floors whole UTC days since a timestamp", () => {
  assert.equal(daysSinceIso("2026-06-19T12:00:00Z", NOW), 1);
  assert.equal(daysSinceIso("2026-06-15T00:00:00Z", NOW), 5);
  assert.equal(daysSinceIso("2026-06-20T11:00:00Z", NOW), 0);
});

test("daysSinceIso returns null for empty or unparseable input", () => {
  assert.equal(daysSinceIso("", NOW), null);
  assert.equal(daysSinceIso("not-a-date", NOW), null);
});

test("statusAnchorIso prefers statusChangedAt", () => {
  assert.equal(
    statusAnchorIso({ statusChangedAt: "2026-06-18T09:30:00Z", eventDate: "2026-06-01" }),
    "2026-06-18T09:30:00Z",
  );
});

test("statusAnchorIso falls back to the event date for legacy rows", () => {
  assert.equal(
    statusAnchorIso({ statusChangedAt: "", eventDate: "2026-06-01" }),
    "2026-06-01T00:00:00Z",
  );
  assert.equal(statusAnchorIso({ statusChangedAt: "", eventDate: "" }), "");
});

test("review/payment timing: a booking 5 days into a status fires both the 1- and 5-day windows", () => {
  // statusChangedAt 5 days ago → elapsed 5 → both paystatus1 (>=1) and paystatus5 (>=5) eligible.
  const anchor = statusAnchorIso({ statusChangedAt: "2026-06-15T12:00:00Z", eventDate: "2026-06-10" });
  const elapsed = daysSinceIso(anchor, NOW);
  assert.equal(elapsed, 5);
  assert.ok(elapsed !== null && elapsed >= 5); // 5-day reminder due
  assert.ok(elapsed !== null && elapsed >= 1); // 1-day reminder window also passed
});
