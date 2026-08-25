// @db-pool-intent: worker
//
// Task #1831 — webhook-stage mirror back into `front_sync_emails`.
//
// Background: the on-demand `syncFrontEmails` path that historically wrote
// rows to `front_sync_emails` was removed during the move to the durable
// webhook pipeline (source_event_log → front_webhook_normalize →
// front_webhook_apply → raw_communication_records). After that change the
// inserter functions in `server/storage/communicationStorage.ts`
// (`createFrontSyncEmail`, `upsertFrontSyncEmailWithVersion`) had zero
// callers, and `front_sync_emails` froze on 2026-04-14. Many downstream
// readers (frontSyncEmailTriage, frontPipelineMetrics,
// frontAutoClosure, frontPipelineStuckAlerts, frontBulkActions,
// healthDegradedTracker, frontAnalyticsCoverage, routes) still query this
// table, so the table-deprecation alternative is much larger than this
// minimal mirror.
//
// This helper is called from the normalize stage (live webhook +
// reconciliation) to insert/upsert the row in `discovered` state, and from
// the apply stage on success / `already_exists` to transition the row to
// `applied`. The transition uses a bare UPDATE (not
// `transitionFrontSyncPipelineState`, which would require `force: true` to
// jump directly from `discovered` → `applied`) because the webhook path
// legitimately bypasses the intermediate triage / hydrate states the
// legacy on-demand sync used.
//
// Pool tenancy: callers run in worker context (`workerDb`), so both helpers
// default to `workerDb` to match every other write in
// `frontWebhookIngestion.ts`. Per the DB-pool-tenancy shared-helper rule
// they also accept an explicit `db` handle so a worker-context caller that
// already holds a scoped handle (e.g. the Task #2670 missing-mirror
// reconciliation prod-action running under `runWithWorkerDb` / an isolated
// test schema) can pass `getDb()` and keep its reads and writes on the same
// connection/schema. Gated by the `front_sync_emails_mirror_enabled` Pool
// Epic kill switch (default ON) so the change is hot-flippable without a
// redeploy.

import { workerDb, withDbHoldLabel } from "../db";
import { frontSyncEmails } from "@shared/schema";
import { computeVersionKey } from "@shared/models/communications";
import { eq, sql } from "drizzle-orm";
import { isPoolEpicSwitchEnabled } from "./poolEpicKillSwitches";

// A drizzle handle compatible with `workerDb` (the worker pool) — also
// satisfied by `getDb()` and the isolated-schema test wrapper.
type FrontSyncEmailMirrorDb = typeof workerDb;

export interface FrontSyncEmailMirrorInput {
  conversationId: string;
  subject?: string | null;
  snippet?: string | null;
  participants?: Array<{ name?: string; email?: string; role?: string }> | null;
  lastMessageAt: Date;
  lastMessageId?: string | null;
}

export async function mirrorWebhookToFrontSyncEmail(
  input: FrontSyncEmailMirrorInput,
  db: FrontSyncEmailMirrorDb = workerDb,
): Promise<void> {
  if (!isPoolEpicSwitchEnabled("front_sync_emails_mirror_enabled")) return;
  if (!input.conversationId) return;

  try {
    await withDbHoldLabel("front_sync_email_mirror:upsert", async () => {
      const versionKey = computeVersionKey(
        input.conversationId,
        input.lastMessageId ?? null,
      );
      await db
        .insert(frontSyncEmails)
        .values({
          conversationId: input.conversationId,
          subject: input.subject ?? null,
          snippet: input.snippet ?? null,
          participantsJson: input.participants ?? null,
          lastMessageAt: input.lastMessageAt,
          lastMessageId: input.lastMessageId ?? null,
          pipelineState: "discovered",
          versionKey,
          stateChangedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: frontSyncEmails.conversationId,
          set: {
            // Content fields use COALESCE so a later payload with nulls
            // can't blank out previously-set values.
            subject: sql`COALESCE(EXCLUDED.subject, ${frontSyncEmails.subject})`,
            snippet: sql`COALESCE(EXCLUDED.snippet, ${frontSyncEmails.snippet})`,
            participantsJson: sql`COALESCE(EXCLUDED.participants_json, ${frontSyncEmails.participantsJson})`,
            // `last_message_at` is always the max, by GREATEST.
            lastMessageAt: sql`GREATEST(EXCLUDED.last_message_at, COALESCE(${frontSyncEmails.lastMessageAt}, 'epoch'::timestamp))`,
            // Version metadata MUST only advance, never regress. An
            // out-of-order payload (older `last_message_at`) keeps the
            // existing `last_message_id` and `version_key`, otherwise
            // downstream consumers that key off `version_key` would
            // desynchronize from the freshness column.
            lastMessageId: sql`CASE
              WHEN EXCLUDED.last_message_at IS NOT NULL
                AND EXCLUDED.last_message_at >= COALESCE(${frontSyncEmails.lastMessageAt}, 'epoch'::timestamp)
              THEN COALESCE(EXCLUDED.last_message_id, ${frontSyncEmails.lastMessageId})
              ELSE ${frontSyncEmails.lastMessageId}
            END`,
            // versionKey MUST stay aligned with the effective
            // lastMessageId — derive it from the same COALESCE the
            // lastMessageId branch uses, NOT from EXCLUDED.version_key
            // (which would regress to `conv::no_msg` when a newer
            // payload arrives with a null message id while we kept the
            // existing non-null lastMessageId).
            versionKey: sql`CASE
              WHEN EXCLUDED.last_message_at IS NOT NULL
                AND EXCLUDED.last_message_at >= COALESCE(${frontSyncEmails.lastMessageAt}, 'epoch'::timestamp)
              THEN ${frontSyncEmails.conversationId} || '::' || COALESCE(EXCLUDED.last_message_id, ${frontSyncEmails.lastMessageId}, 'no_msg')
              ELSE ${frontSyncEmails.versionKey}
            END`,
            // A new normalize event on an already-`applied` row means
            // there's a new message on the conversation. Reset the
            // pipeline back to `discovered` so the apply stage's
            // `markFrontSyncEmailMirrorApplied` has somewhere to go;
            // otherwise the row would silently stay `applied` while a
            // fresh apply pass is in flight. Clears the apply marker
            // and any previous error.
            pipelineState: sql`'discovered'`,
            stateChangedAt: sql`NOW()`,
            pipelineError: sql`NULL`,
            processedAt: sql`NULL`,
          },
        });
    });
  } catch (err) {
    console.warn(
      `[FrontSyncEmailMirror] upsert failed for ${input.conversationId} (non-fatal):`,
      (err as Error).message,
    );
  }
}

export async function markFrontSyncEmailMirrorApplied(
  conversationId: string,
  db: FrontSyncEmailMirrorDb = workerDb,
): Promise<void> {
  if (!isPoolEpicSwitchEnabled("front_sync_emails_mirror_enabled")) return;
  if (!conversationId) return;

  try {
    await withDbHoldLabel("front_sync_email_mirror:apply", async () => {
      await db
        .update(frontSyncEmails)
        .set({
          pipelineState: "applied",
          stateChangedAt: new Date(),
          pipelineError: null,
          processedAt: new Date(),
        })
        .where(eq(frontSyncEmails.conversationId, conversationId));
    });
  } catch (err) {
    console.warn(
      `[FrontSyncEmailMirror] mark applied failed for ${conversationId} (non-fatal):`,
      (err as Error).message,
    );
  }
}
