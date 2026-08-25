// @db-pool-intent: worker
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  import { storage } from "../storage";
import { getDb, withDbAttribution } from "../db";
import { agentMatchDecisions, agentMatchSettingHistory, systemSettings, rawCommunicationRecords, communicationClientLinks, dismissReasons, type DismissReason, type RawCommunicationRecord } from "@shared/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getMatchSettingValue } from "./matchSettings";

export type ReviewCandidate = {
  clientId: string;
  firmName?: string;
  confidenceScore: number;
  matchedOn?: string;
  explanationSummary?: string | null;
  evidenceType?: string;
  supportingSignals?: unknown;
};

export interface RecordZoomReviewDecisionInput {
  communicationId: string;
  communicationType: string;
  /**
   * Task #995: null when there is no deterministic candidate to suggest. The
   * Review Queue UI requires the operator to pick a client before approving
   * such rows.
   */
  suggestedClientId: string | null;
  confidenceScore: number;
  explanationSummary: string;
  reviewReason: string;
  candidateShortlist: ReviewCandidate[];
  supportingSignals?: unknown;
  evidenceType?: string;
  priorClientId?: string | null;
}

/**
 * Task #995: structured review reason for Zoom recordings that produced no
 * deterministic candidate at all (no participant, content, or booking match).
 * Operators triage these with a client picker in the Review Queue UI.
 */
export const NO_CANDIDATE_REVIEW_REASON = "no_deterministic_booking_match";

/**
 * Records a `review_required` decision row for a Zoom communication that was
 * demoted by the deterministic short-circuit guards (412B). Idempotent: if a
 * decision already exists for (communicationId, suggestedClientId), updates it
 * to status=review_required while preserving any existing review resolution.
 *
 * Task #995: when `suggestedClientId` is null the dedupe lookup keys on
 * (communicationId, client_id IS NULL) so concurrent ingestion paths collapse
 * to a single no-candidate row (also enforced by the partial unique index in
 * migration 0046).
 */
export async function recordZoomReviewDecision(input: RecordZoomReviewDecisionInput) {
  const existing = await getDb().select().from(agentMatchDecisions).where(
    and(
      eq(agentMatchDecisions.communicationId, input.communicationId),
      input.suggestedClientId === null
        ? sql`${agentMatchDecisions.clientId} IS NULL`
        : eq(agentMatchDecisions.clientId, input.suggestedClientId),
    ),
  );

  if (existing.length > 0) {
    const row = existing[0];
    if (row.reviewResolution) return row;
    const [updated] = await getDb().update(agentMatchDecisions)
      .set({
        status: "review_required",
        sourceType: "zoom",
        explanationSummary: input.explanationSummary,
        supportingSignalsJson: input.supportingSignals ?? row.supportingSignalsJson,
        evidenceType: input.evidenceType ?? row.evidenceType,
        candidateShortlistJson: input.candidateShortlist,
        priorClientId: input.priorClientId ?? row.priorClientId ?? null,
        reviewReason: input.reviewReason,
        confidenceScore: input.confidenceScore,
      })
      .where(eq(agentMatchDecisions.id, row.id))
      .returning();
    return updated;
  }

  return storage.createAgentMatchDecision({
    communicationId: input.communicationId,
    communicationType: input.communicationType,
    sourceType: "zoom",
    clientId: input.suggestedClientId,
    confidenceScore: input.confidenceScore,
    status: "review_required",
    explanationSummary: input.explanationSummary,
    supportingSignalsJson: input.supportingSignals ?? null,
    semanticReasoningSummary: null,
    evidenceType: input.evidenceType || "structured",
    candidateShortlistJson: input.candidateShortlist,
    priorClientId: input.priorClientId ?? null,
    reviewReason: input.reviewReason,
    reviewedByHuman: false,
    correctedByHuman: false,
  });
}

export type ZoomReviewListItem = {
  decision: typeof agentMatchDecisions.$inferSelect;
  rawRecord: typeof rawCommunicationRecords.$inferSelect | null;
  suggestedClientName: string | null;
  priorClientName: string | null;
  reopenedByUserName: string | null;
  reopenedByUserEmail: string | null;
};

export type ZoomReviewSource = "all" | "backfill" | "live";

export async function listZoomReviewQueue(opts: {
  limit?: number;
  includeResolved?: boolean;
  windowDays?: number;
  source?: ZoomReviewSource;
  dismissReason?: string;
  /**
   * #734: filter the queue to a specific resolution outcome. "reopened" maps
   * to `reopenCount > 0` rather than a value of `reviewResolution` (since a
   * re-opened decision has its `reviewResolution` cleared back to NULL).
   * Setting any value here implies includeResolved=true: callers asking for
   * "approved" calls do not also need to flip the includeResolved switch.
   */
  reviewResolution?: "approved" | "reassigned" | "dismissed" | "reopened";
} = {}): Promise<ZoomReviewListItem[]> {
  const since = opts.windowDays && opts.windowDays > 0
    ? new Date(Date.now() - opts.windowDays * 24 * 60 * 60 * 1000)
    : undefined;
  const source: ZoomReviewSource = opts.source || "all";
  const { BACKFILL_EXPLANATION_PREFIX } = await import("./zoomReviewQueueBackfill");
  // Migration 0023 normalized legacy "Backfill: historical Zoom reprocess ..."
  // summaries to the new "[backfill]" prefix, so we only need one pattern now.
  const backfillPatterns = [`${BACKFILL_EXPLANATION_PREFIX}%`];
  // Filtering by dismissReason implies we are looking at dismissed (resolved)
  // rows, so force-include resolved items even if the caller forgot to.
  const filterByDismiss = !!opts.dismissReason;
  // #734: a specific reviewResolution filter likewise implies resolved rows.
  // "reopened" is special: a re-opened decision has reviewResolution cleared
  // back to NULL, so we look at reopenCount > 0 instead. Re-opened rows are
  // unresolved by definition, so we leave unresolvedOnly=true for that case.
  const filterReopened = opts.reviewResolution === "reopened";
  const filterByResolution =
    !!opts.reviewResolution && opts.reviewResolution !== "reopened";
  const includeResolved =
    !!opts.includeResolved || filterByDismiss || filterByResolution;
  const decisions = await storage.listAgentMatchDecisions({
    sourceType: "zoom",
    status: "review_required",
    unresolvedOnly: filterReopened ? true : !includeResolved,
    reviewResolution: filterByDismiss
      ? "dismissed"
      : filterByResolution
        ? opts.reviewResolution
        : undefined,
    reopenedOnly: filterReopened ? true : undefined,
    dismissReason: filterByDismiss ? opts.dismissReason : undefined,
    since,
    limit: opts.limit || 100,
    explanationSummaryLikeAny: source === "backfill" ? backfillPatterns : undefined,
    explanationSummaryNotLikeAny: source === "live" ? backfillPatterns : undefined,
  });

  const out: ZoomReviewListItem[] = [];
  for (const decision of decisions) {
    let raw: typeof rawCommunicationRecords.$inferSelect | null = null;
    try {
      const { findRawCommunicationByExternalSourceId } = await import("../storage/communicationStorage");
      raw = (await findRawCommunicationByExternalSourceId(decision.communicationId)) || null;
      if (!raw) {
        const direct = await storage.getRawCommunication(decision.communicationId);
        if (direct) raw = direct;
      }
    } catch (err) {
      console.error("[ZoomReview] raw record lookup failed:", err);
    }

    let suggestedClientName: string | null = null;
    let priorClientName: string | null = null;
    try {
      if (decision.clientId) {
        const c = await storage.getClient(decision.clientId);
        suggestedClientName = c?.firmName || null;
      }
      if (decision.priorClientId) {
        const pc = await storage.getClient(decision.priorClientId);
        priorClientName = pc?.firmName || null;
      }
    } catch (err) {
      console.error("[ZoomReview] client name lookup failed:", err);
    }

    let reopenedByUserName: string | null = null;
    let reopenedByUserEmail: string | null = null;
    if (decision.reopenedByUserId) {
      try {
        const u = await storage.getUser(decision.reopenedByUserId);
        if (u) {
          const full = `${u.firstName || ""} ${u.lastName || ""}`.trim();
          reopenedByUserName = full || u.email || decision.reopenedByUserId;
          reopenedByUserEmail = u.email || null;
        } else {
          reopenedByUserName = decision.reopenedByUserId;
        }
      } catch (err) {
        console.error("[ZoomReview] reopener user lookup failed:", err);
        reopenedByUserName = decision.reopenedByUserId;
      }
    }

    out.push({ decision, rawRecord: raw, suggestedClientName, priorClientName, reopenedByUserName, reopenedByUserEmail });
  }
  return out;
}

export type ZoomReviewReasonSummary = {
  windowDays: number | null;
  total: number;
  byReason: Record<string, number>;
};

/**
 * Aggregate Zoom review-queue counts grouped by `reviewReason` over the last
 * `windowDays` days. When `windowDays` is undefined or <= 0, aggregates across
 * the entire history. Counts every decision row whose source is "zoom" and
 * status is "review_required" — including resolved ones — so admins can see
 * the historical impact of guardrail thresholds even after items are cleared.
 */
export async function getZoomReviewReasonSummary(opts: {
  windowDays?: number;
} = {}): Promise<ZoomReviewReasonSummary> {
  const conds: any[] = [
    eq(agentMatchDecisions.sourceType, "zoom"),
    eq(agentMatchDecisions.status, "review_required"),
  ];
  const windowDays = opts.windowDays && opts.windowDays > 0 ? opts.windowDays : null;
  if (windowDays) {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    conds.push(sql`${agentMatchDecisions.createdAt} >= ${since}`);
  }

  const rows = await getDb()
    .select({
      reason: agentMatchDecisions.reviewReason,
      count: sql<number>`count(*)::int`,
    })
    .from(agentMatchDecisions)
    .where(and(...conds))
    .groupBy(agentMatchDecisions.reviewReason);

  const byReason: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    const key = r.reason || "unspecified";
    byReason[key] = (byReason[key] || 0) + r.count;
    total += r.count;
  }
  return { windowDays, total, byReason };
}

/**
 * Same as getZoomReviewReasonSummary but operates on an explicit [since, until)
 * date range. Used to compute "previous window" trend comparisons (e.g. the
 * 7d window immediately before the current 7d window).
 */
export async function getZoomReviewReasonSummaryForRange(opts: {
  since: Date;
  until: Date;
}): Promise<{ byReason: Record<string, number>; total: number }> {
  const conds: any[] = [
    eq(agentMatchDecisions.sourceType, "zoom"),
    eq(agentMatchDecisions.status, "review_required"),
    sql`${agentMatchDecisions.createdAt} >= ${opts.since}`,
    sql`${agentMatchDecisions.createdAt} < ${opts.until}`,
  ];

  const rows = await getDb()
    .select({
      reason: agentMatchDecisions.reviewReason,
      count: sql<number>`count(*)::int`,
    })
    .from(agentMatchDecisions)
    .where(and(...conds))
    .groupBy(agentMatchDecisions.reviewReason);

  const byReason: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    const key = r.reason || "unspecified";
    byReason[key] = (byReason[key] || 0) + r.count;
    total += r.count;
  }
  return { byReason, total };
}

/**
 * Look up the most-recent change timestamp for each given guardrail key.
 * For numeric `agent_match_settings` keys we read the most recent
 * `agent_match_setting_history` row across all scopes (default + zoom)
 * because either scope's change can shift the Zoom-effective value.
 * For the `ZOOM_COMMON_FIRST_NAMES` system_settings key we read the row's
 * `updatedAt` directly (system_settings has no separate history table).
 *
 * Returns null for keys that have never been changed.
 */
function coerceDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

export async function getZoomGuardrailKeyAnchors(opts: {
  matchSettingKeys: string[];
  systemSettingKeys?: string[];
  /**
   * Optional per-key timestamp overrides. When a key is present here, the
   * caller-supplied Date is used as the anchor verbatim (skipping the
   * `agent_match_setting_history` / `system_settings` lookup for that key).
   * This lets the guardrail-impact endpoint compute before/after deltas
   * around any historical change — not just the latest one — when the UI
   * passes a specific audit row's `changedAt`.
   */
  anchorOverrides?: Record<string, Date>;
}): Promise<Record<string, Date | null>> {
  const out: Record<string, Date | null> = {};
  for (const k of opts.matchSettingKeys) out[k] = null;
  for (const k of opts.systemSettingKeys || []) out[k] = null;

  const overrides = opts.anchorOverrides ?? {};
  const overrideKeys = new Set(Object.keys(overrides));
  for (const k of overrideKeys) out[k] = coerceDate(overrides[k]);

  const matchKeysToFetch = opts.matchSettingKeys.filter(k => !overrideKeys.has(k));
  if (matchKeysToFetch.length > 0) {
    const rows = await getDb()
      .select({
        settingKey: agentMatchSettingHistory.settingKey,
        lastChangedAt: sql<unknown>`max(${agentMatchSettingHistory.changedAt})`,
      })
      .from(agentMatchSettingHistory)
      .where(inArray(agentMatchSettingHistory.settingKey, matchKeysToFetch))
      .groupBy(agentMatchSettingHistory.settingKey);
    for (const r of rows) {
      out[r.settingKey] = coerceDate(r.lastChangedAt);
    }
  }

  const systemKeysToFetch = (opts.systemSettingKeys || []).filter(k => !overrideKeys.has(k));
  if (systemKeysToFetch.length > 0) {
    const rows = await getDb()
      .select({ key: systemSettings.key, updatedAt: systemSettings.updatedAt })
      .from(systemSettings)
      .where(inArray(systemSettings.key, systemKeysToFetch));
    for (const r of rows) {
      out[r.key] = coerceDate(r.updatedAt);
    }
  }

  return out;
}

export type ZoomDismissReasonSummary = {
  windowDays: number | null;
  total: number;
  byReason: Record<string, number>;
  recentOtherNotes: { note: string; reviewedAt: string | null }[];
};

/**
 * Aggregate dismissed Zoom review decisions grouped by `dismissReason` over the
 * last `windowDays` days (based on `reviewedAt`). When `windowDays` is undefined
 * or <= 0, aggregates across all history. Also returns the most-recent free-text
 * "other" notes (up to 5) so admins can see why catch-all dismissals happened.
 */
export async function getZoomDismissReasonSummary(opts: {
  windowDays?: number;
} = {}): Promise<ZoomDismissReasonSummary> {
  const conds: any[] = [
    eq(agentMatchDecisions.sourceType, "zoom"),
    eq(agentMatchDecisions.reviewResolution, "dismissed"),
  ];
  const windowDays = opts.windowDays && opts.windowDays > 0 ? opts.windowDays : null;
  if (windowDays) {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    conds.push(sql`${agentMatchDecisions.reviewedAt} >= ${since}`);
  }

  const rows = await getDb()
    .select({
      reason: agentMatchDecisions.dismissReason,
      count: sql<number>`count(*)::int`,
    })
    .from(agentMatchDecisions)
    .where(and(...conds))
    .groupBy(agentMatchDecisions.dismissReason);

  const byReason: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    const key = r.reason || "unspecified";
    byReason[key] = (byReason[key] || 0) + r.count;
    total += r.count;
  }

  const noteConds: any[] = [
    eq(agentMatchDecisions.sourceType, "zoom"),
    eq(agentMatchDecisions.reviewResolution, "dismissed"),
    eq(agentMatchDecisions.dismissReason, "other"),
    sql`${agentMatchDecisions.dismissReasonNote} IS NOT NULL`,
    sql`length(trim(${agentMatchDecisions.dismissReasonNote})) > 0`,
  ];
  if (windowDays) {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    noteConds.push(sql`${agentMatchDecisions.reviewedAt} >= ${since}`);
  }
  const noteRows = await getDb()
    .select({
      note: agentMatchDecisions.dismissReasonNote,
      reviewedAt: agentMatchDecisions.reviewedAt,
    })
    .from(agentMatchDecisions)
    .where(and(...noteConds))
    .orderBy(sql`${agentMatchDecisions.reviewedAt} DESC NULLS LAST`)
    .limit(5);

  const recentOtherNotes = noteRows
    .map((r) => ({
      note: (r.note || "").trim(),
      reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    }))
    .filter((r) => r.note.length > 0);

  return { windowDays, total, byReason, recentOtherNotes };
}

/**
 * Same as getZoomDismissReasonSummary but operates on an explicit [since, until)
 * date range against `reviewedAt`. Used to compute "previous window" trend
 * comparisons for the dismiss-reason breakdown card. Only returns the grouped
 * counts — recent "other" notes are not relevant for the prior-window delta.
 */
export async function getZoomDismissReasonSummaryForRange(opts: {
  since: Date;
  until: Date;
  /**
   * Restrict to a single `agent_match_decisions.source_type`. Defaults to
   * "zoom" for backward compatibility with the original Zoom-only callers.
   * Pass e.g. "front_email" or "twilio_sms" to compute the same dismiss-reason
   * delta for non-Zoom routed-to-review decisions (Task #1239).
   */
  sourceType?: string;
}): Promise<{ byReason: Record<string, number>; total: number }> {
  const conds: any[] = [
    eq(agentMatchDecisions.sourceType, opts.sourceType ?? "zoom"),
    eq(agentMatchDecisions.reviewResolution, "dismissed"),
    sql`${agentMatchDecisions.reviewedAt} >= ${opts.since}`,
    sql`${agentMatchDecisions.reviewedAt} < ${opts.until}`,
  ];

  const rows = await getDb()
    .select({
      reason: agentMatchDecisions.dismissReason,
      count: sql<number>`count(*)::int`,
    })
    .from(agentMatchDecisions)
    .where(and(...conds))
    .groupBy(agentMatchDecisions.dismissReason);

  const byReason: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    const key = r.reason || "unspecified";
    byReason[key] = (byReason[key] || 0) + r.count;
    total += r.count;
  }
  return { byReason, total };
}

export type ZoomResolutionSummaryBuckets = {
  approved: number;
  reassigned: number;
  dismissed: number;
  reopened: number;
  unresolved: number;
};

export type ZoomResolutionSummary = {
  windowDays: number | null;
  total: number;
  byResolution: ZoomResolutionSummaryBuckets;
};

/**
 * Task #1203: aggregate Zoom review-queue rows by resolution outcome over the
 * last `windowDays` days. Each bucket follows the same time-attribution rule
 * the queue UI already uses for filtering:
 *   - approved / reassigned / dismissed → `reviewedAt` in window
 *   - reopened → `reopenedAt` in window AND `reopenCount > 0`
 *   - unresolved → currently `status='review_required'` with no `reviewResolution`
 *     and `createdAt` in window
 * `total` is the sum of all five buckets. Note that "reopened" rows whose
 * resolution has been cleared back to NULL are also counted in "unresolved" if
 * they're still pending — this mirrors the existing chip filter behaviour
 * where the same row can satisfy both filters.
 */
export async function getZoomResolutionSummary(opts: {
  windowDays?: number;
} = {}): Promise<ZoomResolutionSummary> {
  const windowDays = opts.windowDays && opts.windowDays > 0 ? opts.windowDays : null;
  const since = windowDays
    ? new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
    : null;
  const buckets = await aggregateZoomResolutionBuckets({ since, until: null });
  return {
    windowDays,
    total:
      buckets.approved +
      buckets.reassigned +
      buckets.dismissed +
      buckets.reopened +
      buckets.unresolved,
    byResolution: buckets,
  };
}

/**
 * Task #1203: same as `getZoomResolutionSummary` but operates on an explicit
 * [since, until) range. Used to compute the "previous equal-length window"
 * delta shown under each resolution chip.
 */
export async function getZoomResolutionSummaryForRange(opts: {
  since: Date;
  until: Date;
}): Promise<{ byResolution: ZoomResolutionSummaryBuckets; total: number }> {
  const buckets = await aggregateZoomResolutionBuckets({
    since: opts.since,
    until: opts.until,
  });
  return {
    byResolution: buckets,
    total:
      buckets.approved +
      buckets.reassigned +
      buckets.dismissed +
      buckets.reopened +
      buckets.unresolved,
  };
}

async function aggregateZoomResolutionBuckets(opts: {
  since: Date | null;
  until: Date | null;
}): Promise<ZoomResolutionSummaryBuckets> {
  const { since, until } = opts;

  const reviewedAtConds: any[] = [eq(agentMatchDecisions.sourceType, "zoom")];
  if (since) reviewedAtConds.push(sql`${agentMatchDecisions.reviewedAt} >= ${since}`);
  if (until) reviewedAtConds.push(sql`${agentMatchDecisions.reviewedAt} < ${until}`);
  reviewedAtConds.push(
    inArray(agentMatchDecisions.reviewResolution, ["approved", "reassigned", "dismissed"]),
  );

  const resolvedRows = await getDb()
    .select({
      resolution: agentMatchDecisions.reviewResolution,
      count: sql<number>`count(*)::int`,
    })
    .from(agentMatchDecisions)
    .where(and(...reviewedAtConds))
    .groupBy(agentMatchDecisions.reviewResolution);

  const buckets: ZoomResolutionSummaryBuckets = {
    approved: 0,
    reassigned: 0,
    dismissed: 0,
    reopened: 0,
    unresolved: 0,
  };
  for (const r of resolvedRows) {
    if (r.resolution === "approved") buckets.approved += r.count;
    else if (r.resolution === "reassigned") buckets.reassigned += r.count;
    else if (r.resolution === "dismissed") buckets.dismissed += r.count;
  }

  const reopenedConds: any[] = [
    eq(agentMatchDecisions.sourceType, "zoom"),
    sql`${agentMatchDecisions.reopenCount} > 0`,
  ];
  if (since) reopenedConds.push(sql`${agentMatchDecisions.reopenedAt} >= ${since}`);
  if (until) reopenedConds.push(sql`${agentMatchDecisions.reopenedAt} < ${until}`);
  const reopenedRows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(agentMatchDecisions)
    .where(and(...reopenedConds));
  buckets.reopened = reopenedRows[0]?.count ?? 0;

  const unresolvedConds: any[] = [
    eq(agentMatchDecisions.sourceType, "zoom"),
    eq(agentMatchDecisions.status, "review_required"),
    sql`${agentMatchDecisions.reviewResolution} IS NULL`,
  ];
  if (since) unresolvedConds.push(sql`${agentMatchDecisions.createdAt} >= ${since}`);
  if (until) unresolvedConds.push(sql`${agentMatchDecisions.createdAt} < ${until}`);
  const unresolvedRows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(agentMatchDecisions)
    .where(and(...unresolvedConds));
  buckets.unresolved = unresolvedRows[0]?.count ?? 0;

  return buckets;
}

export type ZoomReviewBucket = {
  start: string;
  end: string;
  count: number;
};

export type ZoomReviewBucketsAroundAnchor = {
  anchor: string;
  windowMs: number;
  bucketCount: number;
  buckets: ZoomReviewBucket[];
  before: number;
  after: number;
  total: number;
  reason: string | null;
};

/**
 * Returns routed-to-review counts in evenly-spaced time buckets covering
 * `[anchor - windowMs, anchor + windowMs]`. The anchor sits exactly on the
 * boundary between bucket `bucketCount/2 - 1` and `bucketCount/2` so the
 * "before" and "after" halves always contain the same number of buckets.
 *
 * Used to render the small sparkline that visualizes the impact of a Zoom
 * guardrail change on the rate at which decisions get routed to review.
 * When `reason` is provided, only decisions with `reviewReason = reason` are
 * counted (e.g. `contact_name_only_weak` for the Common First Names list).
 */
export async function getZoomReviewBucketsAroundAnchor(opts: {
  anchor: Date;
  windowMs: number;
  bucketCount?: number;
  reason?: string | null;
  /**
   * Restrict to a single `agent_match_decisions.source_type`. Defaults to
   * "zoom" for backward compatibility with the original Zoom-only callers.
   * Pass e.g. "front_email" or "twilio_sms" to compute the same routed-to-review
   * sparkline for non-Zoom decision sources (Task #1239). The exported helper
   * name is kept for backward compatibility — despite the `Zoom` prefix it is
   * now source-agnostic when `sourceType` is supplied.
   */
  sourceType?: string;
}): Promise<ZoomReviewBucketsAroundAnchor> {
  const anchorMs = opts.anchor.getTime();
  const windowMs = Math.max(1, Math.floor(opts.windowMs));
  // Round to even bucket count so the anchor lands on a bucket boundary.
  const requested = Math.max(2, Math.floor(opts.bucketCount ?? 16));
  const bucketCount = requested % 2 === 0 ? requested : requested + 1;
  const totalSpanMs = windowMs * 2;
  const bucketSizeMs = Math.max(1, Math.floor(totalSpanMs / bucketCount));
  const startMs = anchorMs - windowMs;
  const endMs = startMs + bucketSizeMs * bucketCount;

  const conds: any[] = [
    eq(agentMatchDecisions.sourceType, opts.sourceType ?? "zoom"),
    eq(agentMatchDecisions.status, "review_required"),
    sql`${agentMatchDecisions.createdAt} >= ${new Date(startMs)}`,
    sql`${agentMatchDecisions.createdAt} < ${new Date(endMs)}`,
  ];
  if (opts.reason && opts.reason.length > 0) {
    conds.push(eq(agentMatchDecisions.reviewReason, opts.reason));
  }

  const rows = await getDb()
    .select({ createdAt: agentMatchDecisions.createdAt })
    .from(agentMatchDecisions)
    .where(and(...conds));

  const counts = new Array<number>(bucketCount).fill(0);
  for (const r of rows) {
    if (!r.createdAt) continue;
    const t = r.createdAt instanceof Date ? r.createdAt.getTime() : new Date(r.createdAt as any).getTime();
    if (!Number.isFinite(t)) continue;
    if (t < startMs || t >= endMs) continue;
    const idx = Math.floor((t - startMs) / bucketSizeMs);
    const safeIdx = Math.min(bucketCount - 1, Math.max(0, idx));
    counts[safeIdx] += 1;
  }

  const buckets: ZoomReviewBucket[] = counts.map((count, i) => {
    const bStart = startMs + i * bucketSizeMs;
    const bEnd = i === bucketCount - 1 ? endMs : bStart + bucketSizeMs;
    return {
      start: new Date(bStart).toISOString(),
      end: new Date(bEnd).toISOString(),
      count,
    };
  });

  let before = 0;
  let after = 0;
  for (let i = 0; i < bucketCount; i += 1) {
    if (i < bucketCount / 2) before += counts[i];
    else after += counts[i];
  }

  return {
    anchor: new Date(anchorMs).toISOString(),
    windowMs,
    bucketCount,
    buckets,
    before,
    after,
    total: before + after,
    reason: opts.reason ?? null,
  };
}

export type ZoomReviewSourceCounts = {
  backfill: number;
  live: number;
  total: number;
};

/**
 * Count how many Zoom review-required decisions came from the historical
 * backfill (task #451) vs the live reprocess pipeline. Honors the same
 * `windowDays` and `includeResolved` semantics as `listZoomReviewQueue`.
 */
export async function getZoomReviewSourceCounts(opts: {
  windowDays?: number;
  includeResolved?: boolean;
} = {}): Promise<ZoomReviewSourceCounts> {
  const { BACKFILL_EXPLANATION_PREFIX } = await import("./zoomReviewQueueBackfill");
  const conds: any[] = [
    eq(agentMatchDecisions.sourceType, "zoom"),
    eq(agentMatchDecisions.status, "review_required"),
  ];
  if (!opts.includeResolved) {
    conds.push(sql`${agentMatchDecisions.reviewResolution} IS NULL`);
  }
  if (opts.windowDays && opts.windowDays > 0) {
    const since = new Date(Date.now() - opts.windowDays * 24 * 60 * 60 * 1000);
    conds.push(sql`${agentMatchDecisions.createdAt} >= ${since}`);
  }

  const newPrefix = `${BACKFILL_EXPLANATION_PREFIX}%`;
  const [row] = await getDb()
    .select({
      total: sql<number>`count(*)::int`,
      backfill: sql<number>`count(*) filter (where ${agentMatchDecisions.explanationSummary} LIKE ${newPrefix})::int`,
    })
    .from(agentMatchDecisions)
    .where(and(...conds));

  const total = row?.total || 0;
  const backfill = row?.backfill || 0;
  return { total, backfill, live: total - backfill };
}

export type ZoomGuardrailThresholds = {
  strongSignalMinWeight: number;
  shortTokenMaxLen: number;
};

export function getZoomGuardrailThresholds(): ZoomGuardrailThresholds {
  return {
    strongSignalMinWeight: getMatchSettingValue("ZOOM_STRONG_SIGNAL_MIN_WEIGHT", "zoom"),
    shortTokenMaxLen: Math.floor(getMatchSettingValue("ZOOM_SHORT_TOKEN_MAX_LEN", "zoom")),
  };
}

async function findRawForDecision(decision: typeof agentMatchDecisions.$inferSelect) {
  const { findRawCommunicationByExternalSourceId } = await import("../storage/communicationStorage");
  let raw = await findRawCommunicationByExternalSourceId(decision.communicationId);
  if (!raw) raw = await storage.getRawCommunication(decision.communicationId);
  return raw || null;
}

/**
 * Task #4050: one Zoom meeting frequently produces MULTIPLE raw records — a
 * recording row and a transcript row sharing the same externalSourceId
 * (`zoom_meeting_<uuid>`; every Zoom create path uses that shape). Review
 * actions must stamp EVERY related row, otherwise a reviewed call keeps a
 * half-attributed sibling that never counts toward churn comms and gets
 * re-queued by the next reprocess. Returns the given record first, then any
 * siblings sharing its non-null externalSourceId.
 */
export async function findRelatedZoomRawRecords(
  record: RawCommunicationRecord,
): Promise<RawCommunicationRecord[]> {
  const externalSourceId = record.externalSourceId;
  if (!externalSourceId) return [record];
  const rows = await withDbAttribution("zoomReview:sibling-lookup", () =>
    getDb()
      .select()
      .from(rawCommunicationRecords)
      .where(
        and(
          eq(rawCommunicationRecords.sourceType, "zoom"),
          eq(rawCommunicationRecords.externalSourceId, externalSourceId),
        ),
      ),
  );
  return [record, ...rows.filter((r) => r.id !== record.id)];
}

async function findRawAndSiblingsForDecision(
  decision: typeof agentMatchDecisions.$inferSelect,
): Promise<{ primary: RawCommunicationRecord | null; all: RawCommunicationRecord[] }> {
  const primary = await findRawForDecision(decision);
  if (!primary) return { primary: null, all: [] };
  const all = await findRelatedZoomRawRecords(primary);
  return { primary, all };
}

/**
 * Approve (or reassign) a Zoom review decision. Updates raw_communication_records,
 * communication_client_links, and the decision row atomically inside a single
 * DB transaction so a partial failure cannot leave the audit trail inconsistent
 * with the attribution.
 */
export async function approveReviewDecision(opts: {
  decisionId: string;
  userId: string;
  approvedClientId?: string;
}) {
  const decision = await storage.getAgentMatchDecision(opts.decisionId);
  if (!decision) throw new Error("Decision not found");
  if (decision.status !== "review_required") throw new Error("Decision is not in review");
  if (decision.reviewResolution) throw new Error("Decision already resolved");

  // Task #995: no-candidate review rows have a null `clientId`. Approving
  // them is only possible when the operator picks a client via
  // `approvedClientId` (the Review Queue UI enforces this client-side; we
  // re-check on the server to keep the API contract honest).
  const targetClientId = opts.approvedClientId || decision.clientId;
  if (!targetClientId) {
    throw new Error("approvedClientId is required for no-candidate review decisions");
  }
  const isReassign = !!decision.clientId && targetClientId !== decision.clientId;
  const client = await storage.getClient(targetClientId);
  if (!client) throw new Error("Target client not found");

  // Task #4050: stamp every raw record of the meeting (recording + transcript
  // share one externalSourceId), not just the decision's own row.
  const { primary: raw, all: relatedRaws } = await findRawAndSiblingsForDecision(decision);

  // Stamp distinct match-method strings so audit/log surfaces can tell
  // approved vs. reassigned apart instead of flattening both to "Manual".
  // Reassign also encodes the prior client id so admins can see what changed.
  const stampedMethod = isReassign
    ? `manual_review:reassigned${decision.clientId ? `:${decision.clientId}` : ""}`
    : "manual_review:approved";

  const result = await getDb().transaction(async (tx) => {
    for (const rec of relatedRaws) {
      await tx.update(rawCommunicationRecords)
        .set({
          clientId: targetClientId,
          matchMethod: stampedMethod,
          matchConfidence: 1.0,
          matchStatus: "matched",
          processingStatus: "pending",
          updatedAt: new Date(),
        })
        .where(eq(rawCommunicationRecords.id, rec.id));

      // Task #4079: a manual review verdict is authoritative for the whole
      // record — sweep EVERY other client's link, not just the prior
      // decision's client. No Zoom flow deliberately tags one record with
      // multiple clients (all writers upsert a single clientId), so any
      // other-client link here is stale residue from an earlier auto-match
      // or backfill and would double-count the call in that client's comm
      // history.
      await tx.delete(communicationClientLinks)
        .where(and(
          eq(communicationClientLinks.rawCommunicationRecordId, rec.id),
          sql`${communicationClientLinks.clientId} <> ${targetClientId}`,
        ));

      await tx.insert(communicationClientLinks)
        .values({
          rawCommunicationRecordId: rec.id,
          clientId: targetClientId,
          matchMethod: stampedMethod,
          matchConfidence: 1.0,
          isPrimary: true,
          status: "detected",
        })
        .onConflictDoUpdate({
          target: [communicationClientLinks.rawCommunicationRecordId, communicationClientLinks.clientId],
          set: { matchMethod: stampedMethod, matchConfidence: 1.0, isPrimary: true },
        });
    }

    const [updated] = await tx.update(agentMatchDecisions)
      .set({
        reviewResolution: isReassign ? "reassigned" : "approved",
        reviewedAt: new Date(),
        reviewedByUserId: opts.userId,
        reviewedByHuman: true,
        correctedByHuman: isReassign,
        correctedToClientId: isReassign ? targetClientId : null,
      })
      .where(eq(agentMatchDecisions.id, decision.id))
      .returning();

    return updated;
  });

  for (const rec of relatedRaws) {
    setImmediate(async () => {
      try {
        const { analyzeCommunication } = await import("./communicationAnalysis");
        await analyzeCommunication(rec.id);
      } catch (err) {
        console.error("[ZoomReview] Post-approve analysis failed:", err);
      }
    });
  }

  return { decision: result, rawRecord: raw, stampedRecordIds: relatedRaws.map((r) => r.id) };
}

/**
 * Dismiss a Zoom review decision: clear the raw record's client attribution,
 * remove any communication_client_links, and mark the decision dismissed.
 * All writes happen inside a single DB transaction.
 */
export async function dismissReviewDecision(opts: {
  decisionId: string;
  userId: string;
  reason?: string;
  reasonNote?: string;
}) {
  const decision = await storage.getAgentMatchDecision(opts.decisionId);
  if (!decision) throw new Error("Decision not found");
  if (decision.status !== "review_required") throw new Error("Decision is not in review");
  if (decision.reviewResolution) throw new Error("Decision already resolved");

  let validReason: DismissReason | null = null;
  if (opts.reason) {
    if (!(dismissReasons as readonly string[]).includes(opts.reason)) {
      throw new Error(
        `Invalid dismiss reason. Must be one of: ${dismissReasons.join(", ")}`,
      );
    }
    validReason = opts.reason as DismissReason;
  }
  const note = opts.reasonNote?.trim() || null;
  if (validReason === "other" && !note) {
    throw new Error("A note is required when the dismiss reason is 'other'");
  }

  // Stamp the raw record's matchMethod with the structured reason for legacy
  // log surfaces that still parse it. The decision row is now the source of
  // truth for the audit trail.
  const stampedReason = validReason ?? null;

  // Task #4050: clear every raw record of the meeting, not just the
  // decision's own row (recording + transcript share one externalSourceId).
  const { primary: raw, all: relatedRaws } = await findRawAndSiblingsForDecision(decision);

  const result = await getDb().transaction(async (tx) => {
    for (const rec of relatedRaws) {
      await tx.update(rawCommunicationRecords)
        .set({
          clientId: null,
          matchMethod: stampedReason ? `dismissed:${stampedReason}` : "dismissed",
          matchConfidence: null,
          matchStatus: "unmatched",
          processingStatus: "pending",
          updatedAt: new Date(),
        })
        .where(eq(rawCommunicationRecords.id, rec.id));

      await tx.delete(communicationClientLinks)
        .where(eq(communicationClientLinks.rawCommunicationRecordId, rec.id));
    }

    const [updated] = await tx.update(agentMatchDecisions)
      .set({
        reviewResolution: "dismissed",
        reviewedAt: new Date(),
        reviewedByUserId: opts.userId,
        reviewedByHuman: true,
        dismissReason: stampedReason,
        dismissReasonNote: note,
      })
      .where(eq(agentMatchDecisions.id, decision.id))
      .returning();

    return updated;
  });

  return { decision: result, rawRecord: raw, stampedRecordIds: relatedRaws.map((r) => r.id) };
}

/**
 * Task #996: bulk-action helpers for the Zoom Review Queue admin UI. After
 * Task #993 disabled AI-driven dismissal, every Zoom recording without a
 * deterministic match lands in the queue, so operators need to triage many
 * rows at once. These helpers loop the existing single-row functions so each
 * row keeps its own transaction, dismiss-reason validation, and per-row
 * audit-trail stamp (`manual_review:approved` / `manual_review:reassigned:*` /
 * `dismissed:<reason>`). Per-row failures don't abort the batch — we collect
 * them and return them so the UI can show partial success.
 */
export interface BulkReviewActionResult {
  succeeded: string[];
  failed: { decisionId: string; error: string }[];
}

export async function bulkDismissReviewDecisions(opts: {
  decisionIds: string[];
  userId: string;
  reason?: string;
  reasonNote?: string;
}): Promise<BulkReviewActionResult> {
  const result: BulkReviewActionResult = { succeeded: [], failed: [] };
  for (const id of opts.decisionIds) {
    try {
      await dismissReviewDecision({
        decisionId: id,
        userId: opts.userId,
        reason: opts.reason,
        reasonNote: opts.reasonNote,
      });
      result.succeeded.push(id);
    } catch (err: any) {
      result.failed.push({ decisionId: id, error: err?.message || "Unknown error" });
    }
  }
  return result;
}

export async function bulkApproveReviewDecisions(opts: {
  decisionIds: string[];
  userId: string;
  approvedClientId?: string;
}): Promise<BulkReviewActionResult> {
  const result: BulkReviewActionResult = { succeeded: [], failed: [] };
  for (const id of opts.decisionIds) {
    try {
      await approveReviewDecision({
        decisionId: id,
        userId: opts.userId,
        approvedClientId: opts.approvedClientId,
      });
      result.succeeded.push(id);
    } catch (err: any) {
      result.failed.push({ decisionId: id, error: err?.message || "Unknown error" });
    }
  }
  return result;
}

/**
 * Re-open a previously resolved (approved/reassigned/dismissed) Zoom review
 * decision back into the queue. Clears reviewResolution, dismiss reason fields,
 * reviewedAt and reviewedByUserId so it shows up again as unresolved, and
 * re-stamps the raw_communication_records.matchMethod back to "review_required"
 * (also clearing the prior client attribution so the queue worker treats it as
 * unmatched again). Records who reopened (reopenedByUserId) and when
 * (reopenedAt), and bumps reopenCount so repeated reopens are auditable.
 */
export async function reopenReviewDecision(opts: {
  decisionId: string;
  userId: string;
}) {
  const decision = await storage.getAgentMatchDecision(opts.decisionId);
  if (!decision) throw new Error("Decision not found");
  if (decision.sourceType !== "zoom") {
    throw new Error("Only Zoom review decisions can be re-opened from this endpoint");
  }
  if (!decision.reviewResolution) {
    throw new Error("Decision is not resolved; nothing to re-open");
  }

  // Task #4050: reset every raw record of the meeting, not just the
  // decision's own row (recording + transcript share one externalSourceId).
  const { primary: raw, all: relatedRaws } = await findRawAndSiblingsForDecision(decision);
  const now = new Date();

  const result = await getDb().transaction(async (tx) => {
    for (const rec of relatedRaws) {
      await tx.update(rawCommunicationRecords)
        .set({
          clientId: null,
          matchMethod: "review_required",
          matchConfidence: null,
          matchStatus: "unmatched",
          processingStatus: "pending",
          updatedAt: now,
        })
        .where(eq(rawCommunicationRecords.id, rec.id));

      await tx.delete(communicationClientLinks)
        .where(eq(communicationClientLinks.rawCommunicationRecordId, rec.id));
    }

    const [updated] = await tx.update(agentMatchDecisions)
      .set({
        status: "review_required",
        reviewResolution: null,
        dismissReason: null,
        dismissReasonNote: null,
        reviewedAt: null,
        reviewedByUserId: null,
        reviewedByHuman: false,
        correctedByHuman: false,
        correctedToClientId: null,
        reopenedAt: now,
        reopenedByUserId: opts.userId,
        reopenCount: sql`${agentMatchDecisions.reopenCount} + 1`,
      })
      .where(eq(agentMatchDecisions.id, decision.id))
      .returning();

    return updated;
  });

  return { decision: result, rawRecord: raw, stampedRecordIds: relatedRaws.map((r) => r.id) };
}

/**
 * Task #4050: manual reassignment from the Meeting Review FEED (the
 * `/api/integrations/zoom/messages/:id/reassign` endpoint). The old inline
 * route update had four gaps that kept manually-assigned calls out of churn
 * comms:
 *   1. it never set matchStatus, so the row stayed `unmatched` and the next
 *      reprocess run re-selected it and clobbered the manual assignment;
 *   2. it never wrote a communication_client_links row;
 *   3. it never resolved the open review decision, leaving a ghost queue item;
 *   4. it stamped only the one raw record, leaving the transcript/recording
 *      sibling unattributed.
 * This service closes all four: stamps every related raw record (shared
 * externalSourceId), maintains links, resolves open decisions as
 * approved/reassigned with the acting user, and triggers analysis so the call
 * counts toward churn comms immediately. Clearing (clientId: null) reverts the
 * meeting to unmatched and leaves any open review decision in the queue.
 */
export async function manualReassignZoomRecordFromFeed(opts: {
  recordId: string;
  clientId: string | null;
  userId: string;
}): Promise<{
  record: RawCommunicationRecord;
  stampedRecordIds: string[];
  resolvedDecisionIds: string[];
} | null> {
  const record = await storage.getRawCommunication(opts.recordId);
  if (!record || record.sourceType !== "zoom") return null;

  const relatedRaws = await findRelatedZoomRawRecords(record);
  const now = new Date();
  const resolvedDecisionIds: string[] = [];

  await withDbAttribution("zoomReview:feed-reassign", () =>
    getDb().transaction(async (tx) => {
    for (const rec of relatedRaws) {
      if (opts.clientId) {
        await tx.update(rawCommunicationRecords)
          .set({
            clientId: opts.clientId,
            matchMethod: "manual",
            matchConfidence: 1.0,
            matchStatus: "matched",
            processingStatus: "pending",
            operationalClassificationReason: null,
            updatedAt: now,
          })
          .where(eq(rawCommunicationRecords.id, rec.id));

        // Task #4079: the operator's reassignment is authoritative — sweep
        // EVERY other client's link (not just the record's prior client).
        // Zoom has no deliberate multi-client tagging flow, so any
        // other-client link is stale residue (old auto-match / backfill)
        // that double-counts the call.
        await tx.delete(communicationClientLinks)
          .where(and(
            eq(communicationClientLinks.rawCommunicationRecordId, rec.id),
            sql`${communicationClientLinks.clientId} <> ${opts.clientId}`,
          ));

        await tx.insert(communicationClientLinks)
          .values({
            rawCommunicationRecordId: rec.id,
            clientId: opts.clientId,
            matchMethod: "manual",
            matchConfidence: 1.0,
            isPrimary: true,
            status: "detected",
          })
          .onConflictDoUpdate({
            target: [communicationClientLinks.rawCommunicationRecordId, communicationClientLinks.clientId],
            set: { matchMethod: "manual", matchConfidence: 1.0, isPrimary: true },
          });
      } else {
        await tx.update(rawCommunicationRecords)
          .set({
            clientId: null,
            matchMethod: null,
            matchConfidence: null,
            matchStatus: "unmatched",
            processingStatus: "pending",
            updatedAt: now,
          })
          .where(eq(rawCommunicationRecords.id, rec.id));

        await tx.delete(communicationClientLinks)
          .where(eq(communicationClientLinks.rawCommunicationRecordId, rec.id));
      }
    }

    if (opts.clientId) {
      // Resolve every open review decision covering any related record —
      // decisions key communicationId by raw record id OR externalSourceId
      // (legacy shape), so match both.
      const keys = new Set<string>();
      for (const rec of relatedRaws) {
        keys.add(rec.id);
        if (rec.externalSourceId) keys.add(rec.externalSourceId);
      }
      const openDecisions = await tx.select()
        .from(agentMatchDecisions)
        .where(and(
          inArray(agentMatchDecisions.communicationId, [...keys]),
          eq(agentMatchDecisions.status, "review_required"),
          isNull(agentMatchDecisions.reviewResolution),
        ));
      for (const d of openDecisions) {
        const isReassign = !!d.clientId && d.clientId !== opts.clientId;
        await tx.update(agentMatchDecisions)
          .set({
            reviewResolution: isReassign ? "reassigned" : "approved",
            reviewedAt: now,
            reviewedByUserId: opts.userId,
            reviewedByHuman: true,
            correctedByHuman: isReassign,
            correctedToClientId: isReassign ? opts.clientId : null,
          })
          .where(eq(agentMatchDecisions.id, d.id));
        resolvedDecisionIds.push(d.id);
      }
    }
    }),
  );

  if (opts.clientId) {
    for (const rec of relatedRaws) {
      setImmediate(async () => {
        try {
          const { analyzeCommunication } = await import("./communicationAnalysis");
          await analyzeCommunication(rec.id);
        } catch (err) {
          console.error("[ZoomReview] Post-reassign analysis failed:", err);
        }
      });
    }
  }

  const updated = await storage.getRawCommunication(opts.recordId);
  return {
    record: updated ?? record,
    stampedRecordIds: relatedRaws.map((r) => r.id),
    resolvedDecisionIds,
  };
}
