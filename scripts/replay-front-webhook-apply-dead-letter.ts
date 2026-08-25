/**
 * Task #1045 — Replay the `front_webhook_apply` dead-letter backlog.
 *
 * Background
 * ----------
 * The apply worker crashed with `e.toISOString is not a function` on
 * every job whose normalized payload had been jsonb-round-tripped (the
 * `timestamp` Date became a string and then Drizzle's `timestamp`
 * column blew up). 255+ jobs landed in `dead_letter`. Once the apply
 * code is fixed (see `applyFrontWebhookResult` and
 * `shared/utils/safeDate.ts`), those rows are safe to replay — the
 * normalized payload itself is already correct, only the apply step
 * was failing.
 *
 * Behaviour
 * ---------
 * Default mode is dry-run: lists how many jobs would be replayed and
 * shows a small sample. `--apply` actually replays them by calling
 * `bulkReplayDeadLetteredJobs({ queueName: "front_webhook_apply" })`,
 * which resets each row to `pending` with `attempt_count = 0`. The
 * scheduler picks them up on the next cycle.
 *
 * Usage:
 *   tsx scripts/replay-front-webhook-apply-dead-letter.ts
 *   tsx scripts/replay-front-webhook-apply-dead-letter.ts --apply
 *   tsx scripts/replay-front-webhook-apply-dead-letter.ts --apply --max 500
 *
 * Notes
 * -----
 * - `bulkReplayDeadLetteredJobs` enforces `MAX_BULK_REPLAY` (500) per
 *   call. If the backlog ever exceeds that, run `--apply` repeatedly
 *   until the dry-run reports zero matches.
 * - Idempotent: once a job has been replayed it is no longer in
 *   `dead_letter` status, so re-running is a no-op for that row.
 */

import { bulkReplayDeadLetteredJobs, MAX_BULK_REPLAY } from "../server/services/workScheduler";

const QUEUE_NAME = "front_webhook_apply";

type Args = { apply: boolean; max: number };

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false, max: MAX_BULK_REPLAY };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--max") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) out.max = Math.min(Math.floor(n), MAX_BULK_REPLAY);
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: tsx scripts/replay-front-webhook-apply-dead-letter.ts [--apply] [--max N]");
      process.exit(0);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const { apply, max } = parseArgs(process.argv);

  const dry = await bulkReplayDeadLetteredJobs({
    queueName: QUEUE_NAME,
    dryRun: true,
    maxBatchSize: max,
    operatorId: "task-1045-script",
    operatorUsername: "task-1045-script",
  });

  console.log(
    `[Replay] Dry run: ${dry.count} dead-lettered job(s) on queue "${QUEUE_NAME}" (cap=${dry.cap})${dry.wouldExceedCap ? " — wouldExceedCap=true" : ""}`,
  );
  if (dry.warning) console.log(`[Replay] ${dry.warning}`);
  if (dry.sample && dry.sample.length > 0) {
    console.log(`[Replay] Sample (${dry.sample.length}):`);
    for (const s of dry.sample.slice(0, 5)) {
      console.log(`  - ${s.id} class=${s.workloadClass} err=${(s.errorMessage ?? "").slice(0, 120)}`);
    }
  }

  if (!apply) {
    console.log("[Replay] Dry run complete. Re-run with --apply to actually replay.");
    return;
  }

  if (dry.count === 0) {
    console.log("[Replay] Nothing to do.");
    return;
  }

  const result = await bulkReplayDeadLetteredJobs({
    queueName: QUEUE_NAME,
    dryRun: false,
    maxBatchSize: max,
    operatorId: "task-1045-script",
    operatorUsername: "task-1045-script",
  });

  console.log(`[Replay] Replayed ${result.count} job(s) on queue "${QUEUE_NAME}".`);
  if (result.wouldExceedCap) {
    console.log(`[Replay] Hit cap of ${result.cap}. Re-run --apply until dry-run reports 0 to drain the rest.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[Replay] FAILED:", err);
    process.exit(1);
  });
