/* test-registration
{
  "name": "Front outbound gap-close manual trigger blocked-state 503s (Task #2079)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2079 — Cover the "gap-close is turned off" messages operators
 * see when the manual trigger is blocked.
 *
 * Task #2070 pinned the happy path (202 + enqueued job) and the role
 * gate of:
 *
 *   POST /api/admin/front/analytics-coverage/close-outbound-gap
 *        (isAuthenticated + requireTeamLead — Task #1984)
 *
 * But the route also returns four calm 503 "blocked" responses that
 * mirror the close-gap tick's gates. Each tells the operator *why* the
 * trigger did nothing:
 *
 *   1. master enable setting OFF  → `${SETTING_ENABLED}=false`
 *   2. queue paused               → `queue paused via queue_drain_state`
 *   3. KILL_SWITCH_NON_CRITICAL_SWEEPS ON
 *                                 → `KILL_SWITCH_NON_CRITICAL_SWEEPS=true`
 *   4. per-message materialization switch OFF
 *                                 → `per-message materialization disabled —
 *                                    flip ${SWITCH} ON first`
 *
 * None of these were tested, so a regression that lets a job enqueue
 * while a gate is OFF — or that changes the operator-facing reason text —
 * would go unnoticed. This file flips each gate individually into its
 * blocking state (with every OTHER gate ON), and asserts the route:
 *   - responds 503 with the exact reason string, AND
 *   - enqueues NO `front_outbound_gap_close` work_queue job.
 *
 * The team_lead actor is used throughout so the role gate always passes
 * and we exercise only the gate under test. Every gate is snapshotted
 * and restored so the run is hermetic (mirrors the Task #2070 file).
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
  SETTING_ENABLED,
  REQUIRED_MATERIALIZATION_SWITCH,
} from "../server/services/frontOutboundGapCloser";
import {
  setPoolEpicSwitch,
  isPoolEpicSwitchEnabled,
} from "../server/services/poolEpicKillSwitches";
import {
  setQueuePause,
  _resetQueueDrainStateForTests,
} from "../server/services/queueDrainControl";
import { PERF } from "../server/perfConfig";

const TAG = "task-2079";
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
    VALUES (${TL_ID}, 'team_lead', ${"Task2079 TL"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
}

async function cleanupUsers(): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM users WHERE id = ${TL_ID}`);
  } catch {}
}

/** Drop every gap-closer job from `work_queue` so the "enqueued NO job"
 * assertions start from a clean slate regardless of run order. */
async function clearEnqueuedGapCloseJobs(): Promise<void> {
  await db.execute(sql`DELETE FROM work_queue WHERE queue_name = ${QUEUE_NAME}`);
}

async function countGapCloseJobs(): Promise<number> {
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
  actor: string | null,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (actor) headers["x-test-actor"] = actor;
  const r = await fetch(
    `${baseUrl}/api/admin/front/analytics-coverage/close-outbound-gap`,
    { method: "POST", headers },
  );
  const text = await r.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

type Gate = "enabled" | "queuePaused" | "killSwitch" | "materialization";

/** The exact operator-facing reason (machine `error`) plus the
 * plain-English `reason` sentence (Task #2135) the route emits for a
 * blocked trigger. */
type ExpectedBlock = { error: string; reason: string };

/** Set all four gates to their non-blocking (ON) state, then flip the
 * single gate under test into its blocking state. Returns the exact
 * machine `error` and plain-English `reason` the route is expected to
 * emit. */
async function applyGateState(blocked: Gate): Promise<ExpectedBlock> {
  // Baseline: every gate ON (non-blocking) so only the chosen gate blocks.
  await setSystemSetting(SETTING_ENABLED, "true", "test");
  await setPoolEpicSwitch(REQUIRED_MATERIALIZATION_SWITCH, true, "system");
  await setQueuePause(QUEUE_NAME, false, "system");
  _resetQueueDrainStateForTests();
  (PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean })
    .KILL_SWITCH_NON_CRITICAL_SWEEPS = false;

  switch (blocked) {
    case "enabled":
      await setSystemSetting(SETTING_ENABLED, "false", "test");
      return {
        error: `${SETTING_ENABLED}=false`,
        reason: `The outbound gap closer is turned off, so nothing was run. Turn on the "${SETTING_ENABLED}" setting to enable it.`,
      };
    case "queuePaused":
      await setQueuePause(QUEUE_NAME, true, "system");
      return {
        error: "queue paused via queue_drain_state",
        reason: `The outbound gap-close queue is paused, so nothing was run. Resume the "${QUEUE_NAME}" queue in queue-drain controls to enable it.`,
      };
    case "killSwitch":
      (PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean })
        .KILL_SWITCH_NON_CRITICAL_SWEEPS = true;
      return {
        error: "KILL_SWITCH_NON_CRITICAL_SWEEPS=true",
        reason:
          "Non-critical sweeps are paused by a kill switch, so nothing was run. Turn the KILL_SWITCH_NON_CRITICAL_SWEEPS kill switch off to enable it.",
      };
    case "materialization":
      await setPoolEpicSwitch(REQUIRED_MATERIALIZATION_SWITCH, false, "system");
      return {
        error: `per-message materialization disabled — flip ${REQUIRED_MATERIALIZATION_SWITCH} ON first`,
        reason: `Per-message materialization is off, so a gap-close run can't help yet. Turn on the "${REQUIRED_MATERIALIZATION_SWITCH}" switch first.`,
      };
  }
}

async function main(): Promise<void> {
  await ensureUsers();

  // Snapshot every gate we mutate so the run is hermetic.
  const savedEnabled = (await getSystemSetting(SETTING_ENABLED))?.value ?? null;
  const savedMaterialization = isPoolEpicSwitchEnabled(
    REQUIRED_MATERIALIZATION_SWITCH,
  );
  const savedKillSwitch = (PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean })
    .KILL_SWITCH_NON_CRITICAL_SWEEPS;

  await clearEnqueuedGapCloseJobs();

  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  const cases: Array<{ gate: Gate; label: string }> = [
    { gate: "enabled", label: "master enable setting OFF" },
    { gate: "queuePaused", label: "queue paused via queue_drain_state" },
    { gate: "killSwitch", label: "KILL_SWITCH_NON_CRITICAL_SWEEPS ON" },
    { gate: "materialization", label: "per-message materialization switch OFF" },
  ];

  try {
    for (const { gate, label } of cases) {
      await clearEnqueuedGapCloseJobs();
      const expected = await applyGateState(gate);

      const r = await trigger(baseUrl, TL_ID);
      assertEq(
        r.status,
        503,
        `[${label}] should 503 (got ${r.status} ${JSON.stringify(r.body)})`,
      );
      assertEq(
        r.body?.error,
        expected.error,
        `[${label}] 503 machine error code`,
      );
      // Task #2135 — the route now also returns a plain-English `reason`
      // so the operator who pressed the button understands the no-op.
      assertEq(
        r.body?.reason,
        expected.reason,
        `[${label}] 503 plain-English reason text`,
      );

      // A blocked trigger must never enqueue a gap-close job.
      assertEq(
        await countGapCloseJobs(),
        0,
        `[${label}] a blocked trigger must not enqueue a gap-close job`,
      );
    }

    console.log("front-outbound-gap-close-trigger-blocked.test.ts: OK");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await clearEnqueuedGapCloseJobs();
    await cleanupUsers();

    // Restore every mutated gate to its pre-test state.
    if (savedEnabled === null) await deleteSystemSetting(SETTING_ENABLED);
    else await setSystemSetting(SETTING_ENABLED, savedEnabled, "test");

    await setPoolEpicSwitch(
      REQUIRED_MATERIALIZATION_SWITCH,
      savedMaterialization,
      "system",
    ).catch(() => {});

    await setQueuePause(QUEUE_NAME, false, "system").catch(() => {});
    _resetQueueDrainStateForTests();

    (PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean })
      .KILL_SWITCH_NON_CRITICAL_SWEEPS = savedKillSwitch;
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
await main();
