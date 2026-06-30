// Operational data store (leads, bookings) — the Postgres-backed system of
// record that replaces Google Sheets on the hot path.
//
// Why this exists: every booking/lead/payment write used to go to the artist's
// Google Sheet, so a single expired Google token would fail a core money action
// ("Google access issue — please reconnect…"), and all artists shared one Google
// Cloud project's Sheets quota (~5-8 req/s) — a hard scaling ceiling. With
// OPERATIONAL_STORE="dual"/"postgres", Postgres becomes authoritative and the
// sheet is demoted to a best-effort mirror, so those failures disappear.
//
// This module is intentionally storage-only (no Sheets/record-parsing knowledge)
// so it never imports booking.ts at runtime — booking.ts owns the migration
// orchestration and Sheets mirroring and calls into here. Record shapes come in
// as type-only imports (erased at runtime, so no import cycle).

import { appConfig } from "../config.js";
import { ensurePostgres, getPool, hasPostgres } from "./database.js";
import type { BookingRecord, LeadRecord } from "./booking.js";

export type StoreMode = "sheets" | "dual" | "postgres";

// The effective mode. "dual"/"postgres" only take effect when a database is
// actually configured; otherwise we transparently stay on the Sheets path so
// dev/file-mode and the test suite behave exactly as before.
export function storeMode(): StoreMode {
  const mode = appConfig.operationalStore as StoreMode;
  if ((mode === "dual" || mode === "postgres") && hasPostgres()) return mode;
  return "sheets";
}

// True when Postgres is the source of truth for reads and writes.
export function pgActive(): boolean {
  return storeMode() !== "sheets";
}

// True when writes should also be mirrored (best-effort) to the Google Sheet so
// the artist's familiar sheet stays current and rollback to "sheets" is lossless.
export function mirrorToSheets(): boolean {
  return storeMode() === "dual";
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listLeads(workspaceId: string): Promise<LeadRecord[]> {
  await ensurePostgres();
  const res = await getPool().query<{ data: LeadRecord }>(
    `SELECT data FROM op_leads WHERE workspace_id = $1`,
    [workspaceId],
  );
  return res.rows.map((row) => row.data);
}

export async function findLead(workspaceId: string, leadId: string): Promise<LeadRecord | null> {
  await ensurePostgres();
  const res = await getPool().query<{ data: LeadRecord }>(
    `SELECT data FROM op_leads WHERE workspace_id = $1 AND lead_id = $2 LIMIT 1`,
    [workspaceId, leadId],
  );
  return res.rows[0]?.data ?? null;
}

export async function listBookings(workspaceId: string): Promise<BookingRecord[]> {
  await ensurePostgres();
  const res = await getPool().query<{ data: BookingRecord }>(
    `SELECT data FROM op_bookings WHERE workspace_id = $1`,
    [workspaceId],
  );
  return res.rows.map((row) => row.data);
}

export async function findBooking(workspaceId: string, bookingId: string): Promise<BookingRecord | null> {
  await ensurePostgres();
  const res = await getPool().query<{ data: BookingRecord }>(
    `SELECT data FROM op_bookings WHERE workspace_id = $1 AND booking_id = $2 LIMIT 1`,
    [workspaceId, bookingId],
  );
  return res.rows[0]?.data ?? null;
}

// ── Writes (upsert: covers both create and in-place update) ──────────────────

export async function upsertLead(workspaceId: string, lead: LeadRecord): Promise<void> {
  await ensurePostgres();
  await getPool().query(
    `INSERT INTO op_leads (workspace_id, lead_id, data, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (workspace_id, lead_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [workspaceId, lead.leadId, JSON.stringify(lead)],
  );
}

export async function upsertBooking(workspaceId: string, booking: BookingRecord): Promise<void> {
  await ensurePostgres();
  await getPool().query(
    `INSERT INTO op_bookings (workspace_id, booking_id, data, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (workspace_id, booking_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [workspaceId, booking.bookingId, JSON.stringify(booking)],
  );
}

// ── Backfill helpers (insert-if-absent, so re-running is a no-op) ─────────────

export async function bulkInsertLeadsIfAbsent(workspaceId: string, leads: LeadRecord[]): Promise<void> {
  if (!leads.length) return;
  await ensurePostgres();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const lead of leads) {
      if (!lead.leadId) continue;
      await client.query(
        `INSERT INTO op_leads (workspace_id, lead_id, data, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (workspace_id, lead_id) DO NOTHING`,
        [workspaceId, lead.leadId, JSON.stringify(lead)],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function bulkInsertBookingsIfAbsent(workspaceId: string, bookings: BookingRecord[]): Promise<void> {
  if (!bookings.length) return;
  await ensurePostgres();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const booking of bookings) {
      if (!booking.bookingId) continue;
      await client.query(
        `INSERT INTO op_bookings (workspace_id, booking_id, data, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (workspace_id, booking_id) DO NOTHING`,
        [workspaceId, booking.bookingId, JSON.stringify(booking)],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ── Migration markers (one-time per workspace+entity) ────────────────────────

export async function hasMigrationMarker(workspaceId: string, entity: "leads" | "bookings"): Promise<boolean> {
  await ensurePostgres();
  const res = await getPool().query(
    `SELECT 1 FROM op_migrated WHERE workspace_id = $1 AND entity = $2 LIMIT 1`,
    [workspaceId, entity],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function writeMigrationMarker(workspaceId: string, entity: "leads" | "bookings"): Promise<void> {
  await ensurePostgres();
  await getPool().query(
    `INSERT INTO op_migrated (workspace_id, entity) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [workspaceId, entity],
  );
}
