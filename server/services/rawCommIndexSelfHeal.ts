// @db-pool-intent: ambient
/**
 * Task #3703 — Detect + self-heal a vanished `raw_comm_external_source_id_unique_idx`.
 *
 * The Front per-message materializer writes via
 * `createRawCommunicationOnConflictSkip`, whose
 * `ON CONFLICT (external_source_id) WHERE external_source_id IS NOT NULL DO NOTHING`
 * clause needs the partial unique index
 * `raw_comm_external_source_id_unique_idx` as its conflict arbiter. That
 * index is deliberately raw-SQL-managed (created at bootstrap by
 * `ensureExternalSourceIdUnique()` in server/index.ts, intentionally NOT in
 * shared/schema.ts), so schema-diffing operations can silently drop it. When
 * that happens, EVERY materializer insert raises Postgres error 42P10
 * ("there is no unique or exclusion constraint matching the ON CONFLICT
 * specification") which used to be swallowed into per-message
 * "msg write failed" warn lines — no alert, no self-heal, Front email rows
 * silently stop landing (see .agents/memory/bootstrap-raw-sql-objects-drift.md).
 *
 * This module:
 *   - classifies that exact error class (`isMissingOnConflictArbiterError`,
 *     walking the drizzle `cause` chain),
 *   - performs the SAME self-heal the bootstrap does (dedupe keep-oldest by
 *     created_at, then CREATE UNIQUE INDEX IF NOT EXISTS), at most ONCE per
 *     process (single-flight latch — a second drop in the same process
 *     surfaces as a hard error rather than a heal loop),
 *   - fires a real infra alert via notifyByType with a dedupe key, whether or
 *     not the heal succeeded, so the on-call hears about the drop instead of
 *     discovering it via sagging coverage numbers.
 *
 * The heal runs through `getDb()` so the tx/isolated-schema test sandboxes
 * pin it alongside the failing insert.
 */

import { sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../db";

export const RAW_COMM_UNIQUE_INDEX_NAME =
  "raw_comm_external_source_id_unique_idx";

/** Pg error code for "no unique or exclusion constraint matching the ON CONFLICT specification". */
const PG_INVALID_COLUMN_REFERENCE = "42P10";

const ARBITER_MISSING_MESSAGE =
  "no unique or exclusion constraint matching the ON CONFLICT specification";

/**
 * True when `err` (or anything on its `cause` chain — drizzle wraps the pg
 * error as `cause` with a bare "Failed query: …" outer message) is the
 * missing-ON-CONFLICT-arbiter error class.
 */
export function isMissingOnConflictArbiterError(err: unknown): boolean {
  let current: any = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current.code === PG_INVALID_COLUMN_REFERENCE) return true;
    const msg = typeof current.message === "string" ? current.message : "";
    if (msg.includes(ARBITER_MISSING_MESSAGE)) return true;
    current = current.cause;
  }
  return false;
}

// ── notifyByType injection (test seam, same pattern as other infra alerts) ──
type NotifyByTypeFn = typeof import("./notifications/dispatcher").notifyByType;
let _notifyOverride: NotifyByTypeFn | null = null;

// ── once-per-process heal latch ──
let _healPromise: Promise<boolean> | null = null;
let _healAttempted = false;

export const __rawCommIndexSelfHealTestHelpers = {
  setNotifyByTypeOverride: (fn: NotifyByTypeFn | null): void => {
    _notifyOverride = fn;
  },
  reset: (): void => {
    _healPromise = null;
    _healAttempted = false;
  },
};

async function performHeal(): Promise<boolean> {
  return withDbAttribution("rawCommIndexSelfHeal:heal", async () => {
  const db = getDb();

  // Same dedupe the bootstrap does: keep the oldest row per external_source_id
  // so the unique index can be created even if duplicates snuck in while the
  // arbiter was missing.
  const dupeResult = await db.execute(sql`
    SELECT external_source_id, COUNT(*) as cnt
    FROM raw_communication_records
    WHERE external_source_id IS NOT NULL
    GROUP BY external_source_id
    HAVING COUNT(*) > 1
  `);
  const dupeCount = (dupeResult as any).rows?.length ?? 0;
  if (dupeCount > 0) {
    console.log(
      `[RawCommIndexSelfHeal] Deduplicating ${dupeCount} external_source_id groups (keeping oldest by created_at)...`,
    );
    await db.execute(sql`
      DELETE FROM raw_communication_records
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY external_source_id
            ORDER BY created_at ASC
          ) as rn
          FROM raw_communication_records
          WHERE external_source_id IS NOT NULL
        ) ranked
        WHERE rn > 1
      )
    `);
  }

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS raw_comm_external_source_id_unique_idx
    ON raw_communication_records (external_source_id)
    WHERE external_source_id IS NOT NULL
  `);
  console.log(
    `[RawCommIndexSelfHeal] Recreated missing unique index ${RAW_COMM_UNIQUE_INDEX_NAME}`,
  );
  return true;
  });
}

async function fireAlert(healed: boolean, healError?: unknown): Promise<void> {
  try {
    const notifyByType =
      _notifyOverride ??
      (await import("./notifications/dispatcher")).notifyByType;
    const outcome = healed
      ? "Self-heal SUCCEEDED: duplicates pruned (keep-oldest) and the index was recreated in-process; writes should be flowing again."
      : `Self-heal FAILED (${(healError as any)?.message ?? healError ?? "unknown error"}); Front email materialization is DOWN until the index is restored (a server restart re-runs the bootstrap ensure).`;
    await notifyByType(
      "infra.database.raw_comm_unique_index_missing",
      {
        text:
          `🚨 Partial unique index ${RAW_COMM_UNIQUE_INDEX_NAME} is MISSING from raw_communication_records. ` +
          `Every Front per-message materializer insert was failing with the missing-ON-CONFLICT-arbiter error (42P10). ` +
          `This index is raw-SQL-managed (bootstrap in server/index.ts, not shared/schema.ts) and can be dropped by schema-diffing operations. ` +
          outcome,
      },
      {
        triggerSource: "alert_service",
        dedupeKey: "raw_comm_unique_index_missing:global",
        failureType: healed ? "healed" : "heal_failed",
      },
    );
  } catch (alertErr) {
    // Alerting must never mask the underlying write failure.
    console.error(
      "[RawCommIndexSelfHeal] Failed to dispatch missing-index alert:",
      (alertErr as any)?.message ?? alertErr,
    );
  }
}

/**
 * Called by the leaf writer when it hits the missing-arbiter error class.
 * Runs the heal at most once per process (single-flight; concurrent callers
 * share the same attempt) and fires the infra alert with the heal outcome.
 *
 * Returns true when the index was recreated by THIS process's (single) heal
 * attempt — the caller may then retry its insert once. Returns false when the
 * heal already ran earlier in this process (a repeat drop is NOT re-healed —
 * something is actively fighting the index and looping heals would mask it)
 * or when the heal itself failed.
 */
export async function reportAndHealMissingArbiterIndex(): Promise<boolean> {
  if (_healAttempted && !_healPromise) {
    // A previous attempt already resolved; do not heal again this process.
    return false;
  }
  if (!_healPromise) {
    _healAttempted = true;
    _healPromise = (async () => {
      console.error(
        `[RawCommIndexSelfHeal] Missing ON CONFLICT arbiter detected — ${RAW_COMM_UNIQUE_INDEX_NAME} vanished; attempting one-shot self-heal`,
      );
      let healed = false;
      let healError: unknown;
      try {
        healed = await performHeal();
      } catch (err) {
        healError = err;
        console.error(
          "[RawCommIndexSelfHeal] Self-heal failed:",
          (err as any)?.message ?? err,
        );
      }
      await fireAlert(healed, healError);
      return healed;
    })().finally(() => {
      // Latch stays set via _healAttempted; clear the promise so the
      // "already attempted" fast-path above takes over.
      _healPromise = null;
    });
    return _healPromise;
  }
  // Concurrent caller while the first heal is in flight: share its outcome.
  return _healPromise;
}
