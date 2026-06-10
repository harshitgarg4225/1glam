import crypto from "node:crypto";
import { appConfig } from "../config.js";
import { updateWorkspaceByEmail } from "./database.js";
import { logger } from "./logger.js";
import type { Wallet, WalletLedgerEntry, WorkspaceRecord } from "../types.js";

// Credits at or below this are "running low" — surfaced in the UI so the artist
// can top up before anything stops working.
export const LOW_BALANCE_THRESHOLD = 50;

// Credit packs the artist can buy. 1 credit ≈ ₹1; bigger packs include a bonus.
// Tune freely — these are sensible test-mode defaults.
export type CreditPack = {
  id: string;
  label: string;
  amountInr: number;
  credits: number;
  bonus?: string;
};

export const CREDIT_PACKS: CreditPack[] = [
  { id: "starter", label: "Starter", amountInr: 500, credits: 500 },
  { id: "popular", label: "Popular", amountInr: 1000, credits: 1100, bonus: "+100 free" },
  { id: "pro", label: "Pro", amountInr: 2500, credits: 2900, bonus: "+400 free" },
  { id: "studio", label: "Studio", amountInr: 5000, credits: 6000, bonus: "+1000 free" },
];

// What each metered action costs, in credits. Used by the usage-metering layer.
export const USAGE_COSTS = {
  whatsappMessage: 1,
  instagramMessage: 1,
  aiReply: 2,
  aiLeadEnrichment: 2,
  aiReviewReply: 1,
  aiAssistant: 2,
  documentGeneration: 1,
} as const;

export type UsageKind = keyof typeof USAGE_COSTS;

export function findPack(packId: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === packId);
}

const EMPTY_WALLET: Wallet = { balanceCredits: 0, ledger: [], processedRefs: [] };

export function getWallet(workspace: WorkspaceRecord): Wallet {
  const w = workspace.wallet;
  if (!w) return { ...EMPTY_WALLET };
  return {
    balanceCredits: w.balanceCredits || 0,
    ledger: Array.isArray(w.ledger) ? w.ledger : [],
    processedRefs: Array.isArray(w.processedRefs) ? w.processedRefs : [],
  };
}

function applyEntry(wallet: Wallet, entry: Omit<WalletLedgerEntry, "id" | "balanceAfter" | "createdAt">): Wallet {
  const delta = entry.type === "credit" ? entry.credits : -entry.credits;
  const balanceAfter = wallet.balanceCredits + delta;
  const full: WalletLedgerEntry = {
    ...entry,
    id: crypto.randomUUID(),
    balanceAfter,
    createdAt: new Date().toISOString(),
  };
  return {
    balanceCredits: balanceAfter,
    // Keep the ledger bounded so the workspace blob doesn't grow unbounded.
    ledger: [full, ...wallet.ledger].slice(0, 200),
    processedRefs: entry.ref
      ? [entry.ref, ...wallet.processedRefs].slice(0, 500)
      : wallet.processedRefs,
  };
}

// Adds credits idempotently. If `ref` (e.g. a Razorpay payment id) was already
// applied, this is a no-op so a webhook + checkout callback can't double-credit.
export async function creditWallet(
  email: string,
  input: { credits: number; reason: string; ref?: string; amountInr?: number },
): Promise<{ wallet: Wallet; applied: boolean } | null> {
  let applied = false;
  const updated = await updateWorkspaceByEmail(email, (workspace) => {
    const wallet = getWallet(workspace);
    if (input.ref && wallet.processedRefs.includes(input.ref)) {
      return workspace; // already credited — idempotent
    }
    applied = true;
    return {
      ...workspace,
      wallet: applyEntry(wallet, {
        type: "credit",
        credits: input.credits,
        reason: input.reason,
        ref: input.ref,
        amountInr: input.amountInr,
      }),
    };
  });
  if (!updated) return null;
  return { wallet: getWallet(updated), applied };
}

// Deducts credits for a metered action. Returns the new wallet. Recording is
// always allowed (balance can go to zero/negative); hard enforcement is a
// separate, opt-in concern so existing flows never break unexpectedly.
export async function debitWallet(
  email: string,
  input: { credits: number; reason: string; ref?: string },
): Promise<Wallet | null> {
  const updated = await updateWorkspaceByEmail(email, (workspace) => {
    const wallet = getWallet(workspace);
    if (input.ref && wallet.processedRefs.includes(input.ref)) {
      return workspace;
    }
    return {
      ...workspace,
      wallet: applyEntry(wallet, {
        type: "debit",
        credits: input.credits,
        reason: input.reason,
        ref: input.ref,
      }),
    };
  });
  return updated ? getWallet(updated) : null;
}

export const USAGE_LABELS: Record<UsageKind, string> = {
  whatsappMessage: "WhatsApp message",
  instagramMessage: "Instagram message",
  aiReply: "AI conversation reply",
  aiLeadEnrichment: "AI lead intelligence",
  aiReviewReply: "AI review reply",
  aiAssistant: "AI assistant answer",
  documentGeneration: "Document generated",
};

export function creditCostFor(kind: UsageKind): number {
  return USAGE_COSTS[kind];
}

export function isLowBalance(balanceCredits: number): boolean {
  return balanceCredits <= LOW_BALANCE_THRESHOLD;
}

// True when the workspace can run this action. Always true unless billing is
// enforced AND the balance can't cover the cost.
export function canAfford(workspace: WorkspaceRecord, kind: UsageKind): boolean {
  if (!appConfig.billingEnforced) return true;
  return getWallet(workspace).balanceCredits >= creditCostFor(kind);
}

// Records usage for a metered action. Never throws — a billing hiccup must not
// break a real message send or AI call. Returns the new balance (or null).
export async function meterUsage(
  email: string,
  kind: UsageKind,
  ref?: string,
): Promise<number | null> {
  try {
    const wallet = await debitWallet(email, {
      credits: creditCostFor(kind),
      reason: USAGE_LABELS[kind],
      ref,
    });
    return wallet ? wallet.balanceCredits : null;
  } catch (error) {
    logger.warn("Usage metering failed", { email, kind, error: String(error) });
    return null;
  }
}
