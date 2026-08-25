/* test-registration
{
  "name": "Client-viewed route bumps (Task #1796)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.9s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1796 — Regression: operator-facing entry points bump
 * `clients.last_viewed_at` so the demand-driven SEMrush gate
 * (Task #1785) treats freshly-engaged accounts as active.
 *
 * Pinned routes:
 *   1. GET /api/clients/:id                            (client dashboard load)
 *   2. GET /api/clients/:clientId/command-panel        (Command Center / CRM)
 *   3. GET /api/reports/:id                            (monthly report render)
 *
 * Plus a negative case: GET /api/share/:token (anonymous public share)
 * must NOT bump `last_viewed_at` — otherwise a single forwarded link
 * would keep a client permanently "active" with no operator engagement.
 *
 * `markClientViewed` is fire-and-forget from the route handler
 * (`void markClientViewed(...)`), so each assertion polls
 * `last_viewed_at` for a short window after the HTTP response.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerClientRoutes } from "../server/routes/clients";
import { registerCommandCenterRoutes } from "../server/routes/commandCenter";
import { registerReportRoutes } from "../server/routes/reports";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

const TAG = `task-1796-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CEO_ID = `${TAG}-ceo`;
const CLIENT_ID = `${TAG}-client`;
const REPORT_ID = `${TAG}-report`;
const SHARE_TOKEN = `${TAG}-share-token`;

// Seed `last_viewed_at` 90 days ago so a successful bump moves it
// well past any plausible test-clock skew.
const STALE_VIEWED_AT = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

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
  await db.execute(sql`DELETE FROM users WHERE id = ${CEO_ID}`).catch(() => 0);
}

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${CEO_ID}, 'ceo', 'Task1796 CEO')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, contact_name, last_viewed_at)
    VALUES (${CLIENT_ID}, ${"Task1796 Firm " + TAG}, 'Task1796', ${STALE_VIEWED_AT})
    ON CONFLICT (id) DO UPDATE SET last_viewed_at = ${STALE_VIEWED_AT}
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

async function getLastViewedAt(): Promise<Date | null> {
  const rows = await db.execute<{ last_viewed_at: Date | null }>(sql`
    SELECT last_viewed_at FROM clients WHERE id = ${CLIENT_ID}
  `);
  const raw = rows.rows[0]?.last_viewed_at;
  return raw ? new Date(raw as any) : null;
}

async function resetLastViewedAt(): Promise<void> {
  await db.execute(sql`
    UPDATE clients SET last_viewed_at = ${STALE_VIEWED_AT} WHERE id = ${CLIENT_ID}
  `);
}

/**
 * Poll `last_viewed_at` until it advances past the stale seed value, or
 * until the budget elapses. The route writes happen via
 * `void markClientViewed(...)` after the HTTP response returns.
 */
async function waitForBump(timeoutMs = 3000): Promise<Date | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await getLastViewedAt();
    if (v && v.getTime() > STALE_VIEWED_AT.getTime() + 60_000) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return getLastViewedAt();
}

function buildApp(opts: { authAs?: string | null } = {}): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null/undefined is anonymous → 401.
    (req as any).__test_clerkUserId = opts.authAs ?? null;
    next();
  });
  registerClientRoutes(app);
  registerCommandCenterRoutes(app);
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

async function run(): Promise<void> {
  await cleanup();
  await seed();

  // Authenticated entry points should bump last_viewed_at.
  const authedApp = buildApp({ authAs: CEO_ID });
  const { server: authedServer, baseUrl: authedBase } = await listen(authedApp);

  try {
    // 1. GET /api/clients/:id — client dashboard load.
    await resetLastViewedAt();
    {
      const r = await fetch(`${authedBase}/api/clients/${CLIENT_ID}`);
      ok(r.status === 200, `GET /api/clients/:id → 200 (got ${r.status})`);
      const bumped = await waitForBump();
      ok(
        bumped !== null && bumped.getTime() > STALE_VIEWED_AT.getTime() + 60_000,
        "client dashboard load bumps last_viewed_at",
      );
    }

    // 2. GET /api/clients/:clientId/command-panel — Command Center / CRM.
    await resetLastViewedAt();
    {
      const r = await fetch(`${authedBase}/api/clients/${CLIENT_ID}/command-panel`);
      ok(r.status === 200, `GET /api/clients/:clientId/command-panel → 200 (got ${r.status})`);
      const bumped = await waitForBump();
      ok(
        bumped !== null && bumped.getTime() > STALE_VIEWED_AT.getTime() + 60_000,
        "Command Center load bumps last_viewed_at",
      );
    }

    // 3. GET /api/reports/:id — monthly report render (authenticated).
    await resetLastViewedAt();
    {
      const r = await fetch(`${authedBase}/api/reports/${REPORT_ID}`);
      ok(r.status === 200, `GET /api/reports/:id → 200 (got ${r.status})`);
      const bumped = await waitForBump();
      ok(
        bumped !== null && bumped.getTime() > STALE_VIEWED_AT.getTime() + 60_000,
        "authenticated report render bumps last_viewed_at",
      );
    }
  } finally {
    await closeServer(authedServer);
  }

  // Negative case — anonymous public share must NOT bump.
  const anonApp = buildApp({ authAs: null });
  const { server: anonServer, baseUrl: anonBase } = await listen(anonApp);

  try {
    await resetLastViewedAt();
    const r = await fetch(`${anonBase}/api/share/${SHARE_TOKEN}`);
    ok(r.status === 200, `GET /api/share/:token → 200 (got ${r.status})`);
    // Give the worker the same wall-clock budget as the positive
    // cases. We expect last_viewed_at to remain at the stale value.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = await getLastViewedAt();
    ok(
      after !== null && Math.abs(after.getTime() - STALE_VIEWED_AT.getTime()) < 60_000,
      "anonymous public-share view does NOT bump last_viewed_at",
    );
  } finally {
    await closeServer(anonServer);
  }

  await cleanup();

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exitCode = 1; return; }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().then(
  () => {},
  async (err) => {
    console.error("Test threw:", err);
    await cleanup().catch(() => 0);
    process.exitCode = 1;
  },
);
