/* test-registration
{
  "name": "Call-archive kill switch + typed failure reason (workers parity E-F05/E-F06)",
  "regression": true,
  "sweepOnlyReason": "DB-heavy focused worker-reliability suite exercising the archive pipeline's real claim/failure path; runs in the full suite and the nightly --regression sweep rather than the routine TEST_SMOKE gate.",
  "tier": "small"
}
test-registration */
/**
 * Workers/queues parity (E-F05/E-F06) — focused suite for the two
 * controls added to the call-archive pipeline (whose lease/heartbeat/
 * watcher already existed and are deliberately untouched):
 *
 *  - operator kill switch: ON blocks new claims (queued rows untouched,
 *    no attempts burned); OFF lets the pipeline claim again;
 *  - typed failure reason: classifyArchiveFailure mapping (known classes
 *    + unknown fallback + no-secret persistence), the real
 *    processNextBatch failure path stamping archive_failure_reason
 *    alongside the free-text archive_last_error, and enqueueCallArchive
 *    clearing the stale reason on re-enqueue.
 *
 * The real-path case relies on Twilio being unconfigured in the test
 * environment: the claimed row fails fast in the download step with a
 * config-class error — no network, no vendor calls.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import { storage } from "../server/storage";
import {
  processNextBatch,
  enqueueCallArchive,
  classifyArchiveFailure,
} from "../server/services/callArchivePipeline";
import { setKillSwitch } from "../server/services/killSwitches";

const MARKER = `t_arch_ks_${process.pid}_${Date.now()}`;
const FROM = `+1557${String(process.pid).slice(-4).padStart(4, "0")}`;

interface CallRow {
  id: string;
  archive_status: string | null;
  archive_attempts: number | null;
  archive_last_error: string | null;
  archive_failure_reason: string | null;
  archive_next_attempt_at: Date | null;
  archive_locked_until: Date | null;
}

async function insertQueuedCall(): Promise<string> {
  const tag = `${MARKER}_${Math.random().toString(36).slice(2)}`;
  const r = await workerDb.execute(sql`
    INSERT INTO twilio_calls
      (direction, from_number, to_number, status, twilio_sid, recording_sid,
       archive_status, archive_attempts, archive_next_attempt_at, created_at, updated_at)
    VALUES
      ('inbound', ${FROM}, '+15550000000', 'completed', ${tag}, ${`RE_${tag}`},
       'queued', 0, NOW() - interval '1 minute', NOW() - interval '1 hour', NOW())
    RETURNING id
  `);
  return String((r.rows?.[0] as any)?.id);
}

async function getRow(id: string): Promise<CallRow> {
  const r = await workerDb.execute(sql`
    SELECT id, archive_status, archive_attempts, archive_last_error,
           archive_failure_reason, archive_next_attempt_at, archive_locked_until
    FROM twilio_calls WHERE id = ${id}
  `);
  const row = r.rows?.[0] as unknown as CallRow | undefined;
  assert.ok(row, `twilio_calls row ${id} should exist`);
  return row;
}

async function cleanup(): Promise<void> {
  await workerDb.execute(sql`DELETE FROM twilio_calls WHERE from_number = ${FROM}`);
  try { await storage.deleteSystemSetting("kill_switch_call_archive"); } catch {}
}

async function main(): Promise<void> {
  await cleanup();
  try {
    // ------------------------------------------------------------------
    // 1. classifyArchiveFailure: known classes map correctly; unknown
    //    falls back; AbortError counts as timeout.
    // ------------------------------------------------------------------
    {
      assert.equal(classifyArchiveFailure(new Error("Twilio not configured")), "config_missing");
      assert.equal(classifyArchiveFailure(new Error("Recording fetch from api.twilio.com failed: 404")), "twilio_fetch_failed");
      assert.equal(classifyArchiveFailure(new Error("Object storage upload failed: bucket unavailable")), "object_storage_failed");
      assert.equal(classifyArchiveFailure(new Error("Whisper transcription error")), "transcription_failed");
      // Task #4084: the Drive mirror is retired — folder-flavored failures now
      // classify into the in-app client-files bucket ("drive_failed" is legacy-only).
      assert.equal(classifyArchiveFailure(new Error("Drive folder resolution failed")), "client_files_failed");
      assert.equal(classifyArchiveFailure(new Error("Connection terminated unexpectedly")), "db_error");
      const abortErr: any = new Error("operation was interrupted");
      abortErr.name = "AbortError";
      assert.equal(classifyArchiveFailure(abortErr), "timeout");
      assert.equal(classifyArchiveFailure(new Error("some totally novel condition")), "unknown");
      assert.equal(classifyArchiveFailure(null), "unknown");
      console.log("PASS: classifyArchiveFailure mapping + unknown fallback");
    }

    // ------------------------------------------------------------------
    // 2. Kill switch ON: no claims, queued row untouched, no attempt
    //    burned; OFF: the batch claims and processes the row.
    // ------------------------------------------------------------------
    const id = await insertQueuedCall();
    await setKillSwitch("call_archive", true, "test");
    try {
      const res = await processNextBatch(3);
      assert.deepEqual(res, { processed: 0, errors: 0 }, "batch is a no-op while the switch is on");
      const row = await getRow(id);
      assert.equal(row.archive_status, "queued", "queued row untouched during operator stop");
      assert.equal(Number(row.archive_attempts ?? 0), 0, "no attempt burned");
      assert.equal(row.archive_locked_until, null, "no lease taken");
    } finally {
      await setKillSwitch("call_archive", false, "test");
    }
    console.log("PASS: kill switch blocks claims and leaves rows recoverable");

    // ------------------------------------------------------------------
    // 3. Switch OFF: real claim -> real failure path (Twilio unconfigured
    //    in the test env) -> typed archive_failure_reason persisted
    //    alongside the free-text error; retry state intact (business
    //    behavior unchanged: attempts bumped once, backoff scheduled,
    //    row requeued, lease released).
    // ------------------------------------------------------------------
    {
      const res = await processNextBatch(1);
      assert.equal(res.processed + res.errors, 1, "batch claimed exactly our row");
      const row = await getRow(id);
      assert.equal(row.archive_status, "queued", "config-class failure requeues under the retry cap");
      assert.equal(Number(row.archive_attempts), 1, "claim bumped the attempts epoch once");
      assert.ok(row.archive_last_error, "free-text human detail persisted");
      assert.ok(row.archive_failure_reason, "typed machine-readable reason persisted");
      assert.ok(
        ["config_missing", "twilio_fetch_failed", "timeout", "unknown"].includes(String(row.archive_failure_reason)),
        `reason ${row.archive_failure_reason} should be a valid ArchiveFailureReason for an unconfigured-Twilio failure`,
      );
      assert.equal(row.archive_locked_until, null, "failure released the lease");
      assert.ok(row.archive_next_attempt_at, "backoff scheduled for retry");
      // No secrets in persisted failure detail: the error text must not
      // embed credential-looking material (Twilio SIDs of the form
      // AC/SK + 32 hex chars, or Bearer tokens).
      const text = String(row.archive_last_error);
      assert.ok(!/Bearer\s+[A-Za-z0-9._-]{16,}/i.test(text), "no bearer tokens in archive_last_error");
      assert.ok(!/\b(AC|SK)[0-9a-f]{32}\b/i.test(text), "no Twilio credential SIDs in archive_last_error");
      console.log(`PASS: real failure path persisted typed reason=${row.archive_failure_reason}`);
    }

    // ------------------------------------------------------------------
    // 4. enqueueCallArchive clears the stale typed reason (and error) on
    //    re-enqueue so a later success never carries leftover failure
    //    state. (Success path itself also nulls the reason — asserted in
    //    the done-write shape, covered by existing archive suites.)
    // ------------------------------------------------------------------
    {
      // Drive the row terminal-failed first so enqueue's guard applies.
      await workerDb.execute(sql`
        UPDATE twilio_calls
        SET archive_status = 'failed', archive_failure_reason = 'twilio_fetch_failed',
            archive_last_error = 'seeded terminal failure'
        WHERE id = ${id}
      `);
      await enqueueCallArchive(id);
      const row = await getRow(id);
      assert.equal(row.archive_status, "queued");
      assert.equal(Number(row.archive_attempts), 0, "re-enqueue resets the attempt budget");
      assert.equal(row.archive_last_error, null, "free-text error cleared");
      assert.equal(row.archive_failure_reason, null, "typed reason cleared");
      console.log("PASS: enqueueCallArchive clears stale failure state");
    }

    console.log("ALL call-archive kill-switch/failure-reason tests passed");
  } finally {
    await cleanup();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("FAIL:", err);
    process.exit(1);
  },
);
