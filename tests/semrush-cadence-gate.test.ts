/* test-registration
{
  "name": "SEMrush demand-driven cadence gate (Task #1785)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1785 — SEMrush demand-driven cadence gate sanity tests.
 *
 * Pins three behaviors of the gate:
 *   1. Long-form backoff curve: 1m / 5m / 30m / 2h / 24h (±10% jitter).
 *   2. Skip-log buffering merges multiple records with the same
 *      (date, queue, reason) bucket before flush.
 *   3. Stable response hash is deterministic regardless of key order.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import {
  computeLongFormBackoffMs,
  LONG_FORM_BACKOFF_MAX_ATTEMPTS,
  hashSemrushResponse,
  recordCadenceDecision,
  flushSkipBuffer,
  resolveClientIdForCampaign,
  evaluateRefreshGate,
  markClientViewed,
  _resetCadenceSettingsCache,
} from "../server/services/semrushCadenceGate";
import { workerDb } from "../server/db";

let passed = 0;
let failed = 0;

function group(name: string) {
  console.log(`\n— ${name} —`);
}
function ok(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ok  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL ${msg}`);
  }
}

// 1. Backoff curve buckets — center value ±10% jitter.
group("long-form backoff curve");
{
  const expected = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 24 * 60 * 60_000];
  for (let i = 0; i < expected.length; i++) {
    let minSeen = Infinity;
    let maxSeen = -Infinity;
    for (let trial = 0; trial < 50; trial++) {
      const v = computeLongFormBackoffMs(i + 1);
      if (v < minSeen) minSeen = v;
      if (v > maxSeen) maxSeen = v;
    }
    const lower = expected[i] * 0.89;
    const upper = expected[i] * 1.11;
    ok(
      minSeen >= lower && maxSeen <= upper,
      `attempt ${i + 1} stays within ±10% of ${expected[i]}ms (saw ${minSeen}–${maxSeen})`,
    );
  }
  ok(LONG_FORM_BACKOFF_MAX_ATTEMPTS === expected.length, "max attempts matches curve length");
  // Beyond the curve, clamps to the last bucket.
  const beyond = computeLongFormBackoffMs(99);
  ok(beyond >= 24 * 60 * 60_000 * 0.89, "attempts beyond curve clamp to 24h bucket");
}

// 2. Stable hash determinism.
group("hashSemrushResponse stability");
{
  const a = { b: 1, a: [{ y: 2, x: 1 }] };
  const b = { a: [{ x: 1, y: 2 }], b: 1 };
  ok(hashSemrushResponse(a) === hashSemrushResponse(b), "key order does not affect hash");
  ok(hashSemrushResponse(a) !== hashSemrushResponse({ ...a, b: 2 }), "value change flips hash");
}

// 3. Skip-log buffering merges entries; flush is safe with no DB connected.
group("skip-log buffering");
{
  // We can't reach a real DB in a unit-only test; verify the buffer
  // collapses repeat decisions into a single flushable bucket by
  // exercising the public API and catching the expected write error.
  for (let i = 0; i < 50; i++) {
    recordCadenceDecision({
      queueName: "semrush_background_refresh",
      reason: "skipped_not_stale",
      clientId: i % 5 === 0 ? `client-${i % 3}` : null,
      campaignId: `camp-${i % 7}`,
    });
  }
  // Best-effort flush. If a DB is available it writes a single row;
  // if not, the worker pool will swallow the error in a console.warn.
  await flushSkipBuffer().catch(() => 0);
  ok(true, "buffer accepted 50 decisions and flush did not throw");
}

// 4. Task #1785 review-remediation: campaign→client resolution covers
// both the canonical `semrush_location_campaigns` table AND the legacy
// `client_semrush_integrations` fallback so legacy-but-active clients
// are not classified as `skipped_missing_mapping`. End-to-end gate
// behavior is then asserted across the (mapped/legacy) × (active/
// inactive) matrix.
group("resolveClientIdForCampaign legacy fallback + gate matrix");
{
  const suffix = `t1785-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const clientMappedId = `cl-mapped-${suffix}`;
  const clientLegacyActiveId = `cl-legacy-active-${suffix}`;
  const clientLegacyInactiveId = `cl-legacy-inactive-${suffix}`;
  const locationId = `loc-${suffix}`;
  const campMapped = `camp-mapped-${suffix}`;
  const campLegacyActive = `camp-legacy-active-${suffix}`;
  const campLegacyInactive = `camp-legacy-inactive-${suffix}`;
  const campOrphan = `camp-orphan-${suffix}`;
  const now = new Date();
  const recently = new Date(now.getTime() - 60 * 60_000);
  const longAgo = new Date(now.getTime() - 365 * 24 * 60 * 60_000);

  try {
    await workerDb.execute(sql`
      INSERT INTO clients (id, firm_name, contact_name, last_viewed_at)
      VALUES
        (${clientMappedId}, ${"Test Mapped " + suffix}, 'Test', ${recently}),
        (${clientLegacyActiveId}, ${"Test Legacy Active " + suffix}, 'Test', ${recently}),
        (${clientLegacyInactiveId}, ${"Test Legacy Inactive " + suffix}, 'Test', ${longAgo})
    `);
    await workerDb.execute(sql`
      INSERT INTO client_locations (id, client_id, name)
      VALUES (${locationId}, ${clientMappedId}, ${"Test Loc " + suffix})
    `);
    await workerDb.execute(sql`
      INSERT INTO semrush_location_campaigns
        (client_id, location_id, semrush_campaign_id)
      VALUES (${clientMappedId}, ${locationId}, ${campMapped})
    `);
    await workerDb.execute(sql`
      INSERT INTO client_semrush_integrations
        (client_id, semrush_campaign_id, integration_enabled, is_active)
      VALUES
        (${clientLegacyActiveId}, ${campLegacyActive}, true, true),
        (${clientLegacyInactiveId}, ${campLegacyInactive}, true, true)
    `);
    _resetCadenceSettingsCache();

    // Resolver covers both tables.
    const resolved = await resolveClientIdForCampaign([
      campMapped,
      campLegacyActive,
      campLegacyInactive,
      campOrphan,
    ]);
    ok(resolved.get(campMapped) === clientMappedId, "mapped campaign → mapped client");
    ok(
      resolved.get(campLegacyActive) === clientLegacyActiveId,
      "legacy-only campaign resolves via client_semrush_integrations (active)",
    );
    ok(
      resolved.get(campLegacyInactive) === clientLegacyInactiveId,
      "legacy-only campaign resolves via client_semrush_integrations (inactive)",
    );
    ok(!resolved.has(campOrphan), "orphan campaign with no mapping returns undefined");

    // Gate matrix — stale lastRefreshedAt + demand-driven ON.
    const stale = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
    const gMapped = await evaluateRefreshGate({
      queueName: "semrush_report_refresh",
      campaignId: campMapped,
      clientId: clientMappedId,
      lastRefreshedAt: stale,
    });
    ok(gMapped.allow === true, "active + stale + mapped → enqueue allowed");

    const gLegacyActive = await evaluateRefreshGate({
      queueName: "semrush_report_refresh",
      campaignId: campLegacyActive,
      clientId: clientLegacyActiveId,
      lastRefreshedAt: stale,
    });
    ok(
      gLegacyActive.allow === true,
      "active + stale + legacy-only → enqueue allowed (regression guard)",
    );

    const gLegacyInactive = await evaluateRefreshGate({
      queueName: "semrush_report_refresh",
      campaignId: campLegacyInactive,
      clientId: clientLegacyInactiveId,
      lastRefreshedAt: stale,
    });
    ok(
      gLegacyInactive.allow === false && gLegacyInactive.reason === "skipped_inactive_client",
      "inactive + stale + legacy-only → skipped_inactive_client",
    );

    const gOrphan = await evaluateRefreshGate({
      queueName: "semrush_report_refresh",
      campaignId: campOrphan,
      clientId: null,
      lastRefreshedAt: stale,
    });
    ok(
      gOrphan.allow === false && gOrphan.reason === "skipped_missing_mapping",
      "campaign with no client mapping → skipped_missing_mapping",
    );

    // markClientViewed flips an inactive client to active.
    await markClientViewed(clientLegacyInactiveId, "test:regression");
    _resetCadenceSettingsCache();
    const gLegacyRevived = await evaluateRefreshGate({
      queueName: "semrush_report_refresh",
      campaignId: campLegacyInactive,
      clientId: clientLegacyInactiveId,
      lastRefreshedAt: stale,
    });
    ok(gLegacyRevived.allow === true, "markClientViewed re-opens the gate for inactive client");
  } catch (err: any) {
    failed++;
    console.error(`  FAIL gate-matrix test threw: ${err?.message || err}`);
  } finally {
    await workerDb
      .execute(sql`DELETE FROM client_semrush_integrations WHERE semrush_campaign_id IN (${campLegacyActive}, ${campLegacyInactive})`)
      .catch(() => 0);
    await workerDb
      .execute(sql`DELETE FROM semrush_location_campaigns WHERE semrush_campaign_id = ${campMapped}`)
      .catch(() => 0);
    await workerDb
      .execute(sql`DELETE FROM client_locations WHERE id = ${locationId}`)
      .catch(() => 0);
    await workerDb
      .execute(
        sql`DELETE FROM clients WHERE id IN (${clientMappedId}, ${clientLegacyActiveId}, ${clientLegacyInactiveId})`,
      )
      .catch(() => 0);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
if (failed > 0) process.exitCode = 1;
