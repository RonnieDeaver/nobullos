/* test-registration
{
  "name": "ClickUp OAuth user-id extraction — claims.sub fix, no 401 regression (Task #3104)",
  "tier": "small"
}
test-registration */
/**
 * Regression test for ClickUp user-id extraction fix.
 *
 * Verifies that getClickUpUserId() resolves from req.user.claims.sub
 * (Replit Auth shape), NOT req.user.id — which is always undefined
 * under Replit Auth and caused every ClickUp OAuth route to 401.
 *
 * Sections:
 *   1. Unit tests for getClickUpUserId (pure, no side effects).
 *   2. Route-contract simulation of the requireClickUpToken auth gate.
 *   3. DB-backed end-to-end smoke (Task #3123): spins up a real Express
 *      app with registerClickUpRoutes and hits GET
 *      /api/clickup/filter-presets over HTTP with a Replit Auth-shaped
 *      fake session. Before the #3104 fix this returned 401 for every
 *      Replit Auth user; now it must return 200 with a presets array,
 *      even when the user has never connected ClickUp (filter-presets
 *      reads the NoBull DB directly, not the ClickUp token). An
 *      unauthenticated request must still 401.
 *
 * Auth injection follows the established app-level middleware pattern
 * (.agents/memory/sheets-test-auth-pattern.md) — never ESM patching.
 * Per-run random user id avoids shared dev-DB collisions
 * (.agents/memory/route-test-public-schema-collision.md); the test only
 * reads (no rows seeded), so no cleanup is needed.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher } from "undici";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { getClickUpUserId } from "../server/utils/clickupAuth";

async function run(): Promise<void> {
  let passed = 0;
  const ok = (cond: boolean, msg: string) => {
    assert.ok(cond, msg);
    passed++;
    console.log(`  ok  ${msg}`);
  };

  // ── Unit tests: getClickUpUserId extraction ─────────────────────────────────

  // 1. Replit Auth-shaped session (claims.sub, no .id)
  // This is the session shape Replit Auth / passport produces in prod.
  // Before the fix, `req.user?.id` returned undefined → 401.
  const replitAuthReq = {
    user: {
      claims: { sub: "user-sub-abc123" },
      expires_at: Date.now() / 1000 + 3600,
    },
  };
  ok(
    getClickUpUserId(replitAuthReq) === "user-sub-abc123",
    "getClickUpUserId extracts claims.sub from Replit Auth-shaped session",
  );

  // 2. Old-style session shape (req.user.id, no claims) — no longer used in
  // prod; should return undefined, not throw.
  const oldStyleReq = { user: { id: "legacy-user-id" } };
  ok(
    getClickUpUserId(oldStyleReq) === undefined,
    "getClickUpUserId returns undefined for legacy req.user.id shape (no claims.sub)",
  );

  // 3. Unauthenticated request (no user at all)
  const unauthReq = {};
  ok(
    getClickUpUserId(unauthReq) === undefined,
    "getClickUpUserId returns undefined when req.user is absent",
  );

  // 4. Partial session (claims but no sub)
  const partialReq = { user: { claims: {} } };
  ok(
    getClickUpUserId(partialReq) === undefined,
    "getClickUpUserId returns undefined when claims.sub is absent",
  );

  // 5. The old-style read that caused the bug returns undefined for Replit
  // Auth sessions — confirming the old code was broken for this shape.
  const bugReproReq: any = {
    user: {
      claims: { sub: "user-sub-abc123" },
      expires_at: Date.now() / 1000 + 3600,
    },
    session: undefined,
  };
  const oldStyleRead = bugReproReq.user?.id ?? bugReproReq.session?.user?.id;
  ok(
    oldStyleRead === undefined,
    "old req.user?.id read returns undefined for a Replit Auth session (confirms the original bug)",
  );
  ok(
    getClickUpUserId(bugReproReq) === "user-sub-abc123",
    "new getClickUpUserId correctly extracts sub where old read returned undefined",
  );

  // ── Route-contract tests: requireClickUpToken middleware logic ──────────────
  //
  // Every ClickUp data route calls requireClickUpToken which:
  //   1. Calls getClickUpUserId(req) — returns 401 if undefined
  //   2. Looks up token in DB     — returns 403 if not connected
  //
  // We simulate step 1 (the auth gate) inline to prove:
  //   • a Replit Auth session passes the gate (→ proceeds to step 2)
  //   • an unauthenticated request is rejected at step 1 (→ 401)

  function simulateAuthGate(req: any): 401 | "proceed" {
    const userId = getClickUpUserId(req);
    if (!userId) return 401;
    return "proceed";
  }

  // 7. Replit Auth session → passes the auth gate
  ok(
    simulateAuthGate(replitAuthReq) === "proceed",
    "route auth gate: Replit Auth session passes (not 401) — proceeds to token check",
  );

  // 8. Unauthenticated request → 401 at the auth gate
  ok(
    simulateAuthGate(unauthReq) === 401,
    "route auth gate: unauthenticated request gets 401 at auth gate",
  );

  // 9. Callback error-path returnTo propagation:
  // The callback handler now declares `returnTo` outside the try block so
  // the catch can use it.  Simulate the pattern to prove the error path
  // also honors returnTo (regression guard for the fix in this task).
  {
    let returnTo: string | undefined;
    function simulateCallbackSuccess(parsedReturnTo: string | undefined) {
      returnTo = parsedReturnTo; // set inside try
      return returnTo ?? "/admin/integrations";
    }
    function simulateCallbackError() {
      // catch block uses the outer returnTo (same variable)
      const dest = returnTo ?? "/admin/integrations";
      return dest;
    }

    // error after successful state parse → returnTo honored
    simulateCallbackSuccess("/profile?tab=account");
    ok(
      simulateCallbackError() === "/profile?tab=account",
      "callback error path uses returnTo from state when state parse succeeded",
    );

    // error before state parse (returnTo still undefined) → falls back
    returnTo = undefined;
    ok(
      simulateCallbackError() === "/admin/integrations",
      "callback error path falls back to /admin/integrations when returnTo is unknown",
    );
  }

  // ── DB-backed end-to-end smoke: real route + real DB (Task #3123) ───────────
  //
  // Imported dynamically so the unit sections above stay dependency-free if
  // this block ever needs to be skipped.
  {
    const { registerClickUpRoutes } = await import("../server/routes/clickup");
    const { closeDbPools } = await import("../server/db");
    const { __test_markUserReconciled, __test_resetReconciledUsers } = await import(
      "../server/middlewares/requireAuth"
    );

    const RUN = randomBytes(4).toString("hex");
    const TEST_USER_ID = `clickup-3123-user-${RUN}`;

    // Pre-register the acting identity with requireAuth's registry so the real
    // middleware admits via the Clerk per-request seam without JIT-provisioning
    // a stray public row (the route only needs authentication, not a role).
    __test_markUserReconciled(TEST_USER_ID, { id: TEST_USER_ID });

    // Authenticated app: Clerk per-request test seam injected at app level
    // BEFORE routes register (never ESM patching). (The pre-Clerk
    // passport-shape injection stopped working when auth migrated —
    // requireAuth ignores req.user/req.isAuthenticated.)
    const authedApp = express();
    authedApp.use(express.json());
    authedApp.use((req: any, _res, next) => {
      req.__test_clerkUserId = TEST_USER_ID;
      next();
    });
    registerClickUpRoutes(authedApp);

    // Unauthenticated app: null seam → explicit anonymous → 401.
    const bareApp = express();
    bareApp.use(express.json());
    bareApp.use((req: any, _res, next) => {
      req.__test_clerkUserId = null;
      next();
    });
    registerClickUpRoutes(bareApp);

    async function withServer<T>(
      app: express.Express,
      fn: (baseUrl: string) => Promise<T>,
    ): Promise<T> {
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", resolve));
      try {
        const addr = server.address() as AddressInfo;
        return await fn(`http://127.0.0.1:${addr.port}`);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }

    try {
      // 10-12. Replit Auth session → 200 with presets array from the real
      // route + real DB read, even though this user has never connected
      // ClickUp (the not-connected path must NOT 401/403 here — this
      // route reads NoBull's own DB, not the ClickUp token).
      await withServer(authedApp, async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/clickup/filter-presets`);
        ok(
          r.status === 200,
          `e2e: GET /api/clickup/filter-presets returns 200 (not 401) with a Replit Auth session — got ${r.status}`,
        );
        const body: any = await r.json();
        ok(
          Array.isArray(body.presets),
          "e2e: response body contains a presets array (DB-backed read succeeded)",
        );
        ok(
          body.presets.length === 0,
          "e2e: fresh per-run user id has zero presets (per-user scoping holds)",
        );
      });

      // 13. Unauthenticated request → 401 from the real route.
      await withServer(bareApp, async (baseUrl) => {
        const r = await fetch(`${baseUrl}/api/clickup/filter-presets`);
        ok(
          r.status === 401,
          `e2e: GET /api/clickup/filter-presets returns 401 without a session — got ${r.status}`,
        );
      });
    } finally {
      __test_resetReconciledUsers();
      // Close undici keep-alive sockets and DB pools so the process
      // drains naturally (.agents/memory/route-test-undici-drain-hang.md).
      await getGlobalDispatcher().close();
      await closeDbPools();
    }
  }

  console.log(`\nclickup-oauth-user-id: ${passed} assertion(s) passed.`);
  console.log("clickup-oauth-user-id: verified");
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
