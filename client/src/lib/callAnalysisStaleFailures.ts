/**
 * Task #4466: keep months-old failed call-analysis jobs from burying new
 * results. A failed job is "stale" when it is either older than
 * STALE_FAILURE_DAYS, or superseded by a later successful (complete) run
 * for the same external_id — in both cases the red pill is history, not a
 * call to action. Stale failures are collapsed into an on-demand group in
 * the Call Answer Time Analyzer; recent/actionable failures stay inline
 * with their critical pill.
 *
 * Pure and order-preserving so the page's newest-first server ordering
 * survives the split and the logic is unit-testable without a DOM.
 */

export const STALE_FAILURE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type StalePartitionJob = {
  analysis_id: string;
  external_id: string;
  status: string;
  created_at: string | null;
};

export function partitionStaleFailures<T extends StalePartitionJob>(
  jobs: T[],
  now: Date = new Date(),
): { fresh: T[]; staleFailures: T[] } {
  const cutoffMs = now.getTime() - STALE_FAILURE_DAYS * DAY_MS;

  // Newest complete run per external_id (for the "superseded" rule).
  const latestCompleteByExternalId = new Map<string, number>();
  for (const job of jobs) {
    if (job.status !== "complete" || !job.created_at) continue;
    const t = new Date(job.created_at).getTime();
    if (Number.isNaN(t)) continue;
    const prev = latestCompleteByExternalId.get(job.external_id);
    if (prev === undefined || t > prev) {
      latestCompleteByExternalId.set(job.external_id, t);
    }
  }

  const fresh: T[] = [];
  const staleFailures: T[] = [];
  for (const job of jobs) {
    if (job.status !== "failed") {
      fresh.push(job);
      continue;
    }
    const createdMs = job.created_at ? new Date(job.created_at).getTime() : NaN;
    // Unparseable/missing timestamps stay visible: never silently hide a
    // failure we cannot prove is old.
    const isOld = !Number.isNaN(createdMs) && createdMs < cutoffMs;
    const laterComplete = latestCompleteByExternalId.get(job.external_id);
    const isSuperseded =
      !Number.isNaN(createdMs) &&
      laterComplete !== undefined &&
      laterComplete > createdMs;
    if (isOld || isSuperseded) {
      staleFailures.push(job);
    } else {
      fresh.push(job);
    }
  }
  return { fresh, staleFailures };
}
