/* test-registration
{
  "name": "Slack sustained-outage detector + escalation (Task #4645)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4645: the sustained Slack-outage detector is the alarm-for-the-alarms — prod Slack alerting sat at 100% channel_not_found for weeks while the per-channel self-alert collapsed into one buried unread bell row (audits/slack-outage-diagnosis-2026-08-12.md). This suite pins the lifecycle: open at the min-attempts/failure-rate/24h-streak thresholds, day-counted daily re-alert to responsible admins with day+instance-scoped dedupe keys, durable state that survives restarts, skipped statuses (kill switch) as non-observations, auto-close on recovery, the test-inert default that protects sibling suites' zero-notify asserts, and the cluster-lock-guarded periodic evaluator pass that guarantees the daily cadence even on a quiet or freshly-restarted deployment. A silent drift here means the next total alerting outage goes dark again.",
  "tier": "small"
}
test-registration */
/**
 * Task #4645 — Sustained Slack-outage detector + in-app escalation.
 *
 * Layers:
 *  A. Threshold predicates (all deps injected, no DB): below-min-attempts,
 *     below-failure-rate, too-young streak, boundary open (exactly at the
 *     thresholds, day 1).
 *  B. Streak semantics (injected stats, in-memory state): no duplicate
 *     alert within 24h; daily re-alert with incremented day count and
 *     day-scoped dedupe keys; an all-skipped (kill-switch) lull is a
 *     NON-observation — it neither closes nor re-opens the state.
 *  C. Recovery close + a later fresh outage opens a NEW instance whose
 *     dedupe keys carry a different open-stamp (stale unread rows from a
 *     prior outage can never swallow the new outage's alerts).
 *  D. Durable restart survival against the REAL health-state storage:
 *     state row persists, module-state reset (= process restart) does not
 *     re-alert inside 24h, daily re-alert still fires after, recovery
 *     flips the durable row to healthy.
 *  E. SQL grain of getSlackOutcomeStats against REAL seeded delivery rows:
 *     only success/failed count as observations (skipped_killswitch /
 *     skipped_disabled excluded), failingSince = first failure after the
 *     last success, lastErrorMessage = most recent failure's message.
 *     Seeds are future-dated so ambient rows from sibling suites (always
 *     in the past) cannot interleave with the fixture timeline.
 *  F. Hook wiring + test-inertness: noteSlackDeliveryOutcome and the
 *     console status getter are inert under NODE_ENV=test until a test
 *     opts in; failure-path evaluation is throttled; healthy successes
 *     short-circuit without a DB query.
 *  G. Real notifyUser writes: escalation rows land in user_notifications
 *     for the responsible admins, asserted STRICTLY by dedupe-key prefix +
 *     seeded user ids (never total counts — shared-DB hygiene).
 *  H. Periodic evaluator pass (completion-review hardening): the
 *     cluster-lock-guarded runSlackOutagePeriodicEvaluationOnce opens and
 *     day-N re-alerts from DURABLE state alone — the quiet-deployment /
 *     fresh-restart path where no dispatcher outcome and no console read
 *     ever fires — and skips (null) when a sibling instance holds the lock.
 */

import "./helpers/forceTestEnv";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  evaluateSlackOutage,
  noteSlackDeliveryOutcome,
  getSlackOutageStatusForConsole,
  __setSlackOutageDepsForTest,
  __resetSlackOutageDepsForTest,
  __setSlackOutageTestHookEnabled,
  __resetSlackOutageDetectorStateForTest,
  runSlackOutagePeriodicEvaluationOnce,
  SLACK_OUTAGE_NOTIFICATION_ID,
  SLACK_OUTAGE_STATE_DEDUPE_KEY,
  SLACK_OUTAGE_INBOX_DEDUPE_PREFIX,
  SLACK_OUTAGE_CONSOLE_PATH,
  SLACK_OUTAGE_MIN_ATTEMPTS,
  SLACK_OUTAGE_MIN_STREAK_MS,
  SLACK_OUTAGE_REALERT_INTERVAL_MS,
} from "../server/services/notifications/slackOutageDetector";
import {
  getSlackOutcomeStats,
  getHealthState,
  type SlackOutcomeStats,
} from "../server/storage/notificationsStorage";

const RUN = `t4645-${randomBytes(4).toString("hex")}`;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let failures = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> | void {
  const report = (err?: unknown) => {
    if (err) {
      failures += 1;
      console.error(`✗ ${name}`);
      console.error(`    ${(err as any)?.message ?? err}`);
    } else {
      console.log(`✓ ${name}`);
    }
  };
  try {
    const r = fn();
    if (r instanceof Promise) return r.then(() => report(), report);
    report();
  } catch (err) {
    report(err);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function fakeStats(over: Partial<SlackOutcomeStats>): SlackOutcomeStats {
  return {
    windowFailures: 0,
    windowSuccesses: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
    failingSince: null,
    topFailing: [],
    lastErrorMessage: null,
    ...over,
  };
}

/** In-memory stand-in mirroring upsertHealthState's preserve-on-undefined
 *  semantics, so streak logic can be exercised without the DB. */
function memStateStore() {
  let row: any = undefined;
  return {
    getState: async () => row,
    upsertState: async (patch: any) => {
      const nowd = new Date();
      if (!row) {
        row = {
          id: "mem",
          notificationId: SLACK_OUTAGE_NOTIFICATION_ID,
          dedupeKey: SLACK_OUTAGE_STATE_DEDUPE_KEY,
          state: patch.state,
          failureType: patch.failureType ?? null,
          lastNotifiedAt: patch.lastNotifiedAt ?? null,
          transitionedAt: nowd,
          metadataJson: patch.metadataJson ?? null,
        };
      } else {
        if (patch.state !== undefined && patch.state !== row.state) {
          row.transitionedAt = nowd;
        }
        row = {
          ...row,
          state: patch.state ?? row.state,
          failureType:
            patch.failureType !== undefined ? patch.failureType : row.failureType,
          lastNotifiedAt:
            patch.lastNotifiedAt !== undefined
              ? patch.lastNotifiedAt
              : row.lastNotifiedAt,
          metadataJson:
            patch.metadataJson !== undefined ? patch.metadataJson : row.metadataJson,
        };
      }
      return row;
    },
    peek: () => row,
  };
}

type Sunk = { userId: string; opts: any };

function freshHarness(args?: {
  stats?: SlackOutcomeStats;
  admins?: string[];
  store?: ReturnType<typeof memStateStore>;
  realState?: boolean;
  realNotify?: boolean;
}) {
  __resetSlackOutageDetectorStateForTest();
  __resetSlackOutageDepsForTest();
  const sank: Sunk[] = [];
  const store = args?.store ?? memStateStore();
  let stats = args?.stats ?? fakeStats({});
  let statsCalls = 0;
  const overrides: any = {
    getStats: async () => {
      statsCalls += 1;
      return stats;
    },
    getResponsibleAdmins: async () => args?.admins ?? [`${RUN}-adm1`, `${RUN}-adm2`],
  };
  if (!args?.realState) {
    overrides.getState = store.getState;
    overrides.upsertState = store.upsertState;
  }
  if (!args?.realNotify) {
    overrides.notifyUser = async (userId: string, opts: any) => {
      sank.push({ userId, opts });
      return { id: "sunk" };
    };
  }
  __setSlackOutageDepsForTest(overrides);
  return {
    sank,
    store,
    setStats: (s: SlackOutcomeStats) => {
      stats = s;
    },
    getStatsCalls: () => statsCalls,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(`\nSlack sustained-outage detector tests (${RUN})\n`);
  const now = new Date();

  // ── A. Threshold predicates ────────────────────────────────────────────
  {
    const failing = (over: Partial<SlackOutcomeStats>) =>
      fakeStats({
        windowFailures: 50,
        windowSuccesses: 0,
        lastFailureAt: new Date(now.getTime() - 60_000),
        failingSince: new Date(now.getTime() - 3 * DAY),
        topFailing: [
          { notificationId: "usage.rate_limits.warning", channelId: `C-fake-${RUN}`, failures: 50 },
        ],
        lastErrorMessage: "Slack API error: channel_not_found",
        ...over,
      });

    {
      const h = freshHarness({
        stats: failing({ windowFailures: SLACK_OUTAGE_MIN_ATTEMPTS - 1 }),
      });
      const st = await evaluateSlackOutage({ now });
      await check("below min attempts: stays closed, no alerts", () => {
        assertEq(st.active, false, "active");
        assertEq(h.sank.length, 0, "no notifications");
        assertEq(h.store.peek(), undefined, "no state row written");
      });
    }

    {
      // Physically inconsistent fixture on purpose: isolates the failure-rate
      // predicate (19/21 ≈ 0.905 < 0.95) with the other gates satisfied.
      const h = freshHarness({
        stats: failing({ windowFailures: 19, windowSuccesses: 2 }),
      });
      const st = await evaluateSlackOutage({ now });
      await check("below failure rate: stays closed", () => {
        assertEq(st.active, false, "active");
        assertEq(h.sank.length, 0, "no notifications");
      });
    }

    {
      const h = freshHarness({
        stats: failing({
          failingSince: new Date(now.getTime() - (SLACK_OUTAGE_MIN_STREAK_MS - 60_000)),
        }),
      });
      const st = await evaluateSlackOutage({ now });
      await check("streak younger than 24h: stays closed", () => {
        assertEq(st.active, false, "active");
        assertEq(h.sank.length, 0, "no notifications");
      });
    }

    {
      const h = freshHarness({
        stats: failing({
          windowFailures: SLACK_OUTAGE_MIN_ATTEMPTS,
          failingSince: new Date(now.getTime() - (SLACK_OUTAGE_MIN_STREAK_MS + 5_000)),
        }),
      });
      const st = await evaluateSlackOutage({ now });
      await check("boundary open: exactly min attempts + 24h streak ⇒ day 1 escalation", () => {
        assertEq(st.active, true, "active");
        assertEq(st.dayCount, 1, "dayCount");
        assertEq(h.sank.length, 2, "both responsible admins notified");
        for (const s of h.sank) {
          assert(
            s.opts.dedupeKey?.startsWith(SLACK_OUTAGE_INBOX_DEDUPE_PREFIX),
            `dedupe key has prefix (got ${s.opts.dedupeKey})`,
          );
          assert(/:day1:/.test(s.opts.dedupeKey), `day-scoped key (got ${s.opts.dedupeKey})`);
          assert(s.opts.dedupeKey.endsWith(`:${s.userId}`), "per-user key suffix");
          assertEq(s.opts.deepLink, SLACK_OUTAGE_CONSOLE_PATH, "deep link to the console");
          assert(/day 1/.test(s.opts.title), `title carries day count (got ${s.opts.title})`);
          assert(
            s.opts.body.includes(`C-fake-${RUN}`),
            "body names the failing channel",
          );
          assert(
            /Send test/.test(s.opts.body),
            "body carries plain-language repair instructions",
          );
        }
        const row = h.store.peek();
        assertEq(row?.state, "unhealthy", "durable state opened");
        assert(row?.metadataJson?.openedAt, "openedAt stored");
        assert(row?.metadataJson?.failingSince, "failingSince stored");
      });
    }
  }

  // ── B. Streak semantics: dup-suppress, daily re-alert, non-observation ──
  {
    const failingSince = new Date(now.getTime() - 3 * DAY - 5 * HOUR);
    const stats = fakeStats({
      windowFailures: 120,
      windowSuccesses: 0,
      lastFailureAt: new Date(now.getTime() - 30_000),
      failingSince,
      lastErrorMessage: "Slack API error: channel_not_found",
    });
    const h = freshHarness({ stats });
    const st0 = await evaluateSlackOutage({ now });
    await check("opens with day count derived from failingSince (3d ⇒ day 3)", () => {
      assertEq(st0.active, true, "active");
      assertEq(st0.dayCount, 3, "dayCount");
      assertEq(h.sank.length, 2, "one row per admin");
      assert(h.sank.every((s) => /:day3:/.test(s.opts.dedupeKey)), "day3 keys");
    });

    const st1 = await evaluateSlackOutage({ now: new Date(now.getTime() + HOUR) });
    await check("re-evaluate 1h later: still active, NO duplicate alert", () => {
      assertEq(st1.active, true, "active");
      assertEq(h.sank.length, 2, "sink unchanged");
    });

    const st2 = await evaluateSlackOutage({
      now: new Date(now.getTime() + SLACK_OUTAGE_REALERT_INTERVAL_MS + HOUR),
    });
    await check("25h later: daily re-alert with incremented day count", () => {
      assertEq(st2.active, true, "active");
      assertEq(h.sank.length, 4, "two more rows");
      const fresh = h.sank.slice(2);
      assert(fresh.every((s) => /:day4:/.test(s.opts.dedupeKey)), "day4 keys");
      assert(fresh.every((s) => /day 4/.test(s.opts.title)), "day 4 title");
    });

    // Kill-switch lull: every delivery in the window was skipped ⇒ zero
    // observations. The state must HOLD (no close, no false re-open churn).
    h.setStats(
      fakeStats({
        windowFailures: 0,
        windowSuccesses: 0,
        lastFailureAt: new Date(now.getTime() - 30_000),
        failingSince,
        lastErrorMessage: "Slack API error: channel_not_found",
      }),
    );
    const st3 = await evaluateSlackOutage({
      now: new Date(now.getTime() + SLACK_OUTAGE_REALERT_INTERVAL_MS + 2 * HOUR),
    });
    await check("all-skipped (kill switch) window is a non-observation: state holds open", () => {
      assertEq(st3.active, true, "still active");
      assertEq(h.store.peek()?.state, "unhealthy", "durable state untouched");
      assertEq(h.sank.length, 4, "no extra alert inside the same day");
    });

    // ── C. Recovery close + fresh instance re-open ─────────────────────
    h.setStats(
      fakeStats({
        windowFailures: 2,
        windowSuccesses: 8,
        lastFailureAt: new Date(now.getTime() + 28 * HOUR),
        lastSuccessAt: new Date(now.getTime() + 29 * HOUR),
        failingSince: null,
      }),
    );
    const st4 = await evaluateSlackOutage({ now: new Date(now.getTime() + 30 * HOUR) });
    await check("recovery (success newer than failure) closes the state", () => {
      assertEq(st4.active, false, "inactive");
      assertEq(h.store.peek()?.state, "healthy", "durable state healthy");
      assert(h.store.peek()?.metadataJson?.closedAt, "closedAt recorded");
      assertEq(h.sank.length, 4, "no alert on close");
    });

    const outage2Start = new Date(now.getTime() + 38 * DAY);
    const nowB = new Date(now.getTime() + 41 * DAY);
    h.setStats(
      fakeStats({
        windowFailures: 30,
        windowSuccesses: 0,
        lastFailureAt: new Date(nowB.getTime() - 60_000),
        failingSince: outage2Start,
        lastErrorMessage: "Slack API error: channel_not_found",
      }),
    );
    const st5 = await evaluateSlackOutage({ now: nowB });
    await check("later fresh outage re-opens as a NEW instance (different open-stamp)", () => {
      assertEq(st5.active, true, "active again");
      assertEq(h.sank.length, 6, "fresh day rows");
      const firstStamp = h.sank[0].opts.dedupeKey.split(":")[1];
      const freshStamp = h.sank[4].opts.dedupeKey.split(":")[1];
      assert(
        firstStamp !== freshStamp,
        `new outage instance gets a new stamp (${firstStamp} vs ${freshStamp})`,
      );
      assert(h.sank.slice(4).every((s) => /:day3:/.test(s.opts.dedupeKey)), "day3 of outage #2");
    });
  }

  // ── D. Durable restart survival (REAL health-state storage) ────────────
  {
    const wipeState = () =>
      db.execute(
        sql`DELETE FROM "notification_health_state" WHERE "notification_id" = ${SLACK_OUTAGE_NOTIFICATION_ID}`,
      );
    await wipeState();
    try {
      const failingSince = new Date(now.getTime() - 2 * DAY);
      const stats = fakeStats({
        windowFailures: 40,
        windowSuccesses: 0,
        lastFailureAt: new Date(now.getTime() - 45_000),
        failingSince,
        lastErrorMessage: "Slack API error: channel_not_found",
      });
      const h1 = freshHarness({ stats, realState: true });
      await evaluateSlackOutage({ now });
      await check("durable open: real notification_health_state row written", async () => {
        const row = await getHealthState(
          SLACK_OUTAGE_NOTIFICATION_ID,
          SLACK_OUTAGE_STATE_DEDUPE_KEY,
        );
        assertEq(row?.state, "unhealthy", "state row unhealthy");
        assert(row?.lastNotifiedAt, "lastNotifiedAt stamped");
        assert((row?.metadataJson as any)?.openedAt, "openedAt in metadata");
        assertEq(h1.sank.length, 2, "escalated once");
      });

      // Simulated process restart: module state gone, durable row remains.
      const h2 = freshHarness({ stats, realState: true });
      const stAfterRestart = await evaluateSlackOutage({
        now: new Date(now.getTime() + 2 * HOUR),
      });
      await check("restart survival: active without re-alert inside 24h", () => {
        assertEq(stAfterRestart.active, true, "still active from durable row");
        assertEq(h2.sank.length, 0, "no duplicate alert after restart");
      });

      const stNextDay = await evaluateSlackOutage({
        now: new Date(now.getTime() + SLACK_OUTAGE_REALERT_INTERVAL_MS + 2 * HOUR),
      });
      await check("restart survival: daily re-alert still fires after 24h", () => {
        assertEq(stNextDay.active, true, "active");
        assertEq(h2.sank.length, 2, "day re-alert delivered");
      });

      h2.setStats(
        fakeStats({
          windowFailures: 0,
          windowSuccesses: 5,
          lastFailureAt: new Date(now.getTime() + 20 * HOUR),
          lastSuccessAt: new Date(now.getTime() + 27 * HOUR),
        }),
      );
      await evaluateSlackOutage({ now: new Date(now.getTime() + 28 * HOUR) });
      await check("recovery flips the durable row to healthy", async () => {
        const row = await getHealthState(
          SLACK_OUTAGE_NOTIFICATION_ID,
          SLACK_OUTAGE_STATE_DEDUPE_KEY,
        );
        assertEq(row?.state, "healthy", "state row healthy");
      });
    } finally {
      await wipeState();
    }
  }

  // ── E. SQL grain of getSlackOutcomeStats (real rows, future-dated) ─────
  {
    const notifA = `test.outage.${RUN}.a`;
    const notifB = `test.outage.${RUN}.b`;
    const chan = `C-fake-${RUN}`;
    const base = Date.now();
    const statsNow = new Date(base + 3 * HOUR);
    const insertRow = (
      notificationId: string,
      status: string,
      createdAt: Date,
      errorMessage: string | null,
    ) =>
      db.execute(sql`
        INSERT INTO "notification_deliveries"
          ("notification_id", "status", "channel_id", "error_message", "trigger_source", "created_at")
        VALUES (${notificationId}, ${status}, ${chan}, ${errorMessage}, ${"test"}, ${createdAt})
      `);
    try {
      const optsArg = { windowMs: 24 * HOUR, lookbackMs: 30 * DAY, now: statsNow };
      const before = await getSlackOutcomeStats(optsArg);

      // Timeline (all in the future, beyond any ambient sibling rows):
      // 30 A-failures → 1 A-success → 12 B-failures → skipped noise.
      const err = `Slack API error: channel_not_found (${RUN})`;
      for (let i = 0; i < 30; i++) {
        await insertRow(notifA, "failed", new Date(base + 60 * 60_000 + i * 20_000), err);
      }
      await insertRow(notifA, "success", new Date(base + 95 * 60_000), null);
      const firstBFail = new Date(base + 100 * 60_000);
      for (let i = 0; i < 12; i++) {
        const isLast = i === 11;
        await insertRow(
          notifB,
          "failed",
          new Date(firstBFail.getTime() + i * 20_000),
          isLast ? `${err}-last` : err,
        );
      }
      for (let i = 0; i < 4; i++) {
        await insertRow(notifA, "skipped_killswitch", new Date(base + 110 * 60_000 + i * 1_000), null);
      }
      await insertRow(notifB, "skipped_disabled", new Date(base + 111 * 60_000), null);

      const after = await getSlackOutcomeStats(optsArg);
      await check("SQL grain: only success/failed are observations (skips excluded)", () => {
        assertEq(after.windowFailures - before.windowFailures, 42, "failure delta");
        assertEq(after.windowSuccesses - before.windowSuccesses, 1, "success delta");
      });
      await check("SQL grain: failingSince = first failure after the last success", () => {
        assert(after.failingSince, "failingSince present");
        assert(
          Math.abs(after.failingSince!.getTime() - firstBFail.getTime()) < 1_500,
          `failingSince ≈ first post-success failure (got ${after.failingSince?.toISOString()})`,
        );
      });
      await check("SQL grain: lastErrorMessage is the most recent failure's message", () => {
        assertEq(after.lastErrorMessage, `${err}-last`, "latest error");
      });
      await check("SQL grain: top failing groups include the seeded ids with true counts", () => {
        const a = after.topFailing.find((t) => t.notificationId === notifA);
        assert(a, "seeded notification A present in topFailing");
        assertEq(a!.failures, 30, "A failure count");
        assertEq(a!.channelId, chan, "A channel id");
      });
    } finally {
      await db.execute(
        sql`DELETE FROM "notification_deliveries" WHERE "notification_id" LIKE ${`test.outage.${RUN}%`}`,
      );
    }
  }

  // ── F. Hook wiring + test-inert default ────────────────────────────────
  {
    const h = freshHarness({
      stats: fakeStats({ windowFailures: 1, lastFailureAt: new Date() }),
    });
    noteSlackDeliveryOutcome("failure");
    await sleep(80);
    await check("dispatcher hook is inert under the test runner by default", () => {
      assertEq(h.getStatsCalls(), 0, "no evaluation triggered");
    });
    const consoleInert = await getSlackOutageStatusForConsole();
    await check("console status getter is inert (null) by default under tests", () => {
      assertEq(consoleInert, null, "null status");
    });

    __setSlackOutageTestHookEnabled(true);
    noteSlackDeliveryOutcome("failure");
    let waited = 0;
    while (h.getStatsCalls() < 1 && waited < 2_000) {
      await sleep(50);
      waited += 50;
    }
    await check("enabled hook: failure outcome triggers an evaluation", () => {
      assertEq(h.getStatsCalls(), 1, "evaluated once");
    });

    noteSlackDeliveryOutcome("failure");
    await sleep(80);
    await check("failure evaluations are throttled (no immediate second query)", () => {
      assertEq(h.getStatsCalls(), 1, "still one evaluation");
    });

    noteSlackDeliveryOutcome("success");
    await sleep(80);
    await check("healthy steady-state success short-circuits (no query)", () => {
      assertEq(h.getStatsCalls(), 1, "no extra evaluation");
    });

    const consoleStatus = await getSlackOutageStatusForConsole();
    await check("enabled console read returns the cached fresh status", () => {
      assert(consoleStatus, "status object returned");
      assertEq(consoleStatus!.active, false, "inactive for benign stats");
      assertEq(h.getStatsCalls(), 1, "served from cache, no extra query");
    });
  }

  // ── G. Real notifyUser: prefix-scoped user_notifications rows ──────────
  {
    const u1 = `${RUN}-adm1`;
    const u2 = `${RUN}-adm2`;
    try {
      for (const uid of [u1, u2]) {
        await db.execute(sql`
          INSERT INTO "users" ("id", "email") VALUES (${uid}, ${`${uid}@test.local`})
          ON CONFLICT ("id") DO NOTHING
        `);
      }
      const failingSince = new Date(now.getTime() - 3 * DAY);
      const h = freshHarness({
        stats: fakeStats({
          windowFailures: 60,
          windowSuccesses: 0,
          lastFailureAt: new Date(now.getTime() - 20_000),
          failingSince,
          topFailing: [
            { notificationId: "usage.rate_limits.warning", channelId: `C-fake-${RUN}`, failures: 60 },
          ],
          lastErrorMessage: "Slack API error: channel_not_found",
        }),
        admins: [u1, u2],
        realNotify: true,
      });
      void h;
      await evaluateSlackOutage({ now });
      const rows = async () => {
        const res: any = await db.execute(sql`
          SELECT "user_id", "title", "deep_link", "dedupe_key"
          FROM "user_notifications"
          WHERE "dedupe_key" LIKE ${`${SLACK_OUTAGE_INBOX_DEDUPE_PREFIX}%`}
            AND "user_id" IN (${u1}, ${u2})
          ORDER BY "created_at" ASC
        `);
        return (res?.rows ?? []) as any[];
      };
      const day3 = await rows();
      await check("escalation writes real inbox rows for the responsible admins", () => {
        assertEq(day3.length, 2, "one row per admin (prefix + seeded-user scoped)");
        for (const r of day3) {
          assert(/day 3/.test(r.title), `title has day count (got ${r.title})`);
          assertEq(r.deep_link, SLACK_OUTAGE_CONSOLE_PATH, "deep link");
          assert(/:day3:/.test(r.dedupe_key), "day-scoped dedupe key");
        }
      });

      await evaluateSlackOutage({
        now: new Date(now.getTime() + SLACK_OUTAGE_REALERT_INTERVAL_MS + HOUR),
      });
      const day4 = await rows();
      await check("daily re-alert lands as a FRESH unread row (day-scoped key beats unread-dedupe)", () => {
        assertEq(day4.length, 4, "two rows per admin across two outage days");
        assertEq(
          day4.filter((r) => /:day4:/.test(r.dedupe_key)).length,
          2,
          "exactly one day4 row per admin",
        );
      });
    } finally {
      await db.execute(sql`
        DELETE FROM "user_notifications"
        WHERE "user_id" IN (${u1}, ${u2})
      `);
      await db.execute(sql`DELETE FROM "users" WHERE "id" IN (${u1}, ${u2})`);
      __resetSlackOutageDetectorStateForTest();
      __resetSlackOutageDepsForTest();
    }
  }

  // ── H. Periodic evaluator pass: lock-guarded, durable-state-driven ─────
  // The completion-review gap: after an outage opens, a QUIET deployment
  // (zero further delivery attempts, no console visits) or a fresh restart
  // must still emit the next day-N re-alert. runSlackOutagePeriodicEvaluationOnce
  // is the 6h-interval body — it takes the cluster singleton lock and
  // evaluates from durable state alone.
  {
    const t0 = new Date("2030-05-01T00:00:00.000Z"); // fixed clock, far future
    const failingSince = new Date(t0.getTime() - 30 * HOUR);
    const mkStats = (at: Date) =>
      fakeStats({
        windowFailures: 40,
        windowSuccesses: 0,
        lastFailureAt: new Date(at.getTime() - 10 * 60_000),
        failingSince,
        topFailing: [
          { notificationId: "usage.rate_limits.warning", channelId: `C-h-${RUN}`, failures: 40 },
        ],
        lastErrorMessage: "Slack API error: channel_not_found",
      });

    let lockAvailable = true;
    let lockAcquires = 0;
    let lockReleases = 0;
    const fakeLock = async () => {
      lockAcquires += 1;
      if (!lockAvailable) return null;
      return {
        release: async () => {
          lockReleases += 1;
        },
      };
    };

    // ONE store shared across "restarts" — the durable notification_health_state
    // stand-in. freshHarness() wipes module state (= process restart).
    const store = memStateStore();
    const installDeps = (at: Date) => {
      const h = freshHarness({ stats: mkStats(at), admins: [`${RUN}-h-adm`], store });
      __setSlackOutageDepsForTest({ acquireEvaluatorLock: fakeLock });
      return h;
    };

    // H1 — a periodic tick alone (no dispatcher outcome, no console read)
    // opens the outage and emits the day-1 escalation.
    const h1 = installDeps(t0);
    const r1 = await runSlackOutagePeriodicEvaluationOnce({ now: t0 });
    await check("periodic pass alone opens the outage (quiet deployment, no events)", () => {
      assert(r1, "pass returned a status");
      assertEq(r1!.active, true, "active");
      assertEq(r1!.dayCount, 1, "day 1 (30h streak)");
      assertEq(h1.sank.length, 1, "one escalation row for the single admin");
      assert(/:day1:/.test(h1.sank[0].opts.dedupeKey), "day1-scoped key");
      assertEq(lockAcquires, 1, "cluster lock taken");
      assertEq(lockReleases, 1, "cluster lock released");
    });

    // H2 — simulated restart (module state wiped; durable row survives in
    // the shared store): a tick 2h later must NOT duplicate the alert.
    const t2 = new Date(t0.getTime() + 2 * HOUR);
    const h2 = installDeps(t2);
    const r2 = await runSlackOutagePeriodicEvaluationOnce({ now: t2 });
    await check("restart + periodic tick inside 24h: durable lastNotifiedAt suppresses dup", () => {
      assert(r2, "pass returned a status");
      assertEq(r2!.active, true, "still active from durable row");
      assertEq(h2.sank.length, 0, "no duplicate escalation");
    });

    // H3 — a sibling instance holds the cluster lock: this pass yields.
    lockAvailable = false;
    const t3 = new Date(t0.getTime() + 25 * HOUR);
    const h3 = installDeps(t3);
    const r3 = await runSlackOutagePeriodicEvaluationOnce({ now: t3 });
    await check("sibling holds the cluster lock: pass skips (null), no alert", () => {
      assertEq(r3, null, "skipped while lock is held elsewhere");
      assertEq(h3.sank.length, 0, "losing instance stays silent");
    });

    // H4 — lock free again at t0+25h: the day-2 re-alert fires purely from
    // durable state (H3 didn't evaluate, so lastNotifiedAt is still t0).
    lockAvailable = true;
    const h4 = installDeps(t3);
    const r4 = await runSlackOutagePeriodicEvaluationOnce({ now: t3 });
    await check("periodic tick past 24h: day-2 re-alert from durable state alone", () => {
      assert(r4, "pass returned a status");
      assertEq(r4!.active, true, "active");
      assertEq(r4!.dayCount, 2, "day 2 (55h streak)");
      assertEq(h4.sank.length, 1, "exactly one re-alert row");
      assert(/:day2:/.test(h4.sank[0].opts.dedupeKey), "day2-scoped key");
    });
  }

  if (failures > 0) throw new Error(`${failures} test step(s) failed`);
  console.log("\nAll Slack sustained-outage detector tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit(); a
// leaked handle surfaces as a hang instead of being masked by a forced exit.
let exitCode = 0;
main()
  .catch((err) => {
    console.error("slack-outage-detector: FAILED");
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
