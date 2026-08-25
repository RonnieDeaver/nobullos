/* test-registration
{
  "name": "Clerk Restricted sign-up flip — GET /api/admin/clerk/restrictions reflects allowlist=true after the CEO enable action (Task #4632)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4632: the CEO button (Task #4611) is the only in-app control that closes Clerk sign-up. A silent drift in the flip endpoint (wrong PATCH body, wrong field read back, lost error) would leave account creation open to strangers while the admin card claims otherwise. This suite locks the read-after-write contract (allowlist === true after the flip), idempotence, the CEO-only authz gate (401 anon, 403 non-CEO), and 500-on-vendor-error surfacing — all against a stubbed Clerk API host, so it is fast, hermetic, and never egresses.",
  "tier": "small"
}
test-registration */
/**
 * Task #4632 — Restricted sign-up flip smoke coverage.
 *
 * Mounts the REAL registerClerkAdminRoutes on a mini Express app behind the
 * real requireAuth/requireCeo chain (Clerk-era __test_clerkUserId seam +
 * seeded users rows), and stubs global fetch ONLY for https://api.clerk.com
 * with a tiny in-memory Clerk instance (restrictions state honored by
 * GET /instance and PATCH /instance/restrictions). All other hosts (our own
 * 127.0.0.1 mini server) pass through to the real fetch.
 *
 *   1. Authz — anonymous GET → 401; non-CEO GET/POST → 403 (no vendor call).
 *   2. Baseline — CEO GET returns { allowlist: false, blocklist: false }.
 *   3. Flip — POST /enable-restricted-signup → { ok: true, allowlist: true };
 *      the stub received exactly one PATCH with body { allowlist: true }.
 *   4. Read-after-write (the Task #4632 assertion) — GET now returns
 *      allowlist === true.
 *   5. Idempotence — second POST succeeds; GET still allowlist === true.
 *   6. Vendor error — stub answers 500 → our GET surfaces 500 with an error
 *      message (never a fake "open" reading).
 *   7. Egress guard — zero non-stubbed calls reached api.clerk.com.
 *
 * Fixtures are RUN-suffixed users rows removed in finally.
 */

import "./helpers/forceTestEnv";
import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { randomBytes } from "node:crypto";
import { inArray } from "drizzle-orm";

import { db } from "../server/db";
import { users } from "@shared/schema";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { registerClerkAdminRoutes } from "../server/routes/clerkAdmin";

const RUN = `t4632-${randomBytes(4).toString("hex")}`;
const CEO_ID = `${RUN}-ceo`;
const AM_ID = `${RUN}-am`;

// ── Clerk API stub (host-filtered global fetch override) ────────────────────

const CLERK_HOST = "api.clerk.com";
const realFetch = globalThis.fetch;

// In-memory Clerk instance restrictions state.
const clerkState = { allowlist: false, blocklist: false };
let patchBodies: unknown[] = [];
let failNextClerkCall = false;
let unstubbedClerkCalls = 0;

function installClerkStub(): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      /* relative/odd URLs → pass through */
    }
    if (host !== CLERK_HOST) return realFetch(input, init);

    if (failNextClerkCall) {
      failNextClerkCall = false;
      return new Response("simulated Clerk outage", {
        status: 500,
        statusText: "Internal Server Error",
      });
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url).pathname;
    if (method === "GET" && path === "/v1/instance") {
      return Response.json({ restrictions: { ...clerkState } });
    }
    if (method === "PATCH" && path === "/v1/instance/restrictions") {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      patchBodies.push(body);
      if (typeof body.allowlist === "boolean") clerkState.allowlist = body.allowlist;
      if (typeof body.blocklist === "boolean") clerkState.blocklist = body.blocklist;
      return Response.json({ restrictions: { ...clerkState } });
    }
    unstubbedClerkCalls++;
    return new Response("unexpected Clerk call in test", { status: 599 });
  }) as typeof fetch;
}

// ── Harness ─────────────────────────────────────────────────────────────────

let actingUserId: string | null = CEO_ID;
let baseUrl = "";

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).__test_clerkUserId = actingUserId;
    next();
  });
  registerClerkAdminRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve({ server });
    });
  });
}

async function api(
  method: string,
  path: string,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, { method });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  installClerkStub();

  await db.insert(users).values([
    { id: CEO_ID, email: `${RUN}-ceo@example.test`, firstName: "Ceo", role: "ceo" },
    { id: AM_ID, email: `${RUN}-am@example.test`, firstName: "Am", role: "account_manager" },
  ]);
  __test_markUserReconciled(CEO_ID, {
    id: CEO_ID,
    email: `${RUN}-ceo@example.test`,
    role: "ceo",
  });
  __test_markUserReconciled(AM_ID, {
    id: AM_ID,
    email: `${RUN}-am@example.test`,
    role: "account_manager",
  });

  const { server } = await listen(buildApp());
  try {
    // 1. Authz gates.
    actingUserId = null;
    assert.equal((await api("GET", "/api/admin/clerk/restrictions")).status, 401, "anon GET → 401");
    actingUserId = AM_ID;
    assert.equal(
      (await api("GET", "/api/admin/clerk/restrictions")).status,
      403,
      "non-CEO GET → 403",
    );
    assert.equal(
      (await api("POST", "/api/admin/clerk/enable-restricted-signup")).status,
      403,
      "non-CEO POST → 403",
    );
    assert.equal(patchBodies.length, 0, "no vendor PATCH before an authorized flip");

    // 2. Baseline read.
    actingUserId = CEO_ID;
    const before = await api("GET", "/api/admin/clerk/restrictions");
    assert.equal(before.status, 200, "CEO GET → 200");
    assert.deepEqual(
      before.json,
      { allowlist: false, blocklist: false },
      "baseline restrictions read",
    );

    // 3. Flip.
    const flip = await api("POST", "/api/admin/clerk/enable-restricted-signup");
    assert.equal(flip.status, 200, "flip → 200");
    assert.deepEqual(flip.json, { ok: true, allowlist: true }, "flip response shape");
    assert.deepEqual(patchBodies, [{ allowlist: true }], "exactly one PATCH { allowlist: true }");

    // 4. Read-after-write — THE Task #4632 assertion.
    const after = await api("GET", "/api/admin/clerk/restrictions");
    assert.equal(after.status, 200, "post-flip GET → 200");
    assert.equal(after.json.allowlist, true, "allowlist === true after the flip");

    // 5. Idempotence.
    const flip2 = await api("POST", "/api/admin/clerk/enable-restricted-signup");
    assert.equal(flip2.status, 200, "second flip → 200 (idempotent)");
    assert.equal(
      (await api("GET", "/api/admin/clerk/restrictions")).json.allowlist,
      true,
      "still restricted after repeat flip",
    );

    // 6. Vendor error surfaces, never a fake reading.
    failNextClerkCall = true;
    const errRead = await api("GET", "/api/admin/clerk/restrictions");
    assert.equal(errRead.status, 500, "vendor 500 → our 500");
    assert.ok(
      typeof errRead.json?.error === "string" && errRead.json.error.includes("500"),
      "error message surfaced",
    );

    // 7. Egress guard.
    assert.equal(unstubbedClerkCalls, 0, "no unexpected Clerk API paths were hit");

    console.log("clerk-restricted-signup-flip: all assertions passed");
  } finally {
    server.close();
    globalThis.fetch = realFetch;
    __test_resetReconciledUsers();
    await db.delete(users).where(inArray(users.id, [CEO_ID, AM_ID]));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
