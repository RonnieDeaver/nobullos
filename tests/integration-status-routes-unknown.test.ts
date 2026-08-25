/* test-registration
{
  "name": "Other dedicated integration status routes read-threw → status-unknown 503 (Front/Slack/Zoom/SEMrush/Stripe, Task #2811)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2811: the same read-threw ≠ not-connected contract for the OTHER dedicated status routes (Front / Slack / Zoom / SEMrush / Stripe). Their old catch-alls answered a hard `connected: false` / `configured: false` on ANY error, so a DB blip flashed \"Not Connected\" on healthy cards. Storage-singleton stubs — no live DB outage needed. Gate it so a catch-block \"simplification\" in any of the five routes can't silently reintroduce the false disconnect.",
  "tier": "small"
}
test-registration */
/**
 * Task #2811 — a THROWN settings/token read (DB blip / pool saturation)
 * in the OTHER dedicated integration status routes must surface as an
 * explicit status-unknown 503, never a hard "not connected / not
 * configured". Extends the Google Ads fix (Task #2807,
 * tests/google-ads-status-route-unknown.test.ts) to:
 *
 *   - GET /api/integrations/front/status   (old catch → { connected: false })
 *   - GET /api/integrations/slack/status   (old catch → { connected: false })
 *   - GET /api/integrations/zoom/status    (old catch → { connected: false, tokenValid: false })
 *   - GET /api/semrush/status              (old catch → { configured: false, connected: false })
 *   - GET /api/stripe/status               (isStripeConfiguredAsync folded "unknown" → configured: false)
 *
 * Contract (`.agents/memory/credential-detection-absent-vs-unknown.md`):
 *   1. read THREW → 503 { statusUnknown: true, probeFailed: true,
 *      connected/configured: null, reason } — never false.
 *   2. read SUCCEEDED with no credential (confirmed empty) → the normal
 *      200 not-connected shape — genuine disconnects must still render.
 *
 * Isolation: every route resolves its credential through the shared
 * `storage` singleton (`getSystemSetting` / `getSystemSettingFresh`), so
 * the blip is simulated by monkey-patching those methods to throw. No
 * live DB outage needed; no shared rows touched.
 */
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import * as undici from "undici";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { storage } from "../server/storage";
import { closeDbPools } from "../server/db";
import { registerCommunicationRoutes } from "../server/routes/communications";
import { registerHeatmapRoutes } from "../server/routes/heatmap";
import { registerBillingRoutes } from "../server/routes/billing";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { __resetStripeKeyCacheForTest } from "../server/stripeClient";
import { __resetIntegrationStatusCacheForTest } from "../server/services/integrationStatusCache";

const USER_ID = "status-2811-admin";

const s = storage as any;
const originalGetUser = s.getUser;
const originalGetSystemSetting = s.getSystemSetting;
const originalGetSystemSettingFresh = s.getSystemSettingFresh;

// The dev workspace may have a real STRIPE_SECRET_KEY env var — it would
// bypass the DB read entirely and make both branches unreachable.
const savedStripeEnv = process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_SECRET_KEY;

function installUserStub(): void {
  s.getUser = async (id: string) =>
    id === USER_ID
      ? {
          id: USER_ID,
          email: "status-2811@test.local",
          firstName: "Status",
          lastName: "Unknown",
          role: "ceo",
        }
      : undefined;
  // requireAuth resolves the local user via its direct ambient `db` import, not
  // storage.getUser — and USER_ID is never written to the DB. Pre-register the
  // profile so requireAuth uses it directly (no JIT provision / comms auto-join)
  // while requireRole keeps reading the stubbed storage.getUser above.
  __test_markUserReconciled(USER_ID, {
    id: USER_ID,
    email: "status-2811@test.local",
    firstName: "Status",
    lastName: "Unknown",
    role: "ceo",
  });
}

/** Every settings read THROWS — simulating a transient DB blip. */
function seedThrowingReads(): void {
  const boom = async () => {
    throw new Error("simulated transient DB read failure (pool saturation)");
  };
  s.getSystemSetting = boom;
  s.getSystemSettingFresh = boom;
  __resetStripeKeyCacheForTest();
  // Task #3824 — SEMrush's status route reads through the shared SWR
  // integration-status cache. Batched runner children execute several
  // suites in ONE process, so a sibling suite (or an earlier phase of
  // this one) can leave a stale `connected: true` entry in the module-
  // global memCache that this suite's stubbed reads never touch. Reset
  // per phase so each step derives status only from the stubs. (Redis
  // cold-hydration is separately bypassed under NODE_ENV=test in
  // integrationStatusCache.ts — the dev server's Hub-badge prewarm can
  // no longer poison a sweep either.)
  __resetIntegrationStatusCacheForTest();
}

/** Every settings read succeeds with no row — confirmed empty. */
function seedConfirmedEmptyReads(): void {
  s.getSystemSetting = async () => undefined;
  s.getSystemSettingFresh = async () => undefined;
  __resetStripeKeyCacheForTest();
  __resetIntegrationStatusCacheForTest(); // see seedThrowingReads
}

function restoreStubs(): void {
  s.getUser = originalGetUser;
  s.getSystemSetting = originalGetSystemSetting;
  s.getSystemSettingFresh = originalGetSystemSettingFresh;
  __resetStripeKeyCacheForTest();
  __resetIntegrationStatusCacheForTest(); // don't leak our stub-derived entries to batch siblings
  __test_resetReconciledUsers();
  if (savedStripeEnv !== undefined) process.env.STRIPE_SECRET_KEY = savedStripeEnv;
}

async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk per-request test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated. The
    // pre-Clerk passport-shape injection stopped working when auth migrated.
    req.__test_clerkUserId = USER_ID;
    next();
  });
  registerCommunicationRoutes(app);
  registerHeatmapRoutes(app);
  registerBillingRoutes(app);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function get(baseUrl: string, path: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}${path}`);
  let json: any = null;
  try {
    json = await r.json();
  } catch {
    // non-JSON body — assertions below will fail loudly on json shape
  }
  return { status: r.status, json };
}

const ROUTES: Array<{ label: string; path: string; connectedField: "connected" | "configured" }> = [
  { label: "Front", path: "/api/integrations/front/status", connectedField: "connected" },
  { label: "Slack", path: "/api/integrations/slack/status", connectedField: "connected" },
  { label: "Zoom", path: "/api/integrations/zoom/status", connectedField: "connected" },
  { label: "SEMrush", path: "/api/semrush/status", connectedField: "connected" },
  { label: "Stripe", path: "/api/stripe/status", connectedField: "configured" },
];

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  }
}

async function main(): Promise<void> {
  console.log("Dedicated integration status routes — read-threw ≠ not connected (Task #2811)");

  installUserStub();
  try {
    await withApp(async (baseUrl) => {
      seedThrowingReads();
      for (const route of ROUTES) {
        await step(
          `${route.label}: thrown read → 503 status-unknown, ${route.connectedField} is null — never false`,
          async () => {
            const { status, json } = await get(baseUrl, route.path);
            assert.equal(status, 503, `expected 503, got ${status}: ${JSON.stringify(json)}`);
            assert.equal(json?.statusUnknown, true, "must be an explicit status-unknown shape");
            assert.equal(json?.probeFailed, true);
            assert.notEqual(
              json?.[route.connectedField],
              false,
              `${route.connectedField} must never be committed false off a thrown read`,
            );
            assert.equal(
              json?.[route.connectedField],
              null,
              `${route.connectedField} is UNKNOWN (null)`,
            );
            assert.match(
              String(json?.reason),
              /simulated transient DB read failure/,
              "reason must carry the underlying read error for operator debugging",
            );
          },
        );
      }

      seedConfirmedEmptyReads();
      for (const route of ROUTES) {
        await step(
          `${route.label}: confirmed-empty read → normal 200 not-connected — genuine disconnects still render`,
          async () => {
            const { status, json } = await get(baseUrl, route.path);
            assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
            assert.equal(json?.[route.connectedField], false);
            assert.equal(json?.statusUnknown, undefined, "confirmed empty is NOT status-unknown");
          },
        );
      }
    });
  } finally {
    restoreStubs();
  }

  if (failures > 0) {
    console.error(`\n${failures} step(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\nAll steps passed");
  }

  // Route tests that fetch a local server hang on exit unless undici's
  // keep-alive sockets are closed (see add-stale-location-route.test.ts).
  await undici.getGlobalDispatcher().close();
  await closeDbPools();
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
  try {
    restoreStubs();
    await undici.getGlobalDispatcher().close();
    await closeDbPools();
  } catch {}
});
