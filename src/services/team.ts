import { nanoid } from "nanoid";
import type { Credentials } from "google-auth-library";
import { createGoogleClients } from "./google.js";
import { artistHeaders, sheetNames } from "./sheet-definitions.js";
import { getWorkspaceByEmail } from "./workspace.js";

export type ArtistRecord = {
  artistId: string;
  name: string;
  whatsApp: string;
  email: string;
  city: string;
  skillLevel: string;
  priceMultiplier: number;
  luxuryEligible: string;
  primaryCalendarId: string;
  active: string;
};

export type ArtistInput = {
  artistId?: string;
  name: string;
  whatsApp?: string;
  email?: string;
  city?: string;
  skillLevel?: string;
  priceMultiplier?: number;
  luxuryEligible?: string;
  primaryCalendarId?: string;
  active?: string;
};

export async function listArtists(email: string, tokens: Credentials): Promise<ArtistRecord[]> {
  const workspace = await getWorkspaceByEmail(email);
  if (!workspace) throw new Error("Workspace not found");

  const { sheets } = createGoogleClients(tokens);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: workspace.spreadsheetId,
    range: `${sheetNames.artists}!A2:${toColumn(artistHeaders.length)}`,
  });

  return (response.data.values ?? [])
    .filter((row) => row[0])
    .map(rowToArtist);
}

export async function upsertArtist(
  email: string,
  tokens: Credentials,
  input: ArtistInput,
): Promise<ArtistRecord> {
  const workspace = await getWorkspaceByEmail(email);
  if (!workspace) throw new Error("Workspace not found");

  const { sheets } = createGoogleClients(tokens);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: workspace.spreadsheetId,
    range: `${sheetNames.artists}!A2:${toColumn(artistHeaders.length)}`,
  });
  const rows = response.data.values ?? [];

  const artist: ArtistRecord = {
    artistId: input.artistId || `A${nanoid(6)}`,
    name: input.name,
    whatsApp: input.whatsApp ?? "",
    email: input.email ?? "",
    city: input.city ?? workspace.config.city ?? "",
    skillLevel: input.skillLevel ?? "Senior",
    priceMultiplier: Number(input.priceMultiplier ?? 1) || 1,
    luxuryEligible: input.luxuryEligible ?? "Yes",
    primaryCalendarId: input.primaryCalendarId ?? "",
    active: input.active ?? "Yes",
  };

  const existingIndex = input.artistId
    ? rows.findIndex((row) => row[0] === input.artistId)
    : -1;

  if (existingIndex >= 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.artists}!A${existingIndex + 2}:${toColumn(artistHeaders.length)}${existingIndex + 2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [artistToRow(artist)] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: workspace.spreadsheetId,
      range: `${sheetNames.artists}!A:${toColumn(artistHeaders.length)}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [artistToRow(artist)] },
    });
  }

  return artist;
}

// Soft delete: flip Active to No so the row (and any history referencing it) survives.
export async function deactivateArtist(email: string, tokens: Credentials, artistId: string) {
  const workspace = await getWorkspaceByEmail(email);
  if (!workspace) throw new Error("Workspace not found");

  const { sheets } = createGoogleClients(tokens);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: workspace.spreadsheetId,
    range: `${sheetNames.artists}!A2:${toColumn(artistHeaders.length)}`,
  });
  const rows = response.data.values ?? [];
  const index = rows.findIndex((row) => row[0] === artistId);
  if (index < 0) throw new Error("Artist not found");

  const artist = rowToArtist(rows[index]);
  artist.active = "No";
  await sheets.spreadsheets.values.update({
    spreadsheetId: workspace.spreadsheetId,
    range: `${sheetNames.artists}!A${index + 2}:${toColumn(artistHeaders.length)}${index + 2}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [artistToRow(artist)] },
  });

  return artist;
}

function artistToRow(artist: ArtistRecord) {
  return [
    artist.artistId,
    artist.name,
    artist.whatsApp,
    artist.email,
    artist.city,
    artist.skillLevel,
    artist.priceMultiplier,
    artist.luxuryEligible,
    artist.primaryCalendarId,
    artist.active,
  ];
}

function rowToArtist(row: string[]): ArtistRecord {
  return {
    artistId: row[0] ?? "",
    name: row[1] ?? "",
    whatsApp: row[2] ?? "",
    email: row[3] ?? "",
    city: row[4] ?? "",
    skillLevel: row[5] ?? "",
    priceMultiplier: Number(row[6] ?? 1) || 1,
    luxuryEligible: row[7] ?? "Yes",
    primaryCalendarId: row[8] ?? "",
    active: row[9] ?? "Yes",
  };
}

function toColumn(columnNumber: number) {
  let dividend = columnNumber;
  let columnName = "";
  while (dividend > 0) {
    const modulo = (dividend - 1) % 26;
    columnName = String.fromCharCode(65 + modulo) + columnName;
    dividend = Math.floor((dividend - modulo) / 26);
  }
  return columnName;
}
