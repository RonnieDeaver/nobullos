// @db-pool-intent: worker
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  /**
 * Task #1224 — alert + digest for unreviewed `import_entity_suggestions`.
 *
 * Task #756 added a UI for operators to review pending import suggestions
 * (`/admin/import-suggestions`), but it's a pull surface — if nobody opens
 * it, suggestions can sit `pending` for weeks. Two notifications close
 * that gap:
 *
 *   1. **Threshold-based backlog alert** (`queue.import_suggestions.backlog`)
 *      — fires when the total `status='pending'` count crosses the
 *      configured threshold. Cooldown prevents spam: once we alert, the
 *      same channel is silent until either `cooldown_minutes` minutes have
 *      elapsed OR the backlog grows by another full `growth_threshold`
 *      rows since the last alert.
 *
 *   2. **Daily/weekly digest** (`queue.import_suggestions.digest`) —
 *      summary of pending counts grouped by client + surface. Sent at the
 *      configured UTC hour (and weekday, for weekly cadence).
 *      Idempotency is enforced via a `last_sent_key` system_setting.
 *
 * Both controls live in `system_settings` so an admin can tune them
 * without a deploy. Channel/enabled state is owned by the unified
 * notification_settings table (resolved by `notifyByType`).
 */
import { sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../db";
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { importEntitySuggestions } from "@shared/schema";

export const NOTIFICATION_BACKLOG_ID = "queue.import_suggestions.backlog";
export const NOTIFICATION_DIGEST_ID = "queue.import_suggestions.digest";

// ── Threshold-alert settings ───────────────────────────────────────────
export const SETTING_BACKLOG_ENABLED = "import_suggestions_backlog_alert_enabled";
export const SETTING_BACKLOG_THRESHOLD = "import_suggestions_backlog_alert_threshold";
export const SETTING_BACKLOG_GROWTH = "import_suggestions_backlog_alert_growth_threshold";
export const SETTING_BACKLOG_COOLDOWN = "import_suggestions_backlog_alert_cooldown_minutes";

// ── Digest settings ────────────────────────────────────────────────────
export const SETTING_DIGEST_ENABLED = "import_suggestions_digest.enabled";
export const SETTING_DIGEST_CADENCE = "import_suggestions_digest.cadence";
export const SETTING_DIGEST_HOUR = "import_suggestions_digest.hour_utc";
export const SETTING_DIGEST_WEEKDAY = "import_suggestions_digest.weekday_utc";
export const SETTING_DIGEST_LAST_SENT = "import_suggestions_digest.last_sent_key";

const DEFAULTS = {
  backlogEnabled: true,
  backlogThreshold: 50,
  backlogGrowthThreshold: 25,
  backlogCooldownMinutes: 6 * 60,
  digestEnabled: false,
  digestCadence: "daily" as "daily" | "weekly",
  digestHourUtc: 15,
  digestWeekdayUtc: 1, // Sun=0, Mon=1
};

const CHECK_INTERVAL_MS = 5 * 60_000;

export interface BacklogAlertConfig {
  enabled: boolean;
  threshold: number;
  growthThreshold: number;
  cooldownMinutes: number;
}

export interface DigestConfig {
  enabled: boolean;
  cadence: "daily" | "weekly";
  hourUtc: number;
  weekdayUtc: number;
}

interface LastBacklogAlert {
  at: number;
  pendingCount: number;
}

const lastBacklogAlert: { current: LastBacklogAlert | null } = { current: null };

type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: string },
  options: { triggerSource: string; bypassDedupe?: boolean; metadata?: Record<string, unknown> },
) => Promise<{ delivered: boolean; status?: string; skipReason?: string }>;

let dispatcherOverride: NotifyByTypeFn | null = null;

let interval: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

function parsePositiveInt(raw: string | undefined | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseNonNegativeInt(raw: string | undefined | null, fallback: number, max: number): number {
  if (raw == null) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0 || n > max) return fallback;
  return n;
}

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

function parseCadence(raw: string | undefined | null, fallback: "daily" | "weekly"): "daily" | "weekly" {
  if (!raw) return fallback;
  const v = raw.trim().toLowerCase();
  return v === "weekly" ? "weekly" : v === "daily" ? "daily" : fallback;
}

export async function getBacklogAlertConfig(): Promise<BacklogAlertConfig> {
  const [enabledRow, thresholdRow, growthRow, cooldownRow] = await Promise.all([
    getSystemSetting(SETTING_BACKLOG_ENABLED).catch(() => null),
    getSystemSetting(SETTING_BACKLOG_THRESHOLD).catch(() => null),
    getSystemSetting(SETTING_BACKLOG_GROWTH).catch(() => null),
    getSystemSetting(SETTING_BACKLOG_COOLDOWN).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.backlogEnabled),
    threshold: parsePositiveInt(thresholdRow?.value, DEFAULTS.backlogThreshold),
    growthThreshold: parsePositiveInt(growthRow?.value, DEFAULTS.backlogGrowthThreshold),
    cooldownMinutes: parsePositiveInt(cooldownRow?.value, DEFAULTS.backlogCooldownMinutes),
  };
}

export async function getDigestConfig(): Promise<DigestConfig> {
  const [enabledRow, cadenceRow, hourRow, weekdayRow] = await Promise.all([
    getSystemSetting(SETTING_DIGEST_ENABLED).catch(() => null),
    getSystemSetting(SETTING_DIGEST_CADENCE).catch(() => null),
    getSystemSetting(SETTING_DIGEST_HOUR).catch(() => null),
    getSystemSetting(SETTING_DIGEST_WEEKDAY).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.digestEnabled),
    cadence: parseCadence(cadenceRow?.value, DEFAULTS.digestCadence),
    hourUtc: parseNonNegativeInt(hourRow?.value, DEFAULTS.digestHourUtc, 23),
    weekdayUtc: parseNonNegativeInt(weekdayRow?.value, DEFAULTS.digestWeekdayUtc, 6),
  };
}

interface SurfaceBreakdownRow {
  clientId: string;
  surface: string;
  pendingCount: number;
  oldestPendingAt: Date | null;
}

export interface BacklogSnapshot {
  totalPending: number;
  perSurface: SurfaceBreakdownRow[];
  oldestPendingAt: Date | null;
}

function coerceDate(raw: unknown): Date | null {
  if (raw == null) return null;
  if (raw instanceof Date) return raw;
  const d = new Date(raw as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function loadBacklogSnapshot(): Promise<BacklogSnapshot> {
  const rawRows = await getDb()
    .select({
      clientId: importEntitySuggestions.clientId,
      surface: importEntitySuggestions.surface,
      pendingCount: sql<number>`count(*)::int`,
      oldestPendingAt: sql<Date | string | null>`min(${importEntitySuggestions.createdAt})`,
    })
    .from(importEntitySuggestions)
    .where(sql`${importEntitySuggestions.status} = 'pending'`)
    .groupBy(importEntitySuggestions.clientId, importEntitySuggestions.surface);

  const rows: SurfaceBreakdownRow[] = rawRows.map((r) => ({
    clientId: r.clientId,
    surface: r.surface,
    pendingCount: Number(r.pendingCount) || 0,
    oldestPendingAt: coerceDate(r.oldestPendingAt),
  }));

  let total = 0;
  let oldest: Date | null = null;
  for (const r of rows) {
    total += r.pendingCount;
    if (r.oldestPendingAt && (!oldest || r.oldestPendingAt < oldest)) oldest = r.oldestPendingAt;
  }
  return { totalPending: total, perSurface: rows, oldestPendingAt: oldest };
}

function buildAdminLink(): string {
  const base =
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.REPLIT_DEPLOYMENT_URL ||
    "";
  const path = "/admin/import-suggestions";
  if (!base) return path;
  return `${base.replace(/\/$/, "")}${path}`;
}

function formatAge(ms: number): string {
  const days = ms / 86_400_000;
  if (days >= 1) return `${days.toFixed(days < 10 ? 1 : 0)}d`;
  const hours = ms / 3_600_000;
  if (hours >= 1) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes}m`;
}

function buildBacklogAlertText(args: {
  totalPending: number;
  threshold: number;
  oldestPendingAt: Date | null;
  topSurfaces: SurfaceBreakdownRow[];
  now: number;
}): string {
  const link = buildAdminLink();
  const lines = [
    `:warning: *Import suggestions backlog over threshold* — *${args.totalPending}* pending (threshold ${args.threshold})`,
  ];
  if (args.oldestPendingAt) {
    lines.push(`• Oldest pending: ${formatAge(args.now - args.oldestPendingAt.getTime())} ago`);
  }
  if (args.topSurfaces.length > 0) {
    const top = args.topSurfaces.slice(0, 5);
    lines.push("• Top surfaces:");
    for (const s of top) {
      lines.push(`    – \`${s.surface}\` (client \`${s.clientId}\`): ${s.pendingCount}`);
    }
    if (args.topSurfaces.length > top.length) {
      lines.push(`    – …and ${args.topSurfaces.length - top.length} more groups`);
    }
  }
  lines.push(`Review the queue: ${link}`);
  return lines.join("\n");
}

function buildDigestText(args: {
  cadence: "daily" | "weekly";
  snapshot: BacklogSnapshot;
  now: number;
}): string {
  const link = buildAdminLink();
  const cadenceLabel = args.cadence === "weekly" ? "Weekly" : "Daily";
  const lines = [
    `:bar_chart: *${cadenceLabel} import-suggestions digest* — *${args.snapshot.totalPending}* pending`,
  ];
  if (args.snapshot.oldestPendingAt) {
    lines.push(`• Oldest pending: ${formatAge(args.now - args.snapshot.oldestPendingAt.getTime())} ago`);
  }
  if (args.snapshot.perSurface.length === 0) {
    lines.push("• No pending suggestions across any client/surface — queue is clear.");
  } else {
    const sorted = [...args.snapshot.perSurface].sort((a, b) => b.pendingCount - a.pendingCount);
    const top = sorted.slice(0, 10);
    lines.push("• Pending by client / surface:");
    for (const s of top) {
      lines.push(`    – \`${s.surface}\` (client \`${s.clientId}\`): ${s.pendingCount}`);
    }
    if (sorted.length > top.length) {
      lines.push(`    – …and ${sorted.length - top.length} more groups`);
    }
  }
  lines.push(`Review the queue: ${link}`);
  return lines.join("\n");
}

export interface BacklogCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  totalPending: number;
  decision:
    | "alerted"
    | "skipped_disabled"
    | "skipped_below_threshold"
    | "skipped_cooldown"
    | "skipped_no_growth_since_last_alert"
    | "skipped_send_failed"
    | "skipped_dispatcher_skipped";
  skipReason?: string;
}

export async function checkImportSuggestionsBacklog(now: number = Date.now()): Promise<BacklogCheckResult> {
  const config = await getBacklogAlertConfig();
  const snapshot = await loadBacklogSnapshot();
  const result: BacklogCheckResult = {
    evaluatedAt: new Date(now).toISOString(),
    enabled: config.enabled,
    totalPending: snapshot.totalPending,
    decision: "skipped_disabled",
  };

  if (!config.enabled) {
    result.skipReason = "alert disabled in system_settings";
    return result;
  }

  if (snapshot.totalPending < config.threshold) {
    result.decision = "skipped_below_threshold";
    result.skipReason = `pending ${snapshot.totalPending} < threshold ${config.threshold}`;
    return result;
  }

  const cooldownMs = config.cooldownMinutes * 60_000;
  const last = lastBacklogAlert.current;
  if (last) {
    const elapsedMs = now - last.at;
    const growthSinceLastAlert = snapshot.totalPending - last.pendingCount;
    if (elapsedMs < cooldownMs && growthSinceLastAlert < config.growthThreshold) {
      if (growthSinceLastAlert <= 0) {
        result.decision = "skipped_no_growth_since_last_alert";
        result.skipReason = `no growth since last alert (${snapshot.totalPending} ≤ ${last.pendingCount})`;
      } else {
        result.decision = "skipped_cooldown";
        result.skipReason = `cooldown ${Math.round(elapsedMs / 60_000)}m < ${config.cooldownMinutes}m and growth-since-last ${growthSinceLastAlert} < ${config.growthThreshold}`;
      }
      return result;
    }
  }

  const sorted = [...snapshot.perSurface].sort((a, b) => b.pendingCount - a.pendingCount);
  const text = buildBacklogAlertText({
    totalPending: snapshot.totalPending,
    threshold: config.threshold,
    oldestPendingAt: snapshot.oldestPendingAt,
    topSurfaces: sorted,
    now,
  });

  let dispatchOk = false;
  let skipReason: string | undefined;
  try {
    const notifyByType =
      dispatcherOverride ?? (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      NOTIFICATION_BACKLOG_ID,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        bypassDedupe: true,
        metadata: {
          totalPending: snapshot.totalPending,
          threshold: config.threshold,
          growthThreshold: config.growthThreshold,
          surfaceGroups: snapshot.perSurface.length,
          oldestPendingAt: snapshot.oldestPendingAt?.toISOString() ?? null,
        },
      },
    );
    dispatchOk = r.delivered;
    if (!r.delivered) skipReason = r.skipReason ?? r.status;
  } catch (err: any) {
    console.error(`[ImportSuggestionsBacklogAlerts] dispatch failed: ${err?.message}`);
    skipReason = `dispatch_error:${err?.message ?? "unknown"}`;
  }

  if (dispatchOk) {
    lastBacklogAlert.current = { at: now, pendingCount: snapshot.totalPending };
    result.decision = "alerted";
  } else {
    result.decision = skipReason?.startsWith("dispatch_error")
      ? "skipped_send_failed"
      : "skipped_dispatcher_skipped";
    result.skipReason = skipReason;
  }
  return result;
}

export interface DigestCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  shouldSend: boolean;
  reason: string;
  sent: boolean;
  totalPending: number;
  lastSentKey?: string | null;
}

function buildDigestKey(cadence: "daily" | "weekly", now: Date): string {
  const y = now.getUTCFullYear();
  if (cadence === "daily") {
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  // ISO week (UTC-based, simple). Good enough for once-per-week dedupe.
  const target = new Date(Date.UTC(y, now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const diffDays = Math.round((target.getTime() - firstThursday.getTime()) / 86_400_000);
  const week = 1 + Math.floor(diffDays / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export async function checkImportSuggestionsDigest(
  now: number = Date.now(),
): Promise<DigestCheckResult> {
  const config = await getDigestConfig();
  const ts = new Date(now);
  const result: DigestCheckResult = {
    evaluatedAt: ts.toISOString(),
    enabled: config.enabled,
    shouldSend: false,
    reason: "",
    sent: false,
    totalPending: 0,
  };

  if (!config.enabled) {
    result.reason = "digest disabled";
    return result;
  }
  if (ts.getUTCHours() !== config.hourUtc) {
    result.reason = `not at digest hour (target ${config.hourUtc}, now ${ts.getUTCHours()})`;
    return result;
  }
  if (config.cadence === "weekly" && ts.getUTCDay() !== config.weekdayUtc) {
    result.reason = `not at digest weekday (target ${config.weekdayUtc}, now ${ts.getUTCDay()})`;
    return result;
  }

  const key = buildDigestKey(config.cadence, ts);
  const lastSentRow = await getSystemSetting(SETTING_DIGEST_LAST_SENT).catch(() => null);
  result.lastSentKey = lastSentRow?.value ?? null;
  if (lastSentRow?.value === key) {
    result.reason = `already sent for ${key}`;
    return result;
  }

  const snapshot = await loadBacklogSnapshot();
  result.totalPending = snapshot.totalPending;
  result.shouldSend = true;

  const text = buildDigestText({ cadence: config.cadence, snapshot, now });
  let dispatchOk = false;
  try {
    const notifyByType =
      dispatcherOverride ?? (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      NOTIFICATION_DIGEST_ID,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "scheduled",
        bypassDedupe: true,
        metadata: {
          cadence: config.cadence,
          totalPending: snapshot.totalPending,
          surfaceGroups: snapshot.perSurface.length,
          digestKey: key,
        },
      },
    );
    dispatchOk = r.delivered;
    if (!r.delivered) result.reason = r.skipReason ?? r.status ?? "dispatcher_skipped";
  } catch (err: any) {
    console.error(`[ImportSuggestionsDigest] dispatch failed: ${err?.message}`);
    result.reason = `dispatch_error:${err?.message ?? "unknown"}`;
  }

  if (dispatchOk) {
    result.sent = true;
    result.reason = `sent ${config.cadence} digest for ${key}`;
    try {
      await setSystemSetting(SETTING_DIGEST_LAST_SENT, key, "system");
    } catch (err: any) {
      console.warn(
        `[ImportSuggestionsDigest] failed to persist last_sent_key=${key}: ${err?.message}`,
      );
    }
  }
  return result;
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = (async () => {
    try {
      const r = await checkImportSuggestionsBacklog();
      if (r.decision === "alerted") {
        console.log(
          `[ImportSuggestionsBacklogAlerts] backlog alert sent — pending=${r.totalPending}`,
        );
      }
    } catch (err: any) {
      console.warn(`[ImportSuggestionsBacklogAlerts] backlog tick failed: ${err?.message}`);
    }
    try {
      const d = await checkImportSuggestionsDigest();
      if (d.sent) {
        console.log(
          `[ImportSuggestionsDigest] digest sent — pending=${d.totalPending} (${d.reason})`,
        );
      }
    } catch (err: any) {
      console.warn(`[ImportSuggestionsDigest] digest tick failed: ${err?.message}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startImportSuggestionsBacklogAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution("scheduler:import-suggestions-backlog-alerts", () => tick());
  }, CHECK_INTERVAL_MS);
  console.log(
    `[ImportSuggestionsBacklogAlerts] scheduler started (check every ${CHECK_INTERVAL_MS / 60_000}min)`,
  );
}

export function stopImportSuggestionsBacklogAlertsScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __testHelpers = {
  NOTIFICATION_BACKLOG_ID,
  NOTIFICATION_DIGEST_ID,
  DEFAULTS,
  resetLastAlertCache(): void {
    lastBacklogAlert.current = null;
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
};
