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

function hasPostgres() {
  return Boolean(appConfig.databaseUrl);
}

function getPool() {
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

async function ensurePostgres() {
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
