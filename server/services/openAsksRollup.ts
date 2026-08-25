// @db-pool-intent: mixed — no pool of its own: every query runs on the
// caller-supplied executor (route → API `db`, digest → worker getDb()).
/**
 * Task #3694 — cross-client "aging asks & promises" rollup.
 *
 * One shared query over `client_open_asks` joined to active clients and
 * their owners, consumed by BOTH:
 *   - GET /api/churn/open-asks (Churn Command Center "Promises & Asks" tab)
 *   - the Monday-morning weekly digest (server/services/openAsksDigest.ts)
 *
 * Scope rules (task brief "Done looks like"):
 *   - only `open` / `likely_open` asks — the daily judgment pipeline owns
 *     every other lifecycle state, and resolve/dismiss goes through the
 *     existing per-client PATCH endpoint, never through this module;
 *   - archived and demo clients are excluded unconditionally;
 *   - default ranking blends age and concern multiplicatively
 *     (rank_score = age_days * effective_concern). concern_score already
 *     grows +1 each time the client re-raises the ask, so mention
 *     frequency is priced into the blend without a separate term.
 *
 * DB-pool note: this module deliberately takes its executor from the
 * caller (the route passes the API `db`, the digest passes `getDb()`
 * under its scheduler attribution) so the pool each query lands on is
 * the caller's responsibility. No `getDb()` call lives here.
 */

import { sql, type SQL } from "drizzle-orm";
import { openAskActiveStatuses } from "@shared/schema";

export const openAskRollupSortOptions = ["rank", "age", "concern", "mentions"] as const;
export type OpenAskRollupSort = (typeof openAskRollupSortOptions)[number];

export interface OpenAsksRollupFilters {
  /** `client_ask` | `internal_promise` — validated by the route. */
  askType?: string;
  ownerId?: string;
  clientId?: string;
  sort?: OpenAskRollupSort;
  limit?: number;
}

export interface OpenAskRollupItem {
  id: string;
  clientId: string;
  firmName: string;
  clientCode: string | null;
  ownerId: string | null;
  ownerName: string | null;
  askType: string;
  status: string;
  summary: string;
  detail: string | null;
  askCategory: string | null;
  relatedPromiseText: string | null;
  /** GREATEST(COALESCE(concern_score, 1), 1) — the value ranking uses. */
  concernScore: number;
  mentionCount: number;
  firstMentionedAt: string | null;
  lastReferencedAt: string | null;
  /** Fractional days since first mention (falls back to created_at). */
  ageDays: number;
  /** ageDays * concernScore — the default ranking blend. */
  rankScore: number;
}

/** Minimal executor shape satisfied by both the API `db` and `getDb()`. */
export interface OpenAsksRollupExecutor {
  execute(query: SQL): Promise<unknown>;
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toNum(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ORDER BY fragments keyed by sort option. Aliases (rank_score, age_days,
// effective_concern, effective_mentions) are defined in the SELECT list;
// Postgres allows bare alias references in ORDER BY. Every ordering ends
// with `a.id ASC` so ties are deterministic for tests and paging.
const ORDER_BY: Record<OpenAskRollupSort, SQL> = {
  rank: sql`rank_score DESC, age_days DESC, a.id ASC`,
  age: sql`age_days DESC, rank_score DESC, a.id ASC`,
  concern: sql`effective_concern DESC, age_days DESC, a.id ASC`,
  mentions: sql`effective_mentions DESC, age_days DESC, a.id ASC`,
};

export async function fetchOpenAsksRollup(
  executor: OpenAsksRollupExecutor,
  filters: OpenAsksRollupFilters = {},
): Promise<OpenAskRollupItem[]> {
  const sort: OpenAskRollupSort = filters.sort ?? "rank";

  const conditions: SQL[] = [
    // Lifecycle scope — the shared active-set definition (Task #4765:
    // openAskActiveStatuses is the ONE source every reader derives from).
    sql`a.status IN (${sql.join(openAskActiveStatuses.map((s) => sql`${s}`), sql`, `)})`,
    // Archived/demo clients never appear (task brief hard rule).
    sql`COALESCE(c.is_archived, false) = false`,
    sql`COALESCE(c.is_demo, false) = false`,
  ];
  if (filters.askType) conditions.push(sql`a.ask_type = ${filters.askType}`);
  if (filters.ownerId) conditions.push(sql`c.owner_id = ${filters.ownerId}`);
  if (filters.clientId) conditions.push(sql`a.client_id = ${filters.clientId}`);

  const limit = Number.isFinite(filters.limit) && (filters.limit as number) > 0
    ? Math.floor(filters.limit as number)
    : null;

  const query = sql`
    SELECT
      a.id,
      a.client_id,
      c.firm_name,
      c.client_code,
      c.owner_id,
      TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))) AS owner_name_raw,
      u.email AS owner_email,
      a.ask_type,
      a.status,
      a.summary,
      a.detail,
      a.ask_category,
      a.related_promise_text,
      GREATEST(COALESCE(a.concern_score, 1), 1) AS effective_concern,
      GREATEST(COALESCE(a.mention_count, 1), 1) AS effective_mentions,
      a.first_mentioned_at,
      a.last_referenced_at,
      EXTRACT(EPOCH FROM (NOW() - COALESCE(a.first_mentioned_at, a.created_at, NOW()))) / 86400.0 AS age_days,
      (EXTRACT(EPOCH FROM (NOW() - COALESCE(a.first_mentioned_at, a.created_at, NOW()))) / 86400.0)
        * GREATEST(COALESCE(a.concern_score, 1), 1) AS rank_score
    FROM client_open_asks a
    JOIN clients c ON c.id = a.client_id
    LEFT JOIN users u ON u.id = c.owner_id
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY ${ORDER_BY[sort]}
    ${limit ? sql`LIMIT ${limit}` : sql``}
  `;

  const result = await executor.execute(query);
  // Raw-SQL execute returns a pg QueryResult (rows live on `.rows`), not a
  // mapped array.
  const rows: Record<string, unknown>[] = (result as { rows?: Record<string, unknown>[] })?.rows ?? [];

  return rows.map((r) => {
    const nameRaw = typeof r.owner_name_raw === "string" ? r.owner_name_raw.trim() : "";
    const ownerEmail = typeof r.owner_email === "string" ? r.owner_email : null;
    return {
      id: String(r.id),
      clientId: String(r.client_id),
      firmName: String(r.firm_name ?? ""),
      clientCode: r.client_code == null ? null : String(r.client_code),
      ownerId: r.owner_id == null ? null : String(r.owner_id),
      ownerName: nameRaw.length > 0 ? nameRaw : ownerEmail,
      askType: String(r.ask_type ?? "client_ask"),
      status: String(r.status ?? "open"),
      summary: String(r.summary ?? ""),
      detail: r.detail == null ? null : String(r.detail),
      askCategory: r.ask_category == null ? null : String(r.ask_category),
      relatedPromiseText: r.related_promise_text == null ? null : String(r.related_promise_text),
      concernScore: round2(toNum(r.effective_concern, 1)),
      mentionCount: Math.round(toNum(r.effective_mentions, 1)),
      firstMentionedAt: toIso(r.first_mentioned_at),
      lastReferencedAt: toIso(r.last_referenced_at),
      ageDays: round2(toNum(r.age_days, 0)),
      rankScore: round2(toNum(r.rank_score, 0)),
    };
  });
}
