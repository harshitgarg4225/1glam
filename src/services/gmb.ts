import { appConfig } from "../config.js";
import { fetchWithTimeout } from "./http.js";
import { createGoogleClients } from "./google.js";
import { generateReviewReplies, type GrokReviewReplies } from "./grok.js";
import type { Credentials } from "google-auth-library";
import type { WorkspaceRecord } from "../types.js";

// The Google Business Profile API is allowlist-gated: new GCP projects start
// with zero quota and approval takes days-to-weeks. Until the project is
// approved (GMB_API_ENABLED=1) AND the artist has granted the business.manage
// scope, the agent runs in "assisted" mode — it drafts replies with AI that the
// artist posts to Google in one tap. Once access is granted, the same UI starts
// fetching real reviews and posting replies automatically.
export function gmbApiAvailable(workspace: WorkspaceRecord): boolean {
  if (!appConfig.gmbApiEnabled) return false;
  const scope = workspace.googleTokens?.scope || "";
  return scope.includes("business.manage");
}

export type GmbReview = {
  reviewId: string;
  reviewer: string;
  rating: number;
  comment: string;
  createdAt: string;
  reply?: string;
};

export type GmbStatus = {
  apiAvailable: boolean;
  connected: boolean;
  reviewLink: string;
  // Why auto-sync isn't on yet, in plain language for the artist.
  mode: "assisted" | "auto";
  note: string;
};

export function getGmbStatus(workspace: WorkspaceRecord): GmbStatus {
  const apiAvailable = gmbApiAvailable(workspace);
  const reviewLink = workspace.config.googleReviewLink || "";
  return {
    apiAvailable,
    connected: Boolean(reviewLink),
    reviewLink,
    mode: apiAvailable ? "auto" : "assisted",
    note: apiAvailable
      ? "Connected to Google Business Profile — reviews sync and replies post automatically."
      : "AI drafts every reply for you to post in one tap. Automatic posting unlocks once Google approves Business Profile API access.",
  };
}

// Drafts AI replies to a single review. Works in both modes.
export async function draftReviewReplies(
  workspace: WorkspaceRecord,
  input: { reviewText: string; rating?: number; reviewerName?: string; tone?: string },
): Promise<GrokReviewReplies> {
  return generateReviewReplies({
    brandName: workspace.config.businessName || workspace.name,
    ownerName: workspace.config.ownerName,
    city: workspace.config.city,
    signOff: workspace.config.aiSignOff,
    tone: input.tone || "Warm and grateful",
    reviewerName: input.reviewerName,
    rating: input.rating,
    reviewText: input.reviewText,
  });
}

// ---- Auto-sync path (active only once GMB_API_ENABLED and scope granted) ----
// Implemented against the documented Business Profile API shape. Gated off by
// default; returns apiAvailable:false so the UI cleanly falls back to assisted
// mode until the GCP project is allowlisted.

type AccountLocation = { account: string; location: string };

async function resolvePrimaryLocation(tokens: Credentials): Promise<AccountLocation | null> {
  const { auth } = createGoogleClients(tokens);
  const headers = await auth.getRequestHeaders();

  const accountsRes = await fetchWithTimeout(
    "https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
    { headers },
  );
  if (!accountsRes.ok) return null;
  const accountsJson = (await accountsRes.json()) as { accounts?: Array<{ name?: string }> };
  const account = accountsJson.accounts?.[0]?.name;
  if (!account) return null;

  const locationsRes = await fetchWithTimeout(
    `https://mybusinessbusinessinformation.googleapis.com/v1/${account}/locations?readMask=name`,
    { headers },
  );
  if (!locationsRes.ok) return null;
  const locationsJson = (await locationsRes.json()) as { locations?: Array<{ name?: string }> };
  const location = locationsJson.locations?.[0]?.name;
  if (!location) return null;

  return { account, location };
}

export async function listGmbReviews(
  workspace: WorkspaceRecord,
  tokens: Credentials,
): Promise<{ apiAvailable: boolean; reviews: GmbReview[] }> {
  if (!gmbApiAvailable(workspace)) {
    return { apiAvailable: false, reviews: [] };
  }
  try {
    const target = await resolvePrimaryLocation(tokens);
    if (!target) return { apiAvailable: false, reviews: [] };

    const { auth } = createGoogleClients(tokens);
    const headers = await auth.getRequestHeaders();
    const res = await fetchWithTimeout(
      `https://mybusiness.googleapis.com/v4/${target.account}/${target.location}/reviews`,
      { headers },
    );
    if (!res.ok) return { apiAvailable: false, reviews: [] };

    const json = (await res.json()) as {
      reviews?: Array<{
        reviewId?: string;
        reviewer?: { displayName?: string };
        starRating?: string;
        comment?: string;
        createTime?: string;
        reviewReply?: { comment?: string };
      }>;
    };

    const starMap: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
    const reviews: GmbReview[] = (json.reviews ?? []).map((r) => ({
      reviewId: r.reviewId || "",
      reviewer: r.reviewer?.displayName || "Google user",
      rating: starMap[r.starRating || ""] || 0,
      comment: r.comment || "",
      createdAt: r.createTime || "",
      reply: r.reviewReply?.comment,
    }));
    return { apiAvailable: true, reviews };
  } catch {
    return { apiAvailable: false, reviews: [] };
  }
}

export async function postGmbReply(
  workspace: WorkspaceRecord,
  tokens: Credentials,
  reviewName: string,
  comment: string,
): Promise<boolean> {
  if (!gmbApiAvailable(workspace)) return false;
  try {
    const { auth } = createGoogleClients(tokens);
    const headers = await auth.getRequestHeaders();
    const res = await fetchWithTimeout(`https://mybusiness.googleapis.com/v4/${reviewName}/reply`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ comment }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
