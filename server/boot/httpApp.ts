/**
 * Boot — HTTP app assembly.
 * Extracted verbatim from server/index.ts (Task #3787 split); invoked from
 * the index.ts bootstrap in the exact original sequence.
 * express app, httpServer, middleware, CSP, limiters, log(), api labels, boot gate, listen.
 */

import express, { type Request, Response, NextFunction } from "express";
import compression from "compression";
import { CLERK_PROXY_PATH, clerkProxyMiddleware } from "../middlewares/clerkProxyMiddleware";
import { registerEarlyProdStaticHandlers } from "../static";
import { createBootGate } from "../bootGate";
import { registerMarketingSite } from "../website/marketingSite";
import { createServer } from "http";
import path from "path";
import helmet from "helmet";
import { buildCspDirectives, isFrameRelaxedPath, STRICT_FRAME_ANCESTORS, EMBED_FRAME_ANCESTORS } from "../embedCsp";
import rateLimit from "express-rate-limit";
import {
  webhookLimiter,
  shareFileLimiter,
  userKeyGenerator,
  roleAwareMax,
  createRequestTracker,
  ipBlockMiddleware,
} from "../routes/middleware";
import { createRateLimitHandler, registerLimiterConfig, getDynamicMax } from "../services/rateLimitMonitor";
import {
  withDbHoldLabel as _withDbHoldLabel,
  setCurrentDbHoldLabel as _setCurrentDbHoldLabel,
  recordApiFallbackLabelHit as _recordApiFallbackLabelHit,
} from "../db";
import { WEBHOOK_PATHS, AUTH_LIMITER_PATHS, SHARE_FILE_PATHS } from "../routes/limiterMounts";
import {
  REQUEST_ID_HEADER,
  generateRequestId,
  sanitizeInboundRequestId,
  runWithRequestContext,
} from "../observability/requestContext";
import { recordAccess } from "../observability/accessLog";

export const app = express();
export const httpServer = createServer(app);

app.use(compression());

// Mount Clerk FAPI proxy BEFORE body parsers — the proxy streams raw bytes
// and express.json() would consume the body before it could be forwarded.
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    limit: '15mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: '15mb' }));

// Task #3740 — marketing website (nobullmarketing.com apex+www) + /website-preview.
// Must run before ipBlock/helmet/SPA layers so marketing hosts get the static
// bundle (with its own CSP) and never the OS shell.
registerMarketingSite(app);

// Task #3816 — request spine: request ID + structured access log + rolling
// per-route metrics. Mounted before ipBlock/helmet/limiters so EVERY /api
// response — including ipBlock 403s, limiter 429s, and boot-gate 503s — is
// logged with a request ID and counted in the per-route aggregator. The
// response carries `X-Request-Id`, so a user screenshot of any error can be
// traced to the exact server activity. Non-/api traffic gets the header +
// context but is never logged/aggregated (see accessLog.ts).
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
  // Client disconnected before the response completed (aborted upload,
  // closed SSE stream) — still log/count it, flagged.
  res.on("close", () => record(!res.writableFinished));
  runWithRequestContext(
    { requestId: rid, method: req.method, path: req.path, startedAt },
    () => next(),
  );
});

app.use("/api", ipBlockMiddleware);

// Task #3728 — two CSP policies sharing one directive set (server/embedCsp.ts):
// strict frame-ancestors everywhere, except the public roadmap embed surface
// (the /roadmap/embed HTML document + its /api/public/roadmap JSON), which
// third-party sites must be able to iframe. Helmet mounts before vite/static,
// so the SPA HTML for the embed path gets the relaxed header too.
const strictHelmet = helmet({
  contentSecurityPolicy: {
    directives: buildCspDirectives(STRICT_FRAME_ANCESTORS),
  },
  frameguard: false,
  crossOriginEmbedderPolicy: false,
});
const embedHelmet = helmet({
  contentSecurityPolicy: {
    directives: buildCspDirectives(EMBED_FRAME_ANCESTORS),
  },
  frameguard: false,
  crossOriginEmbedderPolicy: false,
});
app.use((req: Request, res: Response, next: NextFunction) => {
  (isFrameRelaxedPath(req.path) ? embedHelmet : strictHelmet)(req, res, next);
});

// Task #2880: raised from 200 to 400 so a heavy account_manager session
// (300→600 req/15min effective) can open multiple client panels + reports
// without exhausting the interactive budget. Background polling endpoints
// (/api/notifications, /api/notifications/unread-count, /api/activity GET)
// are moved to their own `background_polling` bucket below so they can't
// starve interactive dashboard requests.
registerLimiterConfig("api", 15 * 60 * 1000, 400);
// Task #2838: /api/notifications/events is a long-lived SSE endpoint whose
// client used to retry FAILED connection attempts (401 dead session, 429)
// on a fixed 5 s timer — one request every ~5–6 s. Each attempt was counted
// against the shared "api" bucket (200 req/15 min × 1.5 account_manager =
// 300 max), exhausting ~150–180 slots in 15 min and leaving the dashboard
// and client-summary endpoints with almost no budget. Exempting the SSE
// path prevents reconnect storms from starving unrelated endpoints.
// Task #2840 verified established SSE connections are NOT dropped by the
// proxy/LB (65+ s probes with only 25 s heartbeats survived on both direct
// and proxied connections); the ~5–6 s cadence was the client retry loop.
// The client now backs off exponentially (client/src/lib/sseReconnect.ts).
// A dedicated `notifications_sse` limiter config is registered below for
// auditability in the Rate Limit Dashboard.
registerLimiterConfig("notifications_sse", 15 * 60 * 1000, 0, false, {
  exempt: true,
  note: "Exempt from the shared api bucket — SSE long-lived connections reconnect frequently by design (Task #2838). Requests to /api/notifications/events are never rate limited; max 0 here means no limiter applies, not that everything is blocked.",
});
// Task #2880: background polling endpoints moved out of the shared "api"
// bucket into their own budget so steady-state bell + activity polling
// cannot starve interactive dashboard requests. 120 req/15min base × role
// multiplier (180 for account_manager) is generous for 60s polling across
// several tabs. The SSE stream is the primary delivery path; polling is the
// safety-net fallback when SSE is unavailable.
const BACKGROUND_POLLING_PATHS = [
  "/api/notifications/unread-count",
  "/api/notifications",
  "/api/activity",
] as const;
// Task #2883: tunerReadOnly keeps the auto-tuner from treating this
// non-interactive safety-net bucket like an interactive one — steady
// bell/activity polling traffic would otherwise skew its heuristics into
// proposing limit changes for a bucket that should stay operator-managed.
registerLimiterConfig("background_polling", 15 * 60 * 1000, 120, true, {
  tunerReadOnly: true,
  note: "Non-interactive safety-net bucket for background bell/activity polling (Task #2880). The 120 req/15min limit is enforced, but the auto-tuner never suggests or applies changes here — polling cadence is fixed by the client, so block-rate heuristics for interactive traffic do not apply (Task #2883).",
});
const backgroundPollingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: roleAwareMax(() => getDynamicMax("background_polling")),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  message: { message: "Too many requests, please try again later." },
  skip: (req) => {
    if (WEBHOOK_PATHS.some((p) => req.originalUrl.startsWith(p))) return true;
    // Task #2838 (preserved): the SSE endpoint is intentionally exempt from ALL
    // rate-limit buckets. Express mounts backgroundPollingLimiter at the
    // "/api/notifications" prefix, which would otherwise also match
    // "/api/notifications/events". Explicitly skip it here so the SSE stream
    // cannot be throttled by the background_polling bucket.
    const path = req.originalUrl.split("?")[0];
    if (path === "/api/notifications/events") return true;
    return false;
  },
  handler: createRateLimitHandler("background_polling"),
});
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: roleAwareMax(() => getDynamicMax("api")),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  message: { message: "Too many requests, please try again later." },
  skip: (req) => {
    if (req.path === "/health") return true;
    const path = req.originalUrl.split("?")[0];
    // Task #2838: SSE endpoint is exempt from the api bucket.
    if (path === "/api/notifications/events") return true;
    // Task #2880: background polling endpoints have their own bucket.
    if (BACKGROUND_POLLING_PATHS.some((p) => path === p || path.startsWith(p + "?"))) return true;
    if (WEBHOOK_PATHS.some((p) => req.originalUrl.startsWith(p))) return true;
    return false;
  },
  handler: createRateLimitHandler("api"),
});

registerLimiterConfig("auth", 15 * 60 * 1000, 10, false);
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => getDynamicMax("auth"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login attempts, please try again later." },
  handler: createRateLimitHandler("auth"),
});

for (const webhookPath of WEBHOOK_PATHS) {
  app.use(webhookPath, createRequestTracker("webhook"));
  app.use(webhookPath, webhookLimiter);
}

for (const authPath of AUTH_LIMITER_PATHS) {
  app.use(authPath, createRequestTracker("auth"));
  app.use(authPath, authLimiter);
}

// Task #4041 — the public token-gated share-link download surface gets its
// own IP-keyed bucket so hot-linked files or scripted token scanners cannot
// consume bandwidth/DB work freely (this prefix bypasses the /api limiters).
for (const sharePath of SHARE_FILE_PATHS) {
  app.use(sharePath, createRequestTracker("shareFile"));
  app.use(sharePath, shareFileLimiter);
}

// Task #2880: background polling endpoints get their own limiter so they
// cannot drain the interactive "api" bucket.
for (const pollingPath of BACKGROUND_POLLING_PATHS) {
  app.use(pollingPath, createRequestTracker("background_polling"));
  app.use(pollingPath, backgroundPollingLimiter);
}

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

// Task #836 Phase 1: API request DB hold labels.
//
// Problem: API-pool long client holds were almost all logged with
// `label=unknown`, which made it impossible to attribute API saturation
// to a specific endpoint.
//
// Approach:
//  1. On every API/webhook/auth request, install an outer
//     `withDbHoldLabel` scope so any DB checkout that happens *anywhere*
//     during the request lifecycle is labeled — never `unknown`.
//  2. The label is stored as a mutable ref (see `setCurrentDbHoldLabel`),
//     so the most-specific known label is always read at release time.
//  3. The initial label is a normalized URL fallback. Once Express has
//     matched a route handler, the per-request `res.on("finish")` hook
//     plus a request-completion guard refines the label to the matched
//     route pattern (e.g. `api:GET /api/clients/:id`) so the rolling
//     stats and any long-hold log line carry the correct attribution.
//  4. Health probes (`/health`, `/api/health`) get a distinct label so
//     they do not pollute the user-facing API hold breakdown.

// Task #836 Phase 1: `normalizeApiPathForLabel` lives in `./apiLabel`
// so tests can import it without booting the Express server. We
// re-export here to keep existing callers working.
import { normalizeApiPathForLabel } from "../apiLabel";
export { normalizeApiPathForLabel };

function buildApiLabel(req: Request): string {
  const isHealth =
    req.path === "/health" ||
    req.path === "/api/health" ||
    req.path.startsWith("/api/health/");
  const prefix = isHealth ? "api:health" : "api";
  const route = (req as any).route?.path as string | undefined;
  if (route) {
    const base = (req.baseUrl || "") + route;
    return `${prefix}:${req.method} ${base}`;
  }
  return `${prefix}:${req.method} ${normalizeApiPathForLabel(req.originalUrl || req.url)}`;
}

app.use((req, res, next) => {
  const reqPath = req.path;

  // Task #836 Phase 1: install a label scope so every DB checkout that
  // happens during this request is attributed. The handler may run
  // synchronously up through the first await — by that time
  // `req.route` is populated, so we set the refined label as soon as
  // we can on the next tick. We also refine on `finish` so any post-
  // response work (e.g. background promise) still picks up the matched
  // route if it executed before logging.
  const initialLabel = buildApiLabel(req);

  // Task #3816: the `METHOD path status in Nms` access line moved to the
  // app-level spine middleware (observability/accessLog.ts), which adds
  // rid/route/role fields and elides noisy health/poll routes. This wrapper
  // now only owns DB hold-label attribution.

  _withDbHoldLabel(initialLabel, () => {
    return new Promise<void>((resolve) => {
      // Refine label once Express has had a chance to match a route.
      // setImmediate fires after the current macrotask, which in
      // practice is after Express's synchronous route lookup but
      // before any awaited DB call inside the handler completes.
      setImmediate(() => {
        try {
          const refined = buildApiLabel(req);
          if (refined !== initialLabel) _setCurrentDbHoldLabel(refined);
          // Task #836 Phase 1 (post-review): if Express never attached
          // a matched route by the time we refine, the label is the
          // normalized-URL fallback. Track that as a separate metric
          // so the dashboard can flag attribution regressions even
          // when the label isn't literally "unknown".
          if (!(req as any).route?.path && reqPath.startsWith("/api")) {
            _recordApiFallbackLabelHit();
          }
        } catch {
          // Label refinement is best-effort; never fail the request on
          // an attribution error.
        }
      });
      const done = () => resolve();
      res.on("finish", done);
      res.on("close", done);
      next();
    });
  }).catch((err) => {
    // The inner promise resolves on response finish/close — surfacing an
    // error here means our wrapper itself misbehaved, not the handler.
    console.error("[Task#836] API hold-label wrapper error:", err);
  });
});

// ── READINESS GATE ──────────────────────────────────────────────────────────
// The port binds immediately (below) while bootstrap runs asynchronously, so
// almost nothing is mounted yet when the first requests arrive. Two
// hold-then-serve gates (server/bootGate.ts) cover that window:
//   - /api requests wait at most BOOT_503_GATE_TIMEOUT_MS before receiving
//     the retryable JSON 503 (code BOOT_503). Health-probe paths (/health)
//     and all webhook paths bypass immediately.
//   - Non-API GET/HEAD page requests (the workspace preview, deep links like
//     /dashboard during a deploy's boot window) wait at the page gate
//     mounted below the early static handlers, then receive a no-cache
//     auto-retrying "app is starting" page — never Express's raw
//     "Cannot GET /". Note the early /assets + / handlers below are
//     PRODUCTION-ONLY; in dev there are no early handlers at all, so the
//     page gate is the only thing standing between a pre-ready page load
//     and the default 404. (Task #3782 — an older version of this comment
//     wrongly claimed early handlers covered the homepage in all envs.)
// Marketing hosts are unaffected: registerMarketingSite() mounted earlier
// terminates those requests before either gate.
const BOOT_503_GATE_TIMEOUT_MS = 10_000;
const BOOT_PAGE_GATE_TIMEOUT_MS = 8_000;
export const bootGate = createBootGate({
  apiTimeoutMs: BOOT_503_GATE_TIMEOUT_MS,
  pageTimeoutMs: BOOT_PAGE_GATE_TIMEOUT_MS,
  webhookPaths: WEBHOOK_PATHS,
});
app.use("/api", bootGate.apiGate);

// In production, serve /assets immediately so the SPA's bundled JS/CSS loads
// on the very first request, well before bootstrap completes.
// The homepage GET / is also served immediately so the Replit health-check
// (which probes / within 5 s of deploy) gets a 200 instantly.
// The remaining static routes and the catch-all that serves index.html for all
// client-side routes are added by serveStatic() after route registration to
// preserve the ordering constraint.
// Task #3782: resolution moved to registerEarlyProdStaticHandlers, which is
// CJS/ESM-safe. The old `import.meta.dirname` guard was empty in the CJS
// production bundle (esbuild replaces import.meta with {}), so these handlers
// silently never mounted in the deployed build and "/" 404'd during boot.
if (process.env.NODE_ENV === "production") {
  if (registerEarlyProdStaticHandlers(app)) {
    log("[Bootstrap] Early static handlers registered — /assets + / served immediately");
  } else {
    console.error(
      "[Bootstrap] Early static handlers NOT registered — build directory missing; " +
        "the page gate below will hold / until bootstrap completes.",
    );
  }
}

// Task #3782 — hold non-API page loads (GET/HEAD) during boot. Mounted AFTER
// the marketing site (marketing hosts stay instant) and AFTER the production
// early handlers (so / and /assets keep serving from disk immediately —
// the Replit deploy health probe hits / within seconds). Everything else —
// the dev homepage, deep links like /dashboard during a production boot —
// waits here for readiness instead of falling through to Express's default
// "Cannot GET /", and degrades to the auto-retrying boot page on timeout or
// bootstrap failure. Zero-cost passthrough once the app is ready.
app.use(bootGate.pageGate);

// LISTEN IMMEDIATELY — before any async bootstrap work. Page requests wait
// at the page gate above (production serves /assets + / from the early
// handlers); API requests wait at the /api readiness gate.
const port = parseInt(process.env.PORT || "5000", 10);
httpServer.listen(
  { port, host: "0.0.0.0", reusePort: true },
  () => { log(`serving on port ${port}`); },
);
