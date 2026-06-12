import webpush from "web-push";
import { appConfig } from "../config.js";
import { saveWorkspace } from "./database.js";
import { getWorkspaceByEmail } from "./workspace.js";
import { fcmConfigured, FcmTokenInvalidError, sendFcmNotification } from "./fcm.js";
import { captureException } from "./logger.js";
import type { WorkspaceRecord } from "../types.js";

// Push: the app pings her phone the moment a new request lands. Two transports,
// fanned out side by side from sendPushToWorkspace:
//   - Web push (installed PWA / browser) — needs VAPID keys in env.
//   - FCM (native iOS/Android app) — needs FCM_SERVICE_ACCOUNT_JSON in env.
// Both optional; without keys the UI simply hides the enable button.

export type PushSubscriptionRecord = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export type DeviceTokenRecord = {
  token: string;
  platform: "ios" | "android";
  updatedAt: string;
};

let vapidReady = false;

export function pushConfigured(): boolean {
  if (!appConfig.vapidPublicKey || !appConfig.vapidPrivateKey) return false;
  if (!vapidReady) {
    webpush.setVapidDetails(
      `mailto:support@${new URL(appConfig.baseUrl).hostname}`,
      appConfig.vapidPublicKey,
      appConfig.vapidPrivateKey,
    );
    vapidReady = true;
  }
  return true;
}

export async function addPushSubscription(email: string, subscription: PushSubscriptionRecord) {
  const workspace = await getWorkspaceByEmail(email);
  if (!workspace) throw new Error("Workspace not found");
  const existing = workspace.pushSubscriptions ?? [];
  if (!existing.some((s) => s.endpoint === subscription.endpoint)) {
    // Cap per workspace so a long-lived account can't accumulate stale endpoints.
    workspace.pushSubscriptions = [...existing.slice(-9), subscription];
    workspace.updatedAt = new Date().toISOString();
    await saveWorkspace(workspace);
  }
}

export async function removePushSubscription(email: string, endpoint: string) {
  const workspace = await getWorkspaceByEmail(email);
  if (!workspace) return;
  const remaining = (workspace.pushSubscriptions ?? []).filter((s) => s.endpoint !== endpoint);
  workspace.pushSubscriptions = remaining;
  workspace.updatedAt = new Date().toISOString();
  await saveWorkspace(workspace);
}

// FCM device tokens from the native app. Re-registering an existing token just
// refreshes its timestamp (tokens rotate; the app re-registers on every launch).
export async function addDeviceToken(
  email: string,
  token: string,
  platform: "ios" | "android",
) {
  const workspace = await getWorkspaceByEmail(email);
  if (!workspace) throw new Error("Workspace not found");
  const existing = (workspace.deviceTokens ?? []).filter((t) => t.token !== token);
  workspace.deviceTokens = [
    ...existing.slice(-9),
    { token, platform, updatedAt: new Date().toISOString() },
  ];
  workspace.updatedAt = new Date().toISOString();
  await saveWorkspace(workspace);
}

export async function removeDeviceToken(email: string, token: string) {
  const workspace = await getWorkspaceByEmail(email);
  if (!workspace) return;
  workspace.deviceTokens = (workspace.deviceTokens ?? []).filter((t) => t.token !== token);
  workspace.updatedAt = new Date().toISOString();
  await saveWorkspace(workspace);
}

// Fire-and-forget: sends to every device she enabled — web-push endpoints and
// native FCM tokens. Dead endpoints/tokens (uninstalled app, expired
// subscription) are pruned so the lists stay clean.
export async function sendPushToWorkspace(
  workspace: WorkspaceRecord,
  payload: { title: string; body: string; url?: string },
): Promise<void> {
  const subscriptions = pushConfigured() ? (workspace.pushSubscriptions ?? []) : [];
  const deviceTokens = fcmConfigured() ? (workspace.deviceTokens ?? []) : [];
  if (!subscriptions.length && !deviceTokens.length) return;

  const body = JSON.stringify(payload);
  const deadEndpoints: string[] = [];
  const deadTokens: string[] = [];

  await Promise.all([
    ...subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(subscription, body);
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) deadEndpoints.push(subscription.endpoint);
      }
    }),
    ...deviceTokens.map(async (device) => {
      try {
        await sendFcmNotification(device.token, payload);
      } catch (error) {
        if (error instanceof FcmTokenInvalidError) {
          deadTokens.push(device.token);
        } else {
          captureException(error, { transport: "fcm", platform: device.platform });
        }
      }
    }),
  ]);

  if (deadEndpoints.length || deadTokens.length) {
    if (deadEndpoints.length) {
      workspace.pushSubscriptions = subscriptions.filter((s) => !deadEndpoints.includes(s.endpoint));
    }
    if (deadTokens.length) {
      workspace.deviceTokens = deviceTokens.filter((t) => !deadTokens.includes(t.token));
    }
    workspace.updatedAt = new Date().toISOString();
    await saveWorkspace(workspace).catch(() => undefined);
  }
}
