import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

/**
 * Task #1643 — Front Analytics all-time coverage cache.
 *
 * One row per calendar month from `front_adoption_date` through the
 * current month. `front_total_messages` is the authoritative denominator
 * pulled from Front's Analytics Reports API. `fetched_into_nobull` and
 * `applied_into_nobull` are computed from the local pipeline tables
 * (`front_sync_emails`, `raw_communication_records`). Gaps and pcts
 * are pre-derived so the read-only dashboard helper can aggregate
 * without recomputing per request.
 *
 * Completed months are immutable after first successful pull. Current
 * month is upserted on every refresh.
 */
export const frontAnalyticsMonthlyCoverage = pgTable(
  "front_analytics_monthly_coverage",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    month: varchar("month", { length: 7 }).notNull().unique(),
    monthStart: timestamp("month_start").notNull(),
    monthEnd: timestamp("month_end").notNull(),
    frontTotalMessages: integer("front_total_messages").notNull().default(0),
    fetchedIntoNobull: integer("fetched_into_nobull").notNull().default(0),
    appliedIntoNobull: integer("applied_into_nobull").notNull().default(0),
    ingestGap: integer("ingest_gap").notNull().default(0),
    applyGap: integer("apply_gap").notNull().default(0),
    fetchedCoveragePct: real("fetched_coverage_pct").notNull().default(0),
    appliedCoveragePct: real("applied_coverage_pct").notNull().default(0),
    pulledAt: timestamp("pulled_at"),
    sourceRunId: varchar("source_run_id"),
    isFinalizedMonth: boolean("is_finalized_month").notNull().default(false),
    frontAnalyticsReportId: varchar("front_analytics_report_id"),
    frontAnalyticsStatus: varchar("front_analytics_status"),
    frontAnalyticsError: text("front_analytics_error"),
    /**
     * Task #1675 — set to true for permanent failures (4xx/410 from
     * Front Analytics, auth-failed). The refresh worker skips months
     * with `unrecoverable=true` on subsequent ticks so a confirmed-
     * permanent failure stops re-burning queue slots every 30 min.
     * Cleared on the next successful pull (e.g. after the operator
     * reconnects Front or runs the manual refresh-month endpoint).
     */
    unrecoverable: boolean("unrecoverable").notNull().default(false),
    /**
     * Task #1681 — Front Analytics search-API fallback. When a month is
     * outside the workspace plan's analytics retention window Front
     * returns 403 "plan does not give you access to that time period";
     * we then fall back to `/conversations/search/:query`. These two
     * columns persist *which* path produced the current denominator so
     * the dashboard can pill the unit mismatch and alerts code can
     * avoid mixing inbound-conversations with inbound-messages.
     *
     *   denominator_source: 'analytics_reports' | 'search_conversations'
     *   denominator_unit:   'inbound_messages'  | 'inbound_conversations'
     *
     * `analytics_plan_limited_at` memoizes the last confirmed plan-
     * limit response so the worker can skip the doomed Analytics
     * submit for ~7 days and go straight to search. Cleared on the
     * next successful Analytics pull.
     */
    denominatorSource: varchar("denominator_source", { length: 32 }),
    denominatorUnit: varchar("denominator_unit", { length: 32 }),
    analyticsPlanLimitedAt: timestamp("analytics_plan_limited_at"),
    /**
     * Task #1837 — unit of the local numerator (`fetched_into_nobull` /
     * `applied_into_nobull`). After this task lands every new write
     * persists `"conversations_all"`. Legacy rows without a value were
     * implicitly a mix of conversations (fetched) and messages (applied);
     * the admin UI badges any row where `numerator_unit !==
     * denominator_unit` as "Units not comparable" instead of rendering a
     * misleading coverage %.
     */
    numeratorUnit: varchar("numerator_unit", { length: 32 }),
    /**
     * Task #1837 — secondary diagnostic. When Front's Analytics Reports
     * API succeeds we now persist the inbound-messages count it returns
     * here instead of in `front_total_messages`. `front_total_messages`
     * always holds the primary, units-comparable denominator
     * (conversations, all directions) sourced from Conversations Search.
     */
    analyticsMessagesInbound: integer("analytics_messages_inbound"),
    /**
     * Task #1974 — per-direction message coverage.
     *
     * `messages_inbound_front` / `messages_outbound_front` are the
     * Front-side denominators per direction. For in-plan months these
     * come from Analytics Reports (`num_messages_received` /
     * `num_messages_sent`); for plan-limited months they will come
     * from per-message enumeration (`GET /conversations/{id}/messages`,
     * counted by `is_inbound`) — that fallback is scaffolded but not
     * yet wired (see FRONT_ANALYTICS_COVERAGE.md), so plan-limited
     * months currently leave these columns NULL and the UI surfaces
     * "outbound not yet measured" rather than a false 0/0.
     *
     * `messages_inbound_local` / `messages_outbound_local` are
     * `COUNT(*)` from `raw_communication_records` grouped by
     * `direction IN ('inbound','outbound')` filtered to
     * `source_type='front_email'` for the month window.
     *
     * `messages_inbound_coverage_pct` / `messages_outbound_coverage_pct`
     * and the `_gap` columns are derived server-side from the four
     * counts above; persisted so the read-only summary helper can
     * aggregate without recomputing per request.
     *
     * `direction_data_source` records which Front surface populated
     * the per-direction denominators for this row (`analytics_reports`
     * or `per_message_enumeration`). NULL means per-direction data
     * has not been measured yet for this row.
     */
    messagesInboundFront: integer("messages_inbound_front"),
    messagesOutboundFront: integer("messages_outbound_front"),
    messagesInboundLocal: integer("messages_inbound_local"),
    messagesOutboundLocal: integer("messages_outbound_local"),
    messagesInboundCoveragePct: real("messages_inbound_coverage_pct"),
    messagesOutboundCoveragePct: real("messages_outbound_coverage_pct"),
    messagesInboundGap: integer("messages_inbound_gap"),
    messagesOutboundGap: integer("messages_outbound_gap"),
    directionDataSource: varchar("direction_data_source", { length: 32 }),
    /**
     * Task #1905 — auto-close attribution for dead recovery windows
     * that were dedupe-only (i.e. already ingested via the live Front
     * webhook path). Set to `"webhook_dedupe"` by
     * `frontAutoClosure.maybeCloseDedupeOnlyWindow` after N consecutive
     * 100%-dedupe runs AND apply-layer confirmation that conversations
     * resolved. Auto-closure's `isIngestCandidate` skips any row with a
     * non-null `closed_via` so the loop stops burning Front API budget
     * on a phantom gap. Cleared by operator un-park.
     */
    closedVia: varchar("closed_via", { length: 32 }),
    /**
     * Task #2434 — convergence budget for the
     * `reach_front_coverage_full_message_grain` prod-action. A finalized
     * month that can never reach 100%-of-messages (genuinely nothing more
     * to fetch, or a plan-limited month whose denominator is permanently
     * conversation-grain — Front returns 403 "plan does not give you
     * access to that time period" for the Analytics / search endpoints
     * that would yield message grain) would otherwise be re-counted by the
     * sweep forever. `reachFrontCoverageFullForMonth` resets this to 0 on
     * any progress; on a clean (non-error, non-auth-blocked) drive that
     * makes no progress it is set straight to the cap (proven-unreachable);
     * a transient non-auth recovery error increments it (bounded). Once it
     * reaches the cap the sweep excludes the month so the action converges.
     * Auth-blocked drives never touch it (auth-down is not unreachable).
     */
    coverageConvergenceAttempts: integer("coverage_convergence_attempts")
      .notNull()
      .default(0),
    /**
     * Task #2745 — terminal "deep per-message search enumeration is proven
     * exhausted" marker, distinct from `coverageConvergenceAttempts`.
     *
     * The convergence budget (#2434) can be spent by grain-only re-measures or
     * recovery passes that never actually ran the deep `/conversations/search`
     * + `/conversations/{id}/messages` per-message walk. That left some in-plan,
     * message-grain months (`analytics_plan_limited_at IS NULL`) with a real
     * ingest gap that NO driver drained: `reach_front_coverage_full` retired
     * them on the spent budget, and the plan-limited search-recovery driver
     * skips non-plan-limited months. The "Bring it to 100%" logged-% headline
     * then stuck below target with un-drainable gap.
     *
     * This column is set by `reachFrontCoverageFullForMonth` ONLY when its deep
     * walk has actually run to exhaustion (materializer done) and still made no
     * progress against a residual ingest gap — i.e. the gap is genuinely
     * un-fetchable. Until then the sweep KEEPS such a month a candidate so reach
     * re-runs the deep walk; once set, the sweep retires it (converges) and the
     * headline math parks its residual ingest gap in `searchExhaustedRemainder`
     * (excluded from reachable work) so the button can't spin forever. Cleared
     * back to NULL on any real progress so a later revival re-opens the month.
     */
    deepSearchExhaustedAt: timestamp("deep_search_exhausted_at"),
    /**
     * Task #2795 — denominator floor excess.
     *
     * When the local unique-message count for a month exceeds the Front-
     * enumerated total (analytics_reports or search_conversations), the stored
     * `front_total_messages` is raised to the local count (the floor invariant).
     * This column records the excess — the number of local messages that surpassed
     * the Front-side count — so the Advanced operator panel can surface a per-month
     * reconciliation note without an additional query.
     *
     * NULL means "floor not yet computed or no excess" (existing rows before Task
     * #2795, and rows where the Front count already covered all local messages).
     * 0 means the floor was checked and no excess was found. >0 is the actual excess.
     */
    denominatorFloorExcess: integer("denominator_floor_excess"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    monthIdx: index("front_analytics_monthly_coverage_month_idx").on(table.month),
  }),
);

export const insertFrontAnalyticsMonthlyCoverageSchema = createInsertSchema(
  frontAnalyticsMonthlyCoverage,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertFrontAnalyticsMonthlyCoverage = z.infer<
  typeof insertFrontAnalyticsMonthlyCoverageSchema
>;
export type FrontAnalyticsMonthlyCoverage =
  typeof frontAnalyticsMonthlyCoverage.$inferSelect;
