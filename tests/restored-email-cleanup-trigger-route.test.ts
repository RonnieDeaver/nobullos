/* test-registration
{
  "name": "Restored-email cleanup on-demand routes (Task #2284)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2284 — Cover the on-demand restored-email cleanup buttons/routes.
 *
 * Task #2043 added two CEO-only routes that back the "Restored-email
 * cleanup" preview + run buttons in User Management:
 *
 *   GET  /api/users/restored-email-cleanup/preview  (isAuthenticated + requireCeo)
 *   POST /api/users/restored-email-cleanup/run      (isAuthenticated + requireCeo)
 *
 * The existing `restored-email-cleanup.test.ts` only covers the service
 * tick; nothing pins the route surface. This file (modelled on
 * `front-outbound-gap-close-trigger-route.test.ts`) pins:
 *
 *   1. Auth/role gate on BOTH routes: 401 anon, 403 non-CEO (team_lead),
 *      authorized for CEO.
 *   2. Preview classification: a fallback-email user whose original is
 *      free is "restorable"; a fallback-email user whose original is
 *      still owned by another active user is "collision" (with the
 *      blocking owner identified). Read-only — nothing is mutated.
 *   3. Run enqueues exactly ONE `restored_email_cleanup` worker job with
 *      `force: true`, the operator's userId, and a per-minute dedupe key,
 *      and a second press inside the same minute bucket dedupes to the
 *      same job (no flood).
 *   4. The pause and KILL_SWITCH_NON_CRITICAL_SWEEPS gates each return a
 *      calm 503 WITHOUT enqueuing anything.
 *
 * The run route enqueues a real `restored_email_cleanup` job (the same
 * queue the scheduler producer uses) but never runs a tick itself, so no
 * real email mutation happens — we assert the row that lands in
 * `work_queue` and the JSON response. Every gate is snapshotted and
 * restored so the run is hermetic.
 */

import assert from "node:assert/strict";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerSettingsRoutes } from "../server/routes/settings";
import { QUEUE_NAME } from "../server/services/restoredEmailCleanup";
import {
  setQueuePause,
  _resetQueueDrainStateForTests,
} from "../server/services/queueDrainControl";
import { PERF } from "../server/perfConfig";

const TAG = "task-2284";
const CEO_ID = `${TAG}-ceo`;
const TL_ID = `${TAG}-tl`;

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function ensureActorUsers(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name, authority_level)
    VALUES (${CEO_ID}, 'ceo', ${"Task2284 CEO"}, 'core')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, deleted_at = NULL
  `);
  await db.execute(sql`
    INSERT INTO users (id, role, first_name, authority_level)
    VALUES (${TL_ID}, 'team_lead', ${"Task2284 TL"}, 'core')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, deleted_at = NULL
  `);
}

/** Seed a fixture user with the given email; returns its id. */
async function seedUser(email: string): Promise<string> {
  const id = `${TAG}-${randomUUID()}`;
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES (${id}, ${email}, ${TAG}, 'User', 'user', 'core')
  `);
  return id;
}

async function fetchEmail(id: string): Promise<string | null> {
  const res: any = await db.execute(sql`SELECT email FROM users WHERE id = ${id}`);
  const rows = Array.isArray(res) ? res : (res?.rows ?? []);
  return rows[0] ? (rows[0].email as string | null) : null;
}

async function cleanupUsers(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const literal = `{${ids.join(",")}}`;
  await db
    .execute(sql`DELETE FROM users WHERE id = ANY(${literal}::text[])`)
    .catch(() => {});
}

async function cleanupActorActivity(): Promise<void> {
  await db
    .execute(
      sql`DELETE FROM user_activity_logs WHERE action_type = 'restored_email_cleanup_triggered' AND user_id = ${CEO_ID}`,
    )
    .catch(() => {});
}

/** Drop every cleanup job from `work_queue` so the enqueue assertions
 * start from a clean slate regardless of run order. */
async function clearEnqueuedJobs(): Promise<void> {
  await db.execute(sql`DELETE FROM work_queue WHERE queue_name = ${QUEUE_NAME}`);
}

interface CleanupJobRow {
  id: string;
  dedupe_key: string | null;
  workload_class: string;
  priority: number;
  payload: any;
}

async function listJobs(): Promise<CleanupJobRow[]> {
  const rows = await db.execute(sql`
    SELECT id, dedupe_key, workload_class, priority, payload
    FROM work_queue
    WHERE queue_name = ${QUEUE_NAME}
  `);
  return ((rows as any).rows ?? (rows as unknown as any[])) as CleanupJobRow[];
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): the x-test-actor
    // header names the acting user id (committed public-schema users row);
    // its absence is explicit-unauthenticated (anonymous → 401).
    const actor = String(req.headers["x-test-actor"] ?? "");
    (req as any).__test_clerkUserId = actor || null;
    next();
  });
  registerSettingsRoutes(app);
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

async function call(
  baseUrl: string,
  method: "GET" | "POST",
  path: string,
  actor: string | null,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (actor) headers["x-test-actor"] = actor;
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify({}) : undefined,
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

const PREVIEW_PATH = "/api/users/restored-email-cleanup/preview";
const RUN_PATH = "/api/users/restored-email-cleanup/run";

async function main(): Promise<void> {
  await ensureActorUsers();

  // Snapshot the kill switch we mutate so the run is hermetic.
  const savedKillSwitch = (PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean })
    .KILL_SWITCH_NON_CRITICAL_SWEEPS;

  // ── Preview fixtures: one restorable, one collision ──────────────────
  const ts = Date.now();
  const freeOriginal = `${TAG}-free-${ts}@test.example`;
  const restorableFallback = `${freeOriginal}.restored.${ts}`;
  const restorableId = await seedUser(restorableFallback);

  const collideOriginal = `${TAG}-collide-${ts}@test.example`;
  const collideFallback = `${collideOriginal}.restored.${ts}`;
  const colliderId = await seedUser(collideOriginal); // active owner of the original
  const collisionId = await seedUser(collideFallback);

  const seededIds = [restorableId, colliderId, collisionId];

  await clearEnqueuedJobs();
  await setQueuePause(QUEUE_NAME, false, "system").catch(() => {});
  _resetQueueDrainStateForTests();
  (PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean })
    .KILL_SWITCH_NON_CRITICAL_SWEEPS = false;

  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  try {
    // ── 1. Auth/role gate on the preview route ─────────────────────────
    assertEq(
      (await call(baseUrl, "GET", PREVIEW_PATH, null)).status,
      401,
      "anon preview should 401",
    );
    assertEq(
      (await call(baseUrl, "GET", PREVIEW_PATH, TL_ID)).status,
      403,
      "team_lead preview should 403 (CEO-only)",
    );

    // ── 2. Preview classification (CEO) ────────────────────────────────
    const preview = await call(baseUrl, "GET", PREVIEW_PATH, CEO_ID);
    assertEq(preview.status, 200, `CEO preview should 200 (got ${preview.status})`);
    const items: any[] = preview.body?.items ?? [];

    const restorableItem = items.find((i) => i.userId === restorableId);
    assert.ok(restorableItem, "restorable fixture appears in the preview");
    assertEq(
      restorableItem.outcome,
      "restorable",
      "free original is classified restorable",
    );
    assertEq(
      restorableItem.targetEmail,
      freeOriginal.toLowerCase(),
      "restorable target is the stripped original",
    );

    const collisionItem = items.find((i) => i.userId === collisionId);
    assert.ok(collisionItem, "collision fixture appears in the preview");
    assertEq(
      collisionItem.outcome,
      "collision",
      "still-owned original is classified collision",
    );
    assertEq(
      collisionItem.collidingUserId,
      colliderId,
      "collision identifies the active owner blocking the restore",
    );

    // Preview is read-only — nothing was mutated.
    assertEq(
      await fetchEmail(restorableId),
      restorableFallback,
      "preview did not mutate the restorable user",
    );
    assertEq(
      await fetchEmail(collisionId),
      collideFallback,
      "preview did not mutate the collision user",
    );

    // The preview surfaces the gate context an operator relies on.
    assertEq(preview.body?.paused, false, "preview reports queue not paused");
    assertEq(preview.body?.killSwitch, false, "preview reports kill switch off");

    // ── 3. Auth/role gate on the run route ─────────────────────────────
    assertEq(
      (await call(baseUrl, "POST", RUN_PATH, null)).status,
      401,
      "anon run should 401",
    );
    assertEq(
      (await call(baseUrl, "POST", RUN_PATH, TL_ID)).status,
      403,
      "team_lead run should 403 (CEO-only)",
    );
    assertEq(
      (await listJobs()).length,
      0,
      "a rejected caller must never enqueue a cleanup job",
    );

    // ── 4. CEO happy path: 202 + exactly one enqueued job ──────────────
    const ok = await call(baseUrl, "POST", RUN_PATH, CEO_ID);
    assertEq(ok.status, 202, `CEO run should 202 (got ${ok.status} ${JSON.stringify(ok.body)})`);
    assertEq(ok.body?.status, "enqueued", "response status is 'enqueued'");
    assert.ok(
      typeof ok.body?.jobId === "string" && ok.body.jobId.length > 0,
      `response carries a jobId (got ${JSON.stringify(ok.body?.jobId)})`,
    );

    const afterFirst = await listJobs();
    assertEq(afterFirst.length, 1, "exactly one cleanup job enqueued");
    const job = afterFirst[0];
    assertEq(job.id, ok.body.jobId, "enqueued row id matches the response jobId");
    assertEq(job.workload_class, "maintenance", "job uses the maintenance class");
    assertEq(Number(job.priority), 150, "operator trigger priority is 150");
    assert.ok(
      typeof job.dedupe_key === "string" &&
        new RegExp(`^${QUEUE_NAME}:operator:\\d+$`).test(job.dedupe_key),
      `dedupe key is the per-minute operator bucket key (got ${JSON.stringify(job.dedupe_key)})`,
    );
    assertEq(job.payload?.trigger, "operator", "payload marks an operator trigger");
    assertEq(job.payload?.force, true, "payload forces the run past the master switch");
    assertEq(job.payload?.userId, CEO_ID, "payload records the triggering operator's id");

    // ── 5. Dedupe: a second press in the same bucket collapses to one job ──
    const ok2 = await call(baseUrl, "POST", RUN_PATH, CEO_ID);
    assertEq(ok2.status, 202, `second press should still 202 (got ${ok2.status})`);
    const afterSecond = await listJobs();
    assertEq(
      afterSecond.length,
      1,
      "a second press in the same minute bucket dedupes to one job",
    );
    assertEq(ok2.body?.jobId, job.id, "the deduped press returns the existing job id");

    // ── 6. Pause gate → calm 503, no enqueue ───────────────────────────
    await clearEnqueuedJobs();
    await setQueuePause(QUEUE_NAME, true, "system");
    const paused = await call(baseUrl, "POST", RUN_PATH, CEO_ID);
    assertEq(paused.status, 503, `paused run should 503 (got ${paused.status})`);
    assertEq(
      paused.body?.error,
      "queue paused via queue_drain_state",
      "paused 503 reports the queue-paused reason",
    );
    assertEq(
      (await listJobs()).length,
      0,
      "a paused trigger must not enqueue a cleanup job",
    );
    await setQueuePause(QUEUE_NAME, false, "system");
    _resetQueueDrainStateForTests();

    // ── 7. Kill switch → calm 503, no enqueue ──────────────────────────
    await clearEnqueuedJobs();
    (PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean })
      .KILL_SWITCH_NON_CRITICAL_SWEEPS = true;
    const killed = await call(baseUrl, "POST", RUN_PATH, CEO_ID);
    assertEq(killed.status, 503, `kill-switched run should 503 (got ${killed.status})`);
    assertEq(
      killed.body?.error,
      "KILL_SWITCH_NON_CRITICAL_SWEEPS=true",
      "kill-switch 503 reports the kill-switch reason",
    );
    assertEq(
      (await listJobs()).length,
      0,
      "a kill-switched trigger must not enqueue a cleanup job",
    );
    (PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean })
      .KILL_SWITCH_NON_CRITICAL_SWEEPS = false;

    console.log("restored-email-cleanup-trigger-route.test.ts: OK");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await clearEnqueuedJobs();
    await cleanupActorActivity();
    await cleanupUsers([...seededIds, CEO_ID, TL_ID]);

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
