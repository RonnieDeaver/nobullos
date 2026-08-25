/* test-registration
{
  "name": "Dashboard cross-client Win Feed endpoint (Task #4874)",
  "regression": true,
  "sweepOnlyReason": "Task #4874 — cross-client Win Feed route e2e: DB-heavy (runInIsolatedSchema: users, clients, intelligence_feed_entries) + real HTTP server; runs in the full sweep, not the smoke gate.",
  "tier": "small"
}
test-registration */
/**
 * Task #4874 — Dashboard Win Feed: `GET /api/dashboard/wins` e2e.
 *
 * Boots the real command-center routes (auth gate included) against an
 * isolated schema and asserts over the parsed HTTP JSON body that:
 *
 *   1. The gate holds: unauthenticated gets 401, a below-account-manager
 *      role (sales) gets 403, an account_manager gets 200 — deliberately
 *      NOT the per-client requireCommandCenterAccess gate, because this is
 *      a cross-client read.
 *   2. Rows come back newest-first with client firm name, demo flag, and
 *      author identity (left-joined, so wins survive author deletion).
 *   3. Exclusions: non-win entry types, archived (retracted) entries, and
 *      wins on archived clients never appear. Demo-client wins DO appear
 *      with `clientIsDemo: true` — hiding them is the client-side global
 *      hide-demo toggle's job, mirroring Recent Reports.
 *   4. The `limit` param is validated and clamped: default 20 on garbage,
 *      floor 1, cap 50 — never unbounded.
 *
 * Everything runs inside `runInIsolatedSchema` with `pinGetDbForCrossAsync`
 * so the HTTP handler (a separate async context) reads the cloned tables,
 * not live `public`. IDs still carry a per-run random suffix as defense in
 * depth against any search_path fallthrough.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { registerCommandCenterRoutes } from "../server/routes/commandCenter";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { runInIsolatedSchema } from "./db-sandbox";

const RUN = randomUUID().slice(0, 8);
const AM_ID = `test-4874-am-${RUN}`;
const TL_ID = `test-4874-tl-${RUN}`;
const SALES_ID = `test-4874-sales-${RUN}`;
const C_ACTIVE = `test-4874-client-active-${RUN}`;
const C_DEMO = `test-4874-client-demo-${RUN}`;
const C_ARCHIVED = `test-4874-client-archived-${RUN}`;
const W1 = `test-4874-win-1-${RUN}`; // newest, active client, by AM
const W2 = `test-4874-win-2-${RUN}`; // active client, by TL
const W3 = `test-4874-win-3-${RUN}`; // demo client — included, flagged
const W_ARCHIVED_CLIENT = `test-4874-win-4-${RUN}`; // archived client — excluded
const W_ARCHIVED_STATUS = `test-4874-win-5-${RUN}`; // retracted entry — excluded
const NON_WIN = `test-4874-note-1-${RUN}`; // other entry type — excluded

function buildApp(actingUserId: string | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk per-request test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated.
    (req as any).__test_clerkUserId = actingUserId;
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

async function get(baseUrl: string, p: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${p}`);
  const text = await r.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

async function withServer(
  actingUserId: string | null,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const { server, baseUrl } = await listen(buildApp(actingUserId));
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      // ── Seed users ──
      await isoDb.execute(sql`
        INSERT INTO users (id, role, authority_level, first_name, last_name, email)
        VALUES
          (${AM_ID}, 'account_manager', 'core', 'Alice', 'Alpha', ${`alice-${RUN}@test.local`}),
          (${TL_ID}, 'team_lead', 'director', 'Tessa', 'Lead', ${`tessa-${RUN}@test.local`}),
          (${SALES_ID}, 'sales', 'core', 'Sam', 'Seller', ${`sam-${RUN}@test.local`})
      `);
      // Users are seeded in the isolated (uncommitted) schema, but requireAuth
      // resolves identity via its direct ambient `db` import (PUBLIC schema),
      // which never sees these rows. Pre-register each acting identity so
      // requireAuth admits them without JIT-provisioning a public row; the
      // requireAccountManager gate still reads the isolated-schema role via
      // storage.getUser (pinGetDbForCrossAsync).
      __test_markUserReconciled(AM_ID, {
        id: AM_ID,
        firstName: "Alice",
        lastName: "Alpha",
        role: "account_manager",
      });
      __test_markUserReconciled(TL_ID, {
        id: TL_ID,
        firstName: "Tessa",
        lastName: "Lead",
        role: "team_lead",
      });
      __test_markUserReconciled(SALES_ID, {
        id: SALES_ID,
        firstName: "Sam",
        lastName: "Seller",
        role: "sales",
      });

      // ── Seed clients ──
      await isoDb.execute(sql`
        INSERT INTO clients (id, firm_name, owner_id, is_archived, is_demo)
        VALUES
          (${C_ACTIVE}, ${"Firm Active " + RUN}, ${AM_ID}, false, false),
          (${C_DEMO}, ${"Firm Demo " + RUN}, ${AM_ID}, false, true),
          (${C_ARCHIVED}, ${"Firm Archived " + RUN}, ${AM_ID}, true, false)
      `);

      // ── Seed intel entries (explicit timestamps pin the expected order) ──
      const now = Date.now();
      const HOUR = 60 * 60 * 1000;
      const t1 = new Date(now - 1 * HOUR); // newest
      const t2 = new Date(now - 24 * HOUR);
      const t3 = new Date(now - 48 * HOUR);
      const tOld = new Date(now - 72 * HOUR);
      await isoDb.execute(sql`
        INSERT INTO intelligence_feed_entries (id, client_id, created_by, entry_type, title, body, status, created_at)
        VALUES
          (${W1}, ${C_ACTIVE}, ${AM_ID}, 'win_progress', ${"Win one " + RUN}, ${"Closed the deal " + RUN}, 'approved', ${t1}),
          (${W2}, ${C_ACTIVE}, ${TL_ID}, 'win_progress', ${"Win two " + RUN}, NULL, 'approved', ${t2}),
          (${W3}, ${C_DEMO}, ${AM_ID}, 'win_progress', ${"Win three demo " + RUN}, NULL, 'approved', ${t3}),
          (${W_ARCHIVED_CLIENT}, ${C_ARCHIVED}, ${AM_ID}, 'win_progress', ${"Win archived client " + RUN}, NULL, 'approved', ${tOld}),
          (${W_ARCHIVED_STATUS}, ${C_ACTIVE}, ${AM_ID}, 'win_progress', ${"Win retracted " + RUN}, NULL, 'archived', ${tOld}),
          (${NON_WIN}, ${C_ACTIVE}, ${AM_ID}, 'general_update', ${"Not a win " + RUN}, NULL, 'approved', ${t1})
      `);

      // The sandbox clones table CONTENTS too; cloned real intel rows would
      // pollute global ordering and absolute-length asserts (a cloned row can
      // be newer than our fixtures). Deleting them inside the isolated schema
      // is hermetic — public is untouched.
      await isoDb.execute(sql`
        DELETE FROM intelligence_feed_entries WHERE id NOT LIKE ${"test-4874-%" + RUN}
      `);

      const fixtureIds = new Set([W1, W2, W3, W_ARCHIVED_CLIENT, W_ARCHIVED_STATUS, NON_WIN]);
      const ours = (body: any[]) => body.filter((w) => fixtureIds.has(w.id));

      // ── 1) Auth gate ──
      await withServer(null, async (baseUrl) => {
        const r = await get(baseUrl, "/api/dashboard/wins");
        assert.equal(r.status, 401, `unauthenticated should 401, got ${r.status}`);
      });
      await withServer(SALES_ID, async (baseUrl) => {
        const r = await get(baseUrl, "/api/dashboard/wins");
        assert.equal(r.status, 403, `sales should 403, got ${r.status}: ${JSON.stringify(r.body)}`);
      });

      // ── 2) Content, ordering, exclusions (as account manager) ──
      await withServer(AM_ID, async (baseUrl) => {
        const r = await get(baseUrl, "/api/dashboard/wins");
        assert.equal(r.status, 200, `AM should 200, got ${r.status}: ${JSON.stringify(r.body)}`);
        assert.ok(Array.isArray(r.body), "body should be an array");
        const wins = ours(r.body);
        assert.deepEqual(
          wins.map((w: any) => w.id),
          [W1, W2, W3],
          "exactly the three eligible wins, newest first",
        );

        const w1 = wins[0];
        assert.equal(w1.clientId, C_ACTIVE);
        assert.equal(w1.clientFirmName, "Firm Active " + RUN);
        assert.equal(w1.clientIsDemo, false);
        assert.equal(w1.title, "Win one " + RUN);
        assert.equal(w1.body, "Closed the deal " + RUN);
        assert.equal(w1.createdBy, AM_ID);
        assert.equal(w1.authorFirstName, "Alice");
        assert.equal(w1.authorLastName, "Alpha");
        assert.equal(w1.authorEmail, `alice-${RUN}@test.local`);
        assert.ok(w1.createdAt, "createdAt present");

        const w2 = wins[1];
        assert.equal(w2.createdBy, TL_ID);
        assert.equal(w2.authorFirstName, "Tessa");
        assert.equal(w2.body, null);

        const w3 = wins[2];
        assert.equal(w3.clientId, C_DEMO);
        assert.equal(w3.clientIsDemo, true, "demo win included but flagged");

        // ── 3) Limit validation ──
        const rLimit2 = await get(baseUrl, "/api/dashboard/wins?limit=2");
        assert.equal(rLimit2.status, 200);
        assert.deepEqual(
          ours(rLimit2.body).map((w: any) => w.id),
          [W1, W2],
          "limit=2 keeps the two newest",
        );
        // The isolated schema contains only our rows, so the raw lengths are
        // meaningful too (proves the LIMIT reached SQL, not just a slice).
        assert.equal(rLimit2.body.length, 2);

        const rLimit0 = await get(baseUrl, "/api/dashboard/wins?limit=0");
        assert.equal(rLimit0.status, 200);
        assert.equal(rLimit0.body.length, 1, "limit=0 clamps to floor 1");
        assert.equal(rLimit0.body[0].id, W1);

        const rGarbage = await get(baseUrl, "/api/dashboard/wins?limit=abc");
        assert.equal(rGarbage.status, 200);
        assert.equal(ours(rGarbage.body).length, 3, "garbage limit falls back to default 20");

        const rHuge = await get(baseUrl, "/api/dashboard/wins?limit=999");
        assert.equal(rHuge.status, 200, "oversized limit clamps to 50 and still succeeds");
        assert.equal(ours(rHuge.body).length, 3);
      });

      // ── 4) Team lead passes the gate too ──
      await withServer(TL_ID, async (baseUrl) => {
        const r = await get(baseUrl, "/api/dashboard/wins?limit=1");
        assert.equal(r.status, 200, `TL should 200, got ${r.status}`);
        assert.equal(r.body.length, 1);
      });

      __test_resetReconciledUsers();
    },
    {
      tables: ["users", "clients", "intelligence_feed_entries"],
      pinGetDbForCrossAsync: true,
    },
  );
}

main().then(
  () => {
    console.log("dashboard-wins-route: all sections passed");
    process.exit(0);
  },
  (err) => {
    console.error("dashboard-wins-route: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
