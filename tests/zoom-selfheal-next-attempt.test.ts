/* test-registration
{
  "name": "Zoom self-heal next-attempt readout (Task #2276)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2276 — Coverage for the Zoom self-heal "next auto-reconnect time" readout.
 *
 * Task #2254 exposed the Zoom auth-gate self-heal scheduler's next-attempt
 * timestamp and parked state through `getZoomAuthSelfHealState()` and forwarded
 * them on the `/api/integrations/all-status` zoom block as `cooldownUntil`
 * (= next self-heal attempt time) and `selfHealParked` (= terminal latch set,
 * operator reconnect required). The existing zoom-auth-* tests only assert the
 * `.terminal` shape; nothing covered the new `nextAttemptAt` / `parked`
 * accessor fields or that they reach the API payload.
 *
 * This test drives the real runtime path with a mocked `fetch` and asserts:
 *
 *   1. After a 401 → refresh-OK → retried-call-still-401 engagement (NON-terminal,
 *      so the self-heal loop schedules a retry), `getZoomAuthSelfHealState()`
 *      returns a non-null `nextAttemptAt` (ISO) with `parked === false`.
 *   2. After a 401 → refresh returns terminal `invalid_grant`,
 *      `getZoomAuthSelfHealState()` returns `nextAttemptAt === null` with
 *      `parked === true`.
 *   3. The zoom block of `GET /api/integrations/all-status` forwards those into
 *      `cooldownUntil` / `selfHealParked` accordingly (mirroring
 *      tests/integrations-other-breaker-fields.test.ts).
 *
 * Self-heal is left ENABLED so the scheduler actually arms its (unref'd, 60s)
 * timer in scenario 1 — that's what populates `nextAttemptAt`. The timer is
 * torn down in the `finally` block so the suite still drains on its own.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

// Ensure the Clerk per-request test seam is honored (requireAuth reads
// __test_clerkUserId only when NODE_ENV === "test") for bare repros.
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID || "test_client_id";
process.env.ZOOM_CLIENT_SECRET =
  process.env.ZOOM_CLIENT_SECRET || "test_client_secret";
process.env.ZOOM_REDIRECT_URI =
  process.env.ZOOM_REDIRECT_URI || "https://test.example.com/api/zoom/callback";

import { db } from "../server/db";
import { storage } from "../server/storage";
import { registerIntegrationRoutes } from "../server/routes/integrations";
import { __resetIntegrationStatusCacheForTest } from "../server/services/integrationStatusCache";
import {
  getMeetingDetails,
  getZoomAuthSelfHealState,
  getZoomAuthGate,
  clearZoomPermanentFailure,
  clearZoomValidationBreaker,
  __clearPersistedZoomAuthGateForTest,
  __disableZoomAuthSelfHealForTest,
} from "../server/services/zoomIntegration";

// Drive an AUTHORITATIVE Zoom API call (no `purpose` → authoritative, unlike
// the probe-safe `zoom_probe` health check) so a 401-then-retry actually
// engages the auth gate and arms the self-heal loop. Returns true if the call
// failed (the expected outcome once the gate engages).
async function callAuthoritativeZoom(): Promise<boolean> {
  try {
    await getMeetingDetails("000000000");
    return false;
  } catch {
    return true;
  }
}

const TAG = "task-2276";
const AM_ID = `${TAG}-am`;

const SETTINGS = {
  ACCESS: "zoom_access_token",
  REFRESH: "zoom_refresh_token",
  EXPIRES: "zoom_token_expires_at",
} as const;

const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";
const ZOOM_API_BASE = "https://api.zoom.us/v2";

type ZoomPayload = {
  breakerOpen: boolean;
  cooldownUntil: string | null;
  selfHealParked: boolean;
};

const originalFetch: typeof fetch = global.fetch;

const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

// `zoomApiHandler` / `zoomTokenHandler` let each scenario decide how the
// Zoom `/users/me` probe and the OAuth `/token` refresh respond. Everything
// else (Upstash, other integration probes) falls through to the real fetch.
let zoomApiHandler:
  | ((url: string, init?: any) => Promise<Response>)
  | null = null;
let zoomTokenHandler:
  | ((url: string, init?: any) => Promise<Response>)
  | null = null;

global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  const url =
    typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (url === ZOOM_TOKEN_URL || url.includes("zoom.us/oauth/token")) {
    if (zoomTokenHandler) return zoomTokenHandler(url, init);
    throw new Error(`Unexpected token fetch: ${url}`);
  }
  if (url.startsWith(ZOOM_API_BASE) || url.includes("api.zoom.us/")) {
    if (zoomApiHandler) return zoomApiHandler(url, init);
    throw new Error(`Unexpected zoom api fetch: ${url}`);
  }
  return originalFetch(input as any, init);
}) as any;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function snapshotZoomSettings() {
  return {
    access: (await storage.getSystemSetting(SETTINGS.ACCESS))?.value ?? null,
    refresh: (await storage.getSystemSetting(SETTINGS.REFRESH))?.value ?? null,
    expires: (await storage.getSystemSetting(SETTINGS.EXPIRES))?.value ?? null,
  };
}
async function restoreZoomSettings(
  snap: Awaited<ReturnType<typeof snapshotZoomSettings>>,
) {
  await storage.setSystemSetting(SETTINGS.ACCESS, snap.access ?? "", "test");
  await storage.setSystemSetting(SETTINGS.REFRESH, snap.refresh ?? "", "test");
  await storage.setSystemSetting(SETTINGS.EXPIRES, snap.expires ?? "", "test");
}

async function primeValidTokens(accessValue: string) {
  const farFutureExpiry = Math.floor(Date.now() / 1000) + 3600;
  await storage.setSystemSetting(SETTINGS.ACCESS, accessValue, "test");
  await storage.setSystemSetting(SETTINGS.REFRESH, "primed_refresh", "test");
  await storage.setSystemSetting(SETTINGS.EXPIRES, String(farFutureExpiry), "test");
}

// Reset every gate / breaker / self-heal counter + the durable signal so a
// scenario can't inherit a prior one's open window.
async function resetZoomState() {
  clearZoomPermanentFailure("test_reset");
  clearZoomValidationBreaker();
  await __clearPersistedZoomAuthGateForTest();
  __resetIntegrationStatusCacheForTest();
}

async function ensureUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, role, authority_level, first_name)
    VALUES (${AM_ID}, ${`${AM_ID}@task2276.example`}, 'account_manager', 'core', ${"Task2276 AM"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, authority_level = EXCLUDED.authority_level
  `);
}
async function cleanupUser(): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM users WHERE id = ${AM_ID}`);
  } catch {}
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated.
    // (The pre-Clerk passport-shape injection stopped working when auth
    // migrated — requireAuth ignores req.user/req.isAuthenticated.)
    (req as any).__test_clerkUserId = AM_ID;
    next();
  });
  registerIntegrationRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function fetchZoomBlock(baseUrl: string): Promise<ZoomPayload> {
  const r = await fetch(`${baseUrl}/api/integrations/all-status`);
  if (r.status !== 200) {
    const text = await r.text();
    throw new Error(`all-status → ${r.status}: ${text.slice(0, 300)}`);
  }
  const body = await r.json();
  return body.zoom as ZoomPayload;
}

let passed = 0;
let failed = 0;

function ok(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? `\n      → ${detail}` : ""}`);
    failed++;
  }
}

const snap = await snapshotZoomSettings();

async function main(): Promise<void> {
  console.log("Zoom self-heal next-attempt readout (Task #2276)");

  await ensureUser();
  const { server, baseUrl } = await listen(buildApp());

  try {
    // ── 1. NON-terminal engagement → self-heal scheduled ─────────────────
    // 401 → refresh succeeds (rotated token) → retried /users/me ALSO 401 →
    // gate engaged WITHOUT a terminal latch, so the self-heal loop arms a
    // retry timer and records its next-attempt time.
    console.log(
      "\n— 1. non-terminal engagement → nextAttemptAt set, parked=false —",
    );
    await resetZoomState();
    await primeValidTokens("stale_access_token_1");
    zoomTokenHandler = async () =>
      jsonResponse({
        access_token: "fresh_but_still_rejected",
        refresh_token: "rotated_refresh_1",
        expires_in: 3600,
        scope: "user:read:user:admin",
      });
    zoomApiHandler = async () =>
      jsonResponse({ code: 124, message: "Invalid access token." }, 401);

    const v1Failed = await callAuthoritativeZoom();
    ok("authoritative call failed when retry also 401", v1Failed === true);
    ok("auth gate engaged after second 401", getZoomAuthGate() !== null);

    const sh1 = getZoomAuthSelfHealState();
    ok("self-heal scheduled (timer armed)", sh1.scheduled === true, JSON.stringify(sh1));
    ok(
      "nextAttemptAt is a non-null ISO timestamp while a retry is pending",
      typeof sh1.nextAttemptAt === "string" &&
        !Number.isNaN(Date.parse(sh1.nextAttemptAt as string)),
      `nextAttemptAt=${sh1.nextAttemptAt}`,
    );
    ok(
      "nextAttemptAt is in the future (the scheduled fire time)",
      !!sh1.nextAttemptAt && Date.parse(sh1.nextAttemptAt as string) > Date.now(),
      `nextAttemptAt=${sh1.nextAttemptAt}`,
    );
    ok("parked=false while self-heal is still retrying", sh1.parked === false);
    ok("terminal latch null (non-terminal engagement)", sh1.terminal === null);

    // Route forwards nextAttemptAt → cooldownUntil and parked → selfHealParked.
    const route1 = await fetchZoomBlock(baseUrl);
    ok("route: zoom.breakerOpen=true", route1.breakerOpen === true);
    ok(
      "route: zoom.cooldownUntil mirrors nextAttemptAt",
      route1.cooldownUntil === sh1.nextAttemptAt,
      `cooldownUntil=${route1.cooldownUntil} nextAttemptAt=${sh1.nextAttemptAt}`,
    );
    ok("route: zoom.selfHealParked=false", route1.selfHealParked === false);

    // ── 2. Terminal engagement → self-heal parked ───────────────────────
    // 401 → refresh returns terminal invalid_grant. The gate engages and the
    // terminal latch is set, so self-heal stands down (no scheduled retry).
    console.log(
      "\n— 2. terminal refresh error → nextAttemptAt null, parked=true —",
    );
    await resetZoomState();
    await primeValidTokens("stale_access_token_2");
    zoomTokenHandler = async () =>
      jsonResponse({ error: "invalid_grant", reason: "Invalid Token!" }, 400);
    zoomApiHandler = async () =>
      jsonResponse({ code: 124, message: "Invalid access token." }, 401);

    const v2Failed = await callAuthoritativeZoom();
    ok("authoritative call failed on terminal refresh", v2Failed === true);
    ok("auth gate engaged after terminal refresh", getZoomAuthGate() !== null);

    const sh2 = getZoomAuthSelfHealState();
    ok("nextAttemptAt is null when parked", sh2.nextAttemptAt === null, JSON.stringify(sh2));
    ok("parked=true after terminal latch", sh2.parked === true);
    ok(
      "terminal latch carries the OAuth error code",
      sh2.terminal !== null && sh2.terminal.oauthError === "invalid_grant",
      JSON.stringify(sh2.terminal),
    );
    ok("self-heal not scheduled while parked", sh2.scheduled === false);

    const route2 = await fetchZoomBlock(baseUrl);
    ok("route: zoom.breakerOpen=true (parked)", route2.breakerOpen === true);
    ok(
      "route: zoom.cooldownUntil is null when parked",
      route2.cooldownUntil === null,
      `cooldownUntil=${route2.cooldownUntil}`,
    );
    ok("route: zoom.selfHealParked=true", route2.selfHealParked === true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Disable + tear down any pending self-heal timer so the process drains.
    __disableZoomAuthSelfHealForTest(true);
    clearZoomPermanentFailure("test_cleanup");
    clearZoomValidationBreaker();
    await __clearPersistedZoomAuthGateForTest();
    __disableZoomAuthSelfHealForTest(false);
    __resetIntegrationStatusCacheForTest();
    await restoreZoomSettings(snap);
    await cleanupUser();
    zoomApiHandler = null;
    zoomTokenHandler = null;
    global.fetch = originalFetch;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    if (err?.stack) console.error(err.stack);
    process.exitCode = 1;
  });
