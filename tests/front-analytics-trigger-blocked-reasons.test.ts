/* test-registration
{
  "name": "Front analytics-coverage trigger blocked-state plain-English reasons (Task #2211)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.4s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2211 — Cover the plain-English "blocked" reasons operators see
 * when the other Front analytics-coverage trigger buttons no-op.
 *
 * Task #2135 added plain-English `reason` strings to the four 503
 * "blocked" branches of the outbound gap-close trigger. The same three
 * raw machine-code 503 gates are repeated in three other coverage
 * trigger routes operators can press from the same admin panel:
 *
 *   POST /api/admin/front/analytics-coverage/refresh-month
 *   POST /api/admin/front/analytics-coverage/reprobe-month
 *   POST /api/admin/front/analytics-coverage/recompute
 *        (each: isAuthenticated + requireTeamLead)
 *
 * Each shares the same three gates, which now return BOTH the machine
 * `error` AND a plain-English `reason` (via the shared
 * `frontTriggerBlockedReasons` builders):
 *
 *   1. master refresh setting OFF → `front_analytics_refresh_enabled=false`
 *   2. queue paused               → `queue paused via queue_drain_state`
 *   3. KILL_SWITCH_NON_CRITICAL_SWEEPS ON
 *                                 → `KILL_SWITCH_NON_CRITICAL_SWEEPS=true`
 *
 * This file flips each gate individually into its blocking state (with
 * every OTHER gate ON), POSTs to each of the three routes, and asserts
 * each responds 503 with BOTH the exact machine `error` and the exact
 * plain-English `reason`. Because each gate short-circuits before any
 * real work (refreshMonth / recomputeAllMonths), no Front API calls or
 * DB writes happen on these paths.
 *
 * The team_lead actor is used throughout so the role gate always passes
 * and we exercise only the gate under test. Every gate is snapshotted
 * and restored so the run is hermetic (mirrors the Task #2079 file).
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
import {
  QUEUE_NAME,
  SETTING_REFRESH_ENABLED,
} from "../server/services/frontAnalyticsCoverage";
import {
  refreshDisabledBlocked,
  queuePausedBlocked,
  killSwitchBlocked,
} from "../server/services/frontTriggerBlockedReasons";
import {
  setQueuePause,
  _resetQueueDrainStateForTests,
} from "../server/services/queueDrainControl";
import { PERF } from "../server/perfConfig";

const TAG = "task-2211";
const TL_ID = `${TAG}-tl`;

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function ensureUsers(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${TL_ID}, 'team_lead', ${"Task2211 TL"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
}

async function cleanupUsers(): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM users WHERE id = ${TL_ID}`);
  } catch {}
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

async function post(
  baseUrl: string,
  path: string,
  actor: string | null,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (actor) headers["x-test-actor"] = actor;
  const r = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
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

type Gate = "enabled" | "queuePaused" | "killSwitch";
type ExpectedBlock = { error: string; reason: string };

/** Set all three gates to their non-blocking (ON) state, then flip the
 * single gate under test into its blocking state. Returns the exact
 * machine `error` and plain-English `reason` the routes are expected to
 * emit (sourced from the same shared builders the routes use). */
async function applyGateState(blocked: Gate): Promise<ExpectedBlock> {
  await setSystemSetting(SETTING_REFRESH_ENABLED, "true", "test");
  await setQueuePause(QUEUE_NAME, false, "system");
  _resetQueueDrainStateForTests();
  (PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean })
    .KILL_SWITCH_NON_CRITICAL_SWEEPS = false;

  switch (blocked) {
    case "enabled":
      await setSystemSetting(SETTING_REFRESH_ENABLED, "false", "test");
      return refreshDisabledBlocked(SETTING_REFRESH_ENABLED);
    case "queuePaused":
      await setQueuePause(QUEUE_NAME, true, "system");
      return queuePausedBlocked(QUEUE_NAME);
    case "killSwitch":
      (PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean })
        .KILL_SWITCH_NON_CRITICAL_SWEEPS = true;
      return killSwitchBlocked();
  }
}

async function main(): Promise<void> {
  await ensureUsers();

  const savedEnabled =
    (await getSystemSetting(SETTING_REFRESH_ENABLED))?.value ?? null;
  const savedKillSwitch = (PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean })
    .KILL_SWITCH_NON_CRITICAL_SWEEPS;

  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  // Each route + the body it needs to clear request validation so it
  // reaches the gate checks. refresh-month / reprobe-month require a
  // valid YYYY-MM month; recompute takes no required body.
  const routes: Array<{ path: string; body: unknown; label: string }> = [
    {
      path: "/api/admin/front/analytics-coverage/refresh-month",
      body: { month: "2025-01" },
      label: "refresh-month",
    },
    {
      path: "/api/admin/front/analytics-coverage/reprobe-month",
      body: { month: "2025-01" },
      label: "reprobe-month",
    },
    {
      path: "/api/admin/front/analytics-coverage/recompute",
      body: {},
      label: "recompute",
    },
  ];

  const gates: Array<{ gate: Gate; label: string }> = [
    { gate: "enabled", label: "master refresh setting OFF" },
    { gate: "queuePaused", label: "queue paused via queue_drain_state" },
    { gate: "killSwitch", label: "KILL_SWITCH_NON_CRITICAL_SWEEPS ON" },
  ];

  try {
    for (const { gate, label: gateLabel } of gates) {
      const expected = await applyGateState(gate);
      for (const route of routes) {
        const r = await post(baseUrl, route.path, TL_ID, route.body);
        const ctx = `[${route.label} / ${gateLabel}]`;
        assertEq(
          r.status,
          503,
          `${ctx} should 503 (got ${r.status} ${JSON.stringify(r.body)})`,
        );
        assertEq(r.body?.error, expected.error, `${ctx} 503 machine error code`);
        assertEq(
          r.body?.reason,
          expected.reason,
          `${ctx} 503 plain-English reason text`,
        );
      }
    }

    console.log("front-analytics-trigger-blocked-reasons.test.ts: OK");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanupUsers();

    if (savedEnabled === null) await deleteSystemSetting(SETTING_REFRESH_ENABLED);
    else await setSystemSetting(SETTING_REFRESH_ENABLED, savedEnabled, "test");

    await setQueuePause(QUEUE_NAME, false, "system").catch(() => {});
    _resetQueueDrainStateForTests();

    (PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean })
      .KILL_SWITCH_NON_CRITICAL_SWEEPS = savedKillSwitch;
  }
}

await main();
process.exit(0);
