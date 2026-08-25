// @cross-instance-safe: cooldown-guarded emit — DB zoom_review_alert_last_sent_at cooldown in system_settings gates the alert; duplicate emit is low-harm.
import { storage } from "../storage";
// Task #1573 (Audit Track C): periodic alert poller — uses the worker pool
// so the 60s tick doesn't consume request-pool capacity. The Admin UI
// (request path) reaches this code via separate per-route storage helpers
// that keep using the api pool.
import { workerDb as db, dbRetry, withDbAttribution } from "../db";
import { agentMatchDecisions } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { sendEmail as sendMailerEmail } from "./mailer";

const SETTINGS_KEYS = {
  enabled: "zoom_review_alert_enabled",
  countThreshold: "zoom_review_alert_count_threshold",
  ageHoursThreshold: "zoom_review_alert_age_hours_threshold",
  slackChannel: "zoom_review_alert_slack_channel",
  recipientEmails: "zoom_review_alert_recipient_emails",
  cooldownMinutes: "zoom_review_alert_cooldown_minutes",
  lastSentAt: "zoom_review_alert_last_sent_at",
  lastStatus: "zoom_review_alert_last_status",
  cycleState: "zoom_review_alert_cycle_state",
  lastClearedAt: "zoom_review_alert_last_cleared_at",
  eventHistory: "zoom_review_alert_event_history",
} as const;

type CycleState = "alerted" | "cleared";

const EVENT_HISTORY_LIMIT = 10;

export type ZoomReviewAlertEventType = "backed-up" | "cleared";

export interface ZoomReviewAlertEventChannel {
  attempted: boolean;
  sent: boolean;
  recipients?: number;
  skipReason?: string;
}

export interface ZoomReviewAlertEvent {
  type: ZoomReviewAlertEventType;
  at: string;
  pendingCount: number;
  oldestAgeHours: number | null;
  // Task #653: per-channel delivery outcome, persisted alongside the event
  // so admins can audit historical alerts without reproducing them. Optional
  // so events written before #653 still parse cleanly.
  slack?: ZoomReviewAlertEventChannel;
  email?: ZoomReviewAlertEventChannel;
  inApp?: ZoomReviewAlertEventChannel;
  // Task #1111: explicit marker for events written before Task #653 added
  // per-channel delivery blocks. Backfilled by
  // `scripts/backfill-zoom-alert-event-legacy-marker.ts`. Lets the admin
  // UI distinguish "we never recorded this" (legacy) from "we recorded it
  // and nothing was attempted" (post-#653, no channel data).
  legacy?: boolean;
}

const DEFAULTS = {
  enabled: false,
  countThreshold: 10,
  ageHoursThreshold: 24,
  cooldownMinutes: 60,
  slackChannel: "",
  recipientEmails: [] as string[],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseRecipientEmails(value: string | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    raw = trimmed.split(/[,\s;]+/);
  }
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const e = item.trim().toLowerCase();
    if (!e || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

function normalizeRecipientEmails(input: unknown): string[] {
  let arr: string[];
  if (Array.isArray(input)) {
    arr = input.filter((x): x is string => typeof x === "string");
  } else if (typeof input === "string") {
    arr = input.split(/[,\s;]+/);
  } else {
    throw new Error("recipientEmails must be an array or comma-separated string");
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    const e = item.trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e)) {
      throw new Error(`Invalid email address: ${item}`);
    }
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

const RECIPIENT_ROLES = new Set(["account_manager", "team_lead", "ceo"]);

const POLL_INTERVAL_MS = 5 * 60 * 1000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let inFlightCheck: Promise<ZoomReviewAlertStatus> | null = null;

export interface ZoomReviewAlertSettings {
  enabled: boolean;
  countThreshold: number;
  ageHoursThreshold: number;
  cooldownMinutes: number;
  slackChannel: string;
  recipientEmails: string[];
  lastSentAt: string | null;
  lastStatus: ZoomReviewAlertStatus | null;
  cycleState: CycleState;
  lastClearedAt: string | null;
  eventHistory: ZoomReviewAlertEvent[];
}

export interface ZoomReviewAlertStatus {
  evaluatedAt: string;
  pendingCount: number;
  oldestAgeHours: number | null;
  breached: boolean;
  breachReasons: string[];
  notificationSent: boolean;
  slackSent: boolean;
  slackAttempted?: boolean;
  slackSkipReason?: string;
  emailSent: boolean;
  emailRecipients: number;
  emailAttempted?: boolean;
  emailSkipReason?: string;
  inAppRecipients: number;
  skipReason?: string;
  cleared?: boolean;
}

async function readSetting(key: string): Promise<string | undefined> {
  // Task #813: settings reads are pure idempotent SELECTs; wrap in dbRetry
  // so a transient Neon recycle on the periodic Zoom alert tick is absorbed
  // instead of being charged to dbFailures.
  const row = await dbRetry(
    () => storage.getSystemSetting(key),
    `zoomReviewAlert.readSetting:${key}`,
  );
  return row?.value ?? undefined;
}

// Task #836 Phase 5: batched read used by `getZoomReviewAlertSettings`
// in place of 11 parallel `readSetting` calls. The previous shape
// fanned out to 11 concurrent DB checkouts every 5 minutes, which
// directly contributed to the API pool waiter spikes observed in the
// audit. One single SELECT, one DB checkout. dbRetry covers the
// transient Neon recycle case.
async function readSettingsBatch(keys: string[]): Promise<Record<string, string>> {
  return dbRetry(
    () => storage.getSystemSettings(keys),
    `zoomReviewAlert.readSettingsBatch:${keys.length}`,
  );
}

async function writeSetting(key: string, value: string): Promise<void> {
  // Task #813: setSystemSetting is an UPSERT keyed on `key`. Replaying the
  // same write on retry is safe (idempotent) — the row ends up with the
  // intended value either way.
  await dbRetry(
    () => storage.setSystemSetting(key, value, "system"),
    `zoomReviewAlert.writeSetting:${key}`,
  );
}

function parseInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  return value === "true" || value === "1";
}

// Task #836 Phase 5: defensive parser for `lastClearedAt`. Production
// once contained a corrupted JSON-stringified payload here instead of a
// plain ISO timestamp string. Failing soft (returning null) keeps the
// alert tick running and lets the operator overwrite the bad row at
// their convenience instead of throwing every 5 minutes.
export function parseLastClearedAt(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Detect the legacy bad shape (JSON object/array) and refuse it.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    console.warn(`[ZoomReviewAlert] Ignoring malformed lastClearedAt payload (looks like JSON, not ISO timestamp): ${trimmed.slice(0, 80)}`);
    return null;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    console.warn(`[ZoomReviewAlert] Ignoring unparseable lastClearedAt: ${trimmed.slice(0, 80)}`);
    return null;
  }
  return trimmed;
}

export async function getZoomReviewAlertSettings(): Promise<ZoomReviewAlertSettings> {
  // Task #836 Phase 5: replace 11 parallel `readSetting` calls with a
  // single batched read. Same key list, same defaulting behavior.
  const keys = [
    SETTINGS_KEYS.enabled,
    SETTINGS_KEYS.countThreshold,
    SETTINGS_KEYS.ageHoursThreshold,
    SETTINGS_KEYS.cooldownMinutes,
    SETTINGS_KEYS.slackChannel,
    SETTINGS_KEYS.recipientEmails,
    SETTINGS_KEYS.lastSentAt,
    SETTINGS_KEYS.lastStatus,
    SETTINGS_KEYS.cycleState,
    SETTINGS_KEYS.lastClearedAt,
    SETTINGS_KEYS.eventHistory,
  ];
  const map = await readSettingsBatch(keys);
  const enabled = map[SETTINGS_KEYS.enabled];
  const count = map[SETTINGS_KEYS.countThreshold];
  const age = map[SETTINGS_KEYS.ageHoursThreshold];
  const cooldown = map[SETTINGS_KEYS.cooldownMinutes];
  const channel = map[SETTINGS_KEYS.slackChannel];
  const emails = map[SETTINGS_KEYS.recipientEmails];
  const lastSentAt = map[SETTINGS_KEYS.lastSentAt];
  const lastStatusRaw = map[SETTINGS_KEYS.lastStatus];
  const cycleStateRaw = map[SETTINGS_KEYS.cycleState];
  const lastClearedAtRaw = map[SETTINGS_KEYS.lastClearedAt];
  const eventHistoryRaw = map[SETTINGS_KEYS.eventHistory];

  let lastStatus: ZoomReviewAlertStatus | null = null;
  if (lastStatusRaw) {
    try {
      lastStatus = JSON.parse(lastStatusRaw);
    } catch {
      lastStatus = null;
    }
  }

  let eventHistory: ZoomReviewAlertEvent[] = [];
  if (eventHistoryRaw) {
    try {
      const parsed = JSON.parse(eventHistoryRaw);
      if (Array.isArray(parsed)) {
        eventHistory = parsed
          .filter(
            (e): e is ZoomReviewAlertEvent =>
              e &&
              typeof e === "object" &&
              (e.type === "backed-up" || e.type === "cleared") &&
              typeof e.at === "string",
          )
          .map((e) => {
            const parseChannel = (
              raw: unknown,
            ): ZoomReviewAlertEventChannel | undefined => {
              if (!raw || typeof raw !== "object") return undefined;
              const r = raw as Record<string, unknown>;
              const ch: ZoomReviewAlertEventChannel = {
                attempted: r.attempted === true,
                sent: r.sent === true,
              };
              if (typeof r.recipients === "number") ch.recipients = r.recipients;
              if (typeof r.skipReason === "string") ch.skipReason = r.skipReason;
              return ch;
            };
            const rec = e as unknown as Record<string, unknown>;
            const out: ZoomReviewAlertEvent = {
              type: e.type,
              at: e.at,
              pendingCount: typeof e.pendingCount === "number" ? e.pendingCount : 0,
              oldestAgeHours:
                typeof e.oldestAgeHours === "number" ? e.oldestAgeHours : null,
            };
            const slack = parseChannel(rec.slack);
            const email = parseChannel(rec.email);
            const inApp = parseChannel(rec.inApp);
            if (slack) out.slack = slack;
            if (email) out.email = email;
            if (inApp) out.inApp = inApp;
            // Task #1111: preserve the legacy marker written by the
            // backfill so the admin UI can render a distinct badge.
            if (rec.legacy === true) out.legacy = true;
            return out;
          });
      }
    } catch {
      eventHistory = [];
    }
  }

  return {
    enabled: parseBool(enabled, DEFAULTS.enabled),
    countThreshold: parseInt(count, DEFAULTS.countThreshold),
    ageHoursThreshold: parseInt(age, DEFAULTS.ageHoursThreshold),
    cooldownMinutes: parseInt(cooldown, DEFAULTS.cooldownMinutes),
    slackChannel: channel || DEFAULTS.slackChannel,
    recipientEmails: parseRecipientEmails(emails),
    lastSentAt: lastSentAt || null,
    lastStatus,
    cycleState: cycleStateRaw === "alerted" ? "alerted" : "cleared",
    lastClearedAt: parseLastClearedAt(lastClearedAtRaw),
    eventHistory,
  };
}

async function appendAlertEvent(event: ZoomReviewAlertEvent): Promise<void> {
  try {
    const current = await readSetting(SETTINGS_KEYS.eventHistory);
    let arr: ZoomReviewAlertEvent[] = [];
    if (current) {
      try {
        const parsed = JSON.parse(current);
        if (Array.isArray(parsed)) arr = parsed;
      } catch {
        arr = [];
      }
    }
    arr.unshift(event);
    if (arr.length > EVENT_HISTORY_LIMIT) arr = arr.slice(0, EVENT_HISTORY_LIMIT);
    await writeSetting(SETTINGS_KEYS.eventHistory, JSON.stringify(arr));
  } catch (err) {
    console.error("[ZoomReviewAlert] Failed to append event history:", err);
  }
}

export interface UpdateZoomReviewAlertSettingsInput {
  enabled?: boolean;
  countThreshold?: number;
  ageHoursThreshold?: number;
  cooldownMinutes?: number;
  slackChannel?: string;
  recipientEmails?: string[] | string;
}

export async function updateZoomReviewAlertSettings(
  input: UpdateZoomReviewAlertSettingsInput,
): Promise<ZoomReviewAlertSettings> {
  if (input.enabled !== undefined) {
    await writeSetting(SETTINGS_KEYS.enabled, input.enabled ? "true" : "false");
  }
  if (input.countThreshold !== undefined) {
    if (!Number.isFinite(input.countThreshold) || input.countThreshold < 1) {
      throw new Error("countThreshold must be a positive integer");
    }
    await writeSetting(SETTINGS_KEYS.countThreshold, String(Math.floor(input.countThreshold)));
  }
  if (input.ageHoursThreshold !== undefined) {
    if (!Number.isFinite(input.ageHoursThreshold) || input.ageHoursThreshold < 1) {
      throw new Error("ageHoursThreshold must be a positive integer");
    }
    await writeSetting(SETTINGS_KEYS.ageHoursThreshold, String(Math.floor(input.ageHoursThreshold)));
  }
  if (input.cooldownMinutes !== undefined) {
    if (!Number.isFinite(input.cooldownMinutes) || input.cooldownMinutes < 1) {
      throw new Error("cooldownMinutes must be a positive integer");
    }
    await writeSetting(SETTINGS_KEYS.cooldownMinutes, String(Math.floor(input.cooldownMinutes)));
  }
  if (input.slackChannel !== undefined) {
    await writeSetting(SETTINGS_KEYS.slackChannel, input.slackChannel.trim());
  }
  if (input.recipientEmails !== undefined) {
    const normalized = normalizeRecipientEmails(input.recipientEmails);
    await writeSetting(SETTINGS_KEYS.recipientEmails, JSON.stringify(normalized));
  }
  return getZoomReviewAlertSettings();
}

export interface ZoomReviewQueueMetrics {
  pendingCount: number;
  oldestCreatedAt: Date | null;
  oldestAgeHours: number | null;
}

export async function getZoomReviewQueueMetrics(): Promise<ZoomReviewQueueMetrics> {
  // Task #813: pure idempotent aggregate SELECT used by every alert tick —
  // wrap in dbRetry so a transient Neon recycle isn't charged to dbFailures.
  const [row] = await dbRetry(
    () =>
      db
        .select({
          pendingCount: sql<number>`count(*)::int`,
          oldestCreatedAt: sql<Date | null>`min(${agentMatchDecisions.createdAt})`,
        })
        .from(agentMatchDecisions)
        .where(
          and(
            eq(agentMatchDecisions.sourceType, "zoom"),
            eq(agentMatchDecisions.status, "review_required"),
            sql`${agentMatchDecisions.reviewResolution} IS NULL`,
          ),
        ),
    "zoomReviewAlert.getZoomReviewQueueMetrics",
  );

  const pendingCount = row?.pendingCount ?? 0;
  const rawOldest = row?.oldestCreatedAt ?? null;
  const oldestCreatedAt =
    rawOldest instanceof Date
      ? rawOldest
      : rawOldest != null
        ? new Date(rawOldest as string | number)
        : null;
  const oldestAgeHours = oldestCreatedAt
    ? (Date.now() - oldestCreatedAt.getTime()) / (1000 * 60 * 60)
    : null;

  return { pendingCount, oldestCreatedAt, oldestAgeHours };
}

/**
 * Task #996: backlog trend snapshot for the Zoom Review Queue admin UI.
 *
 * After Task #993 disabled AI-driven dismissal, every Zoom recording without a
 * deterministic match lands in the queue, so operators need at-a-glance signal
 * for whether the backlog is growing or shrinking. We return:
 *   - pendingCount       — pending right now
 *   - pendingCount24hAgo — pending at (now - 24h), i.e. created on/before the
 *                         cutoff and either still unresolved or resolved after
 *                         the cutoff
 *   - pendingCount7dAgo  — same idea, 7 days back
 *   - createdLast24h     — newly routed-to-review rows in the last 24h
 *   - createdLast7d      — newly routed-to-review rows in the last 7d
 *   - resolvedLast24h    — rows resolved (any resolution) in the last 24h
 *   - resolvedLast7d     — same, 7d window
 *
 * The deltas (pendingNow - pendingThen) are what the UI surfaces as the trend
 * indicator; the inflow/outflow numbers help operators reason about whether
 * the backlog change came from a spike in arrivals vs. a slowdown in triage.
 */
export interface ZoomReviewQueueTrend {
  pendingCount: number;
  pendingCount24hAgo: number;
  pendingCount7dAgo: number;
  createdLast24h: number;
  createdLast7d: number;
  resolvedLast24h: number;
  resolvedLast7d: number;
}

export async function getZoomReviewQueueTrend(): Promise<ZoomReviewQueueTrend> {
  const now = new Date();
  const day = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const week = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [row] = await dbRetry(
    () =>
      db
        .select({
          pendingCount: sql<number>`count(*) FILTER (
            WHERE ${agentMatchDecisions.status} = 'review_required'
              AND ${agentMatchDecisions.reviewResolution} IS NULL
          )::int`,
          pendingCount24hAgo: sql<number>`count(*) FILTER (
            WHERE ${agentMatchDecisions.createdAt} <= ${day}
              AND (
                ${agentMatchDecisions.reviewResolution} IS NULL
                OR ${agentMatchDecisions.reviewedAt} > ${day}
              )
          )::int`,
          pendingCount7dAgo: sql<number>`count(*) FILTER (
            WHERE ${agentMatchDecisions.createdAt} <= ${week}
              AND (
                ${agentMatchDecisions.reviewResolution} IS NULL
                OR ${agentMatchDecisions.reviewedAt} > ${week}
              )
          )::int`,
          createdLast24h: sql<number>`count(*) FILTER (
            WHERE ${agentMatchDecisions.createdAt} > ${day}
          )::int`,
          createdLast7d: sql<number>`count(*) FILTER (
            WHERE ${agentMatchDecisions.createdAt} > ${week}
          )::int`,
          resolvedLast24h: sql<number>`count(*) FILTER (
            WHERE ${agentMatchDecisions.reviewedAt} > ${day}
              AND ${agentMatchDecisions.reviewResolution} IS NOT NULL
          )::int`,
          resolvedLast7d: sql<number>`count(*) FILTER (
            WHERE ${agentMatchDecisions.reviewedAt} > ${week}
              AND ${agentMatchDecisions.reviewResolution} IS NOT NULL
          )::int`,
        })
        .from(agentMatchDecisions)
        .where(
          and(
            eq(agentMatchDecisions.sourceType, "zoom"),
            // Restrict the historical universe to rows that ever entered review,
            // so non-review decisions don't inflate the snapshots.
            sql`(${agentMatchDecisions.status} = 'review_required'
                 OR ${agentMatchDecisions.reviewResolution} IS NOT NULL)`,
          ),
        ),
    "zoomReviewAlert.getZoomReviewQueueTrend",
  );

  return {
    pendingCount: row?.pendingCount ?? 0,
    pendingCount24hAgo: row?.pendingCount24hAgo ?? 0,
    pendingCount7dAgo: row?.pendingCount7dAgo ?? 0,
    createdLast24h: row?.createdLast24h ?? 0,
    createdLast7d: row?.createdLast7d ?? 0,
    resolvedLast24h: row?.resolvedLast24h ?? 0,
    resolvedLast7d: row?.resolvedLast7d ?? 0,
  };
}

function buildReviewQueueLink(): string {
  const base = process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || "";
  const path = "/admin/zoom/review";
  if (!base) return path;
  return `${base.replace(/\/$/, "")}${path}`;
}

function buildAlertText(metrics: ZoomReviewQueueMetrics, reasons: string[]): string {
  const link = buildReviewQueueLink();
  const ageStr = metrics.oldestAgeHours != null ? `${metrics.oldestAgeHours.toFixed(1)}h` : "n/a";
  return [
    `:warning: Zoom review queue is backed up`,
    `• Pending calls: *${metrics.pendingCount}*`,
    `• Oldest pending: *${ageStr}*`,
    `• Reasons: ${reasons.join("; ")}`,
    `Review now: ${link}`,
  ].join("\n");
}

function buildClearedText(
  metrics: ZoomReviewQueueMetrics,
  thresholds: { countThreshold: number; ageHoursThreshold: number },
): string {
  const link = buildReviewQueueLink();
  const ageStr = metrics.oldestAgeHours != null ? `${metrics.oldestAgeHours.toFixed(1)}h` : "n/a";
  return [
    `:white_check_mark: Zoom review queue is back to normal`,
    `• Pending calls: *${metrics.pendingCount}* (threshold ${thresholds.countThreshold})`,
    `• Oldest pending: *${ageStr}* (threshold ${thresholds.ageHoursThreshold}h)`,
    `Queue: ${link}`,
  ].join("\n");
}

function buildEmailContent(
  metrics: ZoomReviewQueueMetrics,
  reasons: string[],
): { subject: string; text: string; html: string } {
  const link = buildReviewQueueLink();
  const ageStr = metrics.oldestAgeHours != null ? `${metrics.oldestAgeHours.toFixed(1)}h` : "n/a";
  const subject = `[Zoom Review] Queue backed up: ${metrics.pendingCount} pending, oldest ${ageStr}`;
  const text =
    `Zoom review queue is backed up.\n\n` +
    `Pending calls: ${metrics.pendingCount}\n` +
    `Oldest pending: ${ageStr}\n` +
    `Reasons: ${reasons.join("; ")}\n\n` +
    `Review now: ${link}\n`;
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html =
    `<p><strong>:warning: Zoom review queue is backed up</strong></p>` +
    `<ul>` +
    `<li>Pending calls: <strong>${metrics.pendingCount}</strong></li>` +
    `<li>Oldest pending: <strong>${escape(ageStr)}</strong></li>` +
    `<li>Reasons: ${escape(reasons.join("; "))}</li>` +
    `</ul>` +
    `<p><a href="${escape(link)}">Review now</a></p>`;
  return { subject, text, html };
}

async function sendEmailNotification(
  recipients: string[],
  metrics: ZoomReviewQueueMetrics,
  reasons: string[],
): Promise<{ sent: boolean; recipients: number; skipReason?: string }> {
  if (recipients.length === 0) {
    return { sent: false, recipients: 0, skipReason: "no_recipients" };
  }
  // Pre-check sender/key independently so we can preserve granular skipReason
  // values for the in-app status display, even though the actual send goes
  // through the shared mailer.
  const apiKey = process.env.SENDGRID_API_KEY;
  const from =
    process.env.ZOOM_REVIEW_ALERT_EMAIL_FROM ||
    process.env.SENDGRID_FROM_EMAIL ||
    process.env.ALERT_FROM_EMAIL;
  if (!apiKey && !from) {
    console.warn(
      "[ZoomReviewAlert] Email recipients configured but SENDGRID_API_KEY and sender email are missing; skipping email",
    );
    return { sent: false, recipients: 0, skipReason: "missing_api_key_and_sender" };
  }
  if (!apiKey) {
    console.warn(
      "[ZoomReviewAlert] Email recipients configured but SENDGRID_API_KEY is missing; skipping email",
    );
    return { sent: false, recipients: 0, skipReason: "missing_api_key" };
  }
  if (!from) {
    console.warn(
      "[ZoomReviewAlert] Email recipients configured but sender email is missing; skipping email",
    );
    return { sent: false, recipients: 0, skipReason: "missing_sender" };
  }
  const { subject, text, html } = buildEmailContent(metrics, reasons);
  const result = await sendMailerEmail({
    to: recipients,
    subject,
    text,
    html,
    fromOverride: process.env.ZOOM_REVIEW_ALERT_EMAIL_FROM,
    logPrefix: "[ZoomReviewAlert]",
  });
  if (result.ok) return { sent: true, recipients: recipients.length };
  let skipReason: string;
  if (result.reason === "http_error") {
    skipReason = `send_failed_${result.status ?? "unknown"}`;
  } else if (result.reason === "timeout") {
    skipReason = "timeout";
  } else if (result.reason === "missing_config") {
    // Should be unreachable given the pre-checks above, but keep a sensible label.
    skipReason = "missing_api_key_and_sender";
  } else {
    skipReason = "send_error";
  }
  return { sent: false, recipients: 0, skipReason };
}

async function sendSlackNotification(
  text: string,
): Promise<{ sent: boolean; skipReason?: string }> {
  // Task #994: route through the unified dispatcher. The resolver owns
  // channel selection (notification_settings → legacy
  // `zoom_review_alert_slack_channel`) so console edits immediately reroute
  // live alerts even when the legacy key is empty.
  const { notifyByType } = await import("./notifications/dispatcher");
  const result = await notifyByType(
    "queue.zoom_review.backlog",
    { text, preview: text.slice(0, 300) },
    { triggerSource: "alert_service", bypassDedupe: true },
  );
  if (result.delivered) return { sent: true };
  if (result.status === "failed") {
    const msg = result.error ?? "Slack delivery failed";
    console.error("[ZoomReviewAlert] Slack notification failed:", msg);
    const m = msg.match(/^Slack API error:\s*(.+)$/);
    const detail = (m ? m[1] : msg).trim().slice(0, 120);
    return { sent: false, skipReason: `post_failed:${detail}` };
  }
  if (result.status === "skipped_slack_disconnected") {
    console.warn("[ZoomReviewAlert] Slack not connected; skipping Slack notification");
    return { sent: false, skipReason: "not_connected" };
  }
  if (result.status === "skipped_disabled") return { sent: false, skipReason: "disabled" };
  if (result.status === "skipped_no_channel") return { sent: false, skipReason: "missing_channel" };
  return { sent: false, skipReason: result.status };
}

// Exported under a test-only alias for the Stage B/C migration test
// (tests/notifications-stage-bc-migration.test.ts) so the test can
// drive the real recipient-selection + notifyUser() fan-out path
// without standing up the full alert tick. The optional `usersOverride`
// arg lets the test inject a bounded user set so the sandbox tx
// doesn't fan out to every committed user in the live DB.
export async function __test_createZoomReviewInAppNotifications(
  text: string,
  type: string = "zoom_review_queue_backed_up",
  usersOverride?: ReadonlyArray<{ id: string; role: string | null }>,
): Promise<number> {
  return createInAppNotifications(text, type, usersOverride);
}

async function createInAppNotifications(
  text: string,
  type: string = "zoom_review_queue_backed_up",
  usersOverride?: ReadonlyArray<{ id: string; role: string | null }>,
): Promise<number> {
  try {
    let users: ReadonlyArray<{ id: string; role: string | null }>;
    if (usersOverride) {
      users = usersOverride;
    } else {
      const { getAllUsers } = await import("../storage/clientStorage");
      users = await getAllUsers();
    }
    const recipients = users.filter((u) => !!u.role && RECIPIENT_ROLES.has(u.role));
    // Task #1713 — Stage B: per-user inbox via notifyUser(). Dedupe key
    // matches the canonical alert-resend pattern so a follow-up backed-up
    // alert collapses to one bell row per admin within the dedupe window.
    const { notifyUser } = await import("./notifications/userInbox");
    const isCleared = type === "zoom_review_queue_cleared";
    const dedupeBase = isCleared
      ? "alert:queue.zoom_review.cleared"
      : "alert:queue.zoom_review.backlog";
    const title = isCleared
      ? "Zoom review queue cleared"
      : "Zoom review queue backed up";
    let created = 0;
    for (const u of recipients) {
      try {
        const result = await notifyUser(
          u.id,
          {
            category: "queue_health",
            title,
            body: text,
            deepLink: "/admin/zoom/review",
            dedupeKey: `${dedupeBase}:${u.id}`,
            metadata: { alertType: type },
          },
          // Task #1729 Phase 2.3 — worker-context fan-out routes through
          // the worker pool when tenancy enforcement is on.
          { source: "worker:zoom_review_queue_alerts" },
        );
        if (result && !result.deduped) created++;
      } catch (err) {
        console.error("[ZoomReviewAlert] In-app notify failed for user", u.id, err);
      }
    }
    return created;
  } catch (err) {
    console.error("[ZoomReviewAlert] Failed to create in-app notifications:", err);
    return 0;
  }
}

export interface RunAlertCheckOptions {
  /** Bypass enabled flag (used for manual test). */
  force?: boolean;
  /** Bypass cooldown enforcement (used for manual test). */
  bypassCooldown?: boolean;
  /**
   * Send a sample "all-clear" notification regardless of current metrics.
   * Used by admins to preview the cleared message. Does not modify any
   * persisted alert state (cycle state, last sent/cleared timestamps,
   * event history, or last status).
   */
  forceCleared?: boolean;
  /**
   * Send a sample "backed-up" notification regardless of current metrics
   * or cooldown. Used by admins to preview the backed-up message. Does
   * not modify any persisted alert state (lastSentAt, cycleState,
   * eventHistory, or lastStatus).
   */
  forceBackedUp?: boolean;
}

export async function runZoomReviewAlertCheck(
  opts: RunAlertCheckOptions = {},
): Promise<ZoomReviewAlertStatus> {
  if (inFlightCheck) {
    return inFlightCheck;
  }
  const promise = runZoomReviewAlertCheckImpl(opts).finally(() => {
    inFlightCheck = null;
  });
  inFlightCheck = promise;
  return promise;
}

async function runZoomReviewAlertCheckImpl(
  opts: RunAlertCheckOptions,
): Promise<ZoomReviewAlertStatus> {
  const settings = await getZoomReviewAlertSettings();
  const metrics = await getZoomReviewQueueMetrics();

  const reasons: string[] = [];
  if (metrics.pendingCount >= settings.countThreshold) {
    reasons.push(`pending count ${metrics.pendingCount} ≥ ${settings.countThreshold}`);
  }
  if (
    metrics.oldestAgeHours != null &&
    metrics.oldestAgeHours >= settings.ageHoursThreshold
  ) {
    reasons.push(
      `oldest item age ${metrics.oldestAgeHours.toFixed(1)}h ≥ ${settings.ageHoursThreshold}h`,
    );
  }
  const breached = reasons.length > 0;

  const status: ZoomReviewAlertStatus = {
    evaluatedAt: new Date().toISOString(),
    pendingCount: metrics.pendingCount,
    oldestAgeHours: metrics.oldestAgeHours,
    breached,
    breachReasons: reasons,
    notificationSent: false,
    slackSent: false,
    emailSent: false,
    emailRecipients: 0,
    inAppRecipients: 0,
  };

  if (opts.forceBackedUp) {
    const previewReasons =
      reasons.length > 0 ? reasons : ["preview: backed-up alert sample"];
    const text = buildAlertText(metrics, previewReasons);
    let previewSlackSent = false;
    status.slackAttempted = true;
    const r = await sendSlackNotification(text);
    previewSlackSent = r.sent;
    if (r.skipReason) status.slackSkipReason = r.skipReason;
    const previewInApp = await createInAppNotifications(text);
    status.slackSent = previewSlackSent;
    status.inAppRecipients = previewInApp;
    status.notificationSent = previewSlackSent || previewInApp > 0;
    if (!status.notificationSent) {
      status.skipReason = "preview_delivery_failed";
    }
    console.log(
      `[ZoomReviewAlert] Sent test backed-up preview: count=${metrics.pendingCount}, ` +
        `oldestHours=${metrics.oldestAgeHours?.toFixed(1) ?? "n/a"}, ` +
        `slack=${previewSlackSent}, inApp=${previewInApp} (no persisted state changes)`,
    );
    return status;
  }

  if (opts.forceCleared) {
    const clearedText = buildClearedText(metrics, {
      countThreshold: settings.countThreshold,
      ageHoursThreshold: settings.ageHoursThreshold,
    });
    let clearedSlackSent = false;
    status.slackAttempted = true;
    const r = await sendSlackNotification(clearedText);
    clearedSlackSent = r.sent;
    if (r.skipReason) status.slackSkipReason = r.skipReason;
    const clearedInApp = await createInAppNotifications(
      clearedText,
      "zoom_review_queue_cleared",
    );
    status.cleared = true;
    status.slackSent = clearedSlackSent;
    status.inAppRecipients = clearedInApp;
    status.notificationSent = clearedSlackSent || clearedInApp > 0;
    if (!status.notificationSent) {
      status.skipReason = "clear_delivery_failed";
    }
    console.log(
      `[ZoomReviewAlert] Sent test all-clear preview: count=${metrics.pendingCount}, ` +
        `oldestHours=${metrics.oldestAgeHours?.toFixed(1) ?? "n/a"}, ` +
        `slack=${clearedSlackSent}, inApp=${clearedInApp} (no persisted state changes)`,
    );
    return status;
  }

  if (!settings.enabled && !opts.force) {
    status.skipReason = "alerts_disabled";
    await writeSetting(SETTINGS_KEYS.lastStatus, JSON.stringify(status));
    return status;
  }

  if (!breached && !opts.force) {
    if (settings.cycleState === "alerted") {
      const clearedText = buildClearedText(metrics, {
        countThreshold: settings.countThreshold,
        ageHoursThreshold: settings.ageHoursThreshold,
      });
      let clearedSlackSent = false;
      status.slackAttempted = true;
      const r = await sendSlackNotification(clearedText);
      clearedSlackSent = r.sent;
      if (r.skipReason) status.slackSkipReason = r.skipReason;
      const clearedInApp = await createInAppNotifications(
        clearedText,
        "zoom_review_queue_cleared",
      );
      status.cleared = true;
      status.slackSent = clearedSlackSent;
      status.inAppRecipients = clearedInApp;
      status.notificationSent = clearedSlackSent || clearedInApp > 0;
      if (status.notificationSent) {
        await writeSetting(SETTINGS_KEYS.cycleState, "cleared");
        await writeSetting(SETTINGS_KEYS.lastClearedAt, status.evaluatedAt);
        await appendAlertEvent({
          type: "cleared",
          at: status.evaluatedAt,
          pendingCount: metrics.pendingCount,
          oldestAgeHours: metrics.oldestAgeHours,
          slack: {
            attempted: true,
            sent: clearedSlackSent,
            ...(r.skipReason ? { skipReason: r.skipReason } : {}),
          },
          // Email is intentionally not sent on the all-clear path —
          // record the channel explicitly so the history UI can show
          // a consistent Slack/Email/In-app row for every event.
          email: {
            attempted: false,
            sent: false,
            skipReason: "not_applicable_for_cleared",
          },
          inApp: { attempted: true, sent: clearedInApp > 0, recipients: clearedInApp },
        });
        console.log(
          `[ZoomReviewAlert] Sent all-clear: count=${metrics.pendingCount}, ` +
            `oldestHours=${metrics.oldestAgeHours?.toFixed(1) ?? "n/a"}, ` +
            `slack=${clearedSlackSent}, inApp=${clearedInApp}`,
        );
      } else {
        status.skipReason = "clear_delivery_failed";
        console.warn(
          "[ZoomReviewAlert] All-clear delivery failed on all channels; will retry on next check",
        );
      }
      await writeSetting(SETTINGS_KEYS.lastStatus, JSON.stringify(status));
      return status;
    }
    status.skipReason = "no_breach";
    await writeSetting(SETTINGS_KEYS.lastStatus, JSON.stringify(status));
    return status;
  }

  if (!opts.bypassCooldown && settings.lastSentAt) {
    const last = new Date(settings.lastSentAt).getTime();
    const elapsedMs = Date.now() - last;
    const cooldownMs = settings.cooldownMinutes * 60 * 1000;
    if (Number.isFinite(last) && elapsedMs < cooldownMs) {
      status.skipReason = "cooldown_active";
      await writeSetting(SETTINGS_KEYS.lastStatus, JSON.stringify(status));
      return status;
    }
  }

  const messageReasons = reasons.length > 0 ? reasons : ["manual test alert"];
  const text = buildAlertText(metrics, messageReasons);

  status.slackAttempted = true;
  {
    const r = await sendSlackNotification(text);
    status.slackSent = r.sent;
    if (r.skipReason) status.slackSkipReason = r.skipReason;
  }
  if (settings.recipientEmails.length > 0) {
    status.emailAttempted = true;
    const emailResult = await sendEmailNotification(
      settings.recipientEmails,
      metrics,
      messageReasons,
    );
    status.emailSent = emailResult.sent;
    status.emailRecipients = emailResult.recipients;
    if (emailResult.skipReason) {
      status.emailSkipReason = emailResult.skipReason;
    }
  } else {
    status.emailSkipReason = "no_recipients";
  }
  status.inAppRecipients = await createInAppNotifications(text);
  status.notificationSent =
    status.slackSent || status.emailSent || status.inAppRecipients > 0;

  if (status.notificationSent) {
    await writeSetting(SETTINGS_KEYS.lastSentAt, status.evaluatedAt);
    if (breached) {
      await writeSetting(SETTINGS_KEYS.cycleState, "alerted");
      await appendAlertEvent({
        type: "backed-up",
        at: status.evaluatedAt,
        pendingCount: metrics.pendingCount,
        oldestAgeHours: metrics.oldestAgeHours,
        slack: {
          attempted: status.slackAttempted === true,
          sent: status.slackSent,
          ...(status.slackSkipReason ? { skipReason: status.slackSkipReason } : {}),
        },
        email: {
          attempted: status.emailAttempted === true,
          sent: status.emailSent,
          recipients: status.emailRecipients,
          ...(status.emailSkipReason ? { skipReason: status.emailSkipReason } : {}),
        },
        inApp: {
          attempted: true,
          sent: status.inAppRecipients > 0,
          recipients: status.inAppRecipients,
        },
      });
    }
  }
  await writeSetting(SETTINGS_KEYS.lastStatus, JSON.stringify(status));

  if (status.notificationSent) {
    console.log(
      `[ZoomReviewAlert] Sent backed-up alert: count=${metrics.pendingCount}, ` +
        `oldestHours=${metrics.oldestAgeHours?.toFixed(1) ?? "n/a"}, ` +
        `slack=${status.slackSent}, email=${status.emailSent} (${status.emailRecipients} recipients), ` +
        `inApp=${status.inAppRecipients}`,
    );
  } else if (breached) {
    console.warn(
      "[ZoomReviewAlert] Threshold breached but no notification channel succeeded",
    );
  }

  return status;
}

export function startZoomReviewAlertScheduler(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void withDbAttribution("scheduler:zoom-review-queue-alerts", () =>
      runZoomReviewAlertCheck().catch((err) => {
        console.error("[ZoomReviewAlert] Scheduled check failed:", err);
      }),
    );
  }, POLL_INTERVAL_MS);
  if (typeof (pollTimer as any).unref === "function") (pollTimer as any).unref();
  console.log(
    `[ZoomReviewAlert] Scheduler started (interval=${Math.round(POLL_INTERVAL_MS / 1000)}s)`,
  );
}

export function stopZoomReviewAlertScheduler(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
