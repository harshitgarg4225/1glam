// Per-client photo gallery: before/after looks attached to a specific client
// (and optionally a booking). Distinct from the workspace portfolio, which is
// public marketing imagery on the booking page. These are private working
// records — the artist's visual history of what she did for each client.

export type ClientPhoto = {
  photoId: string;
  clientWhatsApp: string;
  bookingId: string;
  url: string;
  caption: string;
  kind: "before" | "after" | "look";
  uploadedAt: string;
};

export const clientPhotoHeaders = [
  "Photo ID",
  "Client WhatsApp",
  "Booking ID",
  "URL",
  "Caption",
  "Kind",
  "Uploaded At",
] as const;

export function parseClientPhoto(row: string[]): ClientPhoto {
  return {
    photoId: row[0] || "",
    clientWhatsApp: row[1] || "",
    bookingId: row[2] || "",
    url: row[3] || "",
    caption: row[4] || "",
    kind: (row[5] as ClientPhoto["kind"]) || "look",
    uploadedAt: row[6] || "",
  };
}

export function clientPhotoToRow(photo: ClientPhoto): string[] {
  return [
    photo.photoId,
    photo.clientWhatsApp,
    photo.bookingId,
    photo.url,
    photo.caption,
    photo.kind,
    photo.uploadedAt,
  ];
}
