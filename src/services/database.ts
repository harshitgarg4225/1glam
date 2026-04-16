import { promises as fs } from "node:fs";
import path from "node:path";
import { appConfig } from "../config.js";
import type { MetaChannel, WorkspaceRecord } from "../types.js";

type WorkspaceDb = {
  workspaces: WorkspaceRecord[];
};

async function ensureDbFile() {
  await fs.mkdir(path.dirname(appConfig.workspaceDbPath), { recursive: true });
  try {
    await fs.access(appConfig.workspaceDbPath);
  } catch {
    const initial: WorkspaceDb = { workspaces: [] };
    await fs.writeFile(appConfig.workspaceDbPath, JSON.stringify(initial, null, 2), "utf8");
  }
}

export async function readWorkspaceDb(): Promise<WorkspaceDb> {
  await ensureDbFile();
  const content = await fs.readFile(appConfig.workspaceDbPath, "utf8");
  return JSON.parse(content) as WorkspaceDb;
}

export async function writeWorkspaceDb(db: WorkspaceDb) {
  await ensureDbFile();
  await fs.writeFile(appConfig.workspaceDbPath, JSON.stringify(db, null, 2), "utf8");
}

export async function listWorkspaces() {
  const db = await readWorkspaceDb();
  return db.workspaces;
}

export async function findWorkspaceByEmail(email: string) {
  const db = await readWorkspaceDb();
  return db.workspaces.find((workspace) => workspace.email.toLowerCase() === email.toLowerCase()) ?? null;
}

export async function saveWorkspace(record: WorkspaceRecord) {
  const db = await readWorkspaceDb();
  const index = db.workspaces.findIndex((workspace) => workspace.workspaceId === record.workspaceId);

  if (index >= 0) {
    db.workspaces[index] = record;
  } else {
    db.workspaces.push(record);
  }

  await writeWorkspaceDb(db);
}

export async function updateWorkspaceByEmail(
  email: string,
  updater: (workspace: WorkspaceRecord) => WorkspaceRecord,
) {
  const db = await readWorkspaceDb();
  const index = db.workspaces.findIndex((workspace) => workspace.email.toLowerCase() === email.toLowerCase());
  if (index === -1) return null;

  db.workspaces[index] = updater(db.workspaces[index]);
  await writeWorkspaceDb(db);
  return db.workspaces[index];
}

export async function findWorkspaceByMetaAsset(input: {
  channel: MetaChannel;
  pageId?: string;
  instagramBusinessAccountId?: string;
  wabaId?: string;
  phoneNumberId?: string;
}) {
  const db = await readWorkspaceDb();
  return (
    db.workspaces.find((workspace) => {
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

export async function findWorkspaceByMetaUserId(metaUserId: string) {
  const db = await readWorkspaceDb();
  return (
    db.workspaces.find((workspace) =>
      Object.values(workspace.metaConnections ?? {}).some(
        (connection) => connection?.metaUserId === metaUserId,
      ),
    ) ?? null
  );
}
