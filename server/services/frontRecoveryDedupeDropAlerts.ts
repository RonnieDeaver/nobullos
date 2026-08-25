/**
 * Task #1872 — surface apply-layer dedupe drops as a first-class
 * operator signal.
 *
 * Task #1869 Step 6 added a per-page sample log
 * (`front_recovery_dedupe_sample`) with one of three verdicts:
 *   • `apply_layer_dropping` — sampled dedupe-hit conversations exist
 *     in `front_sync_emails` as `discovered`/missing, meaning the
 *     apply layer is silently dropping recovered conversations
 *     instead of persisting them.
 *   • `coverage_denominator_likely_wrong` — every sampled row is
 *     `applied`; recovery worked, the coverage denominator is off.
 *   • `mixed` — neither pattern dominates.
 *
 * On its own the log line is invisible to operators. This service:
 *   1. Records every sample in-memory so the admin trends panel can
 *      render an apply-layer-drop rate alongside dedupe rate.
 *   2. Tracks consecutive `apply_layer_dropping` verdicts per
 *      (jobId, windowLabel). When the count crosses
 *      `front_recovery_dedupe_drop_alert_consecutive_pages` (default
 *      3), fires a single Slack alert via the unified `notifyByType`
 *      dispatcher (`integration.front.recovery_apply_layer_drop`).
 *
 * Dedupe: per-(jobId, windowLabel) escalation key, cleared once the
 * verdict chain breaks. The dispatcher's own dedupeKey collapses any
 * racing duplicate within its reminder window.
 *
 * Task #1907 — verdict counts and active-chain state are also
 * persisted (`dedupe_drop_verdict_rollups`,
 * `dedupe_drop_active_chains`) so the headline drop-rate number and
 * the "active chains" table survive process restarts. The recent
 * per-sample buffer stays in-memory and represents "right now".
 */
import { sql } from "drizzle-orm";
import { workerDb } from "../db";
import { getSystemSetting } from "../storage/settingsStorage";

export const NOTIFICATION_ID =
  "integration.front.recovery_apply_layer_drop";

export const SETTING_ENABLED =
  "front_recovery_dedupe_drop_alert_enabled";
export const SETTING_CONSECUTIVE_PAGES =
  "front_recovery_dedupe_drop_alert_consecutive_pages";

export const DEFAULTS = {
  enabled: true,
  /**
   * Three consecutive page samples flipping `apply_layer_dropping` is
   * the smallest reliable signal — single samples can fire on any
   * isolated batch quirk, but three pages in a row means the apply
   * layer is silently dropping recovered conversations across the
   * whole window.
   */
  consecutivePages: 3,
} as const;

export const MIN_CONSECUTIVE_PAGES = 2;
export const MAX_CONSECUTIVE_PAGES = 100;

/** Max samples kept in memory for the admin trends panel. */
const RECENT_SAMPLE_CAP = 50;

/**
 * Headline verdict totals shown in the panel are summed over this
 * many UTC days from `dedupe_drop_verdict_rollups`. Long enough that
 * a single restart in a quiet stretch does not zero the panel,
 * short enough that the number reflects the current operating
 * picture rather than ancient incidents.
 */
const VERDICT_HISTORICAL_WINDOW_DAYS = 14;

/**
 * Retention windows used by the pool-audit rollup prune tick to keep
 * the dedupe-drop tables small. Exported so the prune lives in one
 * place (`poolAuditRollups.pruneTick`) but the windows stay defined
 * next to the table writers.
 *
 *   * Verdict rollup rows older than 90 UTC days are deleted —
 *     matches the other Pool-epic rollup tables.
 *   * Active-chain rows whose `observed_at` is older than 7 days
 *     (without any update) are deleted so the panel's "active
 *     chains" list reflects actually-live incidents instead of
 *     stuck rows for windows that will never produce another sample.
 */
export const DEDUPE_DROP_VERDICT_ROLLUP_RETENTION_DAYS = 90;
export const DEDUPE_DROP_ACTIVE_CHAIN_STALE_MS = 7 * 24 * 60 * 60_000;

export type DedupeSampleVerdict =
  | "apply_layer_dropping"
  | "coverage_denominator_likely_wrong"
  | "mixed";

export interface DedupeSampleObservation {
  jobId: string | null;
  windowLabel: string;
  pageNumber: number;
  pageScanned: number;
  pageDedupeSkipped: number;
  dedupePct: number;
  sampleSize: number;
  applied: number;
  discovered: number;
  missing: number;
  otherStates: number;
  verdict: DedupeSampleVerdict;
  observedAt: number;
}

interface ConsecutiveState {
  count: number;
  firstPageNumber: number;
  lastPageNumber: number;
  observedAt: number;
}

interface CounterState {
  apply_layer_dropping: number;
  coverage_denominator_likely_wrong: number;
  mixed: number;
}

const recentSamples: DedupeSampleObservation[] = [];
const consecutiveByWindow = new Map<string, ConsecutiveState>();
const alertedWindows = new Set<string>();

let hydratedPromise: Promise<void> | null = null;

type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: string },
  options: {
    triggerSource: string;
    dedupeKey?: string;
    metadata?: Record<string, unknown>;
  },
) => Promise<{ delivered: boolean; status?: string; skipReason?: string }>;

let dispatcherOverride: NotifyByTypeFn | null = null;

/** When set, persistence is skipped — used by unit tests. */
let persistenceDisabledForTests = false;

export function __setDispatcherOverrideForTests(fn: NotifyByTypeFn | null) {
  dispatcherOverride = fn;
}

export function __setPersistenceDisabledForTests(disabled: boolean) {
  persistenceDisabledForTests = disabled;
}

export function __resetStateForTests() {
  recentSamples.length = 0;
  consecutiveByWindow.clear();
  alertedWindows.clear();
  hydratedPromise = null;
}

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

function parsePositiveInt(
  raw: string | undefined | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

export interface DedupeDropAlertConfig {
  enabled: boolean;
  consecutivePages: number;
}

export async function getDedupeDropAlertConfig(): Promise<DedupeDropAlertConfig> {
  const [enabledRow, pagesRow] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_CONSECUTIVE_PAGES).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    consecutivePages: parsePositiveInt(
      pagesRow?.value,
      DEFAULTS.consecutivePages,
      MIN_CONSECUTIVE_PAGES,
      MAX_CONSECUTIVE_PAGES,
    ),
  };
}

function windowKey(jobId: string | null, windowLabel: string): string {
  return `${jobId ?? "_nojob_"}|${windowLabel}`;
}

function parseWindowKey(key: string): { jobId: string | null; windowLabel: string } {
  const sep = key.indexOf("|");
  const jobId = sep > 0 ? key.slice(0, sep) : null;
  const windowLabel = sep > 0 ? key.slice(sep + 1) : key;
  return {
    jobId: jobId === "_nojob_" ? null : jobId,
    windowLabel,
  };
}

function utcDateString(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Lazily load persisted active-chain state into memory exactly once
 * per process so the alert escalator and the panel see chains that
 * were open before restart.
 */
async function ensureHydrated(): Promise<void> {
  if (persistenceDisabledForTests) return;
  if (hydratedPromise) return hydratedPromise;
  hydratedPromise = (async () => {
    try {
      const res = await workerDb.execute<any>(sql`
        SELECT window_key, consecutive_pages, first_page_number,
               last_page_number, observed_at, alerted
        FROM dedupe_drop_active_chains
      `);
      const rows = ((res as any).rows ?? []) as any[];
      for (const r of rows) {
        const key = String(r.window_key);
        // Don't overwrite anything an in-flight sample has already
        // written between init and the SELECT returning.
        if (!consecutiveByWindow.has(key)) {
          consecutiveByWindow.set(key, {
            count: Number(r.consecutive_pages) || 0,
            firstPageNumber: Number(r.first_page_number) || 0,
            lastPageNumber: Number(r.last_page_number) || 0,
            observedAt: Number(r.observed_at) || 0,
          });
        }
        if (r.alerted) alertedWindows.add(key);
      }
    } catch (err: any) {
      console.warn(
        `[FrontRecoveryDedupeDropAlerts] hydrate failed: ${err?.message ?? err}`,
      );
      // Leave hydratedPromise resolved so we don't thrash retries on
      // every sample; the next process restart will try again.
    }
  })();
  return hydratedPromise;
}

async function persistVerdictIncrement(obs: DedupeSampleObservation): Promise<void> {
  if (persistenceDisabledForTests) return;
  try {
    const date = utcDateString(obs.observedAt);
    await workerDb.execute(sql`
      INSERT INTO dedupe_drop_verdict_rollups
        (date, verdict, count, first_seen_at, last_seen_at)
      VALUES
        (${date}, ${obs.verdict}, 1, ${obs.observedAt}, ${obs.observedAt})
      ON CONFLICT (date, verdict)
      DO UPDATE SET
        count = dedupe_drop_verdict_rollups.count + 1,
        last_seen_at = GREATEST(dedupe_drop_verdict_rollups.last_seen_at, EXCLUDED.last_seen_at),
        updated_at = NOW()
    `);
  } catch (err: any) {
    console.warn(
      `[FrontRecoveryDedupeDropAlerts] persistVerdict failed: ${err?.message ?? err}`,
    );
  }
}

async function persistChain(
  key: string,
  obs: DedupeSampleObservation,
  state: ConsecutiveState,
  alerted: boolean,
): Promise<void> {
  if (persistenceDisabledForTests) return;
  try {
    await workerDb.execute(sql`
      INSERT INTO dedupe_drop_active_chains
        (window_key, job_id, window_label, consecutive_pages,
         first_page_number, last_page_number, observed_at, alerted)
      VALUES
        (${key}, ${obs.jobId}, ${obs.windowLabel}, ${state.count},
         ${state.firstPageNumber}, ${state.lastPageNumber}, ${state.observedAt}, ${alerted})
      ON CONFLICT (window_key)
      DO UPDATE SET
        consecutive_pages = EXCLUDED.consecutive_pages,
        last_page_number = EXCLUDED.last_page_number,
        observed_at = EXCLUDED.observed_at,
        alerted = dedupe_drop_active_chains.alerted OR EXCLUDED.alerted,
        updated_at = NOW()
    `);
  } catch (err: any) {
    console.warn(
      `[FrontRecoveryDedupeDropAlerts] persistChain failed: ${err?.message ?? err}`,
    );
  }
}

async function deleteChainRow(key: string): Promise<void> {
  if (persistenceDisabledForTests) return;
  try {
    await workerDb.execute(sql`
      DELETE FROM dedupe_drop_active_chains WHERE window_key = ${key}
    `);
  } catch (err: any) {
    console.warn(
      `[FrontRecoveryDedupeDropAlerts] deleteChain failed: ${err?.message ?? err}`,
    );
  }
}

async function markChainAlerted(key: string): Promise<void> {
  if (persistenceDisabledForTests) return;
  try {
    await workerDb.execute(sql`
      UPDATE dedupe_drop_active_chains
         SET alerted = TRUE, updated_at = NOW()
       WHERE window_key = ${key}
    `);
  } catch (err: any) {
    console.warn(
      `[FrontRecoveryDedupeDropAlerts] markChainAlerted failed: ${err?.message ?? err}`,
    );
  }
}

function buildAlertText(args: {
  jobId: string | null;
  windowLabel: string;
  state: ConsecutiveState;
  threshold: number;
  latest: DedupeSampleObservation;
}): string {
  const { jobId, windowLabel, state, threshold, latest } = args;
  const lines = [
    `:rotating_light: *Front recovery is dropping recovered conversations at the apply layer* — window \`${windowLabel}\``,
    `• Job: \`${jobId ?? "(unknown)"}\` — pages ${state.firstPageNumber}–${state.lastPageNumber} (\u2265 ${threshold} consecutive)`,
    `• Latest sample: dedupe ${(latest.dedupePct * 100).toFixed(1)}% · applied=${latest.applied} discovered=${latest.discovered} missing=${latest.missing} other=${latest.otherStates} of ${latest.sampleSize}`,
    `• What this means: the dedupe rate is inflated because recovered conversations are being skipped at apply — real ingest is stalled even though dedupe pct looks healthy.`,
    `Open the admin trends panel and the Front Historical Recovery panel to investigate the apply layer.`,
  ];
  return lines.join("\n");
}

/**
 * Called by `frontHistoricalRecovery.sampleDedupeAppliedStatus` for
 * every page sample (regardless of verdict). Updates the in-memory
 * panel buffer + the persistent verdict rollup + active-chain row,
 * then — when `apply_layer_dropping` repeats across the configured
 * number of consecutive pages for the same (jobId, windowLabel) —
 * fires a single Slack alert.
 *
 * Safe to call fire-and-forget; never throws.
 */
export async function recordDedupeSample(
  obs: DedupeSampleObservation,
): Promise<void> {
  try {
    await ensureHydrated();

    recentSamples.unshift(obs);
    if (recentSamples.length > RECENT_SAMPLE_CAP) {
      recentSamples.length = RECENT_SAMPLE_CAP;
    }

    await persistVerdictIncrement(obs);

    const key = windowKey(obs.jobId, obs.windowLabel);
    if (obs.verdict !== "apply_layer_dropping") {
      // Any non-dropping verdict breaks the chain. We also clear the
      // "already alerted" flag so a future regression on the same
      // window can re-alert.
      consecutiveByWindow.delete(key);
      alertedWindows.delete(key);
      await deleteChainRow(key);
      return;
    }

    const prev = consecutiveByWindow.get(key);
    const next: ConsecutiveState = prev
      ? {
          count: prev.count + 1,
          firstPageNumber: prev.firstPageNumber,
          lastPageNumber: obs.pageNumber,
          observedAt: obs.observedAt,
        }
      : {
          count: 1,
          firstPageNumber: obs.pageNumber,
          lastPageNumber: obs.pageNumber,
          observedAt: obs.observedAt,
        };
    consecutiveByWindow.set(key, next);
    await persistChain(key, obs, next, alertedWindows.has(key));

    if (alertedWindows.has(key)) return;

    const config = await getDedupeDropAlertConfig().catch(() => null);
    if (!config || !config.enabled) return;
    if (next.count < config.consecutivePages) return;

    const text = buildAlertText({
      jobId: obs.jobId,
      windowLabel: obs.windowLabel,
      state: next,
      threshold: config.consecutivePages,
      latest: obs,
    });

    try {
      const notifyByType =
        dispatcherOverride ??
        (await import("./notifications/dispatcher")).notifyByType;
      const r = await notifyByType(
        NOTIFICATION_ID,
        { text, preview: text.slice(0, 300) },
        {
          triggerSource: "alert_service",
          dedupeKey: key,
          metadata: {
            jobId: obs.jobId,
            windowLabel: obs.windowLabel,
            consecutivePages: next.count,
            threshold: config.consecutivePages,
            firstPageNumber: next.firstPageNumber,
            lastPageNumber: next.lastPageNumber,
            latestSample: {
              pageNumber: obs.pageNumber,
              dedupePct: obs.dedupePct,
              sampleSize: obs.sampleSize,
              applied: obs.applied,
              discovered: obs.discovered,
              missing: obs.missing,
              otherStates: obs.otherStates,
            },
          },
        },
      );
      if (r.delivered || r.status === "skipped_deduped") {
        alertedWindows.add(key);
        await markChainAlerted(key);
      }
    } catch (err: any) {
      console.error(
        `[FrontRecoveryDedupeDropAlerts] dispatch failed window=${obs.windowLabel}: ${err?.message ?? err}`,
      );
    }
  } catch (err: any) {
    console.warn(
      `[FrontRecoveryDedupeDropAlerts] recordDedupeSample failed: ${err?.message ?? err}`,
    );
  }
}

export interface DedupeDropPanelPayload {
  /** Most recent samples first; capped at RECENT_SAMPLE_CAP. */
  recentSamples: DedupeSampleObservation[];
  /**
   * Verdict counts summed over the last
   * `VERDICT_HISTORICAL_WINDOW_DAYS` UTC days, read from
   * `dedupe_drop_verdict_rollups`. Survives process restart.
   */
  verdictCounters: CounterState;
  /** Aggregate rates derived from the persisted verdict counts (historical) plus the in-memory sample buffer (right now). */
  aggregate: {
    /** Count of in-memory samples used for the avgDedupePct + sampleCount fields. */
    sampleCount: number;
    /** Historical apply-layer-drop rate from the verdict rollup. Survives restart. */
    applyLayerDropRate: number;
    /** Mean dedupe pct of the in-memory samples (right now). */
    avgDedupePct: number;
    /** Number of UTC days the historical figures cover. */
    historicalWindowDays: number;
  };
  /** Per-window consecutive `apply_layer_dropping` chains currently open. Hydrated from `dedupe_drop_active_chains`. */
  activeChains: Array<{
    jobId: string | null;
    windowLabel: string;
    consecutivePages: number;
    firstPageNumber: number;
    lastPageNumber: number;
    observedAt: number;
    alerted: boolean;
  }>;
}

async function loadPersistedVerdictCounters(): Promise<CounterState> {
  const empty: CounterState = {
    apply_layer_dropping: 0,
    coverage_denominator_likely_wrong: 0,
    mixed: 0,
  };
  if (persistenceDisabledForTests) return empty;
  try {
    const cutoff = utcDateString(
      Date.now() - VERDICT_HISTORICAL_WINDOW_DAYS * 24 * 60 * 60_000,
    );
    const res = await workerDb.execute<any>(sql`
      SELECT verdict, SUM(count)::bigint AS total
      FROM dedupe_drop_verdict_rollups
      WHERE date >= ${cutoff}
      GROUP BY verdict
    `);
    const rows = ((res as any).rows ?? []) as any[];
    const out = { ...empty };
    for (const r of rows) {
      const v = String(r.verdict);
      const n = Number(r.total) || 0;
      if (v === "apply_layer_dropping") out.apply_layer_dropping = n;
      else if (v === "coverage_denominator_likely_wrong")
        out.coverage_denominator_likely_wrong = n;
      else if (v === "mixed") out.mixed = n;
    }
    return out;
  } catch (err: any) {
    console.warn(
      `[FrontRecoveryDedupeDropAlerts] loadPersistedVerdictCounters failed: ${err?.message ?? err}`,
    );
    return empty;
  }
}

function countVerdictsFromSamples(
  samples: DedupeSampleObservation[],
): CounterState {
  const out: CounterState = {
    apply_layer_dropping: 0,
    coverage_denominator_likely_wrong: 0,
    mixed: 0,
  };
  for (const s of samples) {
    if (s.verdict === "apply_layer_dropping") out.apply_layer_dropping += 1;
    else if (s.verdict === "coverage_denominator_likely_wrong")
      out.coverage_denominator_likely_wrong += 1;
    else if (s.verdict === "mixed") out.mixed += 1;
  }
  return out;
}

export async function getDedupeDropState(): Promise<DedupeDropPanelPayload> {
  await ensureHydrated();
  // When persistence is disabled (unit tests run without touching the
  // shared dev DB), the verdict rollup table is never written, so derive
  // the headline counters from the in-memory sample buffer instead. This
  // keeps the panel object fully populated in both modes; the persisted
  // path (production + the Task #1914 rollup suite) is unchanged.
  const verdictCounters = persistenceDisabledForTests
    ? countVerdictsFromSamples(recentSamples)
    : await loadPersistedVerdictCounters();
  const totalVerdicts =
    verdictCounters.apply_layer_dropping +
    verdictCounters.coverage_denominator_likely_wrong +
    verdictCounters.mixed;
  const samples = recentSamples.slice();
  const sampleCount = samples.length;
  const avgDedupePct =
    sampleCount === 0
      ? 0
      : samples.reduce((acc, s) => acc + s.dedupePct, 0) / sampleCount;
  const activeChains = Array.from(consecutiveByWindow.entries()).map(
    ([key, state]) => {
      const { jobId, windowLabel } = parseWindowKey(key);
      return {
        jobId,
        windowLabel,
        consecutivePages: state.count,
        firstPageNumber: state.firstPageNumber,
        lastPageNumber: state.lastPageNumber,
        observedAt: state.observedAt,
        alerted: alertedWindows.has(key),
      };
    },
  );
  return {
    recentSamples: samples,
    verdictCounters,
    aggregate: {
      sampleCount,
      applyLayerDropRate:
        totalVerdicts === 0
          ? 0
          : verdictCounters.apply_layer_dropping / totalVerdicts,
      avgDedupePct,
      historicalWindowDays: VERDICT_HISTORICAL_WINDOW_DAYS,
    },
    activeChains,
  };
}
