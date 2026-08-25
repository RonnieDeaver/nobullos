/* test-registration
{
  "name": "Internal usage weekly win tracking (Task #4874)",
  "regression": true,
  "sweepOnlyReason": "Task #4874 — weekly win cadence tracker: pure week-bucketing unit asserts plus a DB-backed compute + HTTP gate pass (runInIsolatedSchema: users, clients, intelligence_feed_entries); runs in the full sweep, not the smoke gate.",
  "tier": "small"
}
test-registration */
/**
 * Task #4874 — weekly win cadence tracker for the Internal Usage page.
 *
 * Part A exercises the pure helpers (no DB): UTC Monday week-start
 * derivation, the fixed 8-week trailing grid, and count bucketing with
 * boundary rows landing inside the grid and out-of-window rows dropped.
 *
 * Part B seeds an isolated schema and asserts `computeWinTrackingReport`
 * end to end with a pinned `now` (explicit timestamps, never NOW(), so
 * bucket indices are deterministic):
 *
 *   1. Wins bucket into the right calendar weeks, including the exact
 *      window-start boundary (counted, index 0) and a row just before it
 *      (excluded).
 *   2. met/missed applies only to account managers (≥1/week); other roles
 *      carry `met: null` context counts. Account managers with ZERO wins
 *      are still listed — the gaps are the point.
 *   3. Wins on demo clients, archived clients, and retracted (archived
 *      status) entries never count toward the target — excluded
 *      server-side here, unlike the dashboard feed where demo filtering is
 *      a client-side display preference.
 *   4. The last week is flagged `isCurrent` and the summary counts how
 *      many account managers already met this week's target.
 *   5. Members sort account managers first, then alphabetically.
 *
 * The HTTP route (`GET /api/internal-usage/wins-weekly`) is exercised for
 * the leadership gate (401 / 403 for account_manager / 200 for team_lead)
 * and response shape; numeric bucket asserts stay on the direct compute
 * call so they cannot race a week rollover between seed and request.
 *
 * Everything runs inside `runInIsolatedSchema` with `pinGetDbForCrossAsync`
 * so the HTTP handler (a separate async context) reads the cloned tables,
 * not live `public`. IDs still carry a per-run random suffix as defense in
 * depth against any search_path fallthrough.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { registerInternalUsageRoutes } from "../server/routes/internalUsage";
import {
  computeWinTrackingReport,
  getUtcWeekStart,
  buildTrailingWeekStarts,
  bucketWinCounts,
  WIN_TRACKING_WEEKS,
} from "../server/storage/internalUsageStorage";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { runInIsolatedSchema } from "./db-sandbox";

const RUN = randomUUID().slice(0, 8);
const TL_ID = `test-4874w-tl-${RUN}`;
const AM_A = `test-4874w-am-a-${RUN}`; // has wins across several weeks
const AM_B = `test-4874w-am-b-${RUN}`; // zero wins — must still be listed
const SALES_ID = `test-4874w-sales-${RUN}`; // non-AM with a win — listed, met: null
const C_ACTIVE = `test-4874w-client-active-${RUN}`;
const C_DEMO = `test-4874w-client-demo-${RUN}`;
const C_ARCHIVED = `test-4874w-client-archived-${RUN}`;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// ── Part A: pure helpers (no DB) ─────────────────────────────────────────────
// Past absolute date literals are fine (only future-date literals detonate);
// 2024-05-13 was a Monday.
function partA(): void {
  // getUtcWeekStart: mid-week, exact Monday midnight, Sunday end, month spill.
  assert.equal(
    getUtcWeekStart(new Date("2024-05-15T13:45:12.345Z")).toISOString(),
    "2024-05-13T00:00:00.000Z",
    "Wednesday maps back to Monday 00:00 UTC",
  );
  assert.equal(
    getUtcWeekStart(new Date("2024-05-13T00:00:00.000Z")).toISOString(),
    "2024-05-13T00:00:00.000Z",
    "Monday midnight is its own week start",
  );
  assert.equal(
    getUtcWeekStart(new Date("2024-05-19T23:59:59.999Z")).toISOString(),
    "2024-05-13T00:00:00.000Z",
    "Sunday 23:59 still belongs to Monday's week",
  );
  assert.equal(
    getUtcWeekStart(new Date("2024-03-01T05:00:00.000Z")).toISOString(),
    "2024-02-26T00:00:00.000Z",
    "week start crosses a month boundary backwards",
  );

  // buildTrailingWeekStarts: 8 contiguous weeks, newest last.
  const now = new Date("2024-05-15T13:45:12.345Z");
  const starts = buildTrailingWeekStarts(now);
  assert.equal(starts.length, WIN_TRACKING_WEEKS);
  assert.equal(starts[starts.length - 1].toISOString(), "2024-05-13T00:00:00.000Z");
  for (let i = 1; i < starts.length; i++) {
    assert.equal(
      starts[i].getTime() - starts[i - 1].getTime(),
      WEEK_MS,
      `weeks ${i - 1}→${i} contiguous`,
    );
  }

  // bucketWinCounts: boundary inclusion, per-index placement, drops.
  const gridStart = starts[0];
  const rows = [
    { createdBy: "u1", createdAt: gridStart }, // exact window start → index 0
    { createdBy: "u1", createdAt: new Date(gridStart.getTime() - 1) }, // just before → dropped
    { createdBy: "u1", createdAt: new Date(gridStart.getTime() + WEEK_MS) }, // index 1
    { createdBy: "u1", createdAt: new Date(gridStart.getTime() + WEEK_MS + 3 * DAY_MS) }, // index 1
    { createdBy: "u2", createdAt: now }, // current week → index 7
    { createdBy: "u2", createdAt: new Date(starts[7].getTime() + WEEK_MS) }, // beyond grid → dropped
    { createdBy: "u3", createdAt: null }, // null timestamp → skipped
  ];
  const counts = bucketWinCounts(rows, starts);
  assert.deepEqual(counts.get("u1"), [1, 2, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(counts.get("u2"), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(counts.has("u3"), false, "null-timestamp rows never create a member entry");
}

// ── Part B: DB-backed compute + HTTP gate ────────────────────────────────────

function buildApp(actingUserId: string | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk per-request test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated.
    (req as any).__test_clerkUserId = actingUserId;
    next();
  });
  registerInternalUsageRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function get(baseUrl: string, p: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${p}`);
  const text = await r.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

async function withServer(
  actingUserId: string | null,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const { server, baseUrl } = await listen(buildApp(actingUserId));
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function partB(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      // Pin `now` in JS so every bucket index below is deterministic even if
      // the test straddles midnight (offsets are clock-derived, no absolute
      // future literals).
      const pinnedNow = new Date();
      const weekStarts = buildTrailingWeekStarts(pinnedNow);
      const curStart = weekStarts[weekStarts.length - 1];
      assert.equal(curStart.toISOString(), getUtcWeekStart(pinnedNow).toISOString());

      // Timestamps by target bucket. The current-week win sits at the
      // midpoint between week start and pinnedNow so it is safely inside
      // [curStart, pinnedNow] even moments after a Monday-midnight rollover.
      const tCur = new Date((curStart.getTime() + pinnedNow.getTime()) / 2); // index 7
      const tPrev = new Date(curStart.getTime() - 3.5 * DAY_MS); // index 6
      const tIdx5 = new Date(curStart.getTime() - 10 * DAY_MS); // index 5
      const tIdx0 = weekStarts[0]; // exact window-start boundary → index 0
      const tOutside = new Date(weekStarts[0].getTime() - 1 * 60 * 60 * 1000); // 1h before window

      // ── Seed users ──
      await isoDb.execute(sql`
        INSERT INTO users (id, role, authority_level, first_name, last_name, email)
        VALUES
          (${TL_ID}, 'team_lead', 'director', 'Tessa', 'Lead', ${`tessa-${RUN}@test.local`}),
          (${AM_A}, 'account_manager', 'core', 'Alice', 'Alpha', ${`alice-${RUN}@test.local`}),
          (${AM_B}, 'account_manager', 'core', 'Bob', 'Bravo', ${`bob-${RUN}@test.local`}),
          (${SALES_ID}, 'sales', 'core', 'Sam', 'Seller', ${`sam-${RUN}@test.local`})
      `);
      __test_markUserReconciled(TL_ID, {
        id: TL_ID,
        firstName: "Tessa",
        lastName: "Lead",
        role: "team_lead",
      });
      __test_markUserReconciled(AM_A, {
        id: AM_A,
        firstName: "Alice",
        lastName: "Alpha",
        role: "account_manager",
      });

      // ── Seed clients ──
      await isoDb.execute(sql`
        INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
        VALUES
          (${C_ACTIVE}, ${"Firm Active " + RUN}, ${AM_A}, false, false),
          (${C_DEMO}, ${"Firm Demo " + RUN}, ${AM_A}, false, true),
          (${C_ARCHIVED}, ${"Firm Archived " + RUN}, ${AM_A}, true, false)
      `);

      // ── Seed wins ──
      // AM_A: counted wins at indices 7 (current), 6, 5, 0 (exact boundary);
      // one just outside the window; one demo-client, one archived-client and
      // one retracted win in the current week that must NOT rescue the target
      // if the counted current-week win were missing.
      const mkId = (slug: string) => `test-4874w-${slug}-${RUN}`;
      await isoDb.execute(sql`
        INSERT INTO intelligence_feed_entries (id, client_id, created_by, entry_type, title, status, created_at)
        VALUES
          (${mkId("cur")}, ${C_ACTIVE}, ${AM_A}, 'win_progress', ${"Cur win " + RUN}, 'approved', ${tCur}),
          (${mkId("prev")}, ${C_ACTIVE}, ${AM_A}, 'win_progress', ${"Prev win " + RUN}, 'approved', ${tPrev}),
          (${mkId("idx5")}, ${C_ACTIVE}, ${AM_A}, 'win_progress', ${"Idx5 win " + RUN}, 'approved', ${tIdx5}),
          (${mkId("idx0")}, ${C_ACTIVE}, ${AM_A}, 'win_progress', ${"Boundary win " + RUN}, 'approved', ${tIdx0}),
          (${mkId("outside")}, ${C_ACTIVE}, ${AM_A}, 'win_progress', ${"Outside win " + RUN}, 'approved', ${tOutside}),
          (${mkId("demo")}, ${C_DEMO}, ${AM_A}, 'win_progress', ${"Demo win " + RUN}, 'approved', ${tCur}),
          (${mkId("arch-client")}, ${C_ARCHIVED}, ${AM_A}, 'win_progress', ${"Archived-client win " + RUN}, 'approved', ${tCur}),
          (${mkId("retracted")}, ${C_ACTIVE}, ${AM_A}, 'win_progress', ${"Retracted win " + RUN}, 'archived', ${tCur}),
          (${mkId("non-win")}, ${C_ACTIVE}, ${AM_A}, 'general_update', ${"Not a win " + RUN}, 'approved', ${tCur}),
          (${mkId("sales-win")}, ${C_ACTIVE}, ${SALES_ID}, 'win_progress', ${"Sales win " + RUN}, 'approved', ${tPrev})
      `);

      // ── Direct compute (deterministic buckets) ──
      const report = await computeWinTrackingReport(pinnedNow);

      assert.equal(report.weeks.length, WIN_TRACKING_WEEKS);
      assert.equal(report.generatedAt, pinnedNow.toISOString());
      for (let i = 0; i < report.weeks.length; i++) {
        assert.equal(report.weeks[i].start, weekStarts[i].toISOString(), `week ${i} start`);
        assert.equal(
          report.weeks[i].end,
          new Date(weekStarts[i].getTime() + WEEK_MS).toISOString(),
          `week ${i} end`,
        );
        assert.equal(report.weeks[i].isCurrent, i === report.weeks.length - 1, `week ${i} isCurrent`);
      }

      // Scope to fixture members — the isolated schema also carries cloned
      // public users, so never assert over the full member list.
      const byId = new Map(report.members.map((m) => [m.userId, m]));
      const alice = byId.get(AM_A);
      const bob = byId.get(AM_B);
      const tessa = byId.get(TL_ID);
      const sam = byId.get(SALES_ID);
      assert.ok(alice, "AM with wins listed");
      assert.ok(bob, "zero-win AM still listed");
      assert.ok(tessa, "team lead listed (team role)");
      assert.ok(sam, "non-team-role member with a counted win listed");

      // Alice: counts land in weeks 0, 5, 6, 7; demo/archived/retracted/
      // outside-window/non-win rows all excluded.
      assert.deepEqual(
        alice!.weeks.map((c) => c.count),
        [1, 0, 0, 0, 0, 1, 1, 1],
        "Alice bucket counts",
      );
      assert.equal(alice!.total, 4);
      assert.equal(alice!.isAccountManager, true);
      assert.deepEqual(
        alice!.weeks.map((c) => c.met),
        [true, false, false, false, false, true, true, true],
        "Alice met/missed flags",
      );

      // Bob: zero wins, all weeks missed (the UI renders the current week's
      // zero as pending, but the data layer stays honest: not met yet).
      assert.deepEqual(bob!.weeks.map((c) => c.count), [0, 0, 0, 0, 0, 0, 0, 0]);
      assert.equal(bob!.total, 0);
      assert.deepEqual(
        bob!.weeks.map((c) => c.met),
        new Array(WIN_TRACKING_WEEKS).fill(false),
      );

      // Tessa (team_lead): listed with no target.
      assert.equal(tessa!.isAccountManager, false);
      assert.deepEqual(tessa!.weeks.map((c) => c.met), new Array(WIN_TRACKING_WEEKS).fill(null));
      assert.equal(tessa!.total, 0);

      // Sam (sales): counted win listed for context, no target.
      assert.equal(sam!.isAccountManager, false);
      assert.equal(sam!.total, 1);
      assert.equal(sam!.weeks[6].count, 1);
      assert.deepEqual(sam!.weeks.map((c) => c.met), new Array(WIN_TRACKING_WEEKS).fill(null));

      // Sorting: account managers first, alphabetical within each group.
      const fixtureOrder = report.members
        .map((m) => m.userId)
        .filter((id) => [AM_A, AM_B, TL_ID, SALES_ID].includes(id));
      assert.equal(fixtureOrder[0], AM_A, "Alice (AM) before Bob (AM)? alphabetical");
      assert.equal(fixtureOrder[1], AM_B, "AMs come before non-AMs");
      assert.ok(
        fixtureOrder.indexOf(TL_ID) > fixtureOrder.indexOf(AM_B),
        "team lead sorts after account managers",
      );

      // Summary: only fixture AMs exist as account managers in the isolated
      // schema? No — cloned public users may include AMs too, so assert
      // relatively: Alice met this week, Bob did not, and the summary counts
      // at least Alice while never exceeding the AM total.
      assert.ok(report.summary.accountManagers >= 2, "both fixture AMs counted");
      assert.ok(report.summary.metThisWeek >= 1, "Alice met the current week");
      assert.ok(
        report.summary.metThisWeek <= report.summary.accountManagers,
        "met count bounded by AM count",
      );
      const fixtureAms = [alice!, bob!];
      const fixtureMet = fixtureAms.filter(
        (m) => m.weeks[m.weeks.length - 1].count >= 1,
      ).length;
      assert.equal(fixtureMet, 1, "exactly one fixture AM met the current week");

      // ── HTTP: leadership gate + response shape ──
      await withServer(null, async (baseUrl) => {
        const r = await get(baseUrl, "/api/internal-usage/wins-weekly");
        assert.equal(r.status, 401, `unauthenticated should 401, got ${r.status}`);
      });
      await withServer(AM_A, async (baseUrl) => {
        const r = await get(baseUrl, "/api/internal-usage/wins-weekly");
        assert.equal(r.status, 403, `account_manager should 403, got ${r.status}`);
      });
      await withServer(TL_ID, async (baseUrl) => {
        const r = await get(baseUrl, "/api/internal-usage/wins-weekly");
        assert.equal(r.status, 200, `team_lead should 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.weeks?.length, WIN_TRACKING_WEEKS);
        assert.equal(r.body.weeks[WIN_TRACKING_WEEKS - 1].isCurrent, true);
        assert.ok(Array.isArray(r.body.members));
        // Bucket-independent member assert (no week-rollover race): totals.
        const aliceHttp = r.body.members.find((m: any) => m.userId === AM_A);
        assert.ok(aliceHttp, "Alice present over HTTP");
        // The route recomputes with the live clock; if the UTC week rolled
        // over between seed and request, the exact-window-start boundary win
        // slides out. Exact bucket math is pinned in the direct compute
        // asserts above — here only prove the route serves real aggregates.
        assert.ok(
          [3, 4].includes(aliceHttp.total),
          `Alice total over HTTP should be 3-4, got ${aliceHttp.total}`,
        );
        assert.equal(typeof r.body.summary?.accountManagers, "number");
        assert.equal(typeof r.body.summary?.metThisWeek, "number");
        assert.ok(r.body.generatedAt, "generatedAt present");
      });

      __test_resetReconciledUsers();
    },
    {
      tables: ["users", "clients", "intelligence_feed_entries"],
      pinGetDbForCrossAsync: true,
    },
  );
}

async function main(): Promise<void> {
  partA();
  console.log("internal-usage-wins-weekly: part A (pure helpers) passed");
  await partB();
}

main().then(
  () => {
    console.log("internal-usage-wins-weekly: all sections passed");
    process.exit(0);
  },
  (err) => {
    console.error("internal-usage-wins-weekly: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
