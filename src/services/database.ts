import { promises as fs } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { appConfig } from "../config.js";
import { decryptWorkspaceSecrets, encryptWorkspaceSecrets } from "./crypto.js";
import { TtlCache } from "./cache.js";
import { logger } from "./logger.js";
import type { MetaChannel, WorkspaceRecord } from "../types.js";

// Workspace records are read on virtually every API request (auth guard →
// getWorkspaceByEmail) but written rarely (config saves, token refreshes).
// A short TTL plus invalidation-on-write keeps DB round-trips off the hot
// path without risking stale reads after a save.
const WORKSPACE_CACHE_TTL_MS = 30_000;
const workspaceByEmailCache = new TtlCache<WorkspaceRecord | null>(WORKSPACE_CACHE_TTL_MS);
const workspaceByIdCache = new TtlCache<WorkspaceRecord | null>(WORKSPACE_CACHE_TTL_MS);

function invalidateWorkspaceCache(record?: { email?: string; workspaceId?: string }) {
  if (record?.email) workspaceByEmailCache.delete(normalizeEmail(record.email));
  if (record?.workspaceId) workspaceByIdCache.delete(record.workspaceId);
  if (!record) {
    workspaceByEmailCache.clear();
    workspaceByIdCache.clear();
  }
}

// Persistence boundary helpers: records are encrypted on the way to storage and
// decrypted on the way back, so the rest of the app only ever sees plaintext
// tokens and storage only ever holds ciphertext.
function toStored(record: WorkspaceRecord): WorkspaceRecord {
  return encryptWorkspaceSecrets(record);
}
function fromStored(record: WorkspaceRecord): WorkspaceRecord {
  return decryptWorkspaceSecrets(record);
}

type WorkspaceDb = {
  workspaces: WorkspaceRecord[];
};

let pool: Pool | null = null;
let postgresReady: Promise<void> | null = null;

export function hasPostgres() {
  return Boolean(appConfig.databaseUrl);
}

export function getPool() {
  if (!appConfig.databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }

  if (!pool) {
    pool = new Pool({
      connectionString: appConfig.databaseUrl,
      ssl: appConfig.databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
      // Bounded pool: workspaces are small JSONB rows, so 10 connections per
      // instance is plenty — and it keeps N instances from breaching the
      // Postgres max_connections ceiling.
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Kill any query stuck longer than 30s so a wedged connection can't
      // hold an advisory lock or pool slot forever.
      statement_timeout: 30_000,
    });
    // Idle clients can error (server restart, network blip). Without a
    // listener that's an uncaught exception that kills the process.
    pool.on("error", (err) => {
      logger.error("pg_pool_idle_client_error", { message: err.message });
    });
  }

  return pool;
}

// ---- Conversation memory persistence ----
// AI chat memory must survive redeploys, so it lives in Postgres when a database
// is configured. Callers fall back to the local file store otherwise.
export function conversationMemoryUsesPostgres(): boolean {
  return hasPostgres();
}

export async function readConversationMemory(
  workspaceId: string,
  leadId: string,
): Promise<string> {
  await ensurePostgres();
  const result = await getPool().query<{ content: string }>(
    `SELECT content FROM conversation_memory WHERE workspace_id = $1 AND lead_id = $2 LIMIT 1`,
    [workspaceId, leadId],
  );
  return result.rows[0]?.content ?? "";
}

export async function writeConversationMemory(
  workspaceId: string,
  leadId: string,
  content: string,
): Promise<void> {
  await ensurePostgres();
  await getPool().query(
    `
      INSERT INTO conversation_memory (workspace_id, lead_id, content, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (workspace_id, lead_id)
      DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()
    `,
    [workspaceId, leadId, content],
  );
}

// Tracks already-handled webhook event ids so redelivered events (Meta and
// Leegality both retry until acked) are processed exactly once. Returns true the
// first time an id is seen, false on every redelivery. Multi-instance safe via a
// primary-key insert in Postgres; in file mode it uses a bounded in-memory set
// (single instance, so that's sufficient). Fails open (returns true) on a storage
// error — better to risk a rare duplicate than to drop a real message.
const seenWebhookEvents = new Set<string>();
export async function markWebhookEventProcessed(scope: string, eventId: string): Promise<boolean> {
  const key = `${scope}:${eventId}`;
  if (!hasPostgres()) {
    if (seenWebhookEvents.has(key)) return false;
    seenWebhookEvents.add(key);
    if (seenWebhookEvents.size > 5000) {
      // Bound memory: drop the oldest ~1000 entries.
      for (const k of Array.from(seenWebhookEvents).slice(0, 1000)) seenWebhookEvents.delete(k);
    }
    return true;
  }
  try {
    await ensurePostgres();
    const result = await getPool().query(
      `INSERT INTO processed_webhook_events (id) VALUES ($1)
       ON CONFLICT (id) DO NOTHING`,
      [key],
    );
    return (result.rowCount ?? 0) > 0;
  } catch {
    return true; // fail open
  }
}

// Trims the webhook dedup ledger so it can't grow without bound. Providers
// (Meta, Leegality) only ever redeliver an event for a few days, so anything
// older than the retention window is safe to drop. No-op in file mode (the
// in-memory set is already self-bounding in markWebhookEventProcessed).
export async function cleanupOldWebhookEvents(retentionDays = 30): Promise<number> {
  if (!hasPostgres()) return 0;
  try {
    await ensurePostgres();
    const result = await getPool().query(
      `DELETE FROM processed_webhook_events
       WHERE created_at < NOW() - ($1 || ' days')::interval`,
      [String(Math.max(1, Math.floor(retentionDays)))],
    );
    return result.rowCount ?? 0;
  } catch {
    return 0; // best-effort housekeeping; never throw on the caller's path
  }
}

// Liveness probe for the health endpoint. Reuses the shared pool (rather than
// spinning up a throwaway connection per call) so frequent health checks don't
// churn connections. Returns false in file mode (nothing to ping).
export async function pingDatabase(timeoutMs = 2000): Promise<boolean> {
  if (!hasPostgres()) return false;
  const client = await getPool().connect();
  try {
    await client.query(`SET LOCAL statement_timeout = ${Number(timeoutMs) || 2000}`);
    await client.query("SELECT 1");
    return true;
  } finally {
    client.release();
  }
}

// Closes the Postgres pool during graceful shutdown so in-flight queries drain
// and connections are released cleanly. No-op when running in file mode.
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    postgresReady = null;
  }
}

export async function ensurePostgres() {
  if (!hasPostgres()) return;
  if (postgresReady) return postgresReady;

  postgresReady = (async () => {
    const client = await getPool().connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS workspace_records (
          email TEXT PRIMARY KEY,
          workspace_id TEXT UNIQUE NOT NULL,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS conversation_memory (
          workspace_id TEXT NOT NULL,
          lead_id TEXT NOT NULL,
          content TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (workspace_id, lead_id)
        )
      `);
      // Dedup ledger for redeliverable webhooks (Meta/Leegality). A redelivered
      // event id is a no-op insert, so we process each underlying event once.
      await client.query(`
        CREATE TABLE IF NOT EXISTS processed_webhook_events (
          id TEXT PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // Persists campaign broadcast state so jobs survive instance restarts.
      // Any job still marked "running" at boot is an interrupted broadcast.
      await client.query(`
        CREATE TABLE IF NOT EXISTS campaign_broadcasts (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TIMESTAMPTZ NOT NULL,
          finished_at TIMESTAMPTZ,
          result_json JSONB NOT NULL DEFAULT '{}',
          error TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_campaign_broadcasts_email
        ON campaign_broadcasts (email)
      `);
      // Single-use login tokens for the native app's OAuth handoff (system
      // browser → deep link → session). Stored hashed; rows expire in minutes.
      await client.query(`
        CREATE TABLE IF NOT EXISTS mobile_login_tokens (
          token_hash TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // Contacts who sent STOP or equivalent — must never receive campaign messages.
      await client.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_optouts (
          workspace_id TEXT NOT NULL,
          phone TEXT NOT NULL,
          opted_out_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (workspace_id, phone)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_whatsapp_optouts_workspace
        ON whatsapp_optouts (workspace_id)
      `);
      // Operational data (leads, bookings) — the system of record once
      // OPERATIONAL_STORE is "dual"/"postgres". The full record is stored as a
      // JSONB blob keyed by (workspace_id, id): the row↔record mapping is the
      // identity function, which sidesteps the positional-column fragility of the
      // Sheets schema. The composite PK provides the workspace_id prefix index.
      await client.query(`
        CREATE TABLE IF NOT EXISTS op_leads (
          workspace_id TEXT NOT NULL,
          lead_id TEXT NOT NULL,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (workspace_id, lead_id)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS op_bookings (
          workspace_id TEXT NOT NULL,
          booking_id TEXT NOT NULL,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (workspace_id, booking_id)
        )
      `);
      // One marker row per (workspace, entity) once that workspace's sheet has
      // been backfilled into Postgres, so the lazy per-workspace migration runs
      // exactly once.
      await client.query(`
        CREATE TABLE IF NOT EXISTS op_migrated (
          workspace_id TEXT NOT NULL,
          entity TEXT NOT NULL,
          migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (workspace_id, entity)
        )
      `);
    } finally {
      client.release();
    }

    await backfillPostgresFromFileIfNeeded();
  })().catch((err) => {
    postgresReady = null;
    throw err;
  });

  return postgresReady;
}

async function backfillPostgresFromFileIfNeeded() {
  if (!hasPostgres()) return;

  const fileDb = await readWorkspaceDbFromFileSafe();
  if (!fileDb.workspaces.length) return;

  const existing = await listWorkspacesFromPostgres();
  if (existing.length > 0) return;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const workspace of fileDb.workspaces) {
      await client.query(
        `
          INSERT INTO workspace_records (email, workspace_id, data, updated_at)
          VALUES ($1, $2, $3::jsonb, NOW())
          ON CONFLICT (email)
          DO UPDATE SET
            workspace_id = EXCLUDED.workspace_id,
            data = EXCLUDED.data,
            updated_at = NOW()
        `,
        [
          normalizeEmail(workspace.email),
          workspace.workspaceId,
          JSON.stringify(toStored(workspace)),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function ensureDbFile() {
  await fs.mkdir(path.dirname(appConfig.workspaceDbPath), { recursive: true });
  try {
    await fs.access(appConfig.workspaceDbPath);
  } catch {
    const initial: WorkspaceDb = { workspaces: [] };
    await fs.writeFile(appConfig.workspaceDbPath, JSON.stringify(initial, null, 2), "utf8");
  }
}

async function readWorkspaceDbFromFileSafe(): Promise<WorkspaceDb> {
  try {
    await ensureDbFile();
    const content = await fs.readFile(appConfig.workspaceDbPath, "utf8");
    const db = JSON.parse(content) as WorkspaceDb;
    return { workspaces: db.workspaces.map(fromStored) };
  } catch {
    return { workspaces: [] };
  }
}

async function readWorkspaceDbFromFile(): Promise<WorkspaceDb> {
  await ensureDbFile();
  const content = await fs.readFile(appConfig.workspaceDbPath, "utf8");
  const db = JSON.parse(content) as WorkspaceDb;
  return { workspaces: db.workspaces.map(fromStored) };
}

async function writeWorkspaceDbToFile(db: WorkspaceDb) {
  await ensureDbFile();
  const stored: WorkspaceDb = { workspaces: db.workspaces.map(toStored) };
  const tmp = appConfig.workspaceDbPath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(stored, null, 2), "utf8");
  await fs.rename(tmp, appConfig.workspaceDbPath);
}

async function listWorkspacesFromPostgres() {
  await ensurePostgres();
  const result = await getPool().query<{ data: WorkspaceRecord }>(
    `SELECT data FROM workspace_records ORDER BY updated_at DESC`,
  );
  return result.rows.map((row: { data: WorkspaceRecord }) => fromStored(row.data));
}

async function findWorkspaceByEmailFromPostgres(email: string) {
  await ensurePostgres();
  const result = await getPool().query<{ data: WorkspaceRecord }>(
    `SELECT data FROM workspace_records WHERE email = $1 LIMIT 1`,
    [normalizeEmail(email)],
  );
  return result.rows[0]?.data ? fromStored(result.rows[0].data) : null;
}

async function saveWorkspaceToPostgres(record: WorkspaceRecord) {
  await ensurePostgres();
  await getPool().query(
    `
      INSERT INTO workspace_records (email, workspace_id, data, updated_at)
      VALUES ($1, $2, $3::jsonb, NOW())
      ON CONFLICT (email)
      DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        data = EXCLUDED.data,
        updated_at = NOW()
    `,
    [normalizeEmail(record.email), record.workspaceId, JSON.stringify(toStored(record))],
  );
}

async function updateWorkspaceByEmailInPostgres(
  email: string,
  updater: (workspace: WorkspaceRecord) => WorkspaceRecord,
) {
  await ensurePostgres();
  // Serialize concurrent mutations of the same workspace blob with a row lock.
  // The whole workspace (wallet, bookings, config) is a single JSONB row, so a
  // naive read-modify-write would let two concurrent updates (e.g. the Razorpay
  // webhook racing the checkout-verify callback) clobber each other.
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ data: WorkspaceRecord }>(
      `SELECT data FROM workspace_records WHERE email = $1 FOR UPDATE`,
      [normalizeEmail(email)],
    );
    if (!result.rows[0]?.data) {
      await client.query("ROLLBACK");
      return null;
    }
    const updated = updater(fromStored(result.rows[0].data));
    await client.query(
      `UPDATE workspace_records
         SET workspace_id = $2, data = $3::jsonb, updated_at = NOW()
       WHERE email = $1`,
      [normalizeEmail(email), updated.workspaceId, JSON.stringify(toStored(updated))],
    );
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function readWorkspaceDb(): Promise<WorkspaceDb> {
  if (hasPostgres()) {
    return { workspaces: await listWorkspacesFromPostgres() };
  }

  return readWorkspaceDbFromFile();
}

export async function writeWorkspaceDb(db: WorkspaceDb) {
  invalidateWorkspaceCache(); // bulk overwrite — drop everything cached
  if (hasPostgres()) {
    await ensurePostgres();
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM workspace_records");
      for (const workspace of db.workspaces) {
        await client.query(
          `
            INSERT INTO workspace_records (email, workspace_id, data, updated_at)
            VALUES ($1, $2, $3::jsonb, NOW())
          `,
          [normalizeEmail(workspace.email), workspace.workspaceId, JSON.stringify(toStored(workspace))],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return;
  }

  await writeWorkspaceDbToFile(db);
}

export async function listWorkspaces() {
  if (hasPostgres()) {
    return listWorkspacesFromPostgres();
  }

  const db = await readWorkspaceDbFromFile();
  return db.workspaces;
}

// Cheap workspace count for the signup cap. Uses a SQL COUNT in Postgres so we
// never load every record just to gate a new signup; file mode reads the array.
export async function countWorkspaces(): Promise<number> {
  if (hasPostgres()) {
    const pool = getPool();
    const { rows } = await pool.query<{ count: string }>("SELECT COUNT(*)::int AS count FROM workspace_records");
    return Number(rows[0]?.count ?? 0);
  }
  const db = await readWorkspaceDbFromFile();
  return db.workspaces.length;
}

export async function findWorkspaceByEmail(email: string) {
  const key = normalizeEmail(email);
  return workspaceByEmailCache.getOrLoad(key, async () => {
    if (hasPostgres()) {
      return findWorkspaceByEmailFromPostgres(email);
    }
    const db = await readWorkspaceDbFromFile();
    return db.workspaces.find((workspace) => normalizeEmail(workspace.email) === key) ?? null;
  });
}

export async function saveWorkspace(record: WorkspaceRecord) {
  invalidateWorkspaceCache(record);
  if (hasPostgres()) {
    await saveWorkspaceToPostgres(record);
    return;
  }

  const db = await readWorkspaceDbFromFile();
  const index = db.workspaces.findIndex((workspace) => workspace.workspaceId === record.workspaceId);

  if (index >= 0) {
    db.workspaces[index] = record;
  } else {
    db.workspaces.push(record);
  }

  await writeWorkspaceDbToFile(db);
}

export async function updateWorkspaceByEmail(
  email: string,
  updater: (workspace: WorkspaceRecord) => WorkspaceRecord,
) {
  // Invalidate before AND after: before so a concurrent read mid-update can't
  // re-prime the cache with the old value for a full TTL, after so the next
  // read sees the committed record.
  invalidateWorkspaceCache({ email });
  let updated: WorkspaceRecord | null;
  if (hasPostgres()) {
    updated = await updateWorkspaceByEmailInPostgres(email, updater);
  } else {
    const db = await readWorkspaceDbFromFile();
    const index = db.workspaces.findIndex((workspace) => normalizeEmail(workspace.email) === normalizeEmail(email));
    if (index === -1) return null;
    db.workspaces[index] = updater(db.workspaces[index]);
    await writeWorkspaceDbToFile(db);
    updated = db.workspaces[index];
  }
  if (updated) invalidateWorkspaceCache(updated);
  return updated;
}

// Permanently removes a workspace and all associated data from storage.
// Called from the self-service deletion endpoint. Irreversible.
export async function deleteWorkspace(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  invalidateWorkspaceCache({ email });
  if (hasPostgres()) {
    try {
      await ensurePostgres();
      const res = await getPool().query(
        `DELETE FROM workspace_records WHERE email = $1`,
        [normalized],
      );
      return (res.rowCount ?? 0) > 0;
    } catch {
      return false;
    }
  }
  // File mode: remove from the JSON file.
  const db = await readWorkspaceDbFromFile();
  const before = db.workspaces.length;
  db.workspaces = db.workspaces.filter((w) => normalizeEmail(w.email) !== normalized);
  if (db.workspaces.length === before) return false;
  await writeWorkspaceDbToFile(db);
  return true;
}

export async function findWorkspaceByWorkspaceId(workspaceId: string) {
  return workspaceByIdCache.getOrLoad(workspaceId, async () => {
    if (hasPostgres()) {
      await ensurePostgres();
      const result = await getPool().query<{ data: WorkspaceRecord }>(
        `SELECT data FROM workspace_records WHERE workspace_id = $1 LIMIT 1`,
        [workspaceId],
      );
      return result.rows[0]?.data ? fromStored(result.rows[0].data) : null;
    }
    const db = await readWorkspaceDbFromFile();
    return db.workspaces.find((workspace) => workspace.workspaceId === workspaceId) ?? null;
  });
}

export async function findWorkspaceByMetaAsset(input: {
  channel: MetaChannel;
  pageId?: string;
  instagramBusinessAccountId?: string;
  wabaId?: string;
  phoneNumberId?: string;
}) {
  const workspaces: WorkspaceRecord[] = hasPostgres()
    ? await listWorkspacesFromPostgres()
    : (await readWorkspaceDbFromFile()).workspaces;
  return (
    workspaces.find((workspace: WorkspaceRecord) => {
      const connection = workspace.metaConnections?.[input.channel];
      if (!connection) return false;

      if (input.channel === "instagram") {
        return Boolean(
          (input.pageId && connection.pageId === input.pageId) ||
            (input.instagramBusinessAccountId &&
              connection.instagramBusinessAccountId === input.instagramBusinessAccountId),
        );
      }

      return Boolean(
        (input.wabaId && connection.wabaId === input.wabaId) ||
          (input.phoneNumberId && connection.phoneNumberId === input.phoneNumberId),
      );
    }) ?? null
  );
}

// Runs `fn` only if this instance can acquire a Postgres advisory lock for `key`.
// Used by the reminder cron so that when more than one app instance is running,
// exactly one of them executes the daily send and the others skip it — preventing
// duplicate WhatsApp messages. In file mode (single-instance dev) it always runs.
export async function withDistributedLock<T>(
  key: number,
  fn: () => Promise<T>,
): Promise<{ ran: boolean; result?: T }> {
  if (!hasPostgres()) {
    return { ran: true, result: await fn() };
  }

  await ensurePostgres();
  const client = await getPool().connect();
  try {
    const res = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [key],
    );
    if (!res.rows[0]?.locked) {
      return { ran: false };
    }
    try {
      return { ran: true, result: await fn() };
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [key]);
    }
  } finally {
    client.release();
  }
}

// Like withDistributedLock, but BLOCKS until the lock is acquired instead of
// skipping. Used to serialize the booking-capacity check + create so two
// simultaneous bookings for the same date can't both slip past a max-per-day cap
// (the classic check-then-act race). In file mode (single instance) it just runs.
export async function withSerializedLock<T>(key: number, fn: () => Promise<T>): Promise<T> {
  if (!hasPostgres()) return fn();
  await ensurePostgres();
  const client = await getPool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [key]);
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [key]);
    }
  } finally {
    client.release();
  }
}

// Stable 32-bit signed integer hash for advisory-lock keys derived from strings.
export function lockKeyFromString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0;
  }
  return hash;
}

export async function findWorkspaceByMetaUserId(metaUserId: string) {
  const workspaces: WorkspaceRecord[] = hasPostgres()
    ? await listWorkspacesFromPostgres()
    : (await readWorkspaceDbFromFile()).workspaces;
  return (
    workspaces.find((workspace: WorkspaceRecord) =>
      Object.values(workspace.metaConnections ?? {}).some(
        (connection) => connection?.metaUserId === metaUserId,
      ),
    ) ?? null
  );
}

// ── Campaign broadcast persistence ──────────────────────────────────────────
// Persists job state so the polling endpoint can answer after a restart.
// In file mode (no Postgres) these are no-ops — the in-process map is
// sufficient for single-instance dev.

export async function saveCampaignBroadcast(job: {
  id: string;
  email: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  result: object;
}): Promise<void> {
  if (!hasPostgres()) return;
  await ensurePostgres();
  await getPool().query(
    `INSERT INTO campaign_broadcasts (id, email, status, started_at, finished_at, result_json, error, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW())
     ON CONFLICT (id)
     DO UPDATE SET
       status = EXCLUDED.status,
       finished_at = EXCLUDED.finished_at,
       result_json = EXCLUDED.result_json,
       error = EXCLUDED.error,
       updated_at = NOW()`,
    [
      job.id,
      normalizeEmail(job.email),
      job.status,
      job.startedAt,
      job.finishedAt ?? null,
      JSON.stringify(job.result),
      job.error ?? null,
    ],
  );
}

export async function loadCampaignBroadcast(
  jobId: string,
  email: string,
): Promise<{
  id: string;
  email: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  result: object;
} | null> {
  if (!hasPostgres()) return null;
  await ensurePostgres();
  const res = await getPool().query<{
    id: string;
    email: string;
    status: string;
    started_at: Date;
    finished_at: Date | null;
    result_json: object;
    error: string | null;
  }>(
    `SELECT id, email, status, started_at, finished_at, result_json, error
     FROM campaign_broadcasts
     WHERE id = $1 AND email = $2
     LIMIT 1`,
    [jobId, normalizeEmail(email)],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString(),
    error: row.error ?? undefined,
    result: row.result_json,
  };
}

// Called once on startup. Any broadcast still marked "running" from a previous
// instance is by definition interrupted — mark it so the UI can tell the user.
// Returns the number of jobs transitioned.
export async function markInterruptedCampaigns(): Promise<number> {
  if (!hasPostgres()) return 0;
  await ensurePostgres();
  const res = await getPool().query(
    `UPDATE campaign_broadcasts
     SET status = 'interrupted',
         error = 'Server restarted while broadcast was in progress',
         updated_at = NOW()
     WHERE status = 'running'`,
  );
  return res.rowCount ?? 0;
}

// ── WhatsApp opt-out ledger ───────────────────────────────────────────────────
// Contacts who sent STOP (or equivalent) must never receive another campaign
// message from that workspace. We store workspaceId + E.164 phone as a key.
// In Postgres: a dedicated table so lookups are O(1) without a full scan.
// In file mode: an in-memory Map<workspaceId, Set<phone>> that lasts for the
// life of the process — persists across requests, resets on restart. That is
// acceptable for dev/single-instance deployments; production runs Postgres.

const optOutMemory = new Map<string, Set<string>>();

export async function markPhoneOptedOut(workspaceId: string, phone: string): Promise<void> {
  const normalized = phone.replace(/\D/g, "");
  if (!hasPostgres()) {
    if (!optOutMemory.has(workspaceId)) optOutMemory.set(workspaceId, new Set());
    optOutMemory.get(workspaceId)!.add(normalized);
    return;
  }
  try {
    await ensurePostgres();
    await getPool().query(
      `INSERT INTO whatsapp_optouts (workspace_id, phone, opted_out_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (workspace_id, phone) DO NOTHING`,
      [workspaceId, normalized],
    );
  } catch {
    // Best-effort. Never fail a STOP request — the message is still logged.
  }
}

export async function removePhoneOptOut(workspaceId: string, phone: string): Promise<void> {
  const normalized = phone.replace(/\D/g, "");
  if (!hasPostgres()) {
    optOutMemory.get(workspaceId)?.delete(normalized);
    return;
  }
  try {
    await ensurePostgres();
    await getPool().query(
      `DELETE FROM whatsapp_optouts WHERE workspace_id = $1 AND phone = $2`,
      [workspaceId, normalized],
    );
  } catch { /* best-effort */ }
}

export async function isPhoneOptedOut(workspaceId: string, phone: string): Promise<boolean> {
  const normalized = phone.replace(/\D/g, "");
  if (!hasPostgres()) {
    return optOutMemory.get(workspaceId)?.has(normalized) ?? false;
  }
  try {
    await ensurePostgres();
    const res = await getPool().query(
      `SELECT 1 FROM whatsapp_optouts WHERE workspace_id = $1 AND phone = $2 LIMIT 1`,
      [workspaceId, normalized],
    );
    return (res.rowCount ?? 0) > 0;
  } catch {
    // Fail CLOSED: if we can't confirm opt-out status, treat as opted-out so a
    // STOP'd contact is never messaged on a transient DB error (WhatsApp policy).
    return true;
  }
}

export async function listOptedOutPhones(workspaceId: string): Promise<string[]> {
  if (!hasPostgres()) {
    return Array.from(optOutMemory.get(workspaceId) ?? []);
  }
  // Deliberately does NOT swallow errors: a marketing broadcast must fail CLOSED
  // (abort) when the opt-out list can't be confirmed, rather than message someone
  // who sent STOP. Display/export callers wrap this and fall back to an empty list.
  await ensurePostgres();
  const res = await getPool().query(
    `SELECT phone FROM whatsapp_optouts WHERE workspace_id = $1 ORDER BY opted_out_at DESC`,
    [workspaceId],
  );
  return res.rows.map((r: { phone: string }) => r.phone);
}

// ── Mobile login tokens ──────────────────────────────────────────────────────
// Single-use, short-lived tokens bridging the native app's system-browser OAuth
// back into a webview session. Postgres-backed so the OAuth callback and the
// exchange request may land on different instances. In-memory in file mode.

const mobileLoginTokensMem = new Map<string, { email: string; expiresAtMs: number }>();

export async function storeMobileLoginToken(
  tokenHash: string,
  email: string,
  expiresAt: Date,
): Promise<void> {
  if (!hasPostgres()) {
    // Opportunistic cleanup keeps the dev map bounded.
    const now = Date.now();
    for (const [hash, entry] of mobileLoginTokensMem) {
      if (entry.expiresAtMs <= now) mobileLoginTokensMem.delete(hash);
    }
    mobileLoginTokensMem.set(tokenHash, {
      email: normalizeEmail(email),
      expiresAtMs: expiresAt.getTime(),
    });
    return;
  }
  await ensurePostgres();
  await getPool().query(`DELETE FROM mobile_login_tokens WHERE expires_at < NOW()`);
  await getPool().query(
    `INSERT INTO mobile_login_tokens (token_hash, email, expires_at)
     VALUES ($1, $2, $3)`,
    [tokenHash, normalizeEmail(email), expiresAt],
  );
}

// Atomically consumes the token: deletes the row and returns the email only if
// it existed and hadn't expired. A second call with the same token gets null.
export async function consumeMobileLoginToken(tokenHash: string): Promise<string | null> {
  if (!hasPostgres()) {
    const entry = mobileLoginTokensMem.get(tokenHash);
    mobileLoginTokensMem.delete(tokenHash);
    return entry && entry.expiresAtMs > Date.now() ? entry.email : null;
  }
  await ensurePostgres();
  const res = await getPool().query<{ email: string }>(
    `DELETE FROM mobile_login_tokens
     WHERE token_hash = $1 AND expires_at > NOW()
     RETURNING email`,
    [tokenHash],
  );
  return res.rows[0]?.email ?? null;
}
