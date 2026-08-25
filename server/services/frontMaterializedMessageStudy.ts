// @db-pool-intent: worker — every getDb() call is wrapped in runWithWorkerDb(...)
// @cross-instance-safe: no recurring timer of its own — it is driven only by
// the `study_materialized_front_messages` prod-action / self-heal scheduler
// (which run under a cross-instance prod-action drain lock) and it is
// idempotent: each chunk CLAIMS the rows it touches (matched → status flipped
// to 'pending' which removes them from the candidate predicate; unmatched →
// ai_processed_at stamped terminal), and the enqueued `analyze_communication`
// jobs are dedupe-keyed, so a duplicate run on another instance collapses.
//
// Task #2602 — AI-study the materialized Front messages.
//
// The per-message materialization path (`materializeFrontMessageRecord` in
// `frontWebhookIngestion.ts`) writes one `raw_communication_records` row per
// historical Front message at `processingStatus:'processed'` with NO
// `clientId`. Those two facts mean such a row NEVER enters the classifier
// queue and is NEVER studied into `agent_knowledge_base`
// (`analyzeCommunication` only persists client knowledge when `clientId` is
// set). This module closes that gap: it walks the materialized rows that have
// not yet been studied, resolves each to a client via the SAME deterministic
// hard-match index Front uses elsewhere, and enqueues the existing
// `analyze_communication` job so the message is AI-studied like any other
// communication. Messages with no confident client match are stamped terminal
// (no client knowledge target → no OpenAI spend).
//
// Bounded + opt-in: gated behind the default-OFF
// `front_materialized_message_study_enabled` switch because studying ~100% of
// historical Front messages through GPT-4o is real, unbounded OpenAI spend.

import { sql } from "drizzle-orm";
import { getDb, runWithWorkerDb, withDbAttribution } from "../db";
import {
  resolveFrontHardMatch,
  getHardMatchIndexes,
  type FrontParticipant,
} from "./frontHardMatch";
import { isPoolEpicSwitchEnabled } from "./poolEpicKillSwitches";
import { FRONT_ADOPTION_DATE } from "./frontAnalyticsCoverage";

export const FRONT_MATERIALIZED_MESSAGE_STUDY_SWITCH =
  "front_materialized_message_study_enabled" as const;

/** ISO lower bound for in-scope materialized messages (coverage floor). */
function scopeFloorIso(): string {
  return `${FRONT_ADOPTION_DATE}T00:00:00.000Z`;
}

/**
 * Shared predicate for "a materialized Front message that still needs AI
 * study". Centralised so `countPending` and `studyMaterializedMessageChunk`
 * can never drift:
 *   - source_type='front_email' AND source_subtype='email_message'
 *       → the per-message materialized rows (not conversation envelopes).
 *   - ai_processed_at IS NULL                → not yet studied.
 *   - processing_status='processed'          → terminal materialized row that
 *       has NOT been claimed by this driver yet (claiming flips it to
 *       'pending', which removes it from this set and stops a second enqueue).
 *   - direction IN ('inbound','outbound')    → real messages, never internal.
 *   - timestamp >= floor                     → in coverage scope.
 */
const CANDIDATE_WHERE = sql`
  source_type = 'front_email'
  AND source_subtype = 'email_message'
  AND ai_processed_at IS NULL
  AND processing_status = 'processed'
  AND direction IN ('inbound', 'outbound')
  AND timestamp IS NOT NULL
`;

/** Count materialized Front messages still awaiting AI study. */
export async function countPendingMaterializedMessageStudy(): Promise<number> {
  return runWithWorkerDb(() =>
    withDbAttribution("frontMaterializedMessageStudy:countPending", async () => {
      const floor = scopeFloorIso();
      const res = await getDb().execute(sql`
        SELECT COUNT(*)::int AS n
        FROM raw_communication_records
        WHERE ${CANDIDATE_WHERE}
          AND timestamp >= ${floor}
      `);
      const rows = ((res as any).rows ?? (res as unknown as any[])) as Array<{
        n: number;
      }>;
      return Number(rows?.[0]?.n) || 0;
    }),
  );
}

interface StudyChunkResult {
  examined: number;
  enqueued: number;
  matchedExisting: number;
  unmatchedStamped: number;
}

/**
 * Process one bounded chunk of materialized Front messages:
 *   - resolve each to a client via the deterministic hard-match index,
 *   - matched → persist clientId, CLAIM the row (status → 'pending'), and
 *     enqueue the existing `analyze_communication` job so it is AI-studied,
 *   - unmatched/ambiguous → stamp `ai_processed_at` terminal (no client KB
 *     target, no OpenAI spend).
 *
 * Idempotent and self-bounding: claiming removes a row from `CANDIDATE_WHERE`,
 * so re-running can never double-enqueue, and the enqueue itself is
 * dedupe-keyed (`analyze_<recordId>`).
 */
export async function studyMaterializedMessageChunk(
  limit: number,
): Promise<StudyChunkResult> {
  const result: StudyChunkResult = {
    examined: 0,
    enqueued: 0,
    matchedExisting: 0,
    unmatchedStamped: 0,
  };

  const candidates = await runWithWorkerDb(() =>
    withDbAttribution(
      "frontMaterializedMessageStudy:selectChunk",
      async () => {
        const floor = scopeFloorIso();
        const res = await getDb().execute(sql`
          SELECT id, participants_json, client_id
          FROM raw_communication_records
          WHERE ${CANDIDATE_WHERE}
            AND timestamp >= ${floor}
          ORDER BY timestamp DESC
          LIMIT ${limit}
        `);
        return ((res as any).rows ?? (res as unknown as any[])) as Array<{
          id: string;
          participants_json: unknown;
          client_id: string | null;
        }>;
      },
    ),
  );

  if (candidates.length === 0) return result;

  const indexes = await getHardMatchIndexes();
  const { enqueueJob } = await import("./workScheduler");

  for (const row of candidates) {
    result.examined++;

    // Defensive: a row that already carries a clientId (e.g. matched at some
    // earlier point) just needs enqueuing + claiming.
    if (row.client_id) {
      await claimAndEnqueue(row.id, enqueueJob);
      result.matchedExisting++;
      result.enqueued++;
      continue;
    }

    const participants = Array.isArray(row.participants_json)
      ? (row.participants_json as FrontParticipant[])
      : [];
    const match = resolveFrontHardMatch(participants, indexes);

    if (match.status === "matched") {
      await runWithWorkerDb(() =>
        withDbAttribution(
          "frontMaterializedMessageStudy:claimMatched",
          () =>
            getDb().execute(sql`
              UPDATE raw_communication_records
              SET client_id = ${match.clientId},
                  processing_status = 'pending',
                  updated_at = now()
              WHERE id = ${row.id}
                AND ai_processed_at IS NULL
                AND processing_status = 'processed'
            `),
        ),
      );
      await enqueueJob({
        queueName: "analyze_communication",
        workloadClass: "ingestion",
        priority: 150,
        payload: { recordId: row.id },
        dedupeKey: `analyze_${row.id}`,
      });
      result.enqueued++;
    } else {
      // No confident client → stamp terminal so it converges and is never
      // re-offered (there is no client knowledge target to study against).
      await runWithWorkerDb(() =>
        withDbAttribution(
          "frontMaterializedMessageStudy:stampUnmatched",
          () =>
            getDb().execute(sql`
              UPDATE raw_communication_records
              SET ai_processed_at = now(),
                  updated_at = now()
              WHERE id = ${row.id}
                AND ai_processed_at IS NULL
                AND processing_status = 'processed'
            `),
        ),
      );
      result.unmatchedStamped++;
    }
  }

  return result;
}

async function claimAndEnqueue(
  recordId: string,
  enqueueJob: (params: {
    queueName: string;
    workloadClass: any;
    priority?: number;
    payload?: Record<string, unknown>;
    dedupeKey?: string;
  }) => Promise<string>,
): Promise<void> {
  await runWithWorkerDb(() =>
    withDbAttribution(
      "frontMaterializedMessageStudy:claimExisting",
      () =>
        getDb().execute(sql`
          UPDATE raw_communication_records
          SET processing_status = 'pending',
              updated_at = now()
          WHERE id = ${recordId}
            AND ai_processed_at IS NULL
            AND processing_status = 'processed'
        `),
    ),
  );
  await enqueueJob({
    queueName: "analyze_communication",
    workloadClass: "ingestion",
    priority: 150,
    payload: { recordId },
    dedupeKey: `analyze_${recordId}`,
  });
}

export function isMaterializedMessageStudyEnabled(): boolean {
  return isPoolEpicSwitchEnabled(FRONT_MATERIALIZED_MESSAGE_STUDY_SWITCH);
}
