/**
 * One-off dev-DB sync: apply the Task #4818 schedule targets to the local
 * dev clone so the dashboard shows correct schedules immediately.
 * Run: npx tsx scripts/sync-ads-os-schedules-dev.ts
 * Safe to re-run (idempotent — skips already-matching and absent docs).
 *
 * Uses the same patchClientSchedule helper as the prod action so behaviour
 * is identical: strict read (throws on DB error), raw-doc patch (preserves
 * all stored fields), skip absent docs.
 */
import { getCriteriaStrict, putCriteria } from "../server/services/adsOs/store";
import {
  SCHEDULE_SYNC_TARGETS,
  patchClientSchedule,
} from "../server/services/prodActions/platformOpsActions";

async function main() {
  let updated = 0, skippedMatch = 0, skippedAbsent = 0, errors = 0;
  for (const entry of SCHEDULE_SYNC_TARGETS) {
    try {
      const result = await patchClientSchedule(entry, getCriteriaStrict, putCriteria);
      if (result.outcome === "updated") {
        console.log("  updated:", entry.client);
        updated++;
      } else if (result.outcome === "skipped-match") {
        skippedMatch++;
      } else {
        console.log("  absent (skipped):", entry.client);
        skippedAbsent++;
      }
    } catch(e: any) {
      console.error("  ERROR:", entry.client, e?.message);
      errors++;
    }
  }
  console.log(`\nDone. updated=${updated} skipped-match=${skippedMatch} skipped-absent=${skippedAbsent} errors=${errors}`);
  process.exit(errors > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
