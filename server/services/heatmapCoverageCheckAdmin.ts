/**
 * Task #1115 — Admin getter/setter for the post-backfill heatmap coverage
 * check settings (Task #651). The runtime read path lives in
 * `heatmapCoverageCheck.ts` (`getHeatmapCoverageCheckSettings`); this module
 * adds the write path used by the admin form on `/admin/match-settings`.
 *
 * Each individual setting key is written through `storage.setSystemSetting`
 * and an `adminSettingAudit` row is captured per key that actually changed,
 * matching how `matchSettingsAlerts` and `zoomComparativeResetAlertChannel`
 * record their writes.
 */

import { storage } from "../storage";
import {
  getHeatmapCoverageCheckSettings,
  type CoverageCheckSettings,
} from "./heatmapCoverageCheck";
import type { LastEditedInfo } from "../routes/lastEditedHelper";

const SETTING_ENABLED = "heatmap_coverage_check_after_backfill_enabled";
const SETTING_DELAY_SECONDS = "heatmap_coverage_check_delay_seconds";
const SETTING_RECHECK_SECONDS = "heatmap_coverage_check_recheck_interval_seconds";
const SETTING_MAX_ATTEMPTS = "heatmap_coverage_check_max_attempts";
const SETTING_SLACK_CHANNEL = "heatmap_coverage_alert_slack_channel_id";
const SETTING_ALERT_ON_SUCCESS = "heatmap_coverage_alert_on_success";

export const HEATMAP_COVERAGE_CHECK_SETTING_KEYS = {
  enabled: SETTING_ENABLED,
  delaySeconds: SETTING_DELAY_SECONDS,
  recheckIntervalSeconds: SETTING_RECHECK_SECONDS,
  maxAttempts: SETTING_MAX_ATTEMPTS,
  slackChannelId: SETTING_SLACK_CHANNEL,
  alertOnSuccess: SETTING_ALERT_ON_SUCCESS,
} as const;

export const HEATMAP_COVERAGE_CHECK_DEFAULTS: CoverageCheckSettings = {
  enabled: true,
  delaySeconds: 3600,
  recheckIntervalSeconds: 1800,
  maxAttempts: 6,
  slackChannelId: null,
  alertOnSuccess: false,
};

const ALL_KEYS = Object.values(HEATMAP_COVERAGE_CHECK_SETTING_KEYS);

export interface HeatmapCoverageCheckAdminStatus {
  settings: CoverageCheckSettings;
  defaults: CoverageCheckSettings;
  lastEdited: LastEditedInfo | null;
  lastEditedKey: string | null;
}

async function getMostRecentlyEditedKey(): Promise<{
  key: string | null;
  lastEdited: LastEditedInfo | null;
}> {
  let latestUpdatedAt: Date | null = null;
  let latestUpdatedBy: string | null = null;
  let latestKey: string | null = null;
  for (const key of ALL_KEYS) {
    try {
      const setting = await storage.getSystemSetting(key);
      if (!setting?.updatedAt) continue;
      const ts = new Date(setting.updatedAt);
      if (!latestUpdatedAt || ts > latestUpdatedAt) {
        latestUpdatedAt = ts;
        latestUpdatedBy = setting.updatedBy ?? null;
        latestKey = key;
      }
    } catch {
      // skip — keep scanning
    }
  }
  if (!latestUpdatedAt && !latestUpdatedBy) {
    return { key: null, lastEdited: null };
  }
  const { resolveLastEditedUsers, buildLastEdited } = await import(
    "../routes/lastEditedHelper"
  );
  const userMap = await resolveLastEditedUsers([latestUpdatedBy]);
  return {
    key: latestKey,
    lastEdited: buildLastEdited(latestUpdatedAt, latestUpdatedBy, userMap),
  };
}

export async function heatmapCoverageCheckAdminStatus(): Promise<HeatmapCoverageCheckAdminStatus> {
  const settings = await getHeatmapCoverageCheckSettings();
  const last = await getMostRecentlyEditedKey();
  return {
    settings,
    defaults: HEATMAP_COVERAGE_CHECK_DEFAULTS,
    lastEdited: last.lastEdited,
    lastEditedKey: last.key,
  };
}

export interface HeatmapCoverageCheckUpdate {
  enabled?: boolean;
  delaySeconds?: number;
  recheckIntervalSeconds?: number;
  maxAttempts?: number;
  slackChannelId?: string | null;
  alertOnSuccess?: boolean;
}

export interface HeatmapCoverageCheckUpdateResult {
  status: HeatmapCoverageCheckAdminStatus;
  changed: string[];
}

async function writeSettingWithAudit(opts: {
  key: string;
  newValue: string;
  oldValue: string;
  oldDisplay: unknown;
  newDisplay: unknown;
  updatedBy: string;
}): Promise<boolean> {
  if (opts.newValue === opts.oldValue) return false;
  await storage.setSystemSetting(opts.key, opts.newValue, opts.updatedBy);
  try {
    await storage.recordAdminSettingChange({
      settingKey: opts.key,
      scope: null,
      changedBy:
        opts.updatedBy && opts.updatedBy !== "system" ? opts.updatedBy : null,
      oldValues: { value: opts.oldDisplay },
      newValues: { value: opts.newDisplay },
    });
  } catch (err: any) {
    console.error(
      "[heatmap-coverage-check-admin] Audit record failed:",
      opts.key,
      err?.message,
    );
  }
  return true;
}

export async function setHeatmapCoverageCheckSettings(
  patch: HeatmapCoverageCheckUpdate,
  updatedBy: string,
): Promise<HeatmapCoverageCheckUpdateResult> {
  const previous = await getHeatmapCoverageCheckSettings();
  const changed: string[] = [];

  if (patch.enabled !== undefined) {
    const ok = await writeSettingWithAudit({
      key: SETTING_ENABLED,
      newValue: patch.enabled ? "true" : "false",
      oldValue: previous.enabled ? "true" : "false",
      oldDisplay: previous.enabled,
      newDisplay: patch.enabled,
      updatedBy,
    });
    if (ok) changed.push(SETTING_ENABLED);
  }
  if (patch.alertOnSuccess !== undefined) {
    const ok = await writeSettingWithAudit({
      key: SETTING_ALERT_ON_SUCCESS,
      newValue: patch.alertOnSuccess ? "true" : "false",
      oldValue: previous.alertOnSuccess ? "true" : "false",
      oldDisplay: previous.alertOnSuccess,
      newDisplay: patch.alertOnSuccess,
      updatedBy,
    });
    if (ok) changed.push(SETTING_ALERT_ON_SUCCESS);
  }
  if (patch.delaySeconds !== undefined) {
    const ok = await writeSettingWithAudit({
      key: SETTING_DELAY_SECONDS,
      newValue: String(patch.delaySeconds),
      oldValue: String(previous.delaySeconds),
      oldDisplay: previous.delaySeconds,
      newDisplay: patch.delaySeconds,
      updatedBy,
    });
    if (ok) changed.push(SETTING_DELAY_SECONDS);
  }
  if (patch.recheckIntervalSeconds !== undefined) {
    const ok = await writeSettingWithAudit({
      key: SETTING_RECHECK_SECONDS,
      newValue: String(patch.recheckIntervalSeconds),
      oldValue: String(previous.recheckIntervalSeconds),
      oldDisplay: previous.recheckIntervalSeconds,
      newDisplay: patch.recheckIntervalSeconds,
      updatedBy,
    });
    if (ok) changed.push(SETTING_RECHECK_SECONDS);
  }
  if (patch.maxAttempts !== undefined) {
    const ok = await writeSettingWithAudit({
      key: SETTING_MAX_ATTEMPTS,
      newValue: String(patch.maxAttempts),
      oldValue: String(previous.maxAttempts),
      oldDisplay: previous.maxAttempts,
      newDisplay: patch.maxAttempts,
      updatedBy,
    });
    if (ok) changed.push(SETTING_MAX_ATTEMPTS);
  }
  if (patch.slackChannelId !== undefined) {
    const trimmed = (patch.slackChannelId ?? "").trim();
    const next = trimmed; // empty string clears the override
    const prev = previous.slackChannelId ?? "";
    const ok = await writeSettingWithAudit({
      key: SETTING_SLACK_CHANNEL,
      newValue: next,
      oldValue: prev,
      oldDisplay: previous.slackChannelId,
      newDisplay: trimmed ? trimmed : null,
      updatedBy,
    });
    if (ok) changed.push(SETTING_SLACK_CHANNEL);
  }

  const status = await heatmapCoverageCheckAdminStatus();
  return { status, changed };
}

export function validateHeatmapCoverageCheckUpdate(
  body: unknown,
): { ok: true; patch: HeatmapCoverageCheckUpdate } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Request body must be an object" };
  }
  const b = body as Record<string, unknown>;
  const patch: HeatmapCoverageCheckUpdate = {};

  if ("enabled" in b) {
    if (typeof b.enabled !== "boolean") {
      return { ok: false, error: "enabled must be a boolean" };
    }
    patch.enabled = b.enabled;
  }
  if ("alertOnSuccess" in b) {
    if (typeof b.alertOnSuccess !== "boolean") {
      return { ok: false, error: "alertOnSuccess must be a boolean" };
    }
    patch.alertOnSuccess = b.alertOnSuccess;
  }
  if ("delaySeconds" in b) {
    const n = Number(b.delaySeconds);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 86400) {
      return {
        ok: false,
        error: "delaySeconds must be an integer between 0 and 86400",
      };
    }
    patch.delaySeconds = n;
  }
  if ("recheckIntervalSeconds" in b) {
    const n = Number(b.recheckIntervalSeconds);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 30 || n > 86400) {
      return {
        ok: false,
        error: "recheckIntervalSeconds must be an integer between 30 and 86400",
      };
    }
    patch.recheckIntervalSeconds = n;
  }
  if ("maxAttempts" in b) {
    const n = Number(b.maxAttempts);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 50) {
      return {
        ok: false,
        error: "maxAttempts must be an integer between 1 and 50",
      };
    }
    patch.maxAttempts = n;
  }
  if ("slackChannelId" in b) {
    const v = b.slackChannelId;
    if (v !== null && typeof v !== "string") {
      return { ok: false, error: "slackChannelId must be a string or null" };
    }
    patch.slackChannelId = v as string | null;
  }

  return { ok: true, patch };
}
