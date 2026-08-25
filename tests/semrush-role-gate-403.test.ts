/* test-registration
{
  "name": "SEMrush connection-management role gate — account_manager 403 (Task #2908)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2908: the SEMrush connection-management role gate. An account_manager hitting /api/semrush/authorize or /disconnect directly must 403 (credential untouched) while /status and /campaigns/refresh stay 200. Fast and deterministic: real routes + real role middleware, in-memory credential store, stubbed refresh deps; DB use is limited to seeding/removing two suite-owned users rows.",
  "tier": "small"
}
test-registration */
/**
 * Task #2908 — server-side role-gate test for the SEMrush admin-only
 * connection-management routes.
 *
 * The IntegrationsHub UI hides the Connect / Disconnect buttons from
 * account managers, but the real safety boundary is the backend gate
 * (`requireTeamLead` on /api/semrush/authorize and /api/semrush/disconnect
 * in server/routes/heatmap.ts). This test pins that boundary end-to-end
 * through a real Express app so a middleware regression (e.g. someone
 * swapping requireTeamLead for requireAccountManager, or dropping the
 * guard) fails loudly:
 *
 *   1. POST /api/semrush/authorize as account_manager  ⇒ 403
 *   2. POST /api/semrush/disconnect as account_manager ⇒ 403, and the
 *      stored SEMrush credential is UNTOUCHED (the handler body never ran)
 *   3. GET /api/semrush/status as account_manager ⇒ 200 (read access stays)
 *   4. POST /api/semrush/campaigns/refresh as account_manager ⇒ 200
 *      (requireAccountManager-level work stays available)
 *   5. Positive control: POST /api/semrush/disconnect as team_lead ⇒ 200
 *      and the credential IS cleared — proving the gate distinguishes
 *      roles rather than blanket-403ing.
 *
 * Hermetic seams (no SEMrush OAuth / network):
 *   - `__setSemrushCredentialStoreOverrideForTests` gives this suite its
 *     own in-memory credential map (Task #2240 pattern), so the
 *     "untouched after 403" assertion never races the live worker's
 *     system_settings writes — and the team_lead disconnect clears the
 *     map, not shared dev credentials.
 *   - `__setForceRefreshCampaignsDepsForTest` stubs the refresh route's
 *     connection probe + fetch + enrichment (Task #2223 pattern).
 *
 * Public-API doc note: exercises only our OWN routes/middleware; every
 * path that would reach SEMrush is stubbed via the seams above.
 * Prior-task research: route mounting + role seeding follow
 * tests/semrush-campaign-refresh-force-match.test.ts (Task #2223); the
 * credential-store override follows tests/semrush-disconnect-audit.test.ts
 * (Tasks #2007/#2240). Note the task brief said "DELETE
 * /api/semrush/disconnect" — the real route is POST (heatmap.ts:228), so
 * POST is what's tested.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  __setSemrushCredentialStoreOverrideForTests,
  __setForceRefreshCampaignsDepsForTest,
  clearCampaignCache,
} from "../server/services/semrushApi";
import { registerHeatmapRoutes } from "../server/routes/heatmap";

const AM_ID = "test-2908-account-manager";
const TL_ID = "test-2908-team-lead";

const SETTINGS_KEY_ACCESS = "semrush_access_token";
const SETTINGS_KEY_REFRESH = "semrush_refresh_token";
const SETTINGS_KEY_EXPIRES = "semrush_token_expires_at";

// Suite-owned in-memory credential store (Task #2240 seam): disconnect's
// credential clears land here, never in shared system_settings.
const credStore = new Map<string, string>();

function seedTokens(token: string): void {
  credStore.set(SETTINGS_KEY_ACCESS, token);
  credStore.set(SETTINGS_KEY_REFRESH, `${token}-refresh`);
  credStore.set(SETTINGS_KEY_EXPIRES, String(Date.now() + 3_600_000));
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function seedUsers(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${AM_ID}, 'account_manager', ${"Task2908 AM"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${TL_ID}, 'team_lead', ${"Task2908 TL"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
}

async function cleanupUsers(): Promise<void> {
  try { await db.execute(sql`DELETE FROM users WHERE id IN (${AM_ID}, ${TL_ID})`); } catch {}
}

// Mount the real heatmap routes behind the Clerk per-request test seam so
// the real requireTeamLead / requireAccountManager guards run against the
// seeded user rows. The acting user is switchable per request.
let actingUserId = AM_ID;
function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk per-request test seam (server/middlewares/requireAuth.ts): a
    // string authenticates as that user id; role gating (403) comes from the
    // committed public-schema users rows seeded above.
    (req as any).__test_clerkUserId = actingUserId;
    next();
  });
  registerHeatmapRoutes(app);
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

async function call(
  baseUrl: string,
  method: string,
  path: string,
): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : "{}",
  });
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

async function main(): Promise<void> {
  console.log("SEMrush role-gate 403 coverage (Task #2908)");

  await seedUsers();
  __setSemrushCredentialStoreOverrideForTests(credStore);
  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  try {
    await step("account_manager POST /api/semrush/authorize ⇒ 403", async () => {
      actingUserId = AM_ID;
      const { status, json } = await call(baseUrl, "POST", "/api/semrush/authorize");
      assertEq(status, 403, "authorize status for account_manager");
      assert(
        typeof json.error === "string" && json.error.includes("team_lead"),
        `403 body names the required role (got ${JSON.stringify(json.error)})`,
      );
    });

    await step("account_manager POST /api/semrush/disconnect ⇒ 403, credential untouched", async () => {
      actingUserId = AM_ID;
      seedTokens("task2908-live-token");
      const { status } = await call(baseUrl, "POST", "/api/semrush/disconnect");
      assertEq(status, 403, "disconnect status for account_manager");
      assertEq(
        credStore.get(SETTINGS_KEY_ACCESS),
        "task2908-live-token",
        "access token must be UNTOUCHED after a 403 disconnect attempt",
      );
      assertEq(
        credStore.get(SETTINGS_KEY_REFRESH),
        "task2908-live-token-refresh",
        "refresh token must be UNTOUCHED after a 403 disconnect attempt",
      );
    });

    await step("account_manager GET /api/semrush/status ⇒ 200", async () => {
      actingUserId = AM_ID;
      const { status, json } = await call(baseUrl, "GET", "/api/semrush/status");
      assertEq(status, 200, "status route status for account_manager");
      assert("connected" in json, "status body carries the connected field");
    });

    await step("account_manager POST /api/semrush/campaigns/refresh ⇒ 200", async () => {
      actingUserId = AM_ID;
      clearCampaignCache();
      __setForceRefreshCampaignsDepsForTest({
        getConnectionStatus: async () => ({
          connected: true,
          expired: false,
          disconnectReason: null,
          lastProbeError: null,
        }),
        fetchAndMapCampaigns: async () => [
          {
            id: "task2908-campaign",
            businessName: "Task2908 Firm",
            location: "Austin, TX",
            keywords: [],
            gridSettings: {},
          },
        ] as any,
        enrichCampaigns: async () => {},
      });
      const { status, json } = await call(baseUrl, "POST", "/api/semrush/campaigns/refresh");
      assertEq(status, 200, "refresh status for account_manager");
      assertEq(json.status, "ready", "refresh body.status");
      assertEq(json.count, 1, "refresh body.count");
    });

    await step("positive control: team_lead POST /api/semrush/disconnect ⇒ 200, credential cleared", async () => {
      actingUserId = TL_ID;
      seedTokens("task2908-tl-token");
      const { status, json } = await call(baseUrl, "POST", "/api/semrush/disconnect");
      assertEq(status, 200, "disconnect status for team_lead");
      assertEq(json.success, true, "disconnect body.success for team_lead");
      assertEq(
        credStore.get(SETTINGS_KEY_ACCESS) ?? "",
        "",
        "access token must be cleared by a team_lead disconnect",
      );
    });
  } finally {
    server.close();
    __setSemrushCredentialStoreOverrideForTests(null);
    __setForceRefreshCampaignsDepsForTest(null as any);
    await cleanupUsers();
    clearCampaignCache();
  }

  if (failures > 0) throw new Error(`${failures} test(s) failed`);
  console.log("\nAll SEMrush role-gate tests passed");
}

let exitCode = 0;
main()
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
