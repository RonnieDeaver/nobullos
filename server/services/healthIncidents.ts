// @cross-instance-safe: idempotent auto-resolve — UPDATEs stale incidents to resolved (no-op once resolved); no external emit on this path.
/**
 * Task #861 Phase 3 — Incident grouping (introduced)
 * Task #917 (913D) — Incident lifecycle engine & stale-incident resolution
 *
 * Repeated samples of the same alert (same metric + severity + origin/pool)
 * are coalesced into a single open incident. The incident is updated in place
 * for occurrence_count, peak_value, latest_value, last_seen_at and sample_refs.
 *
 * Fingerprint = `${metric}:${severity}:${origin}` where `origin` is the
 * pool/route/worker label if the alert provides one.
 *
 * ─── Canonical lifecycle (913D) ─────────────────────────────────────────
 *
 *   firing  ──ack──▶ acknowledged ──resolve──▶ resolved (terminal)
 *      │                  │                       ▲
 *      └─── resolve ──────┴───────────────────────┘
 *
 * The only legal statuses are `firing`, `acknowledged`, and `resolved`.
 * `snoozed_until` is metadata attached to an `acknowledged` incident; it
 * suppresses the incident from "needs attention" UI surfaces until the
 * snooze window elapses, but it is NOT a status. Once `snoozed_until`
 * passes, the next matching firing alert flips the incident back to
 * `firing` (re-arm).
 *
 * ─── Auto-resolve rules (913D, refined in #870) ─────────────────────────
 *
 * The resolver pass marks an open `firing` incident `resolved` (setting
 * `resolved_at`) when EITHER of:
 *   (a) the metric has been clean for the auto-resolve quiet window
 *       (Task #870 default 15 min, configurable via
 *       `HEALTH_INCIDENT_AUTO_RESOLVE_QUIET_MS`, re-read each sweep) —
 *       i.e. `now - last_seen_at >= currentAutoResolveQuietMs()`. This is the
 *       "metric recovered" path: an absence of fresh firing samples
 *       means the underlying metric is back under threshold.
 *   (b) `last_seen_at` exceeds the per-metric-class STALE_MAX_AGE_MS
 *       threshold. This catches incidents that lost their re-arming
 *       signal entirely (the row #1 `db_latency:warning:probe` case).
 *
 * Each auto-resolve writes a distinct reason code into the incident's
 * `metadata.autoResolveReason` (`metric_recovered` / `stale_max_age` /
 * `max_episode_duration`) for operator audit.
 *
 * Task #870: manual ack/snooze always wins. An `acknowledged` incident
 * (snoozed is acknowledged + `snoozed_until`) is owned by an operator
 * and is never auto-resolved — the operator must close it explicitly.
 *
 * ─── Dedup / reopen rule (913D) ────────────────────────────────────────
 *
 * Once an incident is `resolved`, it is terminal. A subsequent matching
 * fingerprint ALWAYS creates a NEW incident (never reopens the old one).
 * The lookup helper `findIncidentByFingerprint` enforces this by only
 * matching `firing|acknowledged` rows. This keeps each historical
 * incident's `first_seen_at`/`resolved_at` timeline immutable and gives
 * each new incident a fresh paging/digest scope.
 *
 * ─── Max-age episode splitting (945E) ──────────────────────────────────
 *
 * Auto-resolve (a)/(b) only fires when the metric goes quiet. A chronic
 * condition that re-fires every 30s never goes quiet, so its single
 * incident row would accumulate occurrences forever (the original
 * 4,898-occurrence/7-day symptom). To keep chronic conditions
 * representable as a series of usable operational episodes, an open
 * `firing` incident whose `first_seen_at` is older than
 * `MAX_EPISODE_DURATION_MS` is closed in place at `last_seen_at` and a
 * new `firing` incident is opened for the same fingerprint at the new
 * sample timestamp. Acknowledged incidents are NEVER auto-split — an
 * operator owns them and a silent split would lose that ownership.
 */

import { dbRetry, withDbAttribution } from "../db";
import * as healthStore from "../storage/healthMetricsStorage";
import type { Alert } from "./healthMetrics";
import type { HealthIncidentRecord, InsertHealthIncident } from "@shared/schema";

export interface IngestableAlert extends Omit<Alert, "threshold"> {
  origin?: string | null;
  threshold?: number | null;
}

/** Canonical incident lifecycle (913D). */
export type IncidentStatus = "firing" | "acknowledged" | "resolved";

/**
 * Task #870 — auto-resolve grace window. An open `firing` incident whose
 * underlying metric has stayed under threshold (i.e. no fresh firing
 * sample) for at least this long is auto-closed by the resolver pass.
 *
 * Configurable via `HEALTH_INCIDENT_AUTO_RESOLVE_QUIET_MS` so operators can
 * tighten/loosen the window without a code change. Default is 15 minutes —
 * long enough to ride out a transient spike but short enough to keep the
 * "open incidents" card honest.
 */
function readAutoResolveQuietMs(): number {
  const raw = process.env.HEALTH_INCIDENT_AUTO_RESOLVE_QUIET_MS;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 15 * 60 * 1000;
}
// Re-read on every sweep so an operator can adjust the env var (or, in
// the future, a `system_settings` row) without restarting the process.
function currentAutoResolveQuietMs(): number {
  return readAutoResolveQuietMs();
}
const MAX_SAMPLE_REFS = 50;

/**
 * Task #870 — distinct reason codes stamped onto an incident's metadata
 * when it transitions to `resolved` automatically. Operators can audit
 * the population of auto-closed incidents by filtering on these codes.
 */
export const AUTO_RESOLVE_REASONS = {
  /** Underlying metric stayed under threshold for the quiet window. */
  METRIC_RECOVERED: "metric_recovered",
  /** `last_seen_at` exceeded the per-metric stale-age threshold (lost signal). */
  STALE_MAX_AGE: "stale_max_age",
  /** 945E episode-splitting closed a chronic firing incident in place. */
  MAX_EPISODE_DURATION: "max_episode_duration",
} as const;
export type AutoResolveReason =
  (typeof AUTO_RESOLVE_REASONS)[keyof typeof AUTO_RESOLVE_REASONS];

/**
 * 945E max-age episode duration. A `firing` incident open for longer than
 * this is closed in place and replaced with a new episode for the same
 * fingerprint, so chronic conditions surface as a series of bounded
 * operational episodes instead of one endless row.
 *
 * 6h is short enough that a "this lasted 6 hours" episode reads as a
 * useful operational unit on the dashboard, but long enough that a
 * normally-noisy metric still produces ≤4 episodes/day rather than
 * flapping every few minutes.
 */
const MAX_EPISODE_DURATION_MS = 6 * 60 * 60 * 1000;

/**
 * Health-sampler stall incident type (913B↔913D contract).
 *
 * The supervised-sampler watchdog (913B) raises one of these per stalled
 * sampler. Fingerprint shape: `health_sampler_stalled:critical:<sampler-name>`.
 * Severity is always `critical`. The watchdog clears it by calling
 * `resolveIncident()` with caller=`watchdog:<sampler-name>` once the
 * sampler resumes producing fresh rows.
 */
export const HEALTH_SAMPLER_STALLED_METRIC = "health_sampler_stalled";

/**
 * Per-metric-class stale-age thresholds (913D rule (b)). When an open
 * incident's `last_seen_at` is older than this, the auto-resolver force-
 * closes it even if the metric never explicitly went clean.
 *
 * The default catches the original 913A symptom: an incident left firing
 * for days with only a handful of occurrences because its source signal
 * stopped arriving entirely.
 */
const DEFAULT_STALE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const STALE_MAX_AGE_BY_METRIC: Record<string, number> = {
  // The watchdog re-emits every minute while a sampler is stalled, so a
  // 5-minute stale window is enough to declare the watchdog itself silent.
  [HEALTH_SAMPLER_STALLED_METRIC]: 5 * 60 * 1000,
  // db_latency probes fire every 30s when degraded, so 15 minutes of
  // silence comfortably means the condition cleared.
  db_latency: 15 * 60 * 1000,
  consecutive_db_failures: 15 * 60 * 1000,
};

function staleMaxAgeFor(metric: string): number {
  return STALE_MAX_AGE_BY_METRIC[metric] ?? DEFAULT_STALE_MAX_AGE_MS;
}

function buildFingerprint(alert: IngestableAlert): string {
  // Prefer an explicit origin (pool/worker/route). Fall back to a sentinel so
  // alerts without origin info still group meaningfully and don't degrade
  // into per-sample noise.
  const origin = (alert.origin && alert.origin.trim()) || "global";
  return `${alert.metric}:${alert.severity}:${origin}`.slice(0, 256);
}

function buildTitle(alert: IngestableAlert): string {
  const origin = alert.origin ? ` @ ${alert.origin}` : "";
  return `${alert.metric} ${alert.severity}${origin}`;
}

/**
 * Ingest a single alert into the incidents table. Returns the resulting
 * incident record (open or newly created). Designed to be idempotent so
 * the sampler can call it on every firing sample.
 *
 * `value` is optional but, if provided, drives peak_value / latest_value.
 * `sampleTimestamp` defaults to now() and is what we record as last_seen_at.
 */
export async function ingestAlert(opts: {
  alert: IngestableAlert;
  value?: number | null;
  sampleTimestamp?: number;
  /**
   * Task #992 — additional structured fields merged into the incident's
   * `metadata` JSONB. Caller-supplied keys win over the default
   * `{ message, origin }` pair so the supervised-sampler watchdog (and any
   * future producer) can attach rich diagnostic context (last_success_at,
   * consecutive_misses, sampler_interval_seconds, etc.) for incident UI
   * and post-mortem.
   */
  metadata?: Record<string, unknown>;
}): Promise<HealthIncidentRecord> {
  const { alert } = opts;
  const ts = opts.sampleTimestamp ?? Date.now();
  const value = opts.value ?? 0;
  const fingerprint = buildFingerprint(alert);
  const baseMetadata: Record<string, unknown> = {
    message: alert.message,
    origin: alert.origin ?? null,
    ...(opts.metadata ?? {}),
  };

  return await dbRetry(async () => {
    const existing = await healthStore.findIncidentByFingerprint(fingerprint);
    if (existing) {
      // 945E max-age episode splitting: a `firing` incident that has been
      // open longer than MAX_EPISODE_DURATION_MS is closed in place and
      // replaced by a fresh episode so chronic conditions surface as a
      // series of bounded operational episodes. Acknowledged incidents
      // are owned by an operator and never silently split.
      if (
        existing.status === "firing" &&
        ts - existing.firstSeenAt >= MAX_EPISODE_DURATION_MS
      ) {
        try {
          const existingMeta =
            existing.metadata && typeof existing.metadata === "object"
              ? (existing.metadata as Record<string, unknown>)
              : {};
          await healthStore.updateIncident(existing.id, {
            status: "resolved",
            resolvedAt: existing.lastSeenAt,
            metadata: {
              ...existingMeta,
              autoResolveReason: AUTO_RESOLVE_REASONS.MAX_EPISODE_DURATION,
              autoResolvedAt: existing.lastSeenAt,
            },
          });
        } catch (err: any) {
          // The only safe-to-tolerate failure here is a concurrency race
          // where another caller already closed this row (its current
          // status is no longer `firing`). Anything else — a transient
          // DB error, a permission error, an unexpected lifecycle guard
          // rejection — must propagate so dbRetry retries atomically;
          // otherwise we'd insert a NEW firing episode while leaving the
          // old one open, producing duplicate open episodes for one
          // fingerprint.
          const fresh = await healthStore.getIncidentById(existing.id);
          if (!fresh || fresh.status === "firing") {
            throw err;
          }
          console.warn(
            `[HealthIncidents] episode-split close lost race for #${existing.id} (now ${fresh.status}); proceeding with new episode`,
          );
        }
        const insert: InsertHealthIncident = {
          fingerprint,
          metric: alert.metric,
          severity: alert.severity,
          title: buildTitle(alert),
          firstSeenAt: ts,
          lastSeenAt: ts,
          occurrenceCount: 1,
          peakValue: value,
          latestValue: value,
          threshold: alert.threshold ?? 0,
          status: "firing",
          sampleRefs: [ts],
          metadata: {
            ...baseMetadata,
            splitFromIncidentId: existing.id,
            splitReason: "max_episode_duration",
          },
        };
        return await healthStore.insertIncident(insert);
      }

      const sampleRefs = Array.isArray(existing.sampleRefs) ? (existing.sampleRefs as number[]) : [];
      const nextRefs = [...sampleRefs, ts].slice(-MAX_SAMPLE_REFS);
      const peak = Math.max(existing.peakValue, value);
      // 913D re-arm: an `acknowledged` incident whose snooze window has
      // elapsed flips back to `firing` on the next matching sample.
      // (Acknowledged-without-snooze stays acknowledged on re-fire.)
      let nextStatus: IncidentStatus = existing.status as IncidentStatus;
      if (
        nextStatus === "acknowledged" &&
        existing.snoozedUntil !== null &&
        existing.snoozedUntil !== undefined &&
        existing.snoozedUntil < ts
      ) {
        nextStatus = "firing";
      }
      // Task #992 — when re-emitting on a meaningful change, also
      // refresh the metadata JSONB on the existing open incident so
      // the dashboard sees current consecutive_misses / last_error /
      // recovery_attempts instead of the snapshot from when the
      // incident first opened. Caller-supplied keys win over the
      // defaults, just like the insert path.
      const existingMetadata =
        existing.metadata && typeof existing.metadata === "object"
          ? (existing.metadata as Record<string, unknown>)
          : {};
      const mergedMetadata: Record<string, unknown> = {
        ...existingMetadata,
        ...baseMetadata,
      };
      const updated = await healthStore.updateIncident(existing.id, {
        lastSeenAt: ts,
        occurrenceCount: existing.occurrenceCount + 1,
        peakValue: peak,
        latestValue: value,
        sampleRefs: nextRefs,
        status: nextStatus,
        metadata: mergedMetadata,
        // Bump severity upward but never silently downgrade an open incident.
        severity:
          severityRank(alert.severity) > severityRank(existing.severity)
            ? alert.severity
            : existing.severity,
      });
      return updated ?? existing;
    }

    // No open incident for this fingerprint — create a new one. Per the
    // 913D dedup rule, a previous *resolved* incident with the same
    // fingerprint is intentionally NOT reopened.
    const insert: InsertHealthIncident = {
      fingerprint,
      metric: alert.metric,
      severity: alert.severity,
      title: buildTitle(alert),
      firstSeenAt: ts,
      lastSeenAt: ts,
      occurrenceCount: 1,
      peakValue: value,
      latestValue: value,
      threshold: alert.threshold ?? 0,
      status: "firing",
      sampleRefs: [ts],
      metadata: baseMetadata,
    };
    return await healthStore.insertIncident(insert);
  }, "healthIncidents.ingestAlert");
}

/**
 * Task #992 — refresh `last_seen_at` on the open incident matching
 * the given fingerprint, *without* re-warning, splitting episodes,
 * or bumping occurrenceCount. This is the heartbeat the supervised
 * sampler watchdog calls on every cycle while a stall is unchanged
 * — the dedup gate suppresses the noisy ingestAlert path, but we
 * still need to keep the incident "alive" so the auto-stale-resolve
 * sweep does not silently close an actively stalled sampler.
 *
 * Returns the refreshed record, or `null` if there is no open
 * incident for the fingerprint (in which case the caller should
 * fall through to a real `ingestAlert`).
 */
export async function touchIncidentHeartbeat(
  alert: IngestableAlert,
  now: number = Date.now(),
): Promise<HealthIncidentRecord | null> {
  const fingerprint = buildFingerprint(alert);
  return await dbRetry(async () => {
    const existing = await healthStore.findIncidentByFingerprint(fingerprint);
    if (!existing) return null;
    if (existing.status === "resolved") return null;
    if (existing.lastSeenAt >= now) return existing;
    const updated = await healthStore.updateIncident(existing.id, {
      lastSeenAt: now,
    });
    return updated ?? existing;
  }, "healthIncidents.touchIncidentHeartbeat");
}

/**
 * Auto-resolve open incidents per the 913D rules:
 *   (a) quiet for ≥ currentAutoResolveQuietMs(), OR
 *   (b) last_seen_at older than the per-metric-class stale-age threshold.
 *
 * 945E: in addition, sweep-close any `firing` incident open for longer
 * than MAX_EPISODE_DURATION_MS even if it's still re-firing. This is a
 * safety net for chronic stragglers — under steady traffic the
 * episode-split path inside `ingestAlert` does the same work at the
 * next sample, but the sweep guarantees old episodes don't linger if
 * sample arrival is patchy or the deploy lands between ingests. The
 * straggler is closed at its own `last_seen_at` (matches when it was
 * actually quiet last) and the next matching sample opens a fresh
 * episode via the normal ingest path.
 *
 * Returns the number of incidents transitioned to `resolved`. Safe to call
 * concurrently — the storage transition guard rejects illegal moves.
 */
export async function autoResolveStaleIncidents(now: number = Date.now()): Promise<number> {
  return await dbRetry(async () => {
    // Task #870: manual ack/snooze must win over auto-resolve. An
    // `acknowledged` incident (including snoozed, which is just an
    // acknowledged row with `snoozed_until`) is owned by an operator and
    // is theirs to close. Only sweep `firing` rows. The legacy `snoozed`
    // status is intentionally still included so pre-913D rows that
    // never got normalized aren't left orphaned forever — those rows
    // predate the lifecycle guard and have no operator owner.
    const open = await healthStore.listIncidents({
      statuses: ["firing", "snoozed"],
      limit: 500,
    });
    let resolved = 0;
    for (const inc of open) {
      const quietFor = now - inc.lastSeenAt;
      const staleMax = staleMaxAgeFor(inc.metric);
      const overEpisodeMax =
        inc.status === "firing" && now - inc.firstSeenAt >= MAX_EPISODE_DURATION_MS;
      const recovered = quietFor >= currentAutoResolveQuietMs();
      const stale = quietFor >= staleMax;
      const shouldResolve = recovered || stale || overEpisodeMax;
      if (!shouldResolve) continue;
      try {
        // For an episode-max-age close, stamp resolvedAt at the incident's
        // own last_seen_at so the timeline reads honestly: the episode
        // ended when the last sample landed, not at sweep time.
        const resolvedAt = overEpisodeMax && !recovered
          ? inc.lastSeenAt
          : now;
        // Task #870: distinct reason code for audit. Recovery wins over
        // stale-age (it's the more specific, more common case); the
        // episode-max sweep path only stamps its reason when the row
        // hasn't already gone quiet.
        const reason: AutoResolveReason = recovered
          ? AUTO_RESOLVE_REASONS.METRIC_RECOVERED
          : stale
            ? AUTO_RESOLVE_REASONS.STALE_MAX_AGE
            : AUTO_RESOLVE_REASONS.MAX_EPISODE_DURATION;
        const incMeta =
          inc.metadata && typeof inc.metadata === "object"
            ? (inc.metadata as Record<string, unknown>)
            : {};
        await healthStore.updateIncident(inc.id, {
          status: "resolved",
          resolvedAt,
          metadata: {
            ...incMeta,
            autoResolveReason: reason,
            autoResolvedAt: resolvedAt,
            // Elapsed quiet duration at the moment of resolve (now - last_seen_at),
            // NOT the configured window. Useful for post-mortem ("how long was
            // the metric actually clean before we closed it?").
            autoResolveQuietForMs: quietFor,
          },
        });
        resolved++;
      } catch (err: any) {
        // Lifecycle guard rejected the move (e.g. row already resolved by
        // a concurrent caller). Tolerate and continue.
        console.warn(
          `[HealthIncidents] auto-resolve skipped #${inc.id}: ${err?.message || err}`,
        );
      }
    }
    return resolved;
  }, "healthIncidents.autoResolveStaleIncidents");
}

/**
 * Acknowledge an incident. Idempotent: calling on an already-acknowledged
 * incident returns the current row unchanged. Calling on a `resolved`
 * incident is a no-op (returns the row as-is).
 */
export async function ackIncident(id: number, by: string): Promise<HealthIncidentRecord | null> {
  const current = await healthStore.getIncidentById(id);
  if (!current) return null;
  if (current.status === "resolved") return current; // terminal — no-op
  if (current.status === "acknowledged") return current; // already acked
  return await healthStore.updateIncident(id, {
    status: "acknowledged",
    acknowledgedBy: by,
    acknowledgedAt: Date.now(),
  });
}

/**
 * Snooze an incident (913D: snooze is acknowledged + snoozed_until). When
 * the snooze window elapses the next matching sample re-fires the
 * incident back to `firing`. Idempotent within the lifecycle guard.
 */
export async function snoozeIncident(
  id: number,
  untilTimestamp: number,
  by: string,
): Promise<HealthIncidentRecord | null> {
  const current = await healthStore.getIncidentById(id);
  if (!current) return null;
  if (current.status === "resolved") return current; // terminal — no-op
  return await healthStore.updateIncident(id, {
    status: "acknowledged",
    snoozedUntil: untilTimestamp,
    acknowledgedBy: by,
    acknowledgedAt: Date.now(),
  });
}

/**
 * Resolve an incident. Idempotent: calling on an already-resolved
 * incident returns the row unchanged.
 */
export async function resolveIncident(id: number, by?: string): Promise<HealthIncidentRecord | null> {
  const current = await healthStore.getIncidentById(id);
  if (!current) return null;
  if (current.status === "resolved") return current; // already resolved
  return await healthStore.updateIncident(id, {
    status: "resolved",
    resolvedAt: Date.now(),
    acknowledgedBy: by ?? current.acknowledgedBy ?? undefined,
  });
}

export async function listOpenIncidents(): Promise<HealthIncidentRecord[]> {
  // 913D: include the legacy `snoozed` status so any pre-913D rows that
  // haven't been normalized yet still surface in the open list (the
  // startup normalizer + transition guard handle them on next action).
  return await healthStore.listIncidents({
    statuses: ["firing", "acknowledged", "snoozed"],
    limit: 100,
  });
}

export async function listRecentIncidents(sinceTimestamp: number): Promise<HealthIncidentRecord[]> {
  return await healthStore.listIncidents({
    sinceTimestamp,
    limit: 200,
  });
}

function severityRank(s: string): number {
  switch (s) {
    case "critical":
      return 3;
    case "warning":
      return 2;
    case "info":
      return 1;
    default:
      return 0;
  }
}

// ─── Periodic auto-resolver scheduler (913D) ────────────────────────────

let autoResolverTimer: ReturnType<typeof setInterval> | null = null;
const AUTO_RESOLVER_INTERVAL_MS = 60_000;

/**
 * Start the periodic auto-resolver. Idempotent. Runs one immediate sweep
 * on startup so any pre-existing stuck incidents (e.g. the original
 * `db_latency:warning:probe` row) are cleared as part of the rollout,
 * then sweeps every minute.
 */
export function startIncidentAutoResolver(intervalMs: number = AUTO_RESOLVER_INTERVAL_MS): void {
  if (autoResolverTimer) return;
  autoResolverTimer = setInterval(() => {
    void withDbAttribution("scheduler:health-incidents-auto-resolver", () =>
      autoResolveStaleIncidents().catch((err) =>
        console.warn("[HealthIncidents] auto-resolver tick failed:", err?.message || err),
      ),
    );
  }, intervalMs);
  // Rollout: normalize legacy `snoozed` rows to `acknowledged`, then fire
  // an immediate sweep so any pre-913D incidents stuck open get cleared
  // as part of this deploy (Step 6 of 913D).
  void withDbAttribution("startup:health-incidents-bootstrap", async () => {
      try {
        const normalized = await healthStore.normalizeLegacySnoozedIncidents();
        if (normalized > 0) {
          console.log(
            `[HealthIncidents] startup normalized ${normalized} legacy snoozed incident(s) -> acknowledged`,
          );
        }
      } catch (err: any) {
        console.warn(
          "[HealthIncidents] legacy-snoozed normalize failed:",
          err?.message || err,
        );
      }
      try {
        const n = await autoResolveStaleIncidents();
        if (n > 0) {
          console.log(`[HealthIncidents] startup sweep auto-resolved ${n} stale incident(s)`);
        }
      } catch (err: any) {
        console.warn("[HealthIncidents] startup auto-resolver failed:", err?.message || err);
      }
  });
}

export function stopIncidentAutoResolver(): void {
  if (autoResolverTimer) {
    clearInterval(autoResolverTimer);
    autoResolverTimer = null;
  }
}

// Test-only helper.
export const __test = {
  buildFingerprint,
  currentAutoResolveQuietMs,
  MAX_EPISODE_DURATION_MS,
  staleMaxAgeFor,
  HEALTH_SAMPLER_STALLED_METRIC,
};
