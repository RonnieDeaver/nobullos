import { log } from "./httpApp";
import { ensureFrontSyncEmailsColumns, ensureTwilioColumns, ensureRawCommunicationColumns } from "./schemaEnsures";
/**
 * Boot — deferred DDL batch B.
 * Extracted verbatim from server/index.ts (Task #3787 split); invoked from
 * the index.ts bootstrap in the exact original sequence.
 * idempotent DDL ensures + seeds (parallel, fail-soft).
 */


export function kickDdlEnsuresBatchB(): void {
  // Batch B: idempotent DDL ensures + seeds (parallel, fail-soft).
  void (async () => {
    await Promise.allSettled([
      (async () => {
        try { await ensureFrontSyncEmailsColumns(); }
        catch (err) { console.warn("[Bootstrap] ensureFrontSyncEmailsColumns failed:", err); }
      })(),
      (async () => {
        try { await ensureTwilioColumns(); }
        catch (err) { console.warn("[Bootstrap] ensureTwilioColumns failed:", err); }
      })(),
      (async () => {
        try { await ensureRawCommunicationColumns(); }
        catch (err) { console.warn("[Bootstrap] ensureRawCommunicationColumns failed:", err); }
      })(),
      // Task #2367: seed the RIS V1 QA catalog. Idempotent — new keys only.
      (async () => {
        try {
          const { seedRisCatalog } = await import("../services/ris/risCatalog");
          const risSeed = await seedRisCatalog();
          log(
            `[Bootstrap] ris_checks seed: inserted=${risSeed.inserted} ` +
              `total_seed_rows=${risSeed.total}`,
          );
        } catch (err) { console.warn("[Bootstrap] ris_checks seed failed:", err); }
      })(),
      // Task #1047: defensive boot-time collapse of pre-#1025 duplicate rows.
      (async () => {
        try {
          const { collapseRetroactiveReprocessBacklogOnBoot } = await import(
            "../services/retroactiveReprocessBacklogCollapse"
          );
          const collapse = await collapseRetroactiveReprocessBacklogOnBoot();
          if (collapse.triggered) {
            log(
              `[Bootstrap] retroactive_reprocess backlog collapse: ` +
                `pendingBefore=${collapse.pendingBefore} cancelled=${collapse.cancelled} ` +
                `pendingAfter=${collapse.pendingAfter}`,
            );
          } else {
            log(
              `[Bootstrap] retroactive_reprocess backlog collapse skipped ` +
                `(pending=${collapse.pendingBefore}, below trigger threshold)`,
            );
          }
        } catch (err) { console.warn("[Bootstrap] retroactive_reprocess backlog collapse skipped:", err); }
      })(),
      // Ads OS store tables — raw-SQL-managed boot ensure (all environments).
      (async () => {
        try {
          const { ensureAdsOsStoreTables } = await import("../services/adsOs/storeSchema");
          await ensureAdsOsStoreTables();
          console.log("[Bootstrap] Ads OS store tables ensured");
        } catch (err) { console.warn("[Bootstrap] Ads OS store tables ensure failed:", err); }
      })(),
      // Booking schema ensures
      (async () => {
        try {
          const { ensureBookingTables, recheckBookingSchemaReadiness } = await import(
            "../services/bookingSchemaReadiness"
          );
          await ensureBookingTables();
          const { ensureBookingDbConstraints } = await import("../services/bookingDbConstraints");
          await ensureBookingDbConstraints();
          // Refresh the cached readiness snapshot so it reflects the
          // post-bootstrap state of constraints.
          await recheckBookingSchemaReadiness();
          console.log("[Bootstrap] booking schema and DB-level constraints ensured");
        } catch (err) { console.warn("[Bootstrap] booking schema bootstrap skipped:", err); }
      })(),
    ]);
  })();
}
