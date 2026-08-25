// @cross-instance-safe: cooldown-guarded emit — DB health.digest.last_sent_date key in system_settings gates the daily digest; duplicate emit is low-harm.
/**
 * Task #861 Phase 9 — Daily Slack digest of health status.
 *
 * Reuses the existing alert dispatch pattern (slackIntegration.postMessage,
 * loadAlertNotifyConfig). Suppresses the digest on healthy days where there
 * were no alerts and no telemetry gaps.
 *
 * Configuration:
 *   - `health.digest.enabled`            — "true"/"false"; default false.
 *   - `health.digest.hour_utc`           — integer 0..23; default 14.
 *   - `health.digest.snoozed_until`      — ms epoch; suppresses until then.
 *   - `health.digest.last_sent_date`     — YYYY-MM-DD UTC; idempotency.
 *   - `health.digest.channel`            — channel override; falls back to
 *                                           the rate-limit alert channel.
 */

import { withDbAttribution } from "../db";
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { computeOverview } from "./healthOverview";
import { getFreshness } from "./healthRollups";
import { listOpenIncidents } from "./healthIncidents";
import { getSlowQueries } from "./dbServerMetrics";

const CHECK_INTERVAL_MS = 5 * 60_000;
const SETTING_ENABLED = "health.digest.enabled";
const SETTING_HOUR = "health.digest.hour_utc";
const SETTING_SNOOZED = "health.digest.snoozed_until";
const SETTING_LAST_SENT = "health.digest.last_sent_date";
const SETTING_CHANNEL = "health.digest.channel";

let interval: ReturnType<typeof setInterval> | null = null;

function utcDateString(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export interface DigestPlan {
  shouldSend: boolean;
  reason: string;
  message?: string;
  channel?: string;
}

export async function planDigest(now: number = Date.now()): Promise<DigestPlan> {
  const enabled = (await getSystemSetting(SETTING_ENABLED))?.value === "true";
  if (!enabled) return { shouldSend: false, reason: "digest disabled" };

  const snoozedUntilStr = (await getSystemSetting(SETTING_SNOOZED))?.value;
  const snoozedUntil = snoozedUntilStr ? Number(snoozedUntilStr) : 0;
  if (snoozedUntil && snoozedUntil > now) {
    return { shouldSend: false, reason: `snoozed until ${new Date(snoozedUntil).toISOString()}` };
  }

  const hourStr = (await getSystemSetting(SETTING_HOUR))?.value;
  const targetHour = Number(hourStr ?? "14");
  if (!Number.isFinite(targetHour) || targetHour < 0 || targetHour > 23) {
    return { shouldSend: false, reason: "invalid hour" };
  }
  const utcHour = new Date(now).getUTCHours();
  if (utcHour !== targetHour) {
    return { shouldSend: false, reason: `not at digest hour (${targetHour}, now ${utcHour})` };
  }

  const today = utcDateString(now);
  const lastSent = (await getSystemSetting(SETTING_LAST_SENT))?.value;
  if (lastSent === today) {
    return { shouldSend: false, reason: "already sent today" };
  }

  // Compose
  const [overview, freshness, incidents, slowQ, postDeployReport] =
    await Promise.all([
      computeOverview().catch(() => null),
      getFreshness().catch(() => []),
      listOpenIncidents().catch(() => []),
      getSlowQueries().catch(() => null),
      // Task #973 — pull the latest post-deploy verification status BEFORE
      // the early-return health gate so a deploy-verification WARN/FAIL
      // alone can force the digest to send on an otherwise quiet day.
      // Wrapped to never break a digest tick if verification is degraded.
      import("./postDeployVerification")
        .then(({ runPostDeployVerification }) => runPostDeployVerification())
        .catch(() => null),
    ]);

  const hasAlerts = incidents.length > 0;
  const hasGaps = freshness.some((f) => f.status === "missing" || f.status === "delayed");
  const errorPct = overview?.windows.h24.errorPct ?? 0;
  const isUnhealthy = errorPct > 1 || (overview?.regression?.isRegression ?? false);
  const postDeployNeedsAttention =
    __testGating.evaluatePostDeployNeedsAttention(postDeployReport);

  if (!hasAlerts && !hasGaps && !isUnhealthy && !postDeployNeedsAttention) {
    return { shouldSend: false, reason: "no alerts, no gaps, healthy" };
  }

  const lines: string[] = [];
  lines.push(`*Health Digest — ${today}*`);
  if (overview) {
    lines.push(
      `Status: *${overview.currentStatus.toUpperCase()}* | 24h OK ${overview.windows.h24.okPct.toFixed(1)}% | error ${overview.windows.h24.errorPct.toFixed(1)}%`,
    );
    lines.push(
      `Round-trip p95 ${overview.latency.roundTripP95Ms ?? "—"}ms | p99 ${overview.latency.roundTripP99Ms ?? "—"}ms | error budget remaining ${overview.slo.errorBudgetRemainingPct.toFixed(1)}%`,
    );
    if (overview.regression?.isRegression) {
      lines.push(`*REGRESSION:* ${overview.regression.summary}`);
    }
  }
  if (incidents.length > 0) {
    lines.push(`*Open incidents (${incidents.length}):*`);
    for (const inc of incidents.slice(0, 5)) {
      lines.push(
        `• [${inc.severity.toUpperCase()}] ${inc.title} — ×${inc.occurrenceCount} (peak ${inc.peakValue})`,
      );
    }
  }
  const gaps = freshness.filter((f) => f.status === "missing" || f.status === "delayed");
  if (gaps.length > 0) {
    lines.push(`*Telemetry gaps:*`);
    for (const g of gaps) {
      lines.push(`• \`${g.table}\` — ${g.status}${g.notes ? ` (${g.notes})` : ""}`);
    }
  }
  // Task #973 — surface a one-line post-deploy verification status so
  // any warns from the most recent boot get re-aired in the daily digest
  // (FAIL pages on its own, PASS is the silent default). Sourced from the
  // top-of-function `postDeployReport` so the gating decision and the
  // rendered line stay in sync.
  if (postDeployReport && postDeployReport.overall !== "pass") {
    const tag =
      postDeployReport.overall === "fail" ? ":rotating_light:" : ":warning:";
    const groupSummary = postDeployReport.groups
      .map((g) => `${g.id}=${g.status}`)
      .join(", ");
    lines.push(
      `${tag} Post-deploy verification overall *${postDeployReport.overall.toUpperCase()}* (${groupSummary})`,
    );
  }

  if (slowQ?.available && slowQ.data.length > 0) {
    lines.push(`*Top slow queries (5):*`);
    for (const q of slowQ.data.slice(0, 5)) {
      const snippet = q.query.replace(/\s+/g, " ").slice(0, 80);
      lines.push(`• mean=${q.meanTimeMs}ms calls=${q.calls} \`${snippet}\``);
    }
  }
  lines.push("");
  lines.push("Run `/health` or open the Health Dashboard for details. Use the Markdown export for ops notes.");

  // Channel resolution is now owned by the dispatcher's resolver (which
  // honours notification_settings → `health.digest.channel` legacy key →
  // rate-limit alert channel fallback). Probe it here so we can short-circuit
  // before building a Slack post when nothing is configured.
  const { resolveNotification } = await import("./notifications/resolver");
  const resolved = await resolveNotification("workflow.health.daily_digest");
  if (!resolved?.channelId) {
    return { shouldSend: false, reason: "no slack channel configured" };
  }

  return {
    shouldSend: true,
    reason: "digest pending",
    message: lines.join("\n"),
    channel: resolved.channelId,
  };
}

export async function maybeSendDigest(now: number = Date.now()): Promise<{ sent: boolean; reason: string }> {
  const plan = await planDigest(now);
  if (!plan.shouldSend) return { sent: false, reason: plan.reason };
  if (!plan.message || !plan.channel) {
    return { sent: false, reason: "no message/channel" };
  }
  // Task #994: route through the unified dispatcher. The resolver owns
  // channel selection (notification_settings → `health.digest.channel` →
  // rate-limit alert channel), so admin edits in the Slack Notifications
  // Console immediately reroute the digest. The dispatcher still enforces
  // the console enabled flag and kill switch, and records the delivery.
  const { notifyByType } = await import("./notifications/dispatcher");
  const result = await notifyByType(
    "workflow.health.daily_digest",
    { text: plan.message, preview: plan.message.slice(0, 300) },
    { triggerSource: "scheduled", bypassDedupe: true },
  );
  if (result.delivered) {
    await setSystemSetting(SETTING_LAST_SENT, utcDateString(now), "system");
    return { sent: true, reason: "sent" };
  }
  if (result.status === "failed") {
    return { sent: false, reason: `slack post failed: ${result.error ?? "unknown"}` };
  }
  return { sent: false, reason: result.skipReason ?? result.status };
}

export function startHealthSlackDigestScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution("scheduler:health-slack-digest", () =>
      maybeSendDigest().then(
        (r) => {
          if (r.sent) console.log(`[HealthDigest] sent: ${r.reason}`);
        },
        (err) => console.warn("[HealthDigest] tick error:", err?.message || err),
      ),
    );
  }, CHECK_INTERVAL_MS);
  console.log(`[HealthDigest] scheduler started (check every ${CHECK_INTERVAL_MS / 60000}min)`);
}

export function stopHealthSlackDigestScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __testHelpers = {
  planDigest,
  utcDateString,
  SETTING_ENABLED,
  SETTING_HOUR,
  SETTING_LAST_SENT,
  SETTING_CHANNEL,
  SETTING_SNOOZED,
};

/**
 * Task #973 — exposed for the per-deploy digest regression suite. Mirrors
 * the gating predicate inlined in `planDigest` so tests can lock the
 * contract that warn/fail post-deploy reports force a daily digest send.
 */
export const __testGating = {
  evaluatePostDeployNeedsAttention(
    report: { overall: "pass" | "warn" | "fail" } | null,
  ): boolean {
    return !!report && report.overall !== "pass";
  },
};
