// @db-pool-intent: ambient
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  /**
 * Decorates Zoom message rows fetched from `raw_communication_records` with
 * the latest review state (`review` for unresolved review-required decisions
 * and `resolved` for already-resolved ones).
 *
 * Extracted from the GET /api/integrations/zoom/messages route so the
 * end-to-end test (tests/zoom-resolved-panel-e2e.test.tsx) can exercise the
 * exact same code path the route uses.
 */

import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { bindArrayParam } from "../utils/sqlArray";

export type ZoomFeedMessage = {
  id: string | null;
  externalSourceId?: string | null;
  matchMethod?: string | null;
  review?: unknown;
  resolved?: unknown;
  [key: string]: unknown;
};

export interface ZoomMessagesQuery {
  page?: number;
  limit?: number;
  match?: string;
  clientId?: string;
  host?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface ZoomMessagesResponse {
  messages: ZoomFeedMessage[];
  stats: {
    total: number;
    matched: number;
    unmatched: number;
    needsReview: number;
    matchRate: number;
  };
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

function formatReviewerName(row: any): string | null {
  const first = (row.reviewerFirstName || "").trim();
  const last = (row.reviewerLastName || "").trim();
  const full = `${first} ${last}`.trim();
  return full || row.reviewerEmail || null;
}

function parseDismissReason(matchMethod: string | null | undefined): string | null {
  if (!matchMethod || typeof matchMethod !== "string") return null;
  const lower = matchMethod.toLowerCase();
  if (!lower.startsWith("dismissed:")) return null;
  const reason = matchMethod.slice("dismissed:".length).trim();
  return reason || null;
}

export async function decorateZoomMessagesWithReviewState(
  messages: ZoomFeedMessage[],
): Promise<void> {
  const reviewLookupKeys = new Set<string>();
  for (const m of messages) {
    if (m.id) reviewLookupKeys.add(String(m.id));
    if (m.externalSourceId) reviewLookupKeys.add(String(m.externalSourceId));
  }

  if (reviewLookupKeys.size === 0) {
    for (const m of messages) {
      m.review = null;
      m.resolved = null;
    }
    return;
  }

  const keys = Array.from(reviewLookupKeys);
  const decisionRows = await getDb().execute(sql`
    SELECT DISTINCT ON (amd.communication_id)
           amd.id as "decisionId",
           amd.communication_id as "communicationId",
           amd.status as "status",
           amd.client_id as "clientId",
           amd.confidence_score as "confidenceScore",
           amd.review_reason as "reviewReason",
           amd.explanation_summary as "explanationSummary",
           amd.candidate_shortlist_json as "candidateShortlist",
           amd.prior_client_id as "priorClientId",
           amd.review_resolution as "reviewResolution",
           amd.reviewed_at as "reviewedAt",
           amd.corrected_to_client_id as "correctedToClientId",
           sc.firm_name as "suggestedClientName",
           pc.firm_name as "priorClientName",
           cc.firm_name as "correctedToClientName",
           u.email as "reviewerEmail",
           u.first_name as "reviewerFirstName",
           u.last_name as "reviewerLastName"
    FROM agent_match_decisions amd
    LEFT JOIN clients sc ON amd.client_id = sc.id
    LEFT JOIN clients pc ON amd.prior_client_id = pc.id
    LEFT JOIN clients cc ON amd.corrected_to_client_id = cc.id
    LEFT JOIN users u ON amd.reviewed_by_user_id = u.id
    WHERE amd.source_type = 'zoom'
      AND amd.status = 'review_required'
      AND amd.communication_id = ANY(${bindArrayParam(keys)})
    ORDER BY amd.communication_id, amd.created_at DESC
  `);

  const decisionByKey = new Map<string, any>();
  const candidateClientIds = new Set<string>();
  for (const row of decisionRows.rows as any[]) {
    decisionByKey.set(String(row.communicationId), row);
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

  for (const m of messages) {
    const decision =
      decisionByKey.get(String(m.id)) ||
      (m.externalSourceId ? decisionByKey.get(String(m.externalSourceId)) : null);
    m.review = null;
    m.resolved = null;
    if (!decision) continue;

    if (decision.reviewResolution) {
      const resolution = decision.reviewResolution as "approved" | "reassigned" | "dismissed";
      let finalClientId: string | null = null;
      let finalClientName: string | null = null;
      if (resolution === "approved") {
        finalClientId = decision.clientId || null;
        finalClientName = decision.suggestedClientName || null;
      } else if (resolution === "reassigned") {
        finalClientId = decision.correctedToClientId || null;
        finalClientName = decision.correctedToClientName || null;
      }
      m.resolved = {
        decisionId: decision.decisionId,
        resolution,
        reviewedAt: decision.reviewedAt,
        reviewerName: formatReviewerName(decision),
        reviewReason: decision.reviewReason,
        suggestedClientId: decision.clientId || null,
        suggestedClientName: decision.suggestedClientName || null,
        finalClientId,
        finalClientName,
        dismissReason: resolution === "dismissed" ? parseDismissReason(m.matchMethod as string | null) : null,
      };
    } else if (decision.status === "review_required") {
      const candidates = Array.isArray(decision.candidateShortlist) ? decision.candidateShortlist : [];
      m.review = {
        decisionId: decision.decisionId,
        reviewReason: decision.reviewReason,
        explanationSummary: decision.explanationSummary,
        suggestedClientId: decision.clientId,
        suggestedClientName: decision.suggestedClientName,
        suggestedConfidence: decision.confidenceScore,
        priorClientId: decision.priorClientId,
        priorClientName: decision.priorClientName,
        candidates: candidates.map((c: any) => ({
          clientId: c?.clientId || null,
          clientName: c?.clientId ? candidateNameMap.get(String(c.clientId)) || null : null,
          confidenceScore: typeof c?.confidenceScore === "number" ? c.confidenceScore : null,
          evidenceType: c?.evidenceType || null,
          explanationSummary: c?.explanationSummary || null,
        })),
      };
    }
  }
}

/**
 * Build the full GET /api/integrations/zoom/messages response. Extracted from
 * the route handler so the e2e test can drive the same code path without
 * spinning up Express + auth.
 */
export async function getZoomMessagesPage(
  query: ZoomMessagesQuery = {},
): Promise<ZoomMessagesResponse> {
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(100, Math.max(1, query.limit ?? 25));
  const offset = (page - 1) * limit;
  const matchFilter = query.match;
  const clientFilter = query.clientId;
  const hostFilter = query.host;
  const dateFrom = query.dateFrom;
  const dateTo = query.dateTo;

  const conditions = [sql`r.source_type = 'zoom'`];

  // Task #965: orphaned rows (parent client deleted — see clientStorage.deleteClient)
  // are kept for forensic queries but must not surface in the operator-facing
  // Zoom messages feed. They have client_id=NULL and would otherwise appear
  // in the "unmatched" bucket and the global stats. NULL-safe predicate
  // because match_status is NULL on most pre-#897 rows.
  conditions.push(sql`(r.match_status IS NULL OR r.match_status <> 'orphaned')`);

  if (matchFilter === "matched") {
    conditions.push(sql`r.client_id IS NOT NULL`);
  } else if (matchFilter === "unmatched") {
    conditions.push(sql`r.client_id IS NULL`);
  } else if (matchFilter === "review") {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM agent_match_decisions amd
      WHERE amd.source_type = 'zoom'
        AND amd.status = 'review_required'
        AND amd.review_resolution IS NULL
        AND (amd.communication_id = r.id::text OR amd.communication_id = r.external_source_id)
    )`);
  }

  if (clientFilter) {
    conditions.push(sql`r.client_id = ${clientFilter}`);
  }
  if (hostFilter) {
    conditions.push(sql`(r.raw_payload_json->>'hostName') ILIKE ${"%" + hostFilter + "%"}`);
  }
  if (dateFrom) {
    conditions.push(sql`r.timestamp >= ${new Date(dateFrom)}`);
  }
  if (dateTo) {
    const endOfDay = new Date(dateTo);
    endOfDay.setHours(23, 59, 59, 999);
    conditions.push(sql`r.timestamp <= ${endOfDay}`);
  }

  const whereClause = sql.join(conditions, sql` AND `);
  const db = getDb();

  const globalStatsResult = await db.execute(sql`
    SELECT COUNT(*)::int as total,
           COUNT(CASE WHEN r.client_id IS NOT NULL OR EXISTS (
             SELECT 1 FROM communication_client_links ccl
             WHERE ccl.raw_communication_record_id = r.id AND ccl.status != 'rejected'
           ) THEN 1 END)::int as matched,
           COUNT(CASE WHEN r.client_id IS NULL AND NOT EXISTS (
             SELECT 1 FROM communication_client_links ccl
             WHERE ccl.raw_communication_record_id = r.id AND ccl.status != 'rejected'
           ) THEN 1 END)::int as unmatched,
           COUNT(CASE WHEN EXISTS (
             SELECT 1 FROM agent_match_decisions amd
             WHERE amd.source_type = 'zoom'
               AND amd.status = 'review_required'
               AND amd.review_resolution IS NULL
               AND (amd.communication_id = r.id::text OR amd.communication_id = r.external_source_id)
           ) THEN 1 END)::int as "needsReview"
    FROM raw_communication_records r
    WHERE r.source_type = 'zoom'
      AND (r.match_status IS NULL OR r.match_status <> 'orphaned')
  `);
  const globalStats = globalStatsResult.rows[0] as {
    total: number; matched: number; unmatched: number; needsReview: number;
  };

  const countResult = await db.execute(sql`
    SELECT COUNT(*)::int as total
    FROM raw_communication_records r
    WHERE ${whereClause}
  `);
  const filteredCount = (countResult.rows[0] as { total: number }).total || 0;

  const result = await db.execute(sql`
    SELECT r.id, r.client_id as "clientId", r.title, r.content_text as "contentText",
           r.content_preview as "contentPreview", r.timestamp, r.direction,
           r.match_method as "matchMethod", r.match_confidence as "matchConfidence",
           r.external_url as "externalUrl", r.google_drive_file_url as "googleDriveFileUrl",
           r.client_file_id as "clientFileId",
           r.source_subtype as "sourceSubtype",
           r.external_source_id as "externalSourceId",
           r.ai_summary as "aiSummary", r.created_at as "createdAt",
           r.raw_payload_json as "rawPayload",
           r.participants_json as "participants",
           c.firm_name as "clientName"
    FROM raw_communication_records r
    LEFT JOIN clients c ON r.client_id = c.id
    WHERE ${whereClause}
    ORDER BY r.timestamp DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const messages = result.rows as ZoomFeedMessage[];
  await decorateZoomMessagesWithReviewState(messages);

  return {
    messages,
    stats: {
      total: globalStats.total || 0,
      matched: globalStats.matched || 0,
      unmatched: globalStats.unmatched || 0,
      needsReview: globalStats.needsReview || 0,
      matchRate: globalStats.total > 0
        ? Math.round((globalStats.matched / globalStats.total) * 100)
        : 0,
    },
    pagination: {
      page,
      limit,
      total: filteredCount,
      totalPages: Math.ceil(filteredCount / limit),
    },
  };
}
