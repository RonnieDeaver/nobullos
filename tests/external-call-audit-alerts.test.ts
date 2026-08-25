/* test-registration
{
  "name": "External-call audit alert evaluator (Task #1731 Phase 4.4)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1731 (Pool epic Phase 4, spec 4.4) — external-call audit alert
 * evaluator tests.
 *
 * Seeds `external_call_audits`, `external_call_audit_daily_rollups`, and
 * `pool_state_samples` with synthetic rows that should trip each of the
 * five alert rules, then drives `evaluateExternalCallAlerts` and asserts
 * the right Slack signals were dispatched. The dispatcher is stubbed so
 * no Slack call is made.
 *
 * Each rule is exercised in its own scope with its own dataset to keep
 * the test deterministic and avoid cross-rule interference.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { workerDb, runWithWorkerDb, withDbAttribution } from "../server/db";
import { storage } from "../server/storage";
import {
  evaluateExternalCallAlerts,
  getActiveExternalCallAlerts,
  __testHelpers,
  SETTING_ENABLED,
  SETTING_SAME_RESPONSE_THRESHOLD,
  SETTING_SAME_RESPONSE_WINDOW_MIN,
  SETTING_MIN_CALLS_FOR_RATIO,
  SETTING_CACHE_HIT_DROP_PCT,
  SETTING_RPM_SPIKE_MULT,
  SETTING_DURATION_SPIKE_MULT,
  SETTING_SATURATION_PCT,
  SETTING_SATURATION_CORRELATION_PCT,
  SETTING_COOLDOWN_MINUTES,
} from "../server/services/externalCallAuditAlerts";

const SETTINGS_TO_CLEAN = [
  SETTING_ENABLED,
  SETTING_SAME_RESPONSE_THRESHOLD,
  SETTING_SAME_RESPONSE_WINDOW_MIN,
  SETTING_MIN_CALLS_FOR_RATIO,
  SETTING_CACHE_HIT_DROP_PCT,
  SETTING_RPM_SPIKE_MULT,
  SETTING_DURATION_SPIKE_MULT,
  SETTING_SATURATION_PCT,
  SETTING_SATURATION_CORRELATION_PCT,
  SETTING_COOLDOWN_MINUTES,
];

const TEST_INTEGRATION_TAG = "z-test-task-1731";

interface DispatchCall {
  id: string;
  metadata: Record<string, unknown>;
  text: string;
}

function installDispatcherStub(): DispatchCall[] {
  const calls: DispatchCall[] = [];
  __testHelpers.setDispatcherForTests(async (id, payload, opts) => {
    calls.push({
      id,
      metadata: (opts.metadata ?? {}) as Record<string, unknown>,
      text: payload.text,
    });
    return { delivered: true, status: "sent" };
  });
  return calls;
}

async function cleanFixtures(): Promise<void> {
  await runWithWorkerDb(() =>
    withDbAttribution("test:external-call-audit-alerts-cleanup", async () => {
      await workerDb.execute(
        sql`DELETE FROM external_call_audits WHERE integration LIKE ${TEST_INTEGRATION_TAG + "%"}`,
      );
      await workerDb.execute(
        sql`DELETE FROM external_call_audit_daily_rollups WHERE integration LIKE ${TEST_INTEGRATION_TAG + "%"}`,
      );
      await workerDb.execute(
        sql`DELETE FROM pool_state_samples WHERE sampled_at >= ${Date.now() - 24 * 60 * 60 * 1000} AND pool_name = 'api' AND utilization_pct >= 80 AND total_count = 99`,
      );
    }),
  );
  __testHelpers.resetState();
  for (const k of SETTINGS_TO_CLEAN) {
    try { await storage.deleteSystemSetting(k); } catch {}
  }
}

async function withConfig(values: Record<string, string>): Promise<void> {
  for (const [k, v] of Object.entries(values)) {
    await storage.setSystemSetting(k, v, "system");
  }
}

function utcDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function run(): Promise<void> {
  await cleanFixtures();
  __testHelpers.setKillSwitchForTests(() => true);

  const now = Date.now();

  // Defaults baseline: very low thresholds so each fixture trips its rule.
  await withConfig({
    [SETTING_ENABLED]: "true",
    [SETTING_SAME_RESPONSE_THRESHOLD]: "5",
    [SETTING_SAME_RESPONSE_WINDOW_MIN]: "60",
    [SETTING_MIN_CALLS_FOR_RATIO]: "10",
    [SETTING_CACHE_HIT_DROP_PCT]: "10",
    [SETTING_RPM_SPIKE_MULT]: "3",
    [SETTING_DURATION_SPIKE_MULT]: "3",
    [SETTING_SATURATION_PCT]: "80",
    [SETTING_SATURATION_CORRELATION_PCT]: "30",
    [SETTING_COOLDOWN_MINUTES]: "30",
  });

  // ── Rule 1: same-response storm ───────────────────────────────────
  {
    const calls = installDispatcherStub();
    const sameTag = `${TEST_INTEGRATION_TAG}-sr`;
    const dedupeKey = "dk-sr-1";
    // Seed 6 audits with same_response_as_previous=true in the last hour.
    const rowsSr = Array.from({ length: 6 }).map((_, i) => ({
      integration: sameTag,
      endpoint: "/api/test/same",
      method: "GET",
      called_at: now - i * 60_000,
      duration_ms: 100,
      status_code: 200,
      response_size_bytes: 100,
      response_cache_hit: false,
      same_response_as_previous: true,
      caller_label: "route:test",
      request_dedupe_key: dedupeKey,
      response_hash: "abc",
    }));
    await runWithWorkerDb(() =>
      withDbAttribution("test:seed-sr", async () => {
        for (const r of rowsSr) {
          await workerDb.execute(sql`
            INSERT INTO external_call_audits
              (integration, endpoint, method, called_at, duration_ms, status_code,
               response_size_bytes, response_cache_hit, same_response_as_previous,
               caller_label, request_dedupe_key, response_hash)
            VALUES (${r.integration}, ${r.endpoint}, ${r.method}, ${r.called_at},
                    ${r.duration_ms}, ${r.status_code}, ${r.response_size_bytes},
                    ${r.response_cache_hit}, ${r.same_response_as_previous},
                    ${r.caller_label}, ${r.request_dedupe_key}, ${r.response_hash})
          `);
        }
      }),
    );
    const result = await evaluateExternalCallAlerts(now);
    const srAlerts = result.alerts.filter(
      (a) => a.kind === "same_response_storm" && a.integration === sameTag,
    );
    assert.equal(srAlerts.length, 1, "must fire same-response storm");
    assert.ok(calls.some((c) => c.metadata.kind === "same_response_storm"));
    assert.equal(calls[0]!.id, "infra.usage.external_call_audit_alert");
  }

  // ── Rule 2: cache-hit drop WoW ────────────────────────────────────
  {
    __testHelpers.resetState();
    __testHelpers.setKillSwitchForTests(() => true);
    const calls = installDispatcherStub();
    const tag = `${TEST_INTEGRATION_TAG}-ch`;
    const today = utcDate(now);
    const eightDaysAgo = utcDate(now - 8 * 24 * 60 * 60_000);
    // Prev window: 100 calls, 80 cache hits (80% ratio)
    // Curr window: 100 calls, 10 cache hits (10% ratio) — Δ 70pp drop
    await runWithWorkerDb(() =>
      withDbAttribution("test:seed-ch", async () => {
        await workerDb.execute(sql`
          INSERT INTO external_call_audit_daily_rollups
            (date, integration, endpoint, caller_label, call_count, error_count,
             cache_hit_count, same_response_count, total_response_bytes)
          VALUES (${today}, ${tag}, '/api/test', '', 100, 0, 10, 0, 1000)
        `);
        await workerDb.execute(sql`
          INSERT INTO external_call_audit_daily_rollups
            (date, integration, endpoint, caller_label, call_count, error_count,
             cache_hit_count, same_response_count, total_response_bytes)
          VALUES (${eightDaysAgo}, ${tag}, '/api/test', '', 100, 0, 80, 0, 1000)
        `);
      }),
    );
    const result = await evaluateExternalCallAlerts(now);
    const chAlerts = result.alerts.filter(
      (a) => a.kind === "cache_hit_drop" && a.integration === tag,
    );
    assert.equal(chAlerts.length, 1, "must fire cache-hit drop");
    assert.ok((chAlerts[0]!.metric.dropPct as number) >= 10);
    assert.ok(calls.some((c) => c.metadata.kind === "cache_hit_drop"));
  }

  // ── Rule 3 & 4: rpm spike + duration spike ────────────────────────
  {
    __testHelpers.resetState();
    __testHelpers.setKillSwitchForTests(() => true);
    const calls = installDispatcherStub();
    const tag = `${TEST_INTEGRATION_TAG}-rpm`;
    // baseline7d in the evaluator includes the last hour too, so we
    // seed both: 60 current-hour calls at 3000ms, plus 600 older calls
    // (over the past 7d, OUTSIDE the last hour) at 100ms each.
    //   baseline calls = 660 → baseRpm ≈ 0.065/min
    //   baseline avg   = (60·3000 + 600·100)/660 ≈ 364ms
    //   current calls  = 60 → currRpm = 1/min  (≈15× baseline → trips)
    //   current avg    = 3000ms                (≈8.2× baseline → trips)
    await runWithWorkerDb(() =>
      withDbAttribution("test:seed-rpm", async () => {
        for (let i = 0; i < 60; i++) {
          await workerDb.execute(sql`
            INSERT INTO external_call_audits
              (integration, endpoint, method, called_at, duration_ms, status_code,
               response_size_bytes, response_cache_hit, same_response_as_previous,
               caller_label, request_dedupe_key, response_hash)
            VALUES (${tag}, '/api/test/spike', 'GET', ${now - i * 60_000}, 3000,
                    200, 100, false, false, 'route:test',
                    ${`dk-rpm-curr-${i}`}, ${`h-curr-${i}`})
          `);
        }
        // Older baseline rows: 2h..7d ago at 100ms each
        for (let i = 0; i < 600; i++) {
          const t = now - (2 * 60 + i * 16) * 60_000; // ≥ 2h ago, spread over week
          await workerDb.execute(sql`
            INSERT INTO external_call_audits
              (integration, endpoint, method, called_at, duration_ms, status_code,
               response_size_bytes, response_cache_hit, same_response_as_previous,
               caller_label, request_dedupe_key, response_hash)
            VALUES (${tag}, '/api/test/spike', 'GET', ${t}, 100,
                    200, 100, false, false, 'route:test',
                    ${`dk-rpm-base-${i}`}, ${`h-base-${i}`})
          `);
        }
      }),
    );
    const result = await evaluateExternalCallAlerts(now);
    const rpmAlerts = result.alerts.filter(
      (a) => a.kind === "rpm_spike" && a.integration === tag,
    );
    const durAlerts = result.alerts.filter(
      (a) => a.kind === "duration_spike" && a.integration === tag,
    );
    assert.equal(rpmAlerts.length, 1, "must fire rpm spike");
    assert.equal(durAlerts.length, 1, "must fire duration spike");
    assert.ok(calls.some((c) => c.metadata.kind === "rpm_spike"));
    assert.ok(calls.some((c) => c.metadata.kind === "duration_spike"));
  }

  // ── Rule 5: DB-saturation correlation ─────────────────────────────
  {
    __testHelpers.resetState();
    __testHelpers.setKillSwitchForTests(() => true);
    const calls = installDispatcherStub();
    const tag = `${TEST_INTEGRATION_TAG}-sat`;
    // Seed 10 distinct minute-buckets of external calls; saturate 6 of
    // those minutes on the api pool (utilization >= 80%).
    await runWithWorkerDb(() =>
      withDbAttribution("test:seed-sat", async () => {
        for (let i = 0; i < 10; i++) {
          const t = now - i * 60_000;
          await workerDb.execute(sql`
            INSERT INTO external_call_audits
              (integration, endpoint, method, called_at, duration_ms, status_code,
               response_size_bytes, response_cache_hit, same_response_as_previous,
               caller_label, request_dedupe_key, response_hash)
            VALUES (${tag}, '/api/test/sat', 'GET', ${t}, 50, 200, 100, false,
                    false, 'route:test', ${`dk-sat-${i}`}, ${`h-${i}`})
          `);
        }
        // total_count=99 is the magic value the cleanup helper uses to
        // identify these synthetic samples.
        for (let i = 0; i < 6; i++) {
          const t = now - i * 60_000;
          await workerDb.execute(sql`
            INSERT INTO pool_state_samples
              (sampled_at, pool_name, total_count, idle_count, waiting_count,
               max_count, utilization_pct)
            VALUES (${t}, 'api', 99, 0, 0, 18, 95)
          `);
        }
      }),
    );
    const result = await evaluateExternalCallAlerts(now);
    const satAlerts = result.alerts.filter(
      (a) => a.kind === "db_saturation_correlation" && a.integration === tag,
    );
    assert.equal(satAlerts.length, 1, "must fire db-saturation correlation");
    assert.ok(calls.some((c) => c.metadata.kind === "db_saturation_correlation"));
  }

  // ── Cooldown: re-evaluating immediately must not re-fire the storm ─
  {
    __testHelpers.resetState();
    __testHelpers.setKillSwitchForTests(() => true);
    const calls = installDispatcherStub();
    // Reuse the rule-1 fixture which is still in the table.
    const first = await evaluateExternalCallAlerts(now);
    const firstCount = first.alertsFired;
    const second = await evaluateExternalCallAlerts(now);
    assert.equal(second.alertsFired, 0, "cooldown must suppress immediate re-fire");
    assert.equal(getActiveExternalCallAlerts().length, firstCount);
  }

  // ── Kill switch OFF: tick returns empty without touching the DB ───
  {
    __testHelpers.resetState();
    __testHelpers.setKillSwitchForTests(() => false);
    const calls = installDispatcherStub();
    const result = await evaluateExternalCallAlerts(now);
    assert.equal(result.killSwitchEnabled, false);
    assert.equal(result.alertsFired, 0);
    assert.equal(calls.length, 0);
  }

  await cleanFixtures();
  console.log("external-call-audit-alerts.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run()
  .then(() => {})
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
