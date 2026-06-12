import { GoogleAuth } from "google-auth-library";
import { appConfig } from "../config.js";
import { fetchWithTimeout } from "./http.js";
import { logger } from "./logger.js";

// Native push for the iOS/Android app, via Firebase Cloud Messaging (HTTP v1).
// Optional — configured with a Firebase service-account JSON in env. Web push
// (push.ts) and native push fan out side by side from sendPushToWorkspace, so
// the artist gets the ping on whichever device(s) she has set up.

type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
};

let cached: { auth: GoogleAuth; projectId: string } | null = null;
let parseFailed = false;

function parseServiceAccount(): ServiceAccount | null {
  const raw = appConfig.fcmServiceAccountJson.trim();
  if (!raw) return null;
  try {
    // Accept either the raw JSON or a base64-encoded blob (easier to paste
    // into single-line env var UIs without escaping newlines in private_key).
    const text = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(text) as Partial<ServiceAccount>;
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) return null;
    return parsed as ServiceAccount;
  } catch {
    return null;
  }
}

function getFcm() {
  if (cached || parseFailed) return cached;
  const account = parseServiceAccount();
  if (!account) {
    if (appConfig.fcmServiceAccountJson) {
      parseFailed = true;
      logger.warn("fcm_service_account_invalid", {
        message: "FCM_SERVICE_ACCOUNT_JSON is set but could not be parsed — native push disabled.",
      });
    }
    return null;
  }
  cached = {
    projectId: account.project_id,
    auth: new GoogleAuth({
      credentials: { client_email: account.client_email, private_key: account.private_key },
      scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
    }),
  };
  return cached;
}

export function fcmConfigured(): boolean {
  return getFcm() !== null;
}

// Thrown when FCM reports the device token is gone (app uninstalled, token
// rotated). Callers prune the token from the workspace record.
export class FcmTokenInvalidError extends Error {}

export async function sendFcmNotification(
  deviceToken: string,
  payload: { title: string; body: string; url?: string },
): Promise<void> {
  const fcm = getFcm();
  if (!fcm) throw new Error("FCM is not configured");

  const accessToken = await fcm.auth.getAccessToken();
  const response = await fetchWithTimeout(
    `https://fcm.googleapis.com/v1/projects/${fcm.projectId}/messages:send`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          notification: { title: payload.title, body: payload.body },
          // The in-app bridge reads data.url on notification tap and navigates
          // the webview there (e.g. straight to the new lead).
          data: { url: payload.url || "/" },
          android: { priority: "HIGH", notification: { sound: "default" } },
          apns: { payload: { aps: { sound: "default" } } },
        },
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 404 || text.includes("UNREGISTERED") || text.includes("NOT_FOUND")) {
      throw new FcmTokenInvalidError(text);
    }
    throw new Error(`FCM send failed (${response.status}): ${text}`);
  }
}
