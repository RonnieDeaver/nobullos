/* test-registration
{
  "name": "Integrations Hub Zoom badge fields (Task #1931)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1931 — End-to-end coverage for the Integrations Hub Zoom badge.
 *
 * Boots `GET /api/integrations/all-status` and asserts that the Zoom
 * outcome surfaces (`connected`, `disconnectReason`, `lastProbeError`,
 * plus the preserve branch on a warm cache) actually reach the JSON
 * payload. Mirrors the Task #1889 Slack and Task #1897 Front route-level
 * tests so a future refactor of the response shape can't silently drop
 * `zoom.lastProbeError` or flip a transient 5xx into a Not-Connected
 * badge.
 *
 * Scenarios:
 *   1. `connected`     — Zoom `/users/me` returns 200 with an id. Badge
 *                        connected, disconnectReason null, lastProbeError
 *                        null.
 *   2. `unauthorized`  — Zoom `/users/me` returns 401 and the OAuth
 *                        `/token` refresh returns a terminal
 *                        invalid_grant. The refresh-and-retry path
 *                        engages the auth gate; probeConnection commits
 *                        Not-Connected with `disconnectReason` carrying
 *                        the reason. `lastProbeError` stays null
 *                        (terminal, not transient).
 *   3. `probe_failed`  — Zoom `/users/me` returns 500 on a cold cache.
 *                        Badge value stays null (UI paints "Checking…").
 *   4. Warm-cache preserve — first warm with 200 (connected), then flip
 *                        fetch to 500. The next refresh must leave
 *                        `zoom.connected === true` while populating
 *                        `zoom.lastProbeError`. Uses the
 *                        `__rewindStoredAtMsForTest` seam so we don't
 *                        wait out the 60 s freshness window.
 *
 * The Zoom probe itself is exercised end-to-end (no module-level
 * `probeConnection` stub — ESM exports are read-only). We drive the
 * outcomes by monkey-patching `global.fetch` for `api.zoom.us/v2/*` and
 * `zoom.us/oauth/token`.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { storage } from "../server/storage";
import { registerIntegrationRoutes } from "../server/routes/integrations";
import {
  __resetIntegrationStatusCacheForTest,
  __rewindStoredAtMsForTest,
} from "../server/services/integrationStatusCache";
import {
  clearZoomPermanentFailure,
  clearZoomValidationBreaker,
} from "../server/services/zoomIntegration";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

const TAG = "task-1931";
const AM_ID = `${TAG}-am`;

type ZoomPayload = {
  connected: boolean | null;
  disconnectReason: string | null;
  lastProbeError: string | null;
  lastCheckedAt: string | null;
};

const originalFetch: typeof fetch = global.fetch;
let zoomApiHandler:
  | ((url: string, init?: RequestInit) => Promise<Response>)
  | null = null;
let zoomTokenHandler:
  | ((url: string, init?: RequestInit) => Promise<Response>)
  | null = null;

const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  const url =
    typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (url.includes("api.zoom.us/")) {
    if (zoomApiHandler) return zoomApiHandler(url, init);
    return new Response(JSON.stringify({ id: "me_default" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.includes("zoom.us/oauth/token")) {
    if (zoomTokenHandler) return zoomTokenHandler(url, init);
    return new Response(
      JSON.stringify({
        access_token: "fake-new-access",
        refresh_token: "fake-new-refresh",
        expires_in: 3600,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return originalFetch(input as any, init);
}) as any;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function ensureUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${AM_ID}, 'account_manager', ${"Task1931 AM"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
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
    // Clerk per-request test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated. The
    // pre-Clerk passport-shape injection stopped working when auth migrated.
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

async function fetchZoom(baseUrl: string): Promise<ZoomPayload> {
  const r = await fetch(`${baseUrl}/api/integrations/all-status`);
  if (r.status !== 200) {
    const text = await r.text();
    throw new Error(`all-status → ${r.status}: ${text.slice(0, 300)}`);
  }
  const body = await r.json();
  return body.zoom as ZoomPayload;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollZoomUntil(
  baseUrl: string,
  pred: (s: ZoomPayload) => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<ZoomPayload> {
  const start = Date.now();
  let last: ZoomPayload | null = null;
  while (Date.now() - start < timeoutMs) {
    last = await fetchZoom(baseUrl);
    if (pred(last)) return last;
    await wait(50);
  }
  throw new Error(
    `Timed out waiting for ${label}; last zoom payload = ${JSON.stringify(last)}`,
  );
}

let passed = 0;
let failed = 0;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  __resetIntegrationStatusCacheForTest();
  clearZoomPermanentFailure("test_reset");
  clearZoomValidationBreaker();
  zoomApiHandler = null;
  zoomTokenHandler = null;
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}: ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
  } finally {
    __resetIntegrationStatusCacheForTest();
    clearZoomPermanentFailure("test_reset");
    clearZoomValidationBreaker();
    zoomApiHandler = null;
    zoomTokenHandler = null;
  }
}

async function main(): Promise<void> {
  console.log("Integrations Hub Zoom badge fields end-to-end (Task #1931)");

  await ensureUser();

  // Snapshot + seed Zoom token settings so probeConnection() proceeds
  // straight to the `/users/me` call (no real OAuth refresh in the
  // happy path — the access-token expiry is set well past the 5-min
  // refresh-skew window inside getAccessToken).
  const prior = {
    access: await storage.getSystemSetting("zoom_access_token").catch(() => null),
    refresh: await storage.getSystemSetting("zoom_refresh_token").catch(() => null),
    expires: await storage.getSystemSetting("zoom_token_expires_at").catch(() => null),
  };
  await storage.setSystemSetting("zoom_access_token", "fake-zoom-access", "system");
  await storage.setSystemSetting("zoom_refresh_token", "fake-zoom-refresh", "system");
  await storage.setSystemSetting(
    "zoom_token_expires_at",
    String(Math.floor(Date.now() / 1000) + 60 * 60),
    "system",
  );

  // Refresh path needs OAuth client creds — preserve any existing env so
  // we don't disturb other tests in the same process.
  const priorClientId = process.env.ZOOM_CLIENT_ID;
  const priorClientSecret = process.env.ZOOM_CLIENT_SECRET;
  process.env.ZOOM_CLIENT_ID = priorClientId ?? "fake-zoom-client-id";
  process.env.ZOOM_CLIENT_SECRET = priorClientSecret ?? "fake-zoom-client-secret";

  const { server, baseUrl } = await listen(buildApp());

  try {
    await step("connected outcome — zoom.connected:true + reasons null", async () => {
      zoomApiHandler = async () => jsonResponse({ id: "me_ok", email: "ok@example.com" });
      const z = await pollZoomUntil(
        baseUrl,
        (x) => x.connected === true,
        "zoom.connected === true",
      );
      assert.equal(z.connected, true);
      assert.equal(
        z.disconnectReason,
        null,
        "disconnectReason should be null on a fresh connected commit",
      );
      assert.equal(
        z.lastProbeError,
        null,
        "lastProbeError should be null on a fresh connected commit",
      );
    });

    await step(
      "unauthorized outcome — zoom.connected:false, disconnectReason populated, lastProbeError null",
      async () => {
        // /users/me returns 401 — triggers refresh-and-retry. The
        // OAuth token endpoint returns a terminal invalid_grant, which
        // engages the auth gate and surfaces an unauthorized commit.
        zoomApiHandler = async () => new Response("unauthorized", { status: 401 });
        zoomTokenHandler = async () =>
          new Response(
            JSON.stringify({ error: "invalid_grant", reason: "Invalid Token!" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        const z = await pollZoomUntil(
          baseUrl,
          (x) => x.connected === false,
          "zoom.connected === false (unauthorized commit)",
        );
        assert.equal(z.connected, false);
        assert.ok(
          typeof z.disconnectReason === "string" && z.disconnectReason.length > 0,
          `disconnectReason must surface the terminal Zoom auth reason (got ${z.disconnectReason})`,
        );
        assert.ok(
          /invalid|auth|401|refresh/i.test(z.disconnectReason!),
          `disconnectReason should describe the auth failure (got ${z.disconnectReason})`,
        );
        assert.equal(
          z.lastProbeError,
          null,
          "lastProbeError must be null on a committed unauthorized outcome (terminal, not transient)",
        );
      },
    );

    await step(
      "probe_failed on cold cache — zoom stays null (UI paints Checking…)",
      async () => {
        zoomApiHandler = async () => new Response("boom", { status: 500 });
        // Cold-cache + preserve writes nothing, so connected stays null
        // across multiple polls. Sample a few times to be sure.
        const samples: ZoomPayload[] = [];
        for (let i = 0; i < 6; i++) {
          samples.push(await fetchZoom(baseUrl));
          await wait(75);
        }
        for (const s of samples) {
          assert.equal(
            s.connected,
            null,
            `connected must remain null on cold-cache probe_failed (got ${s.connected})`,
          );
          assert.equal(
            s.disconnectReason,
            null,
            "disconnectReason must stay null when nothing has committed",
          );
        }
      },
    );

    await step(
      "probe_failed on warm cache preserves connected:true + populates lastProbeError",
      async () => {
        // Warm phase: succeed once so the cache commits connected:true.
        zoomApiHandler = async () => jsonResponse({ id: "me_warm" });
        const warm = await pollZoomUntil(
          baseUrl,
          (x) => x.connected === true,
          "warm zoom.connected === true",
        );
        assert.equal(warm.connected, true);
        assert.equal(warm.lastProbeError, null);

        // Walk the cached entry past its freshness window so the next
        // poll kicks a refresh, without discarding the warm value —
        // that's what lets us exercise the preserve branch end-to-end
        // instead of waiting out the 60-second fresh TTL.
        assert.ok(
          __rewindStoredAtMsForTest("zoom", 5 * 60_000),
          "rewind seam should find the warmed zoom cache entry",
        );

        zoomApiHandler = async () => new Response("boom", { status: 500 });
        const preserved = await pollZoomUntil(
          baseUrl,
          (x) => x.lastProbeError !== null,
          "zoom.lastProbeError populated by preserve outcome",
        );
        assert.equal(
          preserved.connected,
          true,
          "preserve outcome must NOT flip connected:true → false",
        );
        assert.ok(
          preserved.lastProbeError && /500|http|probe|zoom api/i.test(preserved.lastProbeError),
          `lastProbeError should describe the transient failure (got ${preserved.lastProbeError})`,
        );
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      for (const [key, snap] of [
        ["zoom_access_token", prior.access],
        ["zoom_refresh_token", prior.refresh],
        ["zoom_token_expires_at", prior.expires],
      ] as const) {
        if (!snap) {
          await storage.deleteSystemSetting(key);
        } else {
          await storage.setSystemSetting(key, snap.value ?? "", "system");
        }
      }
    } catch {}
    if (priorClientId === undefined) delete process.env.ZOOM_CLIENT_ID;
    else process.env.ZOOM_CLIENT_ID = priorClientId;
    if (priorClientSecret === undefined) delete process.env.ZOOM_CLIENT_SECRET;
    else process.env.ZOOM_CLIENT_SECRET = priorClientSecret;
    await cleanupUser();
    global.fetch = originalFetch;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exitCode = 1; return; }
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
