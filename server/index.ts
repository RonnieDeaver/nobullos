import express, { type Request, Response, NextFunction } from "express";
import compression from "compression";
import { registerRoutes } from "./routes";
import { globalApiErrorHandler } from "./observability/httpErrors";
import {
  serveStatic,
  registerEarlyProdStaticHandlers,
  registerMaplibreVendorRoutes,
  resolveServerModuleDir,
} from "./static";
import { createBootGate } from "./bootGate";
import { registerMarketingSite } from "./website/marketingSite";
import { createServer } from "http";
import path from "path";
import fs from "fs";
import helmet from "helmet";
import {
  buildCspDirectives,
  isFrameRelaxedPath,
  STRICT_FRAME_ANCESTORS,
  EMBED_FRAME_ANCESTORS,
} from "./embedCsp";
import rateLimit from "express-rate-limit";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import { getClerkProxyHost } from "./middlewares/clerkProxyMiddleware";
import { requireAuth } from "./middlewares/requireAuth";
import {
  webhookLimiter,
  writeLimiter,
  uploadLimiter,
  adminLimiter,
  adminReadLimiter,
  sensitiveWriteLimiter,
  resolveUserRoleMultiplier,
  userKeyGenerator,
  roleAwareMax,
  createRequestTracker,
  loadRateLimitMultipliers,
  startRateLimitMultipliersRefresh,
  ipBlockMiddleware,
} from "./routes/middleware";
import { createRateLimitHandler, registerLimiterConfig, trackRequest, getDynamicMax, trackUserUsage, loadBlockedIPsFromDB, loadAlertThresholdsFromDB, loadDefaultBlockDurationFromDB, loadBlockedEventsRetentionFromDB, loadBlockedRateLimitEventsFromDB, startBlockedRateLimitEventsPruneTimer } from "./services/rateLimitMonitor";
import { withDbHoldLabel as _withDbHoldLabel, setCurrentDbHoldLabel as _setCurrentDbHoldLabel, recordApiFallbackLabelHit as _recordApiFallbackLabelHit, withDbAttribution as _withDbAttribution } from "./db";
import { shouldRunFrontBackgroundWorkers } from "./lib/deploymentEnv";
import {
  WEBHOOK_PATHS,
  AUTH_LIMITER_PATHS,
  UPLOAD_PATHS,
  ADMIN_ONLY_PATHS,
  ADMIN_READ_PATHS,
  SENSITIVE_WRITE_PATHS,
  isDedicatedBucketWriteRoute,
} from "./routes/limiterMounts";

// ── Boot modules (Task #3787 split) ─────────────────────────────────────────
// Module-scope side effects run in import order below, mirroring the original
// top-to-bottom statement order of this file: process guards, then the HTTP
// app/middleware/listen (hoisted by shutdown's dependency on httpServer —
// safe: signal/uncaught handlers cannot fire mid-eval and no code awaits in
// between), then shutdown signal hooks. The kick* phase functions contain the
// deferred bootstrap statements verbatim and are invoked in the exact
// original sequence inside the async IIFE.
import "./boot/processGuards";
import "./boot/shutdown";
import { app, httpServer, bootGate, log, apiLimiter } from "./boot/httpApp";
import { kickWarmupsBatchA } from "./boot/warmupsBatchA";
import { kickDdlEnsuresBatchB } from "./boot/ddlEnsuresBatchB";
import { kickStartupBackfills } from "./boot/startupBackfills";
import { kickWorkersAndCleanup } from "./boot/workersAndCleanup";
import { kickSchedulerInits } from "./boot/schedulerInits";
import { normalizeApiPathForLabel } from "./boot/httpApp";
export { log, normalizeApiPathForLabel };

// ── ASYNC BOOTSTRAP ─────────────────────────────────────────────────────────
// Runs in the background after the port is already bound. Resolves the
// readiness gates once the critical path completes, then continues with
// deferred warmups and workers. A critical-path failure lands in the .catch
// at the very end of this IIFE (Task #3782) — loud, step-attributed, never a
// silent half-configured server.
let bootStep = "init";
(async () => {
  // Boot-time Redis flush: evict stale integration_status and sys_setting
  // entries that may have been written by the OTHER environment before the
  // env-namespace fix landed (the broken REPL_DEPLOYMENT check meant both
  // dev and prod shared nobull:dev:* keys on the same Upstash instance).
  // After the fix this is belt-and-suspenders (prod starts under a brand-new
  // nobull:prod:* prefix); for dev it clears any pre-fix prod-poisoned values
  // still within their TTL window. Fails open — never blocks startup.
  // Task #3662 — prime the ClickUp COMPANY-token snapshot (DB override → env)
  // so sync configured-gates (Ads OS liveness, hygiene surface) are correct
  // from the first request even when the token lives only in the DB override.
  // One cheap deny-listed DB read; resolve never throws. Fire-and-forget.
  void import("./services/clickUpCompanyToken")
    .then(({ resolveClickUpCompanyToken }) => resolveClickUpCompanyToken())
    .catch((err: any) => {
      console.warn("[ClickUpCompanyToken] boot prime failed (non-fatal):", err?.message ?? err);
    });

  void import("./services/cache/redisCache").then(async ({ flushEnvNamespacesOnBoot }) => {
    // Await the flush BEFORE prewarming so the flush can't wipe the
    // freshly-committed prewarm values (Task #3341).
    await flushEnvNamespacesOnBoot().catch((err) => {
      console.warn("[RedisCache] boot flush failed (non-fatal):", err?.message ?? err);
    });
    // Task #3341 — boot-time pre-warm of the critical Integrations Hub
    // badges (Front, Zoom, Google Ads, SEMrush). After the env-namespace
    // fix, prod's nobull:prod:integration_status:* namespace starts empty
    // on every deploy, so without this the first admin poll painted
    // "Checking…" until each background probe landed. Deployment-gated:
    // the workspace restarts constantly and its probes would add churn
    // against live provider APIs (dev override: env force flag).
    try {
      const { isRunningInDeployment } = await import("./lib/deploymentEnv");
      if (
        isRunningInDeployment() ||
        process.env.INTEGRATION_STATUS_PREWARM_FORCE_ENABLE === "1"
      ) {
        const { prewarmCriticalIntegrationStatuses } = await import(
          "./services/integrationStatusLoaders"
        );
        void prewarmCriticalIntegrationStatuses().catch((err) => {
          console.warn(
            "[IntegrationStatusPrewarm] boot prewarm failed (non-fatal):",
            err?.message ?? err,
          );
        });
      }
    } catch (err: any) {
      console.warn("[IntegrationStatusPrewarm] setup failed (non-fatal):", err?.message ?? err);
    }
  });
  // maplibre-gl is served from node_modules at runtime instead of being
  // bundled into dist/public (~1 MB saved per publish); mounted in both dev
  // and prod — see registerMaplibreVendorRoutes for the rationale.
  registerMaplibreVendorRoutes(app);
  // Serve attached_assets folder for uploaded images (development only)
  if (process.env.NODE_ENV !== "production") {
    // CJS/ESM-safe (Task #3782): never gate on import.meta — it is empty in
    // the CJS bundle (harmless here since this branch is dev-only, but the
    // resolver keeps the pattern consistent and the build warning-free).
    const attachedAssetsPath = path.resolve(resolveServerModuleDir(), "..", "attached_assets");
    app.use("/attached_assets", express.static(attachedAssetsPath));
  }

  // Task #1702: apply any unapplied `migrations/*.sql` files before the
  // rest of bootstrap can touch the schema. Runs only in dev (no-op in
  // production, where `scripts/post-merge.sh` + `predeploy.sh` own the
  // Neon schema). Throws loudly on apply failure so a broken migration
  // surfaces at startup instead of silently breaking the next test run.
  if (process.env.NODE_ENV !== "production") {
    bootStep = "dev-migrations";
    try {
      const { applyPendingDevMigrations } = await import("./devMigrations");
      await _withDbAttribution("startup:dev-migrations", () =>
        applyPendingDevMigrations(),
      );
    } catch (err) {
      console.error(
        "[devMigrations] Failed to apply pending migrations at startup:",
        err,
      );
      throw err;
    }
  }

  // ── CRITICAL PATH ────────────────────────────────────────────────────────
  // Task #959: every awaited bootstrap step from setupAuth through route
  // registration shares one `startup:server-bootstrap` attribution scope.
  // Only the steps that routes strictly depend on are awaited here — auth
  // setup, route registration, error handler, and static/Vite catch-all.
  // All DB warmups, breaker hydrations, DDL ensures, and seeds are deferred
  // to run in parallel after the gate releases (see DEFERRED WARMUPS below).
  await _withDbAttribution("startup:server-bootstrap", async () => {
  // Mount Clerk session middleware (validates session cookie on every request).
  bootStep = "auth-setup";
  app.use(
    clerkMiddleware((req) => ({
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(req) ?? "",
        process.env.CLERK_PUBLISHABLE_KEY,
      ),
    })),
  );
  // /api/auth/user — returns the authenticated user's local DB record.
  // The client's useAuth() hook fetches this to access role/permissions/etc.
  app.get("/api/auth/user", requireAuth, (req: any, res) => {
    res.json(req.dbUser);
  });
  bootStep = "api-middleware";

  app.use("/api", async (req, _res, next) => {
    if (req.path !== "/health" && !WEBHOOK_PATHS.some((p) => req.originalUrl.startsWith(p))) {
      trackRequest("api");
      const auth = getAuth(req);
      const userId = (auth?.sessionClaims?.userId as string | undefined) || auth?.userId || null;
      if (userId) {
        try {
          const multiplier = await resolveUserRoleMultiplier(req);
          trackUserUsage("api", userId, multiplier);
        } catch {
          trackUserUsage("api", userId, 1);
        }
      }
    }
    next();
  });
  app.use("/api", apiLimiter);
  app.use("/api", async (req, _res, next) => {
    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      req.method !== "OPTIONS" &&
      // Task #4788 — writeLimiter skips dedicated-bucket mutations (comms,
      // sheets/docs autosave, activity telemetry); the tracker mirrors that
      // skip so write usage stats stay aligned with limiter consumption
      // (same convention as Task #3853 for admin/sensitiveWrite).
      !isDedicatedBucketWriteRoute(req.method, req.originalUrl)
    ) {
      trackRequest("write");
      const auth = getAuth(req);
      const userId = (auth?.sessionClaims?.userId as string | undefined) || auth?.userId || null;
      if (userId) {
        try {
          const multiplier = await resolveUserRoleMultiplier(req);
          trackUserUsage("write", userId, multiplier);
        } catch {
          trackUserUsage("write", userId, 1);
        }
      }
    }
    next();
  });
  app.use("/api", writeLimiter);

  // Task #3853 — adminLimiter skips GET/HEAD/OPTIONS (mutations only), so the
  // tracker mirrors that to keep usage stats aligned with limiter consumption.
  app.use("/api/admin", createRequestTracker("admin", { mutatingOnly: true }));
  app.use("/api/admin", adminLimiter);

  for (const uploadPath of UPLOAD_PATHS) {
    app.use(uploadPath, createRequestTracker("upload"));
    app.use(uploadPath, uploadLimiter);
  }

  for (const adminPath of ADMIN_ONLY_PATHS) {
    app.use(adminPath, createRequestTracker("admin", { mutatingOnly: true }));
    app.use(adminPath, adminLimiter);
  }

  // Task #3829 — read-heavy admin surfaces get the roomier adminReadLimiter
  // (adminLimiter's 30-req budget would break dashboards firing 10+ GETs/load).
  for (const adminReadPath of ADMIN_READ_PATHS) {
    app.use(adminReadPath, createRequestTracker("adminRead"));
    app.use(adminReadPath, adminReadLimiter);
  }

  for (const swPath of SENSITIVE_WRITE_PATHS) {
    app.use(swPath, createRequestTracker("sensitiveWrite", { mutatingOnly: true }));
    app.use(swPath, sensitiveWriteLimiter);
  }

  bootStep = "route-registration";
  await registerRoutes(httpServer, app);

  // Task #3816: global error middleware — one JSON shape + taxonomy code for
  // every uncaught route error, always logged with the request ID. Body keeps
  // the pre-existing `message` field ("Internal Server Error" for 5xx) so the
  // old contract is preserved while adding error/code/requestId.
  app.use(globalApiErrorHandler);

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    bootStep = "static-serving";
    serveStatic(app);
  } else {
    bootStep = "vite-setup";
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ── RELEASE THE GATES ────────────────────────────────────────────────────
  // Routes are now registered, auth middleware is installed, and the
  // static/Vite catch-all exists. All requests waiting at the /api gate and
  // the page gate will now proceed down the completed stack.
  bootGate.markReady();
  log("[Bootstrap] Server ready — API + page gates released");
  bootStep = "deferred-warmups";

  }); // end startup:server-bootstrap (Task #959)

  // ── DEFERRED WARMUPS ─────────────────────────────────────────────────────
  // All steps below were previously awaited sequentially before listen(),
  // adding ~60s to the cold-boot time on Neon. They are all fail-soft
  // (individual try-catch) and none are required for routes to serve their
  // first request — caches warm on miss, breakers default-open, DDL ensures
  // are idempotent. Running them in parallel after the gate releases means
  // they complete in the background while the app is already serving traffic.

  kickWarmupsBatchA();

  kickDdlEnsuresBatchB();

  kickStartupBackfills();

  kickWorkersAndCleanup();

  kickSchedulerInits();

})().catch((err) => {
  // ── LOUD BOOTSTRAP FAILURE (Task #3782) ─────────────────────────────────
  // Before this catch, a critical-path bootstrap failure surfaced only as an
  // "[FATAL] Unhandled rejection (process kept alive)" log while the
  // half-configured server sat serving "Cannot GET /" forever. markFailed
  // names the failing step and releases every held request onto the
  // auto-retrying boot page (JSON 503 for /api). Then:
  //   - production: exit after a short grace period so the deployment
  //     supervisor restarts the instance — a restart IS the retry for
  //     transient failures (OIDC discovery blip, Neon hiccup).
  //   - development: keep the process alive serving the retry page. The
  //     workspace workflow does not auto-restart an exited process, and a
  //     crash loop would hammer the shared dev DB; the loud log plus the
  //     failure page make the state obvious instead of silent.
  if (bootGate.state() === "ready") {
    // Post-ready tail failure (deferred warmups are individually fail-soft,
    // so this should not happen) — never take down a serving app for it.
    console.error(
      `[Bootstrap] Post-ready bootstrap tail failed at step '${bootStep}' (app keeps serving):`,
      err,
    );
    return;
  }
  bootGate.markFailed(bootStep, err);
  if (process.env.NODE_ENV === "production") {
    console.error(
      "[Bootstrap] Exiting in 3s so the deployment restarts this instance.",
    );
    setTimeout(() => process.exit(1), 3_000);
  } else {
    console.error(
      "[Bootstrap] Dev server kept alive serving the auto-retry page — fix the error above and restart the workflow.",
    );
  }
});
