/* test-registration
{
  "name": "Integrations all status slack fields (baseline triage, Task #3424)",
  "tier": "medium"
}
test-registration */
/**
 * Task #1889 — End-to-end coverage for the Integrations Hub Slack badge.
 *
 * Boots `GET /api/integrations/all-status` and asserts that the four
 * Slack fields added by Task #1876 actually reach the JSON payload, so
 * a future refactor of the response shape can't silently drop them and
 * break the Integrations Hub UI:
 *
 *   - `disconnectReason`        (terminal Slack auth code on unauthorized)
 *   - `breakerOpen`             (boolean — breaker cooldown active)
 *   - `cooldownRemainingMs`     (ms left on the breaker)
 *   - `lastProbeError`          (transient reason on a preserve outcome)
 *
 * Scenarios:
 *   1. `connected`     — `auth.test` returns ok:true. Badge connected,
 *                        disconnectReason null, breakerOpen false,
 *                        cooldownRemainingMs 0, lastProbeError null.
 *   2. `unauthorized`  — `auth.test` returns ok:false / invalid_auth.
 *                        Badge disconnected with `disconnectReason`
 *                        carrying the Slack code.
 *   3. `probe_failed`  — `auth.test` returns HTTP 500. Badge value stays
 *                        null on a cold cache (UI paints "Checking…").
 *   4. Warm-cache preserve — first warm with ok:true (connected), then
 *                        flip fetch to HTTP 500. The next refresh must
 *                        leave `slack.connected === true` while
 *                        populating `slack.lastProbeError`.
 *
 * The Slack probe itself is exercised end-to-end (no module-level
 * `probeConnection` stub — ESM exports are read-only). We drive the
 * outcomes by monkey-patching `global.fetch` for `slack.com/api/*`,
 * which is the same seam the Task #1876 unit suite uses.
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
import {
  __resetSlackAuthBreakerForTest,
} from "../server/services/slackIntegration";

const TAG = "task-1889";
const AM_ID = `${TAG}-am`;

type SlackPayload = {
  connected: boolean | null;
  team: string | null;
  disconnectReason: string | null;
  breakerOpen: boolean;
  cooldownRemainingMs: number;
  lastProbeError: string | null;
};

const originalFetch: typeof fetch = global.fetch;
let slackFetchHandler:
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
  if (url.includes("slack.com/api")) {
    if (slackFetchHandler) return slackFetchHandler(url, init);
    return new Response(JSON.stringify({ ok: true, team: "DefaultTeam" }), {
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
    VALUES (${AM_ID}, 'account_manager', ${"Task1889 AM"})
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

async function fetchSlack(baseUrl: string): Promise<SlackPayload> {
  const r = await fetch(`${baseUrl}/api/integrations/all-status`);
  if (r.status !== 200) {
    const text = await r.text();
    throw new Error(`all-status → ${r.status}: ${text.slice(0, 300)}`);
  }
  const body = await r.json();
  return body.slack as SlackPayload;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll the route until `pred(slack)` is true, or fail after `timeoutMs`. */
async function pollSlackUntil(
  baseUrl: string,
  pred: (s: SlackPayload) => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<SlackPayload> {
  const start = Date.now();
  let last: SlackPayload | null = null;
  while (Date.now() - start < timeoutMs) {
    last = await fetchSlack(baseUrl);
    if (pred(last)) return last;
    await wait(50);
  }
  throw new Error(
    `Timed out waiting for ${label}; last slack payload = ${JSON.stringify(last)}`,
  );
}

let passed = 0;
let failed = 0;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  __resetIntegrationStatusCacheForTest();
  __resetSlackAuthBreakerForTest();
  slackFetchHandler = null;
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
    __resetSlackAuthBreakerForTest();
    slackFetchHandler = null;
  }
}

async function main(): Promise<void> {
  console.log("Integrations Hub Slack badge fields end-to-end (Task #1889)");

  await ensureUser();
  const priorToken = await storage.getSystemSetting("slack_bot_token").catch(() => null);
  const restoreToken = priorToken ? priorToken.value ?? null : undefined;
  await storage.setSystemSetting("slack_bot_token", "xoxb-test-fake", "system");

  const { server, baseUrl } = await listen(buildApp());

  try {
    await step("connected outcome — all four fields present + null reasons", async () => {
      slackFetchHandler = async () =>
        jsonResponse({ ok: true, team: "Task1889Team" });
      const s = await pollSlackUntil(
        baseUrl,
        (x) => x.connected === true,
        "slack.connected === true",
      );
      assert.equal(s.connected, true);
      assert.equal(s.team, "Task1889Team");
      assert.equal(s.disconnectReason, null, "disconnectReason should be null when connected");
      assert.equal(s.breakerOpen, false, "breakerOpen should be false when connected");
      assert.equal(s.cooldownRemainingMs, 0, "cooldownRemainingMs should be 0 when connected");
      assert.equal(s.lastProbeError, null, "lastProbeError should be null on a fresh commit");
    });

    await step("unauthorized outcome — disconnectReason carries the Slack code", async () => {
      slackFetchHandler = async () =>
        jsonResponse({ ok: false, error: "invalid_auth" });
      const s = await pollSlackUntil(
        baseUrl,
        (x) => x.connected === false,
        "slack.connected === false (unauthorized commit)",
      );
      assert.equal(s.connected, false);
      assert.equal(
        s.disconnectReason,
        "invalid_auth",
        "disconnectReason must surface the terminal Slack auth code",
      );
      assert.equal(
        typeof s.breakerOpen,
        "boolean",
        "breakerOpen must reach the payload as a boolean (no silent drop)",
      );
      assert.equal(
        typeof s.cooldownRemainingMs,
        "number",
        "cooldownRemainingMs must reach the payload as a number (no silent drop)",
      );
      assert.ok(
        s.cooldownRemainingMs >= 0,
        `cooldownRemainingMs should be a non-negative number (got ${s.cooldownRemainingMs})`,
      );
      assert.equal(
        s.lastProbeError,
        null,
        "lastProbeError must be null on a committed unauthorized outcome",
      );
    });

    await step("probe_failed on cold cache — slack stays null (UI paints Checking…)", async () => {
      slackFetchHandler = async () => new Response("boom", { status: 500 });
      // Cold-cache + preserve writes nothing, so connected stays null
      // across multiple polls. Sample a few times to be sure.
      const samples: SlackPayload[] = [];
      for (let i = 0; i < 6; i++) {
        samples.push(await fetchSlack(baseUrl));
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
    });

    await step(
      "probe_failed on warm cache preserves connected:true + populates lastProbeError",
      async () => {
        // Warm phase: succeed once so the cache commits connected:true.
        slackFetchHandler = async () =>
          jsonResponse({ ok: true, team: "WarmTeam" });
        const warm = await pollSlackUntil(
          baseUrl,
          (x) => x.connected === true,
          "warm slack.connected === true",
        );
        assert.equal(warm.connected, true);
        assert.equal(warm.lastProbeError, null);

        // Walk the cached entry past its freshness window so the next
        // poll kicks a refresh, without discarding the warm value —
        // that's what lets us exercise the preserve branch end-to-end
        // instead of waiting out the 60-second fresh TTL.
        assert.ok(
          __rewindStoredAtMsForTest("slack", 5 * 60_000),
          "rewind seam should find the warmed slack cache entry",
        );

        slackFetchHandler = async () => new Response("boom", { status: 500 });
        const preserved = await pollSlackUntil(
          baseUrl,
          (x) => x.lastProbeError !== null,
          "slack.lastProbeError populated by preserve outcome",
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
      if (restoreToken === undefined) {
        await storage.deleteSystemSetting("slack_bot_token");
      } else {
        await storage.setSystemSetting("slack_bot_token", restoreToken ?? "", "system");
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
