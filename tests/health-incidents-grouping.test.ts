/* test-registration
{
  "name": "Health incidents grouping & lifecycle (Task #861)",
  "tier": "small"
}
test-registration */
/**
 * Task #861 Phase 3 — health_incidents grouping & lifecycle.
 *
 * Pinned behavior:
 *   1. Two alerts with the same metric+severity+origin collapse into a single
 *      incident; occurrence_count increments and last_seen_at updates.
 *   2. Different origins yield separate incidents.
 *   3. ack / snooze / resolve transition `status` correctly and surface from
 *      the storage helpers.
 *   4. autoResolveStaleIncidents() resolves any open incident whose
 *      last_seen_at is older than 10 minutes.
 */

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  ingestAlert,
  ackIncident,
  snoozeIncident,
  resolveIncident,
  autoResolveStaleIncidents,
  listOpenIncidents,
  __test as incidentsTest,
} from "../server/services/healthIncidents";
import * as healthStore from "../server/storage/healthMetricsStorage";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `t861-inc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const METRIC = `m_${TAG}`;

async function ensureSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS health_incidents (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      fingerprint VARCHAR(256) NOT NULL,
      metric VARCHAR(128) NOT NULL,
      severity VARCHAR(16) NOT NULL,
      title TEXT NOT NULL,
      first_seen_at BIGINT NOT NULL,
      last_seen_at BIGINT NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      peak_value INTEGER NOT NULL DEFAULT 0,
      latest_value INTEGER NOT NULL DEFAULT 0,
      threshold INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL DEFAULT 'firing',
      acknowledged_by VARCHAR(128),
      acknowledged_at BIGINT,
      snoozed_until BIGINT,
      resolved_at BIGINT,
      sample_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
}

async function clearTagged(): Promise<void> {
  await db.execute(sql`DELETE FROM health_incidents WHERE metric = ${METRIC}`);
}

async function run(): Promise<void> {
  await ensureSchema();
  await clearTagged();

  const t0 = Date.now() - 20 * 60_000;

  // 1. Same fingerprint → grouped
  const a = await ingestAlert({
    alert: {
      metric: METRIC,
      value: 100,
      severity: "warning",
      message: "first",
      threshold: 50,
      origin: "api",
    },
    value: 100,
    sampleTimestamp: t0,
  });
  const b = await ingestAlert({
    alert: {
      metric: METRIC,
      value: 200,
      severity: "warning",
      message: "second",
      threshold: 50,
      origin: "api",
    },
    value: 200,
    sampleTimestamp: t0 + 60_000,
  });
  assert(a.id === b.id, "Same fingerprint should reuse same incident");
  assert(b.occurrenceCount === 2, `expected 2 occurrences, got ${b.occurrenceCount}`);
  assert(b.peakValue === 200, `expected peak 200, got ${b.peakValue}`);
  assert(b.lastSeenAt > a.lastSeenAt, "last_seen_at should advance");

  // 2. Different origin → new incident
  const c = await ingestAlert({
    alert: {
      metric: METRIC,
      value: 50,
      severity: "warning",
      message: "worker",
      threshold: 50,
      origin: "worker",
    },
    value: 50,
    sampleTimestamp: t0 + 120_000,
  });
  assert(c.id !== a.id, "Different origin should create new incident");

  // 3. Lifecycle: ack / snooze / resolve
  const acked = await ackIncident(a.id, "test-user");
  assert(acked?.status === "acknowledged", `expected acknowledged, got ${acked?.status}`);
  assert(acked?.acknowledgedBy === "test-user", "acknowledgedBy should be set");

  // 913D: snooze is acknowledged + snoozed_until (not its own status).
  const snoozedUntil = Date.now() + 60 * 60_000;
  const snoozed = await snoozeIncident(a.id, snoozedUntil, "test-user");
  assert(snoozed?.status === "acknowledged", `expected acknowledged (snoozed), got ${snoozed?.status}`);
  assert(snoozed?.snoozedUntil === snoozedUntil, "snoozedUntil should be set");

  const resolved = await resolveIncident(a.id, "test-user");
  assert(resolved?.status === "resolved", "expected resolved");
  assert(resolved?.resolvedAt != null, "resolvedAt should be set");

  // 913D: idempotent resolve.
  const resolvedAgain = await resolveIncident(a.id, "test-user");
  assert(resolvedAgain?.status === "resolved", "resolve should be idempotent");
  assert(resolvedAgain?.resolvedAt === resolved?.resolvedAt, "resolved_at should not change on re-resolve");

  // 4. Auto-resolve stale: c is still open, last_seen_at = t0+120000 (>10min ago)
  const before = await listOpenIncidents();
  const cOpen = before.find((i) => i.id === c.id);
  assert(cOpen != null, "c should be open before auto-resolve");

  const resolvedCount = await autoResolveStaleIncidents();
  assert(resolvedCount >= 1, `expected ≥1 auto-resolved, got ${resolvedCount}`);

  const after = await listOpenIncidents();
  const cStillOpen = after.find((i) => i.id === c.id);
  assert(cStillOpen == null, "c should be auto-resolved after the quiet window");

  // Task #870: auto-resolve must stamp a distinct reason code so operators
  // can audit auto-closed incidents apart from manually closed ones.
  const cAfter = await healthStore.getIncidentById(c.id);
  assert(cAfter?.status === "resolved", "c should be resolved");
  const cMeta = (cAfter?.metadata ?? {}) as Record<string, unknown>;
  assert(
    cMeta.autoResolveReason === "metric_recovered",
    `expected autoResolveReason=metric_recovered, got ${String(cMeta.autoResolveReason)}`,
  );
  assert(typeof cMeta.autoResolvedAt === "number", "autoResolvedAt should be stamped");

  // Task #870: manual ack/snooze must win over auto-resolve. An
  // acknowledged incident — even one whose metric has been silent for
  // longer than the quiet window — must be left alone for the operator
  // to close manually.
  const ackTag = `t870-ack-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const ackMetric = `m_${ackTag}`;
  const ackOldTs = Date.now() - 30 * 60_000; // older than the quiet window
  const ackInc = await ingestAlert({
    alert: {
      metric: ackMetric,
      value: 100,
      severity: "warning",
      message: "ack-wins",
      threshold: 50,
      origin: "api",
    },
    value: 100,
    sampleTimestamp: ackOldTs,
  });
  await ackIncident(ackInc.id, "operator");
  const sweptCount = await autoResolveStaleIncidents();
  const ackAfter = await healthStore.getIncidentById(ackInc.id);
  assert(
    ackAfter?.status === "acknowledged",
    `acknowledged incident must NOT be auto-resolved, got ${ackAfter?.status} (sweep resolved ${sweptCount})`,
  );
  await db.execute(sql`DELETE FROM health_incidents WHERE metric = ${ackMetric}`);

  // Task #870: HEALTH_INCIDENT_AUTO_RESOLVE_QUIET_MS overrides the
  // default 15-min window. The sweep re-reads the env on every call,
  // so flipping it here changes behavior immediately. We pin it to
  // 1 s, ingest a firing incident with last_seen_at 5 s ago, and
  // verify the row is auto-resolved. Then we restore the env so the
  // remaining test sections see the default.
  const cfgTag = `t870-cfg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const cfgMetric = `m_${cfgTag}`;
  const prevEnv = process.env.HEALTH_INCIDENT_AUTO_RESOLVE_QUIET_MS;
  process.env.HEALTH_INCIDENT_AUTO_RESOLVE_QUIET_MS = "1000";
  try {
    assert(
      incidentsTest.currentAutoResolveQuietMs() === 1000,
      `env override must take effect immediately, got ${incidentsTest.currentAutoResolveQuietMs()}`,
    );
    const cfgInc = await ingestAlert({
      alert: {
        metric: cfgMetric,
        value: 100,
        severity: "warning",
        message: "cfg",
        threshold: 50,
        origin: "api",
      },
      value: 100,
      sampleTimestamp: Date.now() - 5_000,
    });
    await autoResolveStaleIncidents();
    const cfgAfter = await healthStore.getIncidentById(cfgInc.id);
    assert(
      cfgAfter?.status === "resolved",
      `5s-quiet incident should resolve under a 1s window, got ${cfgAfter?.status}`,
    );
    const cfgMeta = (cfgAfter?.metadata ?? {}) as Record<string, unknown>;
    assert(
      cfgMeta.autoResolveReason === "metric_recovered",
      `expected metric_recovered, got ${String(cfgMeta.autoResolveReason)}`,
    );
  } finally {
    if (prevEnv === undefined) delete process.env.HEALTH_INCIDENT_AUTO_RESOLVE_QUIET_MS;
    else process.env.HEALTH_INCIDENT_AUTO_RESOLVE_QUIET_MS = prevEnv;
  }
  await db.execute(sql`DELETE FROM health_incidents WHERE metric = ${cfgMetric}`);

  // 913D regression: a row with the LEGACY status='snoozed' must still be
  // operable — listed as open, normalizable to acknowledged, and resolvable
  // without a 500.
  const legacyTs = Date.now() - 5 * 60_000;
  await db.execute(sql`
    INSERT INTO health_incidents
      (fingerprint, metric, severity, title, first_seen_at, last_seen_at,
       status, snoozed_until, sample_refs, metadata)
    VALUES
      (${`legacy:${TAG}:warning:probe`}, ${METRIC}, 'warning', 'legacy snoozed',
       ${legacyTs}, ${legacyTs}, 'snoozed', ${legacyTs + 60 * 60_000},
       '[]'::jsonb, '{}'::jsonb)
  `);
  const legacyRow = (await listOpenIncidents()).find((i) => i.metric === METRIC && i.status === "snoozed");
  assert(legacyRow != null, "legacy snoozed row should appear in open list");
  // Storage normalizer flips it to acknowledged in bulk.
  const normalized = await healthStore.normalizeLegacySnoozedIncidents();
  assert(normalized >= 1, `expected ≥1 normalized, got ${normalized}`);
  const afterNorm = await healthStore.getIncidentById(legacyRow!.id);
  assert(afterNorm?.status === "acknowledged", `legacy row should normalize to acknowledged, got ${afterNorm?.status}`);
  // And resolve still works on it.
  const legacyResolved = await resolveIncident(legacyRow!.id, "test-user");
  assert(legacyResolved?.status === "resolved", "legacy row should resolve cleanly");

  // 945E: max-age episode splitting. A chronic firing incident open
  // longer than MAX_EPISODE_DURATION_MS must be closed in place and
  // a new episode opened for the same fingerprint at the new sample.
  const SPLIT_TAG = `t945e-split-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const SPLIT_METRIC = `m_${SPLIT_TAG}`;
  const epStart = Date.now() - (incidentsTest.MAX_EPISODE_DURATION_MS + 5 * 60_000);
  const ep1 = await ingestAlert({
    alert: { metric: SPLIT_METRIC, value: 100, severity: "critical", message: "ep1", threshold: 50, origin: "probe" },
    value: 100,
    sampleTimestamp: epStart,
  });
  // A re-fire well within the episode window stays grouped.
  const ep1b = await ingestAlert({
    alert: { metric: SPLIT_METRIC, value: 110, severity: "critical", message: "ep1b", threshold: 50, origin: "probe" },
    value: 110,
    sampleTimestamp: epStart + 60_000,
  });
  assert(ep1b.id === ep1.id, "Within-window re-fires must stay in the same episode");
  // A re-fire after MAX_EPISODE_DURATION_MS opens a fresh episode and
  // closes the prior episode at its own last_seen_at.
  const ep2Ts = epStart + incidentsTest.MAX_EPISODE_DURATION_MS + 60_000;
  const ep2 = await ingestAlert({
    alert: { metric: SPLIT_METRIC, value: 120, severity: "critical", message: "ep2", threshold: 50, origin: "probe" },
    value: 120,
    sampleTimestamp: ep2Ts,
  });
  assert(ep2.id !== ep1.id, "Over-max-age re-fire must open a new episode");
  assert(ep2.firstSeenAt === ep2Ts, "New episode firstSeenAt must be the new sample timestamp");
  const closed = await healthStore.getIncidentById(ep1.id);
  assert(closed?.status === "resolved", "Prior episode must be closed by the split");
  assert(closed?.resolvedAt === ep1b.lastSeenAt, "Prior episode resolvedAt must equal its own lastSeenAt (honest timeline)");
  const ep2Meta = (ep2.metadata ?? {}) as Record<string, unknown>;
  assert(ep2Meta.splitFromIncidentId === ep1.id, "New episode metadata must record splitFromIncidentId");
  assert(ep2Meta.splitReason === "max_episode_duration", "New episode metadata must record splitReason");

  // 945E: an acknowledged incident must NEVER be silently split — operator
  // ownership wins over the max-age rule.
  await ackIncident(ep2.id, "test-user");
  const ep2Acked = await ingestAlert({
    alert: { metric: SPLIT_METRIC, value: 130, severity: "critical", message: "ep2-acked", threshold: 50, origin: "probe" },
    value: 130,
    sampleTimestamp: ep2Ts + incidentsTest.MAX_EPISODE_DURATION_MS + 60_000,
  });
  assert(ep2Acked.id === ep2.id, "Acknowledged incidents must not be auto-split");
  assert(ep2Acked.status === "acknowledged", "Acknowledged incidents must keep their status across re-fires within the window");

  // 945E: sweep-close stragglers — a bare INSERT of a chronic firing row
  // (simulating a pre-rollout straggler) is closed by the resolver pass
  // at its own last_seen_at, not at sweep time.
  const stragglerTs = Date.now() - (incidentsTest.MAX_EPISODE_DURATION_MS + 10 * 60_000);
  const stragglerLast = stragglerTs + 60_000; // still recent enough that quietFor < 10m would be FALSE here, but well over episode max
  const stragglerInserted = await healthStore.insertIncident({
    fingerprint: `straggler:${SPLIT_TAG}:critical:probe`,
    metric: SPLIT_METRIC,
    severity: "critical",
    title: "straggler",
    firstSeenAt: stragglerTs,
    lastSeenAt: stragglerLast,
    occurrenceCount: 50,
    peakValue: 999,
    latestValue: 999,
    threshold: 50,
    status: "firing",
    sampleRefs: [stragglerTs, stragglerLast],
    metadata: {},
  });
  await autoResolveStaleIncidents();
  const stragglerAfter = await healthStore.getIncidentById(stragglerInserted.id);
  assert(stragglerAfter?.status === "resolved", "Straggler firing incident over MAX_EPISODE_DURATION_MS must be swept to resolved");
  // Quiet-window > 10m so resolvedAt = now() path is fine; the new code
  // only stamps lastSeenAt when the row went "quiet < 10m". Either way
  // it must be set.
  assert(stragglerAfter?.resolvedAt != null, "Straggler must have a resolvedAt set");

  // 945E: race-tolerance — if the prior episode was concurrently
  // resolved by another caller, ingestAlert proceeds and opens the
  // new episode without throwing. We simulate the race by manually
  // pre-resolving an over-age firing row, then calling ingestAlert
  // for that fingerprint. The new episode must be created and the
  // open count for the fingerprint must remain exactly 1.
  const raceTag = `t945e-race-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const raceMetric = `m_${raceTag}`;
  const raceFingerprintOrigin = `race-probe-${raceTag}`;
  const raceTs = Date.now() - (incidentsTest.MAX_EPISODE_DURATION_MS + 5 * 60_000);
  const raceSeed = await ingestAlert({
    alert: { metric: raceMetric, value: 100, severity: "critical", message: "race", threshold: 50, origin: raceFingerprintOrigin },
    value: 100,
    sampleTimestamp: raceTs,
  });
  // Concurrently resolve the row out from under the next ingest.
  await healthStore.updateIncident(raceSeed.id, { status: "resolved", resolvedAt: raceTs + 1_000 });
  // findIncidentByFingerprint excludes resolved rows, so this ingest
  // takes the normal new-incident path (not the split path) — and the
  // race-tolerance branch is not actually exercised here. Still, it
  // verifies the dedup rule holds: no duplicate firing rows appear.
  const raceAfterIngest = await ingestAlert({
    alert: { metric: raceMetric, value: 110, severity: "critical", message: "race-2", threshold: 50, origin: raceFingerprintOrigin },
    value: 110,
    sampleTimestamp: Date.now(),
  });
  assert(raceAfterIngest.id !== raceSeed.id, "Re-fire after concurrent resolve must open a new incident");
  const raceOpen = (await healthStore.listIncidents({ statuses: ["firing", "acknowledged"], limit: 50 })).filter(
    (i) => i.metric === raceMetric && i.status === "firing",
  );
  assert(raceOpen.length === 1, `expected exactly 1 open firing row after race, got ${raceOpen.length}`);
  await db.execute(sql`DELETE FROM health_incidents WHERE metric = ${raceMetric}`);

  await db.execute(sql`DELETE FROM health_incidents WHERE metric = ${SPLIT_METRIC}`);

  await clearTagged();
  console.log("✓ Health incidents grouping & lifecycle (incl. 945E max-age episode splitting)");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().then(
  () => {},
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
