import type { Credentials } from "google-auth-library";
import { findWorkspaceByEmail } from "./database.js";
import { normalizeStoredTokens, refreshStoredTokens } from "./google.js";
import { persistWorkspaceTokens } from "./workspace.js";

export async function getWorkspaceCredentials(email: string): Promise<Credentials> {
  const workspace = await findWorkspaceByEmail(email);
  if (!workspace?.googleTokens) {
    throw new Error("Stored Google credentials not found for workspace");
  }

  const refreshed = await refreshStoredTokens(workspace.googleTokens, async (nextTokens) => {
    await persistWorkspaceTokens(email, nextTokens);
  });

  await persistWorkspaceTokens(email, normalizeStoredTokens(refreshed));
  return refreshed;
}
