import { appConfig } from "../config.js";
import { fetchWithTimeout } from "./http.js";

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

export type DistanceResult = {
  distanceKm: number;
  travelTimeMin: number;
};

// Estimates driving distance and travel time between the artist's base city and
// the event location using the Google Distance Matrix API. Reuses the existing
// Maps API key. Returns null when nothing usable comes back so the caller can
// degrade gracefully (the fields stay manual).
export async function estimateDistance(
  origin: string,
  destination: string,
): Promise<DistanceResult | null> {
  if (!appConfig.googleMapsApiKey) {
    throw new Error("Distance lookup isn't configured yet. Ask the admin to add a Maps API key.");
  }
  const from = origin.trim();
  const to = destination.trim();
  if (!from || !to) return null;

  const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  url.searchParams.set("origins", from);
  url.searchParams.set("destinations", to);
  url.searchParams.set("units", "metric");
  url.searchParams.set("mode", "driving");
  url.searchParams.set("key", appConfig.googleMapsApiKey);

  const response = await fetchWithTimeout(url.toString());
  if (!response.ok) {
    throw new Error(`Distance lookup failed (${response.status}).`);
  }

  const payload = (await response.json()) as {
    status: string;
    error_message?: string;
    rows?: Array<{
      elements?: Array<{
        status: string;
        distance?: { value: number };
        duration?: { value: number };
      }>;
    }>;
  };

  if (payload.status !== "OK") {
    throw new Error(
      payload.error_message ||
        "Couldn't estimate distance. Make sure the Distance Matrix API is enabled for your key.",
    );
  }

  const element = payload.rows?.[0]?.elements?.[0];
  if (!element || element.status !== "OK" || !element.distance || !element.duration) {
    return null;
  }

  return {
    distanceKm: Math.round((element.distance.value / 1000) * 10) / 10,
    travelTimeMin: Math.round(element.duration.value / 60),
  };
}

// Venue/location suggestions while typing — Places Autocomplete, biased to
// India. Returns [] when the key isn't configured so the field stays a plain
// text input with no error noise.
export async function suggestPlaces(query: string): Promise<string[]> {
  if (!appConfig.googleMapsApiKey) return [];
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  const url = new URL("https://maps.googleapis.com/maps/api/place/autocomplete/json");
  url.searchParams.set("input", trimmed);
  url.searchParams.set("components", "country:in");
  url.searchParams.set("key", appConfig.googleMapsApiKey);

  const response = await fetchWithTimeout(url.toString());
  if (!response.ok) return [];

  const payload = (await response.json()) as {
    status: string;
    predictions?: Array<{ description?: string }>;
  };
  if (payload.status !== "OK") return [];
  return (payload.predictions ?? [])
    .map((p) => p.description || "")
    .filter(Boolean)
    .slice(0, 6);
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

  const response = await fetchWithTimeout(url.toString());
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
