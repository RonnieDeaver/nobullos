// @cross-instance-safe: pure write via materializeFrontMessageRecord which dedupes on external_source_id.
/**
 * Task #2708 — Materialize individual messages for months where conversations
 * are already `applied` in front_sync_emails but their messages were never
 * written to raw_communication_records.
 *
 * Root cause: runTargetedWindowBackfill (the Step 3 driver in
 * reachFrontCoverageFullForMonth) tries to re-pull conversations from Front,
 * finds them already `applied`, and returns 100% `duplicate_ignored`. The
 * numerator never moves because no raw_communication_records rows are written.
 *
 * Fix: use the same bounded enumeration walk that the outbound-gap backfill
 * (Task #2010) uses — but with `collectAllMessages: true` so both inbound
 * AND outbound messages are captured — then write each genuinely-missing
 * message via the shared `materializeFrontMessageRecord` helper. Since that
 * helper dedupes on `external_source_id`, repeated calls are safe.
 *
 * Resumable: a per-month EnumerationCheckpoint is stored in system_settings
 * by the caller (reachFrontCoverageFullForMonth) so a large month (e.g.
 * 3,737 conversations) can be materialized incrementally across self-heal
 * ticks without re-walking from scratch. The checkpoint key uses the prefix
 * `applied_conv_materializer_checkpoint:`.
 *
 * Budget: one tick honours the default ENUM_CONVERSATIONS_PER_TICK_DEFAULT
 * / ENUM_MESSAGE_PAGES_PER_TICK_DEFAULT bounds from frontAnalyticsClient,
 * which aligns with the existing search-rate-limit guards. The caller loops
 * until done or until it hits its own per-month tick cap.
 */

import { sql, type SQL } from "drizzle-orm";
import {
  enumerateMonthlyMessagesByDirectionTickResolved,
  ENUM_CONVERSATIONS_PER_TICK_DEFAULT,
  ENUM_MESSAGE_PAGES_PER_TICK_DEFAULT,
  type EnumerationCheckpoint,
} from "./frontAnalyticsClient";
import { materializeFrontMessageRecord } from "./frontWebhookIngestion";

/** Source label stamped into each materialized row's rawPayloadJson.source. */
export const MATERIALIZATION_SOURCE = "applied_conv_materializer";

/**
 * Task #2714 — operator-tunable per-tick Front API call budget for the
 * applied-conversation materializer (the Step 2.5 driver of the Front Console
 * "Bring it to 100%" flow / `reach_front_coverage_full*`). Task #2713 removed
 * the duplicate re-walk waste, so the only remaining throughput limit is
 * Front's API rate limit — NOT the DB worker pool (already at its safe ceiling
 * against Neon's connection limit). These two `system_settings` rows let an
 * operator speed the backfill up (or slow it down to be gentle on Front)
 * WITHOUT a code change. Each tick's Front cost is bounded by:
 *   - `conversationBudget` — how many conversations are walked per tick, and
 *   - `messagePageBudget`  — total `GET /conversations/:id/messages` pages per tick.
 *
 * Front's published rate limits (https://dev.frontapp.com/docs/rate-limiting,
 * reviewed for this task): standard limit is per-COMPANY 50 rpm (Starter) /
 * 100 rpm (Professional) / 200 rpm (Enterprise); requests made by a partner
 * OAuth integration (how this app connects) get a SEPARATE per-company 120 rpm
 * budget that does not count against the customer's own limit. The Search and
 * `GET .../messages` routes are NOT on the "additional rate-limiting" tiers
 * (those are POST/PATCH writes + `POST /analytics/{reports,exports}`), so a
 * tick is bounded only by that per-minute budget, and the shared client already
 * honors 429 / `Retry-After` with a bounded retry budget. The knob is therefore
 * a throughput dial, not a hard rate guarantee — hence the generous safety
 * ceilings below to stop a fat-finger value, not to model the exact rpm.
 */
export const SETTING_MATERIALIZER_CONVERSATION_BUDGET =
  "front_analytics_materializer_conversation_budget_per_tick";
export const SETTING_MATERIALIZER_MESSAGE_PAGE_BUDGET =
  "front_analytics_materializer_message_page_budget_per_tick";

/**
 * Safety ceilings. A value above these clamps DOWN to the ceiling (still a
 * valid speed-up far beyond the defaults); a non-positive / non-finite / unset
 * value falls back to the in-code default so an empty row preserves today's
 * behavior exactly.
 */
export const MATERIALIZER_CONVERSATION_BUDGET_MAX = 1000;
export const MATERIALIZER_MESSAGE_PAGE_BUDGET_MAX = 5000;

function clampBudget(
  raw: string | null | undefined,
  fallback: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * Pure resolver: turns the two raw `system_settings` values into validated
 * per-tick budgets. Unset / blank / invalid → in-code defaults (today's
 * behavior); over-ceiling → clamped to the ceiling. Exported for direct unit
 * testing of the clamp/fallback contract.
 */
export function resolveMaterializerBudget(
  rawConversationBudget: string | null | undefined,
  rawMessagePageBudget: string | null | undefined,
): { conversationBudget: number; messagePageBudget: number } {
  return {
    conversationBudget: clampBudget(
      rawConversationBudget,
      ENUM_CONVERSATIONS_PER_TICK_DEFAULT,
      MATERIALIZER_CONVERSATION_BUDGET_MAX,
    ),
    messagePageBudget: clampBudget(
      rawMessagePageBudget,
      ENUM_MESSAGE_PAGES_PER_TICK_DEFAULT,
      MATERIALIZER_MESSAGE_PAGE_BUDGET_MAX,
    ),
  };
}

/**
 * Reads the two budget knobs from `system_settings` and resolves them. A read
 * that throws (pool blip) degrades to the in-code defaults rather than failing
 * the tick — the knob is a tuning aid, never a hard dependency.
 */
async function loadMaterializerBudget(): Promise<{
  conversationBudget: number;
  messagePageBudget: number;
}> {
  const { getSystemSetting } = await import("../storage/settingsStorage");
  const [convRow, msgPageRow] = await Promise.all([
    getSystemSetting(SETTING_MATERIALIZER_CONVERSATION_BUDGET).catch(() => null),
    getSystemSetting(SETTING_MATERIALIZER_MESSAGE_PAGE_BUDGET).catch(() => null),
  ]);
  return resolveMaterializerBudget(convRow?.value, msgPageRow?.value);
}

/**
 * Prefix for the per-month resumption checkpoint keys stored in
 * `system_settings` by `reachFrontCoverageFullForMonth`. A non-empty value
 * under `${CHECKPOINT_KEY_PREFIX}${month}` means materialization for that
 * month is still in progress; the caller clears the value (sets it to "")
 * once the enumeration walk reports done.
 */
export const CHECKPOINT_KEY_PREFIX = "applied_conv_materializer_checkpoint:";

/** Minimal DB handle shape so callers can pass either the api or worker pool. */
type DbExecutor = { execute: (query: SQL) => Promise<{ rows: any[] }> };

/** Per-month materialization progress derived from a live checkpoint row. */
export interface MaterializationMonthProgress {
  /** YYYY-MM month the checkpoint belongs to. */
  month: string;
  /** Conversations fully walked (materialized) so far. */
  done: number;
  /**
   * Total conversations to materialize for the month, or `null` while the
   * Conversations Search walk is still discovering more (total not yet known).
   * Known once search pagination is exhausted: done + still-pending.
   */
  total: number | null;
}

/**
 * Read every live materialization checkpoint and derive per-month progress.
 * A checkpoint row whose value is empty / blank means that month finished and
 * is skipped, so the returned list contains only months actively materializing.
 * Months are sorted ascending so the detail string is stable.
 */
export async function listActiveMaterializationProgress(
  db: DbExecutor,
): Promise<MaterializationMonthProgress[]> {
  const result = await db.execute(sql`
    SELECT key, value
    FROM system_settings
    WHERE key LIKE ${CHECKPOINT_KEY_PREFIX + "%"}
  `);
  const out: MaterializationMonthProgress[] = [];
  for (const row of (result.rows ?? []) as Array<{
    key: string;
    value: string | null;
  }>) {
    const value = row.value?.trim();
    if (!value) continue; // cleared checkpoint → month done, skip
    let cp: Partial<EnumerationCheckpoint> | null = null;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") cp = parsed;
    } catch {
      continue; // corrupt checkpoint — nothing meaningful to surface
    }
    if (!cp) continue;
    const month = row.key.slice(CHECKPOINT_KEY_PREFIX.length);
    const done = Number(cp.processedConversationCount ?? 0) || 0;
    const pending = Array.isArray(cp.pendingConversationIds)
      ? cp.pendingConversationIds.length
      : 0;
    // The grand total is only known once search pagination is exhausted
    // (searchStarted AND no next page); until then more conversations may
    // still be discovered, so we cannot honestly report an "of M".
    const searchExhausted =
      cp.searchStarted === true &&
      (cp.searchNextUrl === null || cp.searchNextUrl === undefined);
    out.push({ month, done, total: searchExhausted ? done + pending : null });
  }
  out.sort((a, b) => a.month.localeCompare(b.month));
  return out;
}

/**
 * Format per-month progress into a human sentence fragment, e.g.
 * "materializing messages for 2025-09: 1,200 of 3,737 conversations done".
 * Returns "" when nothing is materializing so callers can append unconditionally.
 */
export function formatMaterializationProgressDetail(
  rows: MaterializationMonthProgress[],
): string {
  if (rows.length === 0) return "";
  return rows
    .map((r) =>
      r.total !== null
        ? `materializing messages for ${r.month}: ${r.done.toLocaleString()} of ${r.total.toLocaleString()} conversations done`
        : `materializing messages for ${r.month}: ${r.done.toLocaleString()} conversations done so far`,
    )
    .join("; ");
}

/**
 * Convenience: read checkpoints and format them in one call, swallowing any
 * read error to "" so surfacing progress can never break a status endpoint.
 */
export async function getMaterializationProgressDetail(
  db: DbExecutor,
): Promise<string> {
  try {
    return formatMaterializationProgressDetail(
      await listActiveMaterializationProgress(db),
    );
  } catch {
    return "";
  }
}

export interface MaterializeTickResult {
  /** Messages inserted into raw_communication_records this tick. */
  inserted: number;
  /** Messages skipped (already present by external_source_id dedup). */
  skipped: number;
  /** True when the enumeration walk has exhausted all conversations for the month. */
  done: boolean;
  /** Updated checkpoint to pass to the next tick. */
  checkpoint: EnumerationCheckpoint;
}

/**
 * Test-only override for the materializeFrontMessageRecord call so smoke
 * tests can inject a fake writer without a real DB connection.
 * Production code never sets this; it remains null at runtime.
 */
type MaterializeFn = typeof materializeFrontMessageRecord;
let _materializerOverride: MaterializeFn | null = null;

export const __frontAppliedConvMaterializerTestHelpers = {
  setMaterializerOverride: (fn: MaterializeFn | null): void => {
    _materializerOverride = fn;
  },
};

/**
 * One bounded tick: enumerate up to the operator-tunable per-tick conversation
 * / message-page budget (Task #2714 — `loadMaterializerBudget`, defaulting to
 * the in-code constants) of conversations for `month`, collect ALL their
 * in-window messages (both inbound and outbound), and write missing rows via
 * materializeFrontMessageRecord.
 *
 * Write-before-checkpoint: rows are written BEFORE the advanced checkpoint
 * is returned to the caller, so an interruption re-walks the tick (idempotent
 * via the per-message dedup) rather than skipping un-written messages.
 *
 * @param month    YYYY-MM string (used only for logging).
 * @param monthStart  UTC start of the month.
 * @param monthEnd    UTC start of the following month (exclusive).
 * @param checkpoint  Resumption checkpoint from the previous tick, or null for
 *                    a fresh walk.
 */
export async function materializeAppliedConvMessagesForMonthTick(
  month: string,
  monthStart: Date,
  monthEnd: Date,
  checkpoint: EnumerationCheckpoint | null,
): Promise<MaterializeTickResult> {
  const { conversationBudget, messagePageBudget } =
    await loadMaterializerBudget();

  const tick = await enumerateMonthlyMessagesByDirectionTickResolved({
    monthStart,
    monthEnd,
    checkpoint,
    collectAllMessages: true,
    conversationBudget,
    messagePageBudget,
  });

  const collected = tick.allMessagesThisTick ?? [];
  let inserted = 0;
  let skipped = 0;

  const materializeFn = _materializerOverride ?? materializeFrontMessageRecord;

  for (const item of collected) {
    try {
      const outcome = await materializeFn({
        msg: item.message,
        conversationId: item.conversationId,
        subject: item.conversationSubject || "(no subject)",
        fallbackTimestamp: monthStart,
        source: MATERIALIZATION_SOURCE,
      });
      if (outcome === "inserted") inserted++;
      else skipped++;
    } catch (perMsgErr: any) {
      skipped++;
      // Surface the underlying Postgres error (Drizzle wraps it as `cause`,
      // logging only "Failed query: …" otherwise) so the next breakage
      // self-explains instead of hiding the constraint/column at fault.
      const cause = (perMsgErr as any)?.cause;
      console.warn(
        `[FrontAppliedConvMaterializer] month=${month} conv=${item.conversationId} msg write failed: ${
          perMsgErr?.message ?? perMsgErr
        }${cause ? ` | cause: ${(cause as any)?.message ?? cause}` : ""}`,
      );
    }
  }

  return {
    inserted,
    skipped,
    done: tick.done,
    checkpoint: tick.checkpoint,
  };
}
