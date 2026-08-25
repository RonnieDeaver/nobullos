/* test-registration
{
  "name": "Orphaned-user heal operator status route (Task #2243)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2243 — cover the orphaned-user heal operator status endpoint
 * (Task #2203 sweep) with automated tests:
 *
 *   GET /api/admin/orphaned-user-heal/status   (isAuthenticated + requireTeamLead)
 *
 * The sibling Task #2203 sweep itself is exercised elsewhere; this file
 * pins the HTTP surface operators read:
 *
 *   1. Auth: the route rejects non-team-lead callers (401 anon,
 *      403 account_manager).
 *   2. Status: GET returns { config, caps, lastRun, lastRunStatus } where
 *      `config` exactly matches `getOrphanedUserHealConfig()` (enabled +
 *      per-tick budget + cadence), and `lastRun` is null with
 *      `lastRunStatus === "never_run"` before any tick has persisted a
 *      summary.
 *   3. Classify: a corrupt persisted value surfaces as
 *      `lastRunStatus === "unreadable"` with a plain-English
 *      `lastRunError`, while `lastRun` stays null.
 *   4. After a real (disabled, default-OFF) tick persists its summary,
 *      status surfaces `lastRunStatus === "ok"` and the exact summary the
 *      tick produced.
 *
 * The route registration under test is the REAL
 * `registerOrphanedUserHealRoutes` mounted on a bare Express app, with the
 * REAL `isAuthenticated` + `requireTeamLead` middleware — only auth
 * identity is injected per request.
 */
import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db, runWithWorkerDb } from "../server/db";
import {
  setSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";
import { registerOrphanedUserHealRoutes } from "../server/routes/orphanedUserHeal";
import {
  getOrphanedUserHealConfig,
  runOrphanedUserHealTick,
  SETTING_ENABLED,
  SETTING_MAX_PER_TICK,
  SETTING_LAST_RUN,
} from "../server/services/orphanedUserHeal";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

const TAG = "task-2243";
const TL_ID = `${TAG}-tl`;
const AM_ID = `${TAG}-am`;

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ── Synthetic users (real requireTeamLead reads storage.getUser) ─────
async function ensureUsers(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${TL_ID}, 'team_lead', ${`${TAG} TL`})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${AM_ID}, 'account_manager', ${`${TAG} AM`})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
}

async function cleanupUsers(): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM users WHERE id IN (${TL_ID}, ${AM_ID})`);
  } catch {}
}

async function resetSettings(): Promise<void> {
  await deleteSystemSetting(SETTING_ENABLED).catch(() => {});
  await deleteSystemSetting(SETTING_MAX_PER_TICK).catch(() => {});
  await deleteSystemSetting(SETTING_LAST_RUN).catch(() => {});
}

// ── Bare Express app with the REAL route; auth identity injected per
//    request via the x-test-actor header (anon when absent). ──────────
function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk per-request test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (→ 401).
    // The pre-Clerk passport-shape injection stopped working when auth migrated.
    const actor = String(req.headers["x-test-actor"] ?? "");
    (req as any).__test_clerkUserId = actor ? actor : null;
    next();
  });
  registerOrphanedUserHealRoutes(app);
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
  const headers: Record<string, string> = {};
  if (actor) headers["x-test-actor"] = actor;
  const r = await fetch(`${baseUrl}${path}`, { method, headers });
  const text = await r.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  await resetSettings();
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    await resetSettings();
  }
}

async function main(): Promise<void> {
  console.log("Orphaned-user heal status route (Task #2243)");

  await ensureUsers();

  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  const STATUS = "/api/admin/orphaned-user-heal/status";

  try {
    // ── (1) Auth gate ────────────────────────────────────────────────
    await step("auth: 401 anon, 403 account_manager", async () => {
      const sAnon = await call(baseUrl, "GET", STATUS, null);
      assertEq(sAnon.status, 401, "GET status anon → 401");

      const sAm = await call(baseUrl, "GET", STATUS, AM_ID);
      assertEq(sAm.status, 403, "GET status account_manager → 403");
    });

    // ── (2) Status shape: config mirrors getOrphanedUserHealConfig() ──
    await step("status: returns { config, caps, lastRun }; config matches the service", async () => {
      // Known, non-default config so we prove the readout reflects
      // system_settings rather than hard-coded defaults.
      await setSystemSetting(SETTING_ENABLED, "true", "test");
      await setSystemSetting(SETTING_MAX_PER_TICK, "7", "test");

      const expected = await getOrphanedUserHealConfig();

      const r = await call(baseUrl, "GET", STATUS, TL_ID);
      assertEq(r.status, 200, "GET status team_lead → 200");
      assert.ok(r.body && typeof r.body === "object", "body is an object");
      assert.ok("config" in r.body, "body has a config key");
      assert.ok("lastRun" in r.body, "body has a lastRun key");

      assert.deepEqual(
        r.body.config,
        expected,
        "status config matches getOrphanedUserHealConfig()",
      );
      assertEq(r.body.config.enabled, true, "config.enabled reflects the setting");
      assertEq(r.body.config.maxPerTick, 7, "config.maxPerTick reflects the setting");
      assert.equal(
        typeof r.body.config.tickIntervalMinutes,
        "number",
        "config carries tickIntervalMinutes",
      );
      assert.equal(
        typeof r.body.caps?.maxPerTick,
        "number",
        "caps carries the per-tick cap",
      );

      // No tick has run yet in this isolated step → lastRun null + never_run.
      assertEq(r.body.lastRun, null, "lastRun null before any tick has run");
      assertEq(
        r.body.lastRunStatus,
        "never_run",
        "lastRunStatus is never_run before any tick has run",
      );
      assert.ok(
        !("lastRunError" in r.body),
        "never_run must not carry a lastRunError",
      );
    });

    // ── (3) Classify: unreadable when the stored value is corrupt ─────
    await step("status: corrupt last-run → lastRunStatus unreadable + error", async () => {
      // Persist a non-JSON value directly so the reader's parse fails.
      await setSystemSetting(SETTING_LAST_RUN, "{not json", "test");

      const r = await call(baseUrl, "GET", STATUS, TL_ID);
      assertEq(r.status, 200, "GET status team_lead → 200");
      assertEq(r.body.lastRun, null, "unreadable keeps lastRun null");
      assertEq(
        r.body.lastRunStatus,
        "unreadable",
        "lastRunStatus is unreadable when the stored value won't parse",
      );
      assert.ok(
        typeof r.body.lastRunError === "string" && r.body.lastRunError.length > 0,
        "unreadable carries a plain-English lastRunError",
      );
    });

    // ── (4) After a real (disabled, default-OFF) tick persists → ok ───
    await step("status: surfaces the summary a real tick persisted (ok)", async () => {
      // SETTING_ENABLED deleted by resetSettings → default OFF. The tick
      // short-circuits with a /disabled/ reason but still persists its
      // summary, so the status route should surface it as `ok`.
      const result = await runWithWorkerDb(() => runOrphanedUserHealTick());
      assertEq(result.enabled, false, "tick reports disabled");
      assertEq(result.candidates, 0, "no candidates while disabled");
      // Task #4554 — the sweep is retired: the tick short-circuits with the
      // retirement reason regardless of the enable switch.
      assert.match(result.reason ?? "", /retired/i, "reason mentions retired");

      const s = await call(baseUrl, "GET", STATUS, TL_ID);
      assertEq(s.status, 200, "GET status after tick → 200");
      assert.ok(s.body?.lastRun, "lastRun is populated after a tick");
      assertEq(
        s.body.lastRunStatus,
        "ok",
        "lastRunStatus is ok once a tick has persisted a readable summary",
      );
      assert.ok(
        !("lastRunError" in s.body),
        "an ok readout must not carry a lastRunError",
      );
      assertEq(
        s.body.lastRun.enabled,
        false,
        "lastRun reflects the disabled no-op tick",
      );
      assertEq(
        s.body.lastRun.ranAt,
        result.ranAt,
        "lastRun is the summary the tick just produced",
      );
      assertEq(s.body.lastRun.healed, 0, "disabled tick healed nobody");
    });

    if (failures > 0) throw new Error(`${failures} test(s) failed`);
    console.log("\nAll orphaned-user heal status route tests passed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

let exitCode = 0;
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084),
// so the process exits on its own once work settles — no manual process.exit().
main()
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    exitCode = 1;
  })
  .finally(async () => {
    try {
      await resetSettings();
    } catch {}
    try {
      await cleanupUsers();
    } catch {}
    process.exitCode = exitCode;
  });
