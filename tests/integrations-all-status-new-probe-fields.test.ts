/* test-registration
{
  "name": "Integrations Hub new probe fields \u2014 PandaDoc commit/preserve (Task #1900)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.9s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1900 — End-to-end coverage for the Task #1888 probe contract
 * on `GET /api/integrations/all-status` for the Zoom / PandaDoc /
 * Stripe / Google Ads cards (Google Drive retired by Task #4084).
 *
 * Mirrors `integrations-all-status-slack-fields.test.ts` but exercises
 * one of the Task #1888 integrations (PandaDoc — cleanest `fetch`-based
 * seam) to assert two route-level invariants for every new probe:
 *
 *   1. `unauthorized` outcome COMMITS `disconnectReason` (the route
 *      pins the badge with the persistent reason).
 *   2. `probe_failed` outcome PRESERVES the previously-committed
 *      `connected` value and SURFACES the transient reason via
 *      `lastProbeError` (no silent flip to Not-Connected on a 5xx
 *      blip).
 *
 * Both invariants are duplicated across all five new cards via the
 * shared `getCachedIntegrationStatus` loader pattern in
 * `server/routes/integrations.ts`. Covering one card end-to-end is
 * sufficient — the per-integration outcome classification is pinned
 * by `tests/new-integration-probes-classification.test.ts`.
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

const TAG = "task-1900";
const AM_ID = `${TAG}-am`;

type PandadocPayload = {
  connected: boolean | null;
  lastCheckedAt: string | null;
  disconnectReason: string | null;
  lastProbeError: string | null;
};

const originalFetch: typeof fetch = global.fetch;
let pandadocFetchHandler:
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
  if (url.includes("api.pandadoc.com")) {
    if (pandadocFetchHandler) return pandadocFetchHandler(url, init);
    return new Response(JSON.stringify({ results: [] }), {
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
    VALUES (${AM_ID}, 'account_manager', ${"Task1900 AM"})
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

async function fetchPandadoc(baseUrl: string): Promise<PandadocPayload> {
  const r = await fetch(`${baseUrl}/api/integrations/all-status`);
  if (r.status !== 200) {
    const text = await r.text();
    throw new Error(`all-status → ${r.status}: ${text.slice(0, 300)}`);
  }
  const body = await r.json();
  return body.pandadoc as PandadocPayload;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollPandadocUntil(
  baseUrl: string,
  pred: (p: PandadocPayload) => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<PandadocPayload> {
  const start = Date.now();
  let last: PandadocPayload | null = null;
  while (Date.now() - start < timeoutMs) {
    last = await fetchPandadoc(baseUrl);
    if (pred(last)) return last;
    await wait(50);
  }
  throw new Error(
    `Timed out waiting for ${label}; last pandadoc payload = ${JSON.stringify(last)}`,
  );
}

let passed = 0;
let failed = 0;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  __resetIntegrationStatusCacheForTest();
  pandadocFetchHandler = null;
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
    pandadocFetchHandler = null;
  }
}

async function main(): Promise<void> {
  console.log("Integrations Hub new-probe fields end-to-end (Task #1900)");

  await ensureUser();
  const priorKey = await storage.getSystemSetting("pandadoc_api_key").catch(() => null);
  const restoreKey = priorKey ? (priorKey.value ?? null) : undefined;
  await storage.setSystemSetting("pandadoc_api_key", "pd-fake-task-1900", "system");

  const { server, baseUrl } = await listen(buildApp());

  try {
    await step(
      "unauthorized outcome COMMITS disconnectReason (badge pinned with reason)",
      async () => {
        pandadocFetchHandler = async () => new Response("forbidden", { status: 403 });
        const p = await pollPandadocUntil(
          baseUrl,
          (x) => x.connected === false,
          "pandadoc.connected === false (unauthorized commit)",
        );
        assert.equal(p.connected, false, "unauthorized must commit connected:false");
        assert.equal(
          p.disconnectReason,
          "http_403",
          `disconnectReason must surface the persistent probe reason (got ${p.disconnectReason})`,
        );
        assert.equal(
          p.lastProbeError,
          null,
          "lastProbeError must be null on a committed unauthorized outcome — preserve is only for transient errors",
        );
      },
    );

    await step(
      "probe_failed on warm cache PRESERVES connected + SURFACES lastProbeError",
      async () => {
        // Warm phase: succeed once so the cache commits connected:true.
        pandadocFetchHandler = async () => jsonResponse({ results: [] }, 200);
        const warm = await pollPandadocUntil(
          baseUrl,
          (x) => x.connected === true,
          "warm pandadoc.connected === true",
        );
        assert.equal(warm.connected, true);
        assert.equal(warm.lastProbeError, null);
        assert.equal(warm.disconnectReason, null);

        // Walk the warm entry past its freshness window so the next
        // poll kicks a refresh, without discarding the warm value —
        // exercises the preserve branch end-to-end.
        assert.ok(
          __rewindStoredAtMsForTest("pandadoc", 5 * 60_000),
          "rewind seam should find the warmed pandadoc cache entry",
        );

        pandadocFetchHandler = async () => new Response("boom", { status: 503 });
        const preserved = await pollPandadocUntil(
          baseUrl,
          (x) => x.lastProbeError !== null,
          "pandadoc.lastProbeError populated by preserve outcome",
        );
        assert.equal(
          preserved.connected,
          true,
          "preserve outcome must NOT flip connected:true → false on a transient 5xx",
        );
        assert.equal(
          preserved.disconnectReason,
          null,
          "disconnectReason must NOT be set by a preserve outcome",
        );
        assert.ok(
          preserved.lastProbeError && /503|http|probe/i.test(preserved.lastProbeError),
          `lastProbeError should describe the transient failure (got ${preserved.lastProbeError})`,
        );
      },
    );

    await step(
      "probe_failed on cold cache leaves connected null (UI paints Checking…)",
      async () => {
        pandadocFetchHandler = async () => new Response("boom", { status: 503 });
        const samples: PandadocPayload[] = [];
        for (let i = 0; i < 6; i++) {
          samples.push(await fetchPandadoc(baseUrl));
          await wait(75);
        }
        for (const s of samples) {
          assert.equal(
            s.connected,
            null,
            `cold-cache probe_failed must leave connected null (got ${s.connected})`,
          );
          assert.equal(
            s.disconnectReason,
            null,
            "disconnectReason must stay null when nothing has committed",
          );
        }
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      if (restoreKey === undefined) {
        await storage.deleteSystemSetting("pandadoc_api_key");
      } else {
        await storage.setSystemSetting("pandadoc_api_key", restoreKey ?? "", "system");
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
