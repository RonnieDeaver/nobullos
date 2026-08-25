/* test-registration
{
  "name": "Measured monthly-leads series + completed-month seed action (Task #4766)",
  "regression": true,
  "sweepOnlyReason": "DB-backed coverage (fixture clients + snapshot rows + a prod-action press against the hermetic per-run DB) — the pure decision rules it feeds are gated in the smoke suite via tests/judgment-measured-stability-fallback.test.ts; keeping this out of the routine TEST_SMOKE wall trades gate seconds for no loss of smoke coverage.",
  "timeoutMs": 120000,
  "tier": "small"
}
test-registration */
/**
 * Task #4766 — DB coverage for the measured-stability data path:
 *
 *   1. `getMeasuredMonthlyLeadsSeries` — latest POST-CLOSE snapshot per
 *      completed period wins; pre-close (mid-month) snapshots are ignored;
 *      only ok-status `perf_total_leads` values surface; judgment-month
 *      and later periods excluded; newest first.
 *   2. `listActiveClientIdsMissingFinalSnapshot` — a post-close snapshot
 *      (even not-configured) counts as final; an error snapshot does NOT
 *      (failed pulls stay pending for retry); archived clients excluded.
 *   3. `seed_live_data_completed_months` prod action — registered with a
 *      converging contract, status reports pending while any client-month
 *      lacks a final snapshot, apply writes explainable dispositions
 *      (BQ unconfigured → not-configured snapshots, never fabricated
 *      numbers), and a second press converges toward not-needed for the
 *      seeded client.
 *
 * Hermetic per-run test DB; fixture clients are archived in cleanup so
 * the action's full-universe status can't be poisoned for later suites.
 */

// Force the BigQuery-unconfigured path regardless of the host env, so the
// action's dispositions are deterministic (not-configured, no network).
delete process.env.BIGQUERY_SERVICE_ACCOUNT_JSON;

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { db, closeDbPools } from "../server/db";
import {
  getMeasuredMonthlyLeadsSeries,
  listActiveClientIdsMissingFinalSnapshot,
  MEASURED_LEADS_METRIC_KEY,
} from "../server/storage/liveDataStorage";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";

const TAG = `t4766-${Date.now().toString(36)}`;
const CLIENT_A = `${TAG}-a`; // has snapshots
const CLIENT_B = `${TAG}-b`; // active, no snapshots (seed target)
const CLIENT_ARCHIVED = `${TAG}-arch`;

const JUDGMENT_DATE = "2026-08-14";

function metricJson(value: number | null, status: string) {
  return JSON.stringify([
    {
      key: MEASURED_LEADS_METRIC_KEY,
      label: "Total leads",
      value,
      unitLabel: null,
      status,
      reason: status === "ok" ? null : "test",
    },
  ]);
}

async function seed(): Promise<void> {
  for (const [id, archived] of [
    [CLIENT_A, false],
    [CLIENT_B, false],
    [CLIENT_ARCHIVED, true],
  ] as const) {
    await db.execute(sql`
      INSERT INTO clients (id, firm_name, is_archived, is_demo, lifecycle_stage)
      VALUES (${id}, ${id}, ${archived}, false, 'customer')
      ON CONFLICT (id) DO UPDATE SET is_archived = ${archived}, is_demo = false, lifecycle_stage = 'customer'
    `);
  }

  const rows: Array<[string, string, string, number | null, string, string]> = [
    // [period, fetchedAt, overallStatus, leads, metricStatus]
    // 2026-07: older post-close ok(5), NEWER post-close ok(9) → 9 wins.
    ["2026-07", "2026-08-02T00:00:00Z", "ok", 5, "ok", CLIENT_A],
    ["2026-07", "2026-08-03T00:00:00Z", "ok", 9, "ok", CLIENT_A],
    // 2026-06: only a PRE-close (mid-month) snapshot → excluded entirely.
    ["2026-06", "2026-06-15T00:00:00Z", "ok", 3, "ok", CLIENT_A],
    // 2026-05: post-close but metric errored → omitted (no fabricated zero).
    ["2026-05", "2026-06-02T00:00:00Z", "partial", null, "error", CLIENT_A],
    // 2026-04: post-close ok(7).
    ["2026-04", "2026-05-02T00:00:00Z", "ok", 7, "ok", CLIENT_A],
    // Judgment month itself — must never surface.
    // future-date-literal-reviewed: 2026-09-01 is only compared against the
    // pinned JUDGMENT_DATE literal ("2026-08-14") by pure period math —
    // literal-vs-literal, no wall-clock read, so it cannot rot.
    ["2026-08", "2026-09-01T00:00:00Z", "ok", 99, "ok", CLIENT_A],
  ];
  for (const [period, fetchedAt, overall, leads, mStatus, clientId] of rows) {
    await db.execute(sql`
      INSERT INTO live_data_snapshots (client_id, period, fetched_at, overall_status, metrics)
      VALUES (${clientId}, ${period}, ${fetchedAt}::timestamptz, ${overall}, ${metricJson(leads, mStatus)}::jsonb)
    `);
  }
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM live_data_snapshots WHERE client_id LIKE ${TAG + "%"}`);
  // Archive fixtures instead of deleting first, then delete (belt+braces
  // against FK'd residue): archived rows drop out of every active filter.
  await db.execute(sql`UPDATE clients SET is_archived = true WHERE id LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE id LIKE ${TAG + "%"}`);
}

async function run(): Promise<void> {
  await cleanup().catch(() => {});
  await seed();
  try {
    // ── 1. getMeasuredMonthlyLeadsSeries ─────────────────────────────
    const series = await getMeasuredMonthlyLeadsSeries(CLIENT_A, JUDGMENT_DATE);
    assert.deepEqual(
      series.map((r) => [r.month, r.leads]),
      [
        ["2026-07", 9], // latest post-close wins over the older 5
        ["2026-04", 7], // 2026-06 pre-close and 2026-05 errored are omitted
      ],
      "series: post-close, ok-only, latest-per-period, judgment month excluded",
    );

    // ── 2. listActiveClientIdsMissingFinalSnapshot ──────────────────
    let missing = await listActiveClientIdsMissingFinalSnapshot("2026-07");
    assert.ok(!missing.includes(CLIENT_A), "A has a final 2026-07 snapshot");
    assert.ok(missing.includes(CLIENT_B), "B is missing 2026-07");
    assert.ok(!missing.includes(CLIENT_ARCHIVED), "archived client never listed");

    // An all-error post-close snapshot does NOT count as final (retryable).
    await db.execute(sql`
      INSERT INTO live_data_snapshots (client_id, period, fetched_at, overall_status, metrics)
      VALUES (${CLIENT_B}, '2026-07', '2026-08-02T00:00:00Z'::timestamptz, 'error', '[]'::jsonb)
    `);
    missing = await listActiveClientIdsMissingFinalSnapshot("2026-07");
    assert.ok(missing.includes(CLIENT_B), "error snapshot leaves B pending");

    // A not-configured post-close snapshot DOES count (explainable disposition).
    await db.execute(sql`
      INSERT INTO live_data_snapshots (client_id, period, fetched_at, overall_status, metrics)
      VALUES (${CLIENT_B}, '2026-07', '2026-08-02T01:00:00Z'::timestamptz, 'not-configured', '[]'::jsonb)
    `);
    missing = await listActiveClientIdsMissingFinalSnapshot("2026-07");
    assert.ok(!missing.includes(CLIENT_B), "not-configured post-close snapshot is final");
    await db.execute(sql`
      DELETE FROM live_data_snapshots WHERE client_id = ${CLIENT_B}
    `);

    // ── 3. seed prod action ──────────────────────────────────────────
    const action = PROD_ACTIONS.find((a) => a.id === "seed_live_data_completed_months");
    assert.ok(action, "seed action must be registered");
    assert.equal(action!.convergence.kind, "converging", "declared converging");
    assert.ok(action!.humanGate?.reason, "human-gated (BigQuery spend)");

    const status = await action!.status();
    assert.equal(status.state, "pending", "B's missing months make status pending");

    // One press starts the background drain (Task #1969 one-and-done model);
    // the press returns immediately while the drain works the backlog.
    const applied = await action!.apply("test" as any);
    assert.equal(applied.state, "applied", "single press starts the drain");

    // Poll until the drain converges B for 2026-07 (BQ unconfigured →
    // explainable not-configured final snapshots, never fabricated numbers).
    const deadline = Date.now() + 60_000;
    let converged = false;
    while (Date.now() < deadline) {
      const missingNow = await listActiveClientIdsMissingFinalSnapshot("2026-07");
      if (!missingNow.includes(CLIENT_B)) {
        converged = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(converged, "background drain converged B for 2026-07");

    // Every drained snapshot must be an explainable disposition — with BQ
    // unconfigured, that is exactly 'not-configured'.
    const bRows = await db.execute(sql`
      SELECT DISTINCT overall_status FROM live_data_snapshots WHERE client_id = ${CLIENT_B}
    `);
    assert.deepEqual(
      (bRows.rows as any[]).map((r) => r.overall_status),
      ["not-configured"],
      "unconfigured BQ yields not-configured dispositions only",
    );

    // Eventual completion: the drain keeps chunking until the WHOLE recent
    // completed-month backlog is exhausted (not just one bounded batch).
    let allDone = false;
    const deadline2 = Date.now() + 60_000;
    while (Date.now() < deadline2) {
      const s = await action!.status();
      if (s.state === "not-needed") {
        allDone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(allDone, "drain exhausted every missing client-month (status not-needed)");
  } finally {
    await cleanup();
  }
}

run()
  .then(() => console.log("All completed-month seed tests passed"))
  .catch((err) => {
    console.error("FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPools().catch(() => {}));
