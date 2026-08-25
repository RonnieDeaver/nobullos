// @db-pool-intent: worker
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  /**
 * Decorates Activity Feed items (the GET /api/integrations/unmatched-feed
 * payload) with the latest open `review` state for any Zoom rows.
 *
 * Extracted from server/routes/integrations.ts so the multi-key Postgres
 * lookup uses the same safe `ANY(ARRAY[...]::text[])` pattern as
 * server/services/zoomMessagesFeed.ts and so we have a single place to
 * regression-test (tests/activity-feed-review-lookup.test.ts).
 *
 * Why the explicit ARRAY[...] form: drizzle binds a JS string[] as a
 * parameter list, which Postgres rejects on `ANY($1::text[])` with
 * "cannot cast type record to text[]". Building the array via
 * sql.join(keys.map(k => sql`${k}`), sql`, `) and wrapping it in
 * ARRAY[...]::text[] gives Postgres the literal array it needs.
 */

import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { bindArrayParam } from "../utils/sqlArray";

export type ActivityFeedReviewCandidate = {
  clientId: string | null;
  clientName: string | null;
  confidenceScore: number | null;
  evidenceType: string | null;
  explanationSummary: string | null;
};

export type ActivityFeedReviewInfo = {
  decisionId: string;
  reviewReason: string | null;
  explanationSummary: string | null;
  suggestedClientId: string | null;
  suggestedClientName: string | null;
  suggestedConfidence: number | null;
  priorClientId: string | null;
  priorClientName: string | null;
  candidates: ActivityFeedReviewCandidate[];
  reopenedAt: string | null;
  reopenedByUserId: string | null;
  reopenedByName: string | null;
  reopenedByEmail: string | null;
  reopenCount: number;
};

export interface ActivityFeedZoomItem {
  source: string;
  metadata?: { recordId?: unknown; externalSourceId?: unknown } | null;
  review?: ActivityFeedReviewInfo | null;
  suggestedClientId?: string | null;
  suggestedClientName?: string | null;
  matchConfidence?: number | null;
  [key: string]: unknown;
}

export async function decorateActivityFeedZoomReviews(
  items: ActivityFeedZoomItem[],
): Promise<void> {
  const zoomItems = items.filter((i) => i.source === "zoom");
  if (zoomItems.length === 0) return;

  const lookupKeys = new Set<string>();
  const itemsByKey = new Map<string, ActivityFeedZoomItem>();
  for (const item of zoomItems) {
    const recordId = item.metadata?.recordId ? String(item.metadata.recordId) : null;
    const externalId = item.metadata?.externalSourceId
      ? String(item.metadata.externalSourceId)
      : null;
    if (recordId) {
      lookupKeys.add(recordId);
      itemsByKey.set(recordId, item);
    }
    if (externalId) {
      lookupKeys.add(externalId);
      if (!itemsByKey.has(externalId)) itemsByKey.set(externalId, item);
    }
  }

  if (lookupKeys.size === 0) {
    for (const item of zoomItems) item.review = null;
    return;
  }

  const keys = Array.from(lookupKeys);
  const reviewRows = await getDb().execute(sql`
    SELECT amd.id as "decisionId",
           amd.communication_id as "communicationId",
           amd.client_id as "clientId",
           amd.confidence_score as "confidenceScore",
           amd.review_reason as "reviewReason",
           amd.explanation_summary as "explanationSummary",
           amd.candidate_shortlist_json as "candidateShortlist",
           amd.prior_client_id as "priorClientId",
           amd.reopened_at as "reopenedAt",
           amd.reopened_by_user_id as "reopenedByUserId",
           amd.reopen_count as "reopenCount",
           sc.firm_name as "suggestedClientName",
           pc.firm_name as "priorClientName",
           ru.first_name as "reopenerFirstName",
           ru.last_name as "reopenerLastName",
           ru.email as "reopenerEmail"
    FROM agent_match_decisions amd
    LEFT JOIN clients sc ON amd.client_id = sc.id
    LEFT JOIN clients pc ON amd.prior_client_id = pc.id
    LEFT JOIN users ru ON ru.id = amd.reopened_by_user_id
    WHERE amd.source_type = 'zoom'
      AND amd.status = 'review_required'
      AND amd.review_resolution IS NULL
      AND amd.communication_id = ANY(${bindArrayParam(keys)})
  `);

  const candidateClientIds = new Set<string>();
  const reviewByItem = new Map<ActivityFeedZoomItem, any>();
  for (const row of reviewRows.rows as any[]) {
    const target = itemsByKey.get(String(row.communicationId));
    if (!target) continue;
    if (!reviewByItem.has(target)) reviewByItem.set(target, row);
    const list = Array.isArray(row.candidateShortlist) ? row.candidateShortlist : [];
    for (const c of list) {
      if (c?.clientId) candidateClientIds.add(String(c.clientId));
    }
  }

  const candidateNameMap = new Map<string, string>();
  if (candidateClientIds.size > 0) {
    const candIdList = Array.from(candidateClientIds);
    const clientRows = await getDb().execute(sql`
      SELECT id, firm_name as "firmName"
      FROM clients
      WHERE id = ANY(${bindArrayParam(candIdList)})
    `);
    for (const cr of clientRows.rows as any[]) {
      candidateNameMap.set(String(cr.id), cr.firmName);
    }
  }

  for (const item of zoomItems) {
    const review = reviewByItem.get(item);
    if (!review) {
      item.review = null;
      continue;
    }
    const candidates = Array.isArray(review.candidateShortlist) ? review.candidateShortlist : [];
    const reopenerName =
      [review.reopenerFirstName, review.reopenerLastName].filter(Boolean).join(" ").trim() ||
      review.reopenerEmail ||
      (review.reopenedByUserId ? String(review.reopenedByUserId) : null);
    const reopenedAtIso = review.reopenedAt
      ? (review.reopenedAt instanceof Date
          ? review.reopenedAt.toISOString()
          : new Date(review.reopenedAt).toISOString())
      : null;
    item.review = {
      decisionId: review.decisionId,
      reviewReason: review.reviewReason,
      explanationSummary: review.explanationSummary,
      suggestedClientId: review.clientId,
      suggestedClientName: review.suggestedClientName,
      suggestedConfidence: review.confidenceScore != null ? Number(review.confidenceScore) : null,
      priorClientId: review.priorClientId,
      priorClientName: review.priorClientName,
      reopenedAt: reopenedAtIso,
      reopenedByUserId: review.reopenedByUserId || null,
      reopenedByName: review.reopenedByUserId ? reopenerName : null,
      reopenedByEmail: review.reopenedByUserId ? (review.reopenerEmail || null) : null,
      reopenCount: Number(review.reopenCount ?? 0) || 0,
      candidates: candidates.map((c: any) => ({
        clientId: c?.clientId || null,
        clientName: c?.clientId ? candidateNameMap.get(String(c.clientId)) || null : null,
        confidenceScore: typeof c?.confidenceScore === "number" ? c.confidenceScore : null,
        evidenceType: c?.evidenceType || null,
        explanationSummary: c?.explanationSummary || null,
      })),
    };
    if (item.review.suggestedClientId && !item.suggestedClientId) {
      item.suggestedClientId = item.review.suggestedClientId;
      item.suggestedClientName = item.review.suggestedClientName;
      if (item.review.suggestedConfidence != null && item.matchConfidence == null) {
        item.matchConfidence = item.review.suggestedConfidence;
      }
    }
  }
}
