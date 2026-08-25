/**
 * Task #994 — Resolves the effective channel/enabled state for a notification.
 *
 * Precedence (highest to lowest):
 *   1. Env override (any of registry.envOverrideKeys with a non-empty value).
 *   2. notification_settings row (channelId).
 *   3. Legacy system_settings row (registry.defaultChannelSettingKey,
 *      legacySettingKeys[]).
 *   4. Default = no channel.
 *
 * Enabled state lives only on the notification_settings row; if no row exists
 * the registry's `defaultEnabled` is used. An env override does not change
 * the saved enabled flag — it only forces the channel.
 */

import { storage } from "../../storage";
import { dbRetry } from "../../db";
import {
  getNotification,
  type NotificationRegistryEntry,
} from "./registry";
import {
  getNotificationSetting,
  upsertNotificationSetting,
} from "../../storage/notificationsStorage";
import type { NotificationSettingSource } from "@shared/schema";

export interface ResolvedNotification {
  id: string;
  registry: NotificationRegistryEntry;
  enabled: boolean;
  channelId: string | null;
  channelName: string | null;
  source: NotificationSettingSource;
  envOverrideActive: boolean;
  envChannelId: string | null;
  legacyChannelId: string | null;
  savedRow: Awaited<ReturnType<typeof getNotificationSetting>> | undefined;
}

async function readLegacyChannelId(
  entry: NotificationRegistryEntry,
): Promise<string | null> {
  const keys = [
    ...(entry.defaultChannelSettingKey ? [entry.defaultChannelSettingKey] : []),
    ...(entry.legacySettingKeys ?? []),
  ];
  for (const key of keys) {
    try {
      const row = await dbRetry(
        () => storage.getSystemSetting(key),
        `notifications.resolver.legacy:${key}`,
      );
      const value = row?.value?.trim();
      if (value) return value;
    } catch {
      // best-effort
    }
  }
  return null;
}

function readEnvChannelId(entry: NotificationRegistryEntry): string | null {
  for (const key of entry.envOverrideKeys ?? []) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return null;
}

export async function resolveNotification(id: string): Promise<ResolvedNotification | null> {
  const entry = getNotification(id);
  if (!entry) return null;
  const [saved, legacyChannelId] = await Promise.all([
    getNotificationSetting(id).catch(() => undefined),
    readLegacyChannelId(entry),
  ]);
  const envChannelId = readEnvChannelId(entry);

  let channelId: string | null = null;
  let channelName: string | null = saved?.channelName ?? null;
  let source: NotificationSettingSource = "default";

  if (envChannelId) {
    channelId = envChannelId;
    channelName = null;
    source = "env_override";
  } else if (saved) {
    // Saved row is authoritative for channel, even when channelId is
    // explicitly null (admin cleared the channel). Legacy keys must NOT
    // be re-read once an admin has saved a setting — that would silently
    // re-enable old routing after a deliberate clear.
    channelId = saved.channelId ?? null;
    source = "notification_settings";
  } else if (legacyChannelId) {
    channelId = legacyChannelId;
    source = "legacy_migrated";
  } else {
    source = "none";
  }

  const enabled = saved ? saved.enabled : entry.defaultEnabled;

  return {
    id,
    registry: entry,
    enabled,
    channelId,
    channelName,
    source,
    envOverrideActive: !!envChannelId,
    envChannelId,
    legacyChannelId,
    savedRow: saved,
  };
}

/**
 * One-shot helper used by the admin API + the dispatcher: ensures that any
 * legacy channel value is durably stored in `notification_settings` so that
 * future resolutions don't need to re-read the legacy row. Idempotent.
 */
export async function migrateLegacyIfNeeded(id: string): Promise<void> {
  const resolved = await resolveNotification(id);
  if (!resolved) return;
  if (resolved.source !== "legacy_migrated") return;
  if (!resolved.legacyChannelId) return;
  if (resolved.savedRow?.channelId) return;
  await upsertNotificationSetting({
    notificationId: id,
    enabled: resolved.enabled,
    channelId: resolved.legacyChannelId,
    channelName: null,
    updatedBy: null,
    source: "legacy_migrated",
  });
}
