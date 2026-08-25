// @db-pool-intent: worker
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  /**
 * DB-side throughput aggregator for queue timing audit entries (Task #724).
 *
 * The previous implementation pulled every completed work_queue row in the
 * window into Node, sorted them by timestamp, and ran a binary search per
 * audit entry. Under heavy traffic that could easily span many thousands
 * of rows, blowing the memory / CPU budget of the timings/history endpoint
 * and producing wrong numbers when rows were paginated or capped at the
 * driver level.
 *
 * This module replaces that with a single Postgres query that uses
 * COUNT(*) FILTER over a per-entry windowed VALUES list, returning the
 * before/after counts already aggregated by the database.
 *
 * The contract (pinned by tests/queue-timing-throughput-db-count.test.ts):
 *   - Exported function signature returns one row per input entry.
 *   - The function does NOT load any work_queue rows into memory; it only
 *     reads the per-entry counts.
 *   - Status semantics are preserved: "pending" while the after-window has
 *     not yet elapsed, "no_baseline" when before == 0, otherwise "ok".
 */
import { sql } from "drizzle-orm";
import { getDb } from "../db";

export type ThroughputStatus = "ok" | "pending" | "no_baseline";

export interface ThroughputResult {
  windowMs: number;
  before: number | null;
  after: number | null;
  status: ThroughputStatus;
}

export interface QueueTimingAuditEntryLike {
  id: string;
  changedAt: Date | string;
}

export const QUEUE_TIMING_THROUGHPUT_WINDOW_MS = 10 * 60 * 1000;

/**
 * Allowed throughput comparison windows admins can pick on the audit list
 * (Task #723). Keep this list in sync with the selector in
 * client/src/components/admin/health/OperationalHealthCards.tsx — the API rejects any
 * value outside this set and falls back to the default 10-minute window.
 */
export const QUEUE_TIMING_THROUGHPUT_ALLOWED_WINDOWS_MS = [
  5 * 60 * 1000,
  10 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
] as const;

/**
 * Clamp a user-supplied `windowMs` to the allow-list above, falling back to
 * the default 10-minute window for anything we don't recognize (NaN, negative,
 * non-numeric, or a numeric value not in the allow-list — e.g. 7 minutes).
 *
 * The `/api/integrations/work-queue/timings/history` endpoint and the
 * throughput-window selector in
 * `client/src/components/admin/health/OperationalHealthCards.tsx` both go through this
 * helper, so the contract is pinned in one place
 * (tests/queue-timing-throughput-db-count.test.ts).
 */
export function resolveThroughputWindowMs(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (
    Number.isFinite(n) &&
    (QUEUE_TIMING_THROUGHPUT_ALLOWED_WINDOWS_MS as readonly number[]).includes(n)
  ) {
    return n;
  }
  return QUEUE_TIMING_THROUGHPUT_WINDOW_MS;
}

export async function computeThroughputForEntries(
  entries: ReadonlyArray<QueueTimingAuditEntryLike>,
  windowMs: number = QUEUE_TIMING_THROUGHPUT_WINDOW_MS,
  now: Date = new Date(),
): Promise<Map<string, ThroughputResult>> {
  const result = new Map<string, ThroughputResult>();
  if (entries.length === 0) return result;

  type Row = {
    id: string;
    t: Date;
    beforeStart: Date;
    afterEnd: Date;
  };
  const rows: Row[] = entries.map((e) => {
    const t = e.changedAt instanceof Date ? e.changedAt : new Date(e.changedAt);
    return {
      id: e.id,
      t,
      beforeStart: new Date(t.getTime() - windowMs),
      afterEnd: new Date(t.getTime() + windowMs),
    };
  });

  const valuesList = sql.join(
    rows.map(
      (r) =>
        sql`(${r.id}::text, ${r.beforeStart}::timestamptz, ${r.t}::timestamptz, ${r.afterEnd}::timestamptz)`,
    ),
    sql`, `,
  );

  const queryResult = await getDb().execute(sql`
    WITH e(id, before_start, t, after_end) AS (
      VALUES ${valuesList}
    )
    SELECT e.id AS id,
           COUNT(*) FILTER (
             WHERE wq.completed_at >= e.before_start
               AND wq.completed_at <  e.t
           )::int AS before_count,
           COUNT(*) FILTER (
             WHERE wq.completed_at >= e.t
               AND wq.completed_at <  e.after_end
           )::int AS after_count
    FROM e
    LEFT JOIN work_queue wq
      ON wq.status = 'completed'
     AND wq.completed_at >= e.before_start
     AND wq.completed_at <  e.after_end
    GROUP BY e.id
  `);

  const countByEntry = new Map<string, { before: number; after: number }>();
  for (const r of queryResult.rows as Array<{
    id: string;
    before_count: number | string | null;
    after_count: number | string | null;
  }>) {
    countByEntry.set(String(r.id), {
      before: Number(r.before_count ?? 0),
      after: Number(r.after_count ?? 0),
    });
  }

  const nowMs = now.getTime();
  for (const r of rows) {
    const counts = countByEntry.get(r.id) ?? { before: 0, after: 0 };
    const postWindowEnd = r.t.getTime() + windowMs;
    const status: ThroughputStatus =
      nowMs < postWindowEnd
        ? "pending"
        : counts.before === 0
        ? "no_baseline"
        : "ok";
    result.set(r.id, {
      windowMs,
      before: counts.before,
      after: status === "pending" ? null : counts.after,
      status,
    });
  }

  return result;
}
