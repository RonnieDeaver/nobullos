/* test-registration
{
  "name": "Front recovery retry alerts (Task #1101)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.5s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1101 regression tests for `frontRecoveryRetryAlerts`.
 *
 * Covers the slow-burn `evaluateConsecutiveWindowsForFront5xxPressure`
 * watcher (added in Task #1083) and the per-window
 * `evaluateWindowForRetryPressure` watcher (Task #1023). Both share the
 * same `__testHelpers.setDispatcherForTests` / `resetAlertedCache`
 * hooks so we stub the Slack dispatcher and clear the in-memory dedupe
 * cache between cases — no real notification is dispatched.
 *
 * Config knobs are written through `storage.setSystemSetting` so we
 * exercise the same `getFrontRecoveryRetryAlertConfig` code path the
 * recovery loop uses in production.
 */
import assert from "node:assert/strict";
import { storage } from "../server/storage";
import {
  __testHelpers,
  count5xxRetries,
  evaluateConsecutiveWindowsForFront5xxPressure,
  evaluateEmptySuffixDedupeKeys,
  evaluateWindowForRetryPressure,
  evaluateWindowForSuppressionDominance,
  SETTING_CONSECUTIVE_5XX_FLOOR,
  SETTING_CONSECUTIVE_WINDOW_COUNT,
  SETTING_EMPTY_SUFFIX_ENABLED,
  SETTING_ENABLED,
  SETTING_SUPPRESSION_DOMINANCE_ENABLED,
  SETTING_SUPPRESSION_DOMINANCE_MIN_PAGES,
  SETTING_SUPPRESSION_DOMINANCE_RATIO,
  SETTING_TOTAL_RETRIES_THRESHOLD,
  SUPPRESSION_DOMINANCE_NOTIFICATION_ID,
} from "../server/services/frontRecoveryRetryAlerts";
import type { WindowCheckpoint } from "../server/services/frontHistoricalRecovery";

const SETTING_KEYS = [
  SETTING_ENABLED,
  SETTING_TOTAL_RETRIES_THRESHOLD,
  SETTING_CONSECUTIVE_WINDOW_COUNT,
  SETTING_CONSECUTIVE_5XX_FLOOR,
  SETTING_SUPPRESSION_DOMINANCE_ENABLED,
  SETTING_SUPPRESSION_DOMINANCE_RATIO,
  SETTING_SUPPRESSION_DOMINANCE_MIN_PAGES,
  SETTING_EMPTY_SUFFIX_ENABLED,
] as const;

const JOB_ID = `t1101_${process.pid}_${Date.now()}`;

function makeWindow(
  label: string,
  overrides: Partial<WindowCheckpoint> = {},
): WindowCheckpoint {
  return {
    windowLabel: label,
    afterTimestamp: 0,
    beforeTimestamp: 0,
    status: "complete",
    statusReason: null,
    scanned: 0,
    ingested: 0,
    skipped: 0,
    errors: [],
    pages: 0,
    lastPageUrl: null,
    startedAt: null,
    completedAt: null,
    retriesByReason: {},
    totalRetries: 0,
    tokenRefreshes: 0,
    ...overrides,
  };
}

interface DispatchCall {
  id: string;
  payload: { text: string; preview?: string };
  options: { triggerSource: string; dedupeKey?: string };
}

function makeDispatcher(
  result: { delivered: boolean; status?: string; skipReason?: string },
): { fn: any; calls: DispatchCall[] } {
  const calls: DispatchCall[] = [];
  const fn = async (id: string, payload: any, options: any) => {
    calls.push({ id, payload, options });
    return result;
  };
  return { fn, calls };
}

async function resetAll(): Promise<void> {
  for (const k of SETTING_KEYS) {
    try {
      await storage.deleteSystemSetting(k);
    } catch {}
  }
  __testHelpers.resetAlertedCache();
  __testHelpers.setDispatcherForTests(null);
}

async function configure(opts: {
  enabled?: boolean;
  totalRetriesThreshold?: number;
  consecutiveWindowCount?: number;
  consecutive5xxFloor?: number;
  suppressionDominanceEnabled?: boolean;
  suppressionDominanceRatio?: number;
  suppressionDominanceMinPages?: number;
  emptySuffixEnabled?: boolean;
}): Promise<void> {
  // Pass "system" as updatedBy — settingsStorage maps that to NULL so
  // the system_settings_updated_by FK is not exercised in tests.
  if (opts.enabled !== undefined) {
    await storage.setSystemSetting(
      SETTING_ENABLED,
      opts.enabled ? "true" : "false",
      "system",
    );
  }
  if (opts.totalRetriesThreshold !== undefined) {
    await storage.setSystemSetting(
      SETTING_TOTAL_RETRIES_THRESHOLD,
      String(opts.totalRetriesThreshold),
      "system",
    );
  }
  if (opts.consecutiveWindowCount !== undefined) {
    await storage.setSystemSetting(
      SETTING_CONSECUTIVE_WINDOW_COUNT,
      String(opts.consecutiveWindowCount),
      "system",
    );
  }
  if (opts.consecutive5xxFloor !== undefined) {
    await storage.setSystemSetting(
      SETTING_CONSECUTIVE_5XX_FLOOR,
      String(opts.consecutive5xxFloor),
      "system",
    );
  }
  if (opts.suppressionDominanceEnabled !== undefined) {
    await storage.setSystemSetting(
      SETTING_SUPPRESSION_DOMINANCE_ENABLED,
      opts.suppressionDominanceEnabled ? "true" : "false",
      "system",
    );
  }
  if (opts.suppressionDominanceRatio !== undefined) {
    await storage.setSystemSetting(
      SETTING_SUPPRESSION_DOMINANCE_RATIO,
      String(opts.suppressionDominanceRatio),
      "system",
    );
  }
  if (opts.suppressionDominanceMinPages !== undefined) {
    await storage.setSystemSetting(
      SETTING_SUPPRESSION_DOMINANCE_MIN_PAGES,
      String(opts.suppressionDominanceMinPages),
      "system",
    );
  }
  if (opts.emptySuffixEnabled !== undefined) {
    await storage.setSystemSetting(
      SETTING_EMPTY_SUFFIX_ENABLED,
      opts.emptySuffixEnabled ? "true" : "false",
      "system",
    );
  }
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  await resetAll();
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    await resetAll();
  }
}

async function main(): Promise<void> {
  console.log("Front recovery retry alerts (Task #1101)");

  // ---- count5xxRetries ----------------------------------------------------
  await step(
    "count5xxRetries sums front_502 + front_503 + front_504 + front_5xx (and front_501)",
    async () => {
      const cp = makeWindow("w-sum", {
        retriesByReason: {
          front_501: 1,
          front_502: 2,
          front_503: 3,
          front_504: 4,
          front_5xx: 5,
          // Non-5xx-class noise that must be ignored.
          front_429: 100,
          timeout: 100,
          network: 100,
          auth_refresh_transient: 100,
        },
      });
      assert.equal(count5xxRetries(cp), 1 + 2 + 3 + 4 + 5);

      // Per the task brief: sum of 502 + 503 + 504 + 5xx specifically.
      const cp2 = makeWindow("w-sum-2", {
        retriesByReason: {
          front_502: 7,
          front_503: 8,
          front_504: 9,
          front_5xx: 11,
        },
      });
      assert.equal(count5xxRetries(cp2), 7 + 8 + 9 + 11);

      // Empty / missing retriesByReason hydrates as 0.
      const cp3 = makeWindow("w-empty");
      assert.equal(count5xxRetries(cp3), 0);
      const cp4 = makeWindow("w-undef", { retriesByReason: undefined });
      assert.equal(count5xxRetries(cp4), 0);
    },
  );

  // ---- evaluateConsecutiveWindowsForFront5xxPressure ---------------------

  await step("consecutive: skipped_disabled when alert turned off", async () => {
    await configure({ enabled: false });
    const { fn, calls } = makeDispatcher({ delivered: true });
    __testHelpers.setDispatcherForTests(fn);

    const r = await evaluateConsecutiveWindowsForFront5xxPressure({
      jobId: JOB_ID,
      windows: [
        makeWindow("w1", { retriesByReason: { front_502: 99 } }),
        makeWindow("w2", { retriesByReason: { front_502: 99 } }),
        makeWindow("w3", { retriesByReason: { front_502: 99 } }),
      ],
    });
    assert.equal(r.decision, "skipped_disabled");
    assert.equal(r.alerted, false);
    assert.equal(calls.length, 0);
  });

  await step(
    "consecutive: skipped_not_enough_windows when fewer than N windows",
    async () => {
      await configure({
        enabled: true,
        consecutiveWindowCount: 3,
        consecutive5xxFloor: 5,
      });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __testHelpers.setDispatcherForTests(fn);

      const r = await evaluateConsecutiveWindowsForFront5xxPressure({
        jobId: JOB_ID,
        windows: [
          makeWindow("w1", { retriesByReason: { front_502: 10 } }),
          makeWindow("w2", { retriesByReason: { front_502: 10 } }),
        ],
      });
      assert.equal(r.decision, "skipped_not_enough_windows");
      assert.equal(r.alerted, false);
      assert.equal(r.consecutiveWindowCount, 3);
      assert.equal(calls.length, 0);
    },
  );

  await step(
    "consecutive: skipped_chain_broken when a non-complete window sits in the trailing N",
    async () => {
      await configure({
        enabled: true,
        consecutiveWindowCount: 3,
        consecutive5xxFloor: 5,
      });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __testHelpers.setDispatcherForTests(fn);

      // The middle window of the trailing 3 is `partial` — chain broken.
      const r = await evaluateConsecutiveWindowsForFront5xxPressure({
        jobId: JOB_ID,
        windows: [
          makeWindow("w1", {
            status: "complete",
            retriesByReason: { front_502: 10 },
          }),
          makeWindow("w2", {
            status: "partial" as any,
            retriesByReason: { front_502: 10 },
          }),
          makeWindow("w3", {
            status: "complete",
            retriesByReason: { front_502: 10 },
          }),
        ],
      });
      assert.equal(r.decision, "skipped_chain_broken");
      assert.equal(r.alerted, false);
      assert.match(r.skipReason ?? "", /w2/);
      assert.equal(calls.length, 0);
    },
  );

  await step(
    "consecutive: skipped_below_floor when a trailing window is under the floor",
    async () => {
      await configure({
        enabled: true,
        consecutiveWindowCount: 3,
        consecutive5xxFloor: 5,
      });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __testHelpers.setDispatcherForTests(fn);

      const r = await evaluateConsecutiveWindowsForFront5xxPressure({
        jobId: JOB_ID,
        windows: [
          makeWindow("w1", { retriesByReason: { front_502: 10 } }),
          makeWindow("w2", { retriesByReason: { front_502: 1 } }), // under
          makeWindow("w3", { retriesByReason: { front_502: 10 } }),
        ],
      });
      assert.equal(r.decision, "skipped_below_floor");
      assert.equal(r.alerted, false);
      assert.match(r.skipReason ?? "", /w2/);
      assert.equal(calls.length, 0);
    },
  );

  await step(
    "consecutive: alerted when trailing N are all complete and at/above floor",
    async () => {
      await configure({
        enabled: true,
        consecutiveWindowCount: 3,
        consecutive5xxFloor: 5,
      });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __testHelpers.setDispatcherForTests(fn);

      // Mix the 5xx-class buckets to also confirm count5xxRetries is in play.
      const r = await evaluateConsecutiveWindowsForFront5xxPressure({
        jobId: JOB_ID,
        windows: [
          // Older non-matching window — should be ignored (only trailing N counted).
          makeWindow("w0", { status: "failed" as any }),
          makeWindow("w1", {
            retriesByReason: { front_502: 3, front_503: 2 },
            totalRetries: 5,
          }),
          makeWindow("w2", {
            retriesByReason: { front_504: 5, front_5xx: 1 },
            totalRetries: 6,
          }),
          makeWindow("w3", {
            retriesByReason: { front_502: 2, front_503: 2, front_504: 2 },
            totalRetries: 6,
          }),
        ],
      });
      assert.equal(r.decision, "alerted");
      assert.equal(r.alerted, true);
      assert.equal(r.consecutiveWindowCount, 3);
      assert.equal(r.consecutive5xxFloor, 5);
      assert.deepEqual(r.matchedWindowLabels, ["w1", "w2", "w3"]);
      assert.equal(r.trailingWindow?.windowLabel, "w3");
      assert.equal(r.trailingWindow?.front5xxRetries, 6);
      assert.equal(calls.length, 1);
      assert.equal(
        calls[0].options.dedupeKey,
        `consecutive|${JOB_ID}|w3`,
      );
    },
  );

  await step(
    "consecutive: re-evaluating the same trailing window dedupes (skipped_already_alerted)",
    async () => {
      await configure({
        enabled: true,
        consecutiveWindowCount: 3,
        consecutive5xxFloor: 5,
      });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __testHelpers.setDispatcherForTests(fn);

      const windows = [
        makeWindow("w1", { retriesByReason: { front_502: 10 } }),
        makeWindow("w2", { retriesByReason: { front_502: 10 } }),
        makeWindow("w3", { retriesByReason: { front_502: 10 } }),
      ];

      const first = await evaluateConsecutiveWindowsForFront5xxPressure({
        jobId: JOB_ID,
        windows,
      });
      assert.equal(first.decision, "alerted");
      assert.equal(calls.length, 1);

      const second = await evaluateConsecutiveWindowsForFront5xxPressure({
        jobId: JOB_ID,
        windows,
      });
      assert.equal(second.decision, "skipped_already_alerted");
      assert.equal(second.alerted, false);
      assert.equal(
        calls.length,
        1,
        "dispatcher must not be called twice for the same trailing window",
      );
      assert.equal(second.trailingWindow?.windowLabel, "w3");
      assert.deepEqual(second.matchedWindowLabels, ["w1", "w2", "w3"]);
    },
  );

  await step(
    "consecutive: skipped_dispatcher_skipped when dispatcher reports not delivered",
    async () => {
      await configure({
        enabled: true,
        consecutiveWindowCount: 3,
        consecutive5xxFloor: 5,
      });
      const { fn, calls } = makeDispatcher({
        delivered: false,
        status: "skipped_disabled",
        skipReason: "channel disabled",
      });
      __testHelpers.setDispatcherForTests(fn);

      const r = await evaluateConsecutiveWindowsForFront5xxPressure({
        jobId: JOB_ID,
        windows: [
          makeWindow("w1", { retriesByReason: { front_502: 10 } }),
          makeWindow("w2", { retriesByReason: { front_502: 10 } }),
          makeWindow("w3", { retriesByReason: { front_502: 10 } }),
        ],
      });
      assert.equal(r.decision, "skipped_dispatcher_skipped");
      assert.equal(r.alerted, false);
      assert.equal(r.skipReason, "channel disabled");
      assert.equal(calls.length, 1);
    },
  );

  // ---- evaluateWindowForRetryPressure (per-window, Task #1023) -----------

  await step("per-window: skipped_disabled when alert turned off", async () => {
    await configure({ enabled: false, totalRetriesThreshold: 10 });
    const { fn, calls } = makeDispatcher({ delivered: true });
    __testHelpers.setDispatcherForTests(fn);

    const r = await evaluateWindowForRetryPressure({
      jobId: JOB_ID,
      checkpoint: makeWindow("w1", { totalRetries: 999 }),
    });
    assert.equal(r.decision, "skipped_disabled");
    assert.equal(r.alerted, false);
    assert.equal(calls.length, 0);
  });

  await step(
    "per-window: skipped_below_threshold when totalRetries < threshold",
    async () => {
      await configure({ enabled: true, totalRetriesThreshold: 10 });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __testHelpers.setDispatcherForTests(fn);

      const r = await evaluateWindowForRetryPressure({
        jobId: JOB_ID,
        checkpoint: makeWindow("w1", { totalRetries: 9 }),
      });
      assert.equal(r.decision, "skipped_below_threshold");
      assert.equal(r.alerted, false);
      assert.equal(r.totalRetries, 9);
      assert.equal(r.threshold, 10);
      assert.equal(calls.length, 0);
    },
  );

  await step(
    "per-window: alerted when threshold crossed, then skipped_already_alerted on re-eval",
    async () => {
      await configure({ enabled: true, totalRetriesThreshold: 10 });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __testHelpers.setDispatcherForTests(fn);

      const cp = makeWindow("w1", {
        totalRetries: 12,
        retriesByReason: { front_502: 12 },
      });

      const first = await evaluateWindowForRetryPressure({
        jobId: JOB_ID,
        checkpoint: cp,
      });
      assert.equal(first.decision, "alerted");
      assert.equal(first.alerted, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].options.dedupeKey, `${JOB_ID}|w1`);

      const second = await evaluateWindowForRetryPressure({
        jobId: JOB_ID,
        checkpoint: cp,
      });
      assert.equal(second.decision, "skipped_already_alerted");
      assert.equal(second.alerted, false);
      assert.equal(calls.length, 1);
    },
  );

  await step(
    "per-window: skipped_dispatcher_skipped when dispatcher reports not delivered",
    async () => {
      await configure({ enabled: true, totalRetriesThreshold: 10 });
      const { fn, calls } = makeDispatcher({
        delivered: false,
        status: "skipped_deduped",
        skipReason: "dispatcher dedupe",
      });
      __testHelpers.setDispatcherForTests(fn);

      const r = await evaluateWindowForRetryPressure({
        jobId: JOB_ID,
        checkpoint: makeWindow("w1", { totalRetries: 50 }),
      });
      assert.equal(r.decision, "skipped_dispatcher_skipped");
      assert.equal(r.alerted, false);
      assert.equal(r.skipReason, "dispatcher dedupe");
      assert.equal(calls.length, 1);
    },
  );

  // ---- evaluateWindowForSuppressionDominance (Task #1903) ----------------

  await step(
    "suppression dominance: skipped_disabled when alert turned off",
    async () => {
      await configure({ suppressionDominanceEnabled: false });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __testHelpers.setDispatcherForTests(fn);
      const r = await evaluateWindowForSuppressionDominance({
        jobId: JOB_ID,
        checkpoint: makeWindow("w-disabled", {
          pages: 20,
          retriesByReason: { same_response_suppressed: 20 },
        }),
      });
      assert.equal(r.decision, "skipped_disabled");
      assert.equal(r.alerted, false);
      assert.equal(calls.length, 0);
    },
  );

  await step(
    "suppression dominance: skipped_below_min_pages when window has too few pages",
    async () => {
      await configure({
        suppressionDominanceEnabled: true,
        suppressionDominanceRatio: 0.25,
        suppressionDominanceMinPages: 8,
      });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __testHelpers.setDispatcherForTests(fn);
      const r = await evaluateWindowForSuppressionDominance({
        jobId: JOB_ID,
        checkpoint: makeWindow("w-tiny", {
          pages: 3,
          retriesByReason: { same_response_suppressed: 3 },
        }),
      });
      assert.equal(r.decision, "skipped_below_min_pages");
      assert.equal(r.alerted, false);
      assert.equal(calls.length, 0);
    },
  );

  await step(
    "suppression dominance: skipped_below_ratio when suppression is healthy share",
    async () => {
      await configure({
        suppressionDominanceEnabled: true,
        suppressionDominanceRatio: 0.25,
        suppressionDominanceMinPages: 8,
      });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __testHelpers.setDispatcherForTests(fn);
      const r = await evaluateWindowForSuppressionDominance({
        jobId: JOB_ID,
        checkpoint: makeWindow("w-healthy", {
          pages: 20,
          retriesByReason: { same_response_suppressed: 2 },
        }),
      });
      assert.equal(r.decision, "skipped_below_ratio");
      assert.equal(r.alerted, false);
      assert.equal(calls.length, 0);
    },
  );

  await step(
    "suppression dominance: alerted when ratio + min pages cross — uses new notification id",
    async () => {
      await configure({
        suppressionDominanceEnabled: true,
        suppressionDominanceRatio: 0.25,
        suppressionDominanceMinPages: 8,
      });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __testHelpers.setDispatcherForTests(fn);
      const r = await evaluateWindowForSuppressionDominance({
        jobId: JOB_ID,
        checkpoint: makeWindow("w-hot", {
          pages: 20,
          retriesByReason: { same_response_suppressed: 10 },
        }),
      });
      assert.equal(r.decision, "alerted");
      assert.equal(r.alerted, true);
      assert.equal(r.suppressedPages, 10);
      assert.equal(r.pages, 20);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].id, SUPPRESSION_DOMINANCE_NOTIFICATION_ID);
      assert.match(calls[0].payload.text, /same-response suppression/i);
      assert.equal(calls[0].options.dedupeKey, `suppression|${JOB_ID}|w-hot`);
    },
  );

  await step(
    "suppression dominance: dedupes per (jobId, windowLabel) — second call is skipped_already_alerted",
    async () => {
      await configure({
        suppressionDominanceEnabled: true,
        suppressionDominanceRatio: 0.25,
        suppressionDominanceMinPages: 4,
      });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __testHelpers.setDispatcherForTests(fn);
      const cp = makeWindow("w-dup", {
        pages: 10,
        retriesByReason: { same_response_suppressed: 5 },
      });
      const first = await evaluateWindowForSuppressionDominance({
        jobId: JOB_ID,
        checkpoint: cp,
      });
      assert.equal(first.decision, "alerted");
      const second = await evaluateWindowForSuppressionDominance({
        jobId: JOB_ID,
        checkpoint: cp,
      });
      assert.equal(second.decision, "skipped_already_alerted");
      assert.equal(calls.length, 1);
    },
  );

  // ---- evaluateEmptySuffixDedupeKeys (Task #1903 sibling) ----------------

  await step(
    "empty-suffix probe: skipped_disabled when feature flag is off",
    async () => {
      await configure({ emptySuffixEnabled: false });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __testHelpers.setDispatcherForTests(fn);
      __testHelpers.setEmptySuffixCounterForTests(async () => 42);
      const r = await evaluateEmptySuffixDedupeKeys({
        jobId: JOB_ID,
        windowLabel: "w-off",
      });
      assert.equal(r.decision, "skipped_disabled");
      assert.equal(calls.length, 0);
      __testHelpers.setEmptySuffixCounterForTests(null);
    },
  );

  await step(
    "empty-suffix probe: skipped_clean when no offending rows exist",
    async () => {
      await configure({ emptySuffixEnabled: true });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __testHelpers.setDispatcherForTests(fn);
      __testHelpers.setEmptySuffixCounterForTests(async () => 0);
      const r = await evaluateEmptySuffixDedupeKeys({
        jobId: JOB_ID,
        windowLabel: "w-clean",
      });
      assert.equal(r.decision, "skipped_clean");
      assert.equal(r.alerted, false);
      assert.equal(r.emptySuffixCount, 0);
      assert.equal(calls.length, 0);
      __testHelpers.setEmptySuffixCounterForTests(null);
    },
  );

  await step(
    "empty-suffix probe: alerted when probe returns > 0; reused notification id",
    async () => {
      await configure({ emptySuffixEnabled: true });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __testHelpers.setDispatcherForTests(fn);
      __testHelpers.setEmptySuffixCounterForTests(async () => 7);
      const r = await evaluateEmptySuffixDedupeKeys({
        jobId: JOB_ID,
        windowLabel: "w-bad",
      });
      assert.equal(r.decision, "alerted");
      assert.equal(r.alerted, true);
      assert.equal(r.emptySuffixCount, 7);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].id, SUPPRESSION_DOMINANCE_NOTIFICATION_ID);
      assert.match(calls[0].payload.text, /empty-suffix/i);
      __testHelpers.setEmptySuffixCounterForTests(null);
    },
  );

  await step(
    "empty-suffix probe: skipped_probe_failed surfaces error without throwing",
    async () => {
      await configure({ emptySuffixEnabled: true });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __testHelpers.setDispatcherForTests(fn);
      __testHelpers.setEmptySuffixCounterForTests(async () => {
        throw new Error("boom");
      });
      const r = await evaluateEmptySuffixDedupeKeys({
        jobId: JOB_ID,
        windowLabel: "w-probe-fail",
      });
      assert.equal(r.decision, "skipped_probe_failed");
      assert.equal(r.alerted, false);
      assert.match(r.skipReason ?? "", /boom/);
      assert.equal(calls.length, 0);
      __testHelpers.setEmptySuffixCounterForTests(null);
    },
  );

  await step(
    "empty-suffix probe: dedupes per (jobId, windowLabel)",
    async () => {
      await configure({ emptySuffixEnabled: true });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __testHelpers.setDispatcherForTests(fn);
      __testHelpers.setEmptySuffixCounterForTests(async () => 3);
      const first = await evaluateEmptySuffixDedupeKeys({
        jobId: JOB_ID,
        windowLabel: "w-dup",
      });
      assert.equal(first.decision, "alerted");
      const second = await evaluateEmptySuffixDedupeKeys({
        jobId: JOB_ID,
        windowLabel: "w-dup",
      });
      assert.equal(second.decision, "skipped_already_alerted");
      assert.equal(calls.length, 1);
      __testHelpers.setEmptySuffixCounterForTests(null);
    },
  );

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exitCode = 1;
  }
  console.log("\nAll Front recovery retry alert tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch((err) => {
    console.error("Test runner crashed:", err);
    process.exitCode = 1;
  });
