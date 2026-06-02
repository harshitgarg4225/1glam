import crypto from "node:crypto";
import { updateWorkspaceByEmail } from "./database.js";
import type { Wallet, WalletLedgerEntry, WorkspaceRecord } from "../types.js";

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
