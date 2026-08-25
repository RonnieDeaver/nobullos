/* test-registration
{
  "name": "Re-judge re-score progress API — strict director gate + fresh/stale split (Task #4812)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4812: GET /api/churn/rejudge-progress feeds the leaderboard's re-score banner. This pins the STRICT director gate (core/lead 403 in BOTH permissive modes — it exposes book-wide churn posture), 401 unauthenticated, 403 for an unknown sub, and the delta-scoped fresh/stale arithmetic (totalJudged = fresh + stale; a seeded current-revision client lands in fresh, an old-revision client in stale, archived clients excluded). A drift here either opens the churn surface below director or makes the CEO-facing progress banner lie about re-score coverage. DB-backed route test, ~5s.",
  "tier": "medium"
}
test-registration */
/**
 * Task #4812 — GET /api/churn/rejudge-progress contract.
 *
 * The endpoint is the churn leaderboard's window into "is a re-judge drain
 * running and how much of the book is on the current judge calibration".
 * Same injected-session harness as tests/churn-going-quiet-route.test.ts:
 * real registerChurnRoutes + real requireAuth behind req.__test_clerkUserId.
 *
 *   1. Authz — strict director+ gate, identical to the leaderboard: core
 *      and lead get 403 with permissive mode pinned OFF *and* ON; director
 *      and ceo authority get 200; unauthenticated gets 401; an unknown sub
 *      is denied at admission with 403.
 *   2. Shape — running/runningSource/currentRevision/totalJudged/fresh/
 *      stale/lastFreshGeneratedAt all present; totalJudged === fresh+stale;
 *      currentRevision echoes FINGERPRINT_REVISION; no drain is running in
 *      this suite so running=false, runningSource=null.
 *   3. Delta-scoped counts (immune to sibling-suite residue): seeding one
 *      current-revision client and one old-revision client moves fresh and
 *      stale up by exactly one each; an archived client with a stale
 *      judgment moves NOTHING.
 *
 * Cross-instance running detection (advisory-lock probe → running=true from
 * another session) is pinned in tests/prod-action-rejudge-stale.test.ts,
 * which owns the drain lifecycle; this suite pins the HTTP surface.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";

import { db, closeDbPools } from "../server/db";
import { clientDailyJudgments } from "@shared/schema";
import { storage } from "../server/storage";
import { __resetPermissiveModeCacheForTests } from "../server/auth/permissions";
import { registerChurnRoutes } from "../server/routes/churn";
import { FINGERPRINT_REVISION } from "../server/services/dailyJudgment";
import { TIER_GATE_VERSION } from "../server/services/judgmentTierGate";

const RUN = `t4812r-${randomBytes(4).toString("hex")}`;

const DIRECTOR_ID = `${RUN}-director`;
const LEAD_ID = `${RUN}-lead`;
const CORE_ID = `${RUN}-core`;
const OWNER_ID = `${RUN}-owner`; // ceo authority; owns the seeded clients
const GHOST_ID = `${RUN}-ghost`; // session sub with no users row

const C_FRESH = `${RUN}-fresh`; // latest judgment at the current revision
const C_STALE = `${RUN}-stale`; // latest judgment on an older revision
const C_ARCHIVED = `${RUN}-archived`; // stale judgment but archived → excluded

const PERMISSIVE_KEY = "role_permissions_permissive_mode";

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
}

async function seedUsers(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES
      (${DIRECTOR_ID}, ${`${DIRECTOR_ID}@t4812.example`}, 'Task4812', 'Director', 'account_manager', 'director'),
      (${LEAD_ID}, ${`${LEAD_ID}@t4812.example`}, 'Task4812', 'Lead', 'team_lead', 'lead'),
      (${CORE_ID}, ${`${CORE_ID}@t4812.example`}, 'Task4812', 'Core', 'account_manager', 'core'),
      (${OWNER_ID}, ${`${OWNER_ID}@t4812.example`}, 'Task4812', 'Owner', 'ceo', 'ceo')
  `);
}

async function seedJudgment(
  clientId: string,
  judgmentDate: string,
  promptRevision: string,
  currentContract = false,
): Promise<void> {
  const dataSourcesSummary: Record<string, unknown> = {
    version: 2,
    tier: "full",
    promptRevision,
    generatedAt: new Date().toISOString(),
    basedOn: ["3 comms (30d)"],
    missing: [],
  };
  if (currentContract) {
    dataSourcesSummary.tierGateVersion = TIER_GATE_VERSION;
    dataSourcesSummary.tierGate = {
      version: TIER_GATE_VERSION,
      judgmentDate,
      proposedStatus: "Watch",
      finalStatus: "Watch",
      proposedRelationshipStatus: "Stable",
      finalRelationshipStatus: "Stable",
      cap: "Watch",
      overridden: false,
      healthyForced: false,
      proposedOverallRisk: 25,
      finalOverallRisk: 25,
      riskDrivers: [],
      capReasons: ["genuinely_uncertain_or_incomplete_basis"],
      silenceExceeded: false,
      deliveryStability: "unknown",
      deliveryStabilitySource: "none",
      evidence: { validCount: 0, rejectedCount: 0, reclassifiedCount: 0, items: [] },
    };
  }
  await db.insert(clientDailyJudgments).values({
    clientId,
    judgmentDate,
    status: "Watch",
    headline: `T4812 fixture ${RUN}`,
    communicationsAnalyzed: 3,
    dataSourcesSummary,
  });
}

async function seedClients(): Promise<void> {
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
    VALUES
      (${C_FRESH}, ${`${RUN} Fresh Firm`}, ${OWNER_ID}, false, false),
      (${C_STALE}, ${`${RUN} Stale Firm`}, ${OWNER_ID}, false, false),
      (${C_ARCHIVED}, ${`${RUN} Archived Firm`}, ${OWNER_ID}, true, false)
  `);
  await seedJudgment(C_FRESH, isoDaysAgo(1), FINGERPRINT_REVISION, true);
  await seedJudgment(C_STALE, isoDaysAgo(2), "3697.1");
  await seedJudgment(C_ARCHIVED, isoDaysAgo(1), "3697.1");
}

async function cleanup(): Promise<void> {
  try {
    await db.execute(sql`
      DELETE FROM clients WHERE id IN (${C_FRESH}, ${C_STALE}, ${C_ARCHIVED})
    `); // cascades client_daily_judgments
  } catch {}
  try {
    await db.execute(sql`
      DELETE FROM users WHERE id IN (${DIRECTOR_ID}, ${LEAD_ID}, ${CORE_ID}, ${OWNER_ID}, ${GHOST_ID})
    `);
  } catch {}
}

// Clerk test seam (server/middlewares/requireAuth.ts): the real requireAuth
// runs against seeded users rows; actingUserId === null models an
// unauthenticated request (→ 401).
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
  const r = await fetch(`${baseUrl}/api/churn/rejudge-progress`, { method: "GET" });
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
  console.log(`Re-judge re-score progress API (Task #4812) [${RUN}]`);

  const originalPermissive = await storage.getSystemSetting(PERMISSIVE_KEY);
  await seedUsers();
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

    await step("strict mode: lead ⇒ 403, director ⇒ 200", async () => {
      actingUserId = LEAD_ID;
      assertEq((await call(baseUrl)).status, 403, "status for lead in strict mode");
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

    await step("permissive mode: director and ceo authority ⇒ 200", async () => {
      actingUserId = DIRECTOR_ID;
      assertEq((await call(baseUrl)).status, 200, "status for director in permissive mode");
      actingUserId = OWNER_ID;
      assertEq((await call(baseUrl)).status, 200, "status for ceo authority in permissive mode");
    });

    await step("unauthenticated ⇒ 401; unknown sub ⇒ 403 at admission", async () => {
      actingUserId = null;
      assertEq((await call(baseUrl)).status, 401, "status without a session");
      actingUserId = GHOST_ID;
      assertEq((await call(baseUrl)).status, 403, "status for an unseeded sub");
    });

    // ── 2. Shape + baseline (before OUR clients exist) ───────────────
    actingUserId = DIRECTOR_ID;
    let baseline: any;
    await step("response shape: progress fields present and consistent", async () => {
      const { status, json } = await call(baseUrl);
      assertEq(status, 200, "status");
      baseline = json;
      assertEq(json.running, false, "running (no drain in this suite)");
      assertEq(json.runningSource, null, "runningSource");
      assertEq(json.currentRevision, FINGERPRINT_REVISION, "currentRevision");
      assert(Number.isInteger(json.totalJudged), "totalJudged is an integer");
      assert(Number.isInteger(json.fresh), "fresh is an integer");
      assert(Number.isInteger(json.stale), "stale is an integer");
      assertEq(json.totalJudged, json.fresh + json.stale, "totalJudged = fresh + stale");
      assert(
        json.lastFreshGeneratedAt === null || typeof json.lastFreshGeneratedAt === "string",
        "lastFreshGeneratedAt is string|null",
      );
    });

    // ── 3. Delta-scoped counts (fixture-keyed, residue-immune) ───────
    await step("seeded fresh/stale clients move the split by exactly one each; archived excluded", async () => {
      await seedClients();
      const { status, json } = await call(baseUrl);
      assertEq(status, 200, "status");
      assertEq(json.totalJudged, baseline.totalJudged + 2, "totalJudged +2 (archived excluded)");
      assertEq(json.fresh, baseline.fresh + 1, "fresh +1 (current-revision client)");
      assertEq(json.stale, baseline.stale + 1, "stale +1 (old-revision client)");
      assert(
        typeof json.lastFreshGeneratedAt === "string" &&
          !Number.isNaN(Date.parse(json.lastFreshGeneratedAt)),
        "lastFreshGeneratedAt reflects the fresh fixture's generation stamp",
      );
    });
  } finally {
    actingUserId = DIRECTOR_ID;
    try {
      await storage.setSystemSetting(PERMISSIVE_KEY, originalPermissive?.value ?? "false", "system");
    } catch {}
    __resetPermissiveModeCacheForTests();
    await cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDbPools();
  }

  console.log(failures > 0 ? `\n${failures} step(s) FAILED` : "\nAll re-judge progress API steps passed");
  process.exitCode = failures > 0 ? 1 : 0;
}

main().catch(async (err) => {
  console.error(err);
  try {
    await closeDbPools();
  } catch {}
  process.exitCode = 1;
});
