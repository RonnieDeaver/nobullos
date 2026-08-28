/**
 * Boot — workers + one-off cleanups.
 * Extracted verbatim from server/index.ts (Task #3787 split); invoked from
 * the index.ts bootstrap in the exact original sequence.
 * MCU worker, rate-limit alert notifier, probe audit, contacts/asks cleanup, work-queue handler bootstrap + required-handlers assert.
 */

import { withDbAttribution as _withDbAttribution } from "../db";
import { log } from "./httpApp";
import { ensureExternalSourceIdUnique, validateBudgetConfig } from "./schemaEnsures";

export function kickWorkersAndCleanup(): void {
      import("../mcu/worker")
        .then(({ startMcuWorker }) => startMcuWorker())
        .catch((err) => console.error("[Bootstrap] MCU worker failed to start:", err));
      // Bootstrap the rate-limit alert notifier so its digest cadence timer
      // is scheduled and any digest warnings persisted before this restart
      // are pulled back into memory for the next scheduled flush.
      import("../services/rateLimitAlertNotifier")
        .then(({ loadAlertNotifyConfig }) => loadAlertNotifyConfig(true))
        .catch((err) =>
          console.error(
            "[Bootstrap] Failed to initialize rate-limit alert notifier:",
            err?.message ?? err,
          ),
        );
      // Task #1882 — boot-time alert-probe audit. Importing the probe
      // owner modules forces their `registerAlertProbe(...)` side-effects
      // to run, then we ask the registry to execute a no-op (LIMIT 0)
      // form of each query. Schema drift (renamed column, dropped table)
      // surfaces immediately as `[ProbeAudit] BROKEN` in the start
      // workflow logs instead of silently warn-and-skip every tick.
      void _withDbAttribution("startup:probe-audit", async () => {
        try {
          await import("../services/leaseChurnAlerts");
          const { runBootAlertProbeAudit } = await import(
            "../services/probeAudit"
          );
          await runBootAlertProbeAudit();
        } catch (err: any) {
          console.error(
            "[ProbeAudit] Boot audit threw unexpectedly:",
            err?.message ?? err,
          );
        }
      });
      // fire-and-forget: cleanup phases catch + log internally.
      void (async () => { await _withDbAttribution("startup:contacts-and-asks-cleanup", async () => {
        try {
          const { db } = await import("../db");
          const { sql } = await import("drizzle-orm");
          const colCheck: { rows?: { column_name: string }[] } = await db.execute(sql`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'client_contacts' AND column_name = 'email'
          `);
          const rows = Array.isArray(colCheck) ? colCheck : colCheck.rows ?? [];
          if (rows.length > 0) {
            await db.execute(sql`
              ALTER TABLE client_contacts
              ADD COLUMN IF NOT EXISTS emails text[] DEFAULT '{}',
              ADD COLUMN IF NOT EXISTS phones text[] DEFAULT '{}'
            `);
            await db.execute(sql`
              UPDATE client_contacts
              SET emails = CASE WHEN email IS NOT NULL AND email != '' THEN ARRAY[email] ELSE '{}' END,
                  phones = CASE WHEN phone IS NOT NULL AND phone != '' THEN ARRAY[phone] ELSE '{}' END
              WHERE (emails IS NULL OR emails = '{}')
            `);
            await db.execute(sql`
              ALTER TABLE client_contacts
              DROP COLUMN IF EXISTS email,
              DROP COLUMN IF EXISTS phone
            `);
            log("Migrated client_contacts email/phone to emails/phones arrays");
          }
        } catch (e) {
          console.warn("Client contacts array migration skipped:", e);
        }
        // Task #914: removed startup invocation of `migrateExistingContactsToTable`.
        // The legacy bulk-migration helper has been deleted because it silently
        // re-created `client_contacts` rows on every restart from the legacy
        // `clients.contactEmail` field, undoing operator cleanups. The original
        // migration ran long ago in production; any future bulk contact creation
        // must go through `clientContactPromotion.ts` (explicit operator opt-in).
        try {
          const { db: dbCleanup } = await import("../db");
          const { sql: sqlCleanup } = await import("drizzle-orm");
          const alreadyRan = await dbCleanup.execute(sqlCleanup`
            SELECT 1 FROM client_open_asks
            WHERE resolution_note LIKE 'Auto-dismissed: cross-client contamination%'
            LIMIT 1
          `);
          const alreadyRanRows = Array.isArray(alreadyRan) ? alreadyRan : alreadyRan.rows ?? [];
          if (alreadyRanRows.length === 0) {
            const otherFirmPatterns = [
              "o'brien", "obrien", "flanagan", "grace legal", "abbott",
              "okuosa", "oscar mendoza", "punchwork", "mendoza",
            ];
            const jonesClientId = "fff49295-9494-4136-9137-2eb2073d8b5b";
            const openAsksResult = await dbCleanup.execute(sqlCleanup`
              SELECT id, summary, ask_text, detail FROM client_open_asks
              WHERE client_id = ${jonesClientId}
              AND status IN ('open', 'likely_open')
            `);
            const openAsks = Array.isArray(openAsksResult) ? openAsksResult : openAsksResult.rows ?? [];
            let dismissed = 0;
            for (const ask of openAsks) {
              const text = ((ask.summary || "") + " " + (ask.ask_text || "") + " " + (ask.detail || "")).toLowerCase();
              const matched = otherFirmPatterns.find(p => text.includes(p));
              if (matched) {
                await dbCleanup.execute(sqlCleanup`
                  UPDATE client_open_asks SET
                    status = 'dismissed',
                    resolution_note = ${"Auto-dismissed: cross-client contamination (matched \"" + matched + "\")"},
                    resolved_at = NOW(),
                    updated_at = NOW()
                  WHERE id = ${ask.id}
                `);
                dismissed++;
              }
            }
            if (dismissed > 0) log(`Cleaned up ${dismissed} contaminated open asks for Jones Law Firm`);
          }
        } catch (err) {
          console.warn("Contaminated asks cleanup skipped:", err);
        }
        if (process.env.JONES_REMEDIATION_ENABLED === "true") {
          try {
            const { remediateJones } = await import("../services/memoryResetWorkflow");
            const { db: dbCheck } = await import("../db");
            const { sql: sqlCheck } = await import("drizzle-orm");
            const jonesMemCheck = await dbCheck.execute(sqlCheck`
              SELECT COUNT(*)::int as cnt FROM client_agent_memory
              WHERE client_id = 'fff49295-9494-4136-9137-2eb2073d8b5b'
              AND source = 'learned'
              AND identifier_type IN ('email', 'domain', 'co_occurrence')
            `);
            const jonesRows = Array.isArray(jonesMemCheck) ? jonesMemCheck : jonesMemCheck.rows ?? [];
            const learnedCount = jonesRows[0]?.cnt ?? 0;
            if (learnedCount > 30) {
              log(`Jones has ${learnedCount} learned entries — running canonical remediation...`);
              const result = await remediateJones();
              log(`Jones remediation complete: removed=${result.resetResult.removed}, rebuilt=${result.resetResult.rebuilt}, claims_released=${result.releaseResult.released}, post_memory=${result.postRebuildInventory.memoryCount}`);
            }
          } catch (err) {
            console.warn("Jones canonical remediation skipped:", err);
          }
        }
      }); })();
      (async () => { await _withDbAttribution("startup:bootstrap-workers", async () => {
        // (fire-and-forget with .catch below: handler registration must not block boot)
        const { registerAllHandlers } = await import("../services/workQueueHandlers");
        registerAllHandlers();

        // Task #978 Phase 1 (Ticket 2): assert required handlers are
        // registered BEFORE the scheduler begins polling. If a handler
        // is missing here it is always a registration bug (deferred
        // import, forgotten line in registerAllHandlers, etc.) and
        // should produce a single loud startup error rather than a
        // flood of "No handler registered" job failures over hours.
        // Task #987: load the persisted per-queue drain state before the
        // scheduler begins polling so a queue that was paused before the
        // last restart stays paused on the very first cycle.
        try {
          const { ensureQueueDrainStateLoaded } = await import("../services/queueDrainControl");
          await ensureQueueDrainStateLoaded();
        } catch (err: any) {
          console.warn("[Bootstrap] queue drain state load failed:", err?.message);
        }

        const { assertRequiredHandlersRegistered } = await import("../services/workScheduler");
        assertRequiredHandlersRegistered([
          "semrush_report_refresh",
          "semrush_background_refresh",
          "retroactive_reprocess",
          "front_webhook_normalize",
          "front_sync_reprocess",
          "analyze_communication",
          "communication_apply",
          // Task #2984 — ClickUp reconciliation sweep + webhook health + repair.
          "clickup_reconciliation_sweep",
          "clickup_webhook_health_check",
          "clickup_webhook_repair",
          // Task #4329 — tags & segments reconciliation sweep (rule-tag +
          // segment-membership convergence; scheduler + manual trigger
          // both enqueue it).
          "tag_segment_reconcile",
          // Task #4333 — deal/lead score recompute sweep (scheduler +
          // manual recompute route both enqueue it).
          "score_recompute",
          // Task #4331 — deal stage automation (stage-change events from
          // the dealsStorage writers + boot catch-up + admin requeue).
          "deal_stage_automation",
          // Task #4335 — email sequence step advancement (enrollment +
          // approval/rejection advancement both enqueue it; a missing
          // handler would strand every active enrollment).
          "email_sequence_step",
           "book_paid_delivery",
          // Task #5156 — ClickUp role projection commands drain.
          "clickup_role_projection",
           // Task #5245 — canonical ClickUp Client List lifecycle commands.
           "clickup_client_mirror",
        ]);

        try {
          const { ensureDurablePipelineTables } = await import("../services/applyPipeline");
          const { retryTransientDbStep } = await import("../lib/bootstrapRetry");
          await retryTransientDbStep("durable_pipeline_tables", () => ensureDurablePipelineTables());
        } catch (e) {
          console.error("[Bootstrap] FATAL: durable_pipeline_tables failed after 5 retries — process will exit:", e);
          setTimeout(() => process.exit(1), 1000);
          return;
        }

        try {
          const { retryTransientDbStep } = await import("../lib/bootstrapRetry");
          await retryTransientDbStep("external_source_id_unique", () => ensureExternalSourceIdUnique());
        } catch (e) {
          console.error("[Bootstrap] FATAL: external_source_id_unique failed after 5 retries — process will exit:", e);
          setTimeout(() => process.exit(1), 1000);
          return;
        }

        try {
          const { cleanupStaleJobsOnStartup } = await import("../services/workScheduler");
          await cleanupStaleJobsOnStartup();
        } catch (e) {
          console.error("[Bootstrap] Startup stale job cleanup failed (non-fatal):", e);
        }

        // Task #836 Phase 2 (post-review): hydrate persisted kill-switch
        // overrides from `system_settings` BEFORE any scheduler/worker
        // tick so a switch that was engaged in a previous process is
        // honored on the very first poll. Without this, the synchronous
        // `isKillSwitchEnabled()` call returns the env default until the
        // background load completes — a measurable window for the first
        // worker tick. This call is awaited and is fail-safe (errors
        // are logged inside the helper); if the load fails we fall back
        // to env defaults rather than blocking startup.
        try {
          const { ensureKillSwitchesLoaded } = await import("../services/killSwitches");
          await ensureKillSwitchesLoaded();
        } catch (e) {
          console.error("[Bootstrap] Non-fatal: kill switch hydration failed:", e);
        }
        try {
          const { startBookPaymentEventReplay } = await import(
            "../services/bookPaymentEventReplay"
          );
          startBookPaymentEventReplay("startup");
        } catch (e) {
          console.error("[Bootstrap] Non-fatal: book-payment replay failed to start:", e);
        }

        // Task #1727 — Pool epic Phase 0 safety switches. Seed the
        // seven `system_settings` rows with their behavior-neutral
        // defaults (idempotent; never overwrites an existing row), then
        // hydrate the in-memory cache so the very first scheduler tick
        // sees the persisted values. Both steps are fail-safe — the
        // loader falls back to hard-coded defaults on error.
        try {
          const {
            ensurePoolEpicSwitchesSeeded,
            ensurePoolEpicSwitchesLoaded,
          } = await import("../services/poolEpicKillSwitches");
          await ensurePoolEpicSwitchesSeeded();
          await ensurePoolEpicSwitchesLoaded();
        } catch (e) {
          console.error("[Bootstrap] Non-fatal: pool epic switch hydration failed:", e);
        }

        try {
          const { startScheduler } = await import("../services/workScheduler");
          const { retryTransientDbStep } = await import("../lib/bootstrapRetry");
          await retryTransientDbStep("scheduler_start", () => startScheduler());
        } catch (e) {
          console.error("[Bootstrap] FATAL: scheduler_start failed after 5 retries — process will exit:", e);
          setTimeout(() => process.exit(1), 1000);
          return;
        }

        // Task #1575 (Track E, F-03) — the per-location SEMrush
        // auto-retry worker is now started inside the deferred
        // WORKER_STAGGER_OFFSETS cohort below (offset
        // `semrush_location_auto_retry`) instead of synchronously here,
        // so its first tick is staggered + jittered relative to the
        // rest of the scheduler cohort.

        try {
          const { PERF: perfFlags } = await import("../perfConfig");
          if (perfFlags.REPAIR_DISPATCHER_ENABLED) {
            const { startRepairDispatcher } = await import("../services/repairDispatcher");
            startRepairDispatcher();
          } else {
            console.log("[RepairDispatcher] Skipped — REPAIR_DISPATCHER_ENABLED is false");
          }
          await validateBudgetConfig();
        } catch (e) {
          console.error("[Bootstrap] Non-fatal: Repair dispatcher or budget validation failed:", e);
        }
      }); })().catch((err) => console.error("[Bootstrap] Workers bootstrap failed:", err));
}
