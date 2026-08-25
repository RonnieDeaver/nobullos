// @db-pool-intent: worker
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  // @cross-instance-safe: the node-cron job runs idempotent time-cutoff DELETEs
  // (audit rows older than the retention window). node-cron's in-process timer
  // fires on every autoscale instance, but concurrent runs target the same
  // already-eligible rows, so deletion is convergent with no double-effect.
  // (Task #2397)
  import cron from "node-cron";
import { sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../db";
import {
  adminSettingAudit,
  staleLeaseThresholdAudit,
  queueTimingAudit,
} from "@shared/schema";
import {
  ensureAdminSettingAuditTable,
  ensureQueueTimingAuditTable,
  getSystemSetting,
  setSystemSetting,
  recordAdminSettingChange,
  pruneAdminSettingAuditPerScope,
  pruneAdminSettingAuditPerScopeReturning,
} from "../storage/settingsStorage";

export const ADMIN_AUDIT_RETENTION_KEY = "admin_audit_retention_days";

export const DEFAULT_RETENTION_DAYS = 180;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

export const BLOCKED_IP_AUDIT_KEY = "blocked_ip";
export const BLOCKED_IP_AUDIT_MAX_PER_IP_KEY = "blocked_ip_audit_max_per_ip";
export const BLOCKED_IP_AUDIT_TRIMMED_KEY = "blocked_ip_audit_trimmed";
export const AUDIT_PRUNE_MANUAL_KEY = "audit_prune_manual";

export const DEFAULT_BLOCKED_IP_AUDIT_MAX_PER_IP = 100;
export const MIN_BLOCKED_IP_AUDIT_MAX_PER_IP = 1;
export const MAX_BLOCKED_IP_AUDIT_MAX_PER_IP = 10_000;

// Task #1000 — `client_contacts_audit` writes one row per contact
// insert/update/delete and is never trimmed. Keep a configurable retention
// window plus a per-contact floor so the "Edit history" dialog stays
// readable but every contact still surfaces at least N most-recent rows.
export const CLIENT_CONTACTS_AUDIT_RETENTION_DAYS_KEY =
  "client_contacts_audit_retention_days";
export const CLIENT_CONTACTS_AUDIT_MIN_PER_CONTACT_KEY =
  "client_contacts_audit_min_per_contact";

export const DEFAULT_CLIENT_CONTACTS_AUDIT_RETENTION_DAYS = 365;
export const DEFAULT_CLIENT_CONTACTS_AUDIT_MIN_PER_CONTACT = 5;
export const MIN_CLIENT_CONTACTS_AUDIT_MIN_PER_CONTACT = 1;
export const MAX_CLIENT_CONTACTS_AUDIT_MIN_PER_CONTACT = 1000;

function parseRetentionDays(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < MIN_RETENTION_DAYS || parsed > MAX_RETENTION_DAYS) return null;
  return parsed;
}

export function getEnvRetentionDays(): number | null {
  return parseRetentionDays(process.env.ADMIN_AUDIT_RETENTION_DAYS);
}

function parseBlockedIpMaxPerIp(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed)) return null;
  if (
    parsed < MIN_BLOCKED_IP_AUDIT_MAX_PER_IP ||
    parsed > MAX_BLOCKED_IP_AUDIT_MAX_PER_IP
  ) {
    return null;
  }
  return parsed;
}

export function getEnvBlockedIpMaxPerIp(): number | null {
  return parseBlockedIpMaxPerIp(process.env.BLOCKED_IP_AUDIT_MAX_PER_IP);
}

export interface BlockedIpAuditRetentionInfo {
  maxEntriesPerIp: number;
  source: RetentionSource;
  defaultMax: number;
  envMax: number | null;
  minMax: number;
  maxMax: number;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export async function getBlockedIpAuditRetention(): Promise<BlockedIpAuditRetentionInfo> {
  const envMax = getEnvBlockedIpMaxPerIp();

  let settingValue: number | null = null;
  let updatedAt: Date | null = null;
  let updatedBy: string | null = null;

  try {
    const setting = await getSystemSetting(BLOCKED_IP_AUDIT_MAX_PER_IP_KEY);
    if (setting?.value) {
      settingValue = parseBlockedIpMaxPerIp(setting.value);
      updatedAt = setting.updatedAt ?? null;
      updatedBy = setting.updatedBy ?? null;
    }
  } catch (err: any) {
    console.error(
      "[AuditRetention] Failed to read blocked_ip max-per-ip setting:",
      err?.message ?? err,
    );
  }

  let maxEntriesPerIp: number;
  let source: RetentionSource;
  if (settingValue !== null) {
    maxEntriesPerIp = settingValue;
    source = "setting";
  } else if (envMax !== null) {
    maxEntriesPerIp = envMax;
    source = "env";
  } else {
    maxEntriesPerIp = DEFAULT_BLOCKED_IP_AUDIT_MAX_PER_IP;
    source = "default";
  }

  return {
    maxEntriesPerIp,
    source,
    defaultMax: DEFAULT_BLOCKED_IP_AUDIT_MAX_PER_IP,
    envMax,
    minMax: MIN_BLOCKED_IP_AUDIT_MAX_PER_IP,
    maxMax: MAX_BLOCKED_IP_AUDIT_MAX_PER_IP,
    updatedAt,
    updatedBy,
  };
}

export async function setBlockedIpAuditMaxPerIp(
  maxEntriesPerIp: number,
  changedBy: string | null,
): Promise<BlockedIpAuditRetentionInfo> {
  if (!Number.isFinite(maxEntriesPerIp) || !Number.isInteger(maxEntriesPerIp)) {
    throw new AuditRetentionValidationError("maxEntriesPerIp must be an integer");
  }
  if (
    maxEntriesPerIp < MIN_BLOCKED_IP_AUDIT_MAX_PER_IP ||
    maxEntriesPerIp > MAX_BLOCKED_IP_AUDIT_MAX_PER_IP
  ) {
    throw new AuditRetentionValidationError(
      `maxEntriesPerIp must be between ${MIN_BLOCKED_IP_AUDIT_MAX_PER_IP} and ${MAX_BLOCKED_IP_AUDIT_MAX_PER_IP}`,
    );
  }

  const previous = await getBlockedIpAuditRetention();
  await setSystemSetting(
    BLOCKED_IP_AUDIT_MAX_PER_IP_KEY,
    String(maxEntriesPerIp),
    changedBy ?? undefined,
  );

  if (
    previous.maxEntriesPerIp !== maxEntriesPerIp ||
    previous.source !== "setting"
  ) {
    try {
      await ensureAdminSettingAuditTable();
      await recordAdminSettingChange({
        settingKey: BLOCKED_IP_AUDIT_MAX_PER_IP_KEY,
        scope: null,
        changedBy: changedBy && changedBy !== "system" ? changedBy : null,
        oldValues: { maxEntriesPerIp: previous.maxEntriesPerIp, source: previous.source },
        newValues: { maxEntriesPerIp, source: "setting" },
      });
    } catch (err: any) {
      console.error(
        "[AuditRetention] Failed to record audit entry for blocked_ip retention change:",
        err?.message ?? err,
      );
    }
  }

  // Apply the new cap immediately.
  void runBlockedIpPruneOnce();

  return getBlockedIpAuditRetention();
}

async function recordBlockedIpTrimNotifications(
  results: Array<{ scope: string | null; count: number }>,
  cap: number,
): Promise<void> {
  for (const { scope, count } of results) {
    if (count <= 0) continue;
    try {
      await recordAdminSettingChange({
        settingKey: BLOCKED_IP_AUDIT_TRIMMED_KEY,
        scope,
        changedBy: null,
        oldValues: null,
        newValues: { trimmedCount: count, cap },
      });
    } catch (err: any) {
      console.error(
        "[AuditRetention] Failed to record blocked_ip trim notification:",
        err?.message ?? err,
      );
    }
  }
  // Task #780 — also enqueue an out-of-band Slack/email alert. Best-effort:
  // a failure here must never block the prune path.
  try {
    const { recordTrimEventsForAlerting } = await import("./blockedIpTrimAlerts");
    await recordTrimEventsForAlerting(results, cap);
  } catch (err: any) {
    console.error(
      "[AuditRetention] Failed to enqueue blocked_ip trim alert:",
      err?.message ?? err,
    );
  }
}

export async function pruneBlockedIpAuditNow(scope?: string): Promise<number> {
  const info = await getBlockedIpAuditRetention();
  const results = await pruneAdminSettingAuditPerScopeReturning({
    settingKey: BLOCKED_IP_AUDIT_KEY,
    maxEntriesPerScope: info.maxEntriesPerIp,
    scope,
  });
  const total = results.reduce((sum, r) => sum + r.count, 0);
  if (total > 0) {
    await recordBlockedIpTrimNotifications(results, info.maxEntriesPerIp);
  }
  return total;
}

let blockedIpPruneRunning = false;

async function runBlockedIpPruneOnce(scope?: string): Promise<number | null> {
  if (blockedIpPruneRunning) {
    return null;
  }
  blockedIpPruneRunning = true;
  try {
    const pruned = await pruneBlockedIpAuditNow(scope);
    if (pruned > 0) {
      const info = await getBlockedIpAuditRetention();
      console.log(
        `[AuditRetention] Pruned ${pruned} blocked_ip audit row(s) ` +
          `(keep last ${info.maxEntriesPerIp} per IP` +
          (scope ? `, scope=${scope})` : ")"),
      );
    }
    return pruned;
  } catch (err: any) {
    console.error(
      "[AuditRetention] blocked_ip per-IP prune failed:",
      err?.message ?? err,
    );
    return null;
  } finally {
    blockedIpPruneRunning = false;
  }
}

export async function pruneBlockedIpAuditForScope(scope: string): Promise<number | null> {
  return runBlockedIpPruneOnce(scope);
}

// ---- Client-contacts audit retention (Task #1000) ----------------------

function parseClientContactsRetentionDays(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < MIN_RETENTION_DAYS || parsed > MAX_RETENTION_DAYS) return null;
  return parsed;
}

function parseClientContactsMinPerContact(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed)) return null;
  if (
    parsed < MIN_CLIENT_CONTACTS_AUDIT_MIN_PER_CONTACT ||
    parsed > MAX_CLIENT_CONTACTS_AUDIT_MIN_PER_CONTACT
  ) {
    return null;
  }
  return parsed;
}

export interface ClientContactsAuditRetentionInfo {
  retentionDays: number;
  retentionDaysSource: "setting" | "env" | "default";
  retentionDaysUpdatedAt: Date | null;
  retentionDaysUpdatedBy: string | null;
  minPerContact: number;
  minPerContactSource: "setting" | "env" | "default";
  minPerContactUpdatedAt: Date | null;
  minPerContactUpdatedBy: string | null;
  defaultRetentionDays: number;
  defaultMinPerContact: number;
  minDays: number;
  maxDays: number;
  minPerContactMin: number;
  minPerContactMax: number;
}

export async function getClientContactsAuditRetention(): Promise<ClientContactsAuditRetentionInfo> {
  let daysSetting: number | null = null;
  let daysUpdatedAt: Date | null = null;
  let daysUpdatedBy: string | null = null;
  let minSetting: number | null = null;
  let minUpdatedAt: Date | null = null;
  let minUpdatedBy: string | null = null;

  try {
    const setting = await getSystemSetting(CLIENT_CONTACTS_AUDIT_RETENTION_DAYS_KEY);
    if (setting?.value) {
      daysSetting = parseClientContactsRetentionDays(setting.value);
      daysUpdatedAt = setting.updatedAt ?? null;
      daysUpdatedBy = setting.updatedBy ?? null;
    }
  } catch (err: any) {
    console.error(
      "[AuditRetention] Failed to read client_contacts_audit retention days:",
      err?.message ?? err,
    );
  }

  try {
    const setting = await getSystemSetting(CLIENT_CONTACTS_AUDIT_MIN_PER_CONTACT_KEY);
    if (setting?.value) {
      minSetting = parseClientContactsMinPerContact(setting.value);
      minUpdatedAt = setting.updatedAt ?? null;
      minUpdatedBy = setting.updatedBy ?? null;
    }
  } catch (err: any) {
    console.error(
      "[AuditRetention] Failed to read client_contacts_audit min-per-contact:",
      err?.message ?? err,
    );
  }

  const envDays = parseClientContactsRetentionDays(process.env.CLIENT_CONTACTS_AUDIT_RETENTION_DAYS);
  const envMin = parseClientContactsMinPerContact(process.env.CLIENT_CONTACTS_AUDIT_MIN_PER_CONTACT);

  let retentionDays: number;
  let retentionDaysSource: "setting" | "env" | "default";
  if (daysSetting !== null) {
    retentionDays = daysSetting;
    retentionDaysSource = "setting";
  } else if (envDays !== null) {
    retentionDays = envDays;
    retentionDaysSource = "env";
  } else {
    retentionDays = DEFAULT_CLIENT_CONTACTS_AUDIT_RETENTION_DAYS;
    retentionDaysSource = "default";
  }

  let minPerContact: number;
  let minPerContactSource: "setting" | "env" | "default";
  if (minSetting !== null) {
    minPerContact = minSetting;
    minPerContactSource = "setting";
  } else if (envMin !== null) {
    minPerContact = envMin;
    minPerContactSource = "env";
  } else {
    minPerContact = DEFAULT_CLIENT_CONTACTS_AUDIT_MIN_PER_CONTACT;
    minPerContactSource = "default";
  }

  return {
    retentionDays,
    retentionDaysSource,
    retentionDaysUpdatedAt: daysUpdatedAt,
    retentionDaysUpdatedBy: daysUpdatedBy,
    minPerContact,
    minPerContactSource,
    minPerContactUpdatedAt: minUpdatedAt,
    minPerContactUpdatedBy: minUpdatedBy,
    defaultRetentionDays: DEFAULT_CLIENT_CONTACTS_AUDIT_RETENTION_DAYS,
    defaultMinPerContact: DEFAULT_CLIENT_CONTACTS_AUDIT_MIN_PER_CONTACT,
    minDays: MIN_RETENTION_DAYS,
    maxDays: MAX_RETENTION_DAYS,
    minPerContactMin: MIN_CLIENT_CONTACTS_AUDIT_MIN_PER_CONTACT,
    minPerContactMax: MAX_CLIENT_CONTACTS_AUDIT_MIN_PER_CONTACT,
  };
}

export async function setClientContactsAuditRetention(
  patch: { retentionDays?: number; minPerContact?: number },
  changedBy: string | null,
): Promise<ClientContactsAuditRetentionInfo> {
  const previous = await getClientContactsAuditRetention();

  if (patch.retentionDays !== undefined) {
    const days = patch.retentionDays;
    if (!Number.isFinite(days) || !Number.isInteger(days)) {
      throw new AuditRetentionValidationError("retentionDays must be an integer");
    }
    if (days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
      throw new AuditRetentionValidationError(
        `retentionDays must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}`,
      );
    }
    await setSystemSetting(
      CLIENT_CONTACTS_AUDIT_RETENTION_DAYS_KEY,
      String(days),
      changedBy ?? undefined,
    );
    if (previous.retentionDays !== days || previous.retentionDaysSource !== "setting") {
      try {
        await ensureAdminSettingAuditTable();
        await recordAdminSettingChange({
          settingKey: CLIENT_CONTACTS_AUDIT_RETENTION_DAYS_KEY,
          scope: null,
          changedBy: changedBy && changedBy !== "system" ? changedBy : null,
          oldValues: { retentionDays: previous.retentionDays, source: previous.retentionDaysSource },
          newValues: { retentionDays: days, source: "setting" },
        });
      } catch (err: any) {
        console.error(
          "[AuditRetention] Failed to record audit entry for client_contacts retention change:",
          err?.message ?? err,
        );
      }
    }
  }

  if (patch.minPerContact !== undefined) {
    const min = patch.minPerContact;
    if (!Number.isFinite(min) || !Number.isInteger(min)) {
      throw new AuditRetentionValidationError("minPerContact must be an integer");
    }
    if (
      min < MIN_CLIENT_CONTACTS_AUDIT_MIN_PER_CONTACT ||
      min > MAX_CLIENT_CONTACTS_AUDIT_MIN_PER_CONTACT
    ) {
      throw new AuditRetentionValidationError(
        `minPerContact must be between ${MIN_CLIENT_CONTACTS_AUDIT_MIN_PER_CONTACT} and ${MAX_CLIENT_CONTACTS_AUDIT_MIN_PER_CONTACT}`,
      );
    }
    await setSystemSetting(
      CLIENT_CONTACTS_AUDIT_MIN_PER_CONTACT_KEY,
      String(min),
      changedBy ?? undefined,
    );
    if (previous.minPerContact !== min || previous.minPerContactSource !== "setting") {
      try {
        await ensureAdminSettingAuditTable();
        await recordAdminSettingChange({
          settingKey: CLIENT_CONTACTS_AUDIT_MIN_PER_CONTACT_KEY,
          scope: null,
          changedBy: changedBy && changedBy !== "system" ? changedBy : null,
          oldValues: { minPerContact: previous.minPerContact, source: previous.minPerContactSource },
          newValues: { minPerContact: min, source: "setting" },
        });
      } catch (err: any) {
        console.error(
          "[AuditRetention] Failed to record audit entry for client_contacts min-per-contact change:",
          err?.message ?? err,
        );
      }
    }
  }

  // Apply immediately so a tightened window takes effect right away.
  void runClientContactsAuditPruneOnce("save", changedBy);

  return getClientContactsAuditRetention();
}

export async function pruneClientContactsAuditNow(): Promise<{
  deleted: number;
  retentionDays: number;
  minPerContact: number;
}> {
  const info = await getClientContactsAuditRetention();
  const db = getDb();
  // Keep the latest `minPerContact` rows per contact untouched. Of the
  // remainder, delete anything older than the retention window. This way
  // every contact always has at least N most-recent edits visible even
  // if the floor pushes them past the cutoff date.
  const result = await db.execute(sql/* sql */`
    DELETE FROM client_contacts_audit
    WHERE id IN (
      SELECT id FROM (
        SELECT id, created_at,
          ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY created_at DESC NULLS LAST) AS rn
        FROM client_contacts_audit
      ) t
      WHERE rn > ${info.minPerContact}
        AND created_at < now() - (${info.retentionDays} || ' days')::interval
    )
  `);
  const deleted = (result as any)?.rowCount ?? 0;
  return {
    deleted: Number(deleted) || 0,
    retentionDays: info.retentionDays,
    minPerContact: info.minPerContact,
  };
}

export interface ClientContactsAuditStats {
  totalRows: number;
  oldestCreatedAt: string | null;
  rowsOlderThanRetention: number;
  contactsWithFloorRows: number;
}

export async function getClientContactsAuditStats(
  previewDays?: number | null,
  previewMinPerContact?: number | null,
): Promise<ClientContactsAuditStats & { retentionDays: number; minPerContact: number; previewDays: number | null; previewMinPerContact: number | null }> {
  const db = getDb();
  const info = await getClientContactsAuditRetention();
  const cutoffDays = previewDays !== undefined && previewDays !== null
    ? Math.max(MIN_RETENTION_DAYS, Math.min(MAX_RETENTION_DAYS, Math.floor(previewDays)))
    : info.retentionDays;
  const minKeep = previewMinPerContact !== undefined && previewMinPerContact !== null
    ? Math.max(
        MIN_CLIENT_CONTACTS_AUDIT_MIN_PER_CONTACT,
        Math.min(MAX_CLIENT_CONTACTS_AUDIT_MIN_PER_CONTACT, Math.floor(previewMinPerContact)),
      )
    : info.minPerContact;

  const totals = await db.execute(sql/* sql */`
    SELECT COUNT(*)::int AS total, MIN(created_at) AS oldest
    FROM client_contacts_audit
  `);
  const totalRow = (totals as any).rows?.[0] ?? {};

  const wouldPrune = await db.execute(sql/* sql */`
    SELECT COUNT(*)::int AS would_prune
    FROM (
      SELECT id, created_at,
        ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY created_at DESC NULLS LAST) AS rn
      FROM client_contacts_audit
    ) t
    WHERE rn > ${minKeep}
      AND created_at < now() - (${cutoffDays} || ' days')::interval
  `);
  const wouldRow = (wouldPrune as any).rows?.[0] ?? {};

  const floorRows = await db.execute(sql/* sql */`
    SELECT COUNT(*)::int AS contacts_with_floor
    FROM (
      SELECT contact_id, COUNT(*) AS c
      FROM client_contacts_audit
      GROUP BY contact_id
    ) g
    WHERE g.c > ${minKeep}
  `);
  const floorRow = (floorRows as any).rows?.[0] ?? {};

  return {
    totalRows: Number(totalRow.total ?? 0),
    oldestCreatedAt: totalRow.oldest ? new Date(totalRow.oldest as any).toISOString() : null,
    rowsOlderThanRetention: Number(wouldRow.would_prune ?? 0),
    contactsWithFloorRows: Number(floorRow.contacts_with_floor ?? 0),
    retentionDays: info.retentionDays,
    minPerContact: info.minPerContact,
    previewDays: previewDays !== undefined && previewDays !== null ? cutoffDays : null,
    previewMinPerContact: previewMinPerContact !== undefined && previewMinPerContact !== null ? minKeep : null,
  };
}

let clientContactsPruneRunning = false;

async function runClientContactsAuditPruneOnce(
  trigger: "scheduled" | "manual" | "save" = "scheduled",
  triggeredBy: string | null = null,
): Promise<{ deleted: number; retentionDays: number; minPerContact: number } | null> {
  if (clientContactsPruneRunning) return null;
  clientContactsPruneRunning = true;
  try {
    const result = await pruneClientContactsAuditNow();
    if (result.deleted > 0) {
      console.log(
        `[AuditRetention] Pruned client_contacts_audit=${result.deleted} ` +
          `(retention=${result.retentionDays}d, keep last ${result.minPerContact} per contact, trigger=${trigger})`,
      );
    }
    try {
      const { recordPruneEvent } = await import("./auditPruneEvents");
      await recordPruneEvent("client_contacts_audit", {
        at: new Date().toISOString(),
        removed: result.deleted,
        maxEntries: result.minPerContact,
        maxAgeDays: result.retentionDays,
        trigger,
        triggeredBy,
      });
    } catch (err: any) {
      console.error(
        "[AuditRetention] Failed to record client_contacts_audit prune event:",
        err?.message ?? err,
      );
    }
    return result;
  } catch (err: any) {
    console.error(
      "[AuditRetention] client_contacts_audit prune failed:",
      err?.message ?? err,
    );
    return null;
  } finally {
    clientContactsPruneRunning = false;
  }
}

export async function triggerClientContactsAuditPruneNow(
  triggeredBy: string | null = null,
): Promise<{ deleted: number; retentionDays: number; minPerContact: number } | null> {
  return runClientContactsAuditPruneOnce("manual", triggeredBy);
}

export type RetentionSource = "setting" | "env" | "default";

export interface AuditRetentionInfo {
  retentionDays: number;
  source: RetentionSource;
  defaultDays: number;
  envDays: number | null;
  minDays: number;
  maxDays: number;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export async function getAuditRetentionDays(): Promise<AuditRetentionInfo> {
  const envDays = getEnvRetentionDays();

  let settingValue: number | null = null;
  let updatedAt: Date | null = null;
  let updatedBy: string | null = null;

  try {
    const setting = await getSystemSetting(ADMIN_AUDIT_RETENTION_KEY);
    if (setting?.value) {
      settingValue = parseRetentionDays(setting.value);
      updatedAt = setting.updatedAt ?? null;
      updatedBy = setting.updatedBy ?? null;
    }
  } catch (err: any) {
    console.error("[AuditRetention] Failed to read system setting:", err?.message ?? err);
  }

  let retentionDays: number;
  let source: RetentionSource;
  if (settingValue !== null) {
    retentionDays = settingValue;
    source = "setting";
  } else if (envDays !== null) {
    retentionDays = envDays;
    source = "env";
  } else {
    retentionDays = DEFAULT_RETENTION_DAYS;
    source = "default";
  }

  return {
    retentionDays,
    source,
    defaultDays: DEFAULT_RETENTION_DAYS,
    envDays,
    minDays: MIN_RETENTION_DAYS,
    maxDays: MAX_RETENTION_DAYS,
    updatedAt,
    updatedBy,
  };
}

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;
let pruneRunning = false;

export interface AuditPruneResult {
  adminSettingAuditDeleted: number;
  staleLeaseThresholdAuditDeleted: number;
  queueTimingAuditDeleted: number;
  retentionDays: number;
}

export interface AuditTableStats {
  totalRows: number;
  oldestChangedAt: string | null;
  rowsOlderThanRetention: number;
}

export interface AuditSettingKeyBreakdown {
  settingKey: string;
  totalRows: number;
  oldestChangedAt: string | null;
  rowsOlderThanRetention: number;
}

export interface AuditRetentionStats {
  retentionDays: number;
  previewDays: number | null;
  adminSettingAudit: AuditTableStats;
  staleLeaseThresholdAudit: AuditTableStats;
  queueTimingAudit: AuditTableStats;
  adminSettingAuditByKey: AuditSettingKeyBreakdown[];
  adminSettingAuditByKeyLimit: number;
  adminSettingAuditDistinctKeys: number;
}

export const ADMIN_SETTING_AUDIT_BY_KEY_LIMIT = 20;

export async function getAuditRetentionStats(
  previewDays?: number | null,
): Promise<AuditRetentionStats> {
  await ensureAdminSettingAuditTable();
  await ensureQueueTimingAuditTable();
  const db = getDb();

  const info = await getAuditRetentionDays();
  const cutoffDays = previewDays !== undefined && previewDays !== null
    ? Math.max(MIN_RETENTION_DAYS, Math.min(MAX_RETENTION_DAYS, Math.floor(previewDays)))
    : info.retentionDays;

  async function statsFor(table: any): Promise<AuditTableStats> {
    const [totalRow] = await db
      .select({
        total: sql<number>`count(*)::int`,
        oldest: sql<Date | null>`min(${table.changedAt})`,
      })
      .from(table);
    const [olderRow] = await db
      .select({
        older: sql<number>`count(*)::int`,
      })
      .from(table)
      .where(sql`${table.changedAt} < now() - (${cutoffDays} || ' days')::interval`);
    return {
      totalRows: Number(totalRow?.total ?? 0),
      oldestChangedAt: totalRow?.oldest ? new Date(totalRow.oldest as any).toISOString() : null,
      rowsOlderThanRetention: Number(olderRow?.older ?? 0),
    };
  }

  async function adminSettingKeyBreakdown(): Promise<{
    rows: AuditSettingKeyBreakdown[];
    distinctKeys: number;
  }> {
    const rowsResult = await db.execute(sql`
      SELECT
        setting_key AS "settingKey",
        COUNT(*)::int AS "totalRows",
        MIN(changed_at) AS "oldestChangedAt",
        COUNT(*) FILTER (
          WHERE changed_at < now() - (${cutoffDays} || ' days')::interval
        )::int AS "rowsOlderThanRetention"
      FROM admin_setting_audit
      GROUP BY setting_key
      ORDER BY COUNT(*) DESC, setting_key ASC
      LIMIT ${ADMIN_SETTING_AUDIT_BY_KEY_LIMIT}
    `);
    const distinctResult = await db.execute(sql`
      SELECT COUNT(DISTINCT setting_key)::int AS "distinctKeys"
      FROM admin_setting_audit
    `);
    const rawRows = (rowsResult as any).rows ?? (rowsResult as any) ?? [];
    const rows: AuditSettingKeyBreakdown[] = (rawRows as any[]).map((r) => ({
      settingKey: String(r.settingKey ?? ""),
      totalRows: Number(r.totalRows ?? 0),
      oldestChangedAt: r.oldestChangedAt
        ? new Date(r.oldestChangedAt as any).toISOString()
        : null,
      rowsOlderThanRetention: Number(r.rowsOlderThanRetention ?? 0),
    }));
    const distinctRow = ((distinctResult as any).rows ?? (distinctResult as any) ?? [])[0];
    const distinctKeys = Number(distinctRow?.distinctKeys ?? rows.length) || 0;
    return { rows, distinctKeys };
  }

  const [admin, stale, queue, adminByKey] = await Promise.all([
    statsFor(adminSettingAudit),
    statsFor(staleLeaseThresholdAudit),
    statsFor(queueTimingAudit),
    adminSettingKeyBreakdown(),
  ]);

  return {
    retentionDays: info.retentionDays,
    previewDays: previewDays !== undefined && previewDays !== null ? cutoffDays : null,
    adminSettingAudit: admin,
    staleLeaseThresholdAudit: stale,
    queueTimingAudit: queue,
    adminSettingAuditByKey: adminByKey.rows,
    adminSettingAuditByKeyLimit: ADMIN_SETTING_AUDIT_BY_KEY_LIMIT,
    adminSettingAuditDistinctKeys: adminByKey.distinctKeys,
  };
}

export async function pruneOldAuditRows(
  retentionDays?: number,
): Promise<AuditPruneResult> {
  const db = getDb();
  await ensureAdminSettingAuditTable();
  await ensureQueueTimingAuditTable();

  let effectiveDays: number;
  if (retentionDays === undefined) {
    effectiveDays = (await getAuditRetentionDays()).retentionDays;
  } else {
    effectiveDays = retentionDays;
  }
  const safeRetention = Math.max(
    MIN_RETENTION_DAYS,
    Math.min(MAX_RETENTION_DAYS, Math.floor(effectiveDays)),
  );

  const adminDeleted = await db
    .delete(adminSettingAudit)
    .where(sql`${adminSettingAudit.changedAt} < now() - (${safeRetention} || ' days')::interval`)
    .returning({ id: adminSettingAudit.id });
  const staleDeleted = await db
    .delete(staleLeaseThresholdAudit)
    .where(sql`${staleLeaseThresholdAudit.changedAt} < now() - (${safeRetention} || ' days')::interval`)
    .returning({ id: staleLeaseThresholdAudit.id });
  const queueTimingDeleted = await db
    .delete(queueTimingAudit)
    .where(sql`${queueTimingAudit.changedAt} < now() - (${safeRetention} || ' days')::interval`)
    .returning({ id: queueTimingAudit.id });

  return {
    adminSettingAuditDeleted: adminDeleted.length,
    staleLeaseThresholdAuditDeleted: staleDeleted.length,
    queueTimingAuditDeleted: queueTimingDeleted.length,
    retentionDays: safeRetention,
  };
}

async function runPruneOnce(
  trigger: "scheduled" | "manual" | "save" = "scheduled",
  triggeredBy: string | null = null,
): Promise<AuditPruneResult | null> {
  if (pruneRunning) {
    console.log("[AuditRetention] Previous prune still running, skipping");
    return null;
  }
  pruneRunning = true;
  try {
    const result = await pruneOldAuditRows();
    console.log(
      `[AuditRetention] Pruned admin_setting_audit=${result.adminSettingAuditDeleted}, ` +
      `stale_lease_threshold_audit=${result.staleLeaseThresholdAuditDeleted}, ` +
      `queue_timing_audit=${result.queueTimingAuditDeleted} ` +
      `(retention=${result.retentionDays}d, trigger=${trigger})`,
    );

    const at = new Date().toISOString();
    const perTableEvents = [
      {
        table: "admin_setting_audit" as const,
        event: {
          at,
          removed: result.adminSettingAuditDeleted,
          maxEntries: 0,
          maxAgeDays: result.retentionDays,
          trigger,
          triggeredBy,
        },
      },
      {
        table: "stale_lease_threshold_audit" as const,
        event: {
          at,
          removed: result.staleLeaseThresholdAuditDeleted,
          maxEntries: 0,
          maxAgeDays: result.retentionDays,
          trigger,
          triggeredBy,
        },
      },
      {
        table: "queue_timing_audit" as const,
        event: {
          at,
          removed: result.queueTimingAuditDeleted,
          maxEntries: 0,
          maxAgeDays: result.retentionDays,
          trigger,
          triggeredBy,
        },
      },
    ];

    try {
      const { recordPruneEvent } = await import("./auditPruneEvents");
      await Promise.all(
        perTableEvents.map(({ table, event }) => recordPruneEvent(table, event)),
      );
    } catch (recordErr: any) {
      console.error(
        "[AuditRetention] Failed to record per-table prune event:",
        recordErr?.message ?? recordErr,
      );
    }

    // Task #774 — fire a Slack/email alert if any per-table delete count
    // crossed the configured anomaly threshold (e.g. operator widened the
    // retention window the wrong way and an order-of-magnitude more rows
    // were deleted than usual).
    try {
      const { evaluatePruneRun } = await import("./auditPruneAnomalyAlerts");
      await evaluatePruneRun(perTableEvents);
    } catch (alertErr: any) {
      console.error(
        "[AuditRetention] Failed to evaluate prune anomaly alerts:",
        alertErr?.message ?? alertErr,
      );
    }

    let blockedIpPruned: number | null = null;
    try {
      const blockedIpInfo = await getBlockedIpAuditRetention();
      const blockedIpResults = await pruneAdminSettingAuditPerScopeReturning({
        settingKey: BLOCKED_IP_AUDIT_KEY,
        maxEntriesPerScope: blockedIpInfo.maxEntriesPerIp,
      });
      blockedIpPruned = blockedIpResults.reduce((sum, r) => sum + r.count, 0);
      if (blockedIpPruned > 0) {
        await recordBlockedIpTrimNotifications(blockedIpResults, blockedIpInfo.maxEntriesPerIp);
      }
      console.log(
        `[AuditRetention] Pruned blocked_ip per-IP excess=${blockedIpPruned} ` +
          `(keep last ${blockedIpInfo.maxEntriesPerIp} per IP, source=${blockedIpInfo.source})`,
      );
      const blockedIpEvent = {
        at: new Date().toISOString(),
        removed: blockedIpPruned,
        maxEntries: blockedIpInfo.maxEntriesPerIp,
        maxAgeDays: 0,
        trigger,
        triggeredBy,
      };
      try {
        const { recordPruneEvent } = await import("./auditPruneEvents");
        await recordPruneEvent("blocked_ip_audit", blockedIpEvent);
      } catch {}
      try {
        const { evaluatePruneRun } = await import("./auditPruneAnomalyAlerts");
        await evaluatePruneRun([
          { table: "blocked_ip_audit", event: blockedIpEvent },
        ]);
      } catch (alertErr: any) {
        console.error(
          "[AuditRetention] Failed to evaluate blocked_ip prune anomaly alert:",
          alertErr?.message ?? alertErr,
        );
      }
    } catch (err: any) {
      console.error(
        "[AuditRetention] blocked_ip per-IP prune failed:",
        err?.message ?? err,
      );
    }

    // Task #1000 — also prune the client_contacts_audit shadow table.
    let clientContactsPruned: number | null = null;
    let clientContactsRetentionInfo: { retentionDays: number; minPerContact: number } | null = null;
    try {
      const ccResult = await runClientContactsAuditPruneOnce(trigger, triggeredBy);
      if (ccResult) {
        clientContactsPruned = ccResult.deleted;
        clientContactsRetentionInfo = {
          retentionDays: ccResult.retentionDays,
          minPerContact: ccResult.minPerContact,
        };
      }
    } catch (err: any) {
      console.error(
        "[AuditRetention] client_contacts_audit prune failed:",
        err?.message ?? err,
      );
    }

    if (trigger === "manual") {
      try {
        await recordAdminSettingChange({
          settingKey: AUDIT_PRUNE_MANUAL_KEY,
          scope: null,
          changedBy: triggeredBy && triggeredBy !== "system" ? triggeredBy : null,
          oldValues: null,
          newValues: {
            trigger,
            retentionDays: result.retentionDays,
            adminSettingAuditDeleted: result.adminSettingAuditDeleted,
            staleLeaseThresholdAuditDeleted: result.staleLeaseThresholdAuditDeleted,
            queueTimingAuditDeleted: result.queueTimingAuditDeleted,
            blockedIpAuditDeleted: blockedIpPruned,
            clientContactsAuditDeleted: clientContactsPruned,
            clientContactsAuditRetention: clientContactsRetentionInfo,
          },
        });
      } catch (err: any) {
        console.error(
          "[AuditRetention] Failed to record manual prune audit row:",
          err?.message ?? err,
        );
      }
    }

    return result;
  } catch (err: any) {
    console.error("[AuditRetention] Prune failed:", err?.message ?? err);
    return null;
  } finally {
    pruneRunning = false;
  }
}

export async function triggerAuditPruneNow(
  triggeredBy: string | null = null,
): Promise<AuditPruneResult | null> {
  return runPruneOnce("manual", triggeredBy);
}

export class AuditRetentionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditRetentionValidationError";
  }
}

export async function setAuditRetentionDays(
  days: number,
  changedBy: string | null,
): Promise<AuditRetentionInfo> {
  if (!Number.isFinite(days) || !Number.isInteger(days)) {
    throw new AuditRetentionValidationError("retentionDays must be an integer");
  }
  if (days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
    throw new AuditRetentionValidationError(
      `retentionDays must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}`,
    );
  }

  const previous = await getAuditRetentionDays();
  await setSystemSetting(
    ADMIN_AUDIT_RETENTION_KEY,
    String(days),
    changedBy ?? undefined,
  );

  if (previous.retentionDays !== days || previous.source !== "setting") {
    try {
      await ensureAdminSettingAuditTable();
      await recordAdminSettingChange({
        settingKey: ADMIN_AUDIT_RETENTION_KEY,
        scope: null,
        changedBy: changedBy && changedBy !== "system" ? changedBy : null,
        oldValues: { retentionDays: previous.retentionDays, source: previous.source },
        newValues: { retentionDays: days, source: "setting" },
      });
    } catch (err: any) {
      console.error(
        "[AuditRetention] Failed to record audit entry for retention change:",
        err?.message ?? err,
      );
    }
  }

  // Apply immediately so a tightened window takes effect right away.
  void runPruneOnce("save", changedBy);

  return getAuditRetentionDays();
}

export function startAuditRetentionScheduler(
  cronExpression = "30 3 * * *",
): void {
  if (scheduledTask) {
    void scheduledTask.stop(); // fire-and-forget: node-cron v4 stop() is async; nothing awaits teardown
  }

  scheduledTask = cron.schedule(cronExpression, () => {
    void withDbAttribution("maintenance:audit-retention-prune", () => runPruneOnce());
  }, {
    timezone: "America/New_York",
  });

  void getAuditRetentionDays().then((info) => {
    console.log(
      `[AuditRetention] Scheduled audit prune with cron: ${cronExpression} ` +
      `(America/New_York), retention=${info.retentionDays}d (source=${info.source})`,
    );
  });

  setTimeout(() => {
    void withDbAttribution("startup:audit-retention-initial-prune", () => runPruneOnce());
  }, 5_000);
}

export function stopAuditRetentionScheduler(): void {
  if (scheduledTask) {
    void scheduledTask.stop(); // fire-and-forget: node-cron v4 stop() is async; nothing awaits teardown
    scheduledTask = null;
    console.log("[AuditRetention] Stopped");
  }
}
