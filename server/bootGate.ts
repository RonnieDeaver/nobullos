// Task #3782 — never show "Cannot GET /" during startup.
//
// The server binds its port immediately while bootstrap (auth setup, route
// registration, the static/Vite catch-all) runs asynchronously. Until that
// completes, Express has no handler for non-API page paths, so a request to
// "/" (the workspace preview, or any visitor during a production deploy's
// boot window) would fall through to Express's default 404 — the raw
// "Cannot GET /" error. This module centralizes the boot-readiness state and
// the two hold-then-serve middlewares:
//
//   - apiGate (mounted at /api): holds API requests up to apiTimeoutMs, then
//     answers the retryable JSON 503 (code BOOT_503, Retry-After). Health
//     probes (/api/health) and webhook paths bypass immediately — they may
//     arrive before the OIDC session middleware is installed.
//   - pageGate (mounted at app level AFTER the marketing-site mount and the
//     production early static handlers): holds non-API GET/HEAD requests up
//     to pageTimeoutMs, then answers a minimal no-cache auto-retrying
//     "app is starting" HTML page. Non-GET/HEAD methods pass through
//     untouched. Once the app is ready, both gates are a zero-cost
//     passthrough (a single state check).
//
// If bootstrap FAILS, markFailed(step, err) logs loudly WHICH step failed and
// releases every held request onto the friendly retry page (JSON 503 for
// /api) instead of leaving them hanging on a half-configured server. What
// happens to the process afterwards (exit so the deployment restarts it vs
// keep serving the retry page in dev) is policy owned by server/index.ts.
//
// Held requests rely on Express's live dispatch: middleware/routes appended
// to the app AFTER a request entered the stack are still reachable when that
// request's next() finally runs (the /api gate has always depended on this).

import type { RequestHandler, Response } from "express";

export type BootState = "booting" | "ready" | "failed";

export interface BootGateOptions {
  /** How long /api requests wait for readiness before the JSON 503. */
  apiTimeoutMs?: number;
  /** How long non-API GET/HEAD page requests wait before the retry page. */
  pageTimeoutMs?: number;
  /** Path prefixes (matched against originalUrl) that bypass the /api gate. */
  webhookPaths?: readonly string[];
}

export interface BootGate {
  state(): BootState;
  /** Release both gates: held requests proceed down the (now complete) stack. */
  markReady(): void;
  /**
   * Record a fatal bootstrap failure: logs the failing step loudly and
   * releases every held request onto the retry page / JSON 503. A failure
   * reported AFTER the app went ready is logged but does NOT flip a serving
   * app back into the failed state (post-ready steps are fail-soft).
   */
  markFailed(step: string, err: unknown): void;
  /** Settles (never rejects) when boot reaches "ready" or "failed". */
  settled: Promise<void>;
  apiGate: RequestHandler;
  pageGate: RequestHandler;
}

/**
 * The minimal self-contained "app is starting" page. No external assets (so
 * it renders even while nothing else is served), auto-retries via both a
 * meta refresh (no-JS fallback) and location.reload(). Each retry request is
 * held at the page gate again, so the page becomes the real app on the first
 * retry after readiness. The HTML comment marker distinguishes the variants
 * for tests without coupling them to user-facing copy.
 */
export function renderBootPage(opts: { failed?: boolean } = {}): string {
  const failed = opts.failed === true;
  const title = failed ? "NoBull OS — restarting" : "NoBull OS — starting";
  const heading = failed
    ? "NoBull OS hit a problem while starting"
    : "NoBull OS is starting…";
  const detail = failed
    ? "This page keeps retrying automatically. The server log names the failing step."
    : "This page refreshes automatically and becomes the app as soon as it's ready.";
  const marker = failed ? "boot-gate:failed" : "boot-gate:starting";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:#0a0a0a;color:#e7e5e4;
       font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
       -webkit-font-smoothing:antialiased}
  .card{text-align:center;padding:2rem 2.5rem;max-width:26rem}
  .spinner{width:2.25rem;height:2.25rem;margin:0 auto 1.25rem;border-radius:9999px;
           border:3px solid rgba(212,175,55,.25);border-top-color:#d4af37;
           animation:spin .9s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{font-size:1.05rem;font-weight:600;margin:0 0 .4rem;color:#fafaf9}
  p{margin:0;color:#a8a29e;font-size:.85rem}
</style>
</head>
<body>
<!-- ${marker} -->
<div class="card">
  <div class="spinner"></div>
  <h1>${heading}</h1>
  <p>${detail}</p>
</div>
<script>setTimeout(function(){location.reload();},3000);</script>
</body>
</html>
`;
}

/**
 * Write the boot page as a retryable 503. no-store so no proxy/browser layer
 * ever caches the loading page in place of the real app. Safe to call for
 * HEAD requests (Express omits the body). No-op if headers already went out.
 */
export function sendBootPage(
  res: Response,
  opts: { failed?: boolean } = {},
): void {
  if (res.headersSent) return;
  res.status(503);
  res.setHeader("Retry-After", "3");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderBootPage(opts));
}

export function createBootGate(options: BootGateOptions = {}): BootGate {
  const apiTimeoutMs = options.apiTimeoutMs ?? 10_000;
  const pageTimeoutMs = options.pageTimeoutMs ?? 8_000;
  const webhookPaths = options.webhookPaths ?? [];

  let state: BootState = "booting";
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });

  // Existing /api boot contract (Task #959) — keep the shape byte-stable:
  // clients (client/src/lib/queryClient.ts) special-case code BOOT_503.
  const sendApiBoot503 = (res: Response): void => {
    if (res.headersSent) return;
    res.setHeader("Retry-After", "10");
    res.status(503).json({
      error: "Server is starting up, please retry shortly.",
      code: "BOOT_503",
    });
  };

  const apiGate: RequestHandler = (req, res, next) => {
    if (state === "ready") return next();
    // Health probes and webhooks must not be held — they may arrive before
    // the OIDC session middleware is installed.
    if (req.path === "/health" || req.path.startsWith("/health/")) return next();
    if (webhookPaths.some((p) => req.originalUrl.startsWith(p))) return next();
    if (state === "failed") return sendApiBoot503(res);
    // Queue this request behind the settled promise. If bootstrap takes
    // longer than apiTimeoutMs we return the retryable 503.
    const gateTimer = setTimeout(() => sendApiBoot503(res), apiTimeoutMs);
    void settled.then(() => {
      clearTimeout(gateTimer);
      if (res.headersSent) return;
      if (state === "ready") next();
      else sendApiBoot503(res);
    });
  };

  const pageGate: RequestHandler = (req, res, next) => {
    if (state === "ready") return next(); // zero-cost passthrough once ready
    // Only page loads are held: non-GET/HEAD methods to non-API paths keep
    // their historical behavior (they have no boot-window UX to protect).
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    // /api traffic is the apiGate's job (mounted on /api ahead of this);
    // the guard keeps the JSON contract even if mount order ever changes.
    if (req.path === "/api" || req.path.startsWith("/api/")) return next();
    if (state === "failed") return sendBootPage(res, { failed: true });
    const gateTimer = setTimeout(() => sendBootPage(res), pageTimeoutMs);
    void settled.then(() => {
      clearTimeout(gateTimer);
      if (res.headersSent) return;
      if (state === "ready") next();
      else sendBootPage(res, { failed: true });
    });
  };

  return {
    state: () => state,
    settled,
    markReady() {
      if (state !== "booting") return;
      state = "ready";
      settle();
    },
    markFailed(step: string, err: unknown) {
      // Loud by design: this line is the one operators grep for.
      console.error(
        `[BootGate] Bootstrap FAILED at step '${step}' — releasing held requests onto the retry page:`,
        err,
      );
      if (state !== "booting") return; // never downgrade a serving app
      state = "failed";
      settle();
    },
    apiGate,
    pageGate,
  };
}
