/* test-registration
{
  "name": "Outbound-email routes — Clerk auth guard: team-lead access, CEO access, unauthenticated 401 (Task #4378)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4378: Clerk migration. outboundEmail.ts routes require isAuthenticated before requireTeamLead/requireCeo. Regression would silently block every authenticated operator from the send-log, suppression list, identities, and settings endpoints. Fast mini-app with isolated DB users, no Clerk session needed.",
  "tier": "small"
}
test-registration */
/**
 * Task #4378 — Auth guard regression for outbound-email admin endpoints.
 *
 * Verifies three contracts after the Clerk migration:
 *
 *   (A) Unauthenticated request to any admin endpoint → 401
 *   (B) Authenticated team_lead can reach team-lead-gated endpoints (200)
 *   (C) Authenticated team_lead is denied CEO-only endpoints (403)
 *   (D) Authenticated CEO can reach CEO-only endpoints (200)
 *
 * Uses the Clerk __test_clerkUserId seam + real DB rows for the users,
 * because requireRole (used by requireTeamLead/requireCeo) reads from
 * storage.getUser() on every request.  Rows are deleted in the finally block.
 */

import assert from "node:assert/strict";
import express, { type Request, type Response } from "express";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { isAuthenticated, __test_markUserReconciled, __test_resetReconciledUsers } from "../server/middlewares/requireAuth";
import { requireTeamLead, requireCeo } from "../server/routes/middleware";

// ── Mini app wiring ───────────────────────────────────────────────────────────

let currentUserId: string | null = null;

function makeApp() {
  const app = express();
  app.use(express.json());

  // Clerk test seam — injects the user ID without a real Clerk session.
  app.use((req: any, _res, next) => {
    req.__test_clerkUserId = currentUserId;
    next();
  });

  // Team-lead gated endpoints (mirrors production outboundEmail.ts).
  app.get("/api/outbound-email/log", isAuthenticated, requireTeamLead, (_req: Request, res: Response) => {
    res.json({ reached: true });
  });
  app.get("/api/outbound-email/counters", isAuthenticated, requireTeamLead, (_req: Request, res: Response) => {
    res.json({ reached: true });
  });
  app.get("/api/outbound-email/suppressions", isAuthenticated, requireTeamLead, (_req: Request, res: Response) => {
    res.json({ reached: true });
  });
  app.get("/api/outbound-email/identities", isAuthenticated, requireTeamLead, (_req: Request, res: Response) => {
    res.json({ reached: true });
  });
  app.get("/api/outbound-email/front-channels", isAuthenticated, requireTeamLead, (_req: Request, res: Response) => {
    res.json({ reached: true });
  });
  app.get("/api/outbound-email/settings", isAuthenticated, requireTeamLead, (_req: Request, res: Response) => {
    res.json({ reached: true });
  });

  // CEO-gated endpoints.
  app.put("/api/outbound-email/settings", isAuthenticated, requireCeo, (_req: Request, res: Response) => {
    res.json({ reached: true });
  });
  app.post("/api/outbound-email/verify-domain", isAuthenticated, requireCeo, (_req: Request, res: Response) => {
    res.json({ reached: true });
  });

  return app;
}

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = createServer(makeApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ── DB seed/cleanup ───────────────────────────────────────────────────────────

const RUN = `oeag-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
const TEAM_LEAD_ID = `${RUN}-tl`;
const CEO_ID = `${RUN}-ceo`;

async function seedUsers(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES
      (${TEAM_LEAD_ID}, ${`${TEAM_LEAD_ID}@test.local`}, 'OE', 'TeamLead', 'team_lead', 'core'),
      (${CEO_ID},       ${`${CEO_ID}@test.local`},       'OE', 'CEO',      'ceo',       'core')
    ON CONFLICT (id) DO NOTHING
  `);
  // Pre-register with requireAuth's test registry so the seam populates
  // req.user.claims.sub without a real Clerk session or DB SELECT.
  __test_markUserReconciled(TEAM_LEAD_ID, {
    id: TEAM_LEAD_ID,
    email: `${TEAM_LEAD_ID}@test.local`,
    firstName: "OE",
    lastName: "TeamLead",
    role: "team_lead",
  });
  __test_markUserReconciled(CEO_ID, {
    id: CEO_ID,
    email: `${CEO_ID}@test.local`,
    firstName: "OE",
    lastName: "CEO",
    role: "ceo",
  });
}

async function cleanupUsers(): Promise<void> {
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${RUN + "%"}`).catch(() => {});
  __test_resetReconciledUsers();
}

// ── Test helpers ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

async function get(base: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function put(base: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(base: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── Test matrix ───────────────────────────────────────────────────────────────

const TEAM_LEAD_ENDPOINTS = [
  [get,  "/api/outbound-email/log"],
  [get,  "/api/outbound-email/counters"],
  [get,  "/api/outbound-email/suppressions"],
  [get,  "/api/outbound-email/identities"],
  [get,  "/api/outbound-email/front-channels"],
  [get,  "/api/outbound-email/settings"],
] as const;

const CEO_ENDPOINTS = [
  [put,  "/api/outbound-email/settings"],
  [post, "/api/outbound-email/verify-domain"],
] as const;

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  await seedUsers();
  try {
    await withServer(async (base) => {
      // (A) Unauthenticated → 401 on every admin endpoint
      console.log("(A) unauthenticated → 401");
      currentUserId = null;
      for (const [fn, path] of TEAM_LEAD_ENDPOINTS) {
        const { status } = await fn(base, path);
        ok(status === 401, `unauthed GET ${path} → 401 (got ${status})`);
      }
      for (const [fn, path] of CEO_ENDPOINTS) {
        const { status } = await fn(base, path);
        ok(status === 401, `unauthed ${path} → 401 (got ${status})`);
      }

      // (B) Authenticated team_lead → 200 on team-lead endpoints
      console.log("(B) team_lead → reaches team-lead endpoints (200)");
      currentUserId = TEAM_LEAD_ID;
      for (const [fn, path] of TEAM_LEAD_ENDPOINTS) {
        const { status, body } = await fn(base, path);
        ok(status === 200 && body?.reached === true, `team_lead GET ${path} → 200 (got ${status})`);
      }

      // (C) Authenticated team_lead → 403 on CEO-only endpoints
      console.log("(C) team_lead → 403 on CEO-only endpoints");
      for (const [fn, path] of CEO_ENDPOINTS) {
        const { status } = await fn(base, path);
        ok(status === 403, `team_lead ${path} → 403 (got ${status})`);
      }

      // (D) Authenticated CEO → 200 on CEO endpoints
      console.log("(D) ceo → reaches CEO-only endpoints (200)");
      currentUserId = CEO_ID;
      for (const [fn, path] of CEO_ENDPOINTS) {
        const { status, body } = await fn(base, path);
        ok(status === 200 && body?.reached === true, `CEO ${path} → 200 (got ${status})`);
      }
    });
  } finally {
    await cleanupUsers();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error("outbound-email-auth-guard test crashed:", err);
  process.exitCode = 1;
});
