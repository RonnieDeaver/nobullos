/* test-registration
{
  "name": "Front Analytics adoption-date override route (Task #1673)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.7s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2481 — the Front adoption-date override route is GONE.
 *
 * Route formerly under test (server/routes/integrations.ts):
 *   POST /api/admin/front/analytics-coverage/adoption-date (requireTeamLead)
 *
 * The coverage floor is now a hard-coded constant
 * (`FRONT_ADOPTION_DATE = 2025-07-01`, server/services/frontAnalyticsCoverage.ts)
 * with no API / UI / worker way to change it. The mutable
 * `system_settings.front_adoption_date` row used to let a missing row
 * regress the floor down to the first Front event (2026-04-16), dropping
 * ~9 months of history. Removing the writer route is part of closing that
 * regression.
 *
 * Pinned behavior:
 *   The route no longer exists, so a POST to it returns 404 for every
 *   caller — anonymous, account_manager, and team_lead alike (there is no
 *   route, hence no auth middleware to 401/403 first) — and the
 *   `system_settings.front_adoption_date` row is never written.
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #1673 / #1656 (the override route + operator attribution this test
 *   previously pinned), #2369 (established 2025-07-01 as the floor).
 */

// Self-establish test mode so the Clerk per-request auth seam is honored even
// under a bare `tsx` repro (requireAuth reads NODE_ENV at request time).
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";

import { storage } from "../server/storage";
import { registerIntegrationRoutes } from "../server/routes/integrations";
import { SETTING_ADOPTION_DATE } from "../server/services/frontAnalyticsCoverage";

const TL_ID = "task-2481-tl";
const AM_ID = "task-2481-am";

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): actor id string
    // authenticates as that user; absent header → null → anonymous 401.
    const actor = String(req.headers["x-test-actor"] ?? "");
    (req as any).__test_clerkUserId = actor || null;
    next();
  });
  registerIntegrationRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function post(
  baseUrl: string,
  actor: string | null,
  body: unknown,
): Promise<{ status: number }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (actor) headers["x-test-actor"] = actor;
  const r = await fetch(`${baseUrl}/api/admin/front/analytics-coverage/adoption-date`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  // Drain the body so the socket can be reused / closed cleanly.
  await r.text().catch(() => undefined);
  return { status: r.status };
}

async function readSettingValue(): Promise<string | null> {
  const row = await storage.getSystemSetting(SETTING_ADOPTION_DATE).catch(() => null);
  return row?.value ?? null;
}

async function main(): Promise<void> {
  // Snapshot existing setting so we can restore it at the end, then clear it
  // so we can prove the (now-removed) route never writes it.
  const saved = await readSettingValue();
  await storage.deleteSystemSetting(SETTING_ADOPTION_DATE);

  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  try {
    // The route is deleted: every caller gets a 404, regardless of role or
    // body validity. There is no route, so there is no auth middleware to
    // 401/403 first.
    for (const actor of [null, AM_ID, TL_ID]) {
      const r = await post(baseUrl, actor, { adoptionDate: "2025-07-01" });
      assertEq(
        r.status,
        404,
        `POST to the removed adoption-date route should 404 (actor=${actor ?? "anon"})`,
      );
    }

    // Belt-and-suspenders: nothing wrote the setting.
    assert.equal(
      await readSettingValue(),
      null,
      "the removed route must never write system_settings.front_adoption_date",
    );

    console.log("front-analytics-coverage-adoption-date-route.test.ts: OK");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (saved === null) {
      await storage.deleteSystemSetting(SETTING_ADOPTION_DATE);
    } else {
      await storage.setSystemSetting(SETTING_ADOPTION_DATE, saved, "system");
    }
    // The local-server route fetches above go through Node's global `undici`
    // dispatcher, which keeps ref'd keep-alive sockets open to 127.0.0.1 after
    // each request. Those linger past `server.close()` and would keep the event
    // loop alive (a drain hang the run-all harness scores as a timeout SIGKILL).
    // Close the dispatcher so the process exits naturally once pools drain.
    try {
      const undici = await import("undici");
      await undici.getGlobalDispatcher().close();
    } catch {
      /* best-effort: fall through to natural drain */
    }
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
await main();
