/**
 * 412G — Zoom auto-claim re-evaluation & backfill (one-shot script).
 *
 * Usage:
 *   tsx scripts/zoom-backfill-reeval.ts --dry-run [--window 90] [--limit 500]
 *   tsx scripts/zoom-backfill-reeval.ts --apply --confirm [--window 90] [--limit 500]
 *
 *   # target a specific raw_communication_records.id (bypasses window/auto-claim filter)
 *   tsx scripts/zoom-backfill-reeval.ts --dry-run --record-id <uuid>
 *   tsx scripts/zoom-backfill-reeval.ts --apply --confirm --record-id <uuid>
 *
 *   # verify a single record's post-backfill state (the Jake → Rahlita case by default)
 *   tsx scripts/zoom-backfill-reeval.ts --verify
 *   tsx scripts/zoom-backfill-reeval.ts --verify --record-id <uuid>
 *
 *   # task #1001 — backfill no-candidate Review Queue rows for older Zoom
 *   # recordings that pre-date task #995 (always dry-run unless --apply).
 *   tsx scripts/zoom-backfill-reeval.ts --no-candidate --dry-run [--limit 500]
 *   tsx scripts/zoom-backfill-reeval.ts --no-candidate --apply --confirm [--limit 500]
 *
 * Always run --dry-run first. The apply pass is idempotent: re-running it
 * will skip records that already carry a backfill_412g decision row.
 */

import {
  runZoomBackfillDryRun,
  runZoomBackfillApply,
  formatBackfillReportText,
  verifyZoomBackfillRecord,
  formatVerificationText,
  JAKE_RAHLITA_RECORD_ID,
} from "../server/services/zoomBackfillReeval";
import {
  runZoomNoCandidateReviewQueueBackfill,
  formatZoomNoCandidateReviewQueueBackfillReport,
} from "../server/services/zoomReviewQueueBackfill";

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const isVerify = !!args["verify"];
  const isApply = !!args["apply"];
  const isNoCandidate = !!args["no-candidate"];
  const isDry = !!args["dry-run"] || (!isApply && !isVerify);
  const windowDays = args["window"] ? parseInt(String(args["window"]), 10) : 90;
  const recordLimit = args["limit"] ? parseInt(String(args["limit"]), 10) : undefined;
  const targetRecordId = args["record-id"] ? String(args["record-id"]) : undefined;

  if (isNoCandidate) {
    if (isApply && !args["confirm"]) {
      console.error("Refusing to apply without --confirm. Run --no-candidate --dry-run first and review the report.");
      process.exit(2);
    }
    const dryRun = !isApply;
    const report = await runZoomNoCandidateReviewQueueBackfill({
      dryRun,
      limit: recordLimit,
    });
    console.log(formatZoomNoCandidateReviewQueueBackfillReport(report));
    if (dryRun) {
      console.log("\n(no changes were applied — dry run)");
    }
    return;
  }

  if (isVerify) {
    const id = targetRecordId || JAKE_RAHLITA_RECORD_ID;
    const v = await verifyZoomBackfillRecord(id);
    console.log(formatVerificationText(v));
    process.exit(v.isClean ? 0 : 1);
  }

  if (isApply && !args["confirm"]) {
    console.error("Refusing to apply without --confirm. Run --dry-run first and review the report.");
    process.exit(2);
  }

  const opts = { windowDays, recordLimit, targetRecordId };

  if (isDry && !isApply) {
    const report = await runZoomBackfillDryRun(opts);
    console.log(formatBackfillReportText(report));
    console.log("\n(no changes were applied — dry run)");
    return;
  }

  // Apply path also runs an internal scan first; the apply function does not
  // separately fetch the dry-run report. We still print the resulting report
  // post-apply so operators see exactly what was touched.
  const result = await runZoomBackfillApply(opts);
  console.log(formatBackfillReportText(result.report));
  console.log("\nApplied:");
  console.log(`  decisions created:  ${result.applied.decisionsCreated}`);
  console.log(`  decisions updated:  ${result.applied.decisionsUpdated}`);
  console.log(`  raw records moved:  ${result.applied.rawRecordsUpdated}`);
  console.log(`  links rejected:     ${result.applied.linksRemoved}`);
  console.log(`  skipped (no change/already backfilled): ${result.applied.skippedNoChange}`);

  if (targetRecordId) {
    console.log("\n— post-apply verification —");
    const v = await verifyZoomBackfillRecord(targetRecordId);
    console.log(formatVerificationText(v));
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[zoom-backfill-reeval] FAILED:", err);
    process.exit(1);
  },
);
