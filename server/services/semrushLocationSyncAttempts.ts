/**
 * Append-only writer + read helpers for `semrush_location_sync_attempts`.
 *
 * Insert-only. Never update or delete from product code — the table exists
 * specifically so operator post-mortems can see every prior attempt for a
 * given (clientId, locationId, campaignId) without trawling logs.
 */
import { workerDb as db } from "../db";
import {
  semrushLocationSyncAttempts,
  type SemrushLocationSyncAttempt,
} from "@shared/schema";
import { and, desc, eq } from "drizzle-orm";

export interface RecordAttemptInput {
  syncStateId: string;
  clientId: string;
  locationId: string;
  campaignId: string;
  runId: string;
  attemptNumber: number;
  phase: "begin" | "complete";
  status: string;
  triggeredBy?: string | null;
  reportDate?: string | null;
  importedKeywordCount?: number | null;
  expectedKeywordCount?: number | null;
  durationMs?: number | null;
  errorCategory?: string | null;
  lastError?: string | null;
  message?: string | null;
}

export async function recordAttempt(input: RecordAttemptInput): Promise<void> {
  // Wrap in try/catch — attempt history is observability only; a write
  // failure here must NOT break the underlying sync run.
  try {
    await db.insert(semrushLocationSyncAttempts).values({
      syncStateId: input.syncStateId,
      clientId: input.clientId,
      locationId: input.locationId,
      campaignId: input.campaignId,
      runId: input.runId,
      attemptNumber: input.attemptNumber,
      phase: input.phase,
      status: input.status,
      triggeredBy: input.triggeredBy ?? null,
      reportDate: input.reportDate ?? null,
      importedKeywordCount: input.importedKeywordCount ?? null,
      expectedKeywordCount: input.expectedKeywordCount ?? null,
      durationMs: input.durationMs ?? null,
      errorCategory: input.errorCategory ?? null,
      lastError: input.lastError ?? null,
      message: input.message ?? null,
    });
  } catch (e: any) {
    console.warn(
      `[SemrushSyncAttempts] Failed to write attempt history (non-fatal) for ${input.clientId}/${input.locationId}/${input.campaignId}: ${e?.message || e}`,
    );
  }
}

export async function listAttemptsForLocation(
  clientId: string,
  locationId: string,
  limit = 50,
): Promise<SemrushLocationSyncAttempt[]> {
  return await db
    .select()
    .from(semrushLocationSyncAttempts)
    .where(
      and(
        eq(semrushLocationSyncAttempts.clientId, clientId),
        eq(semrushLocationSyncAttempts.locationId, locationId),
      ),
    )
    .orderBy(desc(semrushLocationSyncAttempts.createdAt))
    .limit(Math.min(500, Math.max(1, limit)));
}

export async function listAttemptsForState(
  syncStateId: string,
  limit = 50,
): Promise<SemrushLocationSyncAttempt[]> {
  return await db
    .select()
    .from(semrushLocationSyncAttempts)
    .where(eq(semrushLocationSyncAttempts.syncStateId, syncStateId))
    .orderBy(desc(semrushLocationSyncAttempts.createdAt))
    .limit(Math.min(500, Math.max(1, limit)));
}
