/* test-registration
{
  "name": "GET /api/command-panel-summaries derives missingBudgets (product selected but budget NULL) for the client-list flags (Task #4038)",
  "regression": true,
  "sweepOnlyReason": "DB-bound route suite (isolated-schema Postgres tables + a real HTTP server per run); belongs in the full suite and the nightly --regression sweep, not the routine TEST_SMOKE gate.",
  "tier": "small"
}
test-registration */
/**
 * Task #4038 — the client list flags clients whose command panel has a
 * product selected but the matching budget NULL (lsa/google_ads/webinar).
 * The flags come from GET /api/command-panel-summaries, which now returns
 * `missingBudgets: string[]` per panel. This suite pins:
 *
 *   (1) A panel with lsa+google_ads selected and only google_ads budgeted
 *       reports missingBudgets = ["lsa"].
 *   (2) A panel with all selected products budgeted reports [].
 *   (3) A product NOT selected never flags, even with a NULL budget
 *       (gbp-only panel with every budget NULL → []).
 *   (4) A webinar-selected panel with webinar budget NULL flags "webinar";
 *       zero budgets count as entered (0 is a value, only NULL flags).
 *   (5) Non-account-manager callers still only see their own clients' rows.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { registerCommandCenterRoutes } from "../server/routes/commandCenter";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

const TAG = "cp-sum-4038";
const CEO_ID = `${TAG}-ceo`;
const SALES_ID = `${TAG}-sales`;
const CLIENT_GAP = `${TAG}-client-gap`;         // lsa+google_ads selected, only google_ads budgeted
const CLIENT_FULL = `${TAG}-client-full`;       // all selected products budgeted (webinar budget 0)
const CLIENT_GBP = `${TAG}-client-gbp-only`;    // gbp only, all budgets NULL
const CLIENT_WEBINAR = `${TAG}-client-webinar`; // webinar selected, webinar budget NULL

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): the acting id comes
    // from the x-test-user header (defaults to CEO_ID). The pre-Clerk
    // passport-shape injection stopped working when auth migrated.
    const sub = (req.headers["x-test-user"] as string) || CEO_ID;
    (req as any).__test_clerkUserId = sub;
    next();
  });
  registerCommandCenterRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      await isoDb.execute(sql`
        INSERT INTO users (id, role, authority_level, first_name)
        VALUES
          (${CEO_ID}, 'ceo', 'ceo', ${`${TAG}-ceo`}),
          (${SALES_ID}, 'sales', 'sales', ${`${TAG}-sales`})
        ON CONFLICT (id) DO UPDATE
          SET role = EXCLUDED.role, authority_level = EXCLUDED.authority_level
      `);
      // Users live only in the isolated sandbox schema; pre-register them
      // with requireAuth's registry so admission uses the profile directly
      // rather than JIT-provisioning a stray public row.
      __test_markUserReconciled(CEO_ID, { id: CEO_ID, role: "ceo", authorityLevel: "ceo" });
      __test_markUserReconciled(SALES_ID, { id: SALES_ID, role: "sales", authorityLevel: "sales" });
      await isoDb.execute(sql`
        INSERT INTO clients (id, firm_name, products, owner_id)
        VALUES
          (${CLIENT_GAP}, ${`${TAG} Gap Firm`}, ARRAY['lsa','google_ads']::text[], ${SALES_ID}),
          (${CLIENT_FULL}, ${`${TAG} Full Firm`}, ARRAY['lsa','google_ads','webinar']::text[], NULL),
          (${CLIENT_GBP}, ${`${TAG} GBP Firm`}, ARRAY['gbp']::text[], NULL),
          (${CLIENT_WEBINAR}, ${`${TAG} Webinar Firm`}, ARRAY['webinar']::text[], NULL)
      `);
      await isoDb.execute(sql`
        INSERT INTO command_panels (client_id, product_types, lsa_budget, google_ads_budget, webinar_budget)
        VALUES
          (${CLIENT_GAP}, ARRAY['lsa','google_ads']::text[], NULL, 5000, NULL),
          (${CLIENT_FULL}, ARRAY['lsa','google_ads','webinar']::text[], 1000, 2000, 0),
          (${CLIENT_GBP}, ARRAY['gbp']::text[], NULL, NULL, NULL),
          (${CLIENT_WEBINAR}, ARRAY['webinar']::text[], NULL, NULL, NULL)
      `);

      const app = buildApp();
      const { server, baseUrl } = await listen(app);
      try {
        const res = await fetch(`${baseUrl}/api/command-panel-summaries`, {
          headers: { "x-test-user": CEO_ID },
        });
        assert.equal(res.status, 200);
        const rows: Array<{ clientId: string; missingBudgets: string[] }> = await res.json();
        const byClient = new Map(rows.map((r) => [r.clientId, r]));

        // (1) gap panel: lsa selected + NULL lsa budget; webinar not selected
        //     despite NULL webinar budget, so only "lsa" flags.
        assert.deepEqual(byClient.get(CLIENT_GAP)?.missingBudgets, ["lsa"]);
        console.log("  ok  (1) selected-but-NULL budget flags exactly the gapped product");

        // (2)+(4) fully budgeted panel: 0 counts as an entered budget.
        assert.deepEqual(byClient.get(CLIENT_FULL)?.missingBudgets, []);
        console.log("  ok  (2) fully budgeted panel reports no gaps (0 is a value, not NULL)");

        // (3) gbp-only panel with every budget NULL never flags.
        assert.deepEqual(byClient.get(CLIENT_GBP)?.missingBudgets, []);
        console.log("  ok  (3) unselected products never flag even with NULL budgets");

        // (4) webinar selected + NULL webinar budget flags "webinar".
        assert.deepEqual(byClient.get(CLIENT_WEBINAR)?.missingBudgets, ["webinar"]);
        console.log("  ok  (4) webinar gap flags correctly");

        // (5) role scoping: the sales user only sees their own client's row,
        //     and it still carries the derived flags.
        const scoped = await fetch(`${baseUrl}/api/command-panel-summaries`, {
          headers: { "x-test-user": SALES_ID },
        });
        assert.equal(scoped.status, 200);
        const scopedRows: Array<{ clientId: string; missingBudgets: string[] }> = await scoped.json();
        // Scope the assert to this suite's fixture clients only (shared-DB
        // ambient rows must not affect the verdict).
        const fixtureIds = new Set([CLIENT_GAP, CLIENT_FULL, CLIENT_GBP, CLIENT_WEBINAR]);
        const scopedFixture = scopedRows.filter((r) => fixtureIds.has(r.clientId));
        assert.deepEqual(scopedFixture.map((r) => r.clientId), [CLIENT_GAP]);
        assert.deepEqual(scopedFixture[0]?.missingBudgets, ["lsa"]);
        console.log("  ok  (5) non-account-manager scoping preserved with flags attached");
      } finally {
        __test_resetReconciledUsers();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    { tables: ["users", "clients", "command_panels"] },
  );

  console.log("PASS command-panel-summaries-missing-budgets");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
