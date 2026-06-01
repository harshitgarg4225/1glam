import { appConfig } from "../config.js";

export type BusinessCandidate = {
  placeId: string;
  name: string;
  address: string;
  rating?: number;
  userRatingsTotal?: number;
};

// Builds the canonical Google "write a review" deep link for a place. This is
// the same link Google's own "share review form" produces, and works without
// the restricted Business Profile API — only a place_id is needed.
export function buildGoogleReviewLink(placeId: string): string {
  return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;
}

export function placesConfigured(): boolean {
  return Boolean(appConfig.googleMapsApiKey);
}

// Finds Google Business Profiles matching a free-text query (business name +
// city) using the Places Text Search API. Reuses the existing Maps API key.
export async function findBusinessCandidates(query: string): Promise<BusinessCandidate[]> {
  if (!appConfig.googleMapsApiKey) {
    throw new Error("Google Maps API key is not configured.");
  }
  const trimmed = query.trim();
  if (trimmed.length < 3) {
    throw new Error("Type at least 3 characters of your business name.");
  }

  const url = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
  url.searchParams.set("query", trimmed);
  url.searchParams.set("key", appConfig.googleMapsApiKey);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Places lookup failed (${response.status}).`);
  }

  const payload = (await response.json()) as {
    status: string;
    error_message?: string;
    results?: Array<{
      place_id?: string;
      name?: string;
      formatted_address?: string;
      rating?: number;
      user_ratings_total?: number;
    }>;
  };

  if (payload.status === "ZERO_RESULTS") return [];
  if (payload.status !== "OK") {
    throw new Error(
      payload.error_message ||
        "Couldn't search Google right now. Make sure the Places API is enabled for your key.",
    );
  }

  return (payload.results ?? [])
    .filter((result) => result.place_id && result.name)
    .slice(0, 6)
    .map((result) => ({
      placeId: result.place_id as string,
      name: result.name as string,
      address: result.formatted_address ?? "",
      rating: result.rating,
      userRatingsTotal: result.user_ratings_total,
    }));
}
