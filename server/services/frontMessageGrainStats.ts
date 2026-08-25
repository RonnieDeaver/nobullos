// @db-pool-intent: api
//
// Task #2633 — canonical message-grain Front Console stats.
//
// The Front Console must count individual MESSAGES, not conversations
// (Tasks #2602 / #2603 / #2604). Every console figure (KPI strip, Pipeline
// Health, match-stats, diagnosis, Messages tab, Jobs & Bulk Actions) is sourced
// from `raw_communication_records` (source_type='front_email'); `front_sync_emails`
// is joined ONLY as the internal conversation-state lookup so a message inherits
// its conversation's match_status / pipeline_state. This module is the single
// place that performs that join + counting, so the KPI "Match rate" and the
// Messages-tab "Match rate" can never drift.
//
// Pool: every caller is a request-scoped route handler, so the `db` handle is
// passed in (the `api` pool). This module never imports getDb / a pool of its
// own — the handle is always explicit.
//
// Join key: `raw_communication_records.external_thread_id` is the Front
// conversationId on every row (including per-message materialized rows), and
// `front_sync_emails.conversation_id` is UNIQUE. We LEFT JOIN so a message with
// no conversation row still counts toward `total` / `matched`.

import { sql, type SQL } from "drizzle-orm";
import {
  FRONT_NON_MATCHABLE_STATUSES,
  deriveFrontMessageGrainStats,
  type FrontMessageGrainStats,
} from "@shared/frontConsoleMetrics";

/** Minimal structural type so callers can pass any pool's drizzle handle. */
type DbExecutor = { execute: (query: SQL) => Promise<{ rows: any[] }> };

/**
 * Base predicate shared by every message-grain query: real Front-email
 * MESSAGES, never orphaned.
 *
 * Task #2669 — scope to `source_subtype = 'email_message'`. The live
 * webhook/reconciliation path also writes ONE per-conversation rollup row per
 * thread (`source_subtype = 'email_thread'`, always `internal` direction, no
 * body) purely to carry conversation-wide attribution. Those rollups are not
 * customer messages, yet they outnumber the real per-message rows and are all
 * unmatched, so counting them inflated the Front Console unmatched headline
 * (the misleading low match-rate this task fixes). Excluding them here is the
 * single chokepoint that keeps EVERY message-grain figure (matched/unmatched
 * headline, pipeline-by-state, match-method histogram, per-conversation counts)
 * honest and consistent — they can never drift because they share this one
 * predicate. Plan-limited months that only ever produced rollup shells (no
 * per-message history) correctly contribute zero real messages here; they are
 * surfaced separately via the labeled conversation-grain fallback in the
 * Analytics Coverage screen, never mixed into these message-grain counts.
 */
function frontEmailBasePredicate(): SQL {
  return sql`r.source_type = 'front_email' AND r.source_subtype = 'email_message' AND (r.match_status IS NULL OR r.match_status <> 'orphaned')`;
}

/** `front_sync_emails.match_status` values that are NOT matchable, as a bound SQL IN list. */
function nonMatchableInList(): SQL {
  return sql.join(
    FRONT_NON_MATCHABLE_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
}

/**
 * Canonical message-grain matched / matchable / unmatched stats.
 *
 * `extraConditions` (already referencing the `r` alias) are AND-ed onto the base
 * predicate so the Messages tab can compute the SAME stats for a filtered subset.
 */
export async function getFrontMessageGrainStats(
  db: DbExecutor,
  extraConditions: SQL[] = [],
): Promise<FrontMessageGrainStats> {
  const where = sql.join(
    [frontEmailBasePredicate(), ...extraConditions],
    sql` AND `,
  );
  const nonMatchable = nonMatchableInList();
  const result = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE r.client_id IS NOT NULL)::int AS matched,
      COUNT(*) FILTER (WHERE r.client_id IS NULL AND fse.match_status = 'unmatched')::int AS unmatched,
      COUNT(*) FILTER (WHERE fse.match_status IN (${nonMatchable}))::int AS non_matchable
    FROM raw_communication_records r
    LEFT JOIN front_sync_emails fse ON fse.conversation_id = r.external_thread_id
    WHERE ${where}
  `);
  const row = (result.rows?.[0] ?? {}) as Record<string, any>;
  return deriveFrontMessageGrainStats({
    total: Number(row.total) || 0,
    matched: Number(row.matched) || 0,
    unmatched: Number(row.unmatched) || 0,
    nonMatchable: Number(row.non_matchable) || 0,
  });
}

/**
 * Message counts per pipeline_state (message grain). Feeds the Pipeline Health
 * by-state badges, backlog count, applied/done count, failed and dead-lettered
 * tiles. INNER JOIN because a pipeline_state only exists once the conversation
 * row exists.
 */
export async function getFrontMessageGrainPipelineByState(
  db: DbExecutor,
): Promise<Record<string, number>> {
  const result = await db.execute(sql`
    SELECT fse.pipeline_state::text AS state, COUNT(*)::int AS count
    FROM raw_communication_records r
    INNER JOIN front_sync_emails fse ON fse.conversation_id = r.external_thread_id
    WHERE ${frontEmailBasePredicate()}
    GROUP BY fse.pipeline_state
  `);
  const out: Record<string, number> = {};
  for (const row of result.rows ?? []) {
    const state = (row as any).state ?? "unknown";
    out[state] = Number((row as any).count) || 0;
  }
  return out;
}

/**
 * Matched-by-method histogram at message grain (matched messages only). Feeds
 * the Hard-match outcomes tile so its "Matched by method" rows sum to the same
 * message-grain Matched figure shown everywhere else.
 */
export async function getFrontMessageGrainMatchMethods(
  db: DbExecutor,
): Promise<Record<string, number>> {
  const result = await db.execute(sql`
    SELECT
      CASE
        WHEN r.match_method ~ '^\\[[A-Z_]+\\]' THEN substring(r.match_method from '^\\[([A-Z_]+)\\]')
        WHEN r.match_method IS NULL OR r.match_method = '' THEN 'UNKNOWN'
        ELSE upper(r.match_method)
      END AS method,
      COUNT(*)::int AS count
    FROM raw_communication_records r
    WHERE ${frontEmailBasePredicate()}
      AND r.client_id IS NOT NULL
    GROUP BY 1
  `);
  const out: Record<string, number> = {};
  for (const row of result.rows ?? []) {
    out[(row as any).method || "UNKNOWN"] = Number((row as any).count) || 0;
  }
  return out;
}

/**
 * Per-conversation count of real Front-email MESSAGES (`email_message`, via the
 * shared base predicate — rollup `email_thread` shells are excluded, Task #2669),
 * keyed by conversationId. The unmatched-backlog diagnosis uses this to express
 * its per-domain / per-sender tallies as real message counts instead of
 * conversation counts, while still iterating the conversation rows the matcher
 * reasons over. A conversation with only a rollup shell (no materialized
 * messages) simply has no entry here and contributes zero.
 */
export async function getFrontMessageCountByConversation(
  db: DbExecutor,
): Promise<Map<string, number>> {
  const result = await db.execute(sql`
    SELECT r.external_thread_id AS conversation_id, COUNT(*)::int AS count
    FROM raw_communication_records r
    WHERE ${frontEmailBasePredicate()}
      AND r.external_thread_id IS NOT NULL
    GROUP BY r.external_thread_id
  `);
  const out = new Map<string, number>();
  for (const row of result.rows ?? []) {
    const id = (row as any).conversation_id;
    if (id != null) out.set(String(id), Number((row as any).count) || 0);
  }
  return out;
}
