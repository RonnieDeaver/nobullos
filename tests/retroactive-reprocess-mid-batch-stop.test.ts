/* test-registration
{
  "name": "Retroactive reprocess mid-batch kill-switch stop (workers parity E-F04)",
  "regression": true,
  "sweepOnlyReason": "DB-heavy focused suite for the shared re-evaluation routine's cooperative-stop seam; runs in the full suite and the nightly --regression sweep rather than the routine TEST_SMOKE gate.",
  "tier": "small"
}
test-registration */
/**
 * Workers/queues parity (E-F04) — focused suite for the mid-batch stop
 * seam in `reEvaluateUnmatchedForTargets` (the shared re-evaluation
 * routine the `retroactive_reprocess` queue handler calls):
 *
 *  - `shouldAbort` is checked at the true per-row batch boundary: an
 *    immediately-true stop yields aborted=true with ZERO rows visited
 *    (no writes — completed work elsewhere untouched, remaining rows
 *    left in their recoverable unmatched state);
 *  - a counter-based stop is consulted once per row and stops after the
 *    first row, preserving batch ordering (idempotent re-runs pick up
 *    the remainder);
 *  - the default path (no opts — the interactive attach-domain caller)
 *    is unchanged: no aborted flag, every enumerated row visited.
 *
 * Rows use a unique random domain so target enumeration only sees this
 * suite's fixtures; no client matches that domain, so visits leave rows
 * unmatched (business output unchanged) — the observable is the
 * shouldAbort consultation count plus the aborted flag.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import { reEvaluateUnmatchedForTargets } from "../server/services/frontIntegration";

const MARKER = `t_retro_${process.pid}_${Date.now()}`;
const DOMAIN = `${MARKER.replace(/_/g, "")}.example.com`.toLowerCase();

async function insertUnmatched(): Promise<string> {
  const conv = `${MARKER}_conv_${randomUUID().slice(0, 12)}`;
  const participants = JSON.stringify([
    { name: "Fixture Sender", email: `sender_${randomUUID().slice(0, 6)}@${DOMAIN}`, role: "from" },
  ]);
  const r = await workerDb.execute(sql`
    INSERT INTO front_sync_emails
      (conversation_id, subject, participants_json, match_status, pipeline_state, created_at)
    VALUES
      (${conv}, ${`${MARKER} subject`}, ${participants}::jsonb, 'unmatched', 'discovered', NOW())
    RETURNING id
  `);
  return String((r.rows?.[0] as any)?.id);
}

interface FseRow { id: string; match_status: string; match_reason: string | null }
async function getRows(): Promise<FseRow[]> {
  const r = await workerDb.execute(sql`
    SELECT id, match_status, match_reason FROM front_sync_emails
    WHERE conversation_id LIKE ${`${MARKER}%`} ORDER BY created_at
  `);
  return (r.rows ?? []) as unknown as FseRow[];
}

async function cleanup(): Promise<void> {
  await workerDb.execute(sql`DELETE FROM front_sync_emails WHERE conversation_id LIKE ${`${MARKER}%`}`);
}

async function main(): Promise<void> {
  await cleanup();
  try {
    const idA = await insertUnmatched();
    const idB = await insertUnmatched();
    const idC = await insertUnmatched();

    // ------------------------------------------------------------------
    // 1. Immediate stop: aborted=true, zero rows visited, zero writes.
    // ------------------------------------------------------------------
    {
      let checks = 0;
      const res = await reEvaluateUnmatchedForTargets(
        [{ domain: DOMAIN }],
        { shouldAbort: () => { checks += 1; return true; } },
      );
      assert.equal(res.aborted, true, "immediate stop reports aborted");
      assert.equal(res.total, 3, "enumeration still reports the batch size");
      assert.equal(res.matched, 0);
      assert.equal(res.filterRuleHandled, 0);
      assert.equal(checks, 1, "stop consulted exactly once (first row boundary)");
      const rows = await getRows();
      assert.equal(rows.length, 3);
      for (const row of rows) {
        assert.equal(row.match_status, "unmatched", "rows left in their recoverable state");
        assert.equal(row.match_reason, null, "no re-eval writes before the stop");
      }
      console.log("PASS: immediate mid-batch stop (zero visits, zero writes)");
    }

    // ------------------------------------------------------------------
    // 2. Stop after the first row: boundary granularity is per row.
    // ------------------------------------------------------------------
    {
      let checks = 0;
      const res = await reEvaluateUnmatchedForTargets(
        [{ domain: DOMAIN }],
        { shouldAbort: () => { checks += 1; return checks >= 2; } },
      );
      assert.equal(res.aborted, true);
      assert.equal(checks, 2, "consulted once per row boundary until the stop");
      // Exactly one row was visited; a visit may stamp match_reason but
      // never flips match_status without a client match (none exists for
      // this random domain).
      const rows = await getRows();
      const visited = rows.filter((r) => r.match_reason !== null);
      assert.ok(visited.length <= 1, `at most one row visited before the stop (got ${visited.length})`);
      for (const row of rows) {
        assert.equal(row.match_status, "unmatched", "business outcome unchanged for all rows");
      }
      console.log("PASS: per-row boundary stop after first item");
    }

    // ------------------------------------------------------------------
    // 3. Default path (interactive caller, no opts): unchanged behavior,
    //    all rows visited, no aborted flag.
    // ------------------------------------------------------------------
    {
      const res = await reEvaluateUnmatchedForTargets([{ domain: DOMAIN }]);
      assert.equal(res.total, 3, "all fixture rows enumerated");
      assert.ok(!res.aborted, "no aborted flag on the unstopped path");
      assert.equal(res.matched, 0, "no client matches this random domain — outcomes unchanged");
      const rows = await getRows();
      for (const row of rows) {
        assert.equal(row.match_status, "unmatched");
      }
      console.log("PASS: default path unchanged (no stop, no aborted flag)");
    }

    console.log("ALL retroactive-reprocess mid-batch stop tests passed");
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
