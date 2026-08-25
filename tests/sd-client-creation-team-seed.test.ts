/* test-registration
{
  "name": "Client creation seeds SD team assignments — options endpoint + default/explicit/stale-skip + validation (Task #4171)",
  "regression": true,
  "sweepOnlyReason": "Task #4171 — live-DB route test (POST /api/clients goes through storage.createClient, which bypasses isolated-schema pinning) + real HTTP server; random-suffixed fixtures with finally-cleanup.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4171 — Client creation seeds per-department role assignments.
 *
 * Sections:
 *   (A) GET /api/service-desk/client-team-options — only active per_client
 *       departments, stale defaults nulled, membersByDept = {id,name} sorted
 *       (inactive members excluded).
 *   (B) POST /api/clients with NO teamAssignments — every client-facing
 *       department gets a row seeded from its defaults; a stale default is
 *       skipped (null), company + inactive departments get NO row.
 *   (C) POST with explicit picks — override beats default, explicit null
 *       stores null, untouched roles inherit; rows visible via the
 *       assignments GET afterwards (still editable like any other).
 *   (D) POST with a non-member pick — 422 and the client is NOT created.
 *   (E) POST shape/target validation — 400 for company dept, unknown dept,
 *       duplicate entries, non-array payload, entry without departmentId
 *       (client never created).
 *
 * Live-DB pattern copied from audit-history.test.ts: POST /api/clients runs
 * through storage.createClient (module-level db), so runInIsolatedSchema
 * pinning would split writes across schemas. Random-suffixed fixtures +
 * finally cleanup instead; asserts scope to THIS run's ids, never totals.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

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
const CREATOR_ID = `test-4171cs-creator-${RUN}`;
const D_DOER_ID = `test-4171cs-ddoer-${RUN}`;
const D_CHK_ID = `test-4171cs-dchk-${RUN}`; // stale default holder (inactive member)
const PICK_ID = `test-4171cs-pick-${RUN}`; // active member used for explicit picks
const NONMEM_ID = `test-4171cs-nonmem-${RUN}`; // user who is NOT a dept member
const DEPT_A = `dept-4171cs-a-${RUN}`; // per_client, defaults: doer live, checker stale
const DEPT_B = `dept-4171cs-b-${RUN}`; // per_client, no defaults
const DEPT_CO = `dept-4171cs-co-${RUN}`; // company scope — never seeded per client
const DEPT_OFF = `dept-4171cs-off-${RUN}`; // inactive — never seeded

const createdClientIds: string[] = [];

function buildApp(authAs: string | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk per-request test seam (server/middlewares/requireAuth.ts): a
    // string authenticates as that user id; null models an anonymous
    // request (→ 401). Users are seeded in the committed public schema, so
    // the real requireAuth resolves them directly — no registry needed.
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

async function postClient(
  baseUrl: string,
  firmName: string,
  teamAssignments?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await req(baseUrl, "POST", "/api/clients", {
    firmName,
    contactName: "Task4171 Contact",
    products: ["gbp"],
    ...(teamAssignments === undefined ? {} : { teamAssignments }),
  });
  if (res.status === 201 && res.body?.id) createdClientIds.push(res.body.id);
  return res;
}

async function seedRowsFor(clientId: string): Promise<Map<string, any>> {
  const r = await db.execute(sql`
    SELECT department_id, primary_user_id, checker_user_id
    FROM sd_client_dept_assignments WHERE client_id = ${clientId}
  `);
  return new Map(((r as any).rows as any[]).map((row) => [row.department_id, row]));
}

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name, last_name)
    VALUES
      (${CREATOR_ID}, 'ceo', 'Creator', ${RUN}),
      (${D_DOER_ID}, 'account_manager', 'Alpha', 'DefaultDoer'),
      (${D_CHK_ID}, 'account_manager', 'Bravo', 'StaleChecker'),
      (${PICK_ID}, 'account_manager', 'Zulu', 'Picked'),
      (${NONMEM_ID}, 'account_manager', 'Nobody', 'Outside')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    INSERT INTO sd_departments
      (id, name, active, sort_order, assignment_scope,
       default_primary_user_id, default_checker_user_id)
    VALUES
      (${DEPT_A}, ${'CS-A ' + RUN}, true, 9101, 'per_client', ${D_DOER_ID}, ${D_CHK_ID}),
      (${DEPT_B}, ${'CS-B ' + RUN}, true, 9102, 'per_client', NULL, NULL),
      (${DEPT_CO}, ${'CS-CO ' + RUN}, true, 9103, 'company', ${D_DOER_ID}, NULL),
      (${DEPT_OFF}, ${'CS-OFF ' + RUN}, false, 9104, 'per_client', ${D_DOER_ID}, NULL)
  `);
  // Membership: D_DOER active in A; D_CHK INACTIVE in A (→ stale default);
  // PICK active in A and B; D_DOER active in CO.
  await db.execute(sql`
    INSERT INTO sd_department_members (id, department_id, user_id, active)
    VALUES
      (${`m-a-doer-${RUN}`}, ${DEPT_A}, ${D_DOER_ID}, true),
      (${`m-a-chk-${RUN}`}, ${DEPT_A}, ${D_CHK_ID}, false),
      (${`m-a-pick-${RUN}`}, ${DEPT_A}, ${PICK_ID}, true),
      (${`m-b-pick-${RUN}`}, ${DEPT_B}, ${PICK_ID}, true),
      (${`m-co-doer-${RUN}`}, ${DEPT_CO}, ${D_DOER_ID}, true)
  `);
}

async function cleanup(): Promise<void> {
  for (const cid of createdClientIds) {
    await db.execute(sql`DELETE FROM sd_client_dept_assignments WHERE client_id = ${cid}`).catch(() => 0);
    await db.execute(sql`DELETE FROM user_activity_logs WHERE metadata->>'clientId' = ${cid}`).catch(() => 0);
    await db.execute(sql`DELETE FROM clients WHERE id = ${cid}`).catch(() => 0);
  }
  await db.execute(sql`DELETE FROM sd_department_members WHERE department_id LIKE ${'dept-4171cs-%-' + RUN}`).catch(() => 0);
  await db.execute(sql`DELETE FROM sd_departments WHERE id LIKE ${'dept-4171cs-%-' + RUN}`).catch(() => 0);
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${'test-4171cs-%-' + RUN}`).catch(() => 0);
}

async function main(): Promise<void> {
  await seed();
  const { server, baseUrl } = await listen(buildApp(CREATOR_ID));
  try {
    // ── (A) client-team-options ──────────────────────────────────────────
    const opts = await req(baseUrl, "GET", "/api/service-desk/client-team-options");
    assert.equal(opts.status, 200, `A: options endpoint must be 200 (got ${opts.status}: ${JSON.stringify(opts.body)})`);
    const optDepts = opts.body.departments as any[];
    const optA = optDepts.find((d) => d.id === DEPT_A);
    const optB = optDepts.find((d) => d.id === DEPT_B);
    assert.ok(optA && optB, "A: both active per_client depts listed");
    assert.ok(!optDepts.some((d) => d.id === DEPT_CO), "A: company dept excluded from the Add Client form");
    assert.ok(!optDepts.some((d) => d.id === DEPT_OFF), "A: inactive dept excluded");
    assert.equal(optA.defaultPrimaryUserId, D_DOER_ID, "A: live default doer pre-selectable");
    assert.equal(
      Object.prototype.hasOwnProperty.call(optA, "defaultCheckerUserId"),
      false,
      "A: Doer-only departments omit the unsupported Checker default slot",
    );
    const aMembers = (opts.body.membersByDept as Record<string, any[]>)[DEPT_A] ?? [];
    assert.deepEqual(
      aMembers.map((m) => m.id),
      [D_DOER_ID, PICK_ID],
      `A: membersByDept lists active members only, name-sorted (got ${JSON.stringify(aMembers)})`,
    );
    assert.equal(aMembers[0].name, "Alpha DefaultDoer", "A: member entries carry display names");
    console.log("  ✓ A: client-team-options — per_client only, stale defaults nulled, sorted {id,name} members");

    // ── (B) POST with no teamAssignments → default seeding ──────────────
    const b = await postClient(baseUrl, `CS-B Firm ${RUN}`);
    assert.equal(b.status, 201, `B: create must be 201 (got ${b.status}: ${JSON.stringify(b.body)})`);
    assert.ok(b.body.teamAssignmentsSeeded >= 2, `B: response reports seeded rows (got ${b.body.teamAssignmentsSeeded})`);
    assert.equal(b.body.teamAssignmentWarning ?? null, null, "B: no seeding warning on the happy path");
    const bRows = await seedRowsFor(b.body.id);
    const bA = bRows.get(DEPT_A);
    assert.ok(bA, "B: DEPT_A row seeded");
    assert.equal(bA.primary_user_id, D_DOER_ID, "B: untouched doer inherits the live default");
    assert.equal(bA.checker_user_id, null, "B: STALE default checker skipped (not fatal, stored null)");
    const bB = bRows.get(DEPT_B);
    assert.ok(bB, "B: defaultless DEPT_B still gets a row (all-null)");
    assert.equal(bB.primary_user_id, null, "B: DEPT_B doer null");
    assert.ok(!bRows.has(DEPT_CO), "B: company dept gets NO per-client row");
    assert.ok(!bRows.has(DEPT_OFF), "B: inactive dept gets NO row");
    console.log("  ✓ B: no-selection create seeds every client-facing dept from live defaults (stale skipped)");

    // ── (C) POST with explicit picks ─────────────────────────────────────
    const c = await postClient(baseUrl, `CS-C Firm ${RUN}`, [
      { departmentId: DEPT_A, primaryUserId: PICK_ID, checkerUserId: null },
      { departmentId: DEPT_B, primaryUserId: PICK_ID },
    ]);
    assert.equal(c.status, 201, `C: create must be 201 (got ${c.status}: ${JSON.stringify(c.body)})`);
    const cRows = await seedRowsFor(c.body.id);
    const cA = cRows.get(DEPT_A);
    assert.equal(cA.primary_user_id, PICK_ID, "C: explicit pick overrides the default");
    assert.equal(cA.checker_user_id, null, "C: explicit null stores null");
    const cB = cRows.get(DEPT_B);
    assert.equal(cB.primary_user_id, PICK_ID, "C: pick on a second dept saved");
    // Rows are ordinary assignments afterwards — visible via the console GET.
    const after = await req(baseUrl, "GET", `/api/service-desk/clients/${c.body.id}/assignments`);
    assert.equal(after.status, 200, "C: assignments GET must be 200 for the creator (ceo)");
    const afterA = (after.body.assignments as any[]).find((a) => a.departmentId === DEPT_A);
    assert.equal(afterA?.primaryUserId, PICK_ID, "C: seeded row readable via the normal assignments API");
    console.log("  ✓ C: explicit picks — override beats default, explicit null respected, rows editable as usual");

    const retiredSupervisor = await postClient(baseUrl, `CS-Supervisor Firm ${RUN}`, [
      { departmentId: DEPT_B, supervisorUserId: PICK_ID },
    ]);
    assert.equal(retiredSupervisor.status, 400, "C: Supervisor seed input is rejected");

    // ── (D) non-member pick → 422, client NOT created ────────────────────
    const dFirm = `CS-D Firm ${RUN}`;
    const d = await postClient(baseUrl, dFirm, [
      { departmentId: DEPT_B, primaryUserId: NONMEM_ID },
    ]);
    assert.equal(d.status, 422, `D: non-member pick must be 422 (got ${d.status}: ${JSON.stringify(d.body)})`);
    assert.ok(
      String(d.body?.error ?? "").includes("not an active member"),
      `D: 422 explains the membership rule (got ${JSON.stringify(d.body)})`,
    );
    const dCheck = await db.execute(sql`SELECT id FROM clients WHERE firm_name = ${dFirm}`);
    assert.equal((dCheck as any).rows.length, 0, "D: client must NOT be created when validation fails");
    console.log("  ✓ D: non-member pick → 422 before the client row exists");

    // ── (E) shape/target validation → 400, client never created ─────────
    const eFirm = `CS-E Firm ${RUN}`;
    const cases: Array<{ label: string; payload: unknown; needle: string }> = [
      { label: "company dept", payload: [{ departmentId: DEPT_CO, primaryUserId: D_DOER_ID }], needle: "company-wide" },
      { label: "unknown dept", payload: [{ departmentId: `nope-${RUN}` }], needle: "Unknown or inactive" },
      { label: "inactive dept", payload: [{ departmentId: DEPT_OFF }], needle: "Unknown or inactive" },
      {
        label: "duplicate dept",
        payload: [{ departmentId: DEPT_B }, { departmentId: DEPT_B }],
        needle: "Duplicate",
      },
      { label: "non-array", payload: "gimme", needle: "must be an array" },
      { label: "missing departmentId", payload: [{ primaryUserId: PICK_ID }], needle: "require a departmentId" },
      { label: "bad role value", payload: [{ departmentId: DEPT_B, checkerUserId: 42 }], needle: "must be a user id or null" },
    ];
    for (const tc of cases) {
      const e = await postClient(baseUrl, eFirm, tc.payload);
      assert.equal(e.status, 400, `E(${tc.label}): must be 400 (got ${e.status}: ${JSON.stringify(e.body)})`);
      assert.ok(
        String(e.body?.error ?? "").includes(tc.needle),
        `E(${tc.label}): error must mention "${tc.needle}" (got ${JSON.stringify(e.body)})`,
      );
    }
    const eCheck = await db.execute(sql`SELECT id FROM clients WHERE firm_name = ${eFirm}`);
    assert.equal((eCheck as any).rows.length, 0, "E: no client row from any rejected payload");
    console.log("  ✓ E: 400 validation — company/unknown/inactive/duplicate/shape, client never created");
  } finally {
    server.close();
    await cleanup();
  }

  await getGlobalDispatcher().close();
  console.log("sd-client-creation-team-seed: all sections passed (Task #4171).");
}

main().then(
  () => process.exit(0),
  (err) => {
    cleanup().finally(() => {
      console.error("sd-client-creation-team-seed: FAILED —", err?.stack ?? err);
      process.exit(1);
    });
  },
);
