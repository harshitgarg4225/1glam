import { appConfig } from "../config.js";

type Coordinates = {
  lat: number;
  lng: number;
};

export type TravelIntelligence = {
  distanceKm: number;
  travelTimeMin: number;
  outstation: boolean;
  source: "google_maps" | "fallback" | "manual";
  normalizedOrigin: string;
  normalizedDestination: string;
};

export async function resolveTravelIntelligence(input: {
  originCity: string;
  destinationText: string;
  manualDistanceKm?: number;
  manualTravelTimeMin?: number;
  outstationThresholdKm: number;
}): Promise<TravelIntelligence> {
  const manualDistanceKm = Number(input.manualDistanceKm ?? 0);
  const manualTravelTimeMin = Number(input.manualTravelTimeMin ?? 0);

  if (manualDistanceKm > 0 || manualTravelTimeMin > 0) {
    const distanceKm = manualDistanceKm > 0 ? round(manualDistanceKm) : estimateDistanceFromTime(manualTravelTimeMin);
    const travelTimeMin = manualTravelTimeMin > 0 ? Math.round(manualTravelTimeMin) : estimateTimeFromDistance(distanceKm);
    return {
      distanceKm,
      travelTimeMin,
      outstation: distanceKm >= input.outstationThresholdKm,
      source: "manual",
      normalizedOrigin: input.originCity,
      normalizedDestination: input.destinationText,
    };
  }

  if (appConfig.googleMapsApiKey && input.originCity && input.destinationText) {
    try {
      const [origin, destination] = await Promise.all([
        geocodeAddress(input.originCity),
        geocodeAddress(input.destinationText),
      ]);

      if (origin && destination) {
        const distanceKm = round(haversineKm(origin.location, destination.location));
        const travelTimeMin = estimateTimeFromDistance(distanceKm);
        return {
          distanceKm,
          travelTimeMin,
          outstation: distanceKm >= input.outstationThresholdKm,
          source: "google_maps",
          normalizedOrigin: origin.formattedAddress,
          normalizedDestination: destination.formattedAddress,
        };
      }
    } catch {
      // Fall through to deterministic fallback. Lead creation should not fail on maps lookup.
    }
  }

  const fallbackDistanceKm = estimateFallbackDistance(input.originCity, input.destinationText);
  return {
    distanceKm: fallbackDistanceKm,
    travelTimeMin: estimateTimeFromDistance(fallbackDistanceKm),
    outstation: fallbackDistanceKm >= input.outstationThresholdKm,
    source: "fallback",
    normalizedOrigin: input.originCity,
    normalizedDestination: input.destinationText,
  };
}

async function geocodeAddress(address: string) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", appConfig.googleMapsApiKey);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Geocoding failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    status: string;
    results?: Array<{
      formatted_address?: string;
      geometry?: { location?: { lat?: number; lng?: number } };
    }>;
  };

  if (payload.status !== "OK" || !payload.results?.length) {
    return null;
  }

  const first = payload.results[0];
  const lat = first.geometry?.location?.lat;
  const lng = first.geometry?.location?.lng;
  if (typeof lat !== "number" || typeof lng !== "number") {
    return null;
  }

  return {
    formattedAddress: first.formatted_address ?? address,
    location: { lat, lng },
  };
}

function haversineKm(a: Coordinates, b: Coordinates) {
  const earthRadiusKm = 6371;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;

  return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
}

function estimateTimeFromDistance(distanceKm: number) {
  const avgSpeedKmph = distanceKm > 80 ? 45 : distanceKm > 25 ? 32 : 22;
  return Math.max(15, Math.round((distanceKm / avgSpeedKmph) * 60));
}

function estimateDistanceFromTime(travelTimeMin: number) {
  const avgSpeedKmph = 28;
  return round((travelTimeMin / 60) * avgSpeedKmph);
}

function estimateFallbackDistance(origin: string, destination: string) {
  const normalizedOrigin = origin.trim().toLowerCase();
  const normalizedDestination = destination.trim().toLowerCase();
  if (!normalizedDestination || !normalizedOrigin) {
    return 0;
  }

  if (normalizedDestination.includes(normalizedOrigin)) {
    return 12;
  }

  const differentCityHint = normalizedDestination.includes(",") ? 38 : 18;
  return differentCityHint;
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}
