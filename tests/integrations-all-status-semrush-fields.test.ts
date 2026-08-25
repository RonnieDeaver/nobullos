/* test-registration
{
  "name": "Integrations Hub SEMrush badge fields (Task #1975)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.7s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1975 — End-to-end coverage for the Integrations Hub SEMrush badge.
 *
 * Boots `GET /api/integrations/all-status` and asserts that the SEMrush
 * outcome surfaces (`connected`, `disconnectReason`, `lastProbeError`,
 * plus the preserve branch on a warm cache) actually reach the JSON
 * payload. Mirrors `integrations-all-status-zoom-fields.test.ts` so a
 * future refactor of the response shape can't silently flip a transient
 * SEMrush OAuth blip into a Not-Connected badge — the regression
 * symptom the Hub was previously flapping on.
 *
 * Scenarios:
 *   1. `connected`     — Fresh access token already in settings. Probe
 *                        returns connected without hitting the OAuth
 *                        endpoint. Badge connected; reasons null.
 *   2. `unauthorized`  — Only the refresh_token is set; OAuth `/dag/
 *                        device/token` returns a definitive
 *                        `invalid_request` body (SEMrush quirk — NOT
 *                        `invalid_grant`). Helper classifies terminal,
 *                        `onTerminalAfterRetry` clears tokens, probe
 *                        commits unauthorized with reason text.
 *   3. Warm-cache preserve — First warm with a valid access token
 *                        (connected commit). Walk the cache past its
 *                        freshness window, then flip the OAuth endpoint
 *                        to return 500 AND blank the access token so
 *                        the probe must refresh. Helper raises a
 *                        transient OAuthRefreshError, probe returns
 *                        `probe_failed`, the cache preserves
 *                        `connected:true` and populates
 *                        `lastProbeError`.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

// Ensure the Clerk per-request test seam is active for bare repros too.
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db } from "../server/db";
import { storage } from "../server/storage";
import { registerIntegrationRoutes } from "../server/routes/integrations";
import { registerHeatmapRoutes } from "../server/routes/heatmap";
import {
  __resetIntegrationStatusCacheForTest,
  __rewindStoredAtMsForTest,
} from "../server/services/integrationStatusCache";
import { __resetOAuthRefreshSingleFlightForTest } from "../server/services/oauthRefresh";

const TAG = "task-1975";
const AM_ID = `${TAG}-am`;

type SemrushPayload = {
  connected: boolean | null;
  disconnectReason: string | null;
  lastProbeError: string | null;
  lastCheckedAt: string | null;
};

const originalFetch: typeof fetch = global.fetch;
let semrushTokenHandler:
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
  if (url.includes("oauth.semrush.com")) {
    if (semrushTokenHandler) return semrushTokenHandler(url, init);
    // Default: never reached in the connected path; raise so a stray
    // call shows up loudly.
    return new Response("test-default-semrush-oauth-not-mocked", { status: 599 });
  }
  return originalFetch(input as any, init);
}) as any;

async function ensureUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${AM_ID}, 'account_manager', ${"Task1975 AM"})
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
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; requireAuth resolves the seeded users
    // row and populates the legacy req.user.claims.sub shape itself.
    (req as any).__test_clerkUserId = AM_ID;
    next();
  });
  registerIntegrationRoutes(app);
  registerHeatmapRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function fetchSemrush(baseUrl: string): Promise<SemrushPayload> {
  const r = await fetch(`${baseUrl}/api/integrations/all-status`);
  if (r.status !== 200) {
    const text = await r.text();
    throw new Error(`all-status → ${r.status}: ${text.slice(0, 300)}`);
  }
  const body = await r.json();
  return body.semrush as SemrushPayload;
}

type SemrushStatusPayload = {
  configured: boolean;
  connected: boolean;
  expired: boolean;
  disconnectReason: string | null;
  lastProbeError: string | null;
  pendingAuth?: { userCode: string; verificationUri: string };
};

async function fetchSemrushStatus(baseUrl: string): Promise<SemrushStatusPayload> {
  const r = await fetch(`${baseUrl}/api/semrush/status`);
  if (r.status !== 200) {
    const text = await r.text();
    throw new Error(`/api/semrush/status → ${r.status}: ${text.slice(0, 300)}`);
  }
  return (await r.json()) as SemrushStatusPayload;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollSemrushUntil(
  baseUrl: string,
  pred: (s: SemrushPayload) => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<SemrushPayload> {
  const start = Date.now();
  let last: SemrushPayload | null = null;
  while (Date.now() - start < timeoutMs) {
    last = await fetchSemrush(baseUrl);
    if (pred(last)) return last;
    await wait(50);
  }
  throw new Error(
    `Timed out waiting for ${label}; last semrush payload = ${JSON.stringify(last)}`,
  );
}

let passed = 0;
let failed = 0;

async function step(
  name: string,
  setup: () => Promise<void>,
  fn: () => Promise<void>,
): Promise<void> {
  __resetIntegrationStatusCacheForTest();
  __resetOAuthRefreshSingleFlightForTest();
  semrushTokenHandler = null;
  try {
    await setup();
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}: ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
  } finally {
    __resetIntegrationStatusCacheForTest();
    __resetOAuthRefreshSingleFlightForTest();
    semrushTokenHandler = null;
  }
}

async function setTokens(opts: {
  access?: string;
  refresh?: string;
  expiresAt?: number;
}): Promise<void> {
  await storage.setSystemSetting("semrush_access_token", opts.access ?? "", "system");
  await storage.setSystemSetting("semrush_refresh_token", opts.refresh ?? "", "system");
  await storage.setSystemSetting(
    "semrush_token_expires_at",
    opts.expiresAt !== undefined ? String(opts.expiresAt) : "",
    "system",
  );
}

async function main(): Promise<void> {
  console.log("Integrations Hub SEMrush badge fields end-to-end (Task #1975)");

  await ensureUser();

  const prior = {
    access: await storage.getSystemSetting("semrush_access_token").catch(() => null),
    refresh: await storage.getSystemSetting("semrush_refresh_token").catch(() => null),
    expires: await storage.getSystemSetting("semrush_token_expires_at").catch(() => null),
    breaker: await storage.getSystemSetting("semrush_auth_breaker_state").catch(() => null),
  };

  const { server, baseUrl } = await listen(buildApp());

  try {
    await step(
      "connected outcome — semrush.connected:true + reasons null",
      async () => {
        await setTokens({
          access: "fake-semrush-access",
          refresh: "fake-semrush-refresh",
          expiresAt: Date.now() + 60 * 60_000,
        });
      },
      async () => {
        const s = await pollSemrushUntil(
          baseUrl,
          (x) => x.connected === true,
          "semrush.connected === true",
        );
        assert.equal(s.connected, true);
        assert.equal(
          s.disconnectReason,
          null,
          "disconnectReason should be null on a fresh connected commit",
        );
        assert.equal(
          s.lastProbeError,
          null,
          "lastProbeError should be null on a fresh connected commit",
        );
      },
    );

    await step(
      "unauthorized outcome — semrush.connected:false, disconnectReason populated, lastProbeError null",
      async () => {
        // No access token; refresh_token present so the probe goes
        // through the OAuth refresh path. The endpoint returns a
        // SEMrush-flavor terminal body (`invalid_request`, NOT
        // `invalid_grant`).
        await setTokens({
          refresh: "fake-semrush-refresh",
          expiresAt: Date.now() - 60_000,
        });
        // Task #3661 — seed the DURABLE auth-dead breaker signal. Since Task
        // #2500 a terminal refresh on the non-authoritative `probe` purpose
        // only commits `unauthorized` when the durable breaker is open (an
        // authoritative refresh confirmed the death); otherwise the probe
        // preserves the last-known badge (rotation-race safety). This case
        // previously passed only when a SIBLING suite happened to leave an
        // open persisted breaker in the shared dev DB — seed it explicitly so
        // the unauthorized commit is deterministic. `trippedAtMs` is set
        // outside the 15s local-trip grace so the probe_failed case below can
        // clear it and reconcile closes the in-process breaker immediately.
        await storage.setSystemSetting(
          "semrush_auth_breaker_state",
          JSON.stringify({
            code: "semrush_refresh_failed_permanent",
            openedUntilMs: Date.now() + 5 * 60_000,
            trippedAtMs: Date.now() - 60_000,
            tripCount: 1,
          }),
          "system",
        );
        semrushTokenHandler = async () =>
          new Response(
            JSON.stringify({ error: "invalid_request", reason: "Refresh token rejected" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
      },
      async () => {
        const s = await pollSemrushUntil(
          baseUrl,
          (x) => x.connected === false,
          "semrush.connected === false (unauthorized commit)",
        );
        assert.equal(s.connected, false);
        assert.ok(
          typeof s.disconnectReason === "string" && s.disconnectReason.length > 0,
          `disconnectReason must surface the terminal SEMrush refresh reason (got ${s.disconnectReason})`,
        );
        assert.ok(
          /invalid|refresh|400|semrush/i.test(s.disconnectReason!),
          `disconnectReason should describe the auth failure (got ${s.disconnectReason})`,
        );
        assert.equal(
          s.lastProbeError,
          null,
          "lastProbeError must be null on a committed unauthorized outcome (terminal, not transient)",
        );
      },
    );

    await step(
      "probe_failed on warm cache preserves connected:true + populates lastProbeError",
      async () => {
        await setTokens({
          access: "fake-semrush-access",
          refresh: "fake-semrush-refresh",
          expiresAt: Date.now() + 60 * 60_000,
        });
        // Task #3661 — clear the breaker signal seeded by the unauthorized
        // case: this case models a HEALTHY connection hitting a transient
        // probe blip. Empty string is what the breaker's own reset persists.
        await storage.setSystemSetting("semrush_auth_breaker_state", "", "system");
      },
      async () => {
        // Warm phase — probe is connected without hitting OAuth.
        const warm = await pollSemrushUntil(
          baseUrl,
          (x) => x.connected === true,
          "warm semrush.connected === true",
        );
        assert.equal(warm.connected, true);
        assert.equal(warm.lastProbeError, null);

        // Walk the cached entry past its freshness window AND blank
        // the access token so the next probe must refresh — at which
        // point the (5xx) OAuth endpoint forces a transient error.
        assert.ok(
          __rewindStoredAtMsForTest("semrush", 5 * 60_000),
          "rewind seam should find the warmed semrush cache entry",
        );
        await setTokens({
          refresh: "fake-semrush-refresh",
          expiresAt: Date.now() - 60_000,
        });
        semrushTokenHandler = async () => new Response("boom", { status: 500 });

        const preserved = await pollSemrushUntil(
          baseUrl,
          (x) => x.lastProbeError !== null,
          "semrush.lastProbeError populated by preserve outcome",
        );
        assert.equal(
          preserved.connected,
          true,
          "preserve outcome must NOT flip connected:true → false",
        );
        assert.ok(
          preserved.lastProbeError && /500|http|semrush|refresh|probe/i.test(preserved.lastProbeError),
          `lastProbeError should describe the transient failure (got ${preserved.lastProbeError})`,
        );

        // Mixed-state regression: /api/semrush/status MUST agree with
        // /api/integrations/all-status on the same cached preserve
        // entry. Before Task #1975 the Hub badge could show Connected
        // (from cached all-status) while the same card body rendered
        // Re-connect from a live /api/semrush/status probe.
        const sideBySide = await fetchSemrushStatus(baseUrl);
        assert.equal(
          sideBySide.connected,
          true,
          `/api/semrush/status must also preserve connected:true under transient probe failure (got ${JSON.stringify(sideBySide)})`,
        );
        assert.equal(
          sideBySide.expired,
          false,
          "/api/semrush/status must NOT render `expired:true` on a transient probe blip",
        );
        assert.ok(
          sideBySide.lastProbeError,
          "/api/semrush/status must surface lastProbeError when the shared cache preserved",
        );
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      for (const [key, snap] of [
        ["semrush_access_token", prior.access],
        ["semrush_refresh_token", prior.refresh],
        ["semrush_token_expires_at", prior.expires],
        ["semrush_auth_breaker_state", prior.breaker],
      ] as const) {
        if (!snap) {
          await storage.deleteSystemSetting(key);
        } else {
          await storage.setSystemSetting(key, snap.value ?? "", "system");
        }
      }
    } catch {}
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
