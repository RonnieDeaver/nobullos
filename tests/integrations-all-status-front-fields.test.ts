/* test-registration
{
  "name": "Integrations all status front fields (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
/**
 * Task #1897 — End-to-end coverage for the Integrations Hub Front badge.
 *
 * Boots `GET /api/integrations/all-status` and asserts that the Front
 * outcome surfaces (`connected`, `lastProbeError`, plus the preserve
 * branch on a warm cache) actually reach the JSON payload. Mirrors the
 * Task #1889 Slack route-level test so a future refactor of the response
 * shape can't silently drop `front.lastProbeError` or flip a transient
 * 5xx into a Not-Connected badge.
 *
 * Scenarios:
 *   1. `connected`     — Front `/me` returns 200. Badge connected,
 *                        lastProbeError null.
 *   2. `unauthorized`  — Front `/me` returns 401. Badge disconnected,
 *                        lastProbeError null (terminal, not transient).
 *   3. `probe_failed`  — Front `/me` returns 500 on a cold cache. Badge
 *                        value stays null (UI paints "Checking…").
 *   4. Warm-cache preserve — first warm with 200 (connected), then flip
 *                        fetch to 500. The next refresh must leave
 *                        `front.connected === true` while populating
 *                        `front.lastProbeError`. Uses the
 *                        `__rewindStoredAtMsForTest` seam (Task #1889)
 *                        so we don't wait out the 60 s freshness window.
 *
 * The Front probe itself is exercised end-to-end (no module-level
 * `probeConnection` stub — ESM exports are read-only). We drive the
 * outcomes by monkey-patching `global.fetch` for `api2.frontapp.com/*`.
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
import {
  __resetIntegrationStatusCacheForTest,
  __rewindStoredAtMsForTest,
} from "../server/services/integrationStatusCache";

const TAG = "task-1897";
const AM_ID = `${TAG}-am`;

type FrontPayload = {
  connected: boolean | null;
  lastSyncError: string | null;
  lastSyncSuccess: string | null;
  lastCheckedAt: string | null;
  lastProbeError: string | null;
  // Task #3964 (A-003 remainder) — presence-only readiness flag.
  webhookSecretConfigured?: boolean | null;
};

const originalFetch: typeof fetch = global.fetch;
let frontFetchHandler:
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
  if (url.includes("api2.frontapp.com")) {
    if (frontFetchHandler) return frontFetchHandler(url, init);
    return new Response(JSON.stringify({ id: "me_default" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
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
    VALUES (${AM_ID}, 'account_manager', ${"Task1897 AM"})
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
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function fetchFront(baseUrl: string): Promise<FrontPayload> {
  const r = await fetch(`${baseUrl}/api/integrations/all-status`);
  if (r.status !== 200) {
    const text = await r.text();
    throw new Error(`all-status → ${r.status}: ${text.slice(0, 300)}`);
  }
  const body = await r.json();
  return body.front as FrontPayload;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollFrontUntil(
  baseUrl: string,
  pred: (s: FrontPayload) => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<FrontPayload> {
  const start = Date.now();
  let last: FrontPayload | null = null;
  while (Date.now() - start < timeoutMs) {
    last = await fetchFront(baseUrl);
    if (pred(last)) return last;
    await wait(50);
  }
  throw new Error(
    `Timed out waiting for ${label}; last front payload = ${JSON.stringify(last)}`,
  );
}

let passed = 0;
let failed = 0;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  __resetIntegrationStatusCacheForTest();
  frontFetchHandler = null;
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
    frontFetchHandler = null;
  }
}

async function main(): Promise<void> {
  console.log("Integrations Hub Front badge fields end-to-end (Task #1897)");

  await ensureUser();

  // Snapshot + seed Front token settings so probeConnection() proceeds
  // straight to the `/me` call (no real OAuth refresh in the test path).
  const prior = {
    access: await storage.getSystemSetting("front_access_token").catch(() => null),
    refresh: await storage.getSystemSetting("front_refresh_token").catch(() => null),
    expires: await storage.getSystemSetting("front_token_expires_at").catch(() => null),
  };
  await storage.setSystemSetting("front_access_token", "fake-front-access", "system");
  await storage.setSystemSetting("front_refresh_token", "fake-front-refresh", "system");
  // Push expiry well past the 5-min refresh-skew window so
  // getValidFrontAccessToken returns the cached token without
  // attempting a refresh.
  await storage.setSystemSetting(
    "front_token_expires_at",
    String(Date.now() + 60 * 60 * 1000),
    "system",
  );

  const { server, baseUrl } = await listen(buildApp());

  try {
    await step("connected outcome — front.connected:true + lastProbeError null", async () => {
      frontFetchHandler = async () => jsonResponse({ id: "me_ok", name: "Task1897" });
      const f = await pollFrontUntil(
        baseUrl,
        (x) => x.connected === true,
        "front.connected === true",
      );
      assert.equal(f.connected, true);
      assert.equal(
        f.lastProbeError,
        null,
        "lastProbeError should be null on a fresh connected commit",
      );

      // Task #3964 (A-003 remainder) — webhook-secret readiness is surfaced
      // presence-only: strictly boolean once the loader has run, and any
      // secret-adjacent key in the payload carries presence-shaped data,
      // never a value, hash, prefix, or other derived material.
      assert.ok(
        f.webhookSecretConfigured === true || f.webhookSecretConfigured === false,
        `webhookSecretConfigured must be a presence-only boolean, got ${JSON.stringify(
          f.webhookSecretConfigured,
        )}`,
      );
      for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
        if (/secret/i.test(k)) {
          assert.ok(
            typeof v === "boolean" || v === null,
            `front.${k} must be presence-only (boolean/null), got ${typeof v}: ${JSON.stringify(v)}`,
          );
        }
      }
    });

    await step("unauthorized outcome — front.connected:false, lastProbeError null", async () => {
      frontFetchHandler = async () => new Response("nope", { status: 401 });
      const f = await pollFrontUntil(
        baseUrl,
        (x) => x.connected === false,
        "front.connected === false (unauthorized commit)",
      );
      assert.equal(f.connected, false);
      assert.equal(
        f.lastProbeError,
        null,
        "lastProbeError must be null on a committed unauthorized outcome (terminal, not transient)",
      );
    });

    await step("probe_failed on cold cache — front stays null (UI paints Checking…)", async () => {
      frontFetchHandler = async () => new Response("boom", { status: 500 });
      // Cold-cache + preserve writes nothing, so connected stays null
      // across multiple polls. Sample a few times to be sure.
      const samples: FrontPayload[] = [];
      for (let i = 0; i < 6; i++) {
        samples.push(await fetchFront(baseUrl));
        await wait(75);
      }
      for (const s of samples) {
        assert.equal(
          s.connected,
          null,
          `connected must remain null on cold-cache probe_failed (got ${s.connected})`,
        );
      }
    });

    await step(
      "probe_failed on warm cache preserves connected:true + populates lastProbeError",
      async () => {
        // Warm phase: succeed once so the cache commits connected:true.
        frontFetchHandler = async () => jsonResponse({ id: "me_warm" });
        const warm = await pollFrontUntil(
          baseUrl,
          (x) => x.connected === true,
          "warm front.connected === true",
        );
        assert.equal(warm.connected, true);
        assert.equal(warm.lastProbeError, null);

        // Walk the cached entry past its freshness window so the next
        // poll kicks a refresh, without discarding the warm value —
        // that's what lets us exercise the preserve branch end-to-end
        // instead of waiting out the 60-second fresh TTL.
        assert.ok(
          __rewindStoredAtMsForTest("front", 5 * 60_000),
          "rewind seam should find the warmed front cache entry",
        );

        frontFetchHandler = async () => new Response("boom", { status: 500 });
        const preserved = await pollFrontUntil(
          baseUrl,
          (x) => x.lastProbeError !== null,
          "front.lastProbeError populated by preserve outcome",
        );
        assert.equal(
          preserved.connected,
          true,
          "preserve outcome must NOT flip connected:true → false",
        );
        assert.ok(
          preserved.lastProbeError && /500|http|probe/i.test(preserved.lastProbeError),
          `lastProbeError should describe the transient failure (got ${preserved.lastProbeError})`,
        );
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      for (const [key, snap] of [
        ["front_access_token", prior.access],
        ["front_refresh_token", prior.refresh],
        ["front_token_expires_at", prior.expires],
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
