import { getWorkspaceCredentials } from "./auth-store.js";
import { createLeadForWorkspace } from "./booking.js";
import { findWorkspaceByWorkspaceId } from "./database.js";
import { logInteractionForWorkspace } from "./integrations.js";
import type { WorkspaceRecord } from "../types.js";

export type PublicEventType = {
  key: string;
  label: string;
  startingPrice: number;
};

export type PublicBusinessProfile = {
  workspaceId: string;
  businessName: string;
  city: string;
  instagramHandle: string;
  advancePercentage: number;
  eventTypes: PublicEventType[];
};

export type PublicBookingInput = {
  clientName: string;
  clientWhatsApp: string;
  clientInstagram?: string;
  eventType: string;
  eventDate: string;
  eventTime?: string;
  locationText: string;
  notes?: string;
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  Bridal: "Bridal Makeup",
  Engagement: "Engagement Makeup",
  Reception: "Reception Makeup",
  Party: "Party / Event Makeup",
  Shoot: "Photoshoot Makeup",
  Other: "Other",
};

function buildPublicProfile(workspace: WorkspaceRecord): PublicBusinessProfile {
  const { config } = workspace;
  const eventTypes: PublicEventType[] = [
    { key: "Bridal", startingPrice: config.basePriceBridal },
    { key: "Engagement", startingPrice: config.basePriceEngagement },
    { key: "Reception", startingPrice: config.basePriceReception },
    { key: "Party", startingPrice: config.basePriceParty },
    { key: "Shoot", startingPrice: config.basePriceShoot },
    { key: "Other", startingPrice: config.basePriceOther },
  ].map((entry) => ({
    key: entry.key,
    label: EVENT_TYPE_LABELS[entry.key] ?? entry.key,
    startingPrice: Number(entry.startingPrice) || 0,
  }));

  return {
    workspaceId: workspace.workspaceId,
    businessName: config.businessName || workspace.name || "1Glam Artist",
    city: config.city || "",
    instagramHandle: config.instagramHandle || "",
    advancePercentage: Number(config.advancePercentage) || 0,
    eventTypes,
  };
}

export async function getPublicBusinessProfile(workspaceId: string): Promise<PublicBusinessProfile | null> {
  const workspace = await findWorkspaceByWorkspaceId(workspaceId);
  if (!workspace) return null;
  return buildPublicProfile(workspace);
}

export async function createPublicBookingRequest(workspaceId: string, input: PublicBookingInput) {
  const workspace = await findWorkspaceByWorkspaceId(workspaceId);
  if (!workspace) throw new Error("Booking page not found");

  const tokens = await getWorkspaceCredentials(workspace.email);
  const inboundMessage = buildInboundMessage(input);

  const result = await createLeadForWorkspace(workspace.email, tokens, {
    source: "Booking Page",
    clientName: input.clientName,
    clientWhatsApp: input.clientWhatsApp,
    clientInstagram: input.clientInstagram,
    eventType: input.eventType,
    eventDate: input.eventDate,
    eventTime: input.eventTime,
    locationText: input.locationText,
    inboundMessage,
  });

  await logInteractionForWorkspace(workspace.email, tokens, {
    leadId: result.lead.leadId,
    direction: "Inbound",
    channel: "Booking Page",
    actor: input.clientWhatsApp,
    message: inboundMessage,
    aiSummary: `Lead ${result.lead.leadId} created from public booking page`,
  });

  return {
    leadId: result.lead.leadId,
    businessName: workspace.config.businessName || workspace.name,
    eventType: result.lead.eventType,
    eventDate: result.lead.eventDate,
    eventTime: result.lead.eventTime,
  };
}

function buildInboundMessage(input: PublicBookingInput) {
  return [
    `Booking request via website for ${input.eventType}.`,
    `Date: ${input.eventDate}${input.eventTime ? ` at ${input.eventTime}` : ""}.`,
    `Location: ${input.locationText}.`,
    input.clientInstagram ? `Instagram: ${input.clientInstagram}.` : "",
    input.notes ? `Notes: ${input.notes}` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}
