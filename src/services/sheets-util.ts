import type { sheets_v4 } from "googleapis";

// Lazily ensures a named tab exists in the spreadsheet, creating it (with a
// header row) if missing. New sheet tabs are seeded only at workspace creation,
// so any feature added later (gift cards, promo codes, client photos, packages)
// must call this before first read/write or it would fail on older workspaces.
//
// Idempotent and cheap: one metadata read; the addSheet + header write only run
// when the tab is actually absent. Concurrent callers may race to create the
// same tab — the second addSheet returns a 400 we treat as "already exists".
export async function ensureSheetTab(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  title: string,
  headers: readonly string[],
): Promise<void> {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title",
  });
  const existing = (meta.data.sheets ?? []).some((s) => s.properties?.title === title);
  if (existing) return;

  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
  } catch (error) {
    // A concurrent caller may have created it first; only swallow that case.
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) throw error;
    return;
  }

  const lastCol = columnLetter(headers.length);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${title}!A1:${lastCol}1`,
    valueInputOption: "RAW",
    requestBody: { values: [[...headers]] },
  });
}

function columnLetter(columnNumber: number): string {
  let dividend = columnNumber;
  let name = "";
  while (dividend > 0) {
    const modulo = (dividend - 1) % 26;
    name = String.fromCharCode(65 + modulo) + name;
    dividend = Math.floor((dividend - modulo) / 26);
  }
  return name;
}
