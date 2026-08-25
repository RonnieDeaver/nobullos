/**
 * Canonical backfill job lifecycle helpers.
 *
 * Wraps `backfill_jobs` with create/start/progress/complete operations so
 * route handlers and worker code don't have to roll their own column
 * shapes. Every backfill (SEMrush heatmaps and Zoom review-signals) writes
 * one row here so an operator can answer "what backfills ran in the last
 * 24h, and which (clientId, locationId, campaignId, reportDate) tuples are
 * STILL not covered after the backfill finished?".
 */
import { workerDb as db } from "../db";
import {
  backfillJobs,
  heatmapSnapshots,
  type BackfillJob,
  type BackfillJobStatus,
  type BackfillJobType,
} from "@shared/schema";
import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { normalizeKeyword } from "@shared/keywordNormalization";

export interface CreateBackfillJobInput {
  jobType: BackfillJobType;
  triggeredBy?: string | null;
  parameters: Record<string, unknown>;
  totalUnits?: number;
}

export async function createBackfillJob(input: CreateBackfillJobInput): Promise<BackfillJob> {
  const [row] = await db.insert(backfillJobs).values({
    jobType: input.jobType,
    status: "queued",
    triggeredBy: input.triggeredBy ?? null,
    parametersJson: input.parameters,
    totalUnits: input.totalUnits ?? 0,
  }).returning();
  return row;
}

export async function markJobRunning(jobId: string): Promise<void> {
  await db.update(backfillJobs)
    .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
    .where(eq(backfillJobs.id, jobId));
}

export interface ProgressDelta {
  processed?: number;
  succeeded?: number;
  failed?: number;
  alreadyCurrent?: number;
}

export async function recordProgress(jobId: string, delta: ProgressDelta): Promise<void> {
  // SQL-side increments to keep concurrent worker writes safe.
  await db.update(backfillJobs)
    .set({
      processedUnits: sql`${backfillJobs.processedUnits} + ${delta.processed ?? 0}`,
      succeededUnits: sql`${backfillJobs.succeededUnits} + ${delta.succeeded ?? 0}`,
      failedUnits: sql`${backfillJobs.failedUnits} + ${delta.failed ?? 0}`,
      alreadyCurrentUnits: sql`${backfillJobs.alreadyCurrentUnits} + ${delta.alreadyCurrent ?? 0}`,
      updatedAt: new Date(),
    })
    .where(eq(backfillJobs.id, jobId));
}

export interface CompleteJobInput {
  status: BackfillJobStatus;
  resultJson?: unknown;
  errorMessage?: string | null;
  coverageGaps?: CoverageGap[] | null;
}

export async function completeBackfillJob(jobId: string, input: CompleteJobInput): Promise<void> {
  await db.update(backfillJobs)
    .set({
      status: input.status,
      completedAt: new Date(),
      resultJson: input.resultJson ?? null,
      errorMessage: input.errorMessage ?? null,
      coverageGapsJson: input.coverageGaps ?? null,
      updatedAt: new Date(),
    })
    .where(eq(backfillJobs.id, jobId));
}

export async function getBackfillJob(jobId: string): Promise<BackfillJob | null> {
  const [row] = await db.select().from(backfillJobs).where(eq(backfillJobs.id, jobId)).limit(1);
  return row ?? null;
}

export interface ListJobsFilter {
  jobType?: BackfillJobType;
  status?: BackfillJobStatus;
  limit?: number;
}

export async function listBackfillJobs(filter: ListJobsFilter = {}): Promise<BackfillJob[]> {
  const conds: SQL[] = [];
  if (filter.jobType) conds.push(eq(backfillJobs.jobType, filter.jobType));
  if (filter.status) conds.push(eq(backfillJobs.status, filter.status));
  let q = db.select().from(backfillJobs).$dynamic();
  if (conds.length > 0) q = q.where(and(...conds));
  return await q.orderBy(desc(backfillJobs.createdAt)).limit(Math.min(500, Math.max(1, filter.limit ?? 50)));
}

// ---------------------------------------------------------------------------
// Coverage-gap reporting
// ---------------------------------------------------------------------------

export interface CoverageScopeUnit {
  clientId: string;
  locationId: string;
  campaignId: string;
  reportDate: string; // YYYY-MM-DD (UTC day)
  expectedKeywords: string[];
}

export interface CoverageGap {
  clientId: string;
  locationId: string;
  campaignId: string;
  reportDate: string;
  expected: number;
  observed: number;
  missingKeywords: string[];
}

/**
 * For each scope unit (clientId, locationId, campaignId, reportDate), check
 * how many of `expectedKeywords` actually have a `heatmap_snapshots` row.
 * Returns ONLY units with non-empty gaps. Identity matches via the canonical
 * `normalizeKeyword` so casing/whitespace variants count as covered.
 */
export async function computeCoverageGaps(
  scope: CoverageScopeUnit[],
): Promise<CoverageGap[]> {
  const gaps: CoverageGap[] = [];
  for (const unit of scope) {
    const dayStart = new Date(unit.reportDate + "T00:00:00.000Z");
    const dayEnd = new Date(unit.reportDate + "T23:59:59.999Z");
    const rows = await db.select({ keywordName: heatmapSnapshots.keywordName })
      .from(heatmapSnapshots)
      .where(and(
        eq(heatmapSnapshots.campaignId, unit.campaignId),
        eq(heatmapSnapshots.locationId, unit.locationId),
        gte(heatmapSnapshots.reportDate, dayStart),
        lte(heatmapSnapshots.reportDate, dayEnd),
      ));
    const observed = new Set<string>();
    for (const r of rows) observed.add(normalizeKeyword(r.keywordName));
    const expectedNorm = unit.expectedKeywords.map(k => ({ raw: k, norm: normalizeKeyword(k) }));
    const missing = expectedNorm.filter(k => !observed.has(k.norm)).map(k => k.raw);
    if (missing.length > 0) {
      gaps.push({
        clientId: unit.clientId,
        locationId: unit.locationId,
        campaignId: unit.campaignId,
        reportDate: unit.reportDate,
        expected: unit.expectedKeywords.length,
        observed: unit.expectedKeywords.length - missing.length,
        missingKeywords: missing.slice(0, 100), // cap payload size
      });
    }
  }
  return gaps;
}
