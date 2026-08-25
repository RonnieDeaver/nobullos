// @cross-instance-safe: enqueue-only tick — enqueues a dedupe-keyed work_queue job; the handler runs once per claim and duplicate enqueues collapse via wq_dedupe_key_idx.
/**
 * Task #2010 — Fill in missing outbound messages, not just count them.
 *
 * The per-direction coverage row (Task #1974) exposes
 * `messages_outbound_gap` = max(messages_outbound_front -
 * messages_outbound_local, 0): outbound messages Front Analytics says
 * were sent during a month that NoBull never stored as a
 * `raw_communication_records` row. Task #1983 made the *measurement* walk
 * (`enumerateMonthlyMessagesByDirectionTick`) resumable; Task #1984's
 * close-gap driver (`frontOutboundGapCloser.ts`) repairs the gap by
 * re-driving the whole month through Historical Recovery.
 *
 * This module is the cheaper, message-grain *repair* the task asks for.
 * Instead of re-listing AND re-hydrating every conversation in the month
 * (what recovery does — ~2× the Front budget under Front's search-rate
 * cap), it runs the SAME bounded enumeration walk used for measurement
 * with `collectOutboundMessages: true`, so each conversation's messages
 * are fetched ONCE. It then dedupes the in-window outbound message ids
 * against `raw_communication_records.external_source_id` (inside the
 * shared `materializeFrontMessageRecord` helper) and writes only the
 * genuinely-missing rows through the existing ingestion write path.
 *
 * Relationship to Task #1984: both close the same gap and both are
 * idempotent + dedupe-on-write, so they are safe to run together. Prefer
 * THIS driver when Front budget is tight (single fetch per conversation);
 * prefer recovery when you also want the conversation envelope re-applied
 * through the apply pipeline. This driver does NOT depend on the
 * `front_recovery_per_message_materialization_enabled` switch — it writes
 * per-message rows directly.
 *
 * Bounded + resumable + gated, mirroring the closer:
 *   - default-OFF master switch (spawns real ingestion writes),
 *   - per-tick month budget,
 *   - per-month enumeration checkpoint so a large month resumes across
 *     ticks instead of re-walking from scratch,
 *   - honors queue-pause + `KILL_SWITCH_NON_CRITICAL_SWEEPS`,
 *   - persists a last-run JSON summary for the operator readout.
 */
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { PERF } from "../perfConfig";
import { isQueuePaused } from "./queueDrainControl";
import {
  enumerateMonthlyMessagesByDirectionTickResolved,
  type EnumerationCheckpoint,
} from "./frontAnalyticsClient";
import { materializeFrontMessageRecord } from "./frontWebhookIngestion";
import {
  selectOutboundGapMonths,
  selectOutboundGapMonthsForMonth,
  countOutboundLocalForMonth,
} from "./frontOutboundGapCloser";

export const QUEUE_NAME = "front_outbound_gap_backfill";

/** Master enable switch. Default OFF — opt-in because the tick writes
 * real `raw_communication_records` rows, not measurement. */
export const SETTING_ENABLED = "front_outbound_gap_backfill_enabled";

/** Per-tick budget: how many gap months to walk per tick. Bounded
 * 1..MAX so a backlog of gap months can never fan out unboundedly. */
export const SETTING_MAX_MONTHS_PER_TICK =
  "front_outbound_gap_backfill_max_months_per_tick";

const DEFAULT_MAX_MONTHS_PER_TICK = 1;
const MAX_MONTHS_PER_TICK_CAP = 12;

/** Per-month resumable enumeration checkpoint key prefix. */
export const SETTING_CHECKPOINT_PREFIX =
  "front_outbound_gap_backfill_checkpoint:";

/** Persisted JSON summary of the most recent tick (operator readout). */
export const SETTING_LAST_RUN = "front_outbound_gap_backfill_last_run";

/** Stamped into each written row's `rawPayloadJson.source` so prod can
 * tell this driver's rows apart from recovery's. */
export const MATERIALIZATION_SOURCE = "outbound_gap_backfill";

export const TICK_INTERVAL_MS = Number(
  process.env.FRONT_OUTBOUND_GAP_BACKFILL_INTERVAL_MS || 60 * 60_000,
);

let interval: ReturnType<typeof setInterval> | null = null;

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

async function loadMaxMonthsPerTick(): Promise<number> {
  const raw = (
    await getSystemSetting(SETTING_MAX_MONTHS_PER_TICK).catch(() => null)
  )?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_MONTHS_PER_TICK;
  return Math.min(MAX_MONTHS_PER_TICK_CAP, Math.floor(n));
}

function checkpointKey(month: string): string {
  return `${SETTING_CHECKPOINT_PREFIX}${month}`;
}

async function loadCheckpoint(
  month: string,
): Promise<EnumerationCheckpoint | null> {
  const raw = (
    await getSystemSetting(checkpointKey(month)).catch(() => null)
  )?.value?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as EnumerationCheckpoint)
      : null;
  } catch {
    // A corrupt checkpoint just restarts the month from scratch — the
    // per-message dedupe makes a full re-walk idempotent.
    return null;
  }
}

async function saveCheckpoint(
  month: string,
  cp: EnumerationCheckpoint,
): Promise<void> {
  await setSystemSetting(checkpointKey(month), JSON.stringify(cp));
}

async function clearCheckpoint(month: string): Promise<void> {
  try {
    await setSystemSetting(checkpointKey(month), "");
  } catch (err: any) {
    console.warn(
      `[FrontOutboundGapBackfill] failed to clear checkpoint month=${month}: ${
        err?.message ?? err
      }`,
    );
  }
}

export type GapMonthOutcome =
  | "backfilled"
  | "month_complete"
  | "already_closed"
  | "front_count_unknown";

export interface GapMonthAttempt {
  month: string;
  outcome: GapMonthOutcome;
  /** Outbound gap recomputed from the fresh local count vs. stored Front count. */
  remainingGap: number | null;
  /** Outbound messages seen in-window this tick. */
  outboundSeen: number;
  /** New `raw_communication_records` rows written this tick. */
  inserted: number;
  /** Already-present (deduped) outbound messages this tick. */
  skipped: number;
  /** True once the month's walk is fully drained (checkpoint cleared). */
  done: boolean;
}

export interface OutboundGapBackfillTickResult {
  ranAt: string;
  enabled: boolean;
  paused: boolean;
  maxMonthsPerTick: number;
  candidateMonths: number;
  attempted: GapMonthAttempt[];
  reason?: string;
  /** Present when scoped to a single operator-chosen month. */
  scopedMonth?: string;
}

/**
 * Persist the most recent tick summary so the operator status route can
 * surface what the backfill last did without scraping worker logs. Never
 * throws — a persistence failure must not fail the tick.
 */
async function persistLastRun(
  result: OutboundGapBackfillTickResult,
): Promise<void> {
  try {
    await setSystemSetting(SETTING_LAST_RUN, JSON.stringify(result));
  } catch (err: any) {
    console.warn(
      `[FrontOutboundGapBackfill] Failed to persist last-run summary: ${
        err?.message ?? err
      }`,
    );
  }
}

/**
 * Read the persisted last-run summary, or null if the backfill has not
 * run yet (or the stored value is unparseable). Never throws.
 */
export async function getLastOutboundGapBackfillRun(): Promise<OutboundGapBackfillTickResult | null> {
  let raw: string | undefined;
  try {
    raw = (await getSystemSetting(SETTING_LAST_RUN))?.value?.trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as OutboundGapBackfillTickResult)
      : null;
  } catch {
    return null;
  }
}

/**
 * One backfill pass. Reads gap months, re-verifies each gap against a
 * fresh local count, then runs ONE bounded enumeration-walk tick per
 * still-real month (collecting outbound messages) and writes the missing
 * rows via the shared ingestion helper BEFORE persisting the advanced
 * checkpoint — so a crash between write and checkpoint-save only causes a
 * harmless idempotent re-walk, never a lost row. Never throws on a
 * per-month failure; the next tick retries. Persists the summary as the
 * last-run readout before returning.
 */
export async function runOutboundGapBackfillTick(opts?: {
  now?: Date;
  /** When set, scope to this single month (YYYY-MM). */
  month?: string;
}): Promise<OutboundGapBackfillTickResult> {
  const result = await computeOutboundGapBackfillTick(opts);
  await persistLastRun(result);
  return result;
}

async function computeOutboundGapBackfillTick(opts?: {
  now?: Date;
  month?: string;
}): Promise<OutboundGapBackfillTickResult> {
  const now = opts?.now ?? new Date();
  const scopedMonth = opts?.month;
  const enabled = parseBool(
    (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
    false,
  );
  const paused = isQueuePaused(QUEUE_NAME);
  const maxMonthsPerTick = await loadMaxMonthsPerTick();
  const result: OutboundGapBackfillTickResult = {
    ranAt: now.toISOString(),
    enabled,
    paused,
    maxMonthsPerTick,
    candidateMonths: 0,
    attempted: [],
    ...(scopedMonth ? { scopedMonth } : {}),
  };

  if (!enabled) {
    result.reason = "backfill disabled in system_settings";
    return result;
  }
  if (paused) {
    result.reason = "queue paused via queue_drain_state";
    return result;
  }
  if (PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS) {
    result.reason = "KILL_SWITCH_NON_CRITICAL_SWEEPS=true";
    return result;
  }

  const candidates = scopedMonth
    ? await selectOutboundGapMonthsForMonth(scopedMonth)
    : await selectOutboundGapMonths(maxMonthsPerTick);
  result.candidateMonths = candidates.length;
  if (candidates.length === 0) {
    result.reason = scopedMonth
      ? `month ${scopedMonth} has no coverage row to backfill`
      : "no months with messages_outbound_gap > 0";
    return result;
  }

  for (const m of candidates) {
    // Re-verify the gap is still real with a fresh local count — the
    // stored gap can be stale if ingestion already caught up.
    const freshLocal = await countOutboundLocalForMonth(
      m.monthStart,
      m.monthEnd,
    );
    if (m.messagesOutboundFront == null) {
      result.attempted.push({
        month: m.month,
        outcome: "front_count_unknown",
        remainingGap: null,
        outboundSeen: 0,
        inserted: 0,
        skipped: 0,
        done: false,
      });
      continue;
    }
    const remainingGap = Math.max(0, m.messagesOutboundFront - freshLocal);
    if (remainingGap <= 0) {
      // Already caught up — drop any stale checkpoint so a future
      // re-opened gap starts clean.
      await clearCheckpoint(m.month);
      result.attempted.push({
        month: m.month,
        outcome: "already_closed",
        remainingGap: 0,
        outboundSeen: 0,
        inserted: 0,
        skipped: 0,
        done: true,
      });
      continue;
    }

    try {
      const checkpoint = await loadCheckpoint(m.month);
      const tick = await enumerateMonthlyMessagesByDirectionTickResolved({
        monthStart: m.monthStart,
        monthEnd: m.monthEnd,
        checkpoint,
        collectOutboundMessages: true,
      });

      const collected = tick.outboundMessagesThisTick ?? [];
      let inserted = 0;
      let skipped = 0;
      // WRITE the missing rows BEFORE persisting the advanced checkpoint,
      // so an interruption re-walks (idempotent) rather than skipping
      // un-written messages.
      for (const item of collected) {
        try {
          const outcome = await materializeFrontMessageRecord({
            msg: item.message,
            conversationId: item.conversationId,
            subject: item.conversationSubject || "(no subject)",
            fallbackTimestamp: m.monthStart,
            source: MATERIALIZATION_SOURCE,
          });
          if (outcome === "inserted") inserted++;
          else skipped++;
        } catch (perMsgErr: any) {
          skipped++;
          console.warn(
            `[FrontOutboundGapBackfill] month=${m.month} conv=${item.conversationId} msg write failed: ${
              perMsgErr?.message ?? perMsgErr
            }`,
          );
        }
      }

      if (tick.done) {
        await clearCheckpoint(m.month);
      } else {
        await saveCheckpoint(m.month, tick.checkpoint);
      }

      result.attempted.push({
        month: m.month,
        outcome: tick.done ? "month_complete" : "backfilled",
        remainingGap,
        outboundSeen: collected.length,
        inserted,
        skipped,
        done: tick.done,
      });
    } catch (err: any) {
      // Any walk/write failure: log and move on (non-throwing). The
      // checkpoint is left untouched so the next tick resumes.
      console.warn(
        `[FrontOutboundGapBackfill] month=${m.month} backfill tick failed: ${
          err?.message ?? err
        }`,
      );
      result.attempted.push({
        month: m.month,
        outcome: "backfilled",
        remainingGap,
        outboundSeen: 0,
        inserted: 0,
        skipped: 0,
        done: false,
      });
    }
  }

  return result;
}

async function enqueueScheduledTick(): Promise<void> {
  try {
    if (isQueuePaused(QUEUE_NAME)) {
      console.log(
        `[FrontOutboundGapBackfill] enqueue_skipped_queue_paused queue=${QUEUE_NAME} reason=queue_drain_state ts=${new Date().toISOString()}`,
      );
      return;
    }
    // Cheap due-check: skip enqueue entirely when disabled so a default-
    // OFF deploy never piles up no-op jobs.
    const enabled = parseBool(
      (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
      false,
    );
    if (!enabled) return;
    const { enqueueJob } = await import("./workScheduler");
    const bucket = Math.floor(Date.now() / TICK_INTERVAL_MS);
    await enqueueJob({
      queueName: QUEUE_NAME,
      workloadClass: "maintenance",
      priority: 200,
      payload: { trigger: "scheduled", bucket },
      dedupeKey: `${QUEUE_NAME}:scheduled:${bucket}`,
      maxAttempts: 2,
    });
  } catch (err: any) {
    console.warn(
      `[FrontOutboundGapBackfill] enqueue scheduled tick failed: ${
        err?.message ?? err
      }`,
    );
  }
}

export function startFrontOutboundGapBackfillScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void enqueueScheduledTick();
  }, TICK_INTERVAL_MS);
  console.log(
    `[FrontOutboundGapBackfill] enqueue scheduler started (every ${
      TICK_INTERVAL_MS / 60_000
    }min; default OFF via ${SETTING_ENABLED}) — work runs in worker pool via ${QUEUE_NAME} queue`,
  );
}

export function stopFrontOutboundGapBackfillScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __frontOutboundGapBackfillTestHelpers = {
  enqueueScheduledTick,
  loadMaxMonthsPerTick,
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  checkpointKey,
};
