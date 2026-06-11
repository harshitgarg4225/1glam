import { promises as fs } from "node:fs";
import path from "node:path";
import {
  conversationMemoryUsesPostgres,
  readConversationMemory,
  writeConversationMemory,
} from "./database.js";

type ConversationMemoryInput = {
  workspaceId: string;
  leadId: string;
  clientName: string;
  channel: "Instagram" | "WhatsApp";
  summary: string;
  knownDetails: string[];
  openQuestions: string[];
  lastInboundMessage?: string;
  lastOutboundMessage?: string;
};

export async function loadConversationMemory(workspaceId: string, leadId: string) {
  // Postgres-backed when a database is configured, so memory survives redeploys.
  if (conversationMemoryUsesPostgres()) {
    try {
      return await readConversationMemory(workspaceId, leadId);
    } catch {
      return "";
    }
  }
  const filePath = getConversationMemoryPath(workspaceId, leadId);
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export async function saveConversationMemory(input: ConversationMemoryInput) {
  const content = [
    `# Conversation Memory: ${input.leadId}`,
    "",
    `- Workspace ID: ${input.workspaceId}`,
    `- Client: ${input.clientName}`,
    `- Channel: ${input.channel}`,
    `- Updated At: ${new Date().toISOString()}`,
    "",
    "## Summary",
    input.summary || "No summary yet.",
    "",
    "## Known Details",
    ...(input.knownDetails.length ? input.knownDetails.map((item) => `- ${item}`) : ["- None yet"]),
    "",
    "## Open Questions",
    ...(input.openQuestions.length ? input.openQuestions.map((item) => `- ${item}`) : ["- None"]),
    "",
    "## Last Inbound Message",
    input.lastInboundMessage || "None",
    "",
    "## Last Outbound Message",
    input.lastOutboundMessage || "None",
    "",
  ].join("\n");

  if (conversationMemoryUsesPostgres()) {
    await writeConversationMemory(input.workspaceId, input.leadId, content);
    return `pg:conversation_memory/${input.workspaceId}/${input.leadId}`;
  }

  const filePath = getConversationMemoryPath(input.workspaceId, input.leadId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

export function getConversationMemoryPath(workspaceId: string, leadId: string) {
  return path.join(process.cwd(), "data", "conversation-memory", workspaceId, `${leadId}.md`);
}

// Raw key-value access to the same store, for small per-client records (e.g.
// client notes) that don't fit the conversation-markdown shape.
export async function readMemoryRaw(workspaceId: string, key: string): Promise<string> {
  if (conversationMemoryUsesPostgres()) {
    try {
      return await readConversationMemory(workspaceId, key);
    } catch {
      return "";
    }
  }
  try {
    return await fs.readFile(getConversationMemoryPath(workspaceId, key), "utf8");
  } catch {
    return "";
  }
}

export async function writeMemoryRaw(workspaceId: string, key: string, content: string): Promise<void> {
  if (conversationMemoryUsesPostgres()) {
    await writeConversationMemory(workspaceId, key, content);
    return;
  }
  const filePath = getConversationMemoryPath(workspaceId, key);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}
