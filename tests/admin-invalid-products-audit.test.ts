/* test-registration
{
  "name": "Admin invalid-products audit endpoint (Task #1232)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1232 — Regression coverage for the invalid-products audit panel.
 *
 * Task #778 added GET /api/admin/clients/invalid-products: an admin-only
 * read endpoint that walks every client row and surfaces the ones whose
 * stored `products` column still contains values that no longer pass
 * `validateProductList` (see `shared/productResolution.ts`). The admin UI
 * (`client/src/pages/admin/ClientManagement.tsx`) renders these as the
 * amber "Clients with invalid product values" card.
 *
 * Pinned behavior:
 *   1. CEO admin sees offenders with the exact list of invalid values
 *      that `validateProductList` flagged, plus the full stored list.
 *   2. Archived clients are still returned (the UI tags them with an
 *      "archived" badge instead of hiding them), and the `isArchived`
 *      flag round-trips truthfully so the UI can render the badge.
 *   3. Clean clients (all canonical product ids) are NOT included.
 *   4. Non-admin roles (e.g. `account_manager`) receive HTTP 403.
 *
 * The route is registered inline by `registerClientRoutes(app)`. We mount
 * that registrar on a minimal Express app with a stub middleware that sets
 * the Clerk per-request test seam (__test_clerkUserId), so the real
 * requireAuth + role check both run against a seeded DB user.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerClientRoutes } from "../server/routes/clients";
import { bindArrayParam } from "../server/utils/sqlArray";

const TAG = `task-1232-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CEO_ID = `${TAG}-ceo`;
const AM_ID = `${TAG}-am`;
const CLIENT_OFFENDER_ID = `${TAG}-offender`;
const CLIENT_ARCHIVED_ID = `${TAG}-archived`;
const CLIENT_CLEAN_ID = `${TAG}-clean`;

const OFFENDER_BAD_VALUES = ["totally-unknown-product", "legacy_garbage"];
const OFFENDER_STORED = ["gbp", ...OFFENDER_BAD_VALUES];
const ARCHIVED_BAD_VALUES = ["bogus-archived-product"];
const ARCHIVED_STORED = ["lsa", ...ARCHIVED_BAD_VALUES];

async function cleanup(): Promise<void> {
  await db.execute(sql`
    DELETE FROM clients WHERE id IN (
      ${CLIENT_OFFENDER_ID}, ${CLIENT_ARCHIVED_ID}, ${CLIENT_CLEAN_ID}
    )
  `);
  await db.execute(sql`DELETE FROM users WHERE id IN (${CEO_ID}, ${AM_ID})`);
}

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${CEO_ID}, 'ceo', 'Task1232 CEO')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${AM_ID}, 'account_manager', 'Task1232 AM')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);

  // Offender: not archived, not demo, contains two unknown product values.
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, products, is_demo, is_archived)
    VALUES (
      ${CLIENT_OFFENDER_ID},
      ${`Offender Firm ${TAG}`},
      ${bindArrayParam(OFFENDER_STORED)},
      false,
      false
    )
    ON CONFLICT (id) DO UPDATE SET
      products = EXCLUDED.products,
      is_demo = false,
      is_archived = false
  `);

  // Archived offender: same kind of invalid value, but archived. The endpoint
  // still surfaces archived rows; the UI distinguishes them via the
  // `isArchived` flag.
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, products, is_demo, is_archived)
    VALUES (
      ${CLIENT_ARCHIVED_ID},
      ${`Archived Firm ${TAG}`},
      ${bindArrayParam(ARCHIVED_STORED)},
      false,
      true
    )
    ON CONFLICT (id) DO UPDATE SET
      products = EXCLUDED.products,
      is_demo = false,
      is_archived = true
  `);

  // Clean control client: all-canonical products, should NEVER appear in
  // the offenders list.
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, products, is_demo, is_archived)
    VALUES (
      ${CLIENT_CLEAN_ID},
      ${`Clean Firm ${TAG}`},
      ${bindArrayParam(["gbp", "google_ads"])},
      false,
      false
    )
    ON CONFLICT (id) DO UPDATE SET
      products = EXCLUDED.products,
      is_demo = false,
      is_archived = false
  `);
}

function buildApp(actorId: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id (looked up in the committed public-schema
    // users row seeded above); null is explicit-unauthenticated.
    (req as any).__test_clerkUserId = actorId;
    next();
  });
  registerClientRoutes(app);
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

async function fetchAudit(baseUrl: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}/api/admin/clients/invalid-products`);
  const text = await r.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

async function run(): Promise<void> {
  await cleanup();
  await seed();

  // ── Section 1: CEO admin sees both offenders with correct invalid values
  //              and the clean control client is excluded.
  const ceoApp = buildApp(CEO_ID);
  const ceo = await listen(ceoApp);
  try {
    const res = await fetchAudit(ceo.baseUrl);
    assert.equal(res.status, 200, `CEO admin: expected 200, got ${res.status}`);
    assert.ok(typeof res.body?.scanned === "number" && res.body.scanned > 0,
      `CEO admin: response should include scanned count, got ${JSON.stringify(res.body)}`);
    assert.ok(Array.isArray(res.body?.offenders),
      `CEO admin: response should include offenders array`);

    const offenders: any[] = res.body.offenders;
    const offenderById = new Map(offenders.map((o) => [o.id, o]));

    // (1) Offender client is surfaced with the exact invalid values + stored list.
    const offRow = offenderById.get(CLIENT_OFFENDER_ID);
    assert.ok(offRow, "CEO admin: offender client should appear in audit");
    assert.equal(offRow.isArchived, false,
      "CEO admin: offender row should reflect non-archived state");
    assert.deepEqual(
      [...offRow.invalidValues].sort(),
      [...OFFENDER_BAD_VALUES].sort(),
      `CEO admin: offender invalidValues should match seed, got ${JSON.stringify(offRow.invalidValues)}`,
    );
    assert.deepEqual(
      [...offRow.storedProducts].sort(),
      [...OFFENDER_STORED].sort(),
      `CEO admin: offender storedProducts should round-trip, got ${JSON.stringify(offRow.storedProducts)}`,
    );

    // (2) Archived offender is also surfaced, with isArchived=true so the UI
    //     can render the "archived" badge.
    const archivedRow = offenderById.get(CLIENT_ARCHIVED_ID);
    assert.ok(archivedRow,
      "CEO admin: archived client with invalid products should still be surfaced (UI tags it, not hides it)");
    assert.equal(archivedRow.isArchived, true,
      "CEO admin: archived row should have isArchived=true so UI can badge it");
    assert.deepEqual(
      [...archivedRow.invalidValues].sort(),
      [...ARCHIVED_BAD_VALUES].sort(),
      `CEO admin: archived offender invalidValues should match seed`,
    );

    // (3) Clean control client must NOT appear.
    assert.ok(!offenderById.has(CLIENT_CLEAN_ID),
      "CEO admin: clean client (all-canonical products) must not appear in offenders");
  } finally {
    await closeServer(ceo.server);
  }

  // ── Section 2: account_manager (non-admin) gets HTTP 403.
  const amApp = buildApp(AM_ID);
  const am = await listen(amApp);
  try {
    const res = await fetchAudit(am.baseUrl);
    assert.equal(res.status, 403,
      `account_manager: expected 403, got ${res.status} body=${JSON.stringify(res.body)}`);
    assert.ok(
      typeof res.body?.error === "string" && /admin/i.test(res.body.error),
      `account_manager: 403 body should include an admin-required error, got ${JSON.stringify(res.body)}`,
    );
  } finally {
    await closeServer(am.server);
  }

  console.log("admin-invalid-products-audit: PASSED");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run()
  .then(async () => {
    await cleanup().catch(() => undefined);
  })
  .catch(async (err) => {
    console.error("admin-invalid-products-audit: FAILED", err);
    await cleanup().catch(() => undefined);
    process.exitCode = 1;
  });
