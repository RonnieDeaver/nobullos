// Task #672 — Background auto-retry for failed threshold-alert
// (`agent_match_setting_history`) Slack/email deliveries.
//
// When a CEO changes a matching threshold we fan-out a Slack post + email.
// Transient failures (Slack rate limits, SMTP hiccups) used to require an
// admin to notice the failed row in the change-history table and click
// "Retry". This scheduler periodically re-broadcasts those failed rows with
// exponential backoff so transient outages clear themselves without manual
// intervention.
//
// Per-row state (lives on `agent_match_setting_history`):
//   - slack_attempt_count / email_attempt_count — bumped each time we
//     attempt that channel. Capped at MAX_ATTEMPTS so we eventually give up.
//   - last_auto_retry_at — drives the per-row backoff between attempts.
//
// Manual UI retry (server/routes/matchSettings.ts) resets the per-channel
// attempt count for the channels it retried, so the loop picks up fresh
// from a manual nudge if the channel keeps failing.

import { storage } from "../storage";
import { withDbAttribution } from "../db";
import { broadcastMatchSettingChange } from "./matchSettingsAlerts";
import {
  MATCH_SETTING_DESCRIPTORS,
  isAgentMatchSettingKey,
  isAgentMatchSettingSource,
} from "./matchSettings";
import type {
  AgentMatchSettingKey,
  AgentMatchSettingSource,
} from "@shared/schema";

const GIVEUP_RECIPIENT_ROLES = new Set(["account_manager", "team_lead", "ceo"]);

const TICK_INTERVAL_MS = 60_000;
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const SCAN_LIMIT = 100;

// Max attempts BEYOND the initial dispatch (so a row will be re-broadcast at
// most MAX_ATTEMPTS times before we give up on that channel).
export const MAX_ATTEMPTS = 4;

// Exponential backoff (per channel attempt). attempt#1 → 1m, #2 → 5m,
// #3 → 15m, #4 → 60m. Anything beyond the table falls back to the last
// value so we never loop on a divide-by-zero.
const BACKOFF_MS_BY_ATTEMPT = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

function backoffMs(attemptCount: number): number {
  if (attemptCount <= 0) return 0;
  return BACKOFF_MS_BY_ATTEMPT[
    Math.min(attemptCount, BACKOFF_MS_BY_ATTEMPT.length) - 1
  ];
}

const SCOPE_LABEL: Record<AgentMatchSettingSource, string> = {
  default: "Default (all sources)",
  zoom: "Zoom override",
};

function formatThresholdValue(n: number | null | undefined): string {
  if (n === null || n === undefined) return "unset";
  return Number(n).toFixed(3);
}

function formatActor(
  user: { firstName?: string | null; lastName?: string | null; email?: string | null } | null,
  fallbackId: string | null,
): string {
  if (!user) return fallbackId || "system";
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || user.email || fallbackId || "system";
}

let tickTimer: NodeJS.Timeout | null = null;
let running = false;

export interface AutoRetryTickResult {
  scanned: number;
  retried: number;
  skippedBackoff: number;
  exhausted: number;
  errors: number;
}

export async function runMatchSettingsAlertAutoRetryOnce(): Promise<AutoRetryTickResult> {
  const result: AutoRetryTickResult = {
    scanned: 0,
    retried: 0,
    skippedBackoff: 0,
    exhausted: 0,
    errors: 0,
  };

  let candidates: Awaited<
    ReturnType<typeof import("../storage/agentMatchSettingsStorage")["listAgentMatchSettingHistoryForAutoRetry"]>
  >;
  try {
    const { listAgentMatchSettingHistoryForAutoRetry } = await import(
      "../storage/agentMatchSettingsStorage"
    );
    candidates = await listAgentMatchSettingHistoryForAutoRetry({
      withinMs: LOOKBACK_MS,
      maxAttempts: MAX_ATTEMPTS,
      limit: SCAN_LIMIT,
    });
  } catch (err: any) {
    console.error(
      "[MatchSettingsAlertAutoRetry] Failed to load candidates:",
      err?.message ?? err,
    );
    result.errors += 1;
    return result;
  }

  result.scanned = candidates.length;
  if (candidates.length === 0) return result;

  // Resolve user labels once per tick so we don't refetch for every row.
  let allUsers: Awaited<ReturnType<typeof storage.getAllUsers>> = [];
  try {
    allUsers = await storage.getAllUsers();
  } catch (err: any) {
    console.error(
      "[MatchSettingsAlertAutoRetry] Failed to load users:",
      err?.message ?? err,
    );
    result.errors += 1;
    return result;
  }

  const now = Date.now();

  for (const row of candidates) {
    if (!isAgentMatchSettingSource(row.source) || !isAgentMatchSettingKey(row.settingKey)) {
      continue;
    }

    const slackEligible =
      row.slackStatus === "failed" && (row.slackAttemptCount ?? 0) < MAX_ATTEMPTS;
    const emailEligible =
      row.emailStatus === "failed" && (row.emailAttemptCount ?? 0) < MAX_ATTEMPTS;

    if (!slackEligible && !emailEligible) {
      // Either both succeeded since we scanned, or both have exhausted
      // their budget. Nothing to do here.
      if (
        (row.slackStatus === "failed" && (row.slackAttemptCount ?? 0) >= MAX_ATTEMPTS) ||
        (row.emailStatus === "failed" && (row.emailAttemptCount ?? 0) >= MAX_ATTEMPTS)
      ) {
        result.exhausted += 1;
      }
      continue;
    }

    // Per-channel backoff: each channel is gated by its own attempt count.
    // We use the *minimum* required wait of the eligible channels so a
    // channel that's overdue still gets retried even if the other one
    // hasn't earned its slot yet.
    const lastAttemptAt = row.lastAutoRetryAt
      ? new Date(row.lastAutoRetryAt).getTime()
      : new Date(row.changedAt).getTime();
    const eligibleWaits: number[] = [];
    if (slackEligible) eligibleWaits.push(backoffMs(row.slackAttemptCount ?? 0));
    if (emailEligible) eligibleWaits.push(backoffMs(row.emailAttemptCount ?? 0));
    const requiredWait = Math.min(...eligibleWaits);
    if (now - lastAttemptAt < requiredWait) {
      result.skippedBackoff += 1;
      continue;
    }

    const descriptor = MATCH_SETTING_DESCRIPTORS[row.settingKey];
    const scopeLabel = SCOPE_LABEL[row.source];
    const action: "updated" | "cleared" = row.newValue === null ? "cleared" : "updated";
    const actor = row.changedBy ? allUsers.find((u) => u.id === row.changedBy) ?? null : null;
    const recipients = allUsers.filter((u) => u.role === "ceo" && u.id !== row.changedBy);
    const recipientEmails = recipients
      .map((r) => r.email)
      .filter((e): e is string => typeof e === "string" && e.length > 0);
    const actorName = formatActor(actor, row.changedBy);

    let delivery: Awaited<ReturnType<typeof broadcastMatchSettingChange>>;
    let broadcastThrew = false;
    try {
      delivery = await broadcastMatchSettingChange(
        {
          scope: row.source,
          scopeLabel,
          settingKey: descriptor.key,
          settingLabel: descriptor.label,
          oldValue: formatThresholdValue(row.oldValue),
          newValue: formatThresholdValue(row.newValue),
          action,
          actorName,
          recipientEmails,
        },
        { channels: { slack: slackEligible, email: emailEligible } },
      );
    } catch (err: any) {
      // Broadcast threw — synthesize a "failed" outcome for each
      // eligible channel so the post-tick give-up exhaustion logic
      // below treats this attempt identically to a returned-failure
      // attempt. This is critical: without it, an exception on the
      // final allowed attempt would mark the row exhausted (attempt
      // count reaches MAX_ATTEMPTS) but never fire the give-up
      // notification, and the row would never be re-scanned.
      console.warn(
        `[MatchSettingsAlertAutoRetry] Broadcast threw for history ${row.id}:`,
        err?.message ?? err,
      );
      broadcastThrew = true;
      result.errors += 1;
      const reason = err?.message
        ? `Auto-retry exception: ${String(err.message).slice(0, 180)}`
        : "Auto-retry exception";
      delivery = {
        slack: slackEligible
          ? { status: "failed", failureReason: reason }
          : { status: "skipped" },
        email: emailEligible
          ? { status: "failed", failureReason: reason }
          : { status: "skipped" },
      };
    }

    const postSlackStatus = slackEligible ? delivery.slack.status : row.slackStatus;
    const postEmailStatus = emailEligible ? delivery.email.status : row.emailStatus;
    const postSlackCount = slackEligible
      ? (row.slackAttemptCount ?? 0) + 1
      : row.slackAttemptCount ?? 0;
    const postEmailCount = emailEligible
      ? (row.emailAttemptCount ?? 0) + 1
      : row.emailAttemptCount ?? 0;
    const postSlackFailureReason = slackEligible
      ? delivery.slack.status === "failed"
        ? delivery.slack.failureReason ?? null
        : null
      : row.slackFailureReason ?? null;
    const postEmailFailureReason = emailEligible
      ? delivery.email.status === "failed"
        ? delivery.email.failureReason ?? null
        : null
      : row.emailFailureReason ?? null;

    const slackExhausted = postSlackStatus === "failed" && postSlackCount >= MAX_ATTEMPTS;
    const emailExhausted = postEmailStatus === "failed" && postEmailCount >= MAX_ATTEMPTS;
    const shouldNotifyGiveup =
      (slackExhausted || emailExhausted) && !row.autoRetryGiveupNotifiedAt;

    try {
      await storage.updateAgentMatchSettingHistoryDelivery({
        id: row.id,
        slackStatus: slackEligible ? delivery.slack.status : undefined,
        emailStatus: emailEligible ? delivery.email.status : undefined,
        slackFailureReason: slackEligible
          ? delivery.slack.status === "failed"
            ? delivery.slack.failureReason ?? null
            : null
          : undefined,
        emailFailureReason: emailEligible
          ? delivery.email.status === "failed"
            ? delivery.email.failureReason ?? null
            : null
          : undefined,
        slackAttemptCount: slackEligible
          ? (row.slackAttemptCount ?? 0) + 1
          : undefined,
        emailAttemptCount: emailEligible
          ? (row.emailAttemptCount ?? 0) + 1
          : undefined,
        lastAutoRetryAt: new Date(),
      });
      if (!broadcastThrew) result.retried += 1;
    } catch (writeErr: any) {
      console.error(
        `[MatchSettingsAlertAutoRetry] Failed to update history ${row.id}:`,
        writeErr?.message ?? writeErr,
      );
      result.errors += 1;
      continue;
    }

    if (shouldNotifyGiveup) {
      const failedChannels: Array<"slack" | "email"> = [];
      if (slackExhausted) failedChannels.push("slack");
      if (emailExhausted) failedChannels.push("email");
      const latestFailureReason =
        (slackExhausted ? postSlackFailureReason : null) ||
        (emailExhausted ? postEmailFailureReason : null) ||
        "unknown";
      try {
        await notifyAutoRetryGiveup({
          historyId: row.id,
          settingKey: descriptor.key,
          settingLabel: descriptor.label,
          scopeLabel,
          actorName,
          oldValue: formatThresholdValue(row.oldValue),
          newValue: formatThresholdValue(row.newValue),
          failedChannels,
          latestFailureReason,
          maxAttempts: MAX_ATTEMPTS,
          recipients: allUsers.filter(
            (u) => !!u.role && GIVEUP_RECIPIENT_ROLES.has(u.role),
          ),
        });
        await storage.updateAgentMatchSettingHistoryDelivery({
          id: row.id,
          autoRetryGiveupNotifiedAt: new Date(),
        });
        result.exhausted += 1;
      } catch (notifyErr: any) {
        console.error(
          `[MatchSettingsAlertAutoRetry] Give-up notification failed for ${row.id}:`,
          notifyErr?.message ?? notifyErr,
        );
        result.errors += 1;
      }
    }
  }

  return result;
}

interface GiveupNotificationParams {
  historyId: string;
  settingKey: string;
  settingLabel: string;
  scopeLabel: string;
  actorName: string;
  oldValue: string;
  newValue: string;
  failedChannels: Array<"slack" | "email">;
  latestFailureReason: string;
  maxAttempts: number;
  recipients: Awaited<ReturnType<typeof storage.getAllUsers>>;
}

function buildGiveupText(p: GiveupNotificationParams): string {
  const channels = p.failedChannels.join(" + ") || "all channels";
  return (
    `:warning: Threshold-alert auto-retry gave up after ${p.maxAttempts} attempts. ` +
    `${p.actorName}'s change to "${p.settingLabel}" (${p.settingKey}) on ${p.scopeLabel} ` +
    `(${p.oldValue} → ${p.newValue}) was never broadcast on: ${channels}. ` +
    `Latest failure: ${p.latestFailureReason}. Please investigate and resend manually.`
  );
}

function buildGiveupSlackBlocks(p: GiveupNotificationParams): any[] {
  const channels = p.failedChannels.join(", ") || "all channels";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `:warning: *Threshold-alert auto-retry gave up*\n` +
          `${p.actorName}'s change to *${p.settingLabel}* (\`${p.settingKey}\`) was never broadcast.`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Scope*\n${p.scopeLabel}` },
        { type: "mrkdwn", text: `*Change*\n${p.oldValue} → ${p.newValue}` },
        { type: "mrkdwn", text: `*Still-failed channel(s)*\n${channels}` },
        { type: "mrkdwn", text: `*Latest failure*\n${p.latestFailureReason}` },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Auto-retry exhausted after ${p.maxAttempts} attempts. Resend manually from the Change History table.`,
        },
      ],
    },
  ];
}

async function notifyAutoRetryGiveup(p: GiveupNotificationParams): Promise<void> {
  const text = buildGiveupText(p);

  // Slack via the unified dispatcher — reuses the existing match-settings
  // alert channel resolution and bypasses dedupe (this is a discrete event).
  try {
    const { notifyByType } = await import("./notifications/dispatcher");
    const result = await notifyByType(
      "workflow.match_settings.changed",
      {
        text,
        blocks: buildGiveupSlackBlocks(p),
        preview: {
          settingKey: p.settingKey,
          giveup: true,
          failedChannels: p.failedChannels,
        },
      },
      {
        triggerSource: "alert_service",
        bypassDedupe: true,
        // The give-up path produces its own per-recipient `match:giveup:*`
        // inbox row below. Without this flag the dispatcher would ALSO
        // fan out a generic `alert:workflow.match_settings.changed:*`
        // mirror row to every CEO/team_lead, double-belling them.
        skipAdminInAppMirror: true,
      },
    );
    if (!result.delivered && result.status === "failed") {
      console.warn(
        `[MatchSettingsAlertAutoRetry] Give-up Slack delivery failed for ${p.historyId}:`,
        result.error,
      );
    }
  } catch (err: any) {
    console.warn(
      `[MatchSettingsAlertAutoRetry] Give-up Slack dispatch threw for ${p.historyId}:`,
      err?.message ?? err,
    );
  }

  // In-app notifications for admin recipients (CEO / team lead / account
  // manager) so somebody sees this even if Slack itself is the broken
  // channel. Failures here are logged but don't unwind the give-up stamp —
  // the goal is best-effort surfacing.
  // Task #1713 — Stage B: per-user inbox via notifyUser(). Dedupe by
  // (historyId, recipient) so a retried tick can't re-bell the give-up
  // notice (the historyId is also already write-once-guarded by the
  // `autoRetryGiveupNotifiedAt` column above).
  const { notifyUser } = await import("./notifications/userInbox");
  for (const u of p.recipients) {
    try {
      await notifyUser(
        u.id,
        {
          category: "system",
          title: `Threshold-alert auto-retry gave up: ${p.settingLabel}`,
          body: text,
          deepLink: "/admin/match-settings",
          dedupeKey: `match:giveup:${p.historyId}:${u.id}`,
          metadata: {
            historyId: p.historyId,
            settingKey: p.settingKey,
            scopeLabel: p.scopeLabel,
            failedChannels: p.failedChannels,
          },
        },
        // Task #1729 Phase 2.3 — worker-tick caller routes through the
        // worker pool when tenancy enforcement is on.
        { source: "worker:match_settings_alert_auto_retry_giveup" },
      );
    } catch (err: any) {
      console.error(
        `[MatchSettingsAlertAutoRetry] In-app give-up notify failed for user ${u.id}:`,
        err?.message ?? err,
      );
    }
  }
}

async function runTickGuarded(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await runMatchSettingsAlertAutoRetryOnce();
    if (result.retried > 0 || result.exhausted > 0 || result.errors > 0) {
      console.log(
        `[MatchSettingsAlertAutoRetry] tick scanned=${result.scanned} ` +
          `retried=${result.retried} skippedBackoff=${result.skippedBackoff} ` +
          `exhausted=${result.exhausted} errors=${result.errors}`,
      );
    }
  } catch (err: any) {
    console.error(
      "[MatchSettingsAlertAutoRetry] Tick failed:",
      err?.message ?? err,
    );
  } finally {
    running = false;
  }
}

export function startMatchSettingsAlertAutoRetryScheduler(): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    void withDbAttribution("scheduler:match-settings-alert-auto-retry", () =>
      runTickGuarded(),
    );
  }, TICK_INTERVAL_MS);
  if (typeof tickTimer.unref === "function") tickTimer.unref();
  console.log(
    `[MatchSettingsAlertAutoRetry] Scheduler started (tick=${TICK_INTERVAL_MS / 1000}s, ` +
      `maxAttempts=${MAX_ATTEMPTS}, lookback=${LOOKBACK_MS / 60_000}m)`,
  );
  // Run shortly after boot so a fresh start doesn't have to wait a full
  // tick before working through any backlog.
  setTimeout(() => {
    void withDbAttribution(
      "startup:match-settings-alert-auto-retry-initial",
      () => runTickGuarded(),
    );
  }, 10_000);
}

export function stopMatchSettingsAlertAutoRetryScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
    console.log("[MatchSettingsAlertAutoRetry] Scheduler stopped");
  }
}
