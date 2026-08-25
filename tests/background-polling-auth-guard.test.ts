/* test-registration
{
  "name": "Background polling endpoints stay auth-guarded in their own bucket (Task #2884)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2884: the #2880 bucket move means the api limiter's skip predicate now silently passes /api/activity, /api/notifications, and /api/notifications/unread-count through to their handlers — so a refactor dropping isAuthenticated from one of these routes would be harder to notice. This test mounts the REAL routers with the REAL isAuthenticated and asserts every path 401s for unauthenticated requests before any handler runs. Fast, in-process, no DB queries (auth short-circuits).",
  "scanPaths": [
    "server/routes.ts",
    "server/routes/activity.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2884 — Background-polling endpoints must still be AUTH-GUARDED after
 * moving to their own rate-limit bucket (Task #2880).
 *
 * /api/activity, /api/notifications, and /api/notifications/unread-count are
 * skipped by the shared "api" limiter's skip predicate and handled by the
 * separate background_polling bucket. That skip means a refactor that
 * accidentally dropped the isAuthenticated middleware from one of these
 * routes would be harder to catch — the request would silently sail through
 * both limiters straight into the handler.
 *
 * This test mounts the REAL route registrations (registerActivityRoutes,
 * registerUserNotificationRoutes) with the REAL isAuthenticated middleware
 * from server/middlewares/requireAuth into a tiny express app, then fires
 * unauthenticated requests and asserts every background-polling path returns
 * 401 BEFORE any handler (and therefore any DB call) runs.
 *
 * No Clerk session is present; requireAuth's try/catch around getAuth()
 * treats the missing session as unauthenticated and 401s before reaching any
 * handler. No DB reads/writes occur — a handler-reached tripwire asserts
 * nothing leaked past the middleware.
 *
 * Also pinned: the injection point in server/routes.ts — the user-
 * notification routes receive isAuthenticated via an options object, so a
 * source-level check asserts the REAL middleware identifier is what gets
 * passed (a refactor swapping in a no-op there would not be caught by
 * mounting the router ourselves).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";

import { registerActivityRoutes } from "../server/routes/activity";
import { registerUserNotificationRoutes } from "../server/routes/userNotifications";
import { isAuthenticated } from "../server/middlewares/requireAuth";
import { requireTeamLead } from "../server/routes/middleware";

let passed = 0;
let failed = 0;

function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL  ${msg}`);
  }
}

// The three paths that moved to the background_polling bucket (Task #2880).
// Keep in sync with BACKGROUND_POLLING_PATHS in server/index.ts.
const BACKGROUND_POLLING_PATHS = [
  "/api/notifications/unread-count",
  "/api/notifications",
  "/api/activity",
] as const;

// Tripwire: flips true if ANY request makes it past isAuthenticated into a
// route handler. With every request unauthenticated, this must stay false.
let handlerReached = false;

function buildAnonApp(): express.Express {
  const app = express();
  app.use(express.json());

  // Clerk-based requireAuth reads req.__test_clerkUserId (null = anonymous)
  // or falls back to getAuth(req). With no Clerk middleware mounted the
  // getAuth() call is caught by requireAuth's try/catch and treated as
  // unauthenticated — so plain unauthenticated requests 401 naturally.
  // No additional anonymous-state shim is needed.

  // Tripwire BEFORE registration would run before the auth middleware, so
  // instead wrap res.json/send detection via a marker middleware appended to
  // each route is intrusive; simplest reliable tripwire: monkey-patch after
  // auth by mounting a final-position middleware is impossible (handlers end
  // the chain). Instead, patch the app's handlers indirectly: the storage
  // calls would throw on a DB-less run anyway — but we never want to rely on
  // that. So wrap registration-time GET/POST to interpose a marker after the
  // middlewares.
  const origGet = app.get.bind(app);
  const origPost = app.post.bind(app);
  (app as any).get = (path: any, ...handlers: any[]) => {
    // Express overloads app.get: with no handlers it's the settings getter
    // (res.json calls app.get('json replacer') internally) — pass through.
    if (handlers.length === 0) return origGet(path);
    const last = handlers.pop();
    return origGet(path, ...handlers, (req: Request, res: Response, next: NextFunction) => {
      handlerReached = true;
      return last(req, res, next);
    });
  };
  (app as any).post = (path: any, ...handlers: any[]) => {
    const last = handlers.pop();
    return origPost(path, ...handlers, (req: Request, res: Response, next: NextFunction) => {
      handlerReached = true;
      return last(req, res, next);
    });
  };

  // REAL route registrations with the REAL middleware.
  registerActivityRoutes(app);
  registerUserNotificationRoutes(app, { isAuthenticated, requireTeamLead });

  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function run(): Promise<void> {
  const app = buildAnonApp();
  const { server, base } = await listen(app);

  try {
    console.log("[1] unauthenticated GETs on background-polling paths → 401");
    for (const p of BACKGROUND_POLLING_PATHS) {
      const r = await fetch(`${base}${p}`);
      const body = await r.json().catch(() => null);
      ok(r.status === 401, `GET ${p} → 401 (got ${r.status})`);
      ok(
        body && typeof body.message === "string" && /unauthorized/i.test(body.message),
        `GET ${p} 401 body carries an Unauthorized message (got ${JSON.stringify(body)})`,
      );
    }

    console.log("[2] unauthenticated POST /api/activity (client event flush) → 401");
    {
      const r = await fetch(`${base}/api/activity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [{ actionType: "page_view" }] }),
      });
      ok(r.status === 401, `POST /api/activity → 401 (got ${r.status})`);
    }

    console.log("[3] no request leaked past isAuthenticated into a handler");
    ok(handlerReached === false, "handler tripwire never fired — auth middleware short-circuited every request");

    console.log("[4] server/routes.ts injects the REAL isAuthenticated into the notification routes");
    {
      const src = readFileSync("server/routes.ts", "utf8");
      const m = src.match(/registerUserNotificationRoutes\s*\(\s*app\s*,\s*\{([^}]*)\}/);
      ok(!!m, "registerUserNotificationRoutes(app, {...}) call found in server/routes.ts");
      if (m) {
        const optsSrc = m[1];
        ok(
          /(^|[\s,{])isAuthenticated\s*([,}]|:\s*isAuthenticated)/.test(optsSrc),
          `injection passes the real isAuthenticated identifier (opts: ${optsSrc.trim()})`,
        );
      }
      // And the activity router imports the real middleware directly.
      const activitySrc = readFileSync("server/routes/activity.ts", "utf8");
      ok(
        /import\s*\{[^}]*\bisAuthenticated\b[^}]*\}\s*from\s*"\.\.\/middlewares\/requireAuth"/.test(activitySrc),
        "server/routes/activity.ts imports isAuthenticated from middlewares/requireAuth",
      );
      ok(
        /app\.get\(\s*"\/api\/activity"\s*,\s*isAuthenticated\s*,/.test(activitySrc),
        'GET "/api/activity" route lists isAuthenticated as its first middleware',
      );
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  try {
    const { getGlobalDispatcher } = await import("undici");
    await getGlobalDispatcher().close();
  } catch {
    // best-effort — undici keep-alive drain
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
  // Route modules transitively import DB-backed singletons; force a clean exit
  // once assertions are done (no writes happened — auth 401'd everything).
  assert.ok(true);
  process.exit(failed > 0 ? 1 : 0);
}

run().then(
  () => {},
  (err) => {
    console.error("Test threw:", err);
    process.exit(1);
  },
);
