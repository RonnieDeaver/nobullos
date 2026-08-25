/**
 * Task #1046 one-off: initialize stuck legacy `twilio_calls` rows that
 * were created before the claim-query fix landed.
 *
 * Pre-fix, the call-archive scheduler's claim query gated on
 * `recording_status='completed' AND recording_url IS NOT NULL`. Rows
 * whose recording-status webhook never delivered (recording_status /
 * recording_url stayed NULL) were therefore never claimed and never
 * progressed past `archive_status='pending'` with `archive_attempts=0`
 * and `archive_next_attempt_at IS NULL`.
 *
 * The fix in `claimNextCall` already accepts `archive_next_attempt_at
 * IS NULL`, so these rows would be picked up on the next tick after
 * deploy regardless. This script is belt-and-suspenders: it stamps
 * `archive_next_attempt_at = now()` on the matching legacy rows so
 * they are explicitly due (and ordered correctly by COALESCE in the
 * claim ORDER BY).
 *
 * Run:
 *   tsx scripts/init-stuck-call-archive-rows.ts            # dry-run
 *   tsx scripts/init-stuck-call-archive-rows.ts --apply    # write
 *
 * Idempotent: only matches rows that still have all three legacy
 * markers (status='pending', attempts=0, next_attempt_at IS NULL).
 * Re-running after a successful claim is a no-op.
 */
import { sql } from "drizzle-orm";
import { db } from "../server/db";

async function main() {
  const apply = process.argv.includes("--apply");

  interface StuckRow {
    id: string;
    twilio_sid: string | null;
    archive_status: string | null;
    archive_attempts: number | null;
    archive_next_attempt_at: Date | null;
    recording_status: string | null;
    has_recording_url: boolean;
    created_at: Date;
  }

  const preview = await db.execute(sql`
    SELECT id, twilio_sid, archive_status, archive_attempts,
           archive_next_attempt_at, recording_status,
           recording_url IS NOT NULL AS has_recording_url,
           created_at
    FROM twilio_calls
    WHERE archive_status = 'pending'
      AND COALESCE(archive_attempts, 0) = 0
      AND archive_next_attempt_at IS NULL
    ORDER BY created_at ASC
  `);

  const rows = (preview.rows || []) as unknown as StuckRow[];
  console.log(`Matched ${rows.length} stuck row(s):`);
  for (const r of rows) {
    console.log(
      `  id=${r.id} twilio_sid=${r.twilio_sid} created_at=${r.created_at} ` +
      `recording_status=${r.recording_status ?? "null"} has_recording_url=${r.has_recording_url}`,
    );
  }

  if (!apply) {
    console.log("\nDry-run only. Re-run with --apply to write archive_next_attempt_at = now().");
    process.exit(0);
  }

  if (rows.length === 0) {
    console.log("\nNothing to update.");
    process.exit(0);
  }

  const result = await db.execute(sql`
    UPDATE twilio_calls
    SET archive_next_attempt_at = NOW(),
        updated_at = NOW()
    WHERE archive_status = 'pending'
      AND COALESCE(archive_attempts, 0) = 0
      AND archive_next_attempt_at IS NULL
  `);
  console.log(`\nUpdated ${result.rowCount ?? 0} row(s). The call-archive scheduler should pick them up on the next tick (≤30s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error("init-stuck-call-archive-rows failed:", err);
  process.exit(1);
});
