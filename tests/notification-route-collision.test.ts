/* test-registration
{
  "name": "Notification route collision (Task #1707)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
// Task #1707 — Notification bell route-collision regression.
//
// The legacy `registerSettingsRoutes()` used to register
// `GET /api/notifications` (returning the legacy `notifications`
// table as a bare array) before `registerUserNotificationRoutes()`
// could register its own `GET /api/notifications` (returning the new
// `user_notifications` rows in `{notifications: [...]}` shape). The
// legacy handler shadowed the new one, so the bell badge (served by
// the unique `/api/notifications/unread-count`) showed "1" while the
// dropdown list ("/api/notifications") returned an empty legacy
// array — hence "You're all caught up" alongside an unread badge.
//
// This test mounts both registrars in the exact order used by
// `server/routes.ts` (settings first, then userNotifications) and
// asserts:
//   1. GET /api/notifications now returns the NEW shape
//      (`{ notifications: [...] }`) and contains a seeded
//      `user_notifications` row for the caller.
//   2. GET /api/notifications/unread-count returns `{ count: 1 }`.
// If anyone re-introduces a collision by registering a non-userNotifications
// handler for `GET /api/notifications` ahead of the userNotifications
// module, assertion (1) fails because the response is a bare array of
// legacy rows instead of the new envelope.
//
// Usage: tsx tests/notification-route-collision.test.ts

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import { users } from "@shared/schema";
import { notifyUser } from "../server/services/notifications/userInbox";
import { registerSettingsRoutes } from "../server/routes/settings";
import { registerUserNotificationRoutes } from "../server/routes/userNotifications";
import {
  isAuthenticated as realIsAuthenticated,
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  const sym = ok ? "✓" : "✗";
  if (ok) {
    passed++;
    console.log(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.error(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  }
}

async function seedUser(suffix: string): Promise<string> {
  const id = `u-${Date.now()}-${Math.floor(Math.random() * 1e6)}-${suffix}`;
  await getDb().insert(users).values({ id, email: `${id}@test.local` });
  // The row is seeded in the uncommitted tx-sandbox transaction, but requireAuth
  // resolves identity via its direct ambient `db` import (public schema) which
  // never sees it. Pre-register the profile so requireAuth admits the user
  // without JIT-provisioning a public row.
  __test_markUserReconciled(id, { id, email: `${id}@test.local` });
  return id;
}

function buildApp(userId: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk per-request test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated. The
    // pre-Clerk passport-shape injection stopped working when auth migrated.
    (req as any).__test_clerkUserId = userId;
    next();
  });
  // Keep the REAL requireAuth in the loop (via the seam above) so req.user is
  // populated the same way production does; requireTeamLead is unused by the
  // routes this suite exercises.
  const isAuthenticated = realIsAuthenticated;
  const requireTeamLead: RequestHandler = (_req, _res, next) => next();
  // MUST match the order in server/routes.ts: settings first, then
  // userNotifications. The fix in Task #1707 renamed the settings
  // routes off `/api/notifications`, so the userNotifications module
  // wins this match. If the order/registration is reverted, this test
  // will fail at the shape assertion below.
  registerSettingsRoutes(app);
  registerUserNotificationRoutes(app, { isAuthenticated, requireTeamLead });
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function getJson(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`);
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function main(): Promise<void> {
  console.log("Task #1707 — notification route collision");

  await runInTxSandbox(async () => {
    const userId = await seedUser("route-collision");
    const created = await notifyUser(userId, {
      category: "system",
      title: "route-collision probe",
      body: "this row must show up via GET /api/notifications",
    });
    assert(created && !created.deduped, "notifyUser must insert a fresh row");

    const app = buildApp(userId);
    const { server, baseUrl } = await listen(app);
    try {
      const list = await getJson(baseUrl, "/api/notifications");
      check("GET /api/notifications responds 200", list.status === 200,
        `got ${list.status}`);
      // The new userNotifications module returns an OBJECT envelope
      // with a `notifications` array. The legacy settings handler
      // returned a bare ARRAY of legacy rows. If we see a bare array,
      // the legacy handler is shadowing the new one (regression).
      check("response is the new shape (object with notifications array), not a bare legacy array",
        !Array.isArray(list.body) && Array.isArray(list.body?.notifications),
        `body keys: ${JSON.stringify(Object.keys(list.body ?? {}))}`);
      const seededId = created!.notification.id;
      const hit = (list.body?.notifications ?? []).some((n: any) => n.id === seededId);
      check("user_notifications row for this user appears in the list",
        hit,
        `seeded id ${seededId}`);

      const count = await getJson(baseUrl, "/api/notifications/unread-count");
      check("GET /api/notifications/unread-count responds 200",
        count.status === 200, `got ${count.status}`);
      // Task #3570 split the unread count into personal/system buckets.
      // The response is now `{ count, personal, system }` where `count`
      // mirrors the personal-only bell badge. The seeded probe uses
      // category "system", so it lands in the SYSTEM bucket: personal=0,
      // system=1, and count (personal-only) = 0.
      check("unread-count exposes the personal/system bucket shape",
        typeof count.body?.count === "number" &&
          typeof count.body?.personal === "number" &&
          typeof count.body?.system === "number",
        `got ${JSON.stringify(count.body)}`);
      check("system-category probe lands in the system bucket (count/personal=0, system=1)",
        count.body?.count === 0 &&
          count.body?.personal === 0 &&
          count.body?.system === 1,
        `got ${JSON.stringify(count.body)}`);

      // Task #1715 — Stage E removed the legacy `/api/legacy-notifications`
      // shim route entirely. With no other handler matching, Express
      // falls through to its default 404. If anyone re-adds the shim,
      // this assertion fails.
      const legacy = await getJson(baseUrl, "/api/legacy-notifications");
      check("GET /api/legacy-notifications no longer resolves (Stage E removed the shim)",
        legacy.status === 404, `got ${legacy.status}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      __test_resetReconciledUsers();
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
