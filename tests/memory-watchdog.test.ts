/* test-registration
{
  "name": "Memory watchdog — breach-streak alerting + Reserved VM wiring (Task #2897)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2897: the Reserved VM memory watchdog's breach-streak alert state machine plus the deployment wiring it guards (.replit vm target, startup tick, shutdown stop, stagger offset, registry entry, lint annotation). Pure in-memory (dispatcher stubbed, settings fall back to defaults), so it is safe and fast in the routine gate.",
  "scanPaths": [
    ".replit",
    "server/boot/schedulerInits.ts",
    "server/boot/shutdown.ts",
    "server/index.ts",
    "server/services/memoryWatchdog.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2897 — Reserved VM readiness: memory watchdog regression coverage.
 *
 * Guards the pieces of the autoscale → Reserved VM switch that can rot
 * silently:
 *   1. The watchdog's alert-once-per-breach-streak + hysteresis re-arm
 *      state machine (`checkMemoryOnce` in server/services/memoryWatchdog.ts).
 *   2. Dispatch-failure retry semantics (a failed Slack send must NOT latch
 *      the streak, so the next hourly tick retries).
 *   3. The `infra.memory.high_rss` notification-registry entry.
 *   4. Startup/shutdown wiring in server/index.ts + the stagger offset.
 *   5. The `@cross-instance-safe` lint annotation in the watchdog header.
 *   6. `.replit` deployment config: deploymentTarget "vm" and the removed
 *      5904/3001 port block.
 *
 * Pure / in-memory: no DB (settings reads fall back to defaults on error),
 * no network (dispatcher is stubbed), no spawned children — safe for the
 * routine TEST_SMOKE gate.
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #1009 (queue starvation alerts — alert/re-arm + settings pattern),
 *   #2611 (regression sweep scheduler — pure smoke-test harness pattern),
 *   #2657 (infra.backup.failed registry entry format).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import {
  DEFAULTS,
  NOTIFICATION_ID,
  REARM_FRACTION,
  SETTING_ALERT_RSS_MB,
  SETTING_ENABLED,
  checkMemoryOnce,
  __testHelpers,
  type MemorySample,
} from "../server/services/memoryWatchdog";
import { NOTIFICATION_REGISTRY } from "../server/services/notifications/registry";
import { WORKER_STAGGER_OFFSETS } from "../server/services/workerConfig";

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

function sample(rssMb: number): MemorySample {
  return { rssMb, heapUsedMb: rssMb * 0.6, heapTotalMb: rssMb * 0.7, externalMb: 50 };
}

interface DispatchCall {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

function installStubs(opts: { deliver: boolean }) {
  const calls: DispatchCall[] = [];
  __testHelpers.resetStateForTests();
  __testHelpers.setDispatcherForTests(async (id, payload, options) => {
    calls.push({ id, text: payload.text, metadata: options.metadata });
    return { delivered: opts.deliver, status: opts.deliver ? "sent" : "failed" };
  });
  return calls;
}

function setSample(rssMb: number) {
  __testHelpers.setSamplerForTests(() => sample(rssMb));
}

function cleanupStubs() {
  __testHelpers.setSamplerForTests(null);
  __testHelpers.setDispatcherForTests(null);
  __testHelpers.resetStateForTests();
}

const THRESHOLD = DEFAULTS.alertRssMb;
const REARM = Math.round(THRESHOLD * REARM_FRACTION);

// ---------------------------------------------------------------------------
// 1. Alert-once-per-breach-streak + hysteresis re-arm state machine
// ---------------------------------------------------------------------------

test("breach alerts once, stays quiet, re-arms below the re-arm level, then alerts again", async () => {
  const calls = installStubs({ deliver: true });
  try {
    // Just below the threshold — the module doc says the first sample
    // AT/above the threshold alerts, so THRESHOLD-1 is the last "ok" value.
    setSample(THRESHOLD - 1);
    let r = await checkMemoryOnce();
    assert.equal(r.decision, "ok");
    assert.equal(calls.length, 0);

    // First breach — alerts exactly once.
    setSample(THRESHOLD + 100);
    r = await checkMemoryOnce();
    assert.equal(r.decision, "alerted");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, NOTIFICATION_ID);
    assert.match(calls[0].text, /High memory usage/);
    assert.equal(__testHelpers.isAlerted(), true);

    // Continued breach — no second alert for the same streak.
    setSample(THRESHOLD + 300);
    r = await checkMemoryOnce();
    assert.equal(r.decision, "breach_already_alerted");
    assert.equal(calls.length, 1);

    // Hysteresis band: below threshold but at/above the re-arm level —
    // must stay latched so oscillation at the threshold can't flap.
    setSample(REARM + 1);
    r = await checkMemoryOnce();
    assert.equal(r.decision, "above_rearm_still_alerted");
    assert.equal(calls.length, 1);
    assert.equal(__testHelpers.isAlerted(), true);

    // Drop below the re-arm level — a single recovered follow-up, re-armed.
    setSample(REARM - 200);
    r = await checkMemoryOnce();
    assert.equal(r.decision, "recovered");
    assert.equal(calls.length, 2);
    assert.match(calls[1].text, /Memory recovered/);
    assert.equal(__testHelpers.isAlerted(), false);

    // A NEW breach streak alerts again.
    setSample(THRESHOLD + 50);
    r = await checkMemoryOnce();
    assert.equal(r.decision, "alerted");
    assert.equal(calls.length, 3);
  } finally {
    cleanupStubs();
  }
});

test("thresholds derive from DEFAULTS (3072 MB ≈ 75% of the 4 GB tier) with a 90% re-arm", async () => {
  assert.equal(DEFAULTS.alertRssMb, 3072);
  assert.equal(REARM_FRACTION, 0.9);
  const calls = installStubs({ deliver: true });
  try {
    setSample(THRESHOLD);
    const r = await checkMemoryOnce();
    // Boundary: rss === threshold counts as a breach.
    assert.equal(r.decision, "alerted");
    assert.equal(r.thresholdMb, THRESHOLD);
    assert.equal(r.rearmMb, REARM);
    assert.equal(calls.length, 1);
  } finally {
    cleanupStubs();
  }
});

// ---------------------------------------------------------------------------
// 2. Dispatch failures must not latch (retry next tick)
// ---------------------------------------------------------------------------

test("failed breach dispatch does not latch — next tick retries and can succeed", async () => {
  const failingCalls = installStubs({ deliver: false });
  try {
    setSample(THRESHOLD + 100);
    // `let` — reassigned after the dispatcher swap below (a `const` is an
    // esbuild bundle-mode parse error and a runtime TypeError under tsx).
    let r = await checkMemoryOnce();
    assert.equal(r.decision, "breach_dispatch_failed");
    assert.equal(__testHelpers.isAlerted(), false);
    assert.equal(failingCalls.length, 1);

    // Dispatcher recovers — the still-breached next tick alerts.
    const okCalls: DispatchCall[] = [];
    __testHelpers.setDispatcherForTests(async (id, payload, options) => {
      okCalls.push({ id, text: payload.text, metadata: options.metadata });
      return { delivered: true, status: "sent" };
    });
    r = await checkMemoryOnce();
    assert.equal(r.decision, "alerted");
    assert.equal(__testHelpers.isAlerted(), true);
    assert.equal(okCalls.length, 1);
  } finally {
    cleanupStubs();
  }
});

test("failed recovered dispatch keeps the latch so the resolve is retried", async () => {
  installStubs({ deliver: true });
  try {
    setSample(THRESHOLD + 100);
    await checkMemoryOnce(); // latch
    __testHelpers.setDispatcherForTests(async () => ({ delivered: false, status: "failed" }));
    setSample(REARM - 300);
    const r = await checkMemoryOnce();
    assert.equal(r.decision, "recovered_dispatch_failed");
    assert.equal(__testHelpers.isAlerted(), true);
  } finally {
    cleanupStubs();
  }
});

// ---------------------------------------------------------------------------
// 3. Notification registry entry
// ---------------------------------------------------------------------------

test("infra.memory.high_rss is registered, implemented, and default-enabled", () => {
  const entry = NOTIFICATION_REGISTRY.find((t) => t.id === NOTIFICATION_ID);
  assert.ok(entry, `registry entry ${NOTIFICATION_ID} missing`);
  assert.equal(entry.category, "infra");
  assert.equal(entry.defaultEnabled, true);
  assert.equal(entry.implemented, true);
  assert.equal(entry.ownerService, "memoryWatchdog");
});

// ---------------------------------------------------------------------------
// 4. Wiring: startup tick, shutdown stop, stagger offset
// ---------------------------------------------------------------------------

test("server/index.ts wires memory-watchdog startup and shutdown", () => {
  // Task #3787: server/index.ts is a thin orchestrator over server/boot/*;
  // startup wiring may live in either, so scan the combined boot surface.
  const src = [
    "server/index.ts",
    "server/boot/schedulerInits.ts",
    "server/boot/shutdown.ts",
    "server/services/memoryWatchdog.ts",
  ]
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  assert.match(src, /startupTick\("memory-watchdog-init"/, "startup tick missing");
  assert.match(src, /WORKER_STAGGER_OFFSETS\.memory_watchdog/, "stagger offset not used");
  assert.match(src, /stopMemoryWatchdog\(\)/, "graceful shutdown stop missing");
});

test("WORKER_STAGGER_OFFSETS has a unique memory_watchdog offset", () => {
  const offset = WORKER_STAGGER_OFFSETS.memory_watchdog;
  assert.ok(typeof offset === "number" && offset > 0, "memory_watchdog offset missing");
  const collisions = Object.entries(WORKER_STAGGER_OFFSETS).filter(
    ([name, v]) => v === offset && name !== "memory_watchdog",
  );
  assert.deepEqual(collisions, [], `offset ${offset} collides with ${JSON.stringify(collisions)}`);
});

// ---------------------------------------------------------------------------
// 5. Cross-instance lint annotation + settings keys
// ---------------------------------------------------------------------------

test("memoryWatchdog.ts header carries the @cross-instance-safe annotation and settings keys", () => {
  const src = readFileSync("server/services/memoryWatchdog.ts", "utf8");
  const header = src.slice(0, src.indexOf("import "));
  assert.match(header, /@cross-instance-safe:/, "lint annotation missing from header");
  assert.equal(SETTING_ENABLED, "memory_watchdog_enabled");
  assert.equal(SETTING_ALERT_RSS_MB, "memory_watchdog_alert_rss_mb");
  assert.match(src, /memory_watchdog_enabled/);
  assert.match(src, /memory_watchdog_alert_rss_mb/);
});

// ---------------------------------------------------------------------------
// 6. .replit deployment config for the Reserved VM switch
// ---------------------------------------------------------------------------

test(".replit targets vm and the 5904/3001 port block is gone", () => {
  const dotReplit = readFileSync(".replit", "utf8");
  assert.match(dotReplit, /deploymentTarget = "vm"/, "deploymentTarget must be vm");
  assert.doesNotMatch(dotReplit, /localPort = 5904/, "5904 port block must be removed");
  // A bare `externalPort = 3001` is no longer a tell for the old dev block:
  // the platform-registered mockup-sandbox artifact legitimately maps its
  // own vite port to external 3001 (localPort 23636 as of Aug 2026). The
  // regression this test guards is the pre-Reserved-VM 5904→3001 pairing,
  // so pin the 3001 assertion to that pairing instead of any 3001 use.
  assert.doesNotMatch(
    dotReplit,
    /localPort = 5904\s*\r?\nexternalPort = 3001/,
    "5904→3001 port block must be removed",
  );
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(err instanceof Error ? err.stack : err);
    }
  }
  console.log(`\nmemory-watchdog tests: ${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) {
    process.exitCode = 1;
    throw new Error(`${failed} memory-watchdog test(s) failed`);
  }
  console.log("memory-watchdog.test.ts: OK");
})();
