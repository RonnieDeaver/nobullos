/* test-registration
{
  "name": "Connection-lost tracker policy — ok→lost→recovered state machine, outage-window-only probe scheduling, SSE-style backoff growth/cap/jitter bounds, recovery refetch targets only errored active queries (Task #4791)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4791: this state machine is the only thing standing between a network blip and the old broken UX (a destructive toast lingering ~17 minutes plus errored pages until a manual reload). Drift in the entry/recovery transitions, the outage-window-only probe guarantee (an always-on probe would be unapproved always-on server load), the backoff cap, or the errored-query refetch predicate silently breaks the connection-lost lifecycle app-wide. Pure in-memory suite (injected timers/probe/RNG — no DB, no DOM, milliseconds).",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4791 — pure-logic coverage of client/src/lib/connectionLost.ts via
 * the factory with fully injected deps (manual timer registry, scripted
 * probe, fixed RNG). No jsdom, no network, no shared singleton state: every
 * section builds a fresh tracker.
 *
 * Contracts pinned here:
 *   1. nextConnectionProbeDelayMs — quick first probe, then 5s·2^(n−1)
 *      capped at 120s, ±20% jitter applied AFTER the cap (sseReconnect shape).
 *   2. Probes are scheduled ONLY while phase === "lost" (outage-window-only:
 *      exactly one pending probe timer during an outage, zero otherwise).
 *   3. Probe success / successful request / "online" all recover; recovery
 *      cancels the pending probe, refetches ONLY errored active queries
 *      (status-only predicate — meta.silent deliberately included), and
 *      schedules the recovered→ok confirmation.
 *   4. Re-entry during "recovered" restarts a fresh outage window.
 *   5. reset() (test seam) cancels everything and returns to ok.
 */
import assert from "node:assert/strict";
import {
  CONNECTION_PROBE_BACKOFF_MAX_MS,
  CONNECTION_PROBE_INITIAL_DELAY_MS,
  CONNECTION_RECOVERED_CONFIRMATION_MS,
  createConnectionLostTracker,
  nextConnectionProbeDelayMs,
} from "../client/src/lib/connectionLost";

interface FakeTimer {
  fn: () => void;
  delayMs: number;
  cancelled: boolean;
  fired: boolean;
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function makeHarness(probeScript: Array<"ok" | "reject"> = []) {
  const timers: FakeTimer[] = [];
  const script = [...probeScript];
  let probeCalls = 0;
  const refetchCalls: Array<{ type?: string; predicate?: (q: unknown) => boolean }> = [];
  const tracker = createConnectionLostTracker({
    schedule: (fn, delayMs) => {
      const t: FakeTimer = { fn, delayMs, cancelled: false, fired: false };
      timers.push(t);
      return t;
    },
    cancel: (handle) => {
      (handle as FakeTimer).cancelled = true;
    },
    probe: async () => {
      probeCalls++;
      const verdict = script.length > 0 ? script.shift()! : "reject";
      if (verdict === "reject") throw new TypeError("Failed to fetch");
      // ANY HTTP response counts as reachable — model a 503 boot-gate reply.
      return { ok: false, status: 503 };
    },
    // Jitter factor exactly 1.0 → delays are the exact schedule values.
    random: () => 0.5,
  });
  tracker.bindQueryClient({
    refetchQueries: ((filters: { type?: string; predicate?: (q: unknown) => boolean }) => {
      refetchCalls.push(filters);
      return Promise.resolve();
    }) as never,
  });
  return {
    tracker,
    timers,
    refetchCalls,
    getProbeCalls: () => probeCalls,
    active: () => timers.filter((t) => !t.cancelled && !t.fired),
    async fire(t: FakeTimer): Promise<void> {
      assert.ok(!t.cancelled, "firing a cancelled timer — test bug");
      t.fired = true;
      t.fn();
      await drainMicrotasks();
    },
  };
}

async function run(): Promise<void> {
  // ── 1. Backoff schedule math ───────────────────────────────────────────────
  {
    const mid = () => 0.5;
    assert.equal(
      nextConnectionProbeDelayMs(0, mid),
      CONNECTION_PROBE_INITIAL_DELAY_MS,
      "attempt 0 = quick initial delay",
    );
    assert.equal(nextConnectionProbeDelayMs(1, mid), 5_000, "attempt 1 = base 5s");
    assert.equal(nextConnectionProbeDelayMs(2, mid), 10_000, "attempt 2 doubles");
    assert.equal(nextConnectionProbeDelayMs(3, mid), 20_000, "attempt 3 doubles again");
    assert.equal(nextConnectionProbeDelayMs(6, mid), CONNECTION_PROBE_BACKOFF_MAX_MS,
      "attempt 6 hits the 120s cap (5s·2^5 = 160s → cap)");
    assert.equal(nextConnectionProbeDelayMs(40, mid), CONNECTION_PROBE_BACKOFF_MAX_MS,
      "deep attempts stay capped (no overflow growth)");
    // Jitter bounds: uniform in [0.8, 1.2] of the (capped) base.
    assert.equal(nextConnectionProbeDelayMs(0, () => 0), 1_600, "initial lower jitter bound");
    assert.equal(nextConnectionProbeDelayMs(0, () => 1), 2_400, "initial upper jitter bound");
    assert.equal(nextConnectionProbeDelayMs(6, () => 0), 96_000, "capped lower jitter bound");
    assert.equal(nextConnectionProbeDelayMs(6, () => 1), 144_000, "capped upper jitter bound");
    console.log("  ✓ backoff schedule: initial, doubling, cap, jitter bounds");
  }

  // ── 2. Entry — one outage window, one pending probe, cause updates ────────
  {
    const h = makeHarness();
    assert.deepEqual(h.tracker.getState(), { phase: "ok", cause: null, probeAttempts: 0 });
    assert.equal(h.active().length, 0, "ok phase: zero pending timers (outage-window-only)");

    let notified = 0;
    const unsubscribe = h.tracker.subscribe(() => notified++);
    h.tracker.reportConnectionLost("network");
    assert.equal(h.tracker.getState().phase, "lost");
    assert.equal(h.tracker.getState().cause, "network");
    assert.equal(notified, 1, "subscribers notified on entry");
    assert.equal(h.active().length, 1, "exactly one pending probe timer");
    assert.equal(h.active()[0].delayMs, CONNECTION_PROBE_INITIAL_DELAY_MS);

    h.tracker.reportConnectionLost("network");
    assert.equal(h.active().length, 1, "duplicate report: no extra timer");
    assert.equal(notified, 1, "duplicate report with same cause: no re-notify");

    h.tracker.reportConnectionLost("offline");
    assert.equal(h.tracker.getState().cause, "offline", "cause upgrades in place");
    assert.equal(h.tracker.getState().probeAttempts, 0, "cause upgrade keeps the window");
    assert.equal(h.active().length, 1, "cause upgrade: still one timer");
    unsubscribe();
    console.log("  ✓ entry: single outage window, single probe timer, cause upgrade");
  }

  // ── 3. Failed probes grow the backoff to the cap ──────────────────────────
  {
    const h = makeHarness(["reject", "reject", "reject", "reject", "reject", "reject", "reject"]);
    h.tracker.reportConnectionLost("network");
    const expected = [5_000, 10_000, 20_000, 40_000, 80_000, 120_000, 120_000];
    for (let i = 0; i < expected.length; i++) {
      await h.fire(h.active()[0]);
      assert.equal(h.tracker.getState().phase, "lost", `still lost after failed probe ${i + 1}`);
      assert.equal(h.tracker.getState().probeAttempts, i + 1, `probeAttempts counts failure ${i + 1}`);
      assert.equal(h.active().length, 1, "always exactly one rescheduled probe");
      assert.equal(h.active()[0].delayMs, expected[i], `next delay after failure ${i + 1}`);
    }
    assert.equal(h.getProbeCalls(), expected.length, "one probe call per fired timer");
    assert.equal(h.refetchCalls.length, 0, "no refetch while still lost");
    console.log("  ✓ failed probes: doubling reschedule up to the 120s cap");
  }

  // ── 4. Probe success (any HTTP status) → recovered → confirmation → ok ────
  {
    const h = makeHarness(["ok"]);
    h.tracker.reportConnectionLost("network");
    await h.fire(h.active()[0]);
    assert.deepEqual(h.tracker.getState(), { phase: "recovered", cause: null, probeAttempts: 0 });
    assert.equal(h.refetchCalls.length, 1, "recovery refetches exactly once");
    const filters = h.refetchCalls[0];
    assert.equal(filters.type, "active", "refetch targets ACTIVE queries only");
    assert.ok(filters.predicate, "refetch uses a predicate");
    assert.equal(filters.predicate!({ state: { status: "error" } }), true,
      "predicate matches errored queries (status-only — silent included)");
    assert.equal(filters.predicate!({ state: { status: "success" } }), false,
      "predicate skips healthy queries");
    assert.equal(filters.predicate!({ state: { status: "pending" } }), false,
      "predicate skips in-flight queries");
    assert.equal(h.active().length, 1, "only the confirmation timer remains");
    assert.equal(h.active()[0].delayMs, CONNECTION_RECOVERED_CONFIRMATION_MS);
    await h.fire(h.active()[0]);
    assert.equal(h.tracker.getState().phase, "ok", "confirmation clears to ok");
    assert.equal(h.active().length, 0, "ok phase: zero pending timers again");
    console.log("  ✓ probe success (503 counts): recovered → refetch errored-active → ok");
  }

  // ── 5. Recovery via successful request / online cancels the pending probe ─
  {
    for (const trigger of ["request", "online"] as const) {
      const h = makeHarness();
      h.tracker.reportConnectionLost("network");
      const probeTimer = h.active()[0];
      h.tracker.reportServerReachable(trigger);
      assert.equal(h.tracker.getState().phase, "recovered", `${trigger}: recovers`);
      assert.equal(probeTimer.cancelled, true, `${trigger}: pending probe cancelled`);
      assert.equal(h.getProbeCalls(), 0, `${trigger}: no probe ever ran`);
      assert.equal(h.refetchCalls.length, 1, `${trigger}: errored queries refetched`);
    }
    console.log("  ✓ request/online recovery: probe cancelled, refetch fired");
  }

  // ── 6. Reachability reports outside an outage are no-ops ──────────────────
  {
    const h = makeHarness();
    h.tracker.reportServerReachable("request");
    assert.equal(h.tracker.getState().phase, "ok", "ok stays ok");
    assert.equal(h.refetchCalls.length, 0, "no refetch outside an outage window");
    assert.equal(h.timers.length, 0, "no timers outside an outage window");
    console.log("  ✓ reachable-while-ok: pure no-op (no refetch storm on every success)");
  }

  // ── 7. Relapse during the recovered confirmation restarts a fresh window ──
  {
    const h = makeHarness();
    h.tracker.reportConnectionLost("network");
    h.tracker.reportServerReachable("request");
    const confirmation = h.active()[0];
    assert.equal(confirmation.delayMs, CONNECTION_RECOVERED_CONFIRMATION_MS);
    h.tracker.reportConnectionLost("network");
    assert.equal(h.tracker.getState().phase, "lost", "relapse re-enters lost");
    assert.equal(h.tracker.getState().probeAttempts, 0, "fresh window: attempts reset");
    assert.equal(confirmation.cancelled, true, "stale confirmation cancelled");
    assert.equal(h.active().length, 1, "fresh quick probe scheduled");
    assert.equal(h.active()[0].delayMs, CONNECTION_PROBE_INITIAL_DELAY_MS);
    console.log("  ✓ relapse during recovered: confirmation cancelled, fresh window");
  }

  // ── 8. reset() test seam ───────────────────────────────────────────────────
  {
    const h = makeHarness();
    h.tracker.reportConnectionLost("offline");
    h.tracker.reset();
    assert.deepEqual(h.tracker.getState(), { phase: "ok", cause: null, probeAttempts: 0 });
    assert.equal(h.active().length, 0, "reset cancels all pending timers");
    console.log("  ✓ reset(): timers cancelled, back to ok");
  }
}

run()
  .then(() => {
    console.log("\nPASS tests/connection-lost-policy.test.ts");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nFAIL tests/connection-lost-policy.test.ts");
    console.error(err);
    process.exit(1);
  });
