/**
 * Task #1602 — Alert when no Front webhook event has landed in
 * `source_event_log` for longer than the configured threshold.
 *
 * Background
 * ----------
 * On May 15 2026 at 01:58 UTC Front silently stopped delivering
 * webhook events to our `/api/integrations/front/webhook` receiver.
 * Our pipeline kept happily draining the existing backlog (274 jobs
 * over 24h with zero new enqueues) and nobody noticed for three days
 * — until a manual SQL inspection on May 18. The chain itself is
 * healthy; the stall is upstream (provider webhook config drifted,
 * receiver URL not reachable, signing-secret rotated without
 * re-registration, etc.).
 *
 * This watcher mirrors the `callArchiveStuckProcessingAlerts` shape
 * and pages someone via the existing `notifyByType` dispatcher once
 * the gap between *now* and the latest WEBHOOK-ORIGIN
 * `source_event_log.received_at` row (`source_system='front'` AND
 * `dedupe_key LIKE 'front:webhook:%'`) exceeds an operator-tunable
 * threshold (default 60 min). When new events resume arriving the
 * staleness gap drops below the threshold and the watcher stops
 * firing on its own — no manual all-clear required.
 *
 * Webhook grain (Task #3993)
 * --------------------------
 * The original Task #1602 watcher computed MAX(received_at) over ALL
 * `source_system='front'` rows. Reconcile sweeps write ~575 rows/day
 * into the same table, keeping that timestamp perpetually fresh — so
 * a webhook receiver that had NEVER worked (0 deliveries ever,
 * verified 2026-08-07) never fired a single alert. Staleness now keys
 * on webhook-origin rows only; polling rows are reported alongside as
 * evidence that polling is carrying sync, never as freshness.
 *
 * Never-validated era: when Front polling activity exists but NOT ONE
 * webhook row has ever landed, the watcher emits a distinct
 * "webhook never validated — polling carrying sync" alert on its own
 * (longer) cooldown instead of staying silent. Only a table with no
 * Front rows at all (fresh deploy, integration unused) is treated as
 * "nothing to say yet".
 *
 * Slack-auth-aware
 * ----------------
 * The Slack auth circuit breaker added in the same task means that
 * if our Slack token is revoked, dispatch returns `not_configured`
 * instead of hammering Slack with failures. The watcher logs the
 * skip reason and moves on; once the operator re-authorizes Slack
 * the next tick fires normally.
 */
import { sql } from "drizzle-orm";
import { workerDb as db, withDbAttribution } from "../db";
import { getSystemSetting } from "../storage/settingsStorage";

const NOTIFICATION_ID = "pipeline.front_webhook.receiver_stale";

export const SETTING_ENABLED = "front_webhook_receiver_staleness_alert_enabled";
export const SETTING_THRESHOLD_MINUTES =
  "front_webhook_receiver_staleness_alert_threshold_minutes";
export const SETTING_COOLDOWN_MINUTES =
  "front_webhook_receiver_staleness_alert_cooldown_minutes";
export const SETTING_NEVER_VALIDATED_COOLDOWN_MINUTES =
  "front_webhook_receiver_staleness_alert_never_validated_cooldown_minutes";

const DEFAULTS = {
  enabled: true,
  thresholdMinutes: 60,
  cooldownMinutes: 6 * 60,
  // The never-validated state is chronic (it stays true until the
  // receiver fix ships and the first delivery lands), so it repeats on
  // a daily cadence rather than every staleness cooldown.
  neverValidatedCooldownMinutes: 24 * 60,
};

const CHECK_INTERVAL_MS = 5 * 60_000;

export interface FrontReceiverStalenessConfig {
  enabled: boolean;
  thresholdMinutes: number;
  cooldownMinutes: number;
  neverValidatedCooldownMinutes: number;
}

interface LastAlertRecord {
  at: number;
  ageMinutes: number;
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

function parsePositiveInt(raw: string | undefined | null, fallback: number): number {
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

export async function getFrontReceiverStalenessConfig(): Promise<FrontReceiverStalenessConfig> {
  const [enabledRow, thresholdRow, cooldownRow, nvCooldownRow] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_THRESHOLD_MINUTES).catch(() => null),
    getSystemSetting(SETTING_COOLDOWN_MINUTES).catch(() => null),
    getSystemSetting(SETTING_NEVER_VALIDATED_COOLDOWN_MINUTES).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    thresholdMinutes: parsePositiveInt(thresholdRow?.value, DEFAULTS.thresholdMinutes),
    cooldownMinutes: parsePositiveInt(cooldownRow?.value, DEFAULTS.cooldownMinutes),
    neverValidatedCooldownMinutes: parsePositiveInt(
      nvCooldownRow?.value,
      DEFAULTS.neverValidatedCooldownMinutes,
    ),
  };
}

interface LatestRow {
  latest: Date | string | null;
}

function toDate(raw: Date | string | null | undefined): Date | null {
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Latest WEBHOOK-ORIGIN Front row. This is the staleness grain — the
 * receiver stamps every delivery with a `front:webhook:` dedupe-key
 * prefix (see frontWebhookIngestion.buildDedupeKey), while reconcile /
 * backfill sweeps use other prefixes. Backed by the partial index
 * `sel_front_webhook_received_at_idx` (Task #3993 migration).
 */
async function queryLatestWebhookReceivedAt(): Promise<Date | null> {
  const r = await db.execute(sql`
    SELECT MAX(received_at) AS latest
    FROM source_event_log
    WHERE source_system = 'front'
      AND dedupe_key LIKE 'front:webhook:%'
  `);
  return toDate(((r.rows?.[0] ?? null) as unknown as LatestRow | null)?.latest);
}

/**
 * Latest Front row of ANY origin (webhook + reconcile sweeps +
 * backfills). Used only as evidence in alert copy ("polling is
 * carrying sync") and to distinguish a never-validated webhook from a
 * table with no Front activity at all — never as freshness.
 */
async function queryLatestAnyFrontReceivedAt(): Promise<Date | null> {
  const r = await db.execute(sql`
    SELECT MAX(received_at) AS latest
    FROM source_event_log
    WHERE source_system = 'front'
  `);
  return toDate(((r.rows?.[0] ?? null) as unknown as LatestRow | null)?.latest);
}

function buildAdminLink(): string {
  const base =
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.REPLIT_DEPLOYMENT_URL ||
    "";
  const path = "/admin/integrations";
  if (!base) return path;
  return `${base.replace(/\/$/, "")}${path}`;
}

function buildStaleAlertText(args: {
  ageMinutes: number;
  latestWebhookReceivedAt: Date;
  latestAnyReceivedAt: Date | null;
  config: FrontReceiverStalenessConfig;
}): string {
  const pollingLine = args.latestAnyReceivedAt
    ? `• Polling/reconcile rows are still landing (latest Front row of any origin: *${args.latestAnyReceivedAt.toISOString()}*) — polling is carrying sync, which is exactly what hid this before.`
    : `• No other Front activity either.`;
  return [
    `:warning: *Front webhook intake appears stalled — instant sync is down*`,
    `• Latest webhook-origin \`source_event_log\` row (\`dedupe_key LIKE 'front:webhook:%'\`) is *${args.ageMinutes}m* old`,
    `• Threshold: ${args.config.thresholdMinutes}m`,
    `• Last webhook delivery received at *${args.latestWebhookReceivedAt.toISOString()}*`,
    pollingLine,
    `• The chain (normalize → apply workers) is healthy when there's data to drain — investigate the Front-side webhook registration / signing secret / receiver URL.`,
    `Drill in: ${buildAdminLink()}`,
  ].join("\n");
}

function buildNeverValidatedAlertText(args: {
  latestAnyReceivedAt: Date;
  config: FrontReceiverStalenessConfig;
}): string {
  return [
    `:warning: *Front webhook receiver has NEVER been validated — polling is carrying sync*`,
    `• Zero webhook-origin \`source_event_log\` rows (\`dedupe_key LIKE 'front:webhook:%'\`) exist — no Front webhook delivery has ever landed.`,
    `• Front polling/reconcile activity IS present (latest row: *${args.latestAnyReceivedAt.toISOString()}*), so sync looks alive while instant sync is silently down.`,
    `• Verify the Front-side webhook registration, signing secret, and receiver URL end-to-end; this alert repeats every ${args.config.neverValidatedCooldownMinutes}m until the first webhook row lands.`,
    `Drill in: ${buildAdminLink()}`,
  ].join("\n");
}

export interface FrontReceiverStalenessCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  /** Age of the latest WEBHOOK-ORIGIN row; null when none has ever landed. */
  ageMinutes: number | null;
  thresholdMinutes: number;
  cooldownMinutes: number;
  /** Latest webhook-origin row (`dedupe_key LIKE 'front:webhook:%'`). */
  latestReceivedAt: string | null;
  /** Latest Front row of any origin (webhook + reconcile/backfill sweeps). */
  latestAnyReceivedAt: string | null;
  /** Which alert grain the decision refers to. */
  mode: "stale" | "never_validated" | "none";
  alertsSent: number;
  decision:
    | "alerted"
    | "alerted_never_validated"
    | "skipped_disabled"
    | "skipped_below_threshold"
    | "skipped_no_front_activity"
    | "skipped_cooldown"
    | "skipped_send_failed"
    | "skipped_dispatcher_skipped";
  skipReason?: string;
}

async function dispatchAlert(args: {
  text: string;
  metadata: Record<string, unknown>;
}): Promise<{ delivered: boolean; skipReason?: string }> {
  try {
    const notifyByType =
      dispatcherOverride ?? (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      NOTIFICATION_ID,
      { text: args.text, preview: args.text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        bypassDedupe: true,
        metadata: args.metadata,
      },
    );
    if (r.delivered) return { delivered: true };
    return { delivered: false, skipReason: r.skipReason ?? r.status };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[FrontWebhookReceiverStalenessAlerts] dispatch failed: ${msg}`,
    );
    return { delivered: false, skipReason: `dispatch_error:${msg || "unknown"}` };
  }
}

export async function checkFrontWebhookReceiverStaleness(
  now: number = Date.now(),
): Promise<FrontReceiverStalenessCheckResult> {
  const config = await getFrontReceiverStalenessConfig();
  const base = {
    evaluatedAt: new Date(now).toISOString(),
    enabled: config.enabled,
    thresholdMinutes: config.thresholdMinutes,
    cooldownMinutes: config.cooldownMinutes,
  };

  const [latestWebhook, latestAny] = await Promise.all([
    queryLatestWebhookReceivedAt(),
    queryLatestAnyFrontReceivedAt(),
  ]);
  const ageMinutes = latestWebhook
    ? Math.max(0, Math.round((now - latestWebhook.getTime()) / 60_000))
    : null;
  const latestReceivedAt = latestWebhook ? latestWebhook.toISOString() : null;
  const latestAnyReceivedAt = latestAny ? latestAny.toISOString() : null;
  const facts = { ageMinutes, latestReceivedAt, latestAnyReceivedAt };

  if (!config.enabled) {
    return {
      ...base,
      ...facts,
      mode: "none",
      alertsSent: 0,
      decision: "skipped_disabled",
      skipReason: "alert disabled in system_settings",
    };
  }

  // ── Never-validated era ──────────────────────────────────────────────
  // Zero webhook rows have EVER landed. If there is no Front activity of
  // any kind either, the integration is simply unused / freshly deployed
  // — stay quiet. But when polling/reconcile rows ARE flowing, instant
  // sync is silently down while everything looks alive: surface it
  // explicitly on its own (longer) cooldown.
  if (latestWebhook == null) {
    if (latestAny == null) {
      return {
        ...base,
        ...facts,
        mode: "none",
        alertsSent: 0,
        decision: "skipped_no_front_activity",
        skipReason: "no source_event_log rows for source_system='front' at all",
      };
    }
    const nvCooldownMs = config.neverValidatedCooldownMinutes * 60_000;
    if (lastAlert && now - lastAlert.at < nvCooldownMs) {
      const elapsedMin = Math.round((now - lastAlert.at) / 60_000);
      return {
        ...base,
        ...facts,
        mode: "never_validated",
        alertsSent: 0,
        decision: "skipped_cooldown",
        skipReason: `never-validated cooldown ${elapsedMin}m < ${config.neverValidatedCooldownMinutes}m`,
      };
    }
    const text = buildNeverValidatedAlertText({ latestAnyReceivedAt: latestAny, config });
    const r = await dispatchAlert({
      text,
      metadata: {
        mode: "never_validated",
        latestAnyReceivedAt,
        neverValidatedCooldownMinutes: config.neverValidatedCooldownMinutes,
      },
    });
    if (r.delivered) {
      lastAlert = { at: now, ageMinutes: -1 };
      return {
        ...base,
        ...facts,
        mode: "never_validated",
        alertsSent: 1,
        decision: "alerted_never_validated",
      };
    }
    return {
      ...base,
      ...facts,
      mode: "never_validated",
      alertsSent: 0,
      decision: r.skipReason?.startsWith("dispatch_error")
        ? "skipped_send_failed"
        : "skipped_dispatcher_skipped",
      skipReason: r.skipReason,
    };
  }

  // ── Normal staleness path (webhook has worked before) ────────────────
  if (ageMinutes! < config.thresholdMinutes) {
    return {
      ...base,
      ...facts,
      mode: "stale",
      alertsSent: 0,
      decision: "skipped_below_threshold",
      skipReason: `webhook age ${ageMinutes}m < threshold ${config.thresholdMinutes}m`,
    };
  }

  const cooldownMs = config.cooldownMinutes * 60_000;
  if (lastAlert && now - lastAlert.at < cooldownMs) {
    const elapsedMin = Math.round((now - lastAlert.at) / 60_000);
    return {
      ...base,
      ...facts,
      mode: "stale",
      alertsSent: 0,
      decision: "skipped_cooldown",
      skipReason: `cooldown ${elapsedMin}m < ${config.cooldownMinutes}m`,
    };
  }

  const text = buildStaleAlertText({
    ageMinutes: ageMinutes!,
    latestWebhookReceivedAt: latestWebhook,
    latestAnyReceivedAt: latestAny,
    config,
  });
  const r = await dispatchAlert({
    text,
    metadata: {
      mode: "stale",
      ageMinutes,
      thresholdMinutes: config.thresholdMinutes,
      latestReceivedAt,
      latestAnyReceivedAt,
    },
  });
  if (r.delivered) {
    lastAlert = { at: now, ageMinutes: ageMinutes! };
    return {
      ...base,
      ...facts,
      mode: "stale",
      alertsSent: 1,
      decision: "alerted",
    };
  }
  return {
    ...base,
    ...facts,
    mode: "stale",
    alertsSent: 0,
    decision: r.skipReason?.startsWith("dispatch_error")
      ? "skipped_send_failed"
      : "skipped_dispatcher_skipped",
    skipReason: r.skipReason,
  };
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = (async () => {
    try {
      const r = await checkFrontWebhookReceiverStaleness();
      if (r.alertsSent > 0) {
        console.log(
          `[FrontWebhookReceiverStalenessAlerts] sent=1 ageMinutes=${r.ageMinutes} thresholdMinutes=${r.thresholdMinutes}`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[FrontWebhookReceiverStalenessAlerts] tick failed: ${msg}`,
      );
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startFrontWebhookReceiverStalenessAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution(
      "scheduler:front-webhook-receiver-staleness-alerts",
      () => tick(),
    );
  }, CHECK_INTERVAL_MS);
  interval.unref?.();
  console.log(
    `[FrontWebhookReceiverStalenessAlerts] scheduler started (check every ${CHECK_INTERVAL_MS / 60_000}min)`,
  );
}

export function stopFrontWebhookReceiverStalenessAlertsScheduler(): void {
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
