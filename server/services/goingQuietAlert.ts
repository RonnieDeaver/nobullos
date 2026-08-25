/**
 * Task #3695 — Once-per-quiet-streak notification for going-quiet clients.
 *
 * Fired by the daily going-quiet sweep when a client NEWLY transitions to
 * flagged (previous snapshot not flagged → today's snapshot flagged). The
 * streak gate itself is durable — it lives in `client_engagement_snapshots`
 * (the sweep only calls this on the transition), so restarts and autoscale
 * siblings can't re-fire mid-streak. Recovery: when the client re-engages
 * (flagged → not flagged), `onClientReengaged` calls `markRecovered` so the
 * NEXT quiet streak alerts again immediately.
 *
 * Delivery:
 *   - `notifyByType("workflow.client.going_quiet", …)` — Slack channel (if
 *     configured) + the notification delivery ledger. Per-client dedupeKey
 *     gives a second dedupe layer under the transition gate. The generic
 *     admin in-app mirror is suppressed (`skipAdminInAppMirror`) because we
 *     fan out our own TARGETED in-app rows below.
 *   - `notifyUser(...)` in-app rows to the client's owner + every director+
 *     user (authority director/ceo, plus the legacy role-"ceo" bridge) —
 *     the same audience the Churn Command Center gate admits.
 *
 * Kill switch: `kill_switch_going_quiet_alert` (default ON; value "false"
 * disables). When OFF the sweep still snapshots and transitions — only the
 * notify calls are skipped.
 *
 * Tests swap the dispatcher/inbox/settings references via
 * `__setGoingQuietAlertDepsForTest` (ESM live-binding workaround, same
 * pattern as semrushDisconnectAlert).
 */
import { notifyByType, markRecovered } from "./notifications/dispatcher";
import { notifyUser } from "./notifications/userInbox";
import { getDirectorPlusUserIds } from "./notifications/recipients";
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";

export const GOING_QUIET_NOTIFICATION_ID = "workflow.client.going_quiet";

/** Task #3889 — single admin alert when the sweep detects a stale feed. */
export const GOING_QUIET_FEED_STALE_NOTIFICATION_ID =
  "workflow.pipeline.going_quiet_feed_stale";

/** Durable once-per-stale-streak gate ("1" while a streak is active). */
export const SETTING_GOING_QUIET_FEED_STALE_ALERT_ACTIVE =
  "going_quiet_feed_stale_alert_active";

/** Kill switch key — default ON (alert enabled); value "false" disables. */
export const KILL_SWITCH_GOING_QUIET_ALERT = "kill_switch_going_quiet_alert";

// Injectable references (tests can't monkey-patch read-only ESM bindings).
let _notifyByType: typeof notifyByType = notifyByType;
let _markRecovered: typeof markRecovered = markRecovered;
let _notifyUser: typeof notifyUser = notifyUser;
let _getDirectorPlusUserIds: typeof getDirectorPlusUserIds = getDirectorPlusUserIds;
let _getSystemSetting: typeof getSystemSetting = getSystemSetting;
let _setSystemSetting: typeof setSystemSetting = setSystemSetting;

export interface GoingQuietAlertContext {
  clientId: string;
  firmName: string;
  ownerId: string | null;
  snapshotDate: string;
  quietScore: number;
  dropPct: number | null;
  daysSinceLastInbound: number | null;
  reasons: string[];
}

export interface GoingQuietAlertOutcome {
  notified: boolean;
  skippedReason?: "kill_switch";
  recipientIds: string[];
}

/** True unless the kill switch row exists with value "false". A failed
 *  settings read counts as enabled — the alert IS the safety net, so an
 *  infra blip must not silently disable it. */
async function alertEnabled(): Promise<boolean> {
  try {
    const row = await _getSystemSetting(KILL_SWITCH_GOING_QUIET_ALERT);
    return row?.value !== "false";
  } catch (err: any) {
    console.warn(
      `[GoingQuietAlert] kill-switch read failed (treating as enabled): ${err?.message ?? err}`,
    );
    return true;
  }
}

/**
 * Notify the client's owner + director+ users that the client newly went
 * quiet. Called only on the not-flagged → flagged snapshot transition.
 */
export async function notifyClientGoingQuiet(
  ctx: GoingQuietAlertContext,
): Promise<GoingQuietAlertOutcome> {
  if (!(await alertEnabled())) {
    console.log(
      `[GoingQuietAlert] kill switch OFF — suppressing alert for client ${ctx.clientId} (${ctx.firmName})`,
    );
    return { notified: false, skippedReason: "kill_switch", recipientIds: [] };
  }

  const directorIds = await _getDirectorPlusUserIds();
  const recipientIds = Array.from(
    new Set([ctx.ownerId, ...directorIds].filter((id): id is string => !!id)),
  );

  const headline = `Client going quiet: ${ctx.firmName}`;
  const detail = ctx.reasons.length > 0 ? ctx.reasons.join("; ") : "Engagement dropped.";
  const text =
    `${headline} — quiet score ${Math.round(ctx.quietScore)}/100. ${detail} ` +
    `Review: /churn?tab=going-quiet`;

  // Slack + delivery ledger. Transition gating already enforces
  // once-per-streak; the dedupeKey is a second layer against same-day
  // re-runs. Targeted per-user rows below replace the generic admin mirror.
  await _notifyByType(
    GOING_QUIET_NOTIFICATION_ID,
    { text },
    {
      triggerSource: "scheduled",
      dedupeKey: ctx.clientId,
      failureType: "going_quiet",
      skipAdminInAppMirror: true,
      metadata: {
        clientId: ctx.clientId,
        firmName: ctx.firmName,
        snapshotDate: ctx.snapshotDate,
        quietScore: ctx.quietScore,
        dropPct: ctx.dropPct,
        daysSinceLastInbound: ctx.daysSinceLastInbound,
      },
      mirrorDeepLink: "/churn?tab=going-quiet",
    },
  );

  const body = detail.length > 240 ? `${detail.slice(0, 237)}...` : detail;
  for (const uid of recipientIds) {
    try {
      await _notifyUser(uid, {
        category: "system",
        title: headline,
        body,
        deepLink: "/churn?tab=going-quiet",
        // Per-user, per-streak-start dedupe: a same-day sweep re-run can't
        // double-post the inbox row.
        dedupeKey: `going-quiet:${ctx.clientId}:${ctx.snapshotDate}:${uid}`,
        metadata: {
          clientId: ctx.clientId,
          snapshotDate: ctx.snapshotDate,
          quietScore: ctx.quietScore,
        },
      });
    } catch (err: any) {
      console.warn(
        `[GoingQuietAlert] in-app notify failed for user ${uid} (client ${ctx.clientId}): ${err?.message ?? err}`,
      );
    }
  }

  return { notified: true, recipientIds };
}

/**
 * Re-arm the alert when a flagged client re-engages (flagged → not
 * flagged). Clears the dispatcher's unhealthy state for this client so the
 * next quiet streak alerts immediately instead of being deduped.
 */
export async function onClientReengaged(clientId: string): Promise<void> {
  try {
    await _markRecovered(GOING_QUIET_NOTIFICATION_ID, clientId);
  } catch (err: any) {
    console.warn(
      `[GoingQuietAlert] markRecovered failed for client ${clientId}: ${err?.message ?? err}`,
    );
  }
}

// ── Task #3889 — feed-stale pipeline alert (one per stale streak) ───────────

export interface GoingQuietFeedStaleContext {
  snapshotDate: string;
  newestInboundAt: Date | null;
  newestSyncActivityAt: Date | null;
  syncActiveRecent: number;
  lagDays: number | null;
  processed: number;
  suppressedFlags: number;
}

export interface GoingQuietFeedStaleOutcome {
  notified: boolean;
  skippedReason?: "already_active";
}

/**
 * Fired by the sweep when the feed-freshness guard trips. Exactly once per
 * stale streak: a durable `system_settings` flag stays "1" until a later
 * sweep observes the feed healthy again (`onGoingQuietFeedRecovered`).
 *
 * Deliberately NOT behind `kill_switch_going_quiet_alert` — that switch
 * silences the per-client noise; this alert is the meta safety net saying
 * the pipeline itself broke, and it must survive the noise switch. Uses the
 * dispatcher's generic admin in-app mirror + Slack (no per-client fanout).
 * A failed settings read counts as "not yet alerted": double-alerting a
 * broken pipeline beats never alerting.
 */
export async function notifyGoingQuietFeedStale(
  ctx: GoingQuietFeedStaleContext,
): Promise<GoingQuietFeedStaleOutcome> {
  try {
    const row = await _getSystemSetting(SETTING_GOING_QUIET_FEED_STALE_ALERT_ACTIVE);
    if (row?.value === "1") {
      return { notified: false, skippedReason: "already_active" };
    }
  } catch (err: any) {
    console.warn(
      `[GoingQuietAlert] feed-stale streak read failed (treating as new streak): ${err?.message ?? err}`,
    );
  }

  const fmtDate = (d: Date | null): string =>
    d ? d.toISOString().split("T")[0] : "none on record";
  const text =
    `Going Quiet data gap: the communication ingestion feed is stale, so today's sweep ` +
    `suppressed going-quiet flags (${ctx.suppressedFlags} of ${ctx.processed} clients would ` +
    `have been flagged). Newest ingested inbound: ${fmtDate(ctx.newestInboundAt)}; Front shows ` +
    `client activity through ${fmtDate(ctx.newestSyncActivityAt)} ` +
    `(${ctx.syncActiveRecent} conversations active in the recent window` +
    `${ctx.lagDays !== null ? `, feed lag ${ctx.lagDays}d` : ""}). ` +
    `Client flags and owner notifications stay suppressed until the feed catches up. ` +
    `Review: /churn?tab=going-quiet`;

  await _notifyByType(
    GOING_QUIET_FEED_STALE_NOTIFICATION_ID,
    // NOTE: the dispatcher's admin mirror titles every system alert
    // "System alert: <id>" — no per-call title in NotifyPayload; the body
    // carries the human summary.
    { text },
    {
      triggerSource: "scheduled",
      dedupeKey: "global",
      failureType: "going_quiet_feed_stale",
      metadata: {
        snapshotDate: ctx.snapshotDate,
        newestInboundAt: ctx.newestInboundAt?.toISOString() ?? null,
        newestSyncActivityAt: ctx.newestSyncActivityAt?.toISOString() ?? null,
        syncActiveRecent: ctx.syncActiveRecent,
        lagDays: ctx.lagDays,
        processed: ctx.processed,
        suppressedFlags: ctx.suppressedFlags,
      },
      mirrorDeepLink: "/churn?tab=going-quiet",
    },
  );

  // Set the streak gate AFTER the notify: if delivery threw, the next sweep
  // retries (at-least-once for a broken-pipeline alert).
  await _setSystemSetting(SETTING_GOING_QUIET_FEED_STALE_ALERT_ACTIVE, "1");
  return { notified: true };
}

/**
 * Called by the sweep on every healthy run; no-ops unless a stale streak
 * was active. Clears the streak gate and re-arms the dispatcher so the
 * NEXT gap alerts immediately.
 */
export async function onGoingQuietFeedRecovered(): Promise<void> {
  try {
    const row = await _getSystemSetting(SETTING_GOING_QUIET_FEED_STALE_ALERT_ACTIVE);
    if (row?.value !== "1") return;
    await _setSystemSetting(SETTING_GOING_QUIET_FEED_STALE_ALERT_ACTIVE, "");
    await _markRecovered(GOING_QUIET_FEED_STALE_NOTIFICATION_ID, "global");
    console.log("[GoingQuietAlert] feed recovered — stale-streak alert re-armed");
  } catch (err: any) {
    console.warn(
      `[GoingQuietAlert] feed-recovered re-arm failed: ${err?.message ?? err}`,
    );
  }
}

// ── Test injection (ESM live-binding workaround) ────────────────────────────

export function __setGoingQuietAlertDepsForTest(deps: {
  notifyByType?: typeof notifyByType;
  markRecovered?: typeof markRecovered;
  notifyUser?: typeof notifyUser;
  getDirectorPlusUserIds?: typeof getDirectorPlusUserIds;
  getSystemSetting?: typeof getSystemSetting;
  setSystemSetting?: typeof setSystemSetting;
}): void {
  if (deps.notifyByType) _notifyByType = deps.notifyByType;
  if (deps.markRecovered) _markRecovered = deps.markRecovered;
  if (deps.notifyUser) _notifyUser = deps.notifyUser;
  if (deps.getDirectorPlusUserIds) _getDirectorPlusUserIds = deps.getDirectorPlusUserIds;
  if (deps.getSystemSetting) _getSystemSetting = deps.getSystemSetting;
  if (deps.setSystemSetting) _setSystemSetting = deps.setSystemSetting;
}

export function __resetGoingQuietAlertDepsForTest(): void {
  _notifyByType = notifyByType;
  _markRecovered = markRecovered;
  _notifyUser = notifyUser;
  _getDirectorPlusUserIds = getDirectorPlusUserIds;
  _getSystemSetting = getSystemSetting;
  _setSystemSetting = setSystemSetting;
}
