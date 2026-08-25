/* test-registration
{
  "name": "Going Quiet API (Task #3695)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3695: Going Quiet API — the strict director gate (core/lead 403 in BOTH permissive modes), latest-snapshot-per-client selection, flagged-first quiet-score ordering, archived/demo exclusion, snapshot=null for unswept actives, and the thresholds echo. Task #3889 adds the provenance contract: snapshot.dataGap round-trips and the response carries the fleet feed-freshness object the tab's degraded-feed banner reads. Same injected-session harness as the leaderboard test; per-run suffixed rows with cascade cleanup. A drift here opens the churn surface below director, mis-ranks/hides quiet clients, or blinds the tab to a stale feed.",
  "tier": "small"
}
test-registration */
/**
 * Task #3695 — Going Quiet API coverage.
 *
 * Pins the contract of GET /api/churn/going-quiet end-to-end through a real
 * Express app (real registerChurnRoutes + real isAuthenticated behind an
 * injected passport-shaped session — same harness as
 * tests/churn-leaderboard.test.ts):
 *
 *   1. Authz — the gate is STRICT director+ (identical to the leaderboard):
 *      core and lead get 403 with permissive mode pinned OFF *and* ON;
 *      director and ceo authority get 200; unauthenticated gets 401; an
 *      unknown sub is denied at admission (closed sign-in) with 403.
 *   2. Latest-snapshot selection — a client with two snapshot dates returns
 *      only the newer row's values (the older decoy row differs in every
 *      field, so any mixup is visible).
 *   3. Shape — snapshot carries the engagement columns (counts, baseline,
 *      dropPct, silence/call/viewed recency, quietScore, insufficient flag)
 *      and reasons as a real string array; owner display name resolves.
 *   4. Ordering — flagged clients sort above unflagged regardless of score,
 *      higher quietScore first within each group; clients with no snapshot
 *      sort after every snapshot-bearing client. (Relative-order asserts on
 *      seeded ids only — the shared dev DB interleaves real clients.)
 *   5. Exclusion — archived and demo clients never appear, even with
 *      flagged high-score snapshots; a snapshotless active client appears
 *      with snapshot=null instead of being dropped.
 *   6. Thresholds — the response echoes the live tunable settings (compared
 *      against loadGoingQuietSettings() so dev-DB overrides can't flake it).
 *   7. Task #3889 provenance — snapshot.dataGap round-trips (true on a
 *      data-gap row, false on regular rows) and the response carries a
 *      feed-freshness object (shape-pinned; semantics live in the
 *      detector test) for the tab's degraded-feed banner.
 *
 * Seeding uses per-run random suffixes and cleans up in finally (client
 * deletes cascade to snapshots). The permissive-mode switch is captured
 * first and restored in finally with __resetPermissiveModeCacheForTests()
 * after every flip.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { storage } from "../server/storage";
import { __resetPermissiveModeCacheForTests } from "../server/auth/permissions";
import { registerChurnRoutes } from "../server/routes/churn";
import { loadGoingQuietSettings } from "../server/services/goingQuiet";

const RUN = `t3695r-${randomBytes(4).toString("hex")}`;

const DIRECTOR_ID = `${RUN}-director`;
const LEAD_ID = `${RUN}-lead`;
const CORE_ID = `${RUN}-core`;
const OWNER_ID = `${RUN}-owner`; // ceo authority; owns every seeded client
const GHOST_ID = `${RUN}-ghost`; // session sub with no pre-seeded users row

const C_FLAG_HIGH = `${RUN}-flag-high`;
const C_FLAG_LOW = `${RUN}-flag-low`;
const C_UNFLAGGED = `${RUN}-unflagged`;
const C_INSUFF = `${RUN}-insufficient`;
const C_NODATA = `${RUN}-nodata`;
const C_ARCHIVED = `${RUN}-archived`;
const C_DEMO = `${RUN}-demo`;
const C_DATAGAP = `${RUN}-datagap`;

const PERMISSIVE_KEY = "role_permissions_permissive_mode";

const HIGH_REASONS = ["Inbound volume down 90% vs baseline (0.5/wk now vs 5.0/wk)", "No inbound message in 25 days (threshold 21)"];

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES
      (${DIRECTOR_ID}, ${`${DIRECTOR_ID}@t3695.example`}, 'Task3695', 'Director', 'account_manager', 'director'),
      (${LEAD_ID}, ${`${LEAD_ID}@t3695.example`}, 'Task3695', 'Lead', 'team_lead', 'lead'),
      (${CORE_ID}, ${`${CORE_ID}@t3695.example`}, 'Task3695', 'Core', 'account_manager', 'core'),
      (${OWNER_ID}, ${`${OWNER_ID}@t3695.example`}, 'Task3695', 'Owner', 'ceo', 'ceo')
  `);

  await db.execute(sql`
    INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
    VALUES
      (${C_FLAG_HIGH}, ${`${RUN} High Firm`}, ${OWNER_ID}, false, false),
      (${C_FLAG_LOW}, ${`${RUN} Low Firm`}, ${OWNER_ID}, false, false),
      (${C_UNFLAGGED}, ${`${RUN} Fine Firm`}, ${OWNER_ID}, false, false),
      (${C_INSUFF}, ${`${RUN} New Firm`}, ${OWNER_ID}, false, false),
      (${C_NODATA}, ${`${RUN} Unswept Firm`}, ${OWNER_ID}, false, false),
      (${C_ARCHIVED}, ${`${RUN} Archived Firm`}, ${OWNER_ID}, true, false),
      (${C_DEMO}, ${`${RUN} Demo Firm`}, ${OWNER_ID}, false, true),
      (${C_DATAGAP}, ${`${RUN} Gap Firm`}, ${OWNER_ID}, false, false)
  `);

  // C_FLAG_HIGH gets a 07-01 decoy (unflagged, low score, different counts)
  // AND the 07-02 row the endpoint must return — every field differs so a
  // latest-row mixup fails loudly.
  await db.execute(sql`
    INSERT INTO client_engagement_snapshots
      (client_id, snapshot_date, inbound_recent, outbound_recent, inbound_30d, outbound_30d,
       baseline_weekly_inbound, recent_weekly_inbound, drop_pct,
       days_since_last_inbound, days_since_last_call_meeting, days_since_last_viewed,
       history_days, quiet_score, is_flagged, insufficient_history, reasons_json)
    VALUES
      (${C_FLAG_HIGH}, '2026-07-01', 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 10, false, false, ${JSON.stringify(["decoy older row"])}::jsonb),
      (${C_FLAG_HIGH}, '2026-07-02', 1, 3, 4, 6, 5.0, 0.5, 90, 25, 40, 50, 180, 80, true, false, ${JSON.stringify(HIGH_REASONS)}::jsonb),
      (${C_FLAG_LOW}, '2026-07-02', 2, 2, 5, 5, 3.0, 1.0, 66.7, 22, 10, 5, 120, 55, true, false, ${JSON.stringify(["No inbound message in 22 days (threshold 21)"])}::jsonb),
      (${C_UNFLAGGED}, '2026-07-02', 6, 8, 12, 15, 3.0, 3.0, 0, 1, 4, 2, 300, 20, false, false, ${JSON.stringify([])}::jsonb),
      (${C_INSUFF}, '2026-07-02', 2, 1, 2, 1, NULL, 1.0, NULL, 3, NULL, NULL, 12, 5, false, true, ${JSON.stringify(["Only 12 days of communication history (need 60)"])}::jsonb),
      (${C_ARCHIVED}, '2026-07-02', 0, 0, 0, 0, 5.0, 0, 100, 60, 90, 90, 400, 99, true, false, ${JSON.stringify(["Archived must not appear"])}::jsonb),
      (${C_DEMO}, '2026-07-02', 0, 0, 0, 0, 5.0, 0, 100, 60, 90, 90, 400, 99, true, false, ${JSON.stringify(["Demo must not appear"])}::jsonb)
  `);

  // Task #3889 — a data-gap snapshot (persisted by a sweep that found the
  // ingestion feed stale): unflagged by construction, data_gap=true, and a
  // low quiet score so it never disturbs the ordering asserts above.
  await db.execute(sql`
    INSERT INTO client_engagement_snapshots
      (client_id, snapshot_date, inbound_recent, outbound_recent, inbound_30d, outbound_30d,
       days_since_last_inbound, history_days, quiet_score, is_flagged, insufficient_history,
       reasons_json, data_gap)
    VALUES
      (${C_DATAGAP}, '2026-07-02', 0, 0, 0, 0, 45, 200, 1, false, false,
       ${JSON.stringify(["Data gap: the communication feed is behind"])}::jsonb, true)
  `);
}

async function cleanup(): Promise<void> {
  // Client deletes cascade to client_engagement_snapshots (FK ON DELETE CASCADE).
  try {
    await db.execute(sql`
      DELETE FROM clients
      WHERE id IN (${C_FLAG_HIGH}, ${C_FLAG_LOW}, ${C_UNFLAGGED}, ${C_INSUFF}, ${C_NODATA}, ${C_ARCHIVED}, ${C_DEMO}, ${C_DATAGAP})
    `);
  } catch {}
  try {
    await db.execute(sql`
      DELETE FROM users
      WHERE id IN (${DIRECTOR_ID}, ${LEAD_ID}, ${CORE_ID}, ${OWNER_ID}, ${GHOST_ID})
    `);
  } catch {}
}

// Clerk test seam (server/middlewares/requireAuth.ts) so the real requireAuth
// middleware runs against seeded user rows; the acting user switches per
// request. actingUserId === null models an unauthenticated request (→ 401).
// Users are seeded into the committed public schema, so no registry is needed.
let actingUserId: string | null = DIRECTOR_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).__test_clerkUserId = actingUserId;
    next();
  });
  registerChurnRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function call(baseUrl: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}/api/churn/going-quiet`, { method: "GET" });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
  }
}

async function setPermissive(value: "true" | "false"): Promise<void> {
  await storage.setSystemSetting(PERMISSIVE_KEY, value, "system");
  __resetPermissiveModeCacheForTests();
}

async function main(): Promise<void> {
  console.log(`Going Quiet API coverage (Task #3695) [${RUN}]`);

  const originalPermissive = await storage.getSystemSetting(PERMISSIVE_KEY);
  await seed();
  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  try {
    // ── 1. Authz matrix (mirrors the leaderboard's strict gate) ──────
    await setPermissive("false");

    await step("strict mode: core authority ⇒ 403 naming the required level", async () => {
      actingUserId = CORE_ID;
      const { status, json } = await call(baseUrl);
      assertEq(status, 403, "status for core in strict mode");
      assert(
        typeof json.error === "string" && json.error.includes("Director"),
        `403 body names the required level (got ${JSON.stringify(json.error)})`,
      );
    });

    await step("strict mode: lead authority ⇒ 403", async () => {
      actingUserId = LEAD_ID;
      assertEq((await call(baseUrl)).status, 403, "status for lead in strict mode");
    });

    await step("strict mode: director authority ⇒ 200", async () => {
      actingUserId = DIRECTOR_ID;
      assertEq((await call(baseUrl)).status, 200, "status for director in strict mode");
    });

    await setPermissive("true");

    await step("permissive mode: core and lead STILL 403 (gate never opens below director)", async () => {
      actingUserId = CORE_ID;
      assertEq((await call(baseUrl)).status, 403, "status for core in permissive mode");
      actingUserId = LEAD_ID;
      assertEq((await call(baseUrl)).status, 403, "status for lead in permissive mode");
    });

    await step("permissive mode: director ⇒ 200, ceo authority ⇒ 200", async () => {
      actingUserId = DIRECTOR_ID;
      assertEq((await call(baseUrl)).status, 200, "status for director in permissive mode");
      actingUserId = OWNER_ID;
      assertEq((await call(baseUrl)).status, 200, "status for ceo authority in permissive mode");
    });

    await step("unauthenticated request ⇒ 401", async () => {
      actingUserId = null;
      assertEq((await call(baseUrl)).status, 401, "status without a session");
    });

    await step("unknown-sub session is denied at admission ⇒ 403", async () => {
      // Task #4554 closed admission: requireAuth no longer JIT-provisions a
      // users row — an unknown sub with no approved row is denied outright
      // (403 account_not_approved) before the route runs, and no row is
      // ever written. cleanup()'s GHOST_ID delete is now a no-op.
      actingUserId = GHOST_ID;
      assertEq((await call(baseUrl)).status, 403, "status for unapproved unknown user");
    });

    // ── 2-6. Contract (as director) ──────────────────────────────────
    actingUserId = DIRECTOR_ID;
    const { status, json } = await call(baseUrl);
    assertEq(status, 200, "going-quiet status for director");
    const clients: any[] = json.clients;
    const byId = new Map<string, any>(clients.map((c: any) => [c.clientId, c]));

    await step("response shape: clients array + thresholds + generatedAt", async () => {
      assert(Array.isArray(clients), "clients is an array");
      assert(typeof json.generatedAt === "string" && json.generatedAt.length > 0, "generatedAt present");
      const live = await loadGoingQuietSettings();
      assertEq(json.thresholds?.dropThresholdPct, live.dropThresholdPct, "dropThresholdPct echoes live settings");
      assertEq(json.thresholds?.silenceDays, live.silenceDays, "silenceDays echoes live settings");
      assertEq(json.thresholds?.minHistoryDays, live.minHistoryDays, "minHistoryDays echoes live settings");
      assertEq(json.thresholds?.minBaselineWeekly, live.minBaselineWeekly, "minBaselineWeekly echoes live settings");
    });

    await step("latest snapshot wins: the 07-02 row's values, not the 07-01 decoy", async () => {
      const c = byId.get(C_FLAG_HIGH);
      assert(c, "flag-high client present");
      assertEq(c.snapshot?.snapshotDate, "2026-07-02", "snapshot date");
      assertEq(c.snapshot?.isFlagged, true, "flagged");
      assertEq(c.snapshot?.quietScore, 80, "quiet score");
      assertEq(c.snapshot?.dropPct, 90, "drop pct");
      assertEq(c.snapshot?.inboundRecent, 1, "inbound recent");
      assertEq(c.snapshot?.outboundRecent, 3, "outbound recent");
      assertEq(c.snapshot?.inbound30d, 4, "inbound 30d");
      assertEq(c.snapshot?.outbound30d, 6, "outbound 30d");
      assertEq(c.snapshot?.baselineWeeklyInbound, 5, "baseline weekly");
      assertEq(c.snapshot?.recentWeeklyInbound, 0.5, "recent weekly");
      assertEq(c.snapshot?.daysSinceLastInbound, 25, "days since last inbound");
      assertEq(c.snapshot?.daysSinceLastCallMeeting, 40, "days since last call/meeting");
      assertEq(c.snapshot?.daysSinceLastViewed, 50, "days since last viewed");
      assertEq(c.snapshot?.historyDays, 180, "history days");
      assertEq(c.snapshot?.insufficientHistory, false, "insufficient flag");
      assertEq(JSON.stringify(c.snapshot?.reasons), JSON.stringify(HIGH_REASONS), "reasons array passthrough");
    });

    await step("owner display name resolves from the users join", async () => {
      const c = byId.get(C_FLAG_HIGH);
      assertEq(c?.ownerId, OWNER_ID, "owner id");
      assertEq(c?.ownerName, "Task3695 Owner", "owner display name");
    });

    await step("insufficient-history snapshot round-trips (nullable fields stay null)", async () => {
      const c = byId.get(C_INSUFF);
      assertEq(c?.snapshot?.insufficientHistory, true, "insufficient flag");
      assertEq(c?.snapshot?.isFlagged, false, "not flagged");
      assertEq(c?.snapshot?.baselineWeeklyInbound, null, "null baseline stays null");
      assertEq(c?.snapshot?.dropPct, null, "null dropPct stays null");
      assertEq(c?.snapshot?.daysSinceLastCallMeeting, null, "null call recency stays null");
    });

    await step("ordering: flagged by score desc, then unflagged by score, no-snapshot last", async () => {
      const idx = (id: string): number => clients.findIndex((c: any) => c.clientId === id);
      const iHigh = idx(C_FLAG_HIGH);
      const iLow = idx(C_FLAG_LOW);
      const iFine = idx(C_UNFLAGGED);
      const iInsuff = idx(C_INSUFF);
      const iNodata = idx(C_NODATA);
      assert(iHigh >= 0 && iLow >= 0 && iFine >= 0 && iInsuff >= 0 && iNodata >= 0, "all seeded actives present");
      assert(iHigh < iLow, "flagged 80 ranks above flagged 55");
      assert(iLow < iFine, "flagged 55 ranks above unflagged 20 (flag outranks score)");
      assert(iFine < iInsuff, "unflagged 20 ranks above unflagged 5");
      assert(iNodata > iInsuff, "no-snapshot client sorts after snapshot-bearing clients");
    });

    await step("snapshotless active client returns snapshot=null (not dropped)", async () => {
      const c = byId.get(C_NODATA);
      assert(c, "nodata client present");
      assertEq(c.snapshot, null, "snapshot is null");
    });

    await step("archived and demo clients are excluded despite flagged snapshots", async () => {
      assertEq(byId.has(C_ARCHIVED), false, "archived absent");
      assertEq(byId.has(C_DEMO), false, "demo absent");
    });

    // ── Task #3889: provenance surface ───────────────────────────────
    await step("data-gap snapshot surfaces dataGap=true; regular rows read false", async () => {
      const gap = byId.get(C_DATAGAP);
      assert(gap, "data-gap client present");
      assertEq(gap.snapshot?.dataGap, true, "gap row marked dataGap");
      assertEq(gap.snapshot?.isFlagged, false, "gap row never flags");
      assertEq(byId.get(C_FLAG_HIGH)?.snapshot?.dataGap, false, "regular row reads dataGap=false");
    });

    await step("feed-freshness object rides along for the provenance banner", async () => {
      // Values depend on live DB contents — pin the SHAPE (the sweep test
      // covers the stale/healthy semantics). A probe failure would return
      // feed=null, so an object here also proves the probe ran cleanly.
      assert(json.feed && typeof json.feed === "object", "feed object present");
      assertEq(typeof json.feed.stale, "boolean", "feed.stale is boolean");
      assertEq(typeof json.feed.syncActiveRecent, "number", "feed.syncActiveRecent is numeric");
      assertEq(typeof json.feed.staleAfterDays, "number", "feed.staleAfterDays echoes the tunable");
      assertEq(typeof json.feed.minRecentConvs, "number", "feed.minRecentConvs echoes the tunable");
    });
  } finally {
    server.close();
    // Restore the permissive switch exactly as found. A missing original
    // row and value "false" behave identically (the helper defaults OFF),
    // so value-restore is faithful either way.
    try {
      await storage.setSystemSetting(PERMISSIVE_KEY, originalPermissive?.value ?? "false", "system");
    } catch {}
    __resetPermissiveModeCacheForTests();
    await cleanup();
  }

  if (failures > 0) throw new Error(`${failures} test step(s) failed`);
  console.log("\nAll churn-going-quiet route tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit(); a
// leaked handle surfaces as a hang instead of being masked by a forced exit.
let exitCode = 0;
main()
  .catch((err) => {
    console.error("churn-going-quiet-route: FAILED");
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
