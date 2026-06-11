import { readMemoryRaw, writeMemoryRaw } from "./conversation-memory.js";

// Per-client private notes ("sensitive skin, loves nude tones", birthday,
// preferences) keyed by phone number — the relationship memory that makes a
// repeat client feel remembered. Reuses the conversation-memory store
// (Postgres when configured, file fallback otherwise) under a dedicated key,
// so no new tables or sheets are needed.

export type ClientNotes = {
  notes: string;
  birthday: string; // YYYY-MM-DD or ""
  updatedAt: string;
};

export function clientNotesKey(phone: string): string {
  const digits = String(phone || "").replace(/\D/g, "").slice(-12);
  return `client-notes-${digits || "unknown"}`;
}

export async function loadClientNotes(workspaceId: string, phone: string): Promise<ClientNotes> {
  const raw = await readMemoryRaw(workspaceId, clientNotesKey(phone));
  try {
    const parsed = JSON.parse(raw) as Partial<ClientNotes>;
    return {
      notes: String(parsed.notes ?? ""),
      birthday: /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.birthday ?? "")) ? String(parsed.birthday) : "",
      updatedAt: String(parsed.updatedAt ?? ""),
    };
  } catch {
    return { notes: "", birthday: "", updatedAt: "" };
  }
}

export async function saveClientNotes(
  workspaceId: string,
  phone: string,
  input: { notes: string; birthday?: string },
): Promise<ClientNotes> {
  const record: ClientNotes = {
    notes: String(input.notes ?? "").slice(0, 2000),
    birthday: /^\d{4}-\d{2}-\d{2}$/.test(String(input.birthday ?? "")) ? String(input.birthday) : "",
    updatedAt: new Date().toISOString(),
  };
  await writeMemoryRaw(workspaceId, clientNotesKey(phone), JSON.stringify(record));
  return record;
}
