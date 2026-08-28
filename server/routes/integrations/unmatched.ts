/**
 * Integrations routes — unmatched communications feed.
 * Extracted verbatim from server/routes/integrations.ts (Task #4152 / F6
 * split; original lines 53–60, 531–1131, 1338–1698); sections: unmatched communications feed; unmatched triage actions (assign / undo-claim / dismiss / block / promote).
 * Mounted by registerIntegrationRoutes in ../integrations.ts — route order is
 * preserved by the aggregator's call sequence; the only in-slice edit is
 * dynamic-import specifier depth (./ -> ../, ../ -> ../../).
 */
import type { Express } from "express";
import { storage } from "../../storage";
import { db } from "../../db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireAccountManager } from "../middleware";
import type { AuthenticatedRequest, TenantScopedRequest } from "../requestContext";
import {
  rawCommunicationRecords,
  frontSyncEmails,
  clients,
} from "@shared/schema";

let cachedClients: { data: Map<string, any>; ts: number } | null = null;
async function getCachedClientMap(): Promise<Map<string, any>> {
  if (cachedClients && Date.now() - cachedClients.ts < 60_000) return cachedClients.data;
  const allClients = await storage.getClients();
  const map = new Map(allClients.map(c => [c.id, c]));
  cachedClients = { data: map, ts: Date.now() };
  return map;
}

export function registerIntegrationsUnmatchedRoutes(app: Express) {
  app.get("/api/integrations/unmatched-feed", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      // Cap raised from 500 → 10000 so that admin / power-user pulls
      // (and the Task #1242 regression test against the shared dev DB,
      // which can hold thousands of unmatched/dismissed rows) aren't
      // paginated off the first page. Default page size stays at 100.
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 10000));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const showDismissedOperational = req.query.showDismissedOperational === "true";
      const showRecentlyClaimed = req.query.showRecentlyClaimed === "true";
      // #695: when set, restrict items + totalCount to a single source so the
      // paginator and total badge reflect what the user is actually looking
      // at after toggling the source-chip filter. countsBySource always
      // reflects the unfiltered totals so the chips remain navigable.
      const sourceTypeFilter = ((): "all" | "front" | "slack" | "zoom" => {
        const v = String(req.query.sourceType ?? "all");
        return v === "front" || v === "slack" || v === "zoom" ? v : "all";
      })();

      // "Recently claimed" view: surface Zoom recordings that were claimed
      // out of the unmatched feed by an admin via the Command Panel pickers
      // (Key Calls / RER). They previously disappeared silently — this view
      // shows who claimed them and for which client.
      if (showRecentlyClaimed) {
        try {
          const { sql } = await import("drizzle-orm");
          // #695: narrow items + totalCount when a chip filter is active.
          // countsBySource stays unfiltered so the chip group keeps its
          // navigation semantics.
          const sourceFilterSql = sourceTypeFilter === "all"
            ? sql``
            : sql`AND r.source_type = ${sourceTypeFilter}`;
          const claimedRows = await db.execute(sql`
            SELECT r.id            AS "recordId",
                   r.title         AS "title",
                   r.timestamp     AS "timestamp",
                   r.source_type   AS "sourceType",
                   r.content_text  AS "contentText",
                   r.ai_summary    AS "aiSummary",
                   r.participants_json AS "participantsJson",
                   r.raw_payload_json  AS "rawPayloadJson",
                   r.external_source_id AS "externalSourceId",
                   r.client_id     AS "clientId",
                   r.updated_at    AS "claimedAt",
                   c.firm_name     AS "clientName",
                   amd.reviewed_by_user_id AS "claimedByUserId",
                   amd.reviewed_at         AS "decisionReviewedAt",
                   u.first_name    AS "claimedByFirstName",
                   u.last_name     AS "claimedByLastName",
                   u.email         AS "claimedByEmail"
            FROM raw_communication_records r
            LEFT JOIN clients c ON c.id = r.client_id
            LEFT JOIN LATERAL (
              SELECT d.reviewed_by_user_id, d.reviewed_at
              FROM agent_match_decisions d
              WHERE d.client_id = r.client_id
                AND d.status = 'claimed'
                AND d.explanation_summary = 'Manually matched via Command Panel'
                AND (
                  d.communication_id = r.id
                  OR d.communication_id = r.external_source_id
                  OR d.communication_id = 'zoom_' || r.external_source_id
                  OR d.communication_id = 'zoom_' || r.id
                )
              ORDER BY d.created_at DESC
              LIMIT 1
            ) amd ON TRUE
            LEFT JOIN users u ON u.id = amd.reviewed_by_user_id
            WHERE r.match_method = 'manual_command_panel'
              AND r.client_id IS NOT NULL
              AND r.updated_at > NOW() - INTERVAL '30 days'
              ${sourceFilterSql}
            ORDER BY r.updated_at DESC
            LIMIT ${limit}
            OFFSET ${offset}
          `);
          type ClaimedRow = {
            recordId: string;
            title: string | null;
            timestamp: Date | string | null;
            sourceType: string | null;
            contentText: string | null;
            aiSummary: string | null;
            participantsJson: unknown;
            rawPayloadJson: unknown;
            externalSourceId: string | null;
            clientId: string | null;
            claimedAt: Date | string | null;
            clientName: string | null;
            claimedByUserId: string | null;
            decisionReviewedAt: Date | string | null;
            claimedByFirstName: string | null;
            claimedByLastName: string | null;
            claimedByEmail: string | null;
          };
          type CountRow = { count: number | string | null };
          type ParticipantLike = { name?: unknown; email?: unknown; role?: unknown };
          type RawPayloadLike = { channelName?: unknown; channelId?: unknown };
          const countSourceFilterSql = sourceTypeFilter === "all"
            ? sql``
            : sql`AND source_type = ${sourceTypeFilter}`;
          const countRows = (await db.execute(sql`
            SELECT COUNT(*)::int AS count
            FROM raw_communication_records
            WHERE match_method = 'manual_command_panel'
              AND client_id IS NOT NULL
              AND updated_at > NOW() - INTERVAL '30 days'
              ${countSourceFilterSql}
          `)).rows as CountRow[];
          const totalCount = Number(countRows[0]?.count ?? 0);
          const countsBySource = { front: 0, slack: 0, zoom: 0 } as { front: number; slack: number; zoom: number };
          try {
            const groupedRows = (await db.execute(sql`
              SELECT source_type AS "sourceType", COUNT(*)::int AS count
              FROM raw_communication_records
              WHERE match_method = 'manual_command_panel'
                AND client_id IS NOT NULL
                AND updated_at > NOW() - INTERVAL '30 days'
              GROUP BY source_type
            `)).rows as Array<{ sourceType: string | null; count: number | string | null }>;
            for (const r of groupedRows) {
              const s = r.sourceType === "slack" ? "slack" : r.sourceType === "front" ? "front" : "zoom";
              countsBySource[s] += Number(r.count ?? 0);
            }
          } catch (err) {
            console.error("[Integrations] recently-claimed: failed to group counts by source:", err);
          }
          const toIso = (v: Date | string | null): string | null => {
            if (!v) return null;
            const d = v instanceof Date ? v : new Date(v);
            return Number.isNaN(d.getTime()) ? null : d.toISOString();
          };
          const items = (claimedRows.rows as ClaimedRow[]).map((row) => {
            const source: "zoom" | "slack" | "front" =
              row.sourceType === "slack" ? "slack" : row.sourceType === "front" ? "front" : "zoom";
            const rawP: ParticipantLike[] = Array.isArray(row.participantsJson)
              ? (row.participantsJson as ParticipantLike[])
              : [];
            const rawPayload: RawPayloadLike =
              row.rawPayloadJson && typeof row.rawPayloadJson === "object"
                ? (row.rawPayloadJson as RawPayloadLike)
                : {};
            const channelName = typeof rawPayload.channelName === "string" ? rawPayload.channelName : undefined;
            const channelId = typeof rawPayload.channelId === "string" ? rawPayload.channelId : undefined;
            const claimedByName =
              [row.claimedByFirstName, row.claimedByLastName].filter(Boolean).join(" ").trim() ||
              row.claimedByEmail ||
              null;
            return {
              id: `${source}_${row.recordId}`,
              source,
              title: row.title || (source === "zoom" ? "Zoom Meeting" : "Communication"),
              snippet: row.contentText?.substring(0, 200) || "",
              contentText: row.contentText || null,
              aiSummary: row.aiSummary || null,
              participants: rawP.map((p) =>
                typeof p?.email === "string" ? p.email : typeof p?.name === "string" ? p.name : "Unknown",
              ),
              participantsRaw: rawP.map((p) => ({
                name: typeof p?.name === "string" ? p.name : undefined,
                email: typeof p?.email === "string" ? p.email : undefined,
                role: typeof p?.role === "string" ? p.role : undefined,
              })),
              timestamp: toIso(row.timestamp),
              suggestedClientId: null,
              suggestedClientName: null,
              matchConfidence: null,
              metadata: {
                recordId: row.recordId,
                externalSourceId: row.externalSourceId,
                channelName,
                channelId,
              },
              claim: {
                claimedAt: toIso(row.decisionReviewedAt) ?? toIso(row.claimedAt),
                claimedByUserId: row.claimedByUserId || null,
                claimedByName,
                clientId: row.clientId,
                clientName: row.clientName || null,
                source: "command_panel" as const,
              },
            };
          });
          const clientMap = await getCachedClientMap();
          const seenFirmNames = new Set<string>();
          const clientList = Array.from(clientMap.values())
            .filter((c) => !c.isArchived)
            .sort((a, b) => (a.firmName || "").localeCompare(b.firmName || ""))
            .filter((c) => {
              const name = (c.firmName || "").trim().toLowerCase();
              if (seenFirmNames.has(name)) return false;
              seenFirmNames.add(name);
              return true;
            })
            .map((c) => ({ id: c.id, firmName: c.firmName }));
          return res.json({ items, totalCount, needsReviewCount: 0, countsBySource, clients: clientList });
        } catch (err: any) {
          console.error("[Integrations] Recently-claimed feed error:", err);
          return res.status(500).json({ error: err.message });
        }
      }

      type ReviewCandidate = {
        clientId: string | null;
        clientName: string | null;
        confidenceScore: number | null;
        evidenceType: string | null;
        explanationSummary: string | null;
      };
      type ReviewInfo = {
        decisionId: string;
        reviewReason: string | null;
        explanationSummary: string | null;
        suggestedClientId: string | null;
        suggestedClientName: string | null;
        suggestedConfidence: number | null;
        priorClientId: string | null;
        priorClientName: string | null;
        candidates: ReviewCandidate[];
      };
      type FeedItem = {
        id: string;
        source: "front" | "slack" | "zoom";
        title: string;
        snippet: string;
        contentText: string | null;
        aiSummary: string | null;
        participants: string[];
        participantsRaw: Array<{ name?: string; email?: string; role?: string }>;
        timestamp: string | null;
        suggestedClientId: string | null;
        suggestedClientName: string | null;
        matchConfidence: number | null;
        metadata: any;
        isDismissedOperational?: boolean;
        operationalReason?: string | null;
        review?: ReviewInfo | null;
      };
      const items: FeedItem[] = [];

      // Task #4229: when the zoom/slack raw-records section below fails (the
      // deliberate F10 degrade-instead-of-500 swallow), the response carries
      // degradedSources so the UI can show a "temporarily unavailable" notice
      // instead of a silently empty section that looks like "all matched".
      // Empty when everything succeeded — the envelope is otherwise unchanged.
      let degradedSources: Array<"zoom" | "slack"> = [];

      let rawRecordsTotalCount = 0;
      const rawCountsBySource = { slack: 0, zoom: 0, front: 0 } as { slack: number; zoom: number; front: number };

      const frontMatchStatus = showDismissedOperational ? "dismissed_operational" : "unmatched";
      const includeFront = sourceTypeFilter === "all" || sourceTypeFilter === "front";
      const [frontEmails, clientMap] = await Promise.all([
        includeFront
          ? storage.listFrontSyncEmails({ matchStatus: frontMatchStatus, limit, offset })
          : Promise.resolve([] as Awaited<ReturnType<typeof storage.listFrontSyncEmails>>),
        getCachedClientMap(),
      ]);

      const ingestedRecordIds = frontEmails
        .map(e => e.ingestedRecordId)
        .filter((id): id is string => !!id);
      const recordMap = new Map<string, any>();
      if (ingestedRecordIds.length > 0) {
        const { rawCommunicationRecords } = await import("@shared/schema");
        const { inArray } = await import("drizzle-orm");
        const records = await db.select({
          id: rawCommunicationRecords.id,
          contentText: rawCommunicationRecords.contentText,
          aiSummary: rawCommunicationRecords.aiSummary,
        }).from(rawCommunicationRecords)
          .where(inArray(rawCommunicationRecords.id, ingestedRecordIds));
        for (const r of records) recordMap.set(r.id, r);
      }

      for (const email of frontEmails) {
        const rawParticipants = Array.isArray(email.participantsJson) ? (email.participantsJson as any[]) : [];
        const participants = rawParticipants.map((p: any) => p.name || p.handle || p.email || "Unknown");
        const participantsRaw = rawParticipants.map((p: any) => ({ name: p.name, email: p.email, role: p.role }));
        const suggestedClient = email.matchedClientId ? clientMap.get(email.matchedClientId) : null;
        const record = email.ingestedRecordId ? recordMap.get(email.ingestedRecordId) : null;
        items.push({
          id: email.id,
          source: "front",
          title: email.subject || "No subject",
          snippet: email.snippet || "",
          contentText: record?.contentText || email.snippet || null,
          aiSummary: record?.aiSummary || null,
          participants,
          participantsRaw,
          timestamp: email.lastMessageAt?.toISOString() || email.createdAt?.toISOString() || null,
          suggestedClientId: email.matchedClientId || null,
          suggestedClientName: suggestedClient?.firmName || null,
          matchConfidence: email.matchConfidence || null,
          metadata: { conversationId: email.conversationId, frontStatus: email.frontStatus },
          isDismissedOperational: email.matchStatus === "dismissed_operational",
          operationalReason: email.operationalClassificationReason || null,
        });
      }

      try {
        const { rawCommunicationRecords } = await import("@shared/schema");
        const { eq, and, isNull, or, ne, sql, count } = await import("drizzle-orm");

        // When the user has filtered to "front", raw records contribute
        // nothing to either count or items (front pulls from frontEmails).
        const skipRawForFrontFilter = sourceTypeFilter === "front";
        if (skipRawForFrontFilter) {
          // Items + filtered totalCount intentionally skipped (raw records
          // don't participate when filter=front). The per-source groupedCounts
          // query still has to run so `countsBySource` keeps reflecting the
          // unfiltered slack/zoom totals — otherwise the chips next to the
          // active "front" chip silently show 0 and stop being navigable.
          try {
            if (showDismissedOperational) {
              const baseDismissed = eq(rawCommunicationRecords.matchStatus, "dismissed_operational");
              const groupedCounts = await db
                .select({ sourceType: rawCommunicationRecords.sourceType, count: count() })
                .from(rawCommunicationRecords)
                .where(baseDismissed)
                .groupBy(rawCommunicationRecords.sourceType);
              for (const g of groupedCounts) {
                const s = g.sourceType === "slack" ? "slack" : g.sourceType === "front" ? "front" : "zoom";
                rawCountsBySource[s] += Number(g.count || 0);
              }
            } else {
              const zoomHasOpenReview = sql`EXISTS (
                SELECT 1 FROM agent_match_decisions amd
                WHERE amd.source_type = 'zoom'
                  AND amd.status = 'review_required'
                  AND amd.review_resolution IS NULL
                  AND (amd.communication_id = ${rawCommunicationRecords.id}
                       OR amd.communication_id = ${rawCommunicationRecords.externalSourceId})
              )`;
              const slackUnmatched = and(
                eq(rawCommunicationRecords.sourceType, "slack"),
                isNull(rawCommunicationRecords.clientId),
              );
              const zoomUnmatched = and(
                eq(rawCommunicationRecords.sourceType, "zoom"),
                or(isNull(rawCommunicationRecords.clientId), zoomHasOpenReview),
              );
              const allUnmatchedSources = or(slackUnmatched, zoomUnmatched);
              const matchStatusClause = and(
                or(
                  isNull(rawCommunicationRecords.matchStatus),
                  ne(rawCommunicationRecords.matchStatus, "dismissed_operational"),
                ),
                or(
                  isNull(rawCommunicationRecords.matchStatus),
                  ne(rawCommunicationRecords.matchStatus, "orphaned"),
                ),
              );
              const groupedCounts = await db
                .select({ sourceType: rawCommunicationRecords.sourceType, count: count() })
                .from(rawCommunicationRecords)
                .where(and(matchStatusClause, allUnmatchedSources))
                .groupBy(rawCommunicationRecords.sourceType);
              for (const g of groupedCounts) {
                const s = g.sourceType === "slack" ? "slack" : g.sourceType === "front" ? "front" : "zoom";
                rawCountsBySource[s] += Number(g.count || 0);
              }
            }
          } catch (err) {
            console.error("[Integrations] unmatched-feed: failed to group counts by source for front-only filter:", err);
          }
        } else if (showDismissedOperational) {
          const baseDismissed = eq(rawCommunicationRecords.matchStatus, "dismissed_operational");
          const dismissedCondition = sourceTypeFilter === "all"
            ? baseDismissed
            : and(baseDismissed, eq(rawCommunicationRecords.sourceType, sourceTypeFilter));

          const [countResult] = await db.select({ count: count() })
            .from(rawCommunicationRecords)
            .where(dismissedCondition);
          rawRecordsTotalCount = Number(countResult?.count || 0);

          try {
            // countsBySource always reflects the unfiltered (per-source)
            // totals so chips remain navigable while a filter is active.
            const groupedCounts = await db
              .select({ sourceType: rawCommunicationRecords.sourceType, count: count() })
              .from(rawCommunicationRecords)
              .where(baseDismissed)
              .groupBy(rawCommunicationRecords.sourceType);
            for (const g of groupedCounts) {
              const s = g.sourceType === "slack" ? "slack" : g.sourceType === "front" ? "front" : "zoom";
              rawCountsBySource[s] += Number(g.count || 0);
            }
          } catch (err) {
            console.error("[Integrations] unmatched-feed: failed to group dismissed counts:", err);
          }

          const remainingLimit = Math.max(0, limit - items.length);
          const remainingOffset = Math.max(0, offset - frontEmails.length);

          if (remainingLimit > 0) {
            const dismissedRecords = await db.select()
              .from(rawCommunicationRecords)
              .where(dismissedCondition)
              .orderBy(sql`${rawCommunicationRecords.timestamp} DESC NULLS LAST`)
              .limit(remainingLimit)
              .offset(remainingOffset);

            for (const record of dismissedRecords) {
              const source = (record.sourceType === "zoom" ? "zoom" : record.sourceType === "slack" ? "slack" : "front") as "zoom" | "slack" | "front";
              const rawP = Array.isArray(record.participantsJson) ? (record.participantsJson as any[]) : [];
              const rawPayload = record.rawPayloadJson as any;
              items.push({
                id: `${source}_${record.id}`,
                source,
                title: record.title || "Communication",
                snippet: record.contentText?.substring(0, 200) || "",
                contentText: record.contentText || null,
                aiSummary: record.aiSummary || null,
                participants: rawP.map((p: any) => p.email || p.name || "Unknown"),
                participantsRaw: rawP.map((p: any) => ({ name: p.name, email: p.email, role: p.role })),
                timestamp: record.timestamp?.toISOString() || record.createdAt?.toISOString() || null,
                suggestedClientId: null,
                suggestedClientName: null,
                matchConfidence: null,
                metadata: {
                  recordId: record.id,
                  externalSourceId: record.externalSourceId,
                  channelName: rawPayload?.channelName || undefined,
                  channelId: rawPayload?.channelId || undefined,
                },
                isDismissedOperational: true,
                operationalReason: record.operationalClassificationReason || null,
              });
            }
          }
        } else {
          // A Zoom record belongs in the unmatched feed if it has no client_id,
          // OR if it has an unresolved review_required agent_match_decision (the
          // agent_review/policy-demotion path can leave a prior client_id set
          // even though the row is awaiting human review). Slack stays
          // client_id IS NULL only — it has no review-queue concept.
          const zoomHasOpenReview = sql`EXISTS (
            SELECT 1 FROM agent_match_decisions amd
            WHERE amd.source_type = 'zoom'
              AND amd.status = 'review_required'
              AND amd.review_resolution IS NULL
              AND (amd.communication_id = ${rawCommunicationRecords.id}
                   OR amd.communication_id = ${rawCommunicationRecords.externalSourceId})
          )`;
          // Per-source unmatched conditions, then optionally narrow by the
          // user-selected source filter.
          const slackUnmatched = and(
            eq(rawCommunicationRecords.sourceType, "slack"),
            isNull(rawCommunicationRecords.clientId),
          );
          const zoomUnmatched = and(
            eq(rawCommunicationRecords.sourceType, "zoom"),
            or(
              isNull(rawCommunicationRecords.clientId),
              zoomHasOpenReview,
            ),
          );
          const allUnmatchedSources = or(slackUnmatched, zoomUnmatched);
          const sourceClause =
            sourceTypeFilter === "slack"
              ? slackUnmatched
              : sourceTypeFilter === "zoom"
                ? zoomUnmatched
                : allUnmatchedSources;
          // Task #904: orphaned rows (parent client deleted) also have
          // client_id IS NULL, so without an explicit guard they would surface
          // in the unmatched feed alongside genuinely-unmatched messages.
          // Exclude them here so the feed only shows real review candidates.
          const matchStatusClause = and(
            or(
              isNull(rawCommunicationRecords.matchStatus),
              ne(rawCommunicationRecords.matchStatus, "dismissed_operational")
            ),
            or(
              isNull(rawCommunicationRecords.matchStatus),
              ne(rawCommunicationRecords.matchStatus, "orphaned")
            ),
          );
          // Conditions for items + count (filtered).
          const conditions = [matchStatusClause, sourceClause];
          // Conditions for groupedCounts (unfiltered per source so chips
          // continue to display the full unfiltered totals).
          const baseGroupConditions = [matchStatusClause, allUnmatchedSources];

          const [countResult] = await db.select({ count: count() })
            .from(rawCommunicationRecords)
            .where(and(...conditions));
          rawRecordsTotalCount = Number(countResult?.count || 0);

          try {
            const groupedCounts = await db
              .select({ sourceType: rawCommunicationRecords.sourceType, count: count() })
              .from(rawCommunicationRecords)
              .where(and(...baseGroupConditions))
              .groupBy(rawCommunicationRecords.sourceType);
            for (const g of groupedCounts) {
              const s = g.sourceType === "slack" ? "slack" : g.sourceType === "front" ? "front" : "zoom";
              rawCountsBySource[s] += Number(g.count || 0);
            }
          } catch (err) {
            console.error("[Integrations] unmatched-feed: failed to group unmatched counts:", err);
          }

          const remainingLimit = Math.max(0, limit - items.length);
          const remainingOffset = Math.max(0, offset - frontEmails.length);

          if (remainingLimit > 0) {
            const unmatchedRecords = await db.select()
              .from(rawCommunicationRecords)
              .where(and(...conditions))
              .orderBy(sql`${rawCommunicationRecords.timestamp} DESC NULLS LAST`)
              .limit(remainingLimit)
              .offset(remainingOffset);

            for (const record of unmatchedRecords) {
              const source = record.sourceType as "zoom" | "slack";
              const rawP = Array.isArray(record.participantsJson) ? (record.participantsJson as any[]) : [];
              const rawPayload = record.rawPayloadJson as any;
              items.push({
                id: `${source}_${record.id}`,
                source,
                title: record.title || (source === "zoom" ? "Zoom Meeting" : "Slack Message"),
                snippet: record.contentText?.substring(0, 200) || "",
                contentText: record.contentText || null,
                aiSummary: record.aiSummary || null,
                participants: rawP.map((p: any) => p.email || p.name || "Unknown"),
                participantsRaw: rawP.map((p: any) => ({ name: p.name, email: p.email, role: p.role })),
                timestamp: record.timestamp?.toISOString() || record.createdAt?.toISOString() || null,
                suggestedClientId: null,
                suggestedClientName: null,
                matchConfidence: null,
                metadata: {
                  recordId: record.id,
                  externalSourceId: record.externalSourceId,
                  channelName: rawPayload?.channelName || undefined,
                  channelId: rawPayload?.channelId || undefined,
                },
              });
            }
          }
        }
      } catch (err: any) {
        // F10 (Task #4156): this swallow is deliberate resilience — the feed
        // degrades to Front-only rather than 500ing — but a DB failure here
        // silently emptied the zoom/slack section with no trace. One log
        // line (admin route, low frequency); swallow semantics unchanged.
        console.error(
          `[Integrations] unmatched-feed: zoom/slack section failed (degrading to front-only): ${err?.message ?? String(err)}`,
        );
        // Task #4229: surface the degradation to the client. Both sources are
        // served by the single raw_communication_records section that just
        // failed, so both are unavailable.
        degradedSources = ["zoom", "slack"];
      }

      try {
        const { decorateActivityFeedZoomReviews } = await import("../../services/activityFeedReview");
        await decorateActivityFeedZoomReviews(items as any);
      } catch (err) {
        console.error("[Integrations] unmatched-feed: failed to attach review block:", err);
      }

      items.sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return tb - ta;
      });

      // Always compute the unfiltered front total so countsBySource.front
      // shows the same value regardless of the active source-chip filter.
      const frontUnfilteredTotal = showDismissedOperational
        ? await storage.countFrontSyncEmailsByStatus("dismissed_operational")
        : await storage.countUnmatchedFrontSyncEmails();
      const frontTotalCount = includeFront ? frontUnfilteredTotal : 0;
      const totalCount = frontTotalCount + rawRecordsTotalCount;
      // countsBySource intentionally reflects the unfiltered totals for each
      // source so the chip group remains useful as a navigation control even
      // after a filter is applied.
      const countsBySource = {
        front: frontUnfilteredTotal + (rawCountsBySource.front || 0),
        slack: rawCountsBySource.slack || 0,
        zoom: rawCountsBySource.zoom || 0,
      };

      let needsReviewCount = 0;
      if (!showDismissedOperational) {
        try {
          const { sql } = await import("drizzle-orm");
          const reviewCountResult = await db.execute(sql`
            SELECT COUNT(*)::int AS count
            FROM agent_match_decisions
            WHERE source_type = 'zoom'
              AND status = 'review_required'
              AND review_resolution IS NULL
          `);
          needsReviewCount = Number((reviewCountResult.rows[0] as any)?.count || 0);
        } catch (err) {
          console.error("[Integrations] unmatched-feed: failed to count needs-review:", err);
        }
      }
      const seenFirmNames = new Set<string>();
      const clientList = Array.from(clientMap.values())
        .filter(c => !c.isArchived)
        .sort((a, b) => (a.firmName || "").localeCompare(b.firmName || ""))
        .filter(c => {
          const name = (c.firmName || "").trim().toLowerCase();
          if (seenFirmNames.has(name)) return false;
          seenFirmNames.add(name);
          return true;
        })
        .map(c => ({ id: c.id, firmName: c.firmName }));
      res.json({
        items,
        totalCount,
        needsReviewCount,
        countsBySource,
        clients: clientList,
        // Task #4229: only present when the zoom/slack section failed —
        // successful responses keep the exact pre-existing envelope.
        ...(degradedSources.length > 0 ? { degradedSources } : {}),
      });
    } catch (error: any) {
      console.error("[Integrations] Unmatched feed error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // F9 (Task #4155): declared body shape — presence claims only; all existing
  // runtime guards below are unchanged (no new validation).
  type AssignUnmatchedBody = {
    clientId?: string;
    addContactEmails?: unknown;
    // Slack-source fields
    channelName?: string;
    senderName?: string;
    senderEmail?: string;
    messageText?: string;
  };
  app.post("/api/integrations/unmatched/:source/:id/assign", isAuthenticated, requireAccountManager, async (req: TenantScopedRequest<{ source: string; id: string }, AssignUnmatchedBody>, res) => {
    try {
      const { source, id } = req.params;
      const { clientId } = req.body;
      if (!clientId) return res.status(400).json({ error: "clientId required" });

      // F9: non-null — isAuthenticated guarantees a session user; the original
      // (req: any) code already relied on presence here.
      const userId = (req.user?.claims?.sub || req.user?.id)!;

      // Task #755 follow-up: emails the operator explicitly opted in to add
      // as client contacts during the manual-match dialog. Default-NO: if
      // the field is missing or empty, no contact is created.
      const addContactEmails: string[] = Array.isArray(req.body?.addContactEmails)
        ? (req.body.addContactEmails as unknown[]).filter((e): e is string => typeof e === "string" && e.includes("@"))
        : [];

      if (source === "front") {
        const { assignUnmatchedEmail } = await import("../../services/frontIntegration");
        const result = await assignUnmatchedEmail(id, clientId, userId, addContactEmails);
        return res.json({
          success: true,
          recordId: result.recordId,
          contactsAdded: result.contactsAdded,
          contactCreated: result.contactCreated,
        });
      }

      if (source === "zoom") {
        const meetingUuid = id.replace(/^zoom_/, "");
        const { listRecentRecordings, ingestMeeting } = await import("../../services/zoomIntegration");
        const meetings = await listRecentRecordings();
        const meeting = meetings.find((m: any) => (m.uuid || m.id?.toString()) === meetingUuid);
        if (!meeting) return res.status(404).json({ error: "Zoom meeting not found in recent recordings" });
        const result = await ingestMeeting(meeting, clientId, userId, false, undefined, undefined, { origin: "user_manual" });
        let zoomContactsAdded = 0;
        let zoomContactCreated = false;
        if (addContactEmails.length > 0) {
          try {
            const { promoteEmailsToClientContact } = await import("../../services/clientContactPromotion");
            const promo = await promoteEmailsToClientContact({
              clientId,
              emails: addContactEmails,
              contactName: meeting.host_email || meeting.topic,
              userId,
              explicitOptIn: true,
            });
            zoomContactsAdded = promo.added;
            zoomContactCreated = promo.createdNewContact;
          } catch (err) {
            console.error(`[Zoom] Operator-confirmed contact promotion failed for client ${clientId}:`, err);
          }
        }
        try {
          const { analyzeCommunication } = await import("../../services/communicationAnalysis");
          analyzeCommunication(result.recordId).catch(console.error);
        } catch {
          // import-only guard; analyzeCommunication logs its own failures
          // via .catch above (F10 disposition: retained)
        }
        // fire-and-forget: response already sent; errors handled inside the IIFE
        void (async () => {
          try {
            // Task #4025: delivery-mode-aware fan-out (in-app + Drive).
            const { deliverZoomRecording } = await import("../../services/clientFileDelivery");
            await deliverZoomRecording(result.recordId, meeting, clientId);
          } catch (err) {
            console.error("[GoogleDrive] Background upload failed on reassignment:", err);
          }
        })();
        return res.json({
          success: true,
          recordId: result.recordId,
          contactsAdded: zoomContactsAdded,
          contactCreated: zoomContactCreated,
        });
      }

      if (source === "slack") {
        const { channelName, senderName, senderEmail, messageText } = req.body;
        const participants = senderEmail ? [{ email: senderEmail, name: senderName }] : senderName ? [{ name: senderName }] : [];
        const title = channelName ? `Slack #${channelName}` : `Slack message ${id}`;
        const { classifyTouchpoint } = await import("@shared/touchpointClassifier");
        const isTouchpoint = classifyTouchpoint({ sourceType: "slack" });
        const record = await storage.createRawCommunication({
          clientId,
          sourceType: "slack",
          sourceSubtype: "slack_channel",
          title,
          timestamp: new Date(),
          externalSourceId: id,
          participantsJson: participants,
          rawPayloadJson: { slackMessageId: id, channelName, senderName, senderEmail },
          contentText: messageText || undefined,
          createdBy: userId,
        }, { isTouchpoint });
        let slackContactsAdded = 0;
        let slackContactCreated = false;
        if (addContactEmails.length > 0) {
          try {
            const { promoteEmailsToClientContact } = await import("../../services/clientContactPromotion");
            const promo = await promoteEmailsToClientContact({
              clientId,
              emails: addContactEmails,
              contactName: senderName || undefined,
              userId,
              explicitOptIn: true,
            });
            slackContactsAdded = promo.added;
            slackContactCreated = promo.createdNewContact;
          } catch (err) {
            console.error(`[Slack] Operator-confirmed contact promotion failed for client ${clientId}:`, err);
          }
        }
        return res.json({
          success: true,
          recordId: record.id,
          contactsAdded: slackContactsAdded,
          contactCreated: slackContactCreated,
        });
      }

      return res.status(400).json({ error: "Unsupported source" });
    } catch (error: any) {
      console.error("[Integrations] Assign error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // #662: Undo a Command-Panel claim. Reverts the raw record to unmatched
  // (clears client_id, match_method, match_status, match_confidence), removes
  // the corresponding communication_client_links row(s) for the claimed
  // client, and stamps the most-recent `claimed` agent_match_decisions row as
  // `not_claimed` with `correctedByHuman=true` so the audit trail records the
  // reversal. Body: { recordId: string }.
  app.post("/api/integrations/unmatched/undo-claim", isAuthenticated, requireAccountManager, async (req: AuthenticatedRequest, res) => {
    try {
      const { recordId } = (req.body || {}) as { recordId?: unknown };
      if (!recordId || typeof recordId !== "string") {
        return res.status(400).json({ error: "recordId required" });
      }
      const userId = req.user?.claims?.sub || req.user?.id;
      const record = await storage.getRawCommunication(recordId);
      if (!record) return res.status(404).json({ error: "Record not found" });
      if (record.matchMethod !== "manual_command_panel") {
        return res.status(400).json({
          error: "Only Command Panel claims can be undone via this endpoint",
        });
      }
      const claimedClientId = record.clientId;

      // 1) revert raw record
      await storage.updateRawCommunication(recordId, {
        clientId: null,
        matchMethod: null,
        matchStatus: null,
        matchConfidence: null,
      });

      // Track which sub-steps failed so the operator can see partial state
      // instead of getting a misleading "success" toast when cleanup stalls.
      const partialFailures: string[] = [];

      // 2) remove client links pointing at the claimed client
      try {
        const links = await storage.listCommunicationClientLinks(recordId);
        for (const link of links) {
          if (!claimedClientId || link.clientId === claimedClientId) {
            await storage.deleteCommunicationClientLink(link.id);
          }
        }
      } catch (err) {
        console.error("[Integrations] undo-claim: link cleanup failed:", err);
        partialFailures.push("communication_links");
      }

      // 2b) delete the key-call / RER rows the original claim created.
      let keyCallsDeleted = 0;
      let rerRecordingsDeleted = 0;
      try {
        keyCallsDeleted = await storage.deleteKeyCallsByRawCommunication(
          recordId,
          claimedClientId ?? undefined,
        );
      } catch (err) {
        console.error("[Integrations] undo-claim: key-call cleanup failed:", err);
        partialFailures.push("key_calls");
      }
      try {
        rerRecordingsDeleted = await storage.deleteRerRecordingsByRawCommunication(
          recordId,
          claimedClientId ?? undefined,
        );
      } catch (err) {
        console.error("[Integrations] undo-claim: RER cleanup failed:", err);
        partialFailures.push("rer_recordings");
      }

      // 3) stamp the latest claim decision as reverted
      try {
        const lookupKeys = [recordId];
        if (record.externalSourceId) lookupKeys.push(record.externalSourceId);
        type DecisionRow = Awaited<ReturnType<typeof storage.listAgentMatchDecisions>>[number];
        const decisions: DecisionRow[] = [];
        for (const key of lookupKeys) {
          const partial = await storage.listAgentMatchDecisions({
            communicationId: key,
            ...(claimedClientId ? { clientId: claimedClientId } : {}),
          });
          decisions.push(...partial);
        }
        const claimDecision = decisions
          .filter((d) => d.status === "claimed")
          .sort(
            (a, b) =>
              (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
          )[0];
        if (claimDecision) {
          await storage.updateAgentMatchDecision(claimDecision.id, {
            status: "not_claimed",
            correctedByHuman: true,
            reviewedByUserId: userId,
            reviewedAt: new Date(),
            explanationSummary:
              (claimDecision.explanationSummary
                ? claimDecision.explanationSummary + " · "
                : "") + "Reverted via Command Panel undo",
          });
        }
      } catch (err) {
        console.error("[Integrations] undo-claim: decision update failed:", err);
        partialFailures.push("agent_match_decision");
      }

      // 4) penalize the memory signals that drove the (now-undone) claim so the
      // matching agent learns from the reversal.
      return res.json({
        success: true,
        recordId,
        keyCallsDeleted,
        rerRecordingsDeleted,
        partialFailures,
      });
    } catch (error: any) {
      console.error("[Integrations] undo-claim error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/integrations/unmatched/:source/:id/dismiss", isAuthenticated, requireAccountManager, async (req: AuthenticatedRequest<{ source: string; id: string }, { reason?: unknown }>, res) => {
    try {
      const { source, id } = req.params;
      // F9: non-null — isAuthenticated guarantees a session user; the original
      // (req: any) code already relied on presence here.
      const userId = (req.user?.claims?.sub || req.user?.id)!;

      if (source === "front") {
        // Task #1269: optional freeform reason from the row-level dismiss
        // dialog. Mirrors the bulk-dismiss flow (which has always required a
        // reason); for single-row triage the field is optional so trivial
        // cases stay one-click. When provided, it's persisted on the
        // front_sync_emails row for operator audit.
        const rawReason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
        // Cap at 2 KB so a runaway client payload can't bloat the
        // operational_classification_reason column or the classifier
        // content stream. Matches the practical limit of the bulk-dismiss
        // textarea and stays well under any sane Postgres TEXT usage.
        const reason = rawReason?.trim().slice(0, 2000) || undefined;

        const { dismissUnmatchedEmail } = await import("../../services/frontIntegration");
        await dismissUnmatchedEmail(id, userId, reason);

        return res.json({ success: true });
      }

      if (source === "slack" || source === "zoom") {
        const recordId = id.startsWith(`${source}_`) ? id.slice(source.length + 1) : id;
        const record = await storage.getRawCommunication(recordId);
        if (!record) {
          return res.status(404).json({ error: "Record not found" });
        }

        await storage.updateRawCommunication(recordId, {
          matchStatus: "dismissed",
          operationalClassificationReason: `Dismissed by user`,
        });

        return res.json({ success: true });
      }

      return res.status(400).json({ error: "Dismiss not supported for this source" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/integrations/unmatched/:source/:id/block", isAuthenticated, requireAccountManager, async (req: AuthenticatedRequest<{ source: string; id: string }>, res) => {
    try {
      const { source, id } = req.params;
      const userId = req.user?.claims?.sub || req.user?.id;

      if (source === "front") {
        await storage.updateFrontSyncEmail(id, {
          matchStatus: "blocked",
          dismissedBy: userId,
          processedAt: new Date(),
        });

        return res.json({ success: true });
      }

      if (source === "slack" || source === "zoom") {
        const recordId = id.startsWith(`${source}_`) ? id.slice(source.length + 1) : id;
        const record = await storage.getRawCommunication(recordId);
        if (!record) {
          return res.status(404).json({ error: "Record not found" });
        }

        await storage.updateRawCommunication(recordId, {
          matchStatus: "blocked",
          operationalClassificationReason: `Blocked by user`,
        });

        return res.json({ success: true });
      }

      return res.status(400).json({ error: "Block not supported for this source" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/integrations/unmatched/:source/:id/promote", isAuthenticated, requireAccountManager, async (req: AuthenticatedRequest<{ source: string; id: string }>, res) => {
    try {
      const { source, id } = req.params;

      if (source === "front") {
        await storage.updateFrontSyncEmail(id, {
          matchStatus: "unmatched",
          operationalClassificationReason: null,
          processedAt: null,
        });

        // Task #2637: promote simply returns the row to the unmatched pool.
        // Deterministic re-matching happens through the normal reprocess
        // path; there is no AI re-evaluation or memory learning.

        return res.json({ success: true });
      }

      if (source === "slack" || source === "zoom") {
        const recordId = id.replace(/^(slack|zoom)_/, "");
        await storage.updateRawCommunication(recordId, {
          matchStatus: "unmatched",
          operationalClassificationReason: null,
          processingStatus: "pending",
        });

        return res.json({ success: true });
      }

      return res.status(400).json({ error: "Promote not supported for this source" });
    } catch (error: any) {
      console.error("[Integrations] Promote error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------------------------------------------------
  // Bulk noise triage (QA fix, Task #5324): the "By Sender" toggle and the
  // "Dismiss all from …" chips on each card in UnmatchedFeedSection.tsx have
  // always called these exact paths, but no server route ever existed for
  // them — every click 404'd silently (mutations use `meta: { silent: true }`
  // and the count-preview fetch swallows errors into `count: null`). These
  // routes close that gap using the same match_status="dismissed_operational"
  // convention and the same per-item auth guard as the routes above; a bulk
  // dismiss is reversible the same way a single dismiss is (via /promote, or
  // the "Dismissed as Operational" view).
  //
  // Scope is intentionally narrower than the general unmatched-feed
  // definition: only rows with no client_id are touched (front_sync_emails,
  // plus slack/zoom raw records), so a zoom recording still awaiting human
  // review on an already-claimed client is never silently dismissed.
  const rawRecordUnmatchedCondition = and(
    inArray(rawCommunicationRecords.sourceType, ["slack", "zoom"]),
    sql`${rawCommunicationRecords.clientId} IS NULL`,
    sql`(${rawCommunicationRecords.matchStatus} IS NULL OR ${rawCommunicationRecords.matchStatus} NOT IN ('dismissed_operational', 'orphaned', 'dismissed', 'blocked'))`,
  );

  function participantEmailCondition(column: any, senderEmail: string) {
    return sql`EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(${column}, '[]'::jsonb)) AS p
      WHERE LOWER(p->>'email') = ${senderEmail.toLowerCase()}
    )`;
  }

  function participantDomainCondition(column: any, domain: string) {
    const domainLike = `%@${domain.toLowerCase()}`;
    return sql`EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(${column}, '[]'::jsonb)) AS p
      WHERE LOWER(p->>'email') LIKE ${domainLike}
    )`;
  }

  app.get("/api/integrations/unmatched-by-sender", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
      const rows = await db.execute(sql`
        SELECT LOWER(p->>'email') AS "senderEmail", COUNT(DISTINCT fse.id)::int AS "count"
        FROM front_sync_emails fse,
             jsonb_array_elements(COALESCE(fse.participants_json, '[]'::jsonb)) AS p
        WHERE fse.match_status = 'unmatched'
          AND p->>'email' IS NOT NULL
          AND (p->>'role' IS NULL OR p->>'role' IN ('external', 'team', 'from', 'sender'))
        GROUP BY LOWER(p->>'email')
        ORDER BY "count" DESC, "senderEmail" ASC
        LIMIT ${limit}
      `);
      const senders = (rows.rows as Array<{ senderEmail: string; count: number }>).map(r => ({
        senderEmail: r.senderEmail,
        count: Number(r.count),
      }));
      res.json({ senders });
    } catch (error: any) {
      console.error("[Integrations] unmatched-by-sender error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/count-by-sender", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const senderEmail = String(req.query.senderEmail || "").trim();
      if (!senderEmail) return res.status(400).json({ error: "senderEmail required" });
      const [frontCount] = await db.select({ count: sql<number>`count(*)::int` })
        .from(frontSyncEmails)
        .where(and(eq(frontSyncEmails.matchStatus, "unmatched"), participantEmailCondition(frontSyncEmails.participantsJson, senderEmail)));
      const [rawCount] = await db.select({ count: sql<number>`count(*)::int` })
        .from(rawCommunicationRecords)
        .where(and(rawRecordUnmatchedCondition, participantEmailCondition(rawCommunicationRecords.participantsJson, senderEmail)));
      res.json({ count: Number(frontCount?.count || 0) + Number(rawCount?.count || 0) });
    } catch (error: any) {
      console.error("[Integrations] count-by-sender error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/count-by-domain", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const domain = String(req.query.domain || "").trim();
      if (!domain) return res.status(400).json({ error: "domain required" });
      const [frontCount] = await db.select({ count: sql<number>`count(*)::int` })
        .from(frontSyncEmails)
        .where(and(eq(frontSyncEmails.matchStatus, "unmatched"), participantDomainCondition(frontSyncEmails.participantsJson, domain)));
      const [rawCount] = await db.select({ count: sql<number>`count(*)::int` })
        .from(rawCommunicationRecords)
        .where(and(rawRecordUnmatchedCondition, participantDomainCondition(rawCommunicationRecords.participantsJson, domain)));
      res.json({ count: Number(frontCount?.count || 0) + Number(rawCount?.count || 0) });
    } catch (error: any) {
      console.error("[Integrations] count-by-domain error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/count-by-channel", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const channelName = String(req.query.channelName || "").trim();
      if (!channelName) return res.status(400).json({ error: "channelName required" });
      const [rawCount] = await db.select({ count: sql<number>`count(*)::int` })
        .from(rawCommunicationRecords)
        .where(and(
          eq(rawCommunicationRecords.sourceType, "slack"),
          rawRecordUnmatchedCondition,
          sql`${rawCommunicationRecords.rawPayloadJson}->>'channelName' = ${channelName}`,
        ));
      res.json({ count: Number(rawCount?.count || 0) });
    } catch (error: any) {
      console.error("[Integrations] count-by-channel error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/integrations/bulk-dismiss-by-sender", isAuthenticated, requireAccountManager, async (req: AuthenticatedRequest, res) => {
    try {
      const senderEmail = String((req.body as any)?.senderEmail || "").trim();
      if (!senderEmail) return res.status(400).json({ error: "senderEmail required" });
      const userId = req.user?.claims?.sub || req.user?.id;
      const frontResult = await db.update(frontSyncEmails)
        .set({ matchStatus: "dismissed_operational", dismissedBy: userId, processedAt: new Date(), operationalClassificationReason: `Bulk dismissed: sender ${senderEmail}` })
        .where(and(eq(frontSyncEmails.matchStatus, "unmatched"), participantEmailCondition(frontSyncEmails.participantsJson, senderEmail)))
        .returning({ id: frontSyncEmails.id });
      const rawResult = await db.update(rawCommunicationRecords)
        .set({ matchStatus: "dismissed_operational", operationalClassificationReason: `Bulk dismissed: sender ${senderEmail}` })
        .where(and(rawRecordUnmatchedCondition, participantEmailCondition(rawCommunicationRecords.participantsJson, senderEmail)))
        .returning({ id: rawCommunicationRecords.id });
      res.json({ success: true, dismissed: frontResult.length + rawResult.length, senderEmail });
    } catch (error: any) {
      console.error("[Integrations] bulk-dismiss-by-sender error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/integrations/bulk-dismiss-by-domain", isAuthenticated, requireAccountManager, async (req: AuthenticatedRequest, res) => {
    try {
      const domain = String((req.body as any)?.domain || "").trim();
      if (!domain) return res.status(400).json({ error: "domain required" });
      const userId = req.user?.claims?.sub || req.user?.id;
      const frontResult = await db.update(frontSyncEmails)
        .set({ matchStatus: "dismissed_operational", dismissedBy: userId, processedAt: new Date(), operationalClassificationReason: `Bulk dismissed: domain @${domain}` })
        .where(and(eq(frontSyncEmails.matchStatus, "unmatched"), participantDomainCondition(frontSyncEmails.participantsJson, domain)))
        .returning({ id: frontSyncEmails.id });
      const rawResult = await db.update(rawCommunicationRecords)
        .set({ matchStatus: "dismissed_operational", operationalClassificationReason: `Bulk dismissed: domain @${domain}` })
        .where(and(rawRecordUnmatchedCondition, participantDomainCondition(rawCommunicationRecords.participantsJson, domain)))
        .returning({ id: rawCommunicationRecords.id });
      res.json({ success: true, dismissed: frontResult.length + rawResult.length, domain });
    } catch (error: any) {
      console.error("[Integrations] bulk-dismiss-by-domain error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/integrations/bulk-dismiss-by-channel", isAuthenticated, requireAccountManager, async (req: AuthenticatedRequest, res) => {
    try {
      const channelName = String((req.body as any)?.channelName || "").trim();
      if (!channelName) return res.status(400).json({ error: "channelName required" });
      const rawResult = await db.update(rawCommunicationRecords)
        .set({ matchStatus: "dismissed_operational", operationalClassificationReason: `Bulk dismissed: channel #${channelName}` })
        .where(and(
          eq(rawCommunicationRecords.sourceType, "slack"),
          rawRecordUnmatchedCondition,
          sql`${rawCommunicationRecords.rawPayloadJson}->>'channelName' = ${channelName}`,
        ))
        .returning({ id: rawCommunicationRecords.id });
      res.json({ success: true, dismissed: rawResult.length, channelName });
    } catch (error: any) {
      console.error("[Integrations] bulk-dismiss-by-channel error:", error);
      res.status(500).json({ error: error.message });
    }
  });

}
