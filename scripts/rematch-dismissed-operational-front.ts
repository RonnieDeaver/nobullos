/**
 * Task #2637 — Re-match the dismissed_operational Front backlog.
 *
 * The operational classifier was removed (Task #2637). Every `front_sync_emails`
 * row it auto-dismissed (`match_status='dismissed_operational'`) must go back up
 * for deterministic-only matching.
 *
 * Behaviour
 * ---------
 * Default mode is dry-run: counts how many rows are still in
 * `dismissed_operational` and prints a small sample. No writes.
 *
 * `--apply` drives the shared core `rematchDismissedOperationalBatch` in a loop
 * until the cohort is empty, re-bucketing every row to auto_matched / unmatched
 * / blocked / dismissed via the deterministic-only path. NOTE: in the dev
 * workspace the prod DB is read-only, so the canonical apply path is the
 * one-press worker-pool prod-action
 * `rematch_dismissed_operational_front_backlog` in /admin. This CLI's `--apply`
 * is for environments that have write access to the target DB.
 *
 * Idempotent: re-running after `--apply` finds zero candidates.
 *
 * Usage:
 *   tsx scripts/rematch-dismissed-operational-front.ts
 *   tsx scripts/rematch-dismissed-operational-front.ts --apply
 */

import { getDb, runWithWorkerDb } from "../server/db";
import { sql } from "drizzle-orm";
import {
  countDismissedOperationalSyncEmails,
  rematchDismissedOperationalBatch,
  REMATCH_DISMISSED_OPERATIONAL_BATCH_SIZE,
} from "../server/services/frontIntegration";

type Args = { apply: boolean };

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") {
      console.log("scripts/rematch-dismissed-operational-front.ts [--apply]");
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  console.log("== Re-match dismissed-operational Front backlog (Task #2637) ==");
  console.log(`Mode: ${args.apply ? "APPLY" : "DRY-RUN"}`);
  console.log("");

  const total = await runWithWorkerDb(() => countDismissedOperationalSyncEmails());
  console.log(`dismissed_operational front_sync_emails rows: ${total}`);
  console.log("");

  if (total === 0) {
    console.log("Nothing to re-match — exiting.");
    return;
  }

  // Small sample so operators can eyeball before applying.
  const sample = await runWithWorkerDb(() =>
    getDb().execute(sql`
      SELECT id, conversation_id, subject,
             LEFT(COALESCE(operational_classification_reason, ''), 120) AS reason_snippet,
             created_at
      FROM front_sync_emails
      WHERE match_status = 'dismissed_operational'
      ORDER BY created_at DESC
      LIMIT 5
    `),
  );
  console.log("Sample (newest 5 by created_at):");
  for (const r of sample.rows as any[]) {
    console.log(
      `  id=${r.id} conv=${r.conversation_id} created=${r.created_at} ` +
        `subject="${(r.subject ?? "").slice(0, 60)}" reason="${r.reason_snippet}"`,
    );
  }
  console.log("");

  if (!args.apply) {
    console.log("Dry-run complete. Re-run with --apply to perform the re-match,");
    console.log(
      "or use the /admin prod-action 'Re-match dismissed-operational Front backlog'.",
    );
    return;
  }

  // Apply: drain in batches until the cohort is empty (each batch leaves every
  // fetched row out of the cohort, so the loop is guaranteed to terminate).
  const tally = { scanned: 0, matched: 0, unmatched: 0, dismissedByRule: 0, errors: 0 };
  let chunk = 0;
  for (;;) {
    const r = await runWithWorkerDb(() =>
      rematchDismissedOperationalBatch({
        batchSize: REMATCH_DISMISSED_OPERATIONAL_BATCH_SIZE,
      }),
    );
    tally.scanned += r.scanned;
    tally.matched += r.matched;
    tally.unmatched += r.unmatched;
    tally.dismissedByRule += r.dismissedByRule;
    tally.errors += r.errors;
    chunk++;
    if (r.scanned > 0) {
      console.log(
        `  chunk ${chunk}: scanned=${r.scanned} matched=${r.matched} ` +
          `unmatched=${r.unmatched} dismissedByRule=${r.dismissedByRule} errors=${r.errors}`,
      );
    }
    if (r.scanned === 0) break;
  }

  console.log("");
  console.log("Apply complete:");
  console.log(`  scanned:         ${tally.scanned}`);
  console.log(`  matched:         ${tally.matched}`);
  console.log(`  unmatched:       ${tally.unmatched}`);
  console.log(`  dismissedByRule: ${tally.dismissedByRule}`);
  console.log(`  errors:          ${tally.errors}`);

  const remaining = await runWithWorkerDb(() => countDismissedOperationalSyncEmails());
  console.log("");
  console.log(`Remaining dismissed_operational rows: ${remaining}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAILED:", err);
    process.exit(1);
  });
