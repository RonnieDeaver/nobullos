/**
 * Task #1284 — alert when Twilio inbound-webhook retries cause DB unique-index
 * collisions on `twilio_messages.twilio_sid`.
 *
 * Task #849 added the partial unique index `twilio_msg_twilio_sid_uniq` so
 * Twilio's at-least-once delivery becomes a no-op at the database level: the
 * losing insert raises Postgres 23505 and `server/services/twilioService.ts`
 * catches it, logs, and returns without side effects. That's the desired
 * behaviour for normal retry storms (Twilio retries every webhook that
 * doesn't 200 within ~15s), but it also masks pathological cases:
 *   - signature-verification regressed and we're now accepting the same SID
 *     dozens of times because some downstream handler keeps failing,
 *   - an upstream caller is hammering the webhook,
 *   - Twilio is hammering us because our handler is slow.
 *
 * This watcher keeps an in-memory ring buffer of recent collisions (sid +
 * timestamp). On every tick (and on every recorded collision, lazily) it
 * prunes entries older than the rolling window. When the per-window count
 * crosses the threshold it fires a single Slack alert via `notifyByType`,
 * listing the offending SIDs for triage. A per-watcher cooldown prevents
 * spam — once an alert fires, the same alert is silent for
 * `cooldown_minutes` minutes unless the windowed count grows by another
 * full `threshold` collisions above the previously-alerted count.
 *
 * Channel/enabled state lives in `notification_settings` for
 * `infra.twilio_webhook.sid_collision_spike`; threshold knobs live in
 * `system_settings` so an admin can tune them without a deploy.
 */
import { withDbAttribution } from "../db";
import { getSystemSetting } from "../storage/settingsStorage";

const NOTIFICATION_ID = "infra.twilio_webhook.sid_collision_spike";

/**
 * The partial unique index name on `twilio_messages.twilio_sid` added by
 * Task #849. We key collision-recording on the constraint name (when the
 * Postgres driver populates it) so other 23505 violations from the same
 * insert path don't inflate the count if the schema evolves.
 */
export const TWILIO_SID_UNIQUE_CONSTRAINT = "twilio_msg_twilio_sid_uniq";

export const SETTING_ENABLED = "twilio_webhook_collision_alert_enabled";
export const SETTING_WINDOW = "twilio_webhook_collision_alert_window_minutes";
export const SETTING_THRESHOLD = "twilio_webhook_collision_alert_threshold";
export const SETTING_COOLDOWN = "twilio_webhook_collision_alert_cooldown_minutes";

const DEFAULTS = {
  enabled: true,
  windowMinutes: 10,
  threshold: 20,
  cooldownMinutes: 60,
};

const CHECK_INTERVAL_MS = 60_000;

/**
 * Hard cap on retained collision events. A misbehaving caller could spray
 * millions of webhook retries per minute; we don't want the ring buffer to
 * grow unbounded. Once we're past `threshold` we already have what we need
 * to fire — the cap is just defensive memory bookkeeping.
 */
const MAX_RETAINED_EVENTS = 1000;

/** How many SIDs to surface in the alert body for operator triage. */
const MAX_SIDS_IN_ALERT = 10;

export interface TwilioWebhookCollisionAlertConfig {
  enabled: boolean;
  windowMinutes: number;
  threshold: number;
  cooldownMinutes: number;
}

interface CollisionEvent {
  sid: string;
  at: number;
}

interface LastAlertRecord {
  at: number;
  windowedCount: number;
}

const ringBuffer: CollisionEvent[] = [];
let lastAlert: LastAlertRecord | null = null;

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

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

export async function getTwilioWebhookCollisionAlertConfig(): Promise<TwilioWebhookCollisionAlertConfig> {
  const [enabledRow, windowRow, thresholdRow, cooldownRow] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_WINDOW).catch(() => null),
    getSystemSetting(SETTING_THRESHOLD).catch(() => null),
    getSystemSetting(SETTING_COOLDOWN).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    windowMinutes: parsePositiveInt(windowRow?.value, DEFAULTS.windowMinutes),
    threshold: parsePositiveInt(thresholdRow?.value, DEFAULTS.threshold),
    cooldownMinutes: parsePositiveInt(cooldownRow?.value, DEFAULTS.cooldownMinutes),
  };
}

/**
 * Called from the 23505 catch in `server/services/twilioService.ts` on the
 * inbound-webhook insert path. Best-effort and synchronous from the
 * caller's perspective — must never throw.
 *
 * Only records when the error is a unique violation on the
 * `twilio_msg_twilio_sid_uniq` partial index. Other 23505 violations from
 * the same insert path (PK collisions, future indexes) are ignored so
 * they don't inflate the spike count. When the driver doesn't populate
 * `err.constraint` we fall back to a substring check on the error
 * message/detail (node-postgres exposes the constraint name in those
 * fields when `constraint` itself is missing).
 */
export function recordTwilioSidCollision(
  sid: string,
  err?: { code?: string; constraint?: string; message?: string; detail?: string } | null,
): boolean {
  try {
    if (err) {
      if (err.code !== "23505") return false;
      const constraintMatches =
        err.constraint === TWILIO_SID_UNIQUE_CONSTRAINT ||
        (err.constraint == null &&
          ((err.message ?? "").includes(TWILIO_SID_UNIQUE_CONSTRAINT) ||
            (err.detail ?? "").includes(TWILIO_SID_UNIQUE_CONSTRAINT)));
      if (!constraintMatches) return false;
    }
    ringBuffer.push({ sid, at: Date.now() });
    if (ringBuffer.length > MAX_RETAINED_EVENTS) {
      ringBuffer.splice(0, ringBuffer.length - MAX_RETAINED_EVENTS);
    }
    return true;
  } catch (err2: any) {
    console.warn(`[TwilioWebhookCollisionAlerts] recordTwilioSidCollision failed: ${err2?.message}`);
    return false;
  }
}

/**
 * Build a Twilio Console deep-link for a given inbound MessageSid so
 * operators can jump straight from the alert to the upstream record.
 * The console URL pattern is stable; SID format (`SMxxxx`) is opaque
 * but already a Twilio identifier so leaking it in the link is fine.
 */
function twilioConsoleLink(sid: string): string {
  return `https://console.twilio.com/us1/monitor/logs/sms?frPN=&filter-sid=${encodeURIComponent(sid)}`;
}

/**
 * Build an internal admin deep-link for a SID. The Conversation Hub
 * resolves messages by `twilioSid` so operators can land on the row
 * even when the local record is the losing-no-op insert (the canonical
 * row was created by the winning attempt and carries the same SID).
 */
function internalAdminLink(sid: string): string {
  const base =
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.REPLIT_DEPLOYMENT_URL ||
    "";
  const path = `/admin/twilio?messageSid=${encodeURIComponent(sid)}`;
  if (!base) return path;
  return `${base.replace(/\/$/, "")}${path}`;
}

function pruneOlderThan(cutoff: number): void {
  // Events are pushed in arrival order so the first kept index is the
  // first event with at >= cutoff. Linear-scan is fine at the bounded
  // MAX_RETAINED_EVENTS size.
  let drop = 0;
  while (drop < ringBuffer.length && ringBuffer[drop]!.at < cutoff) drop += 1;
  if (drop > 0) ringBuffer.splice(0, drop);
}

export interface CollisionCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  windowMinutes: number;
  threshold: number;
  windowedCount: number;
  alertsSent: number;
  decision:
    | "alerted"
    | "skipped_disabled"
    | "skipped_below_threshold"
    | "skipped_cooldown"
    | "skipped_no_growth_since_last_alert"
    | "skipped_send_failed"
    | "skipped_dispatcher_skipped";
  skipReason?: string;
  /** SIDs surfaced in the alert body (capped). Mirrors what operators see. */
  sampleSids: string[];
}

function buildAlertText(args: {
  windowedCount: number;
  config: TwilioWebhookCollisionAlertConfig;
  sids: string[];
}): string {
  const lines = [
    `:warning: *Twilio inbound webhook — unique-SID collision spike*`,
    `• *${args.windowedCount}* collisions on \`twilio_messages.twilio_sid\` (index \`twilio_msg_twilio_sid_uniq\`) in the last *${args.config.windowMinutes}m*`,
    `• Threshold: *${args.config.threshold}* per *${args.config.windowMinutes}m* window`,
    `• Each collision means Twilio (or an upstream caller) re-delivered the same MessageSid; the losing insert raised Postgres 23505 and we dropped it as a no-op.`,
    `• A spike usually means the webhook handler is too slow (Twilio is retrying), signature verification regressed, or someone is replaying inbound webhooks.`,
  ];
  if (args.sids.length > 0) {
    const sample = args.sids.slice(0, MAX_SIDS_IN_ALERT);
    lines.push(`• Sample SIDs (${sample.length}/${args.sids.length}) — click to triage:`);
    for (const s of sample) {
      lines.push(
        `   • \`${s}\` — <${internalAdminLink(s)}|admin> · <${twilioConsoleLink(s)}|Twilio Console>`,
      );
    }
  }
  return lines.join("\n");
}

export async function checkTwilioWebhookCollisions(
  now: number = Date.now(),
): Promise<CollisionCheckResult> {
  const config = await getTwilioWebhookCollisionAlertConfig();
  const cutoff = now - config.windowMinutes * 60_000;
  pruneOlderThan(cutoff);
  const windowed = ringBuffer.filter((e) => e.at >= cutoff);
  const sampleSids = windowed.map((e) => e.sid);

  const base: Omit<CollisionCheckResult, "decision" | "skipReason"> = {
    evaluatedAt: new Date(now).toISOString(),
    enabled: config.enabled,
    windowMinutes: config.windowMinutes,
    threshold: config.threshold,
    windowedCount: windowed.length,
    alertsSent: 0,
    sampleSids,
  };

  if (!config.enabled) {
    return { ...base, decision: "skipped_disabled", skipReason: "alert disabled in system_settings" };
  }
  if (windowed.length < config.threshold) {
    return {
      ...base,
      decision: "skipped_below_threshold",
      skipReason: `${windowed.length} < ${config.threshold}`,
    };
  }

  if (lastAlert) {
    const elapsedMs = now - lastAlert.at;
    const cooldownMs = config.cooldownMinutes * 60_000;
    const growthSinceLast = windowed.length - lastAlert.windowedCount;
    if (elapsedMs < cooldownMs && growthSinceLast < config.threshold) {
      if (growthSinceLast <= 0) {
        return {
          ...base,
          decision: "skipped_no_growth_since_last_alert",
          skipReason: `no growth since last alert (${windowed.length} ≤ ${lastAlert.windowedCount})`,
        };
      }
      return {
        ...base,
        decision: "skipped_cooldown",
        skipReason: `cooldown ${Math.round(elapsedMs / 60_000)}m < ${config.cooldownMinutes}m and growth-since-last ${growthSinceLast} < ${config.threshold}`,
      };
    }
  }

  const text = buildAlertText({ windowedCount: windowed.length, config, sids: sampleSids });

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
        // We manage our own per-watcher cooldown above; let the dispatcher
        // fire whenever we get here.
        bypassDedupe: true,
        metadata: {
          windowedCount: windowed.length,
          windowMinutes: config.windowMinutes,
          threshold: config.threshold,
          cooldownMinutes: config.cooldownMinutes,
          sampleSids: sampleSids.slice(0, MAX_SIDS_IN_ALERT),
          sampleSidLinks: sampleSids.slice(0, MAX_SIDS_IN_ALERT).map((sid) => ({
            sid,
            adminUrl: internalAdminLink(sid),
            twilioConsoleUrl: twilioConsoleLink(sid),
          })),
        },
      },
    );
    delivered = r.delivered;
    if (!r.delivered) skipReason = r.skipReason ?? r.status;
  } catch (err: any) {
    console.error(`[TwilioWebhookCollisionAlerts] dispatch failed: ${err?.message}`);
    skipReason = `dispatch_error:${err?.message ?? "unknown"}`;
  }

  if (delivered) {
    lastAlert = { at: now, windowedCount: windowed.length };
    return { ...base, alertsSent: 1, decision: "alerted" };
  }
  return {
    ...base,
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
      const r = await checkTwilioWebhookCollisions();
      if (r.alertsSent > 0) {
        console.log(
          `[TwilioWebhookCollisionAlerts] alerted windowedCount=${r.windowedCount} window=${r.windowMinutes}m threshold=${r.threshold}`,
        );
      }
    } catch (err: any) {
      console.warn(`[TwilioWebhookCollisionAlerts] tick failed: ${err?.message}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startTwilioWebhookCollisionAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution("scheduler:twilio-webhook-collision-alerts", () => tick());
  }, CHECK_INTERVAL_MS);
  console.log(
    `[TwilioWebhookCollisionAlerts] scheduler started (check every ${CHECK_INTERVAL_MS / 1000}s)`,
  );
}

export function stopTwilioWebhookCollisionAlertsScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __testHelpers = {
  NOTIFICATION_ID,
  DEFAULTS,
  MAX_RETAINED_EVENTS,
  MAX_SIDS_IN_ALERT,
  resetForTests(): void {
    ringBuffer.length = 0;
    lastAlert = null;
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  ringBufferSize(): number {
    return ringBuffer.length;
  },
};
