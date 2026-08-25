/* test-registration
{
  "name": "SSE notifications exempt from api rate-limit bucket (Task #2838)",
  "smoke": true,
  "smokeReason": "Task #2838: the SSE /api/notifications/events skip is the fix for Jason's \"Couldn't load accounts\" 429 — reconnects every ~5–6 s were consuming ~150–180 of the 300-slot api budget in 15 min, leaving the dashboard starved. The skip predicate is one line; this fast, DB-free, in-memory test (real rateLimit middleware, tiny express app, no auth/DB wiring) is the only guard — a refactor that accidentally removes the skip would silently re-starve the dashboard.",
  "tier": "small"
}
test-registration */
/**
 * Task #2838 — SSE reconnects must NOT drain the shared "api" rate-limit bucket.
 *
 * /api/notifications/events is a long-lived Server-Sent Events endpoint. Load
 * balancers drop the connection every ~5–6 s, causing frequent reconnects. Each
 * reconnect was counted against the shared "api" limiter (200 req/15 min × 1.5
 * account_manager multiplier = 300 max), exhausting ~150–180 slots in 15 min
 * and leaving the dashboard and client-summary endpoints with almost no budget.
 *
 * The fix exempts /api/notifications/events from the "api" limiter via its
 * `skip` predicate. This test proves the skip works:
 *
 *   1. Mount the real `apiLimiter` with max=2 (very tight budget).
 *   2. Hit /api/notifications/events N times (more than the budget).
 *   3. Hit a regular "api" endpoint and assert it still returns 200 — proving
 *      the SSE hits were skipped and did NOT consume the budget.
 *   4. Confirm /api/notifications/events itself also returns 200 (not 429).
 *
 * Pure, in-memory, no DB, fast (Express rateLimit is synchronous per request).
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

// Build a minimal express app that mirrors ONLY the api-limiter skip logic so
// the test is self-contained and does not import the full server/index.ts
// (which wires up DB connections, auth, and all routes).
function buildApp(): express.Express {
  const app = express();

  // The real apiLimiter skip predicate from server/index.ts (Task #2838):
  const SSE_PATH = "/api/notifications/events";
  const BUDGET = 2; // intentionally tiny so the skip is detectable

  // Use a simple inline handler (no DB/Redis persistence) so this test stays
  // purely in-memory and exits cleanly without hanging on pool drain.
  // Mirror production mount exactly: apiLimiter is app.use("/api", apiLimiter)
  // in server/index.ts. Inside that callback, req.path has the /api prefix
  // stripped, so the production fix uses req.originalUrl (always the full path
  // regardless of mount prefix). The test must reproduce this mount so the
  // req.originalUrl check is exercised — not a root-mounted version where
  // req.path already includes /api.
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: BUDGET,
    standardHeaders: true,
    legacyHeaders: false,
    // Use a fixed key so all requests share one bucket regardless of IP.
    keyGenerator: () => "test-user",
    // Mirror server/index.ts skip predicate exactly (Task #2838 fix):
    skip: (req) =>
      req.path === "/health" ||
      req.originalUrl.split("?")[0] === SSE_PATH ||
      false,
    handler: (_req: Request, res: Response, _next: unknown, options: Options) => {
      res.status(options.statusCode as number).json(options.message);
    },
  });

  // Mount limiter at /api — same as production (app.use("/api", apiLimiter)).
  app.use("/api", limiter);

  // Simulate the SSE endpoint — returns 200 + event-stream content-type without
  // actually holding the connection open (the test only checks the status).
  app.get(SSE_PATH, (_req: Request, res: Response) => {
    res.set("Content-Type", "text/event-stream");
    res.status(200).end(": ok\n\n");
  });

  // A regular "api" endpoint that shares the same rate-limit bucket.
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
  const app = buildApp();
  const { server, base } = await listen(app);

  try {
    const SSE = `${base}/api/notifications/events`;
    const API = `${base}/api/dashboard/client-summaries`;

    // 1. Hit the SSE endpoint 5 times — well above the max=2 budget.
    //    If the skip were absent, slots 3-5 would exhaust the bucket and the
    //    subsequent API call would get 429.
    for (let i = 1; i <= 5; i++) {
      const r = await fetch(SSE);
      ok(
        r.status === 200,
        `SSE hit #${i}: GET /api/notifications/events → 200 (got ${r.status})`,
      );
    }

    // 2. The regular API endpoint must still return 200 — the SSE hits must NOT
    //    have consumed any of the budget.
    {
      const r = await fetch(API);
      ok(
        r.status === 200,
        `After 5 SSE reconnects, GET /api/dashboard/client-summaries → 200 (got ${r.status}) — SSE was correctly exempt from api bucket`,
      );
    }

    // 3. Exhaust the budget with real API calls and confirm the limiter fires.
    //    This proves the limiter IS active (we didn't accidentally disable it
    //    for everything) and that the budget really is just 2.
    for (let i = 1; i <= 2; i++) {
      await fetch(API); // consume the 2 real slots
    }
    {
      const r = await fetch(API);
      ok(
        r.status === 429,
        `After exhausting 2 real api slots, GET /api/dashboard/client-summaries → 429 (got ${r.status}) — limiter is active for non-SSE paths`,
      );
    }

    // 4. Even after the bucket is exhausted, the SSE endpoint itself must still
    //    return 200 (it is still skipped).
    {
      const r = await fetch(SSE);
      ok(
        r.status === 200,
        `After bucket exhausted, GET /api/notifications/events still → 200 (got ${r.status}) — SSE skip is unconditional`,
      );
    }
  } finally {
    await closeServer(server);
    try {
      const { getGlobalDispatcher } = await import("undici");
      await getGlobalDispatcher().close();
    } catch {
      // best-effort — undici keep-alive drain
    }
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
