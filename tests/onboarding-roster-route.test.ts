/* test-registration
{
  "name": "Onboarding roster & default person — add/reactivate, active toggle clears a held default, atomic default swap, auth gating (Task #5295)",
  "regression": true,
  "sweepOnlyReason": "Task #5295 — onboarding roster admin routes: DB-heavy (runInIsolatedSchema: users, onboarding_assignees) + real HTTP server.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small",
  "tierReason": "New suite with no recorded green-baseline duration yet, so the mechanical classifier defaults to 'medium'; measured local runs complete in ~2s (well under the 30s small ceiling) — a lightweight isolated-schema (2-table clone) route suite with no heavy harness, matching the same-shaped sd-department-members-route.test.ts's 'small' tier."
}
test-registration */
/**
 * Task #5295 — Onboarding roster & default person (stage 1 of the New Client
 * Onboarding epic):
 *
 *   GET    /api/admin/onboarding/roster        (any authenticated user)
 *   POST   /api/admin/onboarding/roster        (team-lead: add/reactivate)
 *   PUT    /api/admin/onboarding/roster/:id    (team-lead: active toggle)
 *   DELETE /api/admin/onboarding/roster/:id    (team-lead: remove)
 *   PUT    /api/admin/onboarding/default       (team-lead: atomic default swap)
 *
 * Sections:
 *   (A) GET roster gate: 401 anonymous, 200 for any authenticated role
 *   (B) POST add gates: 401 anon, 403 account_manager, 201 team_lead
 *   (C) Re-adding an existing member reactivates (never duplicates the row)
 *   (D) Setting the default: 404 for a user not on the roster, 409 for an
 *       inactive member, 200 for an active member
 *   (E) Default swap is atomic — changing the default to a different active
 *       member clears the old one in the same call, and the DB partial
 *       unique index never allows two rows with is_default = true
 *   (F) Deactivating the current default clears it (no stale default lingers)
 *   (G) Deleting a member removes the row and reports whether it was default
 *   (H) GET reflects members/defaultUserId consistently throughout
 *
 * Runs with pinGetDbForCrossAsync so Express handlers read the cloned tables.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { getGlobalDispatcher } from "undici";

import { registerOnboardingRosterAdminRoutes } from "../server/routes/onboardingRosterAdmin";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

const RUN = Math.random().toString(36).slice(2, 8);
const LEAD_ID = `test-5295-lead-${RUN}`;
const AM_ID = `test-5295-am-${RUN}`;
const MEMBER_A = `test-5295-member-a-${RUN}`;
const MEMBER_B = `test-5295-member-b-${RUN}`;
const NOT_ON_ROSTER = `test-5295-not-on-roster-${RUN}`;

const TABLES = ["users", "sd_departments", "sd_department_members"] as const;

let activeUserId: string | null = LEAD_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk per-request test seam (server/middlewares/requireAuth.ts): a
    // string authenticates as that user id; null models an anonymous
    // request (→ 401).
    (req as any).__test_clerkUserId = activeUserId;
    next();
  });
  registerOnboardingRosterAdminRoutes(app);
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
    headers: payload !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function getRoster(baseUrl: string): Promise<{ status: number; body: any }> {
  return req(baseUrl, "GET", "/api/admin/onboarding/roster");
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db }) => {
      // ── Seed ───────────────────────────────────────────────────────────
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES
          (${LEAD_ID}, 'team_lead', 'Lead 5295'),
          (${AM_ID}, 'account_manager', 'AM 5295')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);
      await db.execute(sql`
        INSERT INTO sd_departments (id, name, active, assignment_scope, sort_order)
        VALUES (${`test-onboarding-dept-${RUN}`}, 'Onboarding', true, 'company', 1)
      `);
      __test_markUserReconciled(LEAD_ID, { id: LEAD_ID, role: "team_lead", firstName: "Lead 5295" });
      __test_markUserReconciled(AM_ID, { id: AM_ID, role: "account_manager", firstName: "AM 5295" });

      const app = buildApp();
      const { server, baseUrl } = await listen(app);

      try {
        // ── (A) GET roster gate ────────────────────────────────────────
        activeUserId = null;
        const anonGet = await getRoster(baseUrl);
        assert.equal(anonGet.status, 401, `A: unauthenticated GET must be 401 (got ${anonGet.status})`);

        activeUserId = AM_ID;
        const amGet = await getRoster(baseUrl);
        assert.equal(amGet.status, 200, `A: any authenticated role (account_manager) GET must be 200 (got ${amGet.status})`);
        assert.deepEqual(amGet.body?.members, [], "A: roster starts empty");
        assert.equal(amGet.body?.defaultUserId, null, "A: no default yet");
        console.log("  ✓ A: GET roster is gated 401 anon / 200 any authenticated role");

        // ── (B) POST add gates ─────────────────────────────────────────
        activeUserId = null;
        const anonAdd = await req(baseUrl, "POST", "/api/admin/onboarding/roster", { userId: MEMBER_A });
        assert.equal(anonAdd.status, 401, `B: unauthenticated add must be 401 (got ${anonAdd.status})`);

        activeUserId = AM_ID;
        const amAdd = await req(baseUrl, "POST", "/api/admin/onboarding/roster", { userId: MEMBER_A });
        assert.equal(amAdd.status, 403, `B: account_manager add must be 403 (got ${amAdd.status})`);

        activeUserId = LEAD_ID;
        const leadAdd = await req(baseUrl, "POST", "/api/admin/onboarding/roster", { userId: MEMBER_A });
        assert.equal(leadAdd.status, 201, `B: team_lead add must be 201 (got ${leadAdd.status}: ${JSON.stringify(leadAdd.body)})`);
        assert.equal(leadAdd.body?.member?.userId, MEMBER_A, "B: added member carries the requested userId");
        assert.equal(leadAdd.body?.member?.active, true, "B: newly added member is active");
        assert.equal(leadAdd.body?.member?.isDefault, false, "B: newly added member is not the default");
        const memberAId = leadAdd.body.member.id as string;
        console.log("  ✓ B: member add is team-lead-gated (401 anon, 403 AM, 201 team_lead)");

        // ── (C) re-add reactivates instead of duplicating ─────────────
        const secondAdd = await req(baseUrl, "POST", "/api/admin/onboarding/roster", { userId: MEMBER_A });
        assert.equal(secondAdd.status, 201, `C: re-add must still be 201 (got ${secondAdd.status})`);
        assert.equal(secondAdd.body?.member?.id, memberAId, "C: re-adding an existing user must reuse the same row (no duplicate)");
        const afterReadd = await getRoster(baseUrl);
        assert.equal(afterReadd.body?.members?.length, 1, `C: roster must still have exactly 1 row (got ${afterReadd.body?.members?.length})`);
        console.log("  ✓ C: re-adding an existing member reactivates rather than duplicating");

        // Add a second member for the swap/atomicity sections below.
        const addB = await req(baseUrl, "POST", "/api/admin/onboarding/roster", { userId: MEMBER_B });
        assert.equal(addB.status, 201, `setup: add MEMBER_B must be 201 (got ${addB.status})`);
        const memberBId = addB.body.member.id as string;

        // ── (D) setDefault validation ──────────────────────────────────
        const notOnRoster = await req(baseUrl, "PUT", "/api/admin/onboarding/default", { userId: NOT_ON_ROSTER });
        assert.equal(notOnRoster.status, 404, `D: unknown user must be 404 (got ${notOnRoster.status})`);

        const deactivateB = await req(baseUrl, "PUT", `/api/admin/onboarding/roster/${memberBId}`, { active: false });
        assert.equal(deactivateB.status, 200, `D: deactivate MEMBER_B must be 200 (got ${deactivateB.status})`);
        assert.equal(deactivateB.body?.member?.active, false, "D: MEMBER_B is now inactive");
        assert.equal(deactivateB.body?.clearedDefault, false, "D: MEMBER_B was never default, nothing to clear");

        const inactiveDefault = await req(baseUrl, "PUT", "/api/admin/onboarding/default", { userId: MEMBER_B });
        assert.equal(inactiveDefault.status, 409, `D: defaulting to an inactive member must be 409 (got ${inactiveDefault.status})`);

        // Reactivate MEMBER_B for the rest of the test.
        const reactivateB = await req(baseUrl, "PUT", `/api/admin/onboarding/roster/${memberBId}`, { active: true });
        assert.equal(reactivateB.status, 200, `D: reactivate MEMBER_B must be 200 (got ${reactivateB.status})`);

        const setDefaultA = await req(baseUrl, "PUT", "/api/admin/onboarding/default", { userId: MEMBER_A });
        assert.equal(setDefaultA.status, 200, `D: setting an active member default must be 200 (got ${setDefaultA.status})`);
        assert.equal(setDefaultA.body?.defaultUserId, MEMBER_A, "D: response reports the new default");
        console.log("  ✓ D: setDefault rejects unknown (404) and inactive (409) users, accepts active ones (200)");

        // ── (E) atomic swap: never two defaults ───────────────────────
        const setDefaultB = await req(baseUrl, "PUT", "/api/admin/onboarding/default", { userId: MEMBER_B });
        assert.equal(setDefaultB.status, 200, `E: swap to MEMBER_B must be 200 (got ${setDefaultB.status})`);
        const rosterAfterSwap = setDefaultB.body?.roster as any[];
        const defaultRows = rosterAfterSwap.filter((m) => m.isDefault);
        assert.equal(defaultRows.length, 1, `E: exactly one row must be default after the swap (got ${defaultRows.length})`);
        assert.equal(defaultRows[0].userId, MEMBER_B, "E: MEMBER_B must be the sole default after the swap");
        const memberARow = rosterAfterSwap.find((m) => m.userId === MEMBER_A);
        assert.equal(memberARow?.isDefault, false, "E: MEMBER_A must no longer be default after the swap");

        const defaultRow = await db.execute(sql`
          SELECT default_primary_user_id AS "defaultUserId"
          FROM sd_departments
          WHERE lower(trim(name)) = 'onboarding' AND assignment_scope = 'company'
        `);
        assert.equal(defaultRow.rows[0]?.defaultUserId, MEMBER_B, "E: Role Assignments stores the sole default holder");
        console.log("  ✓ E: default swap is atomic and stored on the Role Assignments department");

        // ── (F) deactivating the current default clears it ───────────
        const deactivateDefault = await req(baseUrl, "PUT", `/api/admin/onboarding/roster/${memberBId}`, { active: false });
        assert.equal(deactivateDefault.status, 200, `F: deactivate current default must be 200 (got ${deactivateDefault.status})`);
        assert.equal(deactivateDefault.body?.clearedDefault, true, "F: deactivating the default member must report clearedDefault=true");
        assert.equal(deactivateDefault.body?.member?.isDefault, false, "F: the deactivated row must no longer be default");

        const afterClear = await getRoster(baseUrl);
        assert.equal(afterClear.body?.defaultUserId, null, "F: no stale default must linger after deactivation");
        console.log("  ✓ F: deactivating the current default clears it (no stale default lingers)");

        // ── (G) delete reports whether it was the default ────────────
        const setDefaultAAgain = await req(baseUrl, "PUT", "/api/admin/onboarding/default", { userId: MEMBER_A });
        assert.equal(setDefaultAAgain.status, 200, `setup: re-default MEMBER_A must be 200 (got ${setDefaultAAgain.status})`);

        activeUserId = null;
        const anonDelete = await req(baseUrl, "DELETE", `/api/admin/onboarding/roster/${memberAId}`);
        assert.equal(anonDelete.status, 401, `G: unauthenticated delete must be 401 (got ${anonDelete.status})`);

        activeUserId = LEAD_ID;
        const del = await req(baseUrl, "DELETE", `/api/admin/onboarding/roster/${memberAId}`);
        assert.equal(del.status, 200, `G: team_lead delete must be 200 (got ${del.status})`);
        assert.equal(del.body?.wasDefault, true, "G: delete must report that the removed row was the default");

        const afterDelete = await getRoster(baseUrl);
        assert.equal(afterDelete.body?.defaultUserId, null, "H: default must be gone once its holder is deleted");
        assert.equal(
          afterDelete.body?.members?.some((m: any) => m.id === memberAId),
          false,
          "H: deleted row must not appear in the roster listing",
        );
        assert.ok(
          afterDelete.body?.members?.some((m: any) => m.userId === MEMBER_B),
          "H: remaining member (MEMBER_B) must still be listed",
        );
        console.log("  ✓ G/H: delete removes the row, reports wasDefault, and GET reflects it consistently");
      } finally {
        server.close();
        __test_resetReconciledUsers();
      }
    },
    { tables: [...TABLES], pinGetDbForCrossAsync: true },
  );

  await getGlobalDispatcher().close();

  console.log("onboarding-roster-route: all sections passed (Task #5295).");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("onboarding-roster-route: FAILED —", err?.stack ?? err, err?.cause ?? "");
    process.exit(1);
  },
);
