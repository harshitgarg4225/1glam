import { promises as fs } from "node:fs";
import path from "node:path";

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
  const filePath = getConversationMemoryPath(workspaceId, leadId);
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export async function saveConversationMemory(input: ConversationMemoryInput) {
  const filePath = getConversationMemoryPath(input.workspaceId, input.leadId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

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

  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

export function getConversationMemoryPath(workspaceId: string, leadId: string) {
  return path.join(process.cwd(), "data", "conversation-memory", workspaceId, `${leadId}.md`);
}
