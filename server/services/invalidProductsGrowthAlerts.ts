// @db-pool-intent: worker
// @cross-instance-safe: cooldown-guarded emit — DB invalid_products_growth_alert_last_alerted_at cooldown in system_settings gates the alert; duplicate emit is low-harm.
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  /**
 * Task #1231 — alert when the number of clients whose stored `products`
 * column contains values that would now fail strict `validateProductList`
 * validation grows since the last check.
 *
 * Task #778 added a read-only admin panel (`/api/admin/clients/invalid-products`)
 * for this audit, but admins only see it when they happen to visit the Client
 * Management page. A passive Slack/email notification when the offender count
 * grows surfaces regressions sooner (e.g. when an import or older code path
 * writes a new bad row).
 *
 * Notification semantics:
 *   - Snapshot the offenders every `CHECK_INTERVAL_MS`.
 *   - Compare the offender count to the last-known count persisted in
 *     `system_settings` (so restarts don't trigger a spurious alert).
 *   - Fire ONLY when the count *grew*. Stable or shrinking counts are
 *     silent (per the task's "no notification fires when the count is
 *     stable or shrinking" requirement).
 *   - Cooldown: even if growth happens repeatedly, do not re-alert
 *     more often than `cooldown_minutes` (default 6h). Within the
 *     cooldown the new max-seen baseline is still recorded so the next
 *     out-of-cooldown alert only fires for *additional* growth.
 *
 * Kill switch + tuning live in `system_settings` so an admin can adjust
 * without a deploy. Channel/enabled state is owned by the unified
 * notification_settings table (resolved by `notifyByType`).
 */
import { sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../db";
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { clients } from "@shared/schema";
import { validateProductList } from "@shared/productResolution";

export const NOTIFICATION_ID = "data.client_products.invalid_growth";

export const SETTING_ENABLED =
  "invalid_products_growth_alert_enabled";
export const SETTING_COOLDOWN_MINUTES =
  "invalid_products_growth_alert_cooldown_minutes";
export const SETTING_LAST_KNOWN_COUNT =
  "invalid_products_growth_alert_last_known_count";
export const SETTING_LAST_ALERTED_AT =
  "invalid_products_growth_alert_last_alerted_at";

export const DEFAULTS = {
  enabled: true,
  cooldownMinutes: 6 * 60, // 6h
};

const CHECK_INTERVAL_MS = 15 * 60_000; // 15 min

type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: string },
  options: {
    triggerSource: string;
    bypassDedupe?: boolean;
    metadata?: Record<string, unknown>;
  },
) => Promise<{ delivered: boolean; status?: string; skipReason?: string }>;

let dispatcherOverride: NotifyByTypeFn | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

function parsePositiveInt(
  raw: string | undefined | null,
  fallback: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseNonNegativeInt(
  raw: string | undefined | null,
  fallback: number,
): number {
  if (raw == null) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function parseBool(
  raw: string | undefined | null,
  fallback: boolean,
): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

export interface AlertConfig {
  enabled: boolean;
  cooldownMinutes: number;
}

export async function getAlertConfig(): Promise<AlertConfig> {
  const [enabledRow, cooldownRow] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_COOLDOWN_MINUTES).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    cooldownMinutes: parsePositiveInt(
      cooldownRow?.value,
      DEFAULTS.cooldownMinutes,
    ),
  };
}

export interface InvalidProductOffender {
  id: string;
  clientCode: string | null;
  firmName: string | null;
  storedProducts: string[];
  invalidValues: string[];
  isArchived: boolean;
  isDemo: boolean;
}

export interface InvalidProductsSnapshot {
  scanned: number;
  offenders: InvalidProductOffender[];
}

/**
 * Mirrors the audit in `/api/admin/clients/invalid-products` but applies the
 * MOST RESTRICTIVE visibility policy from that endpoint: demo clients are
 * excluded. The alert is delivered to a Slack channel whose audience is not
 * guaranteed to be CEO-only, so we match the non-CEO policy to avoid
 * leaking demo client names/codes outside the surface that already gates
 * them by role.
 */
export async function loadInvalidProductsSnapshot(): Promise<InvalidProductsSnapshot> {
  const rows = await getDb()
    .select({
      id: clients.id,
      clientCode: clients.clientCode,
      firmName: clients.firmName,
      products: clients.products,
      isArchived: clients.isArchived,
      isDemo: clients.isDemo,
    })
    .from(clients);

  const offenders: InvalidProductOffender[] = [];
  for (const r of rows) {
    if (r.isDemo) continue;
    const stored = Array.isArray(r.products) ? (r.products as string[]) : [];
    const { invalid } = validateProductList(stored);
    if (invalid.length === 0) continue;
    offenders.push({
      id: r.id,
      clientCode: r.clientCode ?? null,
      firmName: r.firmName ?? null,
      storedProducts: stored,
      invalidValues: invalid,
      isArchived: !!r.isArchived,
      isDemo: !!r.isDemo,
    });
  }

  return { scanned: rows.length, offenders };
}

function uniqueInvalidValues(offenders: InvalidProductOffender[]): string[] {
  const set = new Set<string>();
  for (const o of offenders) {
    for (const v of o.invalidValues) set.add(v);
  }
  return Array.from(set);
}

function formatOffenderLine(o: InvalidProductOffender): string {
  const name = o.firmName ?? "(unnamed)";
  const code = o.clientCode ? ` [${o.clientCode}]` : "";
  const flags: string[] = [];
  if (o.isArchived) flags.push("archived");
  if (o.isDemo) flags.push("demo");
  const flagStr = flags.length ? ` (${flags.join(", ")})` : "";
  return `    – ${name}${code}${flagStr} → [${o.invalidValues
    .map((v) => `\`${v}\``)
    .join(", ")}]`;
}

function buildAdminLink(): string {
  const base =
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.REPLIT_DEPLOYMENT_URL ||
    "";
  const path = "/admin/client-management";
  if (!base) return path;
  return `${base.replace(/\/$/, "")}${path}`;
}

function buildAlertText(args: {
  currentCount: number;
  previousCount: number;
  offenders: InvalidProductOffender[];
}): string {
  const distinct = uniqueInvalidValues(args.offenders);
  const valueList =
    distinct.length === 0
      ? "(none)"
      : distinct.map((v) => `\`${v}\``).join(", ");
  const newCount = args.currentCount - args.previousCount;
  const lines = [
    `:warning: *Clients with invalid stored product values increased* — *${args.currentCount}* offender(s) (was *${args.previousCount}*, +${newCount})`,
    `• Distinct invalid values: ${valueList}`,
  ];
  if (args.offenders.length === 0) {
    lines.push("• No offender details available.");
  } else {
    const top = args.offenders.slice(0, 10);
    lines.push("• Affected clients:");
    for (const o of top) lines.push(formatOffenderLine(o));
    if (args.offenders.length > top.length) {
      lines.push(`    – …and ${args.offenders.length - top.length} more`);
    }
  }
  lines.push(`Review: ${buildAdminLink()}`);
  return lines.join("\n");
}

export type GrowthCheckDecision =
  | "alerted"
  | "skipped_disabled"
  | "skipped_no_offenders"
  | "skipped_no_growth"
  | "skipped_seeded_baseline"
  | "skipped_cooldown"
  | "skipped_send_failed"
  | "skipped_dispatcher_skipped";

export interface GrowthCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  currentCount: number;
  /** null when no baseline existed prior to this check (first run). */
  previousCount: number | null;
  decision: GrowthCheckDecision;
  cooldownMinutes: number;
  skipReason?: string;
}

/**
 * Snapshot + compare + alert. Safe to call as often as desired — the
 * cooldown + last-known-count persistence makes it idempotent.
 */
export async function checkInvalidProductsGrowth(
  now: number = Date.now(),
): Promise<GrowthCheckResult> {
  const config = await getAlertConfig();
  const snapshot = await loadInvalidProductsSnapshot();
  const currentCount = snapshot.offenders.length;

  const previousRow = await getSystemSetting(SETTING_LAST_KNOWN_COUNT).catch(
    () => null,
  );
  const hasPreviousBaseline =
    previousRow?.value != null && String(previousRow.value).trim() !== "";
  const previousCount = hasPreviousBaseline
    ? parseNonNegativeInt(previousRow?.value, 0)
    : null;

  const result: GrowthCheckResult = {
    evaluatedAt: new Date(now).toISOString(),
    enabled: config.enabled,
    currentCount,
    previousCount,
    decision: "skipped_disabled",
    cooldownMinutes: config.cooldownMinutes,
  };

  if (!config.enabled) {
    result.skipReason = "alert disabled in system_settings";
    // Still record current count so re-enabling doesn't surface a
    // historical spike retroactively.
    await persistLastKnownCount(currentCount);
    return result;
  }

  // First run (or freshly reset): seed the baseline silently so any
  // pre-existing offenders are NOT treated as a growth event.
  if (previousCount === null) {
    result.decision = "skipped_seeded_baseline";
    result.skipReason = `seeded baseline at ${currentCount} (no prior snapshot)`;
    await persistLastKnownCount(currentCount);
    return result;
  }

  if (currentCount === 0) {
    result.decision = "skipped_no_offenders";
    result.skipReason = "no clients with invalid products";
    await persistLastKnownCount(0);
    return result;
  }

  if (currentCount <= previousCount) {
    result.decision = "skipped_no_growth";
    result.skipReason = `current ${currentCount} <= previous ${previousCount}`;
    // Lower the baseline if it shrunk so we re-alert if it climbs back up.
    if (currentCount < previousCount) {
      await persistLastKnownCount(currentCount);
    }
    return result;
  }

  // Growth detected. Honor cooldown but still advance the baseline so the
  // NEXT alert only covers further growth.
  const cooldownMs = config.cooldownMinutes * 60_000;
  const lastAlertedRow = await getSystemSetting(SETTING_LAST_ALERTED_AT).catch(
    () => null,
  );
  const lastAlertedAt = Number(lastAlertedRow?.value ?? 0);
  if (
    Number.isFinite(lastAlertedAt) &&
    lastAlertedAt > 0 &&
    now - lastAlertedAt < cooldownMs
  ) {
    result.decision = "skipped_cooldown";
    result.skipReason = `last alert ${Math.floor(
      (now - lastAlertedAt) / 60_000,
    )}m ago < ${config.cooldownMinutes}m`;
    // Advance the baseline so further growth is detected against the new
    // high-water mark instead of repeatedly re-alerting at cooldown end.
    await persistLastKnownCount(currentCount);
    return result;
  }

  const text = buildAlertText({
    currentCount,
    previousCount,
    offenders: snapshot.offenders,
  });

  let dispatchOk = false;
  let skipReason: string | undefined;
  try {
    const notifyByType =
      dispatcherOverride ??
      (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      NOTIFICATION_ID,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        bypassDedupe: true,
        metadata: {
          currentCount,
          previousCount,
          newOffenders: currentCount - previousCount,
          distinctInvalidValues: uniqueInvalidValues(snapshot.offenders),
          sampleOffenders: snapshot.offenders.slice(0, 10).map((o) => ({
            id: o.id,
            clientCode: o.clientCode,
            firmName: o.firmName,
            invalidValues: o.invalidValues,
            isArchived: o.isArchived,
            isDemo: o.isDemo,
          })),
          cooldownMinutes: config.cooldownMinutes,
        },
      },
    );
    dispatchOk = r.delivered;
    if (!r.delivered) skipReason = r.skipReason ?? r.status;
  } catch (err: any) {
    console.error(
      "[InvalidProductsGrowthAlerts] dispatch failed:",
      err?.message ?? err,
    );
    skipReason = `dispatch_error:${err?.message ?? "unknown"}`;
  }

  if (dispatchOk) {
    await persistLastKnownCount(currentCount);
    await persistLastAlertedAt(now);
    result.decision = "alerted";
    return result;
  }

  // On dispatcher failure, DO NOT advance the baseline so the next tick
  // can retry. (Mirrors the queue-drain backlog alert behaviour.)
  result.decision = skipReason?.startsWith("dispatch_error")
    ? "skipped_send_failed"
    : "skipped_dispatcher_skipped";
  result.skipReason = skipReason;
  return result;
}

async function persistLastKnownCount(count: number): Promise<void> {
  try {
    await setSystemSetting(SETTING_LAST_KNOWN_COUNT, String(count), "system");
  } catch (err: any) {
    console.warn(
      "[InvalidProductsGrowthAlerts] failed to persist last_known_count:",
      err?.message ?? err,
    );
  }
}

async function persistLastAlertedAt(at: number): Promise<void> {
  try {
    await setSystemSetting(SETTING_LAST_ALERTED_AT, String(at), "system");
  } catch (err: any) {
    console.warn(
      "[InvalidProductsGrowthAlerts] failed to persist last_alerted_at:",
      err?.message ?? err,
    );
  }
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = (async () => {
    try {
      const r = await checkInvalidProductsGrowth();
      if (r.decision === "alerted") {
        console.log(
          `[InvalidProductsGrowthAlerts] alert sent — current=${r.currentCount} previous=${r.previousCount}`,
        );
      }
    } catch (err: any) {
      console.warn(
        `[InvalidProductsGrowthAlerts] tick failed: ${err?.message ?? err}`,
      );
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startInvalidProductsGrowthAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution("scheduler:invalid-products-growth-alerts", () =>
      tick(),
    );
  }, CHECK_INTERVAL_MS);
  console.log(
    `[InvalidProductsGrowthAlerts] scheduler started (check every ${
      CHECK_INTERVAL_MS / 60_000
    }min)`,
  );
}

export function stopInvalidProductsGrowthAlertsScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __testHelpers = {
  NOTIFICATION_ID,
  DEFAULTS,
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
};
