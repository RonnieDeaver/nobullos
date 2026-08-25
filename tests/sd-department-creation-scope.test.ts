/* test-registration
{
  "name": "SD department creation-time scope — default/explicit/invalid + per-client surface exclusion (Task #4893)",
  "regression": true,
  "sweepOnlyReason": "Task #4893 — live-DB route test (POST /api/clients seeding goes through storage.createClient, which bypasses isolated-schema pinning) + real HTTP server; random-suffixed fixtures with finally-cleanup.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4893 — creation-time assignment scope for service-desk departments.
 *
 * Department creation used to accept only name + sort order, so every new
 * department was born per_client and a company-scope one polluted per-client
 * surfaces (and client-creation seeding) until someone remembered the scope
 * toggle. Sections:
 *   (A) POST without assignmentScope → persists the 'per_client' default.
 *   (B) POST with 'company' (and explicit 'per_client') → persisted verbatim.
 *   (C) POST with an invalid scope → 400 with the PUT route's exact message;
 *       no row created.
 *       A retired Supervisor key is also rejected rather than ignored.
 *   (D) GET client-team-options excludes the company-created department
 *       (Add Client form never asks for its picks).
 *   (E) POST /api/clients: seeding skips the company-created department with
 *       no interim flip needed; an explicit pick for it is rejected 400.
 *
 * Live-DB pattern copied from sd-client-creation-team-seed.test.ts:
 * random-suffixed fixtures + finally cleanup; asserts scope to THIS run's
 * ids, never totals.
 */

import "./helpers/forceTestEnv";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { getGlobalDispatcher } from "undici";

import { db } from "../server/db";
import { registerClientRoutes } from "../server/routes/clients";
import { registerServiceDeskRoutes } from "../server/routes/serviceDesk";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const CREATOR_ID = `test-4893cs-creator-${RUN}`;

const createdClientIds: string[] = [];
const createdDeptIds: string[] = [];

function buildApp(authAs: string | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk per-request test seam (server/middlewares/requireAuth.ts).
    (req as any).__test_clerkUserId = authAs;
    next();
  });
  registerClientRoutes(app);
  registerServiceDeskRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function req(
  baseUrl: string,
  method: string,
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function postDept(
  baseUrl: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const res = await req(baseUrl, "POST", "/api/service-desk/departments", payload);
  if (res.status === 200 && res.body?.department?.id) createdDeptIds.push(res.body.department.id);
  return res;
}

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name, last_name)
    VALUES (${CREATOR_ID}, 'ceo', 'Creator', ${RUN})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
}

async function cleanup(): Promise<void> {
  for (const cid of createdClientIds) {
    await db.execute(sql`DELETE FROM sd_client_dept_assignments WHERE client_id = ${cid}`).catch(() => 0);
    await db.execute(sql`DELETE FROM user_activity_logs WHERE metadata->>'clientId' = ${cid}`).catch(() => 0);
    await db.execute(sql`DELETE FROM clients WHERE id = ${cid}`).catch(() => 0);
  }
  for (const did of createdDeptIds) {
    await db.execute(sql`DELETE FROM sd_client_dept_assignments WHERE department_id = ${did}`).catch(() => 0);
    await db.execute(sql`DELETE FROM sd_departments WHERE id = ${did}`).catch(() => 0);
  }
  await db.execute(sql`DELETE FROM users WHERE id = ${CREATOR_ID}`).catch(() => 0);
}

async function main(): Promise<void> {
  await seed();
  const { server, baseUrl } = await listen(buildApp(CREATOR_ID));
  try {
    // ── (A) omitted scope → per_client default ──────────────────────────
    const a = await postDept(baseUrl, { name: `Scope Default ${RUN}`, sortOrder: 9301 });
    assert.equal(a.status, 200, `A: create must be 200 (got ${a.status}: ${JSON.stringify(a.body)})`);
    assert.equal(a.body.department.assignmentScope, "per_client", "A: omitted scope persists the per_client default");
    const defaultDeptId = a.body.department.id as string;
    console.log("  ✓ A: omitted assignmentScope → per_client default persisted");

    // ── (B) explicit scopes persisted verbatim ──────────────────────────
    const b = await postDept(baseUrl, { name: `Scope Company ${RUN}`, sortOrder: 9302, assignmentScope: "company" });
    assert.equal(b.status, 200, `B: company create must be 200 (got ${b.status}: ${JSON.stringify(b.body)})`);
    assert.equal(b.body.department.assignmentScope, "company", "B: company scope persisted in the response");
    const companyDeptId = b.body.department.id as string;
    const bRow = await db.execute(sql`SELECT assignment_scope FROM sd_departments WHERE id = ${companyDeptId}`);
    assert.equal((bRow.rows as any[])[0]?.assignment_scope, "company", "B: company scope persisted in the DB");

    const b2 = await postDept(baseUrl, { name: `Scope PerClient ${RUN}`, sortOrder: 9303, assignmentScope: "per_client" });
    assert.equal(b2.status, 200, `B: explicit per_client create must be 200 (got ${b2.status})`);
    assert.equal(b2.body.department.assignmentScope, "per_client", "B: explicit per_client persisted");
    const perClientDeptId = b2.body.department.id as string;
    console.log("  ✓ B: explicit company / per_client persisted verbatim (response + DB)");

    // ── (C) invalid scope → 400, exact PUT-route message, no row ────────
    const cName = `Scope Bogus ${RUN}`;
    const c = await postDept(baseUrl, { name: cName, assignmentScope: "global" });
    assert.equal(c.status, 400, `C: invalid scope must be 400 (got ${c.status}: ${JSON.stringify(c.body)})`);
    assert.equal(
      c.body.error,
      "assignmentScope must be one of: per_client, company",
      `C: exact validation message (got ${JSON.stringify(c.body)})`,
    );
    const cCheck = await db.execute(sql`SELECT id FROM sd_departments WHERE name = ${cName}`);
    assert.equal((cCheck.rows as any[]).length, 0, "C: no department row created from the rejected payload");
    console.log("  ✓ C: invalid scope → 400 with the shared validation message, nothing persisted");

    const retiredName = `Scope Retired Key ${RUN}`;
    const retired = await postDept(baseUrl, {
      name: retiredName,
      defaultSupervisorUserId: CREATOR_ID,
    });
    assert.equal(
      retired.status,
      400,
      `C: retired Supervisor key must be rejected (got ${retired.status}: ${JSON.stringify(retired.body)})`,
    );
    const retiredCheck = await db.execute(sql`SELECT id FROM sd_departments WHERE name = ${retiredName}`);
    assert.equal(
      (retiredCheck.rows as any[]).length,
      0,
      "C: stale Supervisor payload must not create a department",
    );
    console.log("  ✓ C: retired Supervisor creation key → 400, nothing persisted");

    // ── (D) company-created dept excluded from the Add Client form ──────
    const opts = await req(baseUrl, "GET", "/api/service-desk/client-team-options");
    assert.equal(opts.status, 200, `D: options endpoint must be 200 (got ${opts.status})`);
    const optIds = (opts.body.departments as any[]).map((d) => d.id);
    assert.ok(optIds.includes(defaultDeptId), "D: default-scope dept offered on the Add Client form");
    assert.ok(optIds.includes(perClientDeptId), "D: explicit per_client dept offered");
    assert.ok(!optIds.includes(companyDeptId), "D: company-created dept excluded with no interim flip");
    console.log("  ✓ D: client-team-options excludes the company-created department");

    // ── (E) client creation never seeds the company-created dept ────────
    const e = await req(baseUrl, "POST", "/api/clients", {
      firmName: `Scope Firm ${RUN}`,
      contactName: "Task4893 Contact",
      products: ["gbp"],
    });
    assert.equal(e.status, 201, `E: create must be 201 (got ${e.status}: ${JSON.stringify(e.body)})`);
    if (e.body?.id) createdClientIds.push(e.body.id);
    const seeded = await db.execute(sql`
      SELECT department_id FROM sd_client_dept_assignments WHERE client_id = ${e.body.id}
    `);
    const seededIds = new Set((seeded.rows as any[]).map((r) => r.department_id));
    assert.ok(seededIds.has(defaultDeptId), "E: per_client (default) dept seeded");
    assert.ok(seededIds.has(perClientDeptId), "E: per_client (explicit) dept seeded");
    assert.ok(!seededIds.has(companyDeptId), "E: company-created dept gets NO per-client row");

    const e2 = await req(baseUrl, "POST", "/api/clients", {
      firmName: `Scope Firm Rejected ${RUN}`,
      contactName: "Task4893 Contact",
      products: ["gbp"],
      teamAssignments: [{ departmentId: companyDeptId }],
    });
    assert.equal(e2.status, 400, `E: explicit pick for a company-created dept must be 400 (got ${e2.status})`);
    assert.ok(
      String(e2.body?.error ?? "").includes("company-wide"),
      `E: rejection explains the company-wide rule (got ${JSON.stringify(e2.body)})`,
    );
    console.log("  ✓ E: client-creation seeding skips the company-created dept; explicit pick rejected");
  } finally {
    server.close();
    await cleanup();
  }

  await getGlobalDispatcher().close();
  console.log("sd-department-creation-scope: all sections passed (Task #4893).");
}

main().then(
  () => process.exit(0),
  (err) => {
    cleanup().finally(() => {
      console.error("sd-department-creation-scope: FAILED —", err?.stack ?? err);
      process.exit(1);
    });
  },
);
