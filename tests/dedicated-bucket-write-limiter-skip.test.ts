/* test-registration
{
  "name": "Dedicated-bucket writes exempt from shared write limiter (Task #4788)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4788: comms auto-fire writes (typing every ~2 s while composing, presence heartbeat every 25 s per open tab) and sheets/docs autosave (~30 s) double-counted into the shared 60/15min writeLimiter bucket and 429d unrelated saves — users could not save Weekly Availability on /profile (prod: 215 of 351 write-category blocks were the heartbeat alone). The isDedicatedBucketWriteRoute skip predicate in server/routes/limiterMounts.ts is the single guard; this fast, DB-free, in-memory test wires the REAL imported matcher and WEBHOOK_PATHS into a real express-rate-limit stack and proves exempt paths never drain the write bucket, interactive writes still do, the sheets DELETE sibling stays limited, dedicated buckets still fire when exhausted, and the Task #944B webhook skip survives. Same pattern as the #2838/#2880 skip-guard suites.",
  "tier": "small"
}
test-registration */
/**
 * Task #4788 — Mutations governed by a DEDICATED rate-limit bucket must NOT
 * consume the shared writeLimiter budget.
 *
 * Production wiring being modeled (all predicates imported REAL, not mirrored):
 *   - writeLimiter is mounted app.use("/api", ...) with skip =
 *     read-only methods || WEBHOOK_PATHS startsWith || isDedicatedBucketWriteRoute.
 *   - Typing + presence heartbeat carry commsWriteLimiter inline (60/min).
 *   - Sheets/docs autosave PATCH carries sheetsAutosaveLimiter inline (200/15min).
 *   - POST /api/activity rides the method-blind background_polling mount.
 *
 * The bug: before the skip, a few minutes of chatting (typing ~2 s cadence)
 * or an idle second tab (heartbeat every 25 s = 36/15min) exhausted the
 * 60/15min shared bucket, and every later save anywhere in the app 429d
 * ("Too many write requests") — e.g. PUT /api/booking/me/availability/rules.
 *
 * Pure, in-memory, no DB. Mirrors the pattern of
 * background-polling-rate-limit-bucket.test.ts (#2880) and
 * sse-notifications-rate-limit-skip.test.ts (#2838).
 */

import express, { type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import rateLimit, { type Options } from "express-rate-limit";
import {
  isDedicatedBucketWriteRoute,
  DEDICATED_BUCKET_WRITE_ROUTES,
  COMMS_WRITE_BUCKET_ROUTES,
  SHEETS_AUTOSAVE_BUCKET_ROUTES,
  BACKGROUND_POLLING_BUCKET_WRITE_ROUTES,
  WEBHOOK_PATHS,
} from "../server/routes/limiterMounts";

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

// ── Part 0: matcher unit behavior (pure, no server) ─────────────────────────
function matcherUnitChecks(): void {
  console.log("[0] isDedicatedBucketWriteRoute matcher semantics");

  ok(
    isDedicatedBucketWriteRoute("POST", "/api/comms/channels/abc123/typing"),
    "typing POST with concrete channel id matches the :id entry",
  );
  ok(
    isDedicatedBucketWriteRoute("POST", "/api/comms/presence/heartbeat?tab=2"),
    "query string is stripped before matching (heartbeat with ?tab=2)",
  );
  ok(
    isDedicatedBucketWriteRoute("post", "/api/comms/presence/heartbeat"),
    "method comparison is case-insensitive (lowercase post)",
  );
  ok(
    !isDedicatedBucketWriteRoute("GET", "/api/comms/channels/abc123/typing"),
    "GET on an exempt path does NOT match — entries are method-aware",
  );
  ok(
    isDedicatedBucketWriteRoute("PATCH", "/api/sheets/workbooks/wb-1"),
    "sheets autosave PATCH matches",
  );
  ok(
    !isDedicatedBucketWriteRoute("DELETE", "/api/sheets/workbooks/wb-1"),
    "sheets DELETE sibling does NOT match — it stays under writeLimiter",
  );
  ok(
    isDedicatedBucketWriteRoute("PATCH", "/api/docs/documents/doc-1"),
    "docs autosave PATCH matches (shares sheetsAutosaveLimiter)",
  );
  ok(
    isDedicatedBucketWriteRoute("POST", "/api/activity"),
    "activity telemetry POST matches (background_polling bucket)",
  );
  ok(
    !isDedicatedBucketWriteRoute("POST", "/api/activity/extra"),
    "segment-count is exact — a longer path does not prefix-match",
  );
  ok(
    !isDedicatedBucketWriteRoute("POST", "/api/comms/channels/typing"),
    "segment-count is exact — a shorter path does not match the :id entry",
  );
  ok(
    !isDedicatedBucketWriteRoute("PUT", "/api/booking/me/availability/rules"),
    "the availability save (the reported victim) is NOT exempt — interactive writes stay limited",
  );
  ok(
    !isDedicatedBucketWriteRoute("POST", "/api/feedback"),
    "other interactive writes (POST /api/feedback) are NOT exempt",
  );

  // Pattern-vs-pattern: computeLimitersForRoute passes :param route patterns.
  let selfMatch = true;
  for (const entry of DEDICATED_BUCKET_WRITE_ROUTES) {
    const idx = entry.indexOf(" ");
    const method = entry.slice(0, idx);
    const p = entry.slice(idx + 1);
    if (!isDedicatedBucketWriteRoute(method, p)) selfMatch = false;
  }
  ok(selfMatch, "every list entry self-matches when given its own :param pattern (computeLimitersForRoute path)");

  ok(
    DEDICATED_BUCKET_WRITE_ROUTES.length ===
      COMMS_WRITE_BUCKET_ROUTES.length +
        SHEETS_AUTOSAVE_BUCKET_ROUTES.length +
        BACKGROUND_POLLING_BUCKET_WRITE_ROUTES.length,
    "combined list is exactly the union of the three per-bucket lists",
  );
}

// ── In-memory app mirroring the production writeLimiter wiring ──────────────
const WRITE_MSG = { bucket: "write", message: "Too many write requests, please try again later." };
const COMMS_MSG = { bucket: "commsWrite", message: "Too many comms requests, please slow down." };
const SHEETS_MSG = { bucket: "sheetsAutosave", message: "Too many autosave requests, please wait a moment." };
const BG_MSG = { bucket: "background_polling", message: "Too many background requests." };

function jsonHandler(body: Record<string, unknown>) {
  return (_req: Request, res: Response, _next: unknown, options: Options) => {
    res.status(options.statusCode as number).json(body);
  };
}

interface Budgets {
  write: number;
  comms: number;
  sheets: number;
  bg: number;
}

function buildApp(budgets: Budgets): express.Express {
  const app = express();

  // Mirrors writeLimiter in server/routes/middleware.ts — the skip predicate
  // and webhook list are the REAL imports, so a regression in either the
  // matcher or the list wiring fails here.
  const writeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: budgets.write,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: () => "test-user",
    skip: (req) =>
      req.method === "GET" ||
      req.method === "HEAD" ||
      req.method === "OPTIONS" ||
      WEBHOOK_PATHS.some((p) => req.originalUrl.startsWith(p)) ||
      isDedicatedBucketWriteRoute(req.method, req.originalUrl),
    handler: jsonHandler(WRITE_MSG),
  });

  const commsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: budgets.comms,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: () => "test-user",
    handler: jsonHandler(COMMS_MSG),
  });

  const sheetsLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: budgets.sheets,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: () => "test-user",
    handler: jsonHandler(SHEETS_MSG),
  });

  const bgLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: budgets.bg,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: () => "test-user",
    handler: jsonHandler(BG_MSG),
  });

  // Same mount shape as production: writeLimiter at the /api prefix
  // (req.originalUrl carries the full path), bg limiter method-blind at the
  // activity path (server/boot/httpApp.ts pattern).
  app.use("/api", writeLimiter);
  app.use("/api/activity", bgLimiter);

  const okJson = (_req: Request, res: Response) => {
    res.json({ ok: true });
  };

  // Exempt routes carrying their dedicated limiter inline (as in production).
  app.post("/api/comms/channels/:id/typing", commsLimiter, okJson);
  app.post("/api/comms/presence/heartbeat", commsLimiter, okJson);
  app.patch("/api/sheets/workbooks/:id", sheetsLimiter, okJson);
  app.post("/api/activity", okJson);

  // Non-exempt neighbors that must stay under the shared write bucket.
  app.put("/api/booking/me/availability/rules", okJson);
  app.delete("/api/sheets/workbooks/:id", okJson);

  // Read under the same prefix (write limiter skips read-only methods).
  app.get("/api/comms/channels/:id/messages", okJson);

  // Webhook route on a REAL WEBHOOK_PATHS prefix (Task #944B skip).
  app.post(`${WEBHOOK_PATHS[0]}/test-event`, okJson);

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

async function hit(base: string, method: string, path: string): Promise<globalThis.Response> {
  return fetch(`${base}${path}`, { method });
}

async function run(): Promise<void> {
  matcherUnitChecks();

  // ── Part 1: auto-fire writes never drain the write bucket; interactive
  // writes still do; exempt paths survive bucket exhaustion. ────────────────
  {
    const app = buildApp({ write: 2, comms: 100, sheets: 100, bg: 100 });
    const { server, base } = await listen(app);
    try {
      console.log("[1] auto-fire volume with write budget=2 — none of it consumes the bucket");
      for (let i = 1; i <= 5; i++) {
        const r = await hit(base, "POST", `/api/comms/channels/chan-${i}/typing`);
        ok(r.status === 200, `typing POST #${i} → 200 (got ${r.status})`);
      }
      for (let i = 1; i <= 4; i++) {
        const r = await hit(base, "POST", "/api/comms/presence/heartbeat");
        ok(r.status === 200, `heartbeat POST #${i} → 200 (got ${r.status})`);
      }
      for (let i = 1; i <= 3; i++) {
        const r = await hit(base, "PATCH", "/api/sheets/workbooks/wb-1");
        ok(r.status === 200, `sheets autosave PATCH #${i} → 200 (got ${r.status})`);
      }
      for (let i = 1; i <= 3; i++) {
        const r = await hit(base, "POST", "/api/activity");
        ok(r.status === 200, `activity POST #${i} → 200 (got ${r.status})`);
      }

      console.log("[2] the reported victim save works after 15 auto-fire writes");
      {
        const r = await hit(base, "PUT", "/api/booking/me/availability/rules");
        ok(
          r.status === 200,
          `PUT /api/booking/me/availability/rules → 200 (got ${r.status}) — write bucket untouched by auto-fire traffic`,
        );
      }

      console.log("[3] write limiter IS active for interactive writes");
      {
        await hit(base, "PUT", "/api/booking/me/availability/rules"); // slot 2
        const r = await hit(base, "PUT", "/api/booking/me/availability/rules");
        const body = (await r.json()) as { bucket?: string };
        ok(
          r.status === 429 && body.bucket === "write",
          `3rd availability PUT → 429 from the write bucket (got ${r.status}/${body.bucket ?? "?"})`,
        );
      }

      console.log("[4] exempt + webhook + read paths survive write-bucket exhaustion");
      {
        const checks: Array<[string, string]> = [
          ["POST", "/api/comms/channels/chan-x/typing"],
          ["POST", "/api/comms/presence/heartbeat"],
          ["PATCH", "/api/sheets/workbooks/wb-1"],
          ["POST", "/api/activity"],
          ["POST", `${WEBHOOK_PATHS[0]}/test-event`],
          ["GET", "/api/comms/channels/chan-x/messages"],
        ];
        for (const [method, p] of checks) {
          const r = await hit(base, method, p);
          ok(
            r.status === 200,
            `${method} ${p} → 200 after write bucket exhausted (got ${r.status})`,
          );
        }
      }

      console.log("[5] non-exempt sibling methods stay under the write bucket");
      {
        const r = await hit(base, "DELETE", "/api/sheets/workbooks/wb-1");
        const body = (await r.json()) as { bucket?: string };
        ok(
          r.status === 429 && body.bucket === "write",
          `DELETE /api/sheets/workbooks/:id → 429 from write bucket (got ${r.status}/${body.bucket ?? "?"}) — only the PATCH autosave is exempt`,
        );
      }
    } finally {
      await closeServer(server);
    }
  }

  // ── Part 2: dedicated buckets still enforce their own budgets. ────────────
  {
    const app = buildApp({ write: 100, comms: 2, sheets: 1, bg: 100 });
    const { server, base } = await listen(app);
    try {
      console.log("[6] dedicated comms bucket fires when exhausted (exemption is not a free pass)");
      await hit(base, "POST", "/api/comms/channels/chan-1/typing"); // comms slot 1
      await hit(base, "POST", "/api/comms/presence/heartbeat"); // comms slot 2
      {
        const r = await hit(base, "POST", "/api/comms/channels/chan-1/typing");
        const body = (await r.json()) as { bucket?: string };
        ok(
          r.status === 429 && body.bucket === "commsWrite",
          `3rd comms write → 429 from the commsWrite bucket (got ${r.status}/${body.bucket ?? "?"})`,
        );
      }
      console.log("[7] dedicated sheets bucket fires when exhausted");
      await hit(base, "PATCH", "/api/sheets/workbooks/wb-1"); // sheets slot 1
      {
        const r = await hit(base, "PATCH", "/api/sheets/workbooks/wb-1");
        const body = (await r.json()) as { bucket?: string };
        ok(
          r.status === 429 && body.bucket === "sheetsAutosave",
          `2nd autosave PATCH → 429 from the sheetsAutosave bucket (got ${r.status}/${body.bucket ?? "?"})`,
        );
      }
      console.log("[8] comms/sheets 429s never touched the write bucket");
      {
        const r = await hit(base, "PUT", "/api/booking/me/availability/rules");
        ok(
          r.status === 200,
          `availability PUT → 200 while dedicated buckets are exhausted (got ${r.status}) — buckets are independent`,
        );
      }
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
