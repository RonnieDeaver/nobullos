/* test-registration
{
  "name": "Share endpoint carries hideOtherLeads (Task #2766)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2766: the public share route must always inject the per-client hideOtherLeads flag into the payload's client object (true / false / NULL-clamped-to-false). The rendered PublicReport test stubs the /api/share payload, so only this route-level test catches the SERVER dropping the field — a silent regression that would re-show Other leads on every hide-Other client's public report. Real route + dev DB, fast (3 fetches).",
  "tier": "small"
}
test-registration */
/**
 * Task #2766 — Regression: the public share endpoint must always carry the
 * per-client hide-Other setting (`client.hideOtherLeads`, Task #2667) in its
 * payload.
 *
 * The rendered PublicReport test stubs the /api/share payload, so it only
 * proves the CLIENT suppresses the Other bucket when the flag arrives — it
 * cannot catch the server dropping the field. This test hits the real route
 * (GET /api/share/:token → buildReportResponse in server/routes/reports.ts)
 * and pins:
 *   1. hideOtherLeads=true in the DB  → response client.hideOtherLeads === true
 *   2. hideOtherLeads=false in the DB → response client.hideOtherLeads === false
 *   3. hideOtherLeads=NULL in the DB  → response client.hideOtherLeads === false
 *      (the route clamps with `=== true`, so absent/null must serialize as an
 *      explicit boolean false, never undefined/missing — the public renderer
 *      treats a missing field as "show Other", which is the correct default,
 *      but the field itself must always be present as a boolean).
 *   4. (Task #2774) Privacy mode (?private=true) — the same payload builder
 *      has a branch that swaps in "Confidential Client" fields. If a refactor
 *      rebuilds the safeClient object inside that branch and forgets
 *      hideOtherLeads, privacy-mode shares would silently show Other leads
 *      while the normal-mode cases above stay green. Pins that with
 *      hideOtherLeads=true in the DB, a ?private=true fetch returns BOTH
 *      firmName === "Confidential Client" AND client.hideOtherLeads === true
 *      (and false stays an explicit false in privacy mode too).
 *
 * If a refactor omits hideOtherLeads from the share payload, the public
 * report silently shows Other leads again and every existing test stays
 * green — this test is the tripwire.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerReportRoutes } from "../server/routes/reports";

const TAG = `task-2766-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CLIENT_ID = `${TAG}-client`;
const REPORT_ID = `${TAG}-report`;
const SHARE_TOKEN = `${TAG}-share-token`;

let passed = 0;
let failed = 0;

function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL ${msg}`);
  }
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM reports WHERE id = ${REPORT_ID}`).catch(() => 0);
  await db.execute(sql`DELETE FROM clients WHERE id = ${CLIENT_ID}`).catch(() => 0);
}

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, contact_name, hide_other_leads)
    VALUES (${CLIENT_ID}, ${"Task2766 Firm " + TAG}, 'Task2766', true)
    ON CONFLICT (id) DO UPDATE SET hide_other_leads = true
  `);
  await db.execute(sql`
    INSERT INTO reports
      (id, client_id, report_month, status, share_token)
    VALUES (
      ${REPORT_ID}, ${CLIENT_ID}, ${TAG + "-month"}, 'final', ${SHARE_TOKEN}
    )
    ON CONFLICT (id) DO UPDATE SET
      client_id = EXCLUDED.client_id,
      status = 'final',
      share_token = EXCLUDED.share_token
  `);
}

async function setHideOtherLeads(value: boolean | null): Promise<void> {
  await db.execute(sql`
    UPDATE clients SET hide_other_leads = ${value} WHERE id = ${CLIENT_ID}
  `);
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Anonymous public-share consumer — no auth (Clerk test seam:
    // null = explicit-unauthenticated).
    (req as any).__test_clerkUserId = null;
    next();
  });
  registerReportRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function fetchSharePayload(baseUrl: string, query = ""): Promise<any> {
  const r = await fetch(`${baseUrl}/api/share/${SHARE_TOKEN}${query}`);
  ok(r.status === 200, `GET /api/share/:token${query} → 200 (got ${r.status})`);
  return r.json();
}

async function run(): Promise<void> {
  await cleanup();
  await seed();

  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  try {
    // 1. hideOtherLeads = true → payload carries an explicit boolean true.
    {
      const body = await fetchSharePayload(baseUrl);
      ok(body && typeof body.client === "object" && body.client !== null, "share payload includes a client object");
      ok(
        Object.prototype.hasOwnProperty.call(body.client ?? {}, "hideOtherLeads"),
        "client object carries the hideOtherLeads key when true",
      );
      ok(
        body.client?.hideOtherLeads === true,
        `hideOtherLeads=true in DB → client.hideOtherLeads === true (got ${JSON.stringify(body.client?.hideOtherLeads)})`,
      );
    }

    // 2. hideOtherLeads = false → explicit boolean false (not missing).
    {
      await setHideOtherLeads(false);
      const body = await fetchSharePayload(baseUrl);
      ok(
        Object.prototype.hasOwnProperty.call(body.client ?? {}, "hideOtherLeads"),
        "client object carries the hideOtherLeads key when false",
      );
      ok(
        body.client?.hideOtherLeads === false,
        `hideOtherLeads=false in DB → client.hideOtherLeads === false (got ${JSON.stringify(body.client?.hideOtherLeads)})`,
      );
    }

    // 3. hideOtherLeads = NULL (legacy/unset row) → clamps to explicit false.
    {
      await setHideOtherLeads(null);
      const body = await fetchSharePayload(baseUrl);
      ok(
        Object.prototype.hasOwnProperty.call(body.client ?? {}, "hideOtherLeads"),
        "client object carries the hideOtherLeads key when NULL in DB",
      );
      ok(
        body.client?.hideOtherLeads === false,
        `hideOtherLeads=NULL in DB → client.hideOtherLeads === false (got ${JSON.stringify(body.client?.hideOtherLeads)})`,
      );
    }

    // 4. Task #2774 — privacy mode (?private=true) swaps in confidential
    //    client fields; hideOtherLeads must survive that branch.
    {
      await setHideOtherLeads(true);
      const body = await fetchSharePayload(baseUrl, "?private=true");
      ok(
        body.client?.firmName === "Confidential Client",
        `?private=true → firmName === "Confidential Client" (got ${JSON.stringify(body.client?.firmName)})`,
      );
      ok(
        body.client?.contactName === null,
        `?private=true → contactName === null (got ${JSON.stringify(body.client?.contactName)})`,
      );
      ok(
        Object.prototype.hasOwnProperty.call(body.client ?? {}, "hideOtherLeads"),
        "privacy-mode client object still carries the hideOtherLeads key",
      );
      ok(
        body.client?.hideOtherLeads === true,
        `hideOtherLeads=true in DB + ?private=true → client.hideOtherLeads === true (got ${JSON.stringify(body.client?.hideOtherLeads)})`,
      );
    }

    // 4b. Privacy mode with the flag off — still an explicit boolean false.
    {
      await setHideOtherLeads(false);
      const body = await fetchSharePayload(baseUrl, "?private=true");
      ok(
        body.client?.hideOtherLeads === false,
        `hideOtherLeads=false in DB + ?private=true → client.hideOtherLeads === false (got ${JSON.stringify(body.client?.hideOtherLeads)})`,
      );
    }
  } finally {
    await closeServer(server);
    // Route tests that fetch a local express server can hang on exit via
    // undici's keep-alive sockets — close the global dispatcher.
    try {
      const { getGlobalDispatcher } = await import("undici");
      await getGlobalDispatcher().close();
    } catch {
      // best-effort
    }
  }

  await cleanup();

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exitCode = 1; return; }
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit().
run().then(
  () => {},
  async (err) => {
    console.error("Test threw:", err);
    await cleanup().catch(() => 0);
    process.exitCode = 1;
  },
);
