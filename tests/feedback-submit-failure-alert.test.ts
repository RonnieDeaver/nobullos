/* test-registration
{
  "name": "Feedback submit 5xx ops alert (Task #4789)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4789: pins the operator-visibility contract for POST /api/feedback server errors. The requestMetricsAlerts evaluator is structurally blind to low-volume routes (requires ≥30 req/10-min); this dedicated alert fires immediately on any 5xx in the feedback route catch block. DB-free, dispatcher-override.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4789 — feedbackSubmitFailureAlert.ts contract.
 *
 * The alert fires when the route's catch block calls alertFeedbackSubmitFailure.
 * It must:
 *   1. Dispatch to the correct notification id.
 *   2. Use a day-scoped dedupeKey (feedback:submit:5xx:YYYY-MM-DD).
 *   3. Include the error message in the alert text.
 *   4. Never throw (fire-and-forget; dispatcher errors are swallowed).
 */
import "./helpers/forceTestEnv";
import assert from "node:assert/strict";
import {
  alertFeedbackSubmitFailure,
  buildDedupeKey,
  NOTIFICATION_ID,
  __testHelpers,
} from "../server/services/feedbackSubmitFailureAlert";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok  ${name}`);
    })
    .catch((err: any) => {
      failed++;
      console.error(`  FAIL ${name}:`, err?.message ?? err);
    });
}

async function run() {
  console.log("Feedback submit 5xx ops alert (Task #4789)");

  // 1. buildDedupeKey returns a stable day-scoped key.
  // future-date-literal-reviewed: 2026-08-15 (and 2026-08-14) are literal-vs-literal — buildDedupeKey is fed a PINNED epoch (new Date("…Z").getTime()), never NOW(), so the expected key can never rot when the calendar passes these dates.
  await check("buildDedupeKey is day-scoped (YYYY-MM-DD)", () => {
    const key = buildDedupeKey(new Date("2026-08-14T16:07:37Z").getTime());
    assert.equal(key, "feedback:submit:5xx:2026-08-14");
  });

  // future-date-literal-reviewed: the 2026-08-15 literals below are pinned
  // Date inputs (new Date("2026-08-15T00:00:00Z")) asserted against the
  // matching literal key string "feedback:submit:5xx:2026-08-15" — a
  // literal-vs-literal UTC day-rollover comparison that cannot rot when the
  // date passes (no NOW()-relative or future/overdue semantics involved).
  // 2. buildDedupeKey changes on UTC day rollover.
  // future-date-literal-reviewed: 2026-08-15 (and the 2026-08-14 pair) are pinned
  // epoch inputs to buildDedupeKey compared literal-vs-literal against the derived
  // day key — no now()-relative assertion, so they cannot rot. (Marker added as a
  // base repair during Task #4790's gate: this file landed with upstream Task #4789
  // after the 2026-08-13 red manifest, so the calendar-fixture lint flagged it as
  // an unreviewed future literal on every branch.)
  await check("buildDedupeKey changes on UTC day boundary", () => {
    const key1 = buildDedupeKey(new Date("2026-08-14T23:59:59Z").getTime());
    const key2 = buildDedupeKey(new Date("2026-08-15T00:00:00Z").getTime());
    assert.equal(key1, "feedback:submit:5xx:2026-08-14");
    assert.equal(key2, "feedback:submit:5xx:2026-08-15");
    assert.notEqual(key1, key2);
  });

  // 3. alertFeedbackSubmitFailure dispatches to the correct notification id
  //    with the right dedupeKey and error text.
  await check("dispatches correct id + dedupeKey + error text", async () => {
    const dispatchCalls: Array<[string, { text: string; preview?: unknown }, Record<string, unknown>]> = [];
    __testHelpers.setDispatcherForTests(async (id, payload, options) => {
      dispatchCalls.push([id, payload, options]);
      return { delivered: true };
    });

    try {
      await alertFeedbackSubmitFailure(new Error("DB pool exhausted"), {
        userId: "u-test-123",
        page: "/booking/settings",
      });

      assert.equal(dispatchCalls.length, 1, "exactly one dispatch call");
      const [id, payload, options] = dispatchCalls[0];
      assert.equal(id, NOTIFICATION_ID, `expected ${NOTIFICATION_ID}, got ${id}`);
      assert.ok(payload.text.includes("DB pool exhausted"), "error message in alert text");
      assert.ok(payload.text.includes("/booking/settings"), "page in alert text");
      assert.ok(
        (options.dedupeKey as string).startsWith("feedback:submit:5xx:"),
        `dedupeKey should be day-scoped, got: ${options.dedupeKey}`,
      );
    } finally {
      __testHelpers.setDispatcherForTests(null);
    }
  });

  // 4. alertFeedbackSubmitFailure never throws even when the dispatcher throws.
  await check("never throws when dispatcher errors", async () => {
    __testHelpers.setDispatcherForTests(async () => {
      throw new Error("Dispatcher unavailable");
    });
    try {
      // Should resolve without throwing.
      await assert.doesNotReject(
        alertFeedbackSubmitFailure(new Error("route error"), {}),
      );
    } finally {
      __testHelpers.setDispatcherForTests(null);
    }
  });

  console.log(`\nTest run: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void run().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
