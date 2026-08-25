/* test-registration
{
  "name": "Background polling endpoints must not drain api rate-limit bucket (Task #2880)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2880: background polling endpoints (/api/notifications, /api/notifications/unread-count, /api/activity) are skipped from the shared \"api\" bucket and routed to a separate \"background_polling\" bucket so steady-state bell polling cannot starve interactive dashboard requests. The skip predicate is the single guard between the two buckets; a refactor removing it would silently re-introduce Jason's \"Couldn't load accounts\" 429 pattern. Fast, DB-free, in-memory test (real rateLimit middleware, tiny express app, no auth/DB wiring). Same pattern as #2838's skip guard test.",
  "tier": "small"
}
test-registration */
/**
 * Task #2880 — Background polling endpoints must NOT consume the shared
 * "api" rate-limit bucket.
 *
 * /api/notifications, /api/notifications/unread-count, and /api/activity
 * are hit on a 60 s safety-net interval when SSE is down, and from
 * multiple tabs simultaneously. Moving them to their own `background_polling`
 * limiter prevents steady-state bell polling from starving interactive
 * dashboard requests.
 *
 * This test proves the separation works end-to-end:
 *
 *   1. Mount the apiLimiter skip predicate with max=2 (very tight api budget).
 *   2. Hit each background-polling path N times (more than the api budget).
 *   3. Hit a regular "api" endpoint — it must still return 200, proving the
 *      background hits did NOT consume the api budget.
 *   4. Exhaust the api budget with real api calls and confirm the limiter fires
 *      (the limiter IS active — it is not accidentally disabled for everything).
 *   5. Confirm the background-polling paths still return 200 after the api
 *      bucket is exhausted (they are in an independent bucket).
 *   6. Exhaust the background-polling bucket and confirm IT fires correctly.
 *
 * Pure, in-memory, no DB, fast (Express rateLimit is synchronous per request).
 * Mirrors the pattern established by sse-notifications-rate-limit-skip.test.ts.
 */

import express, { type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import rateLimit, { type Options } from "express-rate-limit";

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

// Mirror the BACKGROUND_POLLING_PATHS constant from server/index.ts (Task #2880).
const BACKGROUND_POLLING_PATHS = [
  "/api/notifications/unread-count",
  "/api/notifications",
  "/api/activity",
] as const;

type BgPath = (typeof BACKGROUND_POLLING_PATHS)[number];

// Build a minimal express app that mirrors ONLY the api-limiter skip logic
// and the background-polling limiter wiring so the test is self-contained.
function buildApp(apiBudget: number, bgBudget: number): express.Express {
  const app = express();

  // api limiter: mirrors server/index.ts skip predicate (Task #2880).
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: apiBudget,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: () => "test-user",
    skip: (req) => {
      if (req.path === "/health") return true;
      const path = req.originalUrl.split("?")[0];
      if (path === "/api/notifications/events") return true;
      if (BACKGROUND_POLLING_PATHS.some((p) => path === p || path.startsWith(p + "?"))) return true;
      return false;
    },
    handler: (_req: Request, res: Response, _next: unknown, options: Options) => {
      res.status(options.statusCode as number).json(options.message);
    },
  });

  // background_polling limiter: separate budget from the api bucket.
  // The SSE endpoint (/api/notifications/events) must be skipped here too:
  // Express prefix-matching means app.use("/api/notifications", bgLimiter)
  // also matches the SSE path. The skip mirrors the production fix (Task #2838).
  const bgLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: bgBudget,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: () => "test-user",
    skip: (req) => {
      const path = req.originalUrl.split("?")[0];
      return path === "/api/notifications/events";
    },
    handler: (_req: Request, res: Response, _next: unknown, options: Options) => {
      res.status(options.statusCode as number).json(options.message);
    },
  });

  // Mount api limiter at /api (same as production).
  app.use("/api", apiLimiter);

  // Mount bg limiter for background polling paths (same as production).
  for (const p of BACKGROUND_POLLING_PATHS) {
    app.use(p, bgLimiter);
  }

  // Background polling endpoints.
  for (const p of BACKGROUND_POLLING_PATHS) {
    app.get(p, (_req: Request, res: Response) => {
      res.json({ ok: true, path: p });
    });
  }

  // A regular interactive api endpoint (shares the api bucket).
  app.get("/api/dashboard/client-summaries", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function run(): Promise<void> {
  // Part 1–5: api=2 budget, bg=50 budget (large enough that 9 bg hits never exhaust it)
  {
    const app = buildApp(/* apiBudget */ 2, /* bgBudget */ 50);
    const { server, base } = await listen(app);

    try {
      const DASHBOARD = `${base}/api/dashboard/client-summaries`;
      const bgPaths: BgPath[] = [...BACKGROUND_POLLING_PATHS];

      // 1. Hit each background endpoint several times — more than the api budget.
      //    If the skip were absent, these would immediately exhaust the api bucket.
      console.log("[1] background endpoints — multiple hits each, api budget=2");
      for (const bgPath of bgPaths) {
        for (let i = 1; i <= 3; i++) {
          const r = await fetch(`${base}${bgPath}`);
          ok(
            r.status === 200,
            `bg hit #${i}: GET ${bgPath} → 200 (got ${r.status}) — not api-limited`,
          );
        }
      }

      // 2. The interactive api endpoint must still return 200 after all those
      //    background hits — the api budget was NOT consumed.
      console.log("[2] interactive api endpoint must not be starved");
      {
        const r = await fetch(DASHBOARD);
        ok(
          r.status === 200,
          `After ${bgPaths.length * 3} bg hits, GET /api/dashboard/client-summaries → 200 (got ${r.status}) — bg hits correctly exempt from api bucket`,
        );
      }

      // 3. Exhaust the api budget with real interactive calls, confirm it fires.
      //    Proves the api limiter IS active (not accidentally disabled entirely).
      console.log("[3] api limiter IS active — exhausting budget then confirming 429");
      for (let i = 1; i <= 2; i++) {
        await fetch(DASHBOARD); // consume the 2 real api slots
      }
      {
        const r = await fetch(DASHBOARD);
        ok(
          r.status === 429,
          `After exhausting 2 api slots, GET /api/dashboard/client-summaries → 429 (got ${r.status}) — api limiter is active`,
        );
      }

      // 4. Background endpoints must still be reachable after the api bucket is
      //    exhausted. They live in their own budget and are not affected.
      console.log("[4] background endpoints survive api bucket exhaustion");
      for (const bgPath of bgPaths) {
        const r = await fetch(`${base}${bgPath}`);
        ok(
          r.status === 200,
          `After api bucket exhausted, GET ${bgPath} → 200 (got ${r.status}) — bg bucket is independent`,
        );
      }

    } finally {
      await closeServer(server);
    }
  }

  // Part 5: SSE endpoint /api/notifications/events must be exempt from the bg
  // limiter even though backgroundPollingLimiter is mounted at the
  // "/api/notifications" prefix. Express prefix-matching would otherwise catch
  // the SSE path and apply the bg budget to it, breaking Task #2838.
  {
    const BG_BUDGET = 1; // exhaust in a single request
    const app2 = buildApp(/* apiBudget */ 100, /* bgBudget */ BG_BUDGET);
    // Mount a fake SSE route so the request reaches a handler.
    app2.get("/api/notifications/events", (_req: Request, res: Response) => {
      res.json({ ok: true, sse: true });
    });
    const { server: server2, base: base2 } = await listen(app2);
    try {
      // Exhaust the bg budget.
      await fetch(`${base2}/api/notifications/unread-count`); // consume slot 1
      // SSE endpoint must still return 200 — not 429 — even with bg budget exhausted.
      const r = await fetch(`${base2}/api/notifications/events`);
      ok(
        r.status === 200,
        `After bg budget exhausted, GET /api/notifications/events → 200 (got ${r.status}) — SSE endpoint is exempt from bg limiter (Task #2838 preserved)`,
      );
    } finally {
      await closeServer(server2);
    }
  }

  // Part 6: bg bucket itself limits correctly (separate app with tight bg budget).
  {
    const BG_BUDGET = 2;
    const app = buildApp(/* apiBudget */ 100, /* bgBudget */ BG_BUDGET);
    const { server, base } = await listen(app);

    try {
      console.log("[5] background_polling bucket limits its own endpoints when exhausted");
      // The bg limiter is shared across all 3 bg paths (same instance, same key).
      // Exhaust the budget across paths.
      await fetch(`${base}/api/notifications/unread-count`); // slot 1
      await fetch(`${base}/api/notifications`);               // slot 2
      // Next bg request must 429.
      const r = await fetch(`${base}/api/activity`);
      ok(
        r.status === 429,
        `After exhausting bg budget=${BG_BUDGET} across paths, GET /api/activity → 429 (got ${r.status}) — bg limiter is active`,
      );
      // But the api endpoint is unaffected.
      const r2 = await fetch(`${base}/api/dashboard/client-summaries`);
      ok(
        r2.status === 200,
        `After bg bucket exhausted, GET /api/dashboard/client-summaries → 200 (got ${r2.status}) — api bucket independent from bg`,
      );
    } finally {
      await closeServer(server);
    }
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
}

run().then(
  () => {},
  (err) => {
    console.error("Test threw:", err);
    process.exitCode = 1;
  },
);
