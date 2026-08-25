// @db-pool-intent: ambient
/**
 * Shared core for the "backfill seasonal-trend AI commentary on already-
 * finalized shared reports" prod-action (Task #4252).
 *
 * Background
 * ----------
 * Task #4240 generates the AI seasonal-trend commentary at report-finalize
 * time and caches it in `report_sections` under the internal key
 * `seasonalTrendsAi` (see practiceAreaTrendAnalysis.ts), so the anonymous
 * /api/share/:token payload serves the stored copy without ever reaching
 * OpenAI. Reports finalized BEFORE that change have no stored copy — their
 * shared links still degrade to the deterministic fallback text. This module
 * finds those reports and lets the prod-action generate the missing section
 * through the exact same helper the finalize path uses
 * (`generateAndStoreSeasonalTrendAiAnalysis` — audited section upsert,
 * idempotent on (report_id, section_key), never throws).
 *
 * Candidate rule (mirrors the finalize-path preconditions exactly):
 *   - report.status = 'final'  (only finalized reports carry the cache)
 *   - report.share_token IS NOT NULL  (only shared reports are served
 *     anonymously — unshared reports regain the section if/when they are
 *     re-finalized or shared+refinalized later; deliberately out of scope)
 *   - the owning client has ≥1 practice area (no areas ⇒ nothing to
 *     analyze; such reports are EXCLUDED from pending, never counted —
 *     memory "Prod-action convergence": ambiguity/no-data is surfaced,
 *     not pending)
 *   - no `seasonalTrendsAi` section row exists yet
 *
 * Convergence
 * -----------
 * The feeder is closed at ingest: every finalize since Task #4240 writes the
 * section itself, so the backlog is finite and the action is `converging`.
 * A candidate whose AI generation fails (helper returns null — vendor error
 * or empty trend data) is remembered in the drain-local attempted set and
 * counted as a processed `skipped` unit, so the drain always terminates; a
 * later press retries exactly those rows. Nothing is ever written on
 * failure, so a stored good copy is never clobbered.
 *
 * The OpenAI client is created lazily through the confined adapter factory
 * (server/services/ai/openAiClient.ts) and only when a chunk actually runs —
 * tests inject a fake via `__setSeasonalTrendAiBackfillClientOverrideForTest`
 * and hermetic runs with zero candidates never construct a client at all.
 * No unauthenticated path can reach this module: its only production caller
 * is the auth-gated admin prod-action apply endpoint.
 */
import { sql } from "drizzle-orm";

import {
  generateAndStoreSeasonalTrendAiAnalysis,
  SEASONAL_TRENDS_AI_SECTION_KEY,
  type TrendAnalysisChatClient,
} from "./practiceAreaTrendAnalysis";

/** Drizzle handle that supports `.execute(sql)` — `api` or `worker` pool. */
export type SeasonalTrendAiBackfillDb = ReturnType<
  typeof import("../db")["getDb"]
>;

/**
 * Reports per background-drain chunk. Each unit is one OpenAI chat
 * completion (~seconds), so chunks stay small and the inter-call delay
 * below throttles vendor pressure (mirrors the Common-Issues reformat
 * drain's pacing).
 */
export const SEASONAL_TREND_AI_BACKFILL_CHUNK = 2;

/** Delay between consecutive AI generations within a chunk (ms). */
export const SEASONAL_TREND_AI_BACKFILL_DELAY_MS = 250;

export interface SeasonalTrendAiBackfillCandidate {
  reportId: string;
  practiceAreas: string[];
}

/**
 * Finalized, shared reports whose client has practice areas but which have
 * no stored `seasonalTrendsAi` section. Deterministic order so re-queried
 * chunks walk the same sequence. Count and selection share this ONE
 * predicate (the import-path/backfill single-predicate rule).
 */
export async function findSeasonalTrendAiBackfillCandidates(
  db: SeasonalTrendAiBackfillDb,
): Promise<SeasonalTrendAiBackfillCandidate[]> {
  const result = await db.execute(sql`
    SELECT r.id AS report_id, c.practice_areas AS practice_areas
    FROM reports r
    JOIN clients c ON c.id = r.client_id
    WHERE r.status = 'final'
      AND r.share_token IS NOT NULL
      AND c.practice_areas IS NOT NULL
      AND cardinality(c.practice_areas) > 0
      AND NOT EXISTS (
        SELECT 1 FROM report_sections s
        WHERE s.report_id = r.id
          AND s.section_key = ${SEASONAL_TRENDS_AI_SECTION_KEY}
      )
    ORDER BY r.created_at ASC NULLS LAST, r.id ASC
  `);
  // db.execute returns a raw QueryResult — read .rows (memory
  // "drizzle-execute-raw-result").
  const rows = (result as unknown as { rows: any[] }).rows ?? [];
  return rows.map((row) => ({
    reportId: String(row.report_id),
    practiceAreas: Array.isArray(row.practice_areas)
      ? row.practice_areas.filter(
          (a: unknown): a is string => typeof a === "string" && a.length > 0,
        )
      : [],
  }));
}

// ─── Lazy vendor client (test seam) ──────────────────────────────────
//
// Module-local override so tests can drive the drain with a fake client
// (ESM live-binding patching does not work under tsx — mutate the mutable
// seam instead). Always restore to null in a test's finally.
let __clientOverrideForTest: TrendAnalysisChatClient | null = null;

export function __setSeasonalTrendAiBackfillClientOverrideForTest(
  client: TrendAnalysisChatClient | null,
): void {
  __clientOverrideForTest = client;
}

/**
 * Resolve the chat client for a backfill run: the test override when set,
 * else a repo-standard client from the confined adapter factory (120s
 * timeout, 3 retries). Constructed lazily per apply-press — never at module
 * load — so importing this module (registry composition, tests) stays
 * vendor-inert.
 */
export async function getSeasonalTrendAiBackfillClient(): Promise<TrendAnalysisChatClient> {
  if (__clientOverrideForTest) return __clientOverrideForTest;
  const { createDefaultOpenAiClient } = await import("./ai/openAiClient");
  return createDefaultOpenAiClient();
}

export type SeasonalTrendAiBackfillOutcome = "generated" | "skipped";

/**
 * Generate + store the missing section for one candidate via the exact
 * finalize-path helper. Returns "generated" when the section was stored,
 * "skipped" when the helper declined (AI failure or empty trend data —
 * logged inside the helper; nothing written). Never throws.
 */
export async function processSeasonalTrendAiBackfillCandidate(
  candidate: SeasonalTrendAiBackfillCandidate,
  openaiClient: TrendAnalysisChatClient,
): Promise<SeasonalTrendAiBackfillOutcome> {
  const analysis = await generateAndStoreSeasonalTrendAiAnalysis({
    reportId: candidate.reportId,
    practiceAreas: candidate.practiceAreas,
    openaiClient,
  });
  return analysis ? "generated" : "skipped";
}
