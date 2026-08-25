/**
 * Task #1014 — Backfill `pausedAt` / `pausedAtBacklog` for queues that
 * were paused before Task #998 shipped.
 *
 * Background
 * ----------
 * The Task #998 backlog-growth watcher needs both `pausedAt` and
 * `pausedAtBacklog` on each `queue_drain_state` entry to fire. Queues
 * that were already paused before #998 deployed have neither and the
 * watcher silently skips them with `decision: "skipped_no_baseline"`
 * until an operator manually resumes and re-pauses them. This script
 * fills in the missing baselines using the current timestamp and the
 * current pending-job count for the queue, so the watcher covers them
 * on the next tick.
 *
 * Behaviour
 * ---------
 * Default mode is dry-run: it scans `system_settings.queue_drain_state`,
 * lists every paused queue that is missing either baseline field, and
 * reports what it would write. `--apply` mutates: it sets `pausedAt` to
 * `new Date().toISOString()` and `pausedAtBacklog` to the queue's
 * current `pending` count from `work_queue`. Queues that already have
 * both baselines are left untouched, which makes the script idempotent
 * and safe to re-run.
 *
 * Usage:
 *   tsx scripts/backfill-queue-drain-pause-baselines.ts
 *   tsx scripts/backfill-queue-drain-pause-baselines.ts --apply
 */

import { storage } from "../server/storage";
import { getQueuePendingCount, type QueueDrainState } from "../server/services/queueDrainControl";

const SETTING_KEY = "queue_drain_state";

type Args = { apply: boolean };

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") {
      console.log("scripts/backfill-queue-drain-pause-baselines.ts [--apply]");
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

interface DrainStateMap {
  [queueName: string]: QueueDrainState;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const row = await storage.getSystemSetting(SETTING_KEY);
  if (!row?.value) {
    console.log(`[backfill-pause-baselines] No '${SETTING_KEY}' setting found; nothing to do.`);
    return;
  }

  let parsed: DrainStateMap;
  try {
    parsed = JSON.parse(row.value) as DrainStateMap;
  } catch (err: any) {
    console.error(`[backfill-pause-baselines] Failed to parse '${SETTING_KEY}': ${err?.message}`);
    process.exit(1);
  }

  const queueNames = Object.keys(parsed).sort();
  const candidates: string[] = [];
  for (const name of queueNames) {
    const e = parsed[name];
    if (!e || typeof e !== "object") continue;
    if (!e.paused) continue;
    const missingPausedAt = !e.pausedAt;
    const missingBacklog = e.pausedAtBacklog === null || e.pausedAtBacklog === undefined;
    if (missingPausedAt || missingBacklog) candidates.push(name);
  }

  if (candidates.length === 0) {
    console.log(
      `[backfill-pause-baselines] All ${queueNames.length} queue(s) in '${SETTING_KEY}' already have pause baselines (or are not paused). Nothing to do.`,
    );
    return;
  }

  console.log(
    `[backfill-pause-baselines] Found ${candidates.length} paused queue(s) missing baselines:`,
  );
  const now = new Date().toISOString();
  const planned: Array<{ queueName: string; pausedAt: string; pausedAtBacklog: number }> = [];
  const skipped: Array<{ queueName: string; reason: string }> = [];
  for (const name of candidates) {
    const existing = parsed[name]!;
    const needsBacklog =
      existing.pausedAtBacklog === null || existing.pausedAtBacklog === undefined;
    let backlog: number;
    if (needsBacklog) {
      try {
        backlog = await getQueuePendingCount(name);
      } catch (err: any) {
        // Don't write a baseline of 0 from a transient DB failure — once
        // we write something the queue looks "baselined" on the next
        // run and we'll never come back to fix it. Skip this queue and
        // let the operator re-run after the DB recovers.
        const msg = err?.message ?? String(err);
        console.warn(
          `[backfill-pause-baselines] Failed to read pending count for ${name}: ${msg}; skipping (re-run after the issue is resolved)`,
        );
        skipped.push({ queueName: name, reason: `pending-count read failed: ${msg}` });
        continue;
      }
    } else {
      backlog = existing.pausedAtBacklog as number;
    }
    const newPausedAt = existing.pausedAt ?? now;
    planned.push({ queueName: name, pausedAt: newPausedAt, pausedAtBacklog: backlog });
    console.log(
      `  - ${name}: pausedAt=${newPausedAt} pausedAtBacklog=${backlog} ` +
        `(was pausedAt=${existing.pausedAt ?? "null"}, pausedAtBacklog=${existing.pausedAtBacklog ?? "null"})`,
    );
  }

  if (!args.apply) {
    console.log(
      `[backfill-pause-baselines] Dry-run. Would touch ${planned.length} queue(s); skipped ${skipped.length}. Re-run with --apply to write.`,
    );
    return;
  }

  if (planned.length === 0) {
    console.log(
      `[backfill-pause-baselines] Nothing to write (touched=0 skipped=${skipped.length}).`,
    );
    return;
  }

  for (const p of planned) {
    const existing = parsed[p.queueName]!;
    parsed[p.queueName] = {
      ...existing,
      pausedAt: p.pausedAt,
      pausedAtBacklog: p.pausedAtBacklog,
    };
  }

  await storage.setSystemSetting(SETTING_KEY, JSON.stringify(parsed), "system");
  console.log(
    `[backfill-pause-baselines] Done. touched=${planned.length} skipped=${skipped.length}. Restart the server (or wait for the next deploy) so the in-memory queue-drain cache picks up the new baselines — the watcher reads from that cache on each tick.`,
  );
  if (skipped.length > 0) {
    for (const s of skipped) {
      console.log(`  skipped: ${s.queueName} — ${s.reason}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[backfill-pause-baselines] Fatal: ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
