import webpush from "web-push";
import { appConfig } from "../config.js";
import { saveWorkspace } from "./database.js";
import { getWorkspaceByEmail } from "./workspace.js";
import type { WorkspaceRecord } from "../types.js";

// Web push: the app pings her phone the moment a new request lands, even with
// the browser closed (installed PWA). Optional — needs VAPID keys in env;
// without them the UI simply hides the enable button.

export type PushSubscriptionRecord = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
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

// Fire-and-forget: sends to every device she enabled; dead endpoints (410/404)
// are pruned so the list stays clean.
export async function sendPushToWorkspace(
  workspace: WorkspaceRecord,
  payload: { title: string; body: string; url?: string },
): Promise<void> {
  if (!pushConfigured()) return;
  const subscriptions = workspace.pushSubscriptions ?? [];
  if (!subscriptions.length) return;
  const body = JSON.stringify(payload);
  const dead: string[] = [];
  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(subscription, body);
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) dead.push(subscription.endpoint);
      }
    }),
  );
  if (dead.length) {
    workspace.pushSubscriptions = subscriptions.filter((s) => !dead.includes(s.endpoint));
    workspace.updatedAt = new Date().toISOString();
    await saveWorkspace(workspace).catch(() => undefined);
  }
}
