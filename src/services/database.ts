import { promises as fs } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { appConfig } from "../config.js";
import { decryptWorkspaceSecrets, encryptWorkspaceSecrets } from "./crypto.js";
import type { MetaChannel, WorkspaceRecord } from "../types.js";

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
    });
  }

  return pool;
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
  const current = await findWorkspaceByEmailFromPostgres(email);
  if (!current) return null;
  const updated = updater(current);
  await saveWorkspaceToPostgres(updated);
  return updated;
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
  if (hasPostgres()) {
    return findWorkspaceByEmailFromPostgres(email);
  }

  const db = await readWorkspaceDbFromFile();
  return db.workspaces.find((workspace) => normalizeEmail(workspace.email) === normalizeEmail(email)) ?? null;
}

export async function saveWorkspace(record: WorkspaceRecord) {
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
  if (hasPostgres()) {
    return updateWorkspaceByEmailInPostgres(email, updater);
  }

  const db = await readWorkspaceDbFromFile();
  const index = db.workspaces.findIndex((workspace) => normalizeEmail(workspace.email) === normalizeEmail(email));
  if (index === -1) return null;

  db.workspaces[index] = updater(db.workspaces[index]);
  await writeWorkspaceDbToFile(db);
  return db.workspaces[index];
}

export async function findWorkspaceByWorkspaceId(workspaceId: string) {
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
