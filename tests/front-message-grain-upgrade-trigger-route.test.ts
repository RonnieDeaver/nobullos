/* test-registration
{
  "name": "Front message grain upgrade trigger route (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
/**
 * Task #2365 — Route-level coverage for the message-grain upgrade trigger:
 *
 *   POST /api/admin/front/analytics-coverage/upgrade-message-grain
 *        (isAuthenticated + requireTeamLead)
 *
 * Two surfaces are pinned here that the driver-level test
 * (`front-message-grain-upgrade.test.ts`) does not exercise:
 *
 *  A. Blocked-state 503s — the five gates the route checks IN ORDER, each
 *     returning a calm 503 with an exact machine `error` + plain-English
 *     `reason`, and enqueuing NO `front_message_grain_upgrade` job:
 *       1. master enable setting OFF
 *       2. queue paused via queue_drain_state
 *       3. KILL_SWITCH_NON_CRITICAL_SWEEPS ON
 *       4. per-message enumeration switch OFF (hard gate)
 *       5. front auth breaker open
 *
 *  B. Scoped-month eligibility — with every gate ON, a per-row `{ month }`
 *     run is validated against the SAME filters the scheduled selector uses
 *     before anything is enqueued. A UI only ever offers eligible rows, but
 *     a direct API caller could pass any month, so an ineligible target is
 *     rejected (no no-op job):
 *       - no coverage row            → 404 not_found
 *       - row not finalized          → 422 not_finalized
 *       - row never measured (pulled)→ 422 not_pulled
 *       - row already messages_all   → 409 already_message_grain
 *     and an eligible (finalized + pulled + sub-grain) month → 202 enqueued.
 *
 * Far-future fixture months (Y=2987) are used so the run never reads or
 * mutates a real coverage row on the shared dev DB. The team_lead actor is
 * used throughout so the role gate always passes. Every mutated gate is
 * snapshotted and restored so the run is hermetic.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";

process.env.NODE_ENV = process.env.NODE_ENV || "test";
import {
  getSystemSetting,
  setSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";
import { registerIntegrationRoutes } from "../server/routes/integrations";
import { DENOMINATOR_UNIT_MESSAGES_ALL } from "../server/services/frontAnalyticsCoverage";
import {
  QUEUE_NAME,
  SETTING_ENABLED,
  REQUIRED_ENUM_SWITCH,
} from "../server/services/frontMessageGrainUpgrader";
import {
  setQueuePause,
  _resetQueueDrainStateForTests,
} from "../server/services/queueDrainControl";
import {
  __resetFrontAuthBreakerForTest,
  tripFrontAuthBreaker,
} from "../server/services/frontAuthBreaker";
import { PERF } from "../server/perfConfig";

const TAG = "task-2365-route";
const TL_ID = `${TAG}-tl`;
const Y = 2987; // far-future — never collide with real coverage rows
const ROUTE = "/api/admin/front/analytics-coverage/upgrade-message-grain";

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function monthBounds(month: string): { start: Date; end: Date } {
  const [yy, mm] = month.split("-").map(Number);
  return {
    start: new Date(Date.UTC(yy, mm - 1, 1)),
    end: new Date(Date.UTC(yy, mm, 1)),
  };
}

async function upsertCoverage(
  month: string,
  opts: { finalized: boolean; pulled: boolean; denominatorUnit: string | null },
): Promise<void> {
  const { start, end } = monthBounds(month);
  await db.execute(sql`
    INSERT INTO front_analytics_monthly_coverage
      (month, month_start, month_end, is_finalized_month, pulled_at,
       denominator_unit, applied_coverage_pct)
    VALUES (${month}, ${start.toISOString()}, ${end.toISOString()},
            ${opts.finalized}, ${opts.pulled ? start.toISOString() : null},
            ${opts.denominatorUnit}, ${0})
    ON CONFLICT (month) DO UPDATE SET
      is_finalized_month   = EXCLUDED.is_finalized_month,
      pulled_at            = EXCLUDED.pulled_at,
      denominator_unit     = EXCLUDED.denominator_unit,
      applied_coverage_pct = EXCLUDED.applied_coverage_pct
  `);
}

async function cleanupCoverage(): Promise<void> {
  await db.execute(sql`
    DELETE FROM front_analytics_monthly_coverage WHERE month LIKE ${`${Y}-%`}
  `);
}

async function ensureUsers(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${TL_ID}, 'team_lead', ${"Task2365 TL"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
}

async function cleanupUsers(): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM users WHERE id = ${TL_ID}`);
  } catch {}
}

async function clearJobs(): Promise<void> {
  await db.execute(sql`DELETE FROM work_queue WHERE queue_name = ${QUEUE_NAME}`);
}

async function countJobs(): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM work_queue WHERE queue_name = ${QUEUE_NAME}
  `);
  const r = ((rows as any).rows ?? (rows as unknown as any[]))[0];
  return Number(r?.n ?? 0) || 0;
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const actor = String(req.headers["x-test-actor"] ?? "");
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; empty header (null) is
    // explicit-unauthenticated → 401. (The pre-Clerk passport-shape
    // injection stopped working when auth migrated.)
    (req as any).__test_clerkUserId = actor || null;
    next();
  });
  registerIntegrationRoutes(app);
  return app;
}

async function listen(
  app: express.Express,
): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function trigger(
  baseUrl: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${ROUTE}`, {
    method: "POST",
    headers: { "x-test-actor": TL_ID, "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

/** All gates ON (non-blocking), breaker reset, queue drain reset. */
async function allGatesOn(): Promise<void> {
  await setSystemSetting(SETTING_ENABLED, "true", "test");
  await setSystemSetting(REQUIRED_ENUM_SWITCH, "true", "test");
  await setQueuePause(QUEUE_NAME, false, "system");
  _resetQueueDrainStateForTests();
  (PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean })
    .KILL_SWITCH_NON_CRITICAL_SWEEPS = false;
  __resetFrontAuthBreakerForTest();
}

async function main(): Promise<void> {
  await ensureUsers();

  const savedEnabled = (await getSystemSetting(SETTING_ENABLED))?.value ?? null;
  const savedEnum = (await getSystemSetting(REQUIRED_ENUM_SWITCH))?.value ?? null;
  const savedKillSwitch = (PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean })
    .KILL_SWITCH_NON_CRITICAL_SWEEPS;

  await clearJobs();
  await cleanupCoverage();

  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  try {
    // ---- A. Blocked-state 503s (each gate flipped, others ON) -----------
    type Block = { label: string; apply: () => Promise<void>; error: string };
    const blocks: Block[] = [
      {
        label: "master enable OFF",
        apply: async () => {
          await allGatesOn();
          await setSystemSetting(SETTING_ENABLED, "false", "test");
        },
        error: `${SETTING_ENABLED}=false`,
      },
      {
        label: "queue paused",
        apply: async () => {
          await allGatesOn();
          await setQueuePause(QUEUE_NAME, true, "system");
        },
        error: "queue paused via queue_drain_state",
      },
      {
        label: "kill switch ON",
        apply: async () => {
          await allGatesOn();
          (PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean })
            .KILL_SWITCH_NON_CRITICAL_SWEEPS = true;
        },
        error: "KILL_SWITCH_NON_CRITICAL_SWEEPS=true",
      },
      {
        label: "enumeration switch OFF",
        apply: async () => {
          await allGatesOn();
          await setSystemSetting(REQUIRED_ENUM_SWITCH, "false", "test");
        },
        error: `per-message enumeration disabled — flip ${REQUIRED_ENUM_SWITCH} ON first`,
      },
      {
        label: "front auth breaker open",
        apply: async () => {
          await allGatesOn();
          tripFrontAuthBreaker("unauthorized");
        },
        error: "front auth breaker open",
      },
    ];

    for (const b of blocks) {
      await clearJobs();
      await b.apply();
      const r = await trigger(baseUrl, {});
      assertEq(r.status, 503, `[${b.label}] should 503 (got ${JSON.stringify(r)})`);
      assertEq(r.body?.error, b.error, `[${b.label}] 503 machine error`);
      if (typeof r.body?.reason !== "string" || r.body.reason.length === 0) {
        throw new Error(`[${b.label}] expected a plain-English reason string`);
      }
      assertEq(
        await countJobs(),
        0,
        `[${b.label}] a blocked trigger must not enqueue a job`,
      );
    }

    // ---- B. Scoped-month eligibility (all gates ON) ---------------------
    await allGatesOn();

    // not_found — no row for this month.
    await cleanupCoverage();
    {
      const r = await trigger(baseUrl, { month: `${Y}-09` });
      assertEq(r.status, 404, `[not_found] status (got ${JSON.stringify(r)})`);
      assertEq(await countJobs(), 0, "[not_found] no job enqueued");
    }

    // not_finalized — row exists but is not finalized.
    await upsertCoverage(`${Y}-08`, {
      finalized: false,
      pulled: true,
      denominatorUnit: "conversations_all",
    });
    {
      const r = await trigger(baseUrl, { month: `${Y}-08` });
      assertEq(r.status, 422, `[not_finalized] status (got ${JSON.stringify(r)})`);
      assertEq(await countJobs(), 0, "[not_finalized] no job enqueued");
    }

    // not_pulled — finalized but never measured.
    await upsertCoverage(`${Y}-07`, {
      finalized: true,
      pulled: false,
      denominatorUnit: "conversations_all",
    });
    {
      const r = await trigger(baseUrl, { month: `${Y}-07` });
      assertEq(r.status, 422, `[not_pulled] status (got ${JSON.stringify(r)})`);
      assertEq(await countJobs(), 0, "[not_pulled] no job enqueued");
    }

    // already_message_grain — finalized, pulled, already at messages_all.
    await upsertCoverage(`${Y}-06`, {
      finalized: true,
      pulled: true,
      denominatorUnit: DENOMINATOR_UNIT_MESSAGES_ALL,
    });
    {
      const r = await trigger(baseUrl, { month: `${Y}-06` });
      assertEq(
        r.status,
        409,
        `[already_message_grain] status (got ${JSON.stringify(r)})`,
      );
      assertEq(await countJobs(), 0, "[already_message_grain] no job enqueued");
    }

    // eligible — finalized, pulled, sub-grain → 202 + exactly one job.
    await clearJobs();
    await upsertCoverage(`${Y}-05`, {
      finalized: true,
      pulled: true,
      denominatorUnit: "conversations_all",
    });
    {
      const r = await trigger(baseUrl, { month: `${Y}-05` });
      assertEq(r.status, 202, `[eligible] status (got ${JSON.stringify(r)})`);
      assertEq(r.body?.month, `${Y}-05`, "[eligible] echoes the scoped month");
      assertEq(await countJobs(), 1, "[eligible] enqueues exactly one job");
    }

    console.log("front-message-grain-upgrade-trigger-route.test.ts: OK");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await clearJobs();
    await cleanupCoverage();
    await cleanupUsers();

    if (savedEnabled === null) await deleteSystemSetting(SETTING_ENABLED);
    else await setSystemSetting(SETTING_ENABLED, savedEnabled, "test");
    if (savedEnum === null) await deleteSystemSetting(REQUIRED_ENUM_SWITCH);
    else await setSystemSetting(REQUIRED_ENUM_SWITCH, savedEnum, "test");

    await setQueuePause(QUEUE_NAME, false, "system").catch(() => {});
    _resetQueueDrainStateForTests();
    (PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean })
      .KILL_SWITCH_NON_CRITICAL_SWEEPS = savedKillSwitch;
    __resetFrontAuthBreakerForTest();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084),
// so the process exits on its own once work settles — no manual process.exit().
await main();
