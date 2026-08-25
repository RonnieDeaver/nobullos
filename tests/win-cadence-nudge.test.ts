/* test-registration
{
  "name": "Weekly win-cadence nudge evaluator (Task #4888)",
  "regression": true,
  "sweepOnlyReason": "Task #4888 — win-cadence nudge for account managers: hermetic injected-deps suite (no DB) pinning closed-week selection, week+user-scoped dedupe keys, the durable per-week ledger (no duplicate person+week nudges across re-runs/restarts, partial-failure retry of only the failed recipients), team-lead summaries, lock-contention skip, and test-inert scheduler start; runs in the full sweep, not the smoke gate.",
  "tier": "small"
}
test-registration */
/**
 * Task #4888 — weekly win-cadence nudge (account managers who miss the
 * "at least 1 win/week" target get a bell nudge after the UTC week closes;
 * team leads get one summary row).
 *
 * All layers use injected deps (no DB): the module's contract with
 * computeWinTrackingReport / notification_health_state / notifyUser is
 * exercised through the same deps seam production uses, with an in-memory
 * state store mirroring upsertHealthState semantics.
 *
 * Layers:
 *  A. Closed-week selection + week-stamp math.
 *  B. Targeting: only AMs with zero counted wins in the CLOSED week are
 *     nudged (met AMs, non-AM roles skipped); dedupe keys are week+user
 *     scoped, never constant; deep link points at the tracker page.
 *  C. Idempotence over durable state: a second pass for the same week is a
 *     no-op (alreadyComplete), a module-state reset (= restart) with the
 *     durable row intact still doesn't re-nudge, and a NEW closed week
 *     produces fresh rows under a new stamp.
 *  D. Partial failure: a failed notify keeps the week open; the retry pass
 *     re-sends ONLY the failed recipient (ledger skips the delivered ones).
 *  E. Team-lead summary: one row per lead naming the misses; none when
 *     nobody missed (but the week still completes so passes stay cheap).
 *  F. Lock-guarded periodic pass: contention (null lock) skips evaluation
 *     entirely; a held lock is always released, even when evaluation is
 *     reached; start is test-inert under the test runner.
 */
import "./helpers/forceTestEnv";
import assert from "node:assert/strict";
import {
  evaluateWinCadence,
  runWinCadenceNudgePassOnce,
  startWinCadenceNudgeScheduler,
  stopWinCadenceNudgeScheduler,
  winCadenceWeekStamp,
  WIN_CADENCE_INBOX_DEDUPE_PREFIX,
  WIN_CADENCE_SUMMARY_DEDUPE_PREFIX,
  WIN_CADENCE_PAGE_PATH,
  __setWinCadenceDepsForTest,
  __resetWinCadenceDepsForTest,
} from "../server/services/notifications/winCadenceNudge";
import {
  getUtcWeekStart,
  buildTrailingWeekStarts,
  type WinTrackingReport,
  type WinTrackingMember,
} from "../server/storage/internalUsageStorage";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// ── In-memory mirrors of the injected surfaces ─────────────────────────────

type StateRow = { state: string; metadataJson: any; lastNotifiedAt?: Date | null };

function makeHarness(now: Date, report: WinTrackingReport) {
  let stateRow: StateRow | undefined;
  const notifies: Array<{ userId: string; opts: any }> = [];
  const failFor = new Set<string>();
  __setWinCadenceDepsForTest({
    computeReport: async () => report,
    getState: async () => stateRow as any,
    upsertState: async (patch) => {
      // Mirror upsertHealthState preserve-on-undefined semantics.
      stateRow = {
        state: patch.state,
        metadataJson:
          patch.metadataJson !== undefined ? patch.metadataJson : stateRow?.metadataJson,
        lastNotifiedAt:
          patch.lastNotifiedAt !== undefined ? patch.lastNotifiedAt : stateRow?.lastNotifiedAt,
      };
      return stateRow;
    },
    notifyUser: async (userId, opts) => {
      if (failFor.has(userId)) throw new Error(`injected notify failure for ${userId}`);
      notifies.push({ userId, opts });
      return { notification: { id: `n-${notifies.length}` }, deduped: false };
    },
  });
  return {
    notifies,
    failFor,
    getStateRow: () => stateRow,
    setStateRow: (r: StateRow | undefined) => {
      stateRow = r;
    },
  };
}

function member(
  userId: string,
  role: string,
  countsByWeekIdx: Record<number, number>,
  weekCount: number,
): WinTrackingMember {
  const weeks = Array.from({ length: weekCount }, (_, i) => {
    const count = countsByWeekIdx[i] ?? 0;
    return { count, met: role === "account_manager" ? count > 0 : null };
  });
  return {
    userId,
    firstName: userId.toUpperCase(),
    lastName: "Test",
    email: `${userId}@example.com`,
    role,
    isAccountManager: role === "account_manager",
    weeks,
    total: weeks.reduce((s, w) => s + w.count, 0),
  };
}

function makeReport(now: Date, members: WinTrackingMember[]): WinTrackingReport {
  const starts = buildTrailingWeekStarts(now);
  return {
    weeks: starts.map((s, i) => ({
      start: s.toISOString(),
      end: new Date(s.getTime() + WEEK_MS).toISOString(),
      isCurrent: i === starts.length - 1,
    })),
    members,
    summary: { accountManagers: 0, metThisWeek: 0 },
    generatedAt: now.toISOString(),
  };
}

async function main() {
  // A fixed "now" mid-week; the closed week is the prior UTC Monday week.
  // future-date-literal-reviewed: 2026-08-19T15:30:00.000Z is a pinned injected
  // simulation clock — every harness/report derives from this `now` (makeHarness/
  // makeReport/buildTrailingWeekStarts) and no assertion compares it to the real
  // clock, so the literal cannot rot when the date passes.
  const now = new Date("2026-08-19T15:30:00.000Z"); // Wednesday
  const currentWeekStart = getUtcWeekStart(now);
  const closedWeekStart = new Date(currentWeekStart.getTime() - WEEK_MS);
  const stamp = winCadenceWeekStamp(closedWeekStart);
  const weekCount = buildTrailingWeekStarts(now).length;
  const closedIdx = weekCount - 2;

  // ── A. Closed-week selection + stamp math ────────────────────────────────
  assert.equal(closedWeekStart.getUTCDay(), 1, "closed week starts on Monday");
  assert.equal(stamp, "20260810", "week stamp is the closed Monday YYYYMMDD");

  // ── B. Targeting + dedupe-key shape ──────────────────────────────────────
  {
    const members = [
      member("am-miss", "account_manager", {}, weekCount), // zero everywhere
      member("am-met", "account_manager", { [closedIdx]: 2 }, weekCount),
      // Missed the closed week but active in the CURRENT week — still a miss
      // for the closed week (the target is per-week).
      member("am-late", "account_manager", { [weekCount - 1]: 3 }, weekCount),
      member("lead-1", "team_lead", {}, weekCount),
      member("ceo-1", "ceo", {}, weekCount),
    ];
    const h = makeHarness(now, makeReport(now, members));
    const res = await evaluateWinCadence(now);
    assert.ok(res && !res.alreadyComplete);
    assert.deepEqual(res!.missedUserIds.sort(), ["am-late", "am-miss"]);
    assert.deepEqual(res!.nudgedUserIds.sort(), ["am-late", "am-miss"]);
    assert.deepEqual(res!.summarizedLeadIds, ["lead-1"]);
    assert.equal(res!.failedUserIds.length, 0);

    const amRows = h.notifies.filter((n) =>
      n.opts.dedupeKey.startsWith(WIN_CADENCE_INBOX_DEDUPE_PREFIX),
    );
    assert.equal(amRows.length, 2);
    for (const r of amRows) {
      assert.equal(
        r.opts.dedupeKey,
        `${WIN_CADENCE_INBOX_DEDUPE_PREFIX}${stamp}:${r.userId}`,
        "AM dedupe key is week+user scoped",
      );
      assert.equal(r.opts.deepLink, WIN_CADENCE_PAGE_PATH);
      assert.equal(r.opts.category, "system");
    }
    const leadRows = h.notifies.filter((n) =>
      n.opts.dedupeKey.startsWith(WIN_CADENCE_SUMMARY_DEDUPE_PREFIX),
    );
    assert.equal(leadRows.length, 1);
    assert.equal(
      leadRows[0].opts.dedupeKey,
      `${WIN_CADENCE_SUMMARY_DEDUPE_PREFIX}${stamp}:lead-1`,
    );
    assert.ok(
      leadRows[0].opts.body.includes("AM-MISS Test") &&
        leadRows[0].opts.body.includes("AM-LATE Test"),
      "lead summary names the misses",
    );
    // Met AM / ceo never notified.
    assert.ok(!h.notifies.some((n) => n.userId === "am-met" || n.userId === "ceo-1"));

    // ── C. Idempotence: same week, second pass is a no-op ─────────────────
    const before = h.notifies.length;
    const res2 = await evaluateWinCadence(now);
    assert.ok(res2?.alreadyComplete, "completed week short-circuits");
    assert.equal(h.notifies.length, before, "no duplicate rows for same person+week");

    // Restart simulation: fresh deps (new process) but the SAME durable row.
    const persisted = h.getStateRow();
    __resetWinCadenceDepsForTest();
    const h2 = makeHarness(now, makeReport(now, members));
    h2.setStateRow(persisted);
    const res3 = await evaluateWinCadence(now);
    assert.ok(res3?.alreadyComplete, "durable stamp survives restart");
    assert.equal(h2.notifies.length, 0);

    // A NEW closed week (advance one week) produces fresh rows, new stamp.
    const nextNow = new Date(now.getTime() + WEEK_MS);
    const h3 = makeHarness(nextNow, makeReport(nextNow, members));
    h3.setStateRow(persisted);
    const res4 = await evaluateWinCadence(nextNow);
    assert.ok(res4 && !res4.alreadyComplete);
    const nextStamp = winCadenceWeekStamp(currentWeekStart);
    assert.ok(
      h3.notifies.every((n) => n.opts.dedupeKey.includes(`:${nextStamp}:`) || n.opts.dedupeKey.includes(`${nextStamp}:`)),
      "new week uses a new stamp in every key",
    );
    assert.equal(res4!.nudgedUserIds.length, 2);
  }

  // ── D. Partial failure keeps the week open; retry sends only the failed ──
  {
    const members = [
      member("am-a", "account_manager", {}, weekCount),
      member("am-b", "account_manager", {}, weekCount),
    ];
    const h = makeHarness(now, makeReport(now, members));
    h.failFor.add("am-b");
    const res = await evaluateWinCadence(now);
    assert.deepEqual(res!.nudgedUserIds, ["am-a"]);
    assert.deepEqual(res!.failedUserIds, ["am-b"]);
    assert.notEqual(
      h.getStateRow()!.metadataJson.completedWeekStart,
      closedWeekStart.toISOString(),
      "week not stamped complete while a recipient is missing",
    );

    h.failFor.delete("am-b");
    const res2 = await evaluateWinCadence(now);
    assert.ok(res2 && !res2.alreadyComplete);
    assert.deepEqual(res2!.nudgedUserIds, ["am-b"], "retry sends ONLY the failed recipient");
    assert.equal(
      h.notifies.filter((n) => n.userId === "am-a").length,
      1,
      "delivered recipient never re-nudged (ledger skip)",
    );
    assert.equal(
      h.getStateRow()!.metadataJson.completedWeekStart,
      closedWeekStart.toISOString(),
      "week stamps complete once everyone succeeded",
    );

    const res3 = await evaluateWinCadence(now);
    assert.ok(res3?.alreadyComplete);
  }

  // ── E. Zero misses: no rows at all, but the week completes ───────────────
  {
    const members = [
      member("am-good", "account_manager", { [closedIdx]: 1 }, weekCount),
      member("lead-1", "team_lead", {}, weekCount),
    ];
    const h = makeHarness(now, makeReport(now, members));
    const res = await evaluateWinCadence(now);
    assert.equal(h.notifies.length, 0, "no nudges and no lead summary when nobody missed");
    assert.equal(res!.missedUserIds.length, 0);
    assert.equal(
      h.getStateRow()!.metadataJson.completedWeekStart,
      closedWeekStart.toISOString(),
    );
  }

  // ── F. Lock-guarded pass + test-inert start ──────────────────────────────
  {
    const members = [member("am-miss", "account_manager", {}, weekCount)];
    const h = makeHarness(now, makeReport(now, members));

    // Contention: lock unavailable → no evaluation, no rows.
    __setWinCadenceDepsForTest({ acquireEvaluatorLock: async () => null });
    const skipped = await runWinCadenceNudgePassOnce({ now });
    assert.equal(skipped, null, "contended pass skips");
    assert.equal(h.notifies.length, 0);

    // Held lock: evaluation runs, lock is released exactly once.
    let releases = 0;
    __setWinCadenceDepsForTest({
      acquireEvaluatorLock: async () => ({
        release: async () => {
          releases += 1;
        },
      }),
    });
    const ran = await runWinCadenceNudgePassOnce({ now });
    assert.ok(ran && ran.nudgedUserIds.includes("am-miss"));
    assert.equal(releases, 1, "lock released after the pass");

    // Test-inert start: under the test runner the interval never arms and
    // no boot pass fires (notify count unchanged).
    const before = h.notifies.length;
    startWinCadenceNudgeScheduler();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(h.notifies.length, before, "scheduler start is test-inert");
    stopWinCadenceNudgeScheduler();
  }

  __resetWinCadenceDepsForTest();
  console.log("win-cadence-nudge tests passed");
}

main().then(
  () => {
    // no process.exit(): let the loop drain naturally (pool-exit convention).
  },
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
