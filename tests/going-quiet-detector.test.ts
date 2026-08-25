/* test-registration
{
  "name": "Going-quiet detector scoring + sweep (Task #3695)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3695: Going-quiet detector — the pure baseline/quiet-score arithmetic (drop-threshold boundary, silence rule, pro-rated baseline, insufficient-history suppression, tunable settings) plus the DB-backed sweep: orphan-record exclusion, archived/demo skip, snapshot upsert idempotency, and the once-per-quiet-streak alert lifecycle (flag → no re-notify → re-engage re-arm → second-streak re-notify → kill switch). Task #3889 adds the feed-staleness guard: a stale ingestion feed persists data-gap snapshots with flags + owner notifications suppressed and fires ONE global pipeline alert per streak; recovery re-arms it, and gap rows never serve as flag-transition baselines. Restricted to per-run seeded clients with injected alert deps, so no real client is ever swept or notified. A drift here either false-flags healthy/new clients (the exact 54/56 false-alarm Task #3889 fixed) or lets a disengaging client go quiet with no alert.",
  "tier": "small"
}
test-registration */
/**
 * Task #3695 — Going-quiet client detector coverage.
 *
 * Two layers:
 *
 * A. Pure scoring (`scoreEngagement`) — no DB. Pins the baseline/quiet-score
 *    arithmetic and flag rules exactly:
 *      - drop rule fires at/above the threshold (boundary = 60% inclusive)
 *        and only when the baseline is meaningful (≥ minBaselineWeekly);
 *      - silence rule fires at/above silenceDays;
 *      - insufficient history (no records / short history / never-inbound)
 *        is NEVER flagged, whatever the other signals say;
 *      - baseline pro-rates when the client's history starts inside the
 *        baseline window (true own-rate, not diluted by pre-client weeks);
 *      - custom settings move the flag boundaries (tunables are honored);
 *      - the quiet score components sum as documented (hand-computed cases).
 *
 * B. DB-backed sweep (`runGoingQuietSweep`) against seeded communication
 *    records on the shared dev DB (per-run suffixed ids, restrictToClientIds
 *    so no real client is ever swept or notified from a test run):
 *      - metrics extraction: window boundaries, orphaned-record exclusion,
 *        zoom/twilio_call recency, lastViewedAt passthrough;
 *      - snapshot persistence incl. reasons array and upsert idempotency;
 *      - archived/demo clients get NO snapshot row at all;
 *      - flag TRANSITIONS drive alerts exactly once per quiet streak:
 *        day D flag → notify once; day D+1 still flagged → no re-notify;
 *        day D+2 re-engaged (fresh inbound) → markRecovered re-arm;
 *        day D+30 quiet again → notify fires AGAIN (new streak);
 *      - kill switch value "false" suppresses notifications but the
 *        snapshot still flags;
 *      - real getDirectorPlusUserIds() includes a seeded director and
 *        excludes deleted/core users (inclusion asserts only — the shared
 *        dev DB has real director rows too);
 *      - Task #3889 feed-staleness guard: when front_sync_emails shows the
 *        fleet active but ingested inbound lags beyond the stale window,
 *        snapshots persist as data_gap rows (flags forced off, gap reason
 *        prepended), per-client notifications are suppressed, and ONE
 *        global pipeline alert fires per stale streak via a durable
 *        settings gate; a healthy sweep clears the gate + re-arms the
 *        dispatcher, and data-gap rows are skipped as transition baselines
 *        so a pre-gap quiet streak never re-notifies after the gap.
 *
 * Alert side effects are captured via __setGoingQuietAlertDepsForTest (ESM
 * live-binding workaround, semrushDisconnectAlert pattern) — the dispatcher
 * and user inbox are never actually invoked. Sweep thresholds are injected
 * explicitly so system_settings state never affects the run.
 */

import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  scoreEngagement,
  fetchEngagementMetrics,
  runGoingQuietSweep,
  GOING_QUIET_DEFAULTS,
  GOING_QUIET_DATA_GAP_REASON,
  type EngagementMetrics,
  type GoingQuietSettings,
} from "../server/services/goingQuiet";
import {
  __setGoingQuietAlertDepsForTest,
  __resetGoingQuietAlertDepsForTest,
  GOING_QUIET_NOTIFICATION_ID,
  GOING_QUIET_FEED_STALE_NOTIFICATION_ID,
  SETTING_GOING_QUIET_FEED_STALE_ALERT_ACTIVE,
  KILL_SWITCH_GOING_QUIET_ALERT,
} from "../server/services/goingQuietAlert";
import { getDirectorPlusUserIds } from "../server/services/notifications/recipients";

const RUN = `t3695-${randomBytes(4).toString("hex")}`;

const OWNER_ID = `${RUN}-owner`;
const DIRECTOR_ID = `${RUN}-director`;
const DELETED_DIRECTOR_ID = `${RUN}-deldir`;
const CORE_ID = `${RUN}-core`;

const C_QUIET = `${RUN}-quiet`;
const C_HEALTHY = `${RUN}-healthy`;
const C_INSUFF = `${RUN}-insufficient`;
const C_NOINBOUND = `${RUN}-noinbound`;
const C_ARCHIVED = `${RUN}-archived`;
const C_DEMO = `${RUN}-demo`;
const C_KILLSWITCH = `${RUN}-killswitch`;

const ALL_CLIENT_IDS = [C_QUIET, C_HEALTHY, C_INSUFF, C_NOINBOUND, C_ARCHIVED, C_DEMO, C_KILLSWITCH];

const MS_PER_DAY = 86_400_000;
// Fixed reference "now" in the recent past so seeded timestamps are stable
// regardless of when the test runs.
const DAY_D = new Date("2026-07-01T12:00:00.000Z");
const daysBefore = (base: Date, days: number): Date => new Date(base.getTime() - days * MS_PER_DAY);
const daysAfter = (base: Date, days: number): Date => new Date(base.getTime() + days * MS_PER_DAY);

const SETTINGS: GoingQuietSettings = { ...GOING_QUIET_DEFAULTS };

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function approx(actual: unknown, expected: number, msg: string, tol = 1e-6): void {
  if (typeof actual !== "number" || Math.abs(actual - expected) > tol) {
    throw new Error(`${msg}: expected ~${expected}, got ${JSON.stringify(actual)}`);
  }
}

let failures = 0;
async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
  }
}

// ── Pure-scoring fixtures ───────────────────────────────────────────────────

function metricsOf(partial: Partial<EngagementMetrics>): EngagementMetrics {
  return {
    inboundRecent: 0,
    outboundRecent: 0,
    inbound30d: 0,
    outbound30d: 0,
    inboundBaseline: 0,
    lastInboundAt: null,
    lastCallMeetingAt: null,
    firstCommAt: null,
    lastViewedAt: null,
    asOf: DAY_D,
    ...partial,
  };
}

async function unitTests(): Promise<void> {
  await step("unit: full-collapse case — exact components (45+35+6+10 = 96)", () => {
    const s = scoreEngagement(
      metricsOf({
        inboundBaseline: 36, // 84 covered days → 3.0/wk
        lastInboundAt: daysBefore(DAY_D, 42), // 2× silenceDays → silence component saturates
        firstCommAt: daysBefore(DAY_D, 200),
        lastViewedAt: daysBefore(DAY_D, 60), // viewing component saturates
        lastCallMeetingAt: null, // never → fixed 6
      }),
      SETTINGS,
    );
    approx(s.baselineWeeklyInbound, 3, "baseline weekly");
    approx(s.recentWeeklyInbound, 0, "recent weekly");
    approx(s.dropPct, 100, "drop pct");
    assertEq(s.daysSinceLastInbound, 42, "days since last inbound");
    assertEq(s.historyDays, 200, "history days");
    assertEq(s.insufficientHistory, false, "sufficient history");
    assertEq(s.isFlagged, true, "flagged");
    approx(s.quietScore, 96, "quiet score = 45 + 35 + 6 + 10");
    assert(s.reasons.some((r) => r.includes("down 100%")), `drop reason present (${s.reasons})`);
    assert(s.reasons.some((r) => r.includes("No inbound message in 42 days")), "silence reason present");
    assert(s.reasons.some((r) => r.includes("No call or meeting on record")), "call context reason present");
    assert(s.reasons.some((r) => r.includes("not viewed in 60 days")), "viewing context reason present");
  });

  await step("unit: thin baseline (<minBaselineWeekly) disables the drop rule; silence still flags", () => {
    const s = scoreEngagement(
      metricsOf({
        inboundBaseline: 4, // 4/12wk = 0.33/wk < 0.5 floor
        lastInboundAt: daysBefore(DAY_D, 25),
        firstCommAt: daysBefore(DAY_D, 200),
      }),
      SETTINGS,
    );
    approx(s.baselineWeeklyInbound, 0.33, "baseline weekly", 0.01);
    approx(s.dropPct, 100, "drop pct still reported");
    assertEq(s.isFlagged, true, "flagged by silence");
    assert(!s.reasons.some((r) => r.includes("down")), "no drop reason below the baseline floor");
    assert(s.reasons.some((r) => r.includes("No inbound message in 25 days")), "silence reason present");
    // Components: drop 0 (floor) + silence 35×(25/42) + call never 6 + viewed never 6.
    approx(s.quietScore, Math.round((35 * (25 / 42) + 12) * 10) / 10, "quiet score without drop component", 0.11);
  });

  await step("unit: healthy client — no flag, empty reasons", () => {
    const s = scoreEngagement(
      metricsOf({
        inboundRecent: 4, // 2/wk
        inboundBaseline: 24, // 2/wk
        lastInboundAt: daysBefore(DAY_D, 2),
        lastCallMeetingAt: daysBefore(DAY_D, 10),
        firstCommAt: daysBefore(DAY_D, 300),
        lastViewedAt: daysBefore(DAY_D, 3),
      }),
      SETTINGS,
    );
    approx(s.dropPct, 0, "drop pct ~0");
    assertEq(s.isFlagged, false, "not flagged");
    assertEq(s.reasons.length, 0, "no reasons");
    assert(s.quietScore < 10, `low quiet score (got ${s.quietScore})`);
  });

  await step("unit: no records at all — insufficient, never flagged", () => {
    const s = scoreEngagement(metricsOf({}), SETTINGS);
    assertEq(s.insufficientHistory, true, "insufficient");
    assertEq(s.isFlagged, false, "not flagged");
    assert(s.reasons.some((r) => r.includes("No communication history")), "no-history reason");
    approx(s.quietScore, 12, "score = never-call 6 + never-viewed 6");
  });

  await step("unit: short history — insufficient beats a hard silence signal", () => {
    const s = scoreEngagement(
      metricsOf({
        inboundBaseline: 2,
        lastInboundAt: daysBefore(DAY_D, 25), // would satisfy the silence rule
        firstCommAt: daysBefore(DAY_D, 30), // 30 < 60 required
      }),
      SETTINGS,
    );
    assertEq(s.insufficientHistory, true, "insufficient");
    assertEq(s.isFlagged, false, "not flagged despite 25d silence");
    assert(s.reasons.some((r) => r.includes("Only 30 days")), `short-history reason (${s.reasons})`);
  });

  await step("unit: outbound-only client (never inbound) — insufficient, not flagged", () => {
    const s = scoreEngagement(
      metricsOf({
        outboundRecent: 5,
        firstCommAt: daysBefore(DAY_D, 90),
        lastInboundAt: null,
      }),
      SETTINGS,
    );
    assertEq(s.insufficientHistory, true, "insufficient");
    assertEq(s.isFlagged, false, "not flagged");
    assert(s.reasons.some((r) => r.includes("No inbound communication")), "never-inbound reason");
  });

  await step("unit: drop threshold boundary is inclusive (exactly 60% flags)", () => {
    const s = scoreEngagement(
      metricsOf({
        inboundRecent: 2, // 1.0/wk
        inboundBaseline: 30, // 2.5/wk → drop = (1 − 1/2.5)×100 = 60
        lastInboundAt: daysBefore(DAY_D, 3), // silence rule NOT met
        firstCommAt: daysBefore(DAY_D, 200),
      }),
      SETTINGS,
    );
    approx(s.dropPct, 60, "drop pct exactly 60");
    assertEq(s.isFlagged, true, "flagged at the boundary");
    assert(s.reasons.some((r) => r.includes("down 60%")), "drop reason present");
    assert(!s.reasons.some((r) => r.includes("No inbound message")), "no silence reason at 3d");
  });

  await step("unit: baseline pro-rates when history starts inside the window", () => {
    const s = scoreEngagement(
      metricsOf({
        inboundBaseline: 24,
        firstCommAt: daysBefore(DAY_D, 70), // covered = 70−14 = 56d = 8wk → 3/wk
        lastInboundAt: daysBefore(DAY_D, 16),
      }),
      SETTINGS,
    );
    approx(s.baselineWeeklyInbound, 3, "pro-rated baseline 24/8wk, not 24/12wk");
    assertEq(s.insufficientHistory, false, "70d history is sufficient");
  });

  await step("unit: custom settings move both flag boundaries", () => {
    const base = metricsOf({
      inboundRecent: 2, // 1.0/wk vs 2.5/wk baseline → 60% drop
      inboundBaseline: 30,
      lastInboundAt: daysBefore(DAY_D, 12),
      firstCommAt: daysBefore(DAY_D, 200),
    });
    const stricterDrop = scoreEngagement(base, { ...SETTINGS, dropThresholdPct: 65 });
    assertEq(stricterDrop.isFlagged, false, "60% drop does not flag at a 65% threshold");
    const shorterSilence = scoreEngagement(base, { ...SETTINGS, dropThresholdPct: 65, silenceDays: 10 });
    assertEq(shorterSilence.isFlagged, true, "12d silence flags at a 10-day threshold");
    assert(
      shorterSilence.reasons.some((r) => r.includes("threshold 10")),
      "silence reason names the tuned threshold",
    );
  });
}

// ── DB seeding ──────────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level, deleted_at)
    VALUES
      (${OWNER_ID}, ${`${OWNER_ID}@t3695.example`}, 'Task3695', 'Owner', 'account_manager', 'core', NULL),
      (${DIRECTOR_ID}, ${`${DIRECTOR_ID}@t3695.example`}, 'Task3695', 'Director', 'account_manager', 'director', NULL),
      (${DELETED_DIRECTOR_ID}, ${`${DELETED_DIRECTOR_ID}@t3695.example`}, 'Task3695', 'DeletedDirector', 'account_manager', 'director', NOW()),
      (${CORE_ID}, ${`${CORE_ID}@t3695.example`}, 'Task3695', 'Core', 'account_manager', 'core', NULL)
  `);

  await db.execute(sql`
    INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo, last_viewed_at)
    VALUES
      (${C_QUIET}, ${`${RUN} Quiet Firm`}, ${OWNER_ID}, false, false, ${daysBefore(DAY_D, 40)}),
      (${C_HEALTHY}, ${`${RUN} Healthy Firm`}, ${OWNER_ID}, false, false, ${daysBefore(DAY_D, 3)}),
      (${C_INSUFF}, ${`${RUN} New Firm`}, ${OWNER_ID}, false, false, NULL),
      (${C_NOINBOUND}, ${`${RUN} OneWay Firm`}, ${OWNER_ID}, false, false, NULL),
      (${C_ARCHIVED}, ${`${RUN} Archived Firm`}, ${OWNER_ID}, true, false, NULL),
      (${C_DEMO}, ${`${RUN} Demo Firm`}, ${OWNER_ID}, false, true, NULL),
      (${C_KILLSWITCH}, ${`${RUN} KillSwitch Firm`}, ${OWNER_ID}, false, false, NULL)
  `);

  // Communication history relative to DAY_D. All seeded rows are
  // front_email unless stated otherwise; direction drives inbound counts.
  const rows: Array<{ client: string; source: string; ts: Date; direction: string; matchStatus: string | null }> = [];

  // C_QUIET: first comm 120d back; 36 inbound spread across the baseline
  // window (offsets 15..97d ⇒ exactly 3.0/wk over 12 weeks); ZERO recent
  // inbound except one ORPHANED row 2d back that the filter must ignore;
  // one zoom call 45d back. Drop rule fires at D (silence 15d < 21 yet).
  rows.push({ client: C_QUIET, source: "front_email", ts: daysBefore(DAY_D, 120), direction: "inbound", matchStatus: "matched" });
  for (let i = 0; i < 36; i++) {
    rows.push({
      client: C_QUIET,
      source: "front_email",
      ts: daysBefore(DAY_D, 15 + i * 2.3),
      direction: "inbound",
      matchStatus: i % 2 === 0 ? "matched" : null,
    });
  }
  rows.push({ client: C_QUIET, source: "front_email", ts: daysBefore(DAY_D, 2), direction: "inbound", matchStatus: "orphaned" });
  rows.push({ client: C_QUIET, source: "zoom", ts: daysBefore(DAY_D, 45), direction: "inbound", matchStatus: "matched" });
  rows.push({ client: C_QUIET, source: "front_email", ts: daysBefore(DAY_D, 20), direction: "outbound", matchStatus: "matched" });

  // C_HEALTHY: steady 2/wk inbound through baseline AND recent windows,
  // last inbound 2d back, twilio_call 10d back.
  for (let i = 0; i < 28; i++) {
    rows.push({ client: C_HEALTHY, source: "front_email", ts: daysBefore(DAY_D, 2 + i * 3.5), direction: "inbound", matchStatus: "matched" });
  }
  rows.push({ client: C_HEALTHY, source: "twilio_call", ts: daysBefore(DAY_D, 10), direction: "outbound", matchStatus: "matched" });
  rows.push({ client: C_HEALTHY, source: "front_email", ts: daysBefore(DAY_D, 120), direction: "inbound", matchStatus: "matched" });

  // C_INSUFF: first comm only 10d back (< 60d minimum), one inbound.
  rows.push({ client: C_INSUFF, source: "front_email", ts: daysBefore(DAY_D, 10), direction: "inbound", matchStatus: "matched" });

  // C_NOINBOUND: 90d of history but outbound only.
  for (let i = 0; i < 6; i++) {
    rows.push({ client: C_NOINBOUND, source: "front_email", ts: daysBefore(DAY_D, 5 + i * 15), direction: "outbound", matchStatus: "matched" });
  }

  // C_ARCHIVED / C_DEMO: quiet-shaped history that would flag if they were
  // ever swept — they must get NO snapshot row instead.
  rows.push({ client: C_ARCHIVED, source: "front_email", ts: daysBefore(DAY_D, 80), direction: "inbound", matchStatus: "matched" });
  rows.push({ client: C_DEMO, source: "front_email", ts: daysBefore(DAY_D, 80), direction: "inbound", matchStatus: "matched" });

  // C_KILLSWITCH: same quiet shape as C_QUIET (drop rule fires at D).
  rows.push({ client: C_KILLSWITCH, source: "front_email", ts: daysBefore(DAY_D, 120), direction: "inbound", matchStatus: "matched" });
  for (let i = 0; i < 36; i++) {
    rows.push({ client: C_KILLSWITCH, source: "front_email", ts: daysBefore(DAY_D, 15 + i * 2.3), direction: "inbound", matchStatus: "matched" });
  }

  for (const r of rows) {
    await db.execute(sql`
      INSERT INTO raw_communication_records (client_id, source_type, title, timestamp, direction, match_status)
      VALUES (${r.client}, ${r.source}, ${`${RUN} seeded comm`}, ${r.ts}, ${r.direction}, ${r.matchStatus})
    `);
  }
}

async function cleanup(): Promise<void> {
  // raw_communication_records.client_id has NO cascade — delete comms first,
  // then clients (engagement snapshots cascade with the client), then users.
  try {
    await db.execute(sql`DELETE FROM raw_communication_records WHERE title = ${`${RUN} seeded comm`} OR title = ${`${RUN} reengage comm`}`);
  } catch {}
  try {
    await db.execute(sql`DELETE FROM front_sync_emails WHERE conversation_id LIKE ${`${RUN}-conv-%`}`);
  } catch {}
  try {
    await db.execute(sql`DELETE FROM clients WHERE id IN (${sql.join(ALL_CLIENT_IDS.map((id) => sql`${id}`), sql`, `)})`);
  } catch {}
  try {
    await db.execute(sql`
      DELETE FROM users
      WHERE id IN (${OWNER_ID}, ${DIRECTOR_ID}, ${DELETED_DIRECTOR_ID}, ${CORE_ID})
    `);
  } catch {}
}

async function snapshotRow(clientId: string, snapshotDate: string): Promise<any | undefined> {
  const r = await db.execute(sql`
    SELECT * FROM client_engagement_snapshots
    WHERE client_id = ${clientId} AND snapshot_date = ${snapshotDate}
  `);
  return (r as any).rows[0];
}

const dateStr = (d: Date): string => d.toISOString().split("T")[0];

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Going-quiet detector coverage (Task #3695) [${RUN}]`);

  await unitTests();

  // Captured alert side effects (dispatcher/inbox never actually invoked).
  const notifyByTypeCalls: Array<{ id: string; content: any; options: any }> = [];
  const notifyUserCalls: Array<{ uid: string; notification: any }> = [];
  const recoveredCalls: Array<{ id: string; key: string }> = [];
  let killSwitchValue: string | undefined;
  // Task #3889 — the feed-stale streak gate round-trips through the injected
  // settings pair, so the durable once-per-streak behavior is observable
  // without writing real system_settings rows.
  let feedStaleFlagValue: string | undefined;

  __setGoingQuietAlertDepsForTest({
    notifyByType: (async (id: string, content: any, options: any) => {
      notifyByTypeCalls.push({ id, content, options });
      return true;
    }) as any,
    notifyUser: (async (uid: string, notification: any) => {
      notifyUserCalls.push({ uid, notification });
      return "seeded-notification-id";
    }) as any,
    markRecovered: (async (id: string, key: string) => {
      recoveredCalls.push({ id, key });
    }) as any,
    getDirectorPlusUserIds: (async () => [DIRECTOR_ID]) as any,
    getSystemSetting: (async (key: string) => {
      if (key === KILL_SWITCH_GOING_QUIET_ALERT && killSwitchValue !== undefined) {
        return { key, value: killSwitchValue } as any;
      }
      if (key === SETTING_GOING_QUIET_FEED_STALE_ALERT_ACTIVE && feedStaleFlagValue !== undefined) {
        return { key, value: feedStaleFlagValue } as any;
      }
      return undefined;
    }) as any,
    setSystemSetting: (async (key: string, value: string) => {
      if (key === SETTING_GOING_QUIET_FEED_STALE_ALERT_ACTIVE) feedStaleFlagValue = value;
    }) as any,
  });

  await seed();

  try {
    await step("metrics: window boundaries, orphan exclusion, call recency, viewing passthrough", async () => {
      const m = await fetchEngagementMetrics({ id: C_QUIET, lastViewedAt: daysBefore(DAY_D, 40) }, DAY_D);
      assertEq(m.inboundRecent, 0, "recent inbound excludes the orphaned row");
      // 36 seeded front_email rows + the inbound-direction zoom row at 45d
      // both land inside the baseline window — inbound counts are
      // source-agnostic by design (a call IS engagement).
      assertEq(m.inboundBaseline, 37, "baseline inbound count incl. the zoom row");
      const s = scoreEngagement(m, SETTINGS);
      assertEq(s.daysSinceLastInbound, 15, "days since last (non-orphaned) inbound");
      assertEq(s.daysSinceLastCallMeeting, 45, "days since zoom call");
      assertEq(s.daysSinceLastViewed, 40, "days since last viewed");
      assertEq(s.historyDays, 120, "history days from first comm");
      approx(s.baselineWeeklyInbound, 3.08, "baseline weekly 37/12wk");
      approx(s.dropPct, 100, "drop pct 100");
      assertEq(s.isFlagged, true, "quiet client flags via drop rule");
      assertEq(s.insufficientHistory, false, "quiet client has sufficient history");
    });

    // ── Day D: first sweep — flag + notify once ──
    const D_STR = dateStr(DAY_D);
    await step("sweep day D: counts, snapshot rows, single notification", async () => {
      const r = await runGoingQuietSweep({
        asOf: DAY_D,
        settings: SETTINGS,
        restrictToClientIds: [C_QUIET, C_HEALTHY, C_INSUFF, C_NOINBOUND, C_ARCHIVED, C_DEMO],
      });
      assertEq(r.snapshotDate, D_STR, "snapshot date");
      assertEq(r.processed, 4, "archived/demo never enter the sweep (4 of 6 processed)");
      assertEq(r.flagged, 1, "one flagged");
      assertEq(r.newlyFlagged, 1, "one newly flagged");
      assertEq(r.insufficient, 2, "new firm + outbound-only firm are insufficient");
      assertEq(r.reengaged, 0, "no re-engagements on day D");
      assertEq(r.errors, 0, "no errors");

      const quiet = await snapshotRow(C_QUIET, D_STR);
      assert(quiet, "quiet snapshot row exists");
      assertEq(quiet.is_flagged, true, "quiet row flagged");
      assertEq(quiet.insufficient_history, false, "quiet row not insufficient");
      assertEq(Number(quiet.days_since_last_inbound), 15, "quiet row silence days");
      assert(Array.isArray(quiet.reasons_json), "reasons_json is a jsonb array");
      assert(
        quiet.reasons_json.some((x: string) => x.includes("down 100%")),
        `drop reason persisted (${JSON.stringify(quiet.reasons_json)})`,
      );

      const healthy = await snapshotRow(C_HEALTHY, D_STR);
      assert(healthy, "healthy snapshot row exists");
      assertEq(healthy.is_flagged, false, "healthy not flagged");

      const insuff = await snapshotRow(C_INSUFF, D_STR);
      assertEq(insuff?.insufficient_history, true, "new firm marked insufficient");
      assertEq(insuff?.is_flagged, false, "new firm never flagged");

      assertEq(await snapshotRow(C_ARCHIVED, D_STR), undefined, "archived client has NO snapshot");
      assertEq(await snapshotRow(C_DEMO, D_STR), undefined, "demo client has NO snapshot");

      assertEq(notifyByTypeCalls.length, 1, "exactly one dispatcher notification");
      const call = notifyByTypeCalls[0];
      assertEq(call.id, GOING_QUIET_NOTIFICATION_ID, "notification id");
      assertEq(call.options?.dedupeKey, C_QUIET, "dedupeKey is the client id");
      assertEq(call.options?.skipAdminInAppMirror, true, "generic admin mirror suppressed");
      assertEq(call.options?.triggerSource, "scheduled", "trigger source");
      assert(String(call.content?.text ?? "").includes("Quiet Firm"), "text names the firm");

      const uids = notifyUserCalls.map((c) => c.uid).sort();
      assertEq(JSON.stringify(uids), JSON.stringify([DIRECTOR_ID, OWNER_ID].sort()), "owner + director in-app rows");
      for (const c of notifyUserCalls) {
        assertEq(c.notification?.category, "system", "in-app category");
        assertEq(c.notification?.deepLink, "/churn?tab=going-quiet", "in-app deep link");
        assert(
          String(c.notification?.dedupeKey ?? "").startsWith(`going-quiet:${C_QUIET}:${D_STR}:`),
          "per-user per-streak dedupe key",
        );
      }
    });

    // ── Day D+1: still flagged — same streak, no second notification ──
    await step("sweep day D+1: still flagged, NO re-notify within the streak", async () => {
      const r = await runGoingQuietSweep({
        asOf: daysAfter(DAY_D, 1),
        settings: SETTINGS,
        restrictToClientIds: [C_QUIET],
      });
      assertEq(r.flagged, 1, "still flagged");
      assertEq(r.newlyFlagged, 0, "not NEWLY flagged");
      assertEq(notifyByTypeCalls.length, 1, "dispatcher call count unchanged");
      assert(await snapshotRow(C_QUIET, dateStr(daysAfter(DAY_D, 1))), "day D+1 snapshot persisted");
    });

    // ── Day D+2: client re-engages — recovery re-arm ──
    await step("sweep day D+2: fresh inbound clears the flag and re-arms via markRecovered", async () => {
      for (let i = 0; i < 6; i++) {
        await db.execute(sql`
          INSERT INTO raw_communication_records (client_id, source_type, title, timestamp, direction, match_status)
          VALUES (${C_QUIET}, 'front_email', ${`${RUN} reengage comm`}, ${new Date(daysAfter(DAY_D, 2).getTime() - (24 + i) * 3_600_000)}, 'inbound', 'matched')
        `);
      }
      const r = await runGoingQuietSweep({
        asOf: daysAfter(DAY_D, 2),
        settings: SETTINGS,
        restrictToClientIds: [C_QUIET],
      });
      assertEq(r.flagged, 0, "no longer flagged");
      assertEq(r.reengaged, 1, "counted as re-engaged");
      assertEq(recoveredCalls.length, 1, "markRecovered called once");
      assertEq(recoveredCalls[0]?.id, GOING_QUIET_NOTIFICATION_ID, "recovery notification id");
      assertEq(recoveredCalls[0]?.key, C_QUIET, "recovery dedupe key is the client id");
      assertEq(notifyByTypeCalls.length, 1, "recovery does not notify");
    });

    // ── Day D+30: quiet again — NEW streak notifies again ──
    await step("sweep day D+30: a second quiet streak notifies again (re-armed)", async () => {
      const r = await runGoingQuietSweep({
        asOf: daysAfter(DAY_D, 30),
        settings: SETTINGS,
        restrictToClientIds: [C_QUIET],
      });
      assertEq(r.flagged, 1, "flagged again");
      assertEq(r.newlyFlagged, 1, "new streak detected");
      assertEq(notifyByTypeCalls.length, 2, "second dispatcher notification fired");
      const row = await snapshotRow(C_QUIET, dateStr(daysAfter(DAY_D, 30)));
      assert(
        Number(row?.days_since_last_inbound) >= SETTINGS.silenceDays,
        `second streak driven by silence (${row?.days_since_last_inbound}d)`,
      );
    });

    // ── Kill switch ──
    await step("kill switch 'false': snapshot still flags, notifications suppressed", async () => {
      killSwitchValue = "false";
      const before = notifyByTypeCalls.length;
      const beforeUser = notifyUserCalls.length;
      const r = await runGoingQuietSweep({
        asOf: DAY_D,
        settings: SETTINGS,
        restrictToClientIds: [C_KILLSWITCH],
      });
      killSwitchValue = undefined;
      assertEq(r.flagged, 1, "kill-switch client flags");
      assertEq(r.newlyFlagged, 1, "transition detected");
      assertEq(notifyByTypeCalls.length, before, "no dispatcher call under kill switch");
      assertEq(notifyUserCalls.length, beforeUser, "no in-app rows under kill switch");
      const row = await snapshotRow(C_KILLSWITCH, D_STR);
      assertEq(row?.is_flagged, true, "flagged snapshot persisted regardless");
    });

    // ── Upsert idempotency ──
    await step("same-day re-run upserts (no duplicate rows, counts stable)", async () => {
      const r = await runGoingQuietSweep({
        asOf: DAY_D,
        settings: SETTINGS,
        restrictToClientIds: [C_KILLSWITCH],
      });
      assertEq(r.errors, 0, "no unique-violation errors");
      const rows = await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM client_engagement_snapshots
        WHERE client_id = ${C_KILLSWITCH} AND snapshot_date = ${D_STR}
      `);
      assertEq((rows as any).rows[0].n, 1, "exactly one row per client per day");
    });

    // ── Real director+ recipient resolution ──
    await step("getDirectorPlusUserIds: includes live director, excludes deleted director and core", async () => {
      const ids = await getDirectorPlusUserIds();
      assert(ids.includes(DIRECTOR_ID), "seeded director included");
      assert(!ids.includes(DELETED_DIRECTOR_ID), "deleted director excluded");
      assert(!ids.includes(CORE_ID), "core user excluded");
    });

    // ── Task #3889: feed-staleness guard ──
    // Front's own tracker (front_sync_emails) shows the fleet active while
    // the newest ingested inbound row is ~58 days old → the guard trips:
    // snapshots persist as data-gap rows, flags + owner notifications are
    // suppressed, and ONE global pipeline alert fires per stale streak.
    const STALE_DAY = daysAfter(DAY_D, 60);
    await step("stale feed: flags suppressed, data-gap snapshots, ONE pipeline alert", async () => {
      for (let i = 0; i < 12; i++) {
        await db.execute(sql`
          INSERT INTO front_sync_emails (conversation_id, subject, last_message_at)
          VALUES (${`${RUN}-conv-${i}`}, ${`${RUN} sync activity`}, ${new Date(STALE_DAY.getTime() - (i + 1) * 3_600_000)})
        `);
      }
      const before = notifyByTypeCalls.length;
      const beforeUser = notifyUserCalls.length;
      const r = await runGoingQuietSweep({
        asOf: STALE_DAY,
        settings: SETTINGS,
        restrictToClientIds: [C_QUIET, C_HEALTHY],
      });
      assertEq(r.dataGap, true, "sweep reports dataGap");
      assert(r.feed?.stale === true, "feed measurement is stale");
      assert((r.feed?.syncActiveRecent ?? 0) >= 12, "sync-active count sees the seeded conversations");
      assertEq(r.flagged, 0, "no flags persisted during a gap");
      assertEq(r.newlyFlagged, 0, "no transitions during a gap");
      assertEq(r.suppressedFlags, 2, "both silent-looking clients suppressed instead of flagged");
      assertEq(r.errors, 0, "no errors");

      const gapRow = await snapshotRow(C_QUIET, dateStr(STALE_DAY));
      assert(gapRow, "gap snapshot persisted for continuity");
      assertEq(gapRow.data_gap, true, "snapshot marked data_gap");
      assertEq(gapRow.is_flagged, false, "gap snapshot never flags");
      assertEq(gapRow.reasons_json?.[0], GOING_QUIET_DATA_GAP_REASON, "data-gap reason prepended");

      assertEq(notifyByTypeCalls.length, before + 1, "exactly ONE new dispatcher call");
      const alertCall = notifyByTypeCalls[notifyByTypeCalls.length - 1];
      assertEq(alertCall?.id, GOING_QUIET_FEED_STALE_NOTIFICATION_ID, "it is the pipeline alert");
      assertEq(alertCall?.options?.dedupeKey, "global", "pipeline alert dedupes globally");
      assert(String(alertCall?.content?.text ?? "").includes("2 of 2"), "alert text carries suppressed/processed counts");
      assertEq(notifyUserCalls.length, beforeUser, "NO per-client owner notifications during a gap");
      assertEq(feedStaleFlagValue, "1", "durable stale-streak gate set");
    });

    await step("stale feed day 2: same streak — no second pipeline alert", async () => {
      const before = notifyByTypeCalls.length;
      const r = await runGoingQuietSweep({
        asOf: daysAfter(STALE_DAY, 1),
        settings: SETTINGS,
        restrictToClientIds: [C_QUIET],
      });
      assertEq(r.dataGap, true, "still a data gap");
      assertEq(notifyByTypeCalls.length, before, "streak gate suppresses a second pipeline alert");
      const row = await snapshotRow(C_QUIET, dateStr(daysAfter(STALE_DAY, 1)));
      assertEq(row?.data_gap, true, "day-2 snapshot also marked data_gap");
    });

    await step("feed recovery: alert re-armed; gap rows never serve as transition baseline", async () => {
      // 30 days on, the seeded sync activity has aged out of the recent
      // window → below the min-conversations floor → feed reads healthy.
      const RECOVERY_DAY = daysAfter(STALE_DAY, 30);
      const before = notifyByTypeCalls.length;
      const r = await runGoingQuietSweep({
        asOf: RECOVERY_DAY,
        settings: SETTINGS,
        restrictToClientIds: [C_QUIET, C_HEALTHY],
      });
      assertEq(r.dataGap, false, "feed healthy again");
      assertEq(feedStaleFlagValue, "", "stale-streak gate cleared");
      assert(
        recoveredCalls.some((c) => c.id === GOING_QUIET_FEED_STALE_NOTIFICATION_ID && c.key === "global"),
        "pipeline alert re-armed via markRecovered",
      );
      // Baseline skip: C_QUIET's latest NON-gap snapshot (day D+30) was
      // flagged, so today's flag is the SAME quiet streak — no duplicate
      // owner notification. C_HEALTHY's latest non-gap snapshot (day D)
      // was unflagged → its long silence is a NEW streak → exactly one
      // new per-client alert. If the gap rows (is_flagged=false) leaked
      // into the baseline, C_QUIET would re-notify here too.
      assertEq(r.flagged, 2, "both clients genuinely quiet at recovery");
      assertEq(r.newlyFlagged, 1, "only the healthy→quiet client is a NEW transition");
      const newCalls = notifyByTypeCalls.slice(before);
      assertEq(newCalls.length, 1, "exactly one new dispatcher call");
      assertEq(newCalls[0]?.id, GOING_QUIET_NOTIFICATION_ID, "it is the per-client going-quiet alert");
      assertEq(newCalls[0]?.options?.dedupeKey, C_HEALTHY, "for the newly-quiet client only");
    });
  } finally {
    __resetGoingQuietAlertDepsForTest();
    await cleanup();
  }

  if (failures > 0) throw new Error(`${failures} test step(s) failed`);
  console.log("\nAll going-quiet detector tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit(); a
// leaked handle surfaces as a hang instead of being masked by a forced exit.
let exitCode = 0;
main()
  .catch((err) => {
    console.error("going-quiet-detector: FAILED");
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
