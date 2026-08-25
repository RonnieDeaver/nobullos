/* test-registration
{
  "name": "Request spine: request IDs, access-log elision, error taxonomy, route metrics (Task #3816)",
  "smoke": true,
  "smokeReason": "Guards the app-wide request spine: request-ID propagation into responses/error bodies, access-log elision+sampling rules, the global error middleware's contract-preserving JSON shape (incl. legacy error tokens on migrated routers), and the rolling per-route p50/p95/error aggregator with its flush path. A regression silently blinds production debugging.",
  "tier": "small"
}
test-registration */
/**
 * Task #3816 — app-wide request logging, metrics, and error spine.
 *
 * Hermetic (port-0 express, no DB): boots a mini app wired exactly like
 * server/boot/httpApp.ts + server/index.ts (rid middleware → routes →
 * globalApiErrorHandler) and asserts:
 *
 *  1. Request-ID: generated IDs are 16-hex; a sane inbound X-Request-Id is
 *     honored; hostile/garbage inbound IDs are replaced; every response
 *     carries the header; the ALS context exposes the rid to deep code.
 *  2. Access log: one structured line per API request with rid/route/role;
 *     elided routes sample 1-in-N for successes but ALWAYS log 4xx/5xx and
 *     slow requests; non-API paths never log.
 *  3. Error spine: uncaught route errors → 500 { message: "Internal Server
 *     Error", error, code, requestId }; HttpError surfaces status/code/
 *     details; asyncHandler's legacy token keeps a migrated router's old
 *     `{ error: "<token>" }` 500 contract byte-identical on the error field.
 *  4. Metrics: the aggregator computes windowed p50/p95/max/error counts per
 *     route + the _ALL_ aggregate; old samples fall out of the window;
 *     flushOnce writes one row per active route through the injected leaf
 *     writer and resets interval buckets (no double-count on next flush).
 */
import assert from "node:assert/strict";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import {
  REQUEST_ID_HEADER,
  generateRequestId,
  sanitizeInboundRequestId,
  runWithRequestContext,
  getCurrentRequestId,
} from "../server/observability/requestContext";
import {
  decideAccessLog,
  elisionRuleFor,
  formatAccessLine,
  recordAccess,
  ELIDED_SAMPLE_EVERY_N,
  SLOW_ALWAYS_LOG_MS,
  __testHelpers as accessLogHelpers,
} from "../server/observability/accessLog";
import {
  HttpError,
  asyncHandler,
  codeForStatus,
  globalApiErrorHandler,
} from "../server/observability/httpErrors";
import {
  recordRequestSample,
  getRequestMetricsSummary,
  flushOnce,
  ALL_ROUTES_KEY,
  type RouteStatsWindowRow,
  __testHelpers as metricsHelpers,
} from "../server/services/requestMetrics";

const captured: string[] = [];

function buildSpineApp(): express.Express {
  const app = express();
  app.use(express.json());
  // Mirror of the httpApp.ts spine middleware (rid + header + finish hook +
  // ALS context).
  app.use((req, res, next) => {
    const startedAt = Date.now();
    const rid =
      sanitizeInboundRequestId(req.headers[REQUEST_ID_HEADER.toLowerCase()]) ?? generateRequestId();
    (req as any).requestId = rid;
    res.setHeader(REQUEST_ID_HEADER, rid);
    let recorded = false;
    const record = (aborted: boolean) => {
      if (recorded) return;
      recorded = true;
      recordAccess(req, res, startedAt, aborted);
    };
    res.on("finish", () => record(false));
    res.on("close", () => record(!res.writableFinished));
    runWithRequestContext({ requestId: rid, method: req.method, path: req.path, startedAt }, () =>
      next(),
    );
  });

  app.get("/api/spine/ok", (req, res) => {
    res.json({ ok: true, ridSeenByDeepCode: getCurrentRequestId() });
  });
  app.get(
    "/api/spine/boom",
    asyncHandler(async () => {
      throw new Error("synthetic kaboom with secret internals");
    }),
  );
  app.get(
    "/api/spine/legacy-boom",
    asyncHandler(async () => {
      throw new Error("db exploded");
    }, "list_failed"),
  );
  app.get(
    "/api/spine/http-error",
    asyncHandler(async () => {
      throw new HttpError(422, "bad payload shape", { details: { field: "x" } });
    }),
  );
  // Elided route path (matches the unread-count elision rule exactly).
  app.get("/api/notifications/unread-count", (req, res) => {
    if (req.query.fail === "1") throw new Error("count blew up");
    res.json({ count: 0 });
  });
  app.get("/healthz-not-api", (_req, res) => res.json({ ok: true }));
  app.use(globalApiErrorHandler);
  return app;
}

async function listen(app: express.Express): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function run(): Promise<void> {
  // ── Section 1: pure helpers ────────────────────────────────────────────
  const rid = generateRequestId();
  assert.match(rid, /^[0-9a-f]{16}$/, `generated rid should be 16 hex chars, got ${rid}`);
  assert.equal(sanitizeInboundRequestId("abc-DEF_123.z"), "abc-DEF_123.z");
  assert.equal(sanitizeInboundRequestId("ab"), null, "too-short inbound rid must be rejected");
  assert.equal(sanitizeInboundRequestId("bad rid with spaces"), null);
  assert.equal(sanitizeInboundRequestId("x".repeat(200)), null, "over-long inbound rid rejected");
  assert.equal(sanitizeInboundRequestId('inj"ect\nnewline'), null);
  assert.equal(codeForStatus(404), "not_found");
  assert.equal(codeForStatus(503), "unavailable");
  assert.equal(codeForStatus(418), "bad_request", "unknown 4xx maps to bad_request");
  assert.equal(codeForStatus(599), "internal_error", "unknown 5xx maps to internal_error");

  assert.equal(elisionRuleFor("/api/health/overview"), "health", "health subpaths elide");
  assert.equal(elisionRuleFor("/api/healthz"), null, "prefix match requires a path boundary");
  assert.equal(elisionRuleFor("/api/notifications"), "notifications");
  assert.equal(elisionRuleFor("/api/notifications/123/read"), null, "mutations never elide");
  assert.equal(elisionRuleFor("/api/clients"), null);

  accessLogHelpers.resetSampleCountersForTests();
  let logged = 0;
  for (let i = 0; i < ELIDED_SAMPLE_EVERY_N * 2; i++) {
    if (decideAccessLog({ path: "/api/health/overview", status: 200, durationMs: 5 }).log) logged++;
  }
  assert.equal(logged, 2, `elided route should log exactly 1-in-${ELIDED_SAMPLE_EVERY_N}`);
  assert.equal(
    decideAccessLog({ path: "/api/health/overview", status: 500, durationMs: 5 }).log,
    true,
    "5xx on elided route always logs",
  );
  assert.equal(
    decideAccessLog({ path: "/api/health/overview", status: 200, durationMs: SLOW_ALWAYS_LOG_MS }).log,
    true,
    "slow request on elided route always logs",
  );
  assert.equal(decideAccessLog({ path: "/api/clients", status: 200, durationMs: 3 }).log, true);

  const line = formatAccessLine({
    method: "GET",
    path: "/api/clients/abc",
    status: 200,
    durationMs: 42,
    requestId: "deadbeefdeadbeef",
    route: "/api/clients/:id",
    role: "ceo",
    userId: "u1",
  });
  assert.equal(line, "GET /api/clients/abc 200 in 42ms rid=deadbeefdeadbeef route=GET /api/clients/:id role=ceo uid=u1");

  // ── Section 2: e2e through a port-0 express app ────────────────────────
  metricsHelpers.resetForTests();
  accessLogHelpers.resetSampleCountersForTests();
  accessLogHelpers.setSinkForTests((l) => captured.push(l));
  const errorLogs: string[] = [];
  const origConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    errorLogs.push(args.map((a) => String(a)).join(" "));
  };
  const { server, baseUrl } = await listen(buildSpineApp());
  try {
    // 2a. rid generated + echoed + visible via ALS inside the handler.
    const okRes = await fetch(`${baseUrl}/api/spine/ok`);
    const okRid = okRes.headers.get(REQUEST_ID_HEADER.toLowerCase());
    assert.ok(okRid && /^[0-9a-f]{16}$/.test(okRid), `response must carry generated rid, got ${okRid}`);
    const okBody = await okRes.json();
    assert.equal(okBody.ridSeenByDeepCode, okRid, "ALS context must expose the same rid to deep code");

    // 2b. sane inbound rid honored; hostile one replaced.
    const inbound = await fetch(`${baseUrl}/api/spine/ok`, { headers: { "X-Request-Id": "trace-12345" } });
    assert.equal(inbound.headers.get(REQUEST_ID_HEADER.toLowerCase()), "trace-12345");
    const hostile = await fetch(`${baseUrl}/api/spine/ok`, { headers: { "X-Request-Id": "a b" } });
    const hostileRid = hostile.headers.get(REQUEST_ID_HEADER.toLowerCase());
    assert.ok(hostileRid && /^[0-9a-f]{16}$/.test(hostileRid), "garbage inbound rid must be replaced");

    // 2c. uncaught error → taxonomy 500 body, internals hidden, rid attached.
    const boom = await fetch(`${baseUrl}/api/spine/boom`);
    assert.equal(boom.status, 500);
    const boomBody = await boom.json();
    assert.equal(boomBody.message, "Internal Server Error", "5xx message must stay generic");
    assert.equal(boomBody.code, "internal_error");
    assert.equal(boomBody.requestId, boom.headers.get(REQUEST_ID_HEADER.toLowerCase()));
    assert.ok(!JSON.stringify(boomBody).includes("secret internals"), "5xx body must not leak err.message");
    assert.ok(
      errorLogs.some((l) => l.includes(`rid=${boomBody.requestId}`) && l.includes("[Global Error]")),
      `global handler must log the rid; got: ${errorLogs.slice(-3).join(" | ")}`,
    );

    // 2d. migrated-router legacy token preserved byte-identically.
    const legacy = await fetch(`${baseUrl}/api/spine/legacy-boom`);
    assert.equal(legacy.status, 500);
    const legacyBody = await legacy.json();
    assert.equal(legacyBody.error, "list_failed", "legacy error token contract must be preserved");
    assert.equal(legacyBody.message, "Internal Server Error");

    // 2e. HttpError: status/code/details/message exposed for 4xx.
    const he = await fetch(`${baseUrl}/api/spine/http-error`);
    assert.equal(he.status, 422);
    const heBody = await he.json();
    assert.equal(heBody.code, "unprocessable");
    assert.equal(heBody.message, "bad payload shape");
    assert.deepEqual(heBody.details, { field: "x" });

    // 2f. access lines: ok route logged with rid=/route=/role= fields.
    const okLine = captured.find((l) => l.includes("GET /api/spine/ok 200"));
    assert.ok(okLine, `expected an access line for /api/spine/ok, got: ${captured.join("\n")}`);
    assert.match(okLine!, /rid=[0-9a-f]{16}/);
    assert.match(okLine!, /route=GET \/api\/spine\/ok/);
    assert.match(okLine!, /role=/);
    const boomLine = captured.find((l) => l.includes("GET /api/spine/boom 500"));
    assert.ok(boomLine, "5xx must produce an access line");

    // 2g. elided route: first success logs (sampled), the next 18 do not,
    // but a 500 on the same path always logs.
    const before = captured.length;
    for (let i = 0; i < 5; i++) {
      await fetch(`${baseUrl}/api/notifications/unread-count`);
    }
    const unreadSuccessLines = captured
      .slice(before)
      .filter((l) => l.includes("/api/notifications/unread-count 200"));
    assert.equal(unreadSuccessLines.length, 1, "only the 1-in-N sample of the elided route logs");
    assert.match(unreadSuccessLines[0], /sampled=1\/20/);
    const failRes = await fetch(`${baseUrl}/api/notifications/unread-count?fail=1`);
    assert.equal(failRes.status, 500);
    assert.ok(
      captured.some((l) => l.includes("/api/notifications/unread-count 500")),
      "elided route errors must always log",
    );

    // 2h. non-API paths never log or count.
    await fetch(`${baseUrl}/healthz-not-api`);
    assert.ok(!captured.some((l) => l.includes("healthz-not-api")), "non-API traffic must not log");

    // 2i. every request above landed in the aggregator (per-route + _ALL_).
    const summary = getRequestMetricsSummary({ windowMs: 5 * 60_000 });
    assert.ok(summary.overall && summary.overall.count >= 10, "aggregate _ALL_ entry counts requests");
    const unread = summary.routes.find((r) => r.route.includes("/api/notifications/unread-count"));
    assert.ok(unread, "elided-from-log routes must still be aggregated");
    assert.equal(unread!.count, 6, `5 successes + 1 failure, got ${unread!.count}`);
    assert.equal(unread!.err5xx, 1);
    const nonApi = summary.routes.find((r) => r.route.includes("healthz-not-api"));
    assert.equal(nonApi, undefined, "non-API traffic must not be aggregated");
  } finally {
    console.error = origConsoleError;
    accessLogHelpers.setSinkForTests(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ── Section 3: aggregator math + flush path ───────────────────────────
  metricsHelpers.resetForTests();
  const t0 = Date.now();
  for (let i = 1; i <= 100; i++) {
    recordRequestSample({ method: "GET", route: "/api/fixture/a", status: 200, durationMs: i, now: t0 });
  }
  recordRequestSample({ method: "GET", route: "/api/fixture/a", status: 500, durationMs: 400, now: t0 });
  recordRequestSample({ method: "GET", route: "/api/fixture/a", status: 404, durationMs: 5, now: t0 });
  // Stale sample far outside the window must be excluded from window stats.
  recordRequestSample({ method: "GET", route: "/api/fixture/stale", status: 200, durationMs: 9999, now: t0 - 60 * 60_000 });

  const s = getRequestMetricsSummary({ windowMs: 15 * 60_000, now: t0 + 1 });
  const a = s.routes.find((r) => r.route === "GET /api/fixture/a");
  assert.ok(a, "fixture route present in summary");
  assert.equal(a!.count, 102);
  assert.equal(a!.err5xx, 1);
  assert.equal(a!.err4xx, 1);
  assert.equal(a!.p50Ms, 50, `nearest-rank p50 of 1..100 (+400,+5) is 50, got ${a!.p50Ms}`);
  assert.ok(a!.p95Ms >= 95 && a!.p95Ms <= 100, `p95 should sit in the high-90s, got ${a!.p95Ms}`);
  assert.equal(a!.maxMs, 400);
  assert.equal(a!.err5xxRatePct, Math.round((1 / 102) * 1000) / 10);
  const stale = s.routes.find((r) => r.route === "GET /api/fixture/stale");
  assert.equal(stale, undefined, "samples older than the window are excluded");
  assert.ok(s.overall!.count >= 102, "_ALL_ aggregates the fixture traffic");

  // Flush: injected leaf writer receives per-route rows + _ALL_, buckets reset.
  const flushed: RouteStatsWindowRow[][] = [];
  metricsHelpers.setWriterForTests(async (rows) => {
    flushed.push(rows);
  });
  const flushRes = await flushOnce(t0 + 2);
  assert.equal(flushRes.error, null);
  assert.equal(flushed.length, 1);
  const flushedRows = flushed[0];
  const allRow = flushedRows.find((r) => r.route === ALL_ROUTES_KEY);
  const aRow = flushedRows.find((r) => r.route === "GET /api/fixture/a");
  assert.ok(allRow, "flush includes the _ALL_ aggregate row");
  assert.ok(aRow, "flush includes the per-route row");
  assert.equal(aRow!.count, 102);
  assert.equal(aRow!.err5xx, 1);
  assert.ok(aRow!.p95Ms > 0 && aRow!.p50Ms > 0);
  const flushRes2 = await flushOnce(t0 + 3);
  assert.equal(flushRes2.rows, 0, "buckets must reset after a flush (no double count)");

  // Flush failure: warn-only, never throws, next interval keeps working.
  metricsHelpers.setWriterForTests(async () => {
    throw new Error("synthetic insert failure");
  });
  recordRequestSample({ method: "GET", route: "/api/fixture/a", status: 200, durationMs: 10, now: t0 + 4 });
  const failFlush = await flushOnce(t0 + 5);
  assert.equal(failFlush.rows, 0);
  assert.match(failFlush.error ?? "", /synthetic insert failure/);
  metricsHelpers.setWriterForTests(null);
  metricsHelpers.resetForTests();

  console.log("request-observability: PASSED");
}

run().catch((err) => {
  console.error("request-observability: FAILED", err);
  process.exitCode = 1;
});
