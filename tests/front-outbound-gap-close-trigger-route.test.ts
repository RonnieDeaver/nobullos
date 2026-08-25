/* test-registration
{
  "name": "Front outbound gap-close manual trigger route (Task #2070)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2070 — Cover the operator's manual gap-close trigger with an
 * automated test.
 *
 * The sibling read-only status route is pinned by Task #2026
 * (front-outbound-gap-close-status-route.test.ts). This file pins the
 * WRITE route operators press to manually kick off a gap-close run:
 *
 *   POST /api/admin/front/analytics-coverage/close-outbound-gap
 *        (isAuthenticated + requireTeamLead — Task #1984)
 *
 * That route enqueues a real `front_outbound_gap_close` worker job (the
 * same queue the scheduler producer uses) so months with a positive
 * `messages_outbound_gap` are later driven back through historical
 * recovery by the worker. It does NOT run a tick itself, so asserting
 * the enqueue never spawns real Front Historical Recovery — we assert
 * the row that lands in `work_queue` and the JSON response operators
 * rely on.
 *
 * Three contracts are pinned:
 *   1. Role gate: 401 anon, 403 account_manager, 202 team_lead.
 *   2. A successful trigger enqueues exactly one `front_outbound_gap_close`
 *      job with the expected payload (`trigger: "operator"`, the actor's
 *      userId) and an `operator` dedupe key, and a second press inside the
 *      same minute bucket dedupes to the same job (no flood).
 *   3. The response shape operators rely on: 202 + { status: "enqueued",
 *      jobId } where jobId matches the enqueued row.
 *
 * All four close-gap gates the route mirrors must be ON for the 202 path:
 * SETTING_ENABLED, queue not paused, KILL_SWITCH_NON_CRITICAL_SWEEPS off,
 * and the per-message materialization switch ON. Each gate is snapshotted
 * and restored so the run is hermetic.
 */

import assert from "node:assert/strict";
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

const TAG = "task-2070";
const TL_ID = `${TAG}-tl`;
const AM_ID = `${TAG}-am`;

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
    VALUES (${TL_ID}, 'team_lead', ${"Task2070 TL"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${AM_ID}, 'account_manager', ${"Task2070 AM"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
}

async function cleanupUsers(): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM users WHERE id IN (${TL_ID}, ${AM_ID})`);
  } catch {}
}

/** Drop every gap-closer job from `work_queue` so the enqueue assertions
 * start from a clean slate regardless of run order. */
async function clearEnqueuedGapCloseJobs(): Promise<void> {
  await db.execute(sql`DELETE FROM work_queue WHERE queue_name = ${QUEUE_NAME}`);
}

interface GapCloseJobRow {
  id: string;
  dedupe_key: string | null;
  workload_class: string;
  priority: number;
  payload: any;
}

async function listGapCloseJobs(): Promise<GapCloseJobRow[]> {
  const rows = await db.execute(sql`
    SELECT id, dedupe_key, workload_class, priority, payload
    FROM work_queue
    WHERE queue_name = ${QUEUE_NAME}
  `);
  return ((rows as any).rows ?? (rows as unknown as any[])) as GapCloseJobRow[];
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
  month?: string,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (actor) headers["x-test-actor"] = actor;
  headers["content-type"] = "application/json";
  const r = await fetch(
    `${baseUrl}/api/admin/front/analytics-coverage/close-outbound-gap`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(month ? { month } : {}),
    },
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

  try {
    // ── 1. Role gate (auth runs before any gate, so order is safe) ─────
    const anon = await trigger(baseUrl, null);
    assertEq(anon.status, 401, `anon should 401 (got ${anon.status})`);

    const am = await trigger(baseUrl, AM_ID);
    assertEq(
      am.status,
      403,
      `account_manager should 403 (got ${am.status} ${JSON.stringify(am.body)})`,
    );

    // No job may have been enqueued by a rejected caller.
    assertEq(
      (await listGapCloseJobs()).length,
      0,
      "a rejected caller must never enqueue a gap-close job",
    );

    // ── 2. Flip every gate ON so the team_lead trigger reaches enqueue ──
    await setSystemSetting(SETTING_ENABLED, "true", "test");
    await setPoolEpicSwitch(REQUIRED_MATERIALIZATION_SWITCH, true, "system");
    await setQueuePause(QUEUE_NAME, false, "system");
    _resetQueueDrainStateForTests();
    (PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean })
      .KILL_SWITCH_NON_CRITICAL_SWEEPS = false;

    // ── 3. Team-lead happy path: 202 + enqueued job + response shape ───
    const ok = await trigger(baseUrl, TL_ID);
    assertEq(
      ok.status,
      202,
      `team_lead should 202 (got ${ok.status} ${JSON.stringify(ok.body)})`,
    );
    assertEq(ok.body?.status, "enqueued", "response status is 'enqueued'");
    assert.ok(
      typeof ok.body?.jobId === "string" && ok.body.jobId.length > 0,
      `response carries a jobId (got ${JSON.stringify(ok.body?.jobId)})`,
    );

    // Exactly one job landed, and it matches the response + expected payload.
    const afterFirst = await listGapCloseJobs();
    assertEq(afterFirst.length, 1, "exactly one gap-close job enqueued");
    const job = afterFirst[0];
    assertEq(job.id, ok.body.jobId, "enqueued row id matches the response jobId");
    assertEq(job.workload_class, "maintenance", "job uses the maintenance class");
    assertEq(Number(job.priority), 150, "operator trigger priority is 150");
    assert.ok(
      typeof job.dedupe_key === "string" &&
        /^front_outbound_gap_close:operator:all:\d+$/.test(job.dedupe_key),
      `dedupe key is the all-months operator bucket key (got ${JSON.stringify(job.dedupe_key)})`,
    );
    assertEq(job.payload?.trigger, "operator", "payload marks an operator trigger");
    assertEq(
      job.payload?.userId,
      TL_ID,
      "payload records the triggering operator's id",
    );
    assert.ok(
      job.payload?.month === undefined,
      "an all-months run carries no scoped month in its payload",
    );
    assertEq(ok.body?.month, null, "all-months response reports month: null");

    // ── 4. Dedupe: a second press in the same bucket collapses to one job ──
    const ok2 = await trigger(baseUrl, TL_ID);
    assertEq(ok2.status, 202, `second press should still 202 (got ${ok2.status})`);
    const afterSecond = await listGapCloseJobs();
    assertEq(
      afterSecond.length,
      1,
      "a second press in the same minute bucket dedupes to one job",
    );
    assertEq(
      ok2.body?.jobId,
      job.id,
      "the deduped press returns the existing job id",
    );

    // ── 5. Month-scoped run (Task #2057): a valid { month } enqueues a
    //      separate job whose dedupe key + payload carry the month, and a
    //      bad month shape is rejected 400 before any enqueue. ───────────
    const scopedMonth = "2025-07";
    const scoped = await trigger(baseUrl, TL_ID, scopedMonth);
    assertEq(
      scoped.status,
      202,
      `month-scoped press should 202 (got ${scoped.status} ${JSON.stringify(scoped.body)})`,
    );
    assertEq(scoped.body?.month, scopedMonth, "scoped response echoes the month");
    const scopedJob = (await listGapCloseJobs()).find(
      (j) => j.id === scoped.body?.jobId,
    );
    assert.ok(scopedJob, "the month-scoped press enqueued a distinct job");
    assertEq(
      scopedJob!.payload?.month,
      scopedMonth,
      "scoped job payload carries the chosen month",
    );
    assert.ok(
      typeof scopedJob!.dedupe_key === "string" &&
        new RegExp(
          `^front_outbound_gap_close:operator:${scopedMonth}:\\d+$`,
        ).test(scopedJob!.dedupe_key),
      `scoped dedupe key carries the month (got ${JSON.stringify(scopedJob!.dedupe_key)})`,
    );

    const beforeBad = (await listGapCloseJobs()).length;
    const bad = await trigger(baseUrl, TL_ID, "2025-13");
    assertEq(bad.status, 400, `a malformed month is rejected 400 (got ${bad.status})`);
    assertEq(
      (await listGapCloseJobs()).length,
      beforeBad,
      "a rejected malformed month enqueues nothing",
    );

    console.log("front-outbound-gap-close-trigger-route.test.ts: OK");
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
