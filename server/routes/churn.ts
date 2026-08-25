/**
 * Task #3691 — Churn Command Center: portfolio-wide churn early-warning
 * leaderboard API.
 *
 * GET /api/churn/leaderboard — director-gated. The gate is STRICT: unlike
 * most route gates it does not open under permissive mode, so any user
 * below director authority gets a 403 in all modes (see
 * canAccessChurnCommandCenter in server/auth/permissions.ts).
 *
 * Returns one entry per active (non-archived, non-demo) client with:
 *   - latest daily judgment, in full: status / riskScore / headline /
 *     judgmentDate plus the judgment's readable content (summaryText,
 *     narrativeSummary, changeSummary, sentimentSummary, concernsJson,
 *     keyRisks, actionsJson, winsJson, keyOpportunities), evidence fields
 *     (unresolvedAskCount, communicationsAnalyzed, dataSourcesSummary,
 *     confidence, confidenceLevel, generatedFromStartAt/EndAt) and
 *     statusSince — the first judgment date of the current consecutive
 *     same-status run
 *   - latest relationship-signal sub-scores (sentiment, complaint, trust,
 *     responsiveness, execution, lead-volume, unresolved-task, health)
 *   - 7/30-day risk deltas: latest riskScore minus the most recent SCORED
 *     judgment dated at least 7/30 days before the latest judgment
 *     (positive delta = risk went UP = worsening)
 *   - latest engagement snapshot facts (daysSinceLastInbound,
 *     daysSinceLastCallMeeting, inbound30d, outbound30d) so the board can
 *     show observable recency next to the AI judgment
 *   - reportMetrics: real lead/review counts from the newest monthly-report
 *     marketing sections (latest month, prior month for the ~30d direction,
 *     and the average of up to 3 pre-latest months for the ~90d direction),
 *     read with the same canonical extraction as the client-facing report
 *     trend — no-evidence months come back null, never a fabricated 0
 *   - account owner (id, display name, avatar)
 *
 * Clients with no judgment rows come back with judgment=null so the UI can
 * show them in a "No data" bucket instead of dropping them silently.
 *
 * Read-only aggregation over what the daily-judgment cron already writes —
 * no new scoring happens here. Runs on the request-scoped API pool `db`,
 * same as the dashboard aggregation in server/routes/clients.ts.
 */
import type { Express } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { isAuthenticated } from "../middlewares/requireAuth";
import { canAccessChurnCommandCenter } from "../auth/permissions";
import { loadGoingQuietSettings, measureGoingQuietFeedFreshness } from "../services/goingQuiet";
import {
  fetchOpenAsksRollup,
  openAskRollupSortOptions,
  type OpenAskRollupSort,
} from "../services/openAsksRollup";
import {
  amCoachingReports,
  amCoachingRuns,
  churnRadarRuns,
  churnRadarClientResults,
  churnRadarFindings,
  churnRadarThemeLabels,
  users,
  type ChurnRadarRun,
  type ChurnRadarSynthesis,
  type ChurnRadarThemeCategory,
} from "@shared/schema";
import { fetchTeamTrends } from "../services/churnTeamTrends";
import { readMonthLeadsReviews } from "@shared/reportMetrics";
import { startAmCoachingRun } from "../services/amCoachingRun";
import { startChurnRadarSweep } from "../services/churnRiskRadar";
import { insertClientConcernIntelSchema } from "@shared/schema";
import { mirrorOperatorIntelToKnowledge } from "../services/agentKnowledgeService";
import { classifyStabilityTriage } from "../services/stabilityTriage";
import { toAccountRatingPresentation } from "../services/judgmentTierGate";

// Task #4292 — focused write-boundary schema for POST /api/churn/concern-intel:
// the insert schema minus audit columns (createdBy comes from the session),
// .strict() so unknown keys are rejected rather than silently dropped.
const concernIntelBodySchema = insertClientConcernIntelSchema
  .omit({ createdBy: true })
  .strict();

export function registerChurnRoutes(app: Express) {
  app.get("/api/churn/leaderboard", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      if (!(await canAccessChurnCommandCenter(user))) {
        return res.status(403).json({ error: "Director access required" });
      }

      // One aggregation pass. judgment_date / signal_date are 'YYYY-MM-DD'
      // varchars, so lexicographic DESC is chronological DESC; the ::date
      // casts in the baseline CTEs are guarded by the ISO-shape regex so a
      // malformed legacy row degrades to "no baseline" instead of a 500.
      const result = await db.execute(sql`
        WITH active_clients AS (
          SELECT c.id, c.firm_name, c.client_code, c.owner_id,
                 u.first_name AS owner_first_name,
                 u.last_name  AS owner_last_name,
                 u.email      AS owner_email,
                 u.profile_image_url AS owner_avatar
          FROM clients c
          LEFT JOIN users u ON u.id = c.owner_id
          WHERE COALESCE(c.is_archived, false) = false
            AND COALESCE(c.is_demo, false) = false
            -- Task #4330: lead-stage records are prospects, not churnable clients
            AND COALESCE(c.lifecycle_stage, 'customer') = 'customer'
        ),
        latest_judgment AS (
          SELECT DISTINCT ON (j.client_id)
                 j.client_id,
                 j.id AS judgment_id,
                 j.status,
                 j.risk_score,
                  j.relationship_health,
                  j.relationship_status,
                 COALESCE(NULLIF(j.headline, ''), j.summary_text) AS headline,
                 j.judgment_date,
                 j.summary_text,
                 j.narrative_summary,
                 j.change_summary,
                 j.sentiment_summary,
                 j.concerns_json,
                 j.key_risks,
                 j.actions_json,
                 j.wins_json,
                 j.key_opportunities,
                 j.unresolved_ask_count,
                 j.communications_analyzed,
                 j.data_sources_summary,
                 j.confidence,
                 j.confidence_level,
                 j.generated_from_start_at,
                 j.generated_from_end_at
          FROM client_daily_judgments j
          WHERE j.client_id IN (SELECT id FROM active_clients)
          ORDER BY j.client_id, j.judgment_date DESC, j.created_at DESC
        ),
        baseline_7d AS (
          SELECT DISTINCT ON (j.client_id) j.client_id, j.risk_score
          FROM client_daily_judgments j
          JOIN latest_judgment l ON l.client_id = j.client_id
          WHERE j.risk_score IS NOT NULL
            AND j.judgment_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            AND l.judgment_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            AND j.judgment_date::date <= l.judgment_date::date - 7
          ORDER BY j.client_id, j.judgment_date DESC, j.created_at DESC
        ),
        baseline_30d AS (
          SELECT DISTINCT ON (j.client_id) j.client_id, j.risk_score
          FROM client_daily_judgments j
          JOIN latest_judgment l ON l.client_id = j.client_id
          WHERE j.risk_score IS NOT NULL
            AND j.judgment_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            AND l.judgment_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            AND j.judgment_date::date <= l.judgment_date::date - 30
          ORDER BY j.client_id, j.judgment_date DESC, j.created_at DESC
        ),
        latest_signals AS (
          SELECT DISTINCT ON (s.client_id)
                 s.client_id,
                 s.signal_date,
                 s.sentiment_score,
                 s.complaint_score,
                 s.trust_score,
                 s.responsiveness_risk_score,
                 s.execution_risk_score,
                 s.lead_volume_concern_score,
                 s.unresolved_task_score,
                 s.relationship_health_score
          FROM client_relationship_signals s
          WHERE s.client_id IN (SELECT id FROM active_clients)
          ORDER BY s.client_id, s.signal_date DESC, s.created_at DESC
        ),
        status_streak AS (
          -- First judgment date of the CURRENT consecutive same-status run:
          -- the earliest latest-status row dated after the client's most
          -- recent different-status row. judgment_date is an ISO
          -- 'YYYY-MM-DD' varchar, so lexicographic compare is chronological;
          -- COALESCE('') makes a never-changed history reach the oldest row.
          SELECT l.client_id,
                 MIN(j.judgment_date) AS status_since
          FROM latest_judgment l
          JOIN client_daily_judgments j
            ON j.client_id = l.client_id
           AND j.status = l.status
          WHERE j.judgment_date > COALESCE((
                  SELECT MAX(j2.judgment_date)
                  FROM client_daily_judgments j2
                  WHERE j2.client_id = l.client_id
                    AND j2.status IS DISTINCT FROM l.status
                ), '')
          GROUP BY l.client_id
        ),
        latest_engagement AS (
          SELECT DISTINCT ON (e.client_id)
                 e.client_id,
                 e.snapshot_date,
                 e.days_since_last_inbound,
                 e.days_since_last_call_meeting,
                 e.inbound_30d,
                 e.outbound_30d
          FROM client_engagement_snapshots e
          WHERE e.client_id IN (SELECT id FROM active_clients)
          ORDER BY e.client_id, e.snapshot_date DESC, e.created_at DESC
        ),
        report_metrics AS (
          -- Newest 4 monthly-report marketing sections per client: latest
          -- month + prior month (~30d direction) + up to 3 pre-latest months
          -- (~90d average). The JSONB payloads are decoded in JS with the
          -- same canonical readers the client-facing report trend uses.
          SELECT t.client_id,
                 json_agg(json_build_object('month', t.report_month, 'marketing', t.data)
                          ORDER BY t.report_month DESC) AS report_months
          FROM (
            SELECT r.client_id, r.report_month, rs.data,
                   row_number() OVER (PARTITION BY r.client_id ORDER BY r.report_month DESC) AS rn
            FROM reports r
            JOIN report_sections rs ON rs.report_id = r.id AND rs.section_key = 'marketing'
            WHERE r.client_id IN (SELECT id FROM active_clients)
          ) t
          WHERE t.rn <= 4
          GROUP BY t.client_id
        ),
        recent_intel AS (
          -- Task #4292 — operator concern intel from the last 90 days,
          -- newest first, attributed. Matched to displayed concerns in JS.
          SELECT ci.client_id,
                 json_agg(json_build_object(
                   'id', ci.id,
                   'judgmentId', ci.judgment_id,
                   'concernText', ci.concern_text,
                   'intelType', ci.intel_type,
                   'note', ci.note,
                   'createdBy', ci.created_by,
                   'createdByName', COALESCE(NULLIF(TRIM(CONCAT(iu.first_name, ' ', iu.last_name)), ''), iu.email),
                   'createdAt', ci.created_at
                 ) ORDER BY ci.created_at DESC) AS intel_entries
          FROM client_concern_intel ci
          LEFT JOIN users iu ON iu.id = ci.created_by
          WHERE ci.client_id IN (SELECT id FROM active_clients)
            AND ci.created_at >= NOW() - INTERVAL '90 days'
          GROUP BY ci.client_id
        )
        SELECT a.id, a.firm_name, a.client_code, a.owner_id,
               a.owner_first_name, a.owner_last_name, a.owner_email, a.owner_avatar,
               l.judgment_id, l.status, l.risk_score,
               l.relationship_health, l.relationship_status,
               l.headline, l.judgment_date,
               l.summary_text, l.narrative_summary, l.change_summary,
               l.sentiment_summary, l.concerns_json, l.key_risks,
               l.actions_json, l.wins_json, l.key_opportunities,
               l.unresolved_ask_count, l.communications_analyzed,
               l.data_sources_summary, l.confidence, l.confidence_level,
               l.generated_from_start_at, l.generated_from_end_at,
               ss.status_since,
               b7.risk_score  AS baseline_risk_7d,
               b30.risk_score AS baseline_risk_30d,
               s.signal_date, s.sentiment_score, s.complaint_score, s.trust_score,
               s.responsiveness_risk_score, s.execution_risk_score,
               s.lead_volume_concern_score, s.unresolved_task_score,
               s.relationship_health_score,
               e.snapshot_date, e.days_since_last_inbound,
               e.days_since_last_call_meeting, e.inbound_30d, e.outbound_30d,
               rm.report_months,
               ri.intel_entries
        FROM active_clients a
        LEFT JOIN latest_judgment l ON l.client_id = a.id
        LEFT JOIN status_streak ss ON ss.client_id = a.id
        LEFT JOIN baseline_7d  b7  ON b7.client_id  = a.id
        LEFT JOIN baseline_30d b30 ON b30.client_id = a.id
        LEFT JOIN latest_signals s ON s.client_id = a.id
        LEFT JOIN latest_engagement e ON e.client_id = a.id
        LEFT JOIN report_metrics rm ON rm.client_id = a.id
        LEFT JOIN recent_intel ri ON ri.client_id = a.id
        ORDER BY (l.risk_score IS NULL), l.risk_score DESC, a.firm_name ASC
      `);

      const rows: any[] = (result as any).rows ?? [];
      const toNum = (v: unknown): number | null =>
        v === null || v === undefined ? null : Number(v);
      const toIso = (v: unknown): string | null =>
        v instanceof Date ? v.toISOString() : typeof v === "string" && v ? v : null;

      // Real lead/review numbers from the same monthly-report marketing
      // sections the client-facing report trend renders (see trendData in
      // server/routes/reports.ts). Extraction lives in
      // shared/reportMetrics.readMonthLeadsReviews — the daily judgment's
      // multi-month report history uses the SAME function (Task #4292).
      const readMonthMetrics = (
        entry: any,
      ): { month: string; leads: number | null; reviews: number | null } | null =>
        readMonthLeadsReviews(entry?.month, entry?.marketing);
      const avgOf = (vals: number[]): number | null =>
        vals.length > 0
          ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
          : null;
      const buildReportMetrics = (raw: unknown) => {
        const entries = Array.isArray(raw) ? raw : [];
        const months = entries
          .map(readMonthMetrics)
          .filter((v): v is NonNullable<ReturnType<typeof readMonthMetrics>> => v !== null);
        if (months.length === 0) return null;
        const latest = months[0];
        const prev = months[1] ?? null;
        const prior = months.slice(1); // up to 3 pre-latest months (~90d view)
        const leadsPriorVals = prior.map((p) => p.leads).filter((v): v is number => v !== null);
        const reviewsPriorVals = prior.map((p) => p.reviews).filter((v): v is number => v !== null);
        return {
          latestMonth: latest.month,
          leads: latest.leads,
          reviews: latest.reviews,
          prevMonth: prev?.month ?? null,
          leadsPrev: prev?.leads ?? null,
          reviewsPrev: prev?.reviews ?? null,
          leadsAvg90: avgOf(leadsPriorVals),
          reviewsAvg90: avgOf(reviewsPriorVals),
          leadsMonthsInAvg: leadsPriorVals.length,
          reviewsMonthsInAvg: reviewsPriorVals.length,
        };
      };

      // Task #4292 — match recent operator intel to the concerns the card
      // displays (keyRisks falling back to concernsJson, mirroring the UI's
      // pick) by normalized text so operators see "addressed" inline.
      const normalizeConcern = (s: unknown): string =>
        typeof s === "string"
          ? s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim()
          : "";
      const buildConcernIntel = (rawEntries: unknown, displayedConcerns: string[]) => {
        const entries = Array.isArray(rawEntries) ? rawEntries : [];
        const normalized = displayedConcerns.map(normalizeConcern);
        return entries.map((e: any) => {
          const matchIdx = normalized.indexOf(normalizeConcern(e?.concernText));
          return {
            id: e?.id as string,
            judgmentId: (e?.judgmentId ?? null) as string | null,
            concernText: (e?.concernText ?? "") as string,
            intelType: (e?.intelType ?? "context") as string,
            note: (e?.note ?? "") as string,
            createdBy: (e?.createdBy ?? null) as string | null,
            createdByName: (e?.createdByName ?? null) as string | null,
            createdAt: (e?.createdAt ?? null) as string | null,
            matchedConcern: matchIdx >= 0 ? displayedConcerns[matchIdx] : null,
          };
        });
      };

      const clients = rows.map((r: any) => {
        const riskScore = toNum(r.risk_score);
        const base7 = toNum(r.baseline_risk_7d);
        const base30 = toNum(r.baseline_risk_30d);
        const displayedConcerns: string[] = (() => {
          const keyRisks = Array.isArray(r.key_risks) ? r.key_risks : [];
          if (keyRisks.length > 0) return keyRisks.filter((v: unknown) => typeof v === "string");
          const concerns = Array.isArray(r.concerns_json) ? r.concerns_json : [];
          return concerns.filter((v: unknown) => typeof v === "string");
        })();
        return {
          clientId: r.id as string,
          firmName: r.firm_name as string,
          clientCode: (r.client_code ?? null) as string | null,
          ownerId: (r.owner_id ?? null) as string | null,
          ownerName:
            [r.owner_first_name, r.owner_last_name].filter(Boolean).join(" ") ||
            r.owner_email ||
            null,
          ownerAvatar: (r.owner_avatar ?? null) as string | null,
          judgment: r.judgment_date
            ? {
                judgmentId: (r.judgment_id ?? null) as string | null,
                status: r.status as string,
                riskScore,
                headline: (r.headline ?? null) as string | null,
                judgmentDate: r.judgment_date as string,
                summaryText: (r.summary_text ?? null) as string | null,
                narrativeSummary: (r.narrative_summary ?? null) as string | null,
                changeSummary: (r.change_summary ?? null) as string | null,
                sentimentSummary: (r.sentiment_summary ?? null) as string | null,
                concernsJson: r.concerns_json ?? null,
                keyRisks: r.key_risks ?? null,
                actionsJson: r.actions_json ?? null,
                winsJson: r.wins_json ?? null,
                keyOpportunities: r.key_opportunities ?? null,
                unresolvedAskCount: toNum(r.unresolved_ask_count),
                communicationsAnalyzed: toNum(r.communications_analyzed),
                dataSourcesSummary: r.data_sources_summary ?? null,
                confidence: (r.confidence ?? null) as string | null,
                confidenceLevel: (r.confidence_level ?? null) as string | null,
                generatedFromStartAt: toIso(r.generated_from_start_at),
                generatedFromEndAt: toIso(r.generated_from_end_at),
                statusSince: (r.status_since ?? null) as string | null,
                rating: toAccountRatingPresentation({
                  status: r.status,
                  relationship: r.relationship_health ?? r.relationship_status,
                  riskScore,
                  judgmentDate: r.judgment_date,
                  dataSourcesSummary: r.data_sources_summary,
                }),
              }
            : null,
          signals: r.signal_date
            ? {
                signalDate: r.signal_date as string,
                sentimentScore: toNum(r.sentiment_score),
                complaintScore: toNum(r.complaint_score),
                trustScore: toNum(r.trust_score),
                responsivenessRiskScore: toNum(r.responsiveness_risk_score),
                executionRiskScore: toNum(r.execution_risk_score),
                leadVolumeConcernScore: toNum(r.lead_volume_concern_score),
                unresolvedTaskScore: toNum(r.unresolved_task_score),
                relationshipHealthScore: toNum(r.relationship_health_score),
              }
            : null,
          engagement: r.snapshot_date
            ? {
                snapshotDate: r.snapshot_date as string,
                daysSinceLastInbound: toNum(r.days_since_last_inbound),
                daysSinceLastCallMeeting: toNum(r.days_since_last_call_meeting),
                inbound30d: toNum(r.inbound_30d),
                outbound30d: toNum(r.outbound_30d),
              }
            : null,
          reportMetrics: buildReportMetrics(r.report_months),
          concernIntel: buildConcernIntel(r.intel_entries, displayedConcerns),
          riskDelta7d:
            riskScore !== null && base7 !== null ? riskScore - base7 : null,
          riskDelta30d:
            riskScore !== null && base30 !== null ? riskScore - base30 : null,
        };
      });

      res.json({ clients, generatedAt: new Date().toISOString() });
    } catch (error) {
      console.error("[ChurnLeaderboard] Failed to build leaderboard:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  /**
   * Task #4292 — operator concern intel: append-only response to a flagged
   * concern ("add context" or "mark resolved" + note). Same STRICT director
   * gate. createdBy comes from the session, never the body (persistence
   * write-boundary convention). Each save is mirrored into the agent
   * knowledge base (operator_intel category) best-effort — the intel row is
   * the source of record, so a mirror failure logs loudly but still 201s.
   */
  // Task #4812 — re-score progress for the leaderboard banner: how much of
  // the active book's latest judgments are on the current prompt revision,
  // and whether a re-judge drain is running anywhere in the cluster. Same
  // strict director gate as the leaderboard (this is churn-surface data).
  // Dynamic import keeps the worker-intent judgment modules out of this
  // route file's static graph (mirrors the prod-action definition).
  app.get("/api/churn/rejudge-progress", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      if (!(await canAccessChurnCommandCenter(user))) {
        return res.status(403).json({ error: "Director access required" });
      }
      const { getRejudgeRescoreProgress } = await import("../services/rejudgeStaleJudgments");
      res.json(await getRejudgeRescoreProgress());
    } catch (error) {
      console.error("Error computing re-judge re-score progress:", error);
      res.status(500).json({ error: "Failed to compute re-score progress" });
    }
  });

  app.post("/api/churn/concern-intel", isAuthenticated, async (req: any, res) => {
    try {
      const user = await requireChurnDirector(req, res);
      if (!user) return;

      const parsed = concernIntelBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues });
      }

      const client = await storage.getClient(parsed.data.clientId);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }

      const intel = await storage.createClientConcernIntel({
        ...parsed.data,
        createdBy: user.id,
      });

      try {
        await mirrorOperatorIntelToKnowledge(
          intel.clientId,
          intel.id,
          intel.intelType as "context" | "resolved",
          intel.concernText,
          intel.note,
        );
      } catch (mirrorError) {
        console.error(
          `[ConcernIntel] KB mirror failed for intel ${intel.id} (client ${intel.clientId}) — intel row saved, knowledge base out of sync:`,
          mirrorError,
        );
      }

      res.status(201).json({ intel });
    } catch (error) {
      console.error("[ConcernIntel] Failed to save concern intel:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  /**
   * Task #3695 — Going Quiet tab: latest engagement snapshot per active
   * client, written by the daily going-quiet sweep. Same STRICT director
   * gate as the leaderboard. Clients with no snapshot yet come back with
   * snapshot=null (sweep hasn't covered them) instead of being dropped.
   * Ordering: flagged first by quiet score, then the rest by quiet score,
   * no-snapshot clients last by firm name.
   */
  app.get("/api/churn/going-quiet", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      if (!(await canAccessChurnCommandCenter(user))) {
        return res.status(403).json({ error: "Director access required" });
      }

      // snapshot_date is a 'YYYY-MM-DD' varchar → lexicographic DESC is
      // chronological DESC (same convention as judgment_date above).
      const result = await db.execute(sql`
        WITH active_clients AS (
          SELECT c.id, c.firm_name, c.client_code, c.owner_id,
                 u.first_name AS owner_first_name,
                 u.last_name  AS owner_last_name,
                 u.email      AS owner_email,
                 u.profile_image_url AS owner_avatar
          FROM clients c
          LEFT JOIN users u ON u.id = c.owner_id
          WHERE COALESCE(c.is_archived, false) = false
            AND COALESCE(c.is_demo, false) = false
            -- Task #4330: lead-stage records are prospects, not churnable clients
            AND COALESCE(c.lifecycle_stage, 'customer') = 'customer'
        ),
        latest_snapshot AS (
          SELECT DISTINCT ON (s.client_id)
                 s.client_id, s.snapshot_date,
                 s.inbound_recent, s.outbound_recent,
                 s.inbound_30d, s.outbound_30d,
                 s.baseline_weekly_inbound, s.recent_weekly_inbound, s.drop_pct,
                 s.days_since_last_inbound, s.days_since_last_call_meeting,
                 s.days_since_last_viewed, s.history_days,
                 s.quiet_score, s.is_flagged, s.insufficient_history,
                 s.data_gap, s.reasons_json
          FROM client_engagement_snapshots s
          WHERE s.client_id IN (SELECT id FROM active_clients)
          ORDER BY s.client_id, s.snapshot_date DESC, s.created_at DESC
        )
        SELECT a.*,
               ls.snapshot_date, ls.inbound_recent, ls.outbound_recent,
               ls.inbound_30d, ls.outbound_30d,
               ls.baseline_weekly_inbound, ls.recent_weekly_inbound, ls.drop_pct,
               ls.days_since_last_inbound, ls.days_since_last_call_meeting,
               ls.days_since_last_viewed, ls.history_days,
               ls.quiet_score, ls.is_flagged, ls.insufficient_history,
               ls.data_gap, ls.reasons_json
        FROM active_clients a
        LEFT JOIN latest_snapshot ls ON ls.client_id = a.id
        ORDER BY (ls.client_id IS NULL),
                 COALESCE(ls.is_flagged, false) DESC,
                 ls.quiet_score DESC NULLS LAST,
                 a.firm_name ASC
      `);

      const rows: any[] = (result as any).rows ?? [];
      const toNum = (v: unknown): number | null =>
        v === null || v === undefined ? null : Number(v);

      const clients = rows.map((r: any) => ({
        clientId: r.id as string,
        firmName: r.firm_name as string,
        clientCode: (r.client_code ?? null) as string | null,
        ownerId: (r.owner_id ?? null) as string | null,
        ownerName:
          [r.owner_first_name, r.owner_last_name].filter(Boolean).join(" ") ||
          r.owner_email ||
          null,
        ownerAvatar: (r.owner_avatar ?? null) as string | null,
        snapshot: r.snapshot_date
          ? {
              snapshotDate: r.snapshot_date as string,
              inboundRecent: toNum(r.inbound_recent) ?? 0,
              outboundRecent: toNum(r.outbound_recent) ?? 0,
              inbound30d: toNum(r.inbound_30d) ?? 0,
              outbound30d: toNum(r.outbound_30d) ?? 0,
              baselineWeeklyInbound: toNum(r.baseline_weekly_inbound),
              recentWeeklyInbound: toNum(r.recent_weekly_inbound),
              dropPct: toNum(r.drop_pct),
              daysSinceLastInbound: toNum(r.days_since_last_inbound),
              daysSinceLastCallMeeting: toNum(r.days_since_last_call_meeting),
              daysSinceLastViewed: toNum(r.days_since_last_viewed),
              historyDays: toNum(r.history_days),
              quietScore: toNum(r.quiet_score) ?? 0,
              isFlagged: r.is_flagged === true,
              insufficientHistory: r.insufficient_history === true,
              dataGap: r.data_gap === true,
              reasons: Array.isArray(r.reasons_json) ? (r.reasons_json as string[]) : [],
            }
          : null,
      }));

      // Task #3889 — live feed-freshness alongside the snapshots so the tab
      // can show the degraded-feed banner the moment the pipeline stalls
      // (not only after the next daily sweep). Non-fatal: a probe error
      // yields feed=null and the tab renders as before.
      let feed: Awaited<ReturnType<typeof measureGoingQuietFeedFreshness>> | null = null;
      try {
        feed = await measureGoingQuietFeedFreshness(new Date(), "api:churn:going-quiet-feed");
      } catch (err: any) {
        console.warn(
          `[ChurnGoingQuiet] feed-freshness probe failed (returning feed=null): ${err?.message ?? err}`,
        );
      }

      const settings = await loadGoingQuietSettings();
      res.json({
        clients,
        feed: feed
          ? {
              stale: feed.stale,
              newestInboundAt: feed.newestInboundAt?.toISOString() ?? null,
              newestSyncActivityAt: feed.newestSyncActivityAt?.toISOString() ?? null,
              syncActiveRecent: feed.syncActiveRecent,
              lagDays: feed.lagDays,
              staleAfterDays: feed.staleAfterDays,
              minRecentConvs: feed.minRecentConvs,
            }
          : null,
        thresholds: {
          dropThresholdPct: settings.dropThresholdPct,
          silenceDays: settings.silenceDays,
          minHistoryDays: settings.minHistoryDays,
          minBaselineWeekly: settings.minBaselineWeekly,
        },
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[ChurnGoingQuiet] Failed to build going-quiet list:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  /**
   * Task #4766 — unknown-stability operator triage. Active clients whose
   * LATEST judgment still reads deliveryStability "unknown" (after the
   * measured-live-data fallback), split deterministically from the
   * judgment's own stored source signals into "data gap" (recent
   * communications exist — the honest fix is entering real reports or
   * configuring the measured BigQuery source) vs "archive candidate"
   * (dead across comms, entered reports, measured data, and open asks —
   * routed to the EXISTING archive/offboarding flow, human-confirmed).
   * Read path only; classification logic is pure (stabilityTriage.ts).
   */
  app.get("/api/churn/stability-triage", isAuthenticated, async (req: any, res) => {
    try {
      const user = await requireChurnDirector(req, res);
      if (!user) return;

      const result = await db.execute(sql`
        WITH active_clients AS (
          SELECT c.id, c.firm_name, c.client_code, c.big_query_client_key,
                 u.first_name AS owner_first_name,
                 u.last_name  AS owner_last_name,
                 u.email      AS owner_email,
                 u.profile_image_url AS owner_avatar
          FROM clients c
          LEFT JOIN users u ON u.id = c.owner_id
          WHERE COALESCE(c.is_archived, false) = false
            AND COALESCE(c.is_demo, false) = false
            AND COALESCE(c.lifecycle_stage, 'customer') = 'customer'
        ),
        latest_judgment AS (
          SELECT DISTINCT ON (j.client_id)
                 j.client_id, j.judgment_date, j.data_sources_summary
          FROM client_daily_judgments j
          WHERE j.client_id IN (SELECT id FROM active_clients)
          ORDER BY j.client_id, j.judgment_date DESC
        )
        SELECT a.*, lj.judgment_date, lj.data_sources_summary
        FROM active_clients a
        JOIN latest_judgment lj ON lj.client_id = a.id
        WHERE lj.data_sources_summary->'tierGate'->>'deliveryStability' = 'unknown'
        ORDER BY a.firm_name
      `);

      const rows: any[] = (result as any).rows ?? [];
      const clients = rows.map((r: any) => {
        const inventory = r.data_sources_summary ?? {};
        const sources = inventory.sources ?? {};
        const judgmentDate = String(r.judgment_date);
        const lastCommAt = (sources.comms?.lastCommAt ?? null) as string | null;
        const lastEnteredReportMonth = (sources.report?.month ?? null) as string | null;
        const measuredMonths = Array.isArray(sources.measuredLeads)
          ? sources.measuredLeads.length
          : 0;
        const activeOpenAsks = Number(sources.openAsks?.activeCount ?? 0) || 0;
        const triage = classifyStabilityTriage({
          judgmentDate,
          lastCommAt,
          lastEnteredReportMonth,
          measuredMonths,
          activeOpenAsks,
        });
        return {
          clientId: r.id as string,
          firmName: r.firm_name as string,
          clientCode: (r.client_code ?? null) as string | null,
          ownerName:
            [r.owner_first_name, r.owner_last_name].filter(Boolean).join(" ") ||
            r.owner_email ||
            null,
          ownerAvatar: (r.owner_avatar ?? null) as string | null,
          judgmentDate,
          deliveryStabilitySource:
            (inventory.tierGate?.deliveryStabilitySource ?? null) as string | null,
          lastCommAt,
          lastEnteredReportMonth,
          measuredMonths,
          measuredSourceConfigured: !!r.big_query_client_key,
          activeOpenAsks,
          kind: triage.kind,
          reasons: triage.reasons,
        };
      });

      res.json({ clients, generatedAt: new Date().toISOString() });
    } catch (error) {
      console.error("[ChurnStabilityTriage] Failed to build triage list:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ─── Task #3694 — cross-client aging asks & promises rollup ─────────
  // GET /api/churn/open-asks — same STRICT director gate as the
  // leaderboard (403 below director in ALL modes). Lists every
  // open/likely_open ask across active clients (archived/demo excluded)
  // with client + owner context, default-ranked by the age×concern blend.
  // Filters: askType / ownerId / clientId. Sorts: rank (default) / age /
  // concern / mentions. Query lives in services/openAsksRollup.ts, shared
  // with the weekly digest.
  //
  // Resolve/dismiss is deliberately NOT here — the tab reuses the
  // existing per-client PATCH /api/clients/:clientId/open-asks/:askId so
  // the lifecycle semantics stay in one place (task brief: "reusing
  // existing per-client update semantics").
  app.get("/api/churn/open-asks", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      if (!(await canAccessChurnCommandCenter(user))) {
        return res.status(403).json({ error: "Director access required" });
      }

      const askType =
        typeof req.query.askType === "string" && req.query.askType !== ""
          ? req.query.askType
          : undefined;
      if (askType !== undefined && !["client_ask", "internal_promise"].includes(askType)) {
        return res.status(400).json({ error: "Invalid askType" });
      }
      const sort =
        typeof req.query.sort === "string" && req.query.sort !== ""
          ? req.query.sort
          : undefined;
      if (sort !== undefined && !openAskRollupSortOptions.includes(sort as OpenAskRollupSort)) {
        return res.status(400).json({ error: "Invalid sort" });
      }
      const ownerId =
        typeof req.query.ownerId === "string" && req.query.ownerId !== ""
          ? req.query.ownerId
          : undefined;
      const clientId =
        typeof req.query.clientId === "string" && req.query.clientId !== ""
          ? req.query.clientId
          : undefined;

      const asks = await fetchOpenAsksRollup(db, {
        askType,
        ownerId,
        clientId,
        sort: (sort as OpenAskRollupSort | undefined) ?? "rank",
      });

      res.json({ asks, generatedAt: new Date().toISOString() });
    } catch (error) {
      console.error("[ChurnOpenAsks] Failed to build open-asks rollup:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ─── Task #3712 — Team Coaching: per-AM churn trends ────────────────
  // GET /api/churn/team-trends — same STRICT director gate. Groups the
  // existing judgment/insight/comms data by clients.owner_id into per-AM
  // buckets + an "unassigned" bucket + a department rollup. Deterministic
  // reads only; aggregation lives in services/churnTeamTrends.ts.
  app.get("/api/churn/team-trends", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      if (!(await canAccessChurnCommandCenter(user))) {
        return res.status(403).json({ error: "Director access required" });
      }

      res.json(await fetchTeamTrends(db));
    } catch (error) {
      console.error("[ChurnTeamTrends] Failed to build team trends:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ─── Task #3712 — Team Coaching: coaching runs ──────────────────────
  // POST /api/churn/coaching/runs — start a background coaching run
  // across all AMs. Liveness truth is the cluster-wide advisory lock, so
  // a concurrent start (from any instance) gets a graceful 409 with the
  // active run attached. 202 = accepted, work continues in background.
  app.post("/api/churn/coaching/runs", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      if (!(await canAccessChurnCommandCenter(user))) {
        return res.status(403).json({ error: "Director access required" });
      }

      const result = await startAmCoachingRun(user.id);
      if (!result.started) {
        return res.status(409).json({
          error: "A coaching run is already in progress",
          activeRun: result.activeRun,
        });
      }
      res.status(202).json({ run: result.run });
    } catch (error) {
      console.error("[AmCoaching] Failed to start coaching run:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // GET /api/churn/coaching/runs — run history (newest first) so the
  // director can compare an AM's patterns against earlier runs.
  app.get("/api/churn/coaching/runs", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      if (!(await canAccessChurnCommandCenter(user))) {
        return res.status(403).json({ error: "Director access required" });
      }

      const rows = await db
        .select({
          run: amCoachingRuns,
          requesterFirstName: users.firstName,
          requesterLastName: users.lastName,
          requesterEmail: users.email,
        })
        .from(amCoachingRuns)
        .leftJoin(users, eq(users.id, amCoachingRuns.requestedByUserId))
        .orderBy(desc(amCoachingRuns.startedAt))
        .limit(20);

      const runs = rows.map((r) => ({
        ...r.run,
        requestedByName:
          [r.requesterFirstName, r.requesterLastName].filter(Boolean).join(" ") ||
          r.requesterEmail ||
          null,
      }));
      res.json({ runs, generatedAt: new Date().toISOString() });
    } catch (error) {
      console.error("[AmCoaching] Failed to list coaching runs:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // GET /api/churn/coaching/runs/:runId — one run with progress counters,
  // department synthesis and every per-AM report (evidence excerpts point
  // at concrete raw_communication_records).
  app.get("/api/churn/coaching/runs/:runId", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      if (!(await canAccessChurnCommandCenter(user))) {
        return res.status(403).json({ error: "Director access required" });
      }

      const runId = String(req.params.runId ?? "");
      const [run] = await db
        .select()
        .from(amCoachingRuns)
        .where(eq(amCoachingRuns.id, runId))
        .limit(1);
      if (!run) {
        return res.status(404).json({ error: "Run not found" });
      }

      const reportRows = await db
        .select({
          report: amCoachingReports,
          amFirstName: users.firstName,
          amLastName: users.lastName,
          amEmail: users.email,
          amAvatar: users.profileImageUrl,
        })
        .from(amCoachingReports)
        .leftJoin(users, eq(users.id, amCoachingReports.amUserId))
        .where(eq(amCoachingReports.runId, runId));

      const reports = reportRows
        .map((r) => ({
          id: r.report.id,
          amUserId: r.report.amUserId,
          amName:
            [r.amFirstName, r.amLastName].filter(Boolean).join(" ") ||
            r.amEmail ||
            r.report.amUserId,
          amEmail: r.amEmail ?? null,
          amAvatar: r.amAvatar ?? null,
          status: r.report.status,
          clientCount: r.report.clientCount,
          zoomSampleCount: r.report.zoomSampleCount,
          emailSampleCount: r.report.emailSampleCount,
          unattributedSampleCount: r.report.unattributedSampleCount,
          mistakes: r.report.mistakesJson ?? [],
          unattributed: r.report.unattributedJson ?? [],
          strengths: r.report.strengthsJson ?? [],
          zoomSummary: r.report.zoomSummary,
          emailSummary: r.report.emailSummary,
          coachingFocus: r.report.coachingFocus,
          insufficientData: r.report.insufficientData,
          error: r.report.error,
          createdAt: r.report.createdAt,
        }))
        .sort((a, b) => a.amName.localeCompare(b.amName));

      res.json({ run, reports, generatedAt: new Date().toISOString() });
    } catch (error) {
      console.error("[AmCoaching] Failed to load coaching run:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ── Task #3692 — Churn Risk Radar sweep ──────────────────────────────────
  // On-demand portfolio sweep: start (409 when one is already running),
  // poll progress, list past runs, fetch a run's full results. All strict
  // director-gated like the leaderboard. Reads run on the API pool `db`;
  // the sweep itself runs on the worker pool inside churnRiskRadar.ts.

  app.post("/api/churn/radar/runs", isAuthenticated, async (req: any, res) => {
    try {
      const user = await requireChurnDirector(req, res);
      if (!user) return;

      const result = await startChurnRadarSweep(user.id);
      if (result.outcome === "already_running") {
        return res.status(409).json({
          error: "A churn radar sweep is already running",
          run: result.run ? serializeRadarRun(result.run) : null,
        });
      }
      res.status(202).json({
        run: result.run ? serializeRadarRun(result.run) : null,
        resumed: result.outcome === "resumed",
      });
    } catch (error) {
      console.error("[ChurnRadar] Failed to start sweep:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/churn/radar/runs", isAuthenticated, async (req: any, res) => {
    try {
      const user = await requireChurnDirector(req, res);
      if (!user) return;

      const rows = await db
        .select({
          run: churnRadarRuns,
          requesterFirst: users.firstName,
          requesterLast: users.lastName,
          requesterEmail: users.email,
        })
        .from(churnRadarRuns)
        .leftJoin(users, eq(users.id, churnRadarRuns.requestedBy))
        .orderBy(desc(churnRadarRuns.startedAt))
        .limit(24);
      res.json({
        runs: rows.map((r) =>
          serializeRadarRun(
            r.run,
            [r.requesterFirst, r.requesterLast].filter(Boolean).join(" ") || r.requesterEmail || null,
          ),
        ),
      });
    } catch (error) {
      console.error("[ChurnRadar] Failed to list runs:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/churn/radar/runs/:id", isAuthenticated, async (req: any, res) => {
    try {
      const user = await requireChurnDirector(req, res);
      if (!user) return;

      const [run] = await db
        .select()
        .from(churnRadarRuns)
        .where(eq(churnRadarRuns.id, req.params.id));
      if (!run) return res.status(404).json({ error: "Run not found" });
      res.json({ run: serializeRadarRun(run) });
    } catch (error) {
      console.error("[ChurnRadar] Failed to fetch run:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/churn/radar/runs/:id/results", isAuthenticated, async (req: any, res) => {
    try {
      const user = await requireChurnDirector(req, res);
      if (!user) return;

      const [run] = await db
        .select()
        .from(churnRadarRuns)
        .where(eq(churnRadarRuns.id, req.params.id));
      if (!run) return res.status(404).json({ error: "Run not found" });

      const [resultRows, findingRows] = await Promise.all([
        db
          .select()
          .from(churnRadarClientResults)
          .where(eq(churnRadarClientResults.runId, run.id)),
        db
          .select()
          .from(churnRadarFindings)
          .where(eq(churnRadarFindings.runId, run.id)),
      ]);

      const findingsByClient = new Map<string, typeof findingRows>();
      for (const f of findingRows) {
        const list = findingsByClient.get(f.clientId) ?? [];
        list.push(f);
        findingsByClient.set(f.clientId, list);
      }

      // Rank order: analyzed clients by churn likelihood desc, then
      // insufficient-data, then errored — each alphabetical within.
      const statusOrder: Record<string, number> = { analyzed: 0, insufficient_data: 1, error: 2 };
      const clients = resultRows
        .map((r) => ({
          clientId: r.clientId,
          firmName: r.firmName,
          status: r.status,
          churnLikelihood: r.churnLikelihood,
          likelihoodBand: r.likelihoodBand,
          summary: r.summary,
          insufficiencyReason: r.insufficiencyReason,
          errorMessage: r.errorMessage,
          findings: (findingsByClient.get(r.clientId) ?? [])
            .sort((a, b) => a.rank - b.rank)
            .map((f) => ({
              rank: f.rank,
              reason: f.reason,
              severity: f.severity,
              confidence: f.confidence,
              evidence: Array.isArray(f.evidenceJson) ? (f.evidenceJson as string[]) : [],
              themeCategory: f.themeCategory,
              themeLabel:
                churnRadarThemeLabels[f.themeCategory as ChurnRadarThemeCategory] ?? f.themeCategory,
            })),
        }))
        .sort(
          (a, b) =>
            (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3) ||
            (b.churnLikelihood ?? -1) - (a.churnLikelihood ?? -1) ||
            a.firmName.localeCompare(b.firmName),
        );

      const synthesis = (run.synthesisJson ?? null) as ChurnRadarSynthesis | null;
      res.json({
        run: serializeRadarRun(run),
        clients,
        themes: synthesis?.themes ?? [],
        generatedAt: synthesis?.generatedAt ?? null,
      });
    } catch (error) {
      console.error("[ChurnRadar] Failed to fetch run results:", error);
      res.status(500).json({ error: "Server error" });
    }
  });
}

/**
 * Shared strict director gate for all churn routes (401 unknown user,
 * 403 below director in ALL modes — no permissive-mode bypass).
 * Returns the user record, or null after writing the error response.
 */
async function requireChurnDirector(req: any, res: any): Promise<{ id: string } | null> {
  const userId = req.user?.claims?.sub;
  const user = await storage.getUser(userId);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  if (!(await canAccessChurnCommandCenter(user))) {
    res.status(403).json({ error: "Director access required" });
    return null;
  }
  return user;
}

function serializeRadarRun(run: ChurnRadarRun, requesterName?: string | null) {
  return {
    id: run.id,
    status: run.status,
    requestedBy: run.requestedBy,
    requesterName: requesterName ?? null,
    totalClients: run.totalClients,
    processedClients: run.processedClients,
    analyzedClients: run.analyzedClients,
    insufficientClients: run.insufficientClients,
    errorClients: run.errorClients,
    errorSummary: run.errorSummary,
    modelVersion: run.modelVersion,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}
