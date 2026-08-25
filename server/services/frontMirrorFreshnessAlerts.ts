/**
 * Task #2146 — Alert when the Front email mirror stops getting new entries.
 *
 * Background
 * ----------
 * On 2026-04-14 the `front_sync_emails` mirror silently froze: the
 * on-demand writer had been removed during the move to the durable
 * webhook pipeline and nothing replaced it, so the table stopped
 * receiving rows for weeks. Nobody noticed until the coverage numbers
 * had drifted badly, because no watcher looked at the table's
 * freshness. Task #1831 restored the writer
 * (`frontSyncEmailMirror.ts`, confirmed permanent in Task #2092), but
 * the same silent-freeze failure mode can recur if the mirror path is
 * disabled (its kill switch `front_sync_emails_mirror_enabled`) or
 * breaks.
 *
 * What this watcher does
 * ----------------------
 * It compares the mirror's freshness (`MAX(created_at)` on
 * `front_sync_emails`) against live Front webhook intake
 * (`MAX(received_at)` on `source_event_log` where
 * `source_system='front'`). It fires only when Front webhooks ARE
 * arriving recently but the mirror's newest row has fallen behind by
 * more than the configured lag threshold — i.e. the writer is disabled
 * or broken. When no fresh Front webhooks exist at all (a genuinely
 * quiet period, or an upstream Front delivery stall) it stays silent,
 * so it doesn't cry wolf. The upstream-stall case is already owned by
 * `frontWebhookReceiverStalenessAlerts` (Task #1602).
 *
 * Relationship to the sibling Front watchers
 * ------------------------------------------
 *   * `frontWebhookReceiverStalenessAlerts` — no webhooks arriving
 *     (upstream Front delivery stalled).
 *   * `frontPipelineStuckAlerts` — rows in a non-terminal
 *     `pipeline_state` aging out (apply stage stalled).
 *   * THIS watcher — webhooks arriving but the mirror writer has
 *     stopped inserting new rows (writer disabled / broken).
 *
 * Configuration (all in `system_settings`):
 *   * `front_mirror_freshness_alert_enabled` — kill switch (default
 *     true; the conservative lag threshold below keeps it quiet).
 *   * `front_mirror_freshness_alert_lag_minutes` — how far the
 *     mirror's newest row may fall behind the latest fresh Front
 *     webhook before alerting, AND the freshness window a Front
 *     webhook must fall within to count as "live traffic" (default
 *     180 = 3h).
 *   * `front_mirror_freshness_alert_cooldown_minutes` — re-alert
 *     cooldown while still frozen (default 360 = 6h).
 *
 * Channel resolution is owned by the dispatcher (notification id
 * `pipeline.front_sync_emails.mirror_frozen` → `notification_settings`
 * → `rate_limit_alert_slack_channel_id` legacy fallback).
 */
// @db-pool-intent: worker
//   This watcher runs from the staggered worker scheduler; all DB work
//   is wrapped in runWithWorkerDb(...) so the test-only AsyncLocalStorage
//   schema sandbox in `tests/db-sandbox.ts` can redirect getDb() at the
//   isolated schema.
import { sql } from "drizzle-orm";
import { getDb, runWithWorkerDb, withDbAttribution } from "../db";
import { getSystemSetting } from "../storage/settingsStorage";
import { isPoolEpicSwitchEnabled } from "./poolEpicKillSwitches";

const NOTIFICATION_ID = "pipeline.front_sync_emails.mirror_frozen";

export const SETTING_ENABLED = "front_mirror_freshness_alert_enabled";
export const SETTING_LAG_MINUTES = "front_mirror_freshness_alert_lag_minutes";
export const SETTING_COOLDOWN_MINUTES =
  "front_mirror_freshness_alert_cooldown_minutes";

const DEFAULTS = {
  enabled: true,
  lagMinutes: 180,
  cooldownMinutes: 6 * 60,
};

const CHECK_INTERVAL_MS = 5 * 60_000;

export interface FrontMirrorFreshnessConfig {
  enabled: boolean;
  lagMinutes: number;
  cooldownMinutes: number;
}

interface LastAlertRecord {
  at: number;
  mirrorAgeMinutes: number | null;
}

let lastAlert: LastAlertRecord | null = null;

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

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

export async function getFrontMirrorFreshnessConfig(): Promise<FrontMirrorFreshnessConfig> {
  const [enabledRow, lagRow, cooldownRow] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_LAG_MINUTES).catch(() => null),
    getSystemSetting(SETTING_COOLDOWN_MINUTES).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    lagMinutes: parsePositiveInt(lagRow?.value, DEFAULTS.lagMinutes),
    cooldownMinutes: parsePositiveInt(
      cooldownRow?.value,
      DEFAULTS.cooldownMinutes,
    ),
  };
}

function coerceDate(raw: unknown): Date | null {
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw as string);
  return Number.isFinite(d.getTime()) ? d : null;
}

interface FreshnessRow {
  mirror_latest: Date | string | null;
  webhook_latest: Date | string | null;
}

async function queryFreshness(): Promise<{
  mirrorLatest: Date | null;
  webhookLatest: Date | null;
}> {
  const r = await runWithWorkerDb(() =>
    withDbAttribution("alerts:front_mirror_freshness:query", () =>
      getDb().execute(sql`
        SELECT
          (SELECT MAX(created_at) FROM front_sync_emails)            AS mirror_latest,
          (SELECT MAX(received_at) FROM source_event_log
             WHERE source_system = 'front')                         AS webhook_latest
      `),
    ),
  );
  const row = (r.rows?.[0] ?? null) as unknown as FreshnessRow | null;
  return {
    mirrorLatest: coerceDate(row?.mirror_latest ?? null),
    webhookLatest: coerceDate(row?.webhook_latest ?? null),
  };
}

function buildAdminLink(): string {
  const base =
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.REPLIT_DEPLOYMENT_URL ||
    "";
  const path = "/admin/front-historical-recovery";
  if (!base) return path;
  return `${base.replace(/\/$/, "")}${path}`;
}

function buildAlertText(args: {
  mirrorAgeMinutes: number | null;
  webhookAgeMinutes: number;
  mirrorBehindWebhookMinutes: number | null;
  mirrorLatest: Date | null;
  webhookLatest: Date | null;
  mirrorSwitchEnabled: boolean;
  config: FrontMirrorFreshnessConfig;
}): string {
  const mirrorLine =
    args.mirrorLatest && args.mirrorAgeMinutes != null
      ? `• Mirror's newest row (\`MAX(created_at)\`) is *${args.mirrorAgeMinutes}m* old (at ${args.mirrorLatest.toISOString()}) — *${args.mirrorBehindWebhookMinutes}m behind* the latest Front webhook`
      : `• The mirror has *no rows at all* (\`MAX(created_at)\` is NULL) while Front webhooks keep arriving`;
  const causeLine = args.mirrorSwitchEnabled
    ? `• The \`front_sync_emails_mirror_enabled\` kill switch is *ON* — the writer is enabled but appears broken (normalize stage not calling the mirror, or upserts failing). Check \`[FrontSyncEmailMirror]\` warnings in the logs.`
    : `• The \`front_sync_emails_mirror_enabled\` kill switch is *OFF* — the writer is intentionally disabled. Re-enable it in \`system_settings\` to resume mirroring.`;
  return [
    `:warning: *Front email mirror has stopped receiving new rows*`,
    `• Front webhooks ARE still arriving — latest \`source_event_log\` (front) is only *${args.webhookAgeMinutes}m* old`,
    mirrorLine,
    `• Lag threshold (mirror behind webhook): ${args.config.lagMinutes}m`,
    causeLine,
    `• Silence during planned maintenance: \`system_settings.${SETTING_ENABLED}\` → \`false\``,
    `• Drill in: ${buildAdminLink()}`,
  ].join("\n");
}

export interface FrontMirrorFreshnessCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  lagMinutes: number;
  cooldownMinutes: number;
  mirrorLatest: string | null;
  webhookLatest: string | null;
  mirrorAgeMinutes: number | null;
  webhookAgeMinutes: number | null;
  mirrorBehindWebhookMinutes: number | null;
  mirrorSwitchEnabled: boolean;
  alertsSent: number;
  decision:
    | "alerted"
    | "skipped_disabled"
    | "skipped_no_webhook_traffic"
    | "skipped_mirror_fresh"
    | "skipped_cooldown"
    | "skipped_send_failed"
    | "skipped_dispatcher_skipped";
  skipReason?: string;
}

/**
 * The three freshness verdicts the watcher can reach once alerting is
 * enabled. Shared by the alert path and the Task #2172 auto-recovery
 * prod-action so both judge "frozen vs fresh vs quiet" identically.
 */
export type FrontMirrorFreshnessState =
  | "no_webhook_traffic"
  | "mirror_fresh"
  | "frozen";

export interface FrontMirrorFreshnessEvaluation {
  evaluatedAt: string;
  state: FrontMirrorFreshnessState;
  lagMinutes: number;
  mirrorLatest: string | null;
  webhookLatest: string | null;
  mirrorAgeMinutes: number | null;
  webhookAgeMinutes: number | null;
  mirrorBehindWebhookMinutes: number | null;
  mirrorSwitchEnabled: boolean;
  reason: string;
}

/**
 * Pure freshness evaluation (Task #2172).
 *
 * Computes the mirror-vs-webhook freshness state WITHOUT any alert side
 * effects (no cooldown bookkeeping, no dispatch). This is the detection
 * core shared by the alert path (`checkFrontMirrorFreshness`) and the
 * auto-recovery prod-action (`recover_frozen_front_mirror` in
 * `prodActionsRegistry.ts`), so both judge "mirror frozen while live
 * webhooks arrive" with identical thresholds.
 *
 * It deliberately does NOT consult the alert kill switch
 * (`front_mirror_freshness_alert_enabled`); callers decide whether to
 * act on the result. The three states mirror the alert path's skip
 * branches:
 *   - "no_webhook_traffic" — no fresh Front intake (quiet period or an
 *     upstream delivery stall) → never a mirror-writer problem.
 *   - "mirror_fresh" — the mirror is keeping up with live intake.
 *   - "frozen" — webhooks are fresh but the mirror's newest row trails
 *     them past the lag threshold (or the mirror is empty): the writer
 *     is disabled or broken.
 */
export async function evaluateFrontMirrorFreshness(
  now: number = Date.now(),
  configArg?: FrontMirrorFreshnessConfig,
): Promise<FrontMirrorFreshnessEvaluation> {
  const config = configArg ?? (await getFrontMirrorFreshnessConfig());
  const mirrorSwitchEnabled = isPoolEpicSwitchEnabled(
    "front_sync_emails_mirror_enabled",
  );
  const { mirrorLatest, webhookLatest } = await queryFreshness();
  const mirrorAgeMinutes = mirrorLatest
    ? Math.max(0, Math.round((now - mirrorLatest.getTime()) / 60_000))
    : null;
  const webhookAgeMinutes = webhookLatest
    ? Math.max(0, Math.round((now - webhookLatest.getTime()) / 60_000))
    : null;
  // How far the mirror's newest row trails the latest Front webhook —
  // computed as the delta between the two maxima, NOT each against `now`.
  // This isolates "the mirror is behind live intake" from "everything is
  // simply old". `null` means the mirror has no rows at all (treated as
  // frozen below when webhooks are fresh). A mirror newer than the
  // webhook clamps to 0.
  const mirrorBehindWebhookMinutes =
    mirrorLatest && webhookLatest
      ? Math.max(
          0,
          Math.round(
            (webhookLatest.getTime() - mirrorLatest.getTime()) / 60_000,
          ),
        )
      : null;
  const common = {
    evaluatedAt: new Date(now).toISOString(),
    lagMinutes: config.lagMinutes,
    mirrorLatest: mirrorLatest ? mirrorLatest.toISOString() : null,
    webhookLatest: webhookLatest ? webhookLatest.toISOString() : null,
    mirrorAgeMinutes,
    webhookAgeMinutes,
    mirrorBehindWebhookMinutes,
    mirrorSwitchEnabled,
  };

  // "No Front traffic" — evaluated FIRST so the mirror-behind-webhook
  // threshold is only considered once we know live intake is happening.
  if (webhookAgeMinutes == null || webhookAgeMinutes >= config.lagMinutes) {
    return {
      ...common,
      state: "no_webhook_traffic",
      reason:
        webhookAgeMinutes == null
          ? "no source_event_log rows for source_system='front'"
          : `latest front webhook ${webhookAgeMinutes}m old >= lag ${config.lagMinutes}m (no fresh traffic)`,
    };
  }

  // Webhooks are arriving recently. If the mirror's newest row trails
  // the latest webhook by no more than the lag threshold, the writer is
  // keeping up. A NULL delta (mirror empty) falls through to frozen.
  if (
    mirrorBehindWebhookMinutes != null &&
    mirrorBehindWebhookMinutes <= config.lagMinutes
  ) {
    return {
      ...common,
      state: "mirror_fresh",
      reason: `mirror trails webhook by ${mirrorBehindWebhookMinutes}m <= lag ${config.lagMinutes}m`,
    };
  }

  return {
    ...common,
    state: "frozen",
    reason:
      mirrorBehindWebhookMinutes == null
        ? "mirror has no rows at all while Front webhooks are fresh"
        : `mirror trails webhook by ${mirrorBehindWebhookMinutes}m > lag ${config.lagMinutes}m`,
  };
}

export async function checkFrontMirrorFreshness(
  now: number = Date.now(),
): Promise<FrontMirrorFreshnessCheckResult> {
  const config = await getFrontMirrorFreshnessConfig();

  if (!config.enabled) {
    return {
      evaluatedAt: new Date(now).toISOString(),
      enabled: config.enabled,
      lagMinutes: config.lagMinutes,
      cooldownMinutes: config.cooldownMinutes,
      mirrorSwitchEnabled: isPoolEpicSwitchEnabled(
        "front_sync_emails_mirror_enabled",
      ),
      mirrorLatest: null,
      webhookLatest: null,
      mirrorAgeMinutes: null,
      webhookAgeMinutes: null,
      mirrorBehindWebhookMinutes: null,
      alertsSent: 0,
      decision: "skipped_disabled",
      skipReason: "alert disabled in system_settings",
    };
  }

  const ev = await evaluateFrontMirrorFreshness(now, config);
  const withFreshness = {
    evaluatedAt: ev.evaluatedAt,
    enabled: config.enabled,
    lagMinutes: config.lagMinutes,
    cooldownMinutes: config.cooldownMinutes,
    mirrorSwitchEnabled: ev.mirrorSwitchEnabled,
    mirrorLatest: ev.mirrorLatest,
    webhookLatest: ev.webhookLatest,
    mirrorAgeMinutes: ev.mirrorAgeMinutes,
    webhookAgeMinutes: ev.webhookAgeMinutes,
    mirrorBehindWebhookMinutes: ev.mirrorBehindWebhookMinutes,
  };

  if (ev.state === "no_webhook_traffic") {
    return {
      ...withFreshness,
      alertsSent: 0,
      decision: "skipped_no_webhook_traffic",
      skipReason: ev.reason,
    };
  }

  if (ev.state === "mirror_fresh") {
    return {
      ...withFreshness,
      alertsSent: 0,
      decision: "skipped_mirror_fresh",
      skipReason: ev.reason,
    };
  }

  // state === "frozen" — webhooks are fresh by construction, so
  // webhookAgeMinutes is non-null. Re-derive the Date objects and locals
  // the dispatch tail below expects.
  const mirrorLatest = ev.mirrorLatest ? new Date(ev.mirrorLatest) : null;
  const webhookLatest = ev.webhookLatest ? new Date(ev.webhookLatest) : null;
  const mirrorAgeMinutes = ev.mirrorAgeMinutes;
  const webhookAgeMinutes = ev.webhookAgeMinutes as number;
  const mirrorBehindWebhookMinutes = ev.mirrorBehindWebhookMinutes;
  const mirrorSwitchEnabled = ev.mirrorSwitchEnabled;

  // Webhooks fresh, mirror frozen / behind → the writer is disabled or
  // broken. Alert (subject to cooldown).
  const cooldownMs = config.cooldownMinutes * 60_000;
  if (lastAlert && now - lastAlert.at < cooldownMs) {
    const elapsedMin = Math.round((now - lastAlert.at) / 60_000);
    return {
      ...withFreshness,
      alertsSent: 0,
      decision: "skipped_cooldown",
      skipReason: `cooldown ${elapsedMin}m < ${config.cooldownMinutes}m`,
    };
  }

  const text = buildAlertText({
    mirrorAgeMinutes,
    webhookAgeMinutes,
    mirrorBehindWebhookMinutes,
    mirrorLatest,
    webhookLatest,
    mirrorSwitchEnabled,
    config,
  });

  let delivered = false;
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
          mirrorAgeMinutes,
          webhookAgeMinutes,
          lagMinutes: config.lagMinutes,
          mirrorSwitchEnabled,
          mirrorLatest: withFreshness.mirrorLatest,
          webhookLatest: withFreshness.webhookLatest,
        },
      },
    );
    delivered = r.delivered;
    if (!r.delivered) skipReason = r.skipReason ?? r.status;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[FrontMirrorFreshnessAlerts] dispatch failed: ${msg}`);
    skipReason = `dispatch_error:${msg || "unknown"}`;
  }

  if (delivered) {
    lastAlert = { at: now, mirrorAgeMinutes };
    return {
      ...withFreshness,
      alertsSent: 1,
      decision: "alerted",
    };
  }
  return {
    ...withFreshness,
    alertsSent: 0,
    decision: skipReason?.startsWith("dispatch_error")
      ? "skipped_send_failed"
      : "skipped_dispatcher_skipped",
    skipReason,
  };
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = (async () => {
    try {
      const r = await checkFrontMirrorFreshness();
      if (r.alertsSent > 0) {
        console.log(
          `[FrontMirrorFreshnessAlerts] sent=1 mirrorAgeMinutes=${r.mirrorAgeMinutes} webhookAgeMinutes=${r.webhookAgeMinutes}`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[FrontMirrorFreshnessAlerts] tick failed: ${msg}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startFrontMirrorFreshnessAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution(
      "scheduler:front-mirror-freshness-alerts",
      () => tick(),
    );
  }, CHECK_INTERVAL_MS);
  interval.unref?.();
  console.log(
    `[FrontMirrorFreshnessAlerts] scheduler started (check every ${CHECK_INTERVAL_MS / 60_000}min)`,
  );
}

export function stopFrontMirrorFreshnessAlertsScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __testHelpers = {
  NOTIFICATION_ID,
  DEFAULTS,
  resetLastAlertCache(): void {
    lastAlert = null;
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
};
