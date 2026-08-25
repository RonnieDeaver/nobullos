/* test-registration
{
  "name": "Invalid-products growth alert (Task #1231)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "scanPaths": [
    "server/boot",
    "server/index.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #1231 regression tests: invalid-products growth alert.
 *
 * Covers:
 *   - Fires through `notifyByType` when offender count grows since last snapshot,
 *     names the count, distinct invalid values, and affected client names.
 *   - Silent when count is stable.
 *   - Silent when count shrinks (and lowers the baseline so a future climb fires).
 *   - Cooldown prevents repeat alerts within the window but still advances baseline.
 *   - First seed (no previous count) with no offenders is silent.
 *   - Dispatcher-side skip does not consume baseline/cooldown — next tick retries.
 *   - Source-level guard: server/index.ts wires the scheduler startup.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";
import { storage } from "../server/storage";
import {
  checkInvalidProductsGrowth,
  NOTIFICATION_ID,
  SETTING_ENABLED,
  SETTING_COOLDOWN_MINUTES,
  SETTING_LAST_KNOWN_COUNT,
  SETTING_LAST_ALERTED_AT,
  __testHelpers,
} from "../server/services/invalidProductsGrowthAlerts";

const MARKER = `t1231_${process.pid}_${Date.now()}`;
const CLIENT_A = `${MARKER}_a`;
const CLIENT_B = `${MARKER}_b`;
const CLIENT_C = `${MARKER}_c`;

const SETTING_KEYS = [
  SETTING_ENABLED,
  SETTING_COOLDOWN_MINUTES,
  SETTING_LAST_KNOWN_COUNT,
  SETTING_LAST_ALERTED_AT,
] as const;

async function cleanup(): Promise<void> {
  const db = getDb();
  for (const id of [CLIENT_A, CLIENT_B, CLIENT_C]) {
    await db.execute(sql`DELETE FROM clients WHERE id = ${id}`);
  }
  for (const k of SETTING_KEYS) {
    try {
      await storage.deleteSystemSetting(k);
    } catch {}
  }
}

async function seedClient(
  id: string,
  products: string[],
  opts: { isDemo?: boolean } = {},
): Promise<void> {
  const arrayLiteral = `{${products
    .map((p) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",")}}`;
  const isDemo = !!opts.isDemo;
  await getDb().execute(sql`
    INSERT INTO clients (id, firm_name, products, is_demo, is_archived)
    VALUES (${id}, ${`Firm ${id}`}, ${arrayLiteral}::text[], ${isDemo}, false)
    ON CONFLICT (id) DO UPDATE SET products = EXCLUDED.products, is_demo = EXCLUDED.is_demo
  `);
}

async function deleteClient(id: string): Promise<void> {
  await getDb().execute(sql`DELETE FROM clients WHERE id = ${id}`);
}

interface DispatchCall {
  id: string;
  text: string;
  meta: Record<string, unknown> | undefined;
}

function installDispatcherStub(
  calls: DispatchCall[],
  outcome: { delivered: boolean; status?: string; skipReason?: string } = {
    delivered: true,
  },
) {
  __testHelpers.setDispatcherForTests(async (id, payload, opts) => {
    calls.push({ id, text: payload.text, meta: opts.metadata });
    return {
      delivered: outcome.delivered,
      status: outcome.status ?? (outcome.delivered ? "sent" : "failed"),
      skipReason: outcome.skipReason,
    };
  });
  return () => __testHelpers.setDispatcherForTests(null);
}

async function resetSettings(): Promise<void> {
  for (const k of SETTING_KEYS) {
    try {
      await storage.deleteSystemSetting(k);
    } catch {}
  }
}

async function testFirstRunSeedsBaselineSilently(): Promise<void> {
  await cleanup();
  // Pre-existing offender at startup must NOT alert — it's a baseline seed.
  await seedClient(CLIENT_A, ["gbp", "definitely-not-a-product"]);
  const calls: DispatchCall[] = [];
  const restore = installDispatcherStub(calls);
  try {
    const r = await checkInvalidProductsGrowth();
    assert.equal(r.decision, "skipped_seeded_baseline", `decision=${r.decision}`);
    assert.equal(r.previousCount, null, "previous is null on first run");
    assert.equal(r.currentCount, 1, "current=1");
    assert.equal(calls.length, 0, "no dispatch on baseline seed");
    const lkc = await storage.getSystemSetting(SETTING_LAST_KNOWN_COUNT);
    assert.equal(lkc?.value, "1", "baseline persisted at current count");
  } finally {
    restore();
  }
  console.log("✓ first run seeds baseline silently (no alert for pre-existing offenders)");
}

async function testGrowthFiresWithDetails(): Promise<void> {
  await cleanup();
  // Establish baseline of 1 offender silently first.
  await seedClient(CLIENT_A, ["gbp", "definitely-not-a-product"]);
  {
    const calls: DispatchCall[] = [];
    const restore = installDispatcherStub(calls);
    try {
      const r = await checkInvalidProductsGrowth();
      assert.equal(r.decision, "skipped_seeded_baseline");
      assert.equal(calls.length, 0);
    } finally {
      restore();
    }
  }

  // Now ADD a second offender → must alert (genuine growth).
  await seedClient(CLIENT_B, ["gbp", "another-bad-value"]);
  const calls: DispatchCall[] = [];
  const restore = installDispatcherStub(calls);
  try {
    const r = await checkInvalidProductsGrowth();
    assert.equal(r.decision, "alerted", `decision=${r.decision}`);
    assert.equal(r.currentCount, 2, "current=2");
    assert.equal(r.previousCount, 1, "previous=1");
    assert.equal(calls.length, 1, "1 dispatch");
    assert.equal(calls[0].id, NOTIFICATION_ID);
    assert.match(calls[0].text, /2/);
    assert.match(calls[0].text, /definitely-not-a-product/);
    assert.match(calls[0].text, /another-bad-value/);
    assert.match(calls[0].text, new RegExp(`Firm ${CLIENT_A}`));
    assert.match(calls[0].text, new RegExp(`Firm ${CLIENT_B}`));
    const meta = calls[0].meta as Record<string, unknown>;
    assert.equal(meta.currentCount, 2);
    assert.equal(meta.previousCount, 1);
    assert.equal(meta.newOffenders, 1);
    assert.ok(
      Array.isArray(meta.distinctInvalidValues) &&
        (meta.distinctInvalidValues as string[]).includes(
          "definitely-not-a-product",
        ) &&
        (meta.distinctInvalidValues as string[]).includes("another-bad-value"),
      "metadata.distinctInvalidValues",
    );
    const lkc = await storage.getSystemSetting(SETTING_LAST_KNOWN_COUNT);
    assert.equal(lkc?.value, "2", "baseline advanced to 2");
  } finally {
    restore();
  }
  console.log("✓ growth fires + names count/values/clients + advances baseline");
}

async function testStableCountSilent(): Promise<void> {
  await cleanup();
  await seedClient(CLIENT_A, ["gbp", "bad-one"]);
  await seedClient(CLIENT_B, ["gbp", "bad-two"]);
  await storage.setSystemSetting(SETTING_LAST_KNOWN_COUNT, "2", "system");
  const calls: DispatchCall[] = [];
  const restore = installDispatcherStub(calls);
  try {
    const r = await checkInvalidProductsGrowth();
    assert.equal(r.decision, "skipped_no_growth", `decision=${r.decision}`);
    assert.equal(calls.length, 0, "no dispatch when stable");
  } finally {
    restore();
  }
  console.log("✓ stable count is silent");
}

async function testShrinkingCountSilentAndLowersBaseline(): Promise<void> {
  await cleanup();
  await seedClient(CLIENT_A, ["gbp", "bad-one"]);
  await storage.setSystemSetting(SETTING_LAST_KNOWN_COUNT, "5", "system");
  const calls: DispatchCall[] = [];
  const restore = installDispatcherStub(calls);
  try {
    const r = await checkInvalidProductsGrowth();
    assert.equal(r.decision, "skipped_no_growth", `decision=${r.decision}`);
    assert.equal(calls.length, 0, "no dispatch when shrinking");
    const lkc = await storage.getSystemSetting(SETTING_LAST_KNOWN_COUNT);
    assert.equal(lkc?.value, "1", "baseline lowered to current count");
  } finally {
    restore();
  }
  console.log("✓ shrinking count is silent and baseline is lowered");
}

async function testNoOffendersSilent(): Promise<void> {
  await cleanup();
  // Baseline already exists; current snapshot has no offenders.
  await storage.setSystemSetting(SETTING_LAST_KNOWN_COUNT, "3", "system");
  const calls: DispatchCall[] = [];
  const restore = installDispatcherStub(calls);
  try {
    const r = await checkInvalidProductsGrowth();
    assert.equal(r.decision, "skipped_no_offenders");
    assert.equal(calls.length, 0);
    const lkc = await storage.getSystemSetting(SETTING_LAST_KNOWN_COUNT);
    assert.equal(lkc?.value, "0", "baseline pinned to 0");
  } finally {
    restore();
  }
  console.log("✓ zero offenders is silent (baseline=0)");
}

async function testCooldownGatesAndAdvancesBaseline(): Promise<void> {
  await cleanup();
  await seedClient(CLIENT_A, ["gbp", "bad-one"]);
  await storage.setSystemSetting(SETTING_LAST_KNOWN_COUNT, "0", "system");
  await storage.setSystemSetting(SETTING_COOLDOWN_MINUTES, "60", "system");
  // Pretend we alerted 5 minutes ago.
  await storage.setSystemSetting(
    SETTING_LAST_ALERTED_AT,
    String(Date.now() - 5 * 60_000),
    "system",
  );
  // Now grow to 2 offenders.
  await seedClient(CLIENT_B, ["gbp", "bad-two"]);
  const calls: DispatchCall[] = [];
  const restore = installDispatcherStub(calls);
  try {
    const r = await checkInvalidProductsGrowth();
    assert.equal(r.decision, "skipped_cooldown", `decision=${r.decision}`);
    assert.equal(calls.length, 0, "no dispatch within cooldown");
    const lkc = await storage.getSystemSetting(SETTING_LAST_KNOWN_COUNT);
    assert.equal(
      lkc?.value,
      "2",
      "baseline still advanced so further growth is what triggers next alert",
    );
  } finally {
    restore();
  }
  console.log("✓ cooldown gates dispatch but advances baseline");
}

async function testDispatcherSkipDoesNotConsumeBaseline(): Promise<void> {
  await cleanup();
  await seedClient(CLIENT_A, ["gbp", "bad-one"]);
  await storage.setSystemSetting(SETTING_LAST_KNOWN_COUNT, "0", "system");
  const calls: DispatchCall[] = [];
  const restore = installDispatcherStub(calls, {
    delivered: false,
    status: "skipped_disabled",
    skipReason: "channel not configured",
  });
  try {
    const r = await checkInvalidProductsGrowth();
    assert.equal(
      r.decision,
      "skipped_dispatcher_skipped",
      `decision=${r.decision}`,
    );
    const lkc = await storage.getSystemSetting(SETTING_LAST_KNOWN_COUNT);
    // Baseline must NOT be advanced on dispatcher failure so the next tick retries.
    assert.ok(
      lkc?.value == null || lkc.value === "0",
      `baseline not advanced on dispatcher skip (got ${lkc?.value})`,
    );
    const ts = await storage.getSystemSetting(SETTING_LAST_ALERTED_AT);
    assert.ok(
      ts?.value == null,
      `no last-alerted timestamp on dispatcher skip (got ${ts?.value})`,
    );
  } finally {
    restore();
  }
  console.log("✓ dispatcher skip does not consume baseline/cooldown");
}

async function testDemoClientsExcluded(): Promise<void> {
  await cleanup();
  // One real offender + one demo offender. Only the real one should count.
  await seedClient(CLIENT_A, ["gbp", "bad-real"]);
  await seedClient(CLIENT_B, ["gbp", "bad-demo"], { isDemo: true });
  // Pre-seed baseline at 0 so the next run treats the real offender as growth.
  await storage.setSystemSetting(SETTING_LAST_KNOWN_COUNT, "0", "system");
  const calls: DispatchCall[] = [];
  const restore = installDispatcherStub(calls);
  try {
    const r = await checkInvalidProductsGrowth();
    assert.equal(r.decision, "alerted", `decision=${r.decision}`);
    assert.equal(r.currentCount, 1, "demo offender excluded from count");
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /bad-real/);
    assert.ok(
      !calls[0].text.includes("bad-demo"),
      "demo offender's invalid value not leaked into alert",
    );
    assert.ok(
      !calls[0].text.includes(`Firm ${CLIENT_B}`),
      "demo client name not leaked into alert",
    );
  } finally {
    restore();
  }
  console.log("✓ demo clients excluded from snapshot (no name/value leak)");
}

async function testDisabledKillSwitch(): Promise<void> {
  await cleanup();
  await seedClient(CLIENT_A, ["gbp", "bad-one"]);
  await seedClient(CLIENT_B, ["gbp", "bad-two"]);
  await storage.setSystemSetting(SETTING_ENABLED, "false", "system");
  const calls: DispatchCall[] = [];
  const restore = installDispatcherStub(calls);
  try {
    const r = await checkInvalidProductsGrowth();
    assert.equal(r.decision, "skipped_disabled", `decision=${r.decision}`);
    assert.equal(calls.length, 0);
    // Baseline still recorded so re-enabling doesn't fire retroactively for
    // already-known offenders.
    const lkc = await storage.getSystemSetting(SETTING_LAST_KNOWN_COUNT);
    assert.equal(lkc?.value, "2", "baseline pinned even when disabled");
  } finally {
    restore();
  }
  console.log("✓ kill switch silences alert + still records baseline");
}

async function testIndexWiring(): Promise<void> {
  const fs = await import("node:fs/promises");
  // Task #3787: scheduler wiring moved into server/boot/ (thin-orchestrator
  // split); scan index + boot modules.
  const bootFiles = (await fs.readdir("server/boot")).filter((f) => f.endsWith(".ts")).sort();
  const src = [
    await fs.readFile("server/index.ts", "utf8"),
    ...(await Promise.all(bootFiles.map((f) => fs.readFile(`server/boot/${f}`, "utf8")))),
  ].join("\n");
  assert.ok(
    src.includes('services/invalidProductsGrowthAlerts"'),
    "server/index.ts imports invalidProductsGrowthAlerts",
  );
  assert.ok(
    src.includes("startInvalidProductsGrowthAlertsScheduler"),
    "server/index.ts calls startInvalidProductsGrowthAlertsScheduler",
  );
  console.log("✓ scheduler is wired into server/index.ts");
}

/**
 * Pre-existing invalid-products offenders in the dev DB (left over by
 * other tests or seed data) pollute the global snapshot count and break
 * this test's hardcoded baseline assertions (e.g. currentCount=1). To
 * isolate without destroying those rows, temporarily flip their
 * `is_demo` flag to `true` — `loadInvalidProductsSnapshot` excludes
 * demo clients (line 160 in invalidProductsGrowthAlerts.ts) — then
 * restore the flags at the end of the suite.
 */
async function quarantinePreExistingOffenders(): Promise<{
  restore: () => Promise<void>;
}> {
  const db = getDb();
  const snap = await import("../server/services/invalidProductsGrowthAlerts");
  const before = await snap.loadInvalidProductsSnapshot();
  const ids = before.offenders
    .filter((o) => !o.isDemo)
    .map((o) => o.id)
    .filter((id) => !id.startsWith(MARKER)); // never touch our own test rows
  if (ids.length === 0) {
    return { restore: async () => {} };
  }
  await db.execute(
    sql`UPDATE clients SET is_demo = true WHERE id = ANY(${ids}::text[])`,
  );
  return {
    restore: async () => {
      await db.execute(
        sql`UPDATE clients SET is_demo = false WHERE id = ANY(${ids}::text[])`,
      );
    },
  };
}

async function main(): Promise<void> {
  const quarantine = await quarantinePreExistingOffenders();
  try {
    await resetSettings();
    await testFirstRunSeedsBaselineSilently();
    await testGrowthFiresWithDetails();
    await testStableCountSilent();
    await testShrinkingCountSilentAndLowersBaseline();
    await testNoOffendersSilent();
    await testCooldownGatesAndAdvancesBaseline();
    await testDispatcherSkipDoesNotConsumeBaseline();
    await testDemoClientsExcluded();
    await testDisabledKillSwitch();
    await testIndexWiring();
    console.log("\nALL INVALID-PRODUCTS GROWTH ALERT TESTS PASSED");
  } finally {
    await cleanup();
    __testHelpers.setDispatcherForTests(null);
    await quarantine.restore();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(
  () => {},
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
