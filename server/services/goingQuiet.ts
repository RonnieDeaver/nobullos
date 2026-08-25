// @db-pool-intent: worker
//
// Task #3695 — Going-quiet client detector.
//
// Computes a daily engagement snapshot for every active client from
// `raw_communication_records` (Front email, Zoom, SMS/calls, Slack, manual
// notes) plus `clients.last_viewed_at`, compares recent inbound volume
// against the client's OWN trailing baseline, and rolls the signals into a
// 0–100 quiet score with a flagged/not-flagged state and human-readable
// reasons. Snapshots persist to `client_engagement_snapshots`
// (shared/models/engagement.ts); the flag transition between consecutive
// snapshots drives the once-per-quiet-streak notification in
// `goingQuietAlert.ts` (re-armed on re-engagement).
//
// Pool intent: the sweep entry point wraps everything in
// `runWithWorkerDb(...)` (background pool) — it runs from the daily
// judgment scheduler, never from a request handler. `getDb()` is used
// (instead of a hard `workerDb` import) so tests can pin the isolated
// sandbox / run the compute helpers directly on the API pool.
//
// Scoring model (deterministic, no AI):
//   - Recent window  = last 14 days   (RECENT_WINDOW_DAYS)
//   - Baseline window = the 84 days before the recent window
//     (BASELINE_WINDOW_DAYS), pro-rated when the client's history starts
//     inside it so the baseline is the client's true own weekly rate.
//   - Flag rules (tunable via system_settings, defaults below):
//       drop rule    — recent weekly inbound dropped ≥ dropThresholdPct %
//                      vs baseline (baseline must be ≥ minBaselineWeekly
//                      msgs/week to be meaningful)
//       silence rule — no inbound message for ≥ silenceDays days
//   - Clients with insufficient history (fewer than minHistoryDays days
//     since their first record, or no inbound ever) get a snapshot marked
//     `insufficientHistory` and are NEVER flagged. Archived/demo clients
//     get no snapshot at all (storage.getActiveClients excludes them).

import { sql } from "drizzle-orm";
import { getDb, runWithWorkerDb, withDbAttribution } from "../db";
import { clientEngagementSnapshots, type ClientEngagementSnapshot } from "@shared/schema";
import { storage } from "../storage";
import {
  notifyClientGoingQuiet,
  onClientReengaged,
  notifyGoingQuietFeedStale,
  onGoingQuietFeedRecovered,
} from "./goingQuietAlert";

// ── Windows (days) ──────────────────────────────────────────────────────────

export const RECENT_WINDOW_DAYS = 14;
export const BASELINE_WINDOW_DAYS = 84; // 12 weeks preceding the recent window

const MS_PER_DAY = 86_400_000;

// ── Tunable settings ────────────────────────────────────────────────────────

export interface GoingQuietSettings {
  /** Flag when recent weekly inbound dropped at least this % vs baseline. */
  dropThresholdPct: number;
  /** Flag when the client has sent nothing inbound for this many days. */
  silenceDays: number;
  /** Minimum days since the client's first communication record. */
  minHistoryDays: number;
  /** Baseline weekly inbound must be at least this for the drop rule. */
  minBaselineWeekly: number;
}

export const GOING_QUIET_DEFAULTS: GoingQuietSettings = {
  dropThresholdPct: 60,
  silenceDays: 21,
  minHistoryDays: 60,
  minBaselineWeekly: 0.5,
};

export const GOING_QUIET_SETTING_KEYS = {
  dropThresholdPct: "going_quiet_drop_threshold_pct",
  silenceDays: "going_quiet_silence_days",
  minHistoryDays: "going_quiet_min_history_days",
  minBaselineWeekly: "going_quiet_min_baseline_weekly",
} as const;

/** Read the tunable thresholds from system_settings, falling back to the
 *  defaults for missing/malformed values (a bad row must never break the
 *  sweep or silently zero a threshold). */
export async function loadGoingQuietSettings(): Promise<GoingQuietSettings> {
  const out: GoingQuietSettings = { ...GOING_QUIET_DEFAULTS };
  for (const key of Object.keys(GOING_QUIET_SETTING_KEYS) as Array<keyof GoingQuietSettings>) {
    try {
      const row = await storage.getSystemSetting(GOING_QUIET_SETTING_KEYS[key]);
      if (row?.value !== undefined && row?.value !== null && row.value !== "") {
        const parsed = Number(row.value);
        if (Number.isFinite(parsed) && parsed > 0) out[key] = parsed;
      }
    } catch (err: any) {
      console.warn(
        `[GoingQuiet] failed reading setting ${GOING_QUIET_SETTING_KEYS[key]}; using default: ${err?.message ?? err}`,
      );
    }
  }
  return out;
}

// ── Task #3889 — fleet-wide feed-freshness guard ────────────────────────────
//
// The detector counts inbound strictly from `raw_communication_records`, so
// when the Front ingestion pipeline stalls (dead token, stopped backfill
// drivers) EVERY client's inbound collapses to zero at once and the sweep
// happily reports mass client silence (the Aug 2026 incident: 54/56 flagged
// with a uniform late-June cliff). The guard cross-checks the newest
// ingested Front inbound row against Front's own conversation tracker
// (`front_sync_emails`, fed by the reconciliation poller — historically the
// most durable feed we have). When Front says clients are active but no
// inbound rows are landing, the feed is stale: snapshots are persisted as
// data-gap rows with flags forced off, per-client notifications are
// suppressed, and ONE admin pipeline alert fires per stale streak.

export const GOING_QUIET_FEED_SETTING_KEYS = {
  /** Feed is stale when newest ingested inbound lags Front activity by more days than this. */
  staleAfterDays: "going_quiet_feed_stale_after_days",
  /** Require at least this many Front-active conversations in the recent
   *  window before declaring a gap (a genuinely quiet fleet — e.g. holiday
   *  week — must not trip a false pipeline alarm). */
  minRecentConvs: "going_quiet_feed_min_recent_convs",
} as const;

export const GOING_QUIET_FEED_DEFAULTS = {
  staleAfterDays: 3,
  minRecentConvs: 10,
} as const;

/** Reason string prepended to every snapshot written during a feed gap. */
export const GOING_QUIET_DATA_GAP_REASON =
  "Data gap: the communication feed is behind — inbound gaps here reflect missing ingestion, not client silence";

export interface GoingQuietFeedFreshness {
  /** True = the ingestion feed is behind Front's own activity; do not trust inbound zeros. */
  stale: boolean;
  /** Newest ingested inbound Front row (any client), null when none exist. */
  newestInboundAt: Date | null;
  /** Newest conversation activity Front itself reports (front_sync_emails). */
  newestSyncActivityAt: Date | null;
  /** Conversations with Front activity inside the recent window. */
  syncActiveRecent: number;
  /** Days the ingested feed lags Front activity (null when either side is empty). */
  lagDays: number | null;
  staleAfterDays: number;
  minRecentConvs: number;
}

/**
 * Compare the ingested Front inbound feed against Front's own conversation
 * tracker. Front-only on both sides deliberately: the email feed dominates
 * inbound volume, and a live SMS trickle must not mask a dead email
 * pipeline. Tolerant of missing/malformed settings rows (defaults above).
 */
export async function measureGoingQuietFeedFreshness(
  asOf: Date = new Date(),
  attributionLabel = "worker:going-quiet:feed-freshness",
): Promise<GoingQuietFeedFreshness> {
  let staleAfterDays: number = GOING_QUIET_FEED_DEFAULTS.staleAfterDays;
  let minRecentConvs: number = GOING_QUIET_FEED_DEFAULTS.minRecentConvs;
  try {
    const row = await storage.getSystemSetting(GOING_QUIET_FEED_SETTING_KEYS.staleAfterDays);
    const parsed = Number(row?.value);
    if (row?.value && Number.isFinite(parsed) && parsed > 0) staleAfterDays = parsed;
  } catch {
    /* default stands */
  }
  try {
    const row = await storage.getSystemSetting(GOING_QUIET_FEED_SETTING_KEYS.minRecentConvs);
    const parsed = Number(row?.value);
    if (row?.value && Number.isFinite(parsed) && parsed >= 0) minRecentConvs = parsed;
  } catch {
    /* default stands */
  }

  // Tracker activity counts EITHER a fresh last_message_at (the reconciliation
  // mirror's stamp) OR a fresh created_at (the poller's discovery stamp). The
  // two are redundant while both pipelines are healthy — the redundancy is the
  // point: if the mirror path ever regresses the way the inbound feed did, the
  // discovery stamp alone still proves Front-side activity, so the guard trips
  // instead of failing open below the min-conversations floor.
  const recentStart = new Date(asOf.getTime() - RECENT_WINDOW_DAYS * MS_PER_DAY);
  const result = await withDbAttribution(attributionLabel, () =>
    getDb().execute(sql`
      SELECT
        (SELECT MAX(timestamp) FROM raw_communication_records
          WHERE direction = 'inbound' AND source_type = 'front_email'
            AND timestamp < ${asOf}
            AND (match_status IS NULL OR match_status <> 'orphaned')) AS newest_inbound_at,
        (SELECT GREATEST(
          (SELECT MAX(last_message_at) FROM front_sync_emails
            WHERE last_message_at < ${asOf}),
          (SELECT MAX(created_at) FROM front_sync_emails
            WHERE created_at < ${asOf})))                             AS newest_sync_at,
        (SELECT COUNT(*)::int FROM front_sync_emails
          WHERE (last_message_at >= ${recentStart} AND last_message_at < ${asOf})
             OR (created_at >= ${recentStart} AND created_at < ${asOf})) AS sync_active_recent
    `),
  );
  const row: any = (result as any).rows?.[0] ?? {};
  const toDate = (v: unknown): Date | null => {
    if (!v) return null;
    const d = new Date(v as any);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const newestInboundAt = toDate(row.newest_inbound_at);
  const newestSyncActivityAt = toDate(row.newest_sync_at);
  const syncActiveRecent = Number(row.sync_active_recent ?? 0);

  const lagDays =
    newestSyncActivityAt !== null && newestInboundAt !== null
      ? round1((newestSyncActivityAt.getTime() - newestInboundAt.getTime()) / MS_PER_DAY)
      : null;
  const stale =
    syncActiveRecent >= minRecentConvs &&
    newestSyncActivityAt !== null &&
    (newestInboundAt === null || (lagDays !== null && lagDays > staleAfterDays));

  return {
    stale,
    newestInboundAt,
    newestSyncActivityAt,
    syncActiveRecent,
    lagDays,
    staleAfterDays,
    minRecentConvs,
  };
}

// ── Raw engagement metrics (DB extraction) ──────────────────────────────────

export interface EngagementMetrics {
  inboundRecent: number;
  outboundRecent: number;
  inbound30d: number;
  outbound30d: number;
  /** Inbound count inside the baseline window (before the recent window). */
  inboundBaseline: number;
  lastInboundAt: Date | null;
  lastCallMeetingAt: Date | null;
  firstCommAt: Date | null;
  lastViewedAt: Date | null;
  asOf: Date;
}

/**
 * One aggregate pass over the client's communication records. Orphaned
 * records (client deleted → evidence preserved) are excluded, mirroring the
 * daily judgment's defense-in-depth filter. Calls/meetings = `zoom` +
 * `twilio_call` source types, either direction (a live conversation is a
 * live conversation).
 */
export async function fetchEngagementMetrics(
  client: { id: string; lastViewedAt?: Date | string | null },
  asOf: Date,
): Promise<EngagementMetrics> {
  const recentStart = new Date(asOf.getTime() - RECENT_WINDOW_DAYS * MS_PER_DAY);
  const thirtyStart = new Date(asOf.getTime() - 30 * MS_PER_DAY);
  const baselineStart = new Date(
    asOf.getTime() - (RECENT_WINDOW_DAYS + BASELINE_WINDOW_DAYS) * MS_PER_DAY,
  );

  const result = await withDbAttribution("worker:going-quiet:metrics", () =>
    getDb().execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE direction = 'inbound'  AND timestamp >= ${recentStart} AND timestamp < ${asOf})::int  AS inbound_recent,
        COUNT(*) FILTER (WHERE direction = 'outbound' AND timestamp >= ${recentStart} AND timestamp < ${asOf})::int  AS outbound_recent,
        COUNT(*) FILTER (WHERE direction = 'inbound'  AND timestamp >= ${thirtyStart} AND timestamp < ${asOf})::int  AS inbound_30d,
        COUNT(*) FILTER (WHERE direction = 'outbound' AND timestamp >= ${thirtyStart} AND timestamp < ${asOf})::int  AS outbound_30d,
        COUNT(*) FILTER (WHERE direction = 'inbound'  AND timestamp >= ${baselineStart} AND timestamp < ${recentStart})::int AS inbound_baseline,
        MAX(timestamp) FILTER (WHERE direction = 'inbound' AND timestamp < ${asOf})                        AS last_inbound_at,
        MAX(timestamp) FILTER (WHERE source_type IN ('zoom', 'twilio_call') AND timestamp < ${asOf})       AS last_call_meeting_at,
        MIN(timestamp) FILTER (WHERE timestamp < ${asOf})                                                  AS first_comm_at
      FROM raw_communication_records
      WHERE client_id = ${client.id}
        AND (match_status IS NULL OR match_status <> 'orphaned')
    `),
  );

  const row: any = (result as any).rows?.[0] ?? {};
  const toDate = (v: unknown): Date | null => {
    if (!v) return null;
    const d = new Date(v as any);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  return {
    inboundRecent: Number(row.inbound_recent ?? 0),
    outboundRecent: Number(row.outbound_recent ?? 0),
    inbound30d: Number(row.inbound_30d ?? 0),
    outbound30d: Number(row.outbound_30d ?? 0),
    inboundBaseline: Number(row.inbound_baseline ?? 0),
    lastInboundAt: toDate(row.last_inbound_at),
    lastCallMeetingAt: toDate(row.last_call_meeting_at),
    firstCommAt: toDate(row.first_comm_at),
    lastViewedAt: toDate(client.lastViewedAt ?? null),
    asOf,
  };
}

// ── Pure scoring (unit-testable without a DB) ───────────────────────────────

export interface EngagementScore {
  inboundRecent: number;
  outboundRecent: number;
  inbound30d: number;
  outbound30d: number;
  baselineWeeklyInbound: number | null;
  recentWeeklyInbound: number;
  dropPct: number | null;
  daysSinceLastInbound: number | null;
  daysSinceLastCallMeeting: number | null;
  daysSinceLastViewed: number | null;
  historyDays: number | null;
  quietScore: number;
  isFlagged: boolean;
  insufficientHistory: boolean;
  reasons: string[];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * Deterministic roll-up of raw metrics into baseline comparison, quiet
 * score, flag state, and reasons. Pure — all judgment-call arithmetic for
 * the detector lives here so tests can pin it exactly.
 */
export function scoreEngagement(
  metrics: EngagementMetrics,
  settings: GoingQuietSettings = GOING_QUIET_DEFAULTS,
): EngagementScore {
  const { asOf } = metrics;
  const daysSince = (d: Date | null): number | null =>
    d === null ? null : Math.floor((asOf.getTime() - d.getTime()) / MS_PER_DAY);

  const historyDays = daysSince(metrics.firstCommAt);
  const daysSinceLastInbound = daysSince(metrics.lastInboundAt);
  const daysSinceLastCallMeeting = daysSince(metrics.lastCallMeetingAt);
  const daysSinceLastViewed = daysSince(metrics.lastViewedAt);

  const recentWeeklyInbound = round2(metrics.inboundRecent / (RECENT_WINDOW_DAYS / 7));

  // Baseline = the client's own trailing rate. When the client's history
  // begins inside the baseline window, pro-rate over the covered span so a
  // young-but-sufficient client's rate isn't diluted by empty weeks they
  // weren't a client for. Coverage below one week → no meaningful baseline.
  let baselineWeeklyInbound: number | null = null;
  if (metrics.firstCommAt !== null && historyDays !== null) {
    const coveredDays = Math.min(
      BASELINE_WINDOW_DAYS,
      Math.max(0, historyDays - RECENT_WINDOW_DAYS),
    );
    if (coveredDays >= 7) {
      baselineWeeklyInbound = round2(metrics.inboundBaseline / (coveredDays / 7));
    }
  }

  const dropPct =
    baselineWeeklyInbound !== null && baselineWeeklyInbound > 0
      ? round1((1 - recentWeeklyInbound / baselineWeeklyInbound) * 100)
      : null;

  // ── Insufficient history — snapshot, but never flag ──
  const reasons: string[] = [];
  let insufficientHistory = false;
  if (metrics.firstCommAt === null) {
    insufficientHistory = true;
    reasons.push("No communication history on record");
  } else if (historyDays !== null && historyDays < settings.minHistoryDays) {
    insufficientHistory = true;
    reasons.push(
      `Only ${historyDays} days of communication history (need ${settings.minHistoryDays})`,
    );
  } else if (metrics.lastInboundAt === null) {
    insufficientHistory = true;
    reasons.push("No inbound communication from this client on record");
  }

  // ── Flag rules ──
  let isFlagged = false;
  if (!insufficientHistory) {
    const dropRule =
      dropPct !== null &&
      baselineWeeklyInbound !== null &&
      baselineWeeklyInbound >= settings.minBaselineWeekly &&
      dropPct >= settings.dropThresholdPct;
    const silenceRule =
      daysSinceLastInbound !== null && daysSinceLastInbound >= settings.silenceDays;

    if (dropRule) {
      reasons.push(
        `Inbound volume down ${Math.round(dropPct!)}% vs baseline ` +
          `(${recentWeeklyInbound.toFixed(1)}/wk now vs ${baselineWeeklyInbound!.toFixed(1)}/wk)`,
      );
    }
    if (silenceRule) {
      reasons.push(
        `No inbound message in ${daysSinceLastInbound} days (threshold ${settings.silenceDays})`,
      );
    }
    isFlagged = dropRule || silenceRule;

    // Context reasons — only attached to flagged snapshots so the row
    // explains itself; they never flag on their own.
    if (isFlagged) {
      if (daysSinceLastCallMeeting === null) {
        reasons.push("No call or meeting on record");
      } else if (daysSinceLastCallMeeting >= 30) {
        reasons.push(`No call or meeting in ${daysSinceLastCallMeeting} days`);
      }
      if (daysSinceLastViewed === null) {
        reasons.push("No client report/dashboard views on record");
      } else if (daysSinceLastViewed >= 30) {
        reasons.push(`Client reports/dashboard not viewed in ${daysSinceLastViewed} days`);
      }
    }
  }

  // ── Quiet score (0–100, ranking severity) ──
  //   drop vs own baseline …… 0–45
  //   inbound silence ………… 0–35 (saturates at 2× silenceDays)
  //   call/meeting recency … 0–10 (saturates at 90d; never = 6)
  //   viewing recency ……… 0–10 (saturates at 60d; never = 6)
  const dropComponent =
    dropPct !== null &&
    baselineWeeklyInbound !== null &&
    baselineWeeklyInbound >= settings.minBaselineWeekly
      ? 45 * clamp01(dropPct / 100)
      : 0;
  const silenceComponent =
    daysSinceLastInbound !== null
      ? 35 * clamp01(daysSinceLastInbound / (2 * settings.silenceDays))
      : 0;
  const callComponent =
    daysSinceLastCallMeeting === null ? 6 : 10 * clamp01(daysSinceLastCallMeeting / 90);
  const viewedComponent =
    daysSinceLastViewed === null ? 6 : 10 * clamp01(daysSinceLastViewed / 60);
  const quietScore = round1(
    dropComponent + silenceComponent + callComponent + viewedComponent,
  );

  return {
    inboundRecent: metrics.inboundRecent,
    outboundRecent: metrics.outboundRecent,
    inbound30d: metrics.inbound30d,
    outbound30d: metrics.outbound30d,
    baselineWeeklyInbound,
    recentWeeklyInbound,
    dropPct,
    daysSinceLastInbound,
    daysSinceLastCallMeeting,
    daysSinceLastViewed,
    historyDays,
    quietScore,
    isFlagged,
    insufficientHistory,
    reasons,
  };
}

/** Metrics + scoring in one call (the per-client unit the sweep runs). */
export async function computeEngagementSnapshot(
  client: { id: string; lastViewedAt?: Date | string | null },
  asOf: Date,
  settings: GoingQuietSettings = GOING_QUIET_DEFAULTS,
): Promise<EngagementScore> {
  const metrics = await fetchEngagementMetrics(client, asOf);
  return scoreEngagement(metrics, settings);
}

// ── Persistence ─────────────────────────────────────────────────────────────

async function getLatestSnapshotBefore(
  clientId: string,
  snapshotDate: string,
): Promise<ClientEngagementSnapshot | undefined> {
  return withDbAttribution("worker:going-quiet:prev-snapshot", async () => {
    const rows = await getDb()
      .select()
      .from(clientEngagementSnapshots)
      .where(
        // Data-gap snapshots are excluded as the transition baseline: a gap
        // day must neither look like a re-engagement (flagged → gap) nor
        // re-notify an ongoing quiet streak once the feed recovers
        // (gap-unflagged → flagged would re-fire without this filter).
        sql`${clientEngagementSnapshots.clientId} = ${clientId} AND ${clientEngagementSnapshots.snapshotDate} < ${snapshotDate} AND ${clientEngagementSnapshots.dataGap} = false`,
      )
      .orderBy(sql`${clientEngagementSnapshots.snapshotDate} DESC`)
      .limit(1);
    return rows[0];
  });
}

async function upsertSnapshot(
  clientId: string,
  snapshotDate: string,
  score: EngagementScore,
  dataGap: boolean,
): Promise<void> {
  await withDbAttribution("worker:going-quiet:upsert", () =>
    getDb()
      .insert(clientEngagementSnapshots)
      .values({
        clientId,
        snapshotDate,
        dataGap,
        inboundRecent: score.inboundRecent,
        outboundRecent: score.outboundRecent,
        inbound30d: score.inbound30d,
        outbound30d: score.outbound30d,
        baselineWeeklyInbound: score.baselineWeeklyInbound,
        recentWeeklyInbound: score.recentWeeklyInbound,
        dropPct: score.dropPct,
        daysSinceLastInbound: score.daysSinceLastInbound,
        daysSinceLastCallMeeting: score.daysSinceLastCallMeeting,
        daysSinceLastViewed: score.daysSinceLastViewed,
        historyDays: score.historyDays,
        quietScore: score.quietScore,
        isFlagged: score.isFlagged,
        insufficientHistory: score.insufficientHistory,
        reasonsJson: score.reasons,
      })
      .onConflictDoUpdate({
        target: [clientEngagementSnapshots.clientId, clientEngagementSnapshots.snapshotDate],
        set: {
          dataGap,
          inboundRecent: score.inboundRecent,
          outboundRecent: score.outboundRecent,
          inbound30d: score.inbound30d,
          outbound30d: score.outbound30d,
          baselineWeeklyInbound: score.baselineWeeklyInbound,
          recentWeeklyInbound: score.recentWeeklyInbound,
          dropPct: score.dropPct,
          daysSinceLastInbound: score.daysSinceLastInbound,
          daysSinceLastCallMeeting: score.daysSinceLastCallMeeting,
          daysSinceLastViewed: score.daysSinceLastViewed,
          historyDays: score.historyDays,
          quietScore: score.quietScore,
          isFlagged: score.isFlagged,
          insufficientHistory: score.insufficientHistory,
          reasonsJson: score.reasons,
          updatedAt: new Date(),
        },
      }),
  );
}

// ── Daily sweep ─────────────────────────────────────────────────────────────

export interface GoingQuietSweepResult {
  snapshotDate: string;
  processed: number;
  flagged: number;
  newlyFlagged: number;
  reengaged: number;
  insufficient: number;
  errors: number;
  /** Task #3889 — true when the feed-freshness guard suppressed flagging. */
  dataGap: boolean;
  /** Flags that WOULD have fired but were suppressed by the data-gap guard. */
  suppressedFlags: number;
  /** The freshness measurement backing dataGap (null if the probe failed). */
  feed: GoingQuietFeedFreshness | null;
}

export interface GoingQuietSweepOptions {
  /** Override "now" (tests / manual re-runs). */
  asOf?: Date;
  /** Override thresholds (tests). Defaults to loadGoingQuietSettings(). */
  settings?: GoingQuietSettings;
  /**
   * Restrict the sweep to these client ids (tests seed their own clients on
   * the shared dev DB and must never touch — or notify about — real ones).
   */
  restrictToClientIds?: string[];
}

/**
 * The daily pass: snapshot every active client (archived/demo excluded by
 * storage.getActiveClients), then fire the once-per-streak notification on
 * a not-flagged → flagged transition and re-arm on flagged → not-flagged.
 * Runs on the worker pool; call sites hold the cross-instance singleton
 * lock (daily judgment scheduler), so this function does not re-lock.
 */
export async function runGoingQuietSweep(
  options: GoingQuietSweepOptions = {},
): Promise<GoingQuietSweepResult> {
  return runWithWorkerDb(() =>
    withDbAttribution("worker:going-quiet-sweep", () => runSweepInner(options)),
  );
}

async function runSweepInner(
  options: GoingQuietSweepOptions,
): Promise<GoingQuietSweepResult> {
  const asOf = options.asOf ?? new Date();
  const snapshotDate = asOf.toISOString().split("T")[0];
  const settings = options.settings ?? (await loadGoingQuietSettings());

  let clients = await storage.getActiveClients();
  if (options.restrictToClientIds) {
    const allowed = new Set(options.restrictToClientIds);
    clients = clients.filter((c) => allowed.has(c.id));
  }

  const result: GoingQuietSweepResult = {
    snapshotDate,
    processed: 0,
    flagged: 0,
    newlyFlagged: 0,
    reengaged: 0,
    insufficient: 0,
    errors: 0,
    dataGap: false,
    suppressedFlags: 0,
    feed: null,
  };

  // Task #3889 — feed-freshness guard. A probe FAILURE is logged but the
  // sweep proceeds as healthy: the guard exists to stop a stale feed from
  // flagging the fleet, and a broken probe must not disable the detector
  // itself (legacy behavior is the fallback).
  let feed: GoingQuietFeedFreshness | null = null;
  try {
    feed = await measureGoingQuietFeedFreshness(asOf);
  } catch (err: any) {
    console.error(
      `[GoingQuiet] feed-freshness probe failed (sweep proceeds as healthy): ${err?.message ?? err}`,
    );
  }
  const feedStale = feed?.stale === true;
  result.dataGap = feedStale;
  result.feed = feed;
  if (feedStale) {
    console.warn(
      `[GoingQuiet] feed is STALE (newest inbound ${feed?.newestInboundAt?.toISOString() ?? "none"}, ` +
        `Front activity through ${feed?.newestSyncActivityAt?.toISOString() ?? "none"}, ` +
        `lag ${feed?.lagDays ?? "n/a"}d) — persisting data-gap snapshots, suppressing flags + notifications`,
    );
  }

  for (const client of clients) {
    try {
      let score = await computeEngagementSnapshot(client, asOf, settings);
      if (feedStale) {
        // Data gap: the inbound zeros are (probably) ingestion loss, not
        // client silence. Persist the snapshot for continuity but force
        // the flag off and label the row so the UI can show provenance.
        if (score.isFlagged) result.suppressedFlags += 1;
        score = {
          ...score,
          isFlagged: false,
          reasons: [GOING_QUIET_DATA_GAP_REASON, ...score.reasons],
        };
      }
      const prev = await getLatestSnapshotBefore(client.id, snapshotDate);
      await upsertSnapshot(client.id, snapshotDate, score, feedStale);

      result.processed += 1;
      if (score.insufficientHistory) result.insufficient += 1;
      if (score.isFlagged) result.flagged += 1;

      if (feedStale) continue; // no transitions, no per-client notifications

      const prevFlagged = prev?.isFlagged ?? false;
      if (score.isFlagged && !prevFlagged) {
        // Newly flagged — exactly once per quiet streak (the previous
        // snapshot is durable state, so restarts/instances can't re-fire).
        result.newlyFlagged += 1;
        try {
          await notifyClientGoingQuiet({
            clientId: client.id,
            firmName: (client as any).firmName ?? client.id,
            ownerId: (client as any).ownerId ?? null,
            snapshotDate,
            quietScore: score.quietScore,
            dropPct: score.dropPct,
            daysSinceLastInbound: score.daysSinceLastInbound,
            reasons: score.reasons,
          });
        } catch (err: any) {
          console.error(
            `[GoingQuiet] notification failed for client ${client.id}: ${err?.message ?? err}`,
          );
        }
      } else if (!score.isFlagged && prevFlagged) {
        // Re-engaged — re-arm the alert for the next streak.
        result.reengaged += 1;
        try {
          await onClientReengaged(client.id);
        } catch (err: any) {
          console.error(
            `[GoingQuiet] recovery re-arm failed for client ${client.id}: ${err?.message ?? err}`,
          );
        }
      }
    } catch (err: any) {
      result.errors += 1;
      console.error(
        `[GoingQuiet] snapshot failed for client ${client.id}: ${err?.message ?? err}`,
      );
    }
  }

  // Task #3889 — ONE admin pipeline alert per stale streak (instead of the
  // suppressed per-client fanout), re-armed when a later sweep sees the
  // feed healthy again. Never lets alerting break the sweep.
  try {
    if (feedStale && feed) {
      await notifyGoingQuietFeedStale({
        snapshotDate,
        newestInboundAt: feed.newestInboundAt,
        newestSyncActivityAt: feed.newestSyncActivityAt,
        syncActiveRecent: feed.syncActiveRecent,
        lagDays: feed.lagDays,
        processed: result.processed,
        suppressedFlags: result.suppressedFlags,
      });
    } else if (feed && !feedStale) {
      await onGoingQuietFeedRecovered();
    }
  } catch (err: any) {
    console.error(
      `[GoingQuiet] feed-stale pipeline alert handling failed: ${err?.message ?? err}`,
    );
  }

  return result;
}
