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

// ---- In-app Business Profile creation ----
// Creates the artist's Google Business listing from inside the product: a
// service-area business ("Make-up artist" category, customer-location-only, no
// street address shown) under her own Google account, then surfaces Google's
// verification options. Verification itself always completes on Google's side
// (video call / phone code) — that part can't be done for her.

export const BUSINESS_MANAGE_SCOPE = "https://www.googleapis.com/auth/business.manage";

export function hasBusinessScope(workspace: WorkspaceRecord): boolean {
  return (workspace.googleTokens?.scope || "").includes("business.manage");
}

export type GmbCreateStatus = {
  scopeGranted: boolean;
  // Where to send her to grant the Business Profile permission.
  grantUrl: string;
};

export function getGmbCreateStatus(workspace: WorkspaceRecord): GmbCreateStatus {
  return {
    scopeGranted: hasBusinessScope(workspace),
    grantUrl: "/auth/google/business",
  };
}

export type GmbCreateInput = {
  businessName: string;
  phone: string;
  serviceAreas: string[];
  website?: string;
};

export type GmbCreateResult =
  | { ok: true; locationName: string; verificationOptions: string[] }
  | { ok: false; reason: "scope" | "approval" | "invalid" | "error"; message: string };

// Human-readable labels for Google's verification methods.
export const VERIFICATION_LABELS: Record<string, string> = {
  AUTO: "Instant (no extra step needed)",
  EMAIL: "Email code",
  PHONE_CALL: "Phone call with a code",
  SMS: "SMS code",
  VETTED_PARTNER: "Partner verification",
  ADDRESS: "Postcard by mail",
  BUSINESS_VIDEO: "Short video call / video recording with Google",
};

async function extractApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message || `Google returned ${res.status}.`;
  } catch {
    return `Google returned ${res.status}.`;
  }
}

export async function createBusinessProfile(
  workspace: WorkspaceRecord,
  tokens: Credentials,
  input: GmbCreateInput,
): Promise<GmbCreateResult> {
  if (!hasBusinessScope(workspace)) {
    return {
      ok: false,
      reason: "scope",
      message: "Google needs your permission to manage Business Profiles. Tap 'Allow Business Profile access' first.",
    };
  }

  try {
    const { auth } = createGoogleClients(tokens);
    const headers = await auth.getRequestHeaders();

    const accountsRes = await fetchWithTimeout(
      "https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
      { headers },
    );
    if (accountsRes.status === 403 || accountsRes.status === 429) {
      return {
        ok: false,
        reason: "approval",
        message: "Our Business Profile API access is still being approved by Google. Use the guided setup below for now — it takes about 5 minutes.",
      };
    }
    if (!accountsRes.ok) {
      return { ok: false, reason: "error", message: await extractApiError(accountsRes) };
    }
    const accountsJson = (await accountsRes.json()) as { accounts?: Array<{ name?: string }> };
    const account = accountsJson.accounts?.[0]?.name;
    if (!account) {
      return { ok: false, reason: "error", message: "Couldn't find a Business Profile account for your Google login." };
    }

    const location = {
      languageCode: "en",
      title: input.businessName,
      categories: { primaryCategory: { name: "categories/gcid:make_up_artist" } },
      phoneNumbers: { primaryPhone: input.phone },
      ...(input.website ? { websiteUri: input.website } : {}),
      serviceArea: {
        businessType: "CUSTOMER_LOCATION_ONLY",
        places: {
          placeInfos: input.serviceAreas.map((area) => ({ placeName: area })),
        },
      },
    };

    const requestId = `bd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const createRes = await fetchWithTimeout(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${account}/locations?requestId=${requestId}`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(location),
      },
    );
    if (createRes.status === 403 || createRes.status === 429) {
      return {
        ok: false,
        reason: "approval",
        message: "Our Business Profile API access is still being approved by Google. Use the guided setup below for now.",
      };
    }
    if (createRes.status === 400) {
      return { ok: false, reason: "invalid", message: await extractApiError(createRes) };
    }
    if (!createRes.ok) {
      return { ok: false, reason: "error", message: await extractApiError(createRes) };
    }
    const created = (await createRes.json()) as { name?: string };
    const locationName = created.name || "";

    // Surface how Google will verify her. Failure here doesn't undo creation.
    let verificationOptions: string[] = [];
    if (locationName) {
      try {
        const verifyRes = await fetchWithTimeout(
          `https://mybusinessverifications.googleapis.com/v1/${locationName}:fetchVerificationOptions`,
          {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ languageCode: "en" }),
          },
        );
        if (verifyRes.ok) {
          const verifyJson = (await verifyRes.json()) as {
            options?: Array<{ verificationMethod?: string }>;
          };
          verificationOptions = (verifyJson.options ?? [])
            .map((option) => option.verificationMethod || "")
            .filter(Boolean);
        }
      } catch {
        // Options are a nicety; the listing exists either way.
      }
    }

    return { ok: true, locationName, verificationOptions };
  } catch (error) {
    return {
      ok: false,
      reason: "error",
      message: error instanceof Error ? error.message : "Something went wrong talking to Google.",
    };
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
