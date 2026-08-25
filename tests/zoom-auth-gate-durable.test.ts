/* test-registration
{
  "name": "Zoom durable auth-gate persistence (Task #2122)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2122 regression coverage for the DURABLE Zoom auth-gate signal
 * (`server/services/zoomIntegration.ts`). Mirrors the Front auth-breaker
 * durable-persistence coverage (Task #2103,
 * `tests/front-auth-breaker.test.ts` Group 7) adapted for the Zoom gate's
 * sticky shape (no cooldown expiry; cleared only by a refresh / reconnect).
 *
 * Background: Task #1843 added the in-memory `zoomAuthGate` + self-heal
 * loop, but the gate was per-process and reset on restart, so on autoscale
 * the fail-fast suppression could silently lift after a deploy / restart
 * (until the next dead refresh re-engaged it) and be inconsistent across
 * instances. Task #2122 mirrors the gate into a single `system_settings`
 * row so it survives restarts and converges across instances.
 *
 * Locks:
 *   1. Engaging the gate (terminal proactive-expiry refresh) persists the
 *      durable signal — including the self-heal terminal latch.
 *   2. `clearZoomPermanentFailure` clears the durable signal.
 *   3. `hydrateZoomAuthGateFromStore` re-engages the gate in a fresh
 *      process from the durable signal (and restores the terminal latch so
 *      self-heal stays parked).
 *   4. `reconcileZoomAuthGateFromStore` clears the local gate when another
 *      instance cleared the store (past the persist grace window).
 *   5. Reconcile keeps a brand-new local gate whose persist may still be in
 *      flight (the persist grace window).
 *
 * `global.fetch` is monkey-patched so the suite never hits real Zoom.
 */
process.env.ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID || "test_client_id";
process.env.ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET || "test_client_secret";
process.env.ZOOM_REDIRECT_URI =
  process.env.ZOOM_REDIRECT_URI || "https://test.example.com/api/zoom/callback";

const { storage } = await import("../server/storage");
const zoom = await import("../server/services/zoomIntegration");

const SETTINGS = {
  ACCESS: "zoom_access_token",
  REFRESH: "zoom_refresh_token",
  EXPIRES: "zoom_token_expires_at",
  GRANTED: "zoom_granted_scopes",
} as const;

const GATE_STATE_KEY = "zoom_auth_gate_state";
const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";

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

// The gate persists fire-and-forget; poll the store until the predicate
// holds (or time out). Polling — rather than a fixed delay — keeps the
// suite deterministic when the shared dev DB is under load from other
// concurrently-running suites.
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 3000,
): Promise<boolean> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await predicate()) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function snapshotZoomSettings() {
  return {
    access: (await storage.getSystemSetting(SETTINGS.ACCESS))?.value ?? null,
    refresh: (await storage.getSystemSetting(SETTINGS.REFRESH))?.value ?? null,
    expires: (await storage.getSystemSetting(SETTINGS.EXPIRES))?.value ?? null,
    granted: (await storage.getSystemSetting(SETTINGS.GRANTED))?.value ?? null,
  };
}
async function restoreZoomSettings(
  snap: Awaited<ReturnType<typeof snapshotZoomSettings>>,
) {
  await storage.setSystemSetting(SETTINGS.ACCESS, snap.access ?? "", "test");
  await storage.setSystemSetting(SETTINGS.REFRESH, snap.refresh ?? "", "test");
  await storage.setSystemSetting(SETTINGS.EXPIRES, snap.expires ?? "", "test");
  await storage.setSystemSetting(SETTINGS.GRANTED, snap.granted ?? "", "test");
}

// Prime a token WITHIN the 300s proactive-expiry window so getAccessToken()
// takes the refresh branch.
async function primeExpiringTokens(accessValue = "expiring_access") {
  const nearExpiry = Math.floor(Date.now() / 1000) + 60; // inside 300s window
  await storage.setSystemSetting(SETTINGS.ACCESS, accessValue, "test");
  await storage.setSystemSetting(SETTINGS.REFRESH, "primed_refresh", "test");
  await storage.setSystemSetting(SETTINGS.EXPIRES, String(nearExpiry), "test");
}

const terminalRefreshFetch = (originalFetch: typeof fetch) =>
  (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes(".upstash.io")) return originalFetch(u as any, init);
    if (u === ZOOM_TOKEN_URL) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  }) as any;

const originalFetch = globalThis.fetch;
const snap = await snapshotZoomSettings();

// Stop the live self-heal timer from firing — we only exercise the
// synchronous gate persistence behavior here.
zoom.__disableZoomAuthSelfHealForTest(true);

try {
  // ── 1. Engaging the gate persists the durable signal ─────────────────
  console.log("— 1. terminal refresh engages gate → durable signal persisted —");
  zoom.clearZoomPermanentFailure("test_reset");
  await zoom.__clearPersistedZoomAuthGateForTest();
  await primeExpiringTokens("expiring_access_1");
  globalThis.fetch = terminalRefreshFetch(originalFetch);
  try {
    await zoom.getAccessToken();
  } catch {
    /* expected: terminal refresh throws */
  }
  ok("gate engaged after terminal refresh", zoom.getZoomAuthGate() !== null);
  // Wait until the fire-and-forget persist lands so a later clear cannot be
  // reordered ahead of it.
  await waitFor(async () => !!(await zoom.__readPersistedZoomAuthGateForTest()));
  const raw1 = await zoom.__readPersistedZoomAuthGateForTest();
  ok("durable signal persisted on engage", !!raw1, `raw=${JSON.stringify(raw1)}`);
  let parsed1: any = null;
  try {
    parsed1 = raw1 ? JSON.parse(raw1) : null;
  } catch {
    /* malformed */
  }
  ok(
    "persisted reason carries the OAuth error code",
    !!parsed1 && /invalid_grant/i.test(String(parsed1.reason)),
    `parsed=${JSON.stringify(parsed1)}`,
  );
  ok(
    "persisted payload latches the terminal self-heal state",
    !!parsed1 && parsed1.terminal && parsed1.terminal.oauthError === "invalid_grant",
    `terminal=${JSON.stringify(parsed1?.terminal)}`,
  );

  // ── 2. clearZoomPermanentFailure clears the durable signal ───────────
  console.log("\n— 2. clearZoomPermanentFailure → durable signal cleared —");
  zoom.clearZoomPermanentFailure("test_reset");
  const cleared = await waitFor(
    async () => !(await zoom.__readPersistedZoomAuthGateForTest()),
  );
  const raw2 = await zoom.__readPersistedZoomAuthGateForTest();
  ok("durable signal cleared on clear", cleared && !raw2, `raw=${JSON.stringify(raw2)}`);

  // ── 3. hydrate re-engages the gate in a fresh process ────────────────
  console.log("\n— 3. hydrate re-engages the gate (+ terminal latch) from the store —");
  zoom.clearZoomPermanentFailure("test_reset");
  await zoom.__clearPersistedZoomAuthGateForTest();
  // Seed the store directly (simulating instance A's persisted gate) while
  // this process's in-memory gate is null (simulating a fresh restart).
  await storage.setSystemSetting(
    GATE_STATE_KEY,
    JSON.stringify({
      status: 401,
      reason: 'auth invalid_grant: {"error":"invalid_grant"}',
      since: Date.now(),
      terminal: { oauthError: "invalid_grant", body: '{"error":"invalid_grant"}' },
    }),
    "test",
  );
  ok("in-memory gate is null before hydrate (simulated restart)", zoom.getZoomAuthGate() === null);
  const { gateOpen } = await zoom.hydrateZoomAuthGateFromStore();
  ok("hydrate reports gateOpen", gateOpen === true);
  ok("in-memory gate engaged after hydrate", zoom.getZoomAuthGate() !== null);
  ok(
    "hydrated gate reason preserved",
    !!zoom.getZoomAuthGate() && /invalid_grant/i.test(zoom.getZoomAuthGate()!.reason),
    `reason=${zoom.getZoomAuthGate()?.reason}`,
  );
  ok(
    "hydrate restored the terminal latch (self-heal stays parked)",
    zoom.getZoomAuthSelfHealState().terminal?.oauthError === "invalid_grant",
    `state=${JSON.stringify(zoom.getZoomAuthSelfHealState())}`,
  );

  // ── 4. reconcile clears local gate when the store was cleared elsewhere
  console.log("\n— 4. reconcile clears local gate when another instance cleared the store —");
  // Gate is currently engaged (from step 3). Clear the store directly to
  // simulate a reconnect on another instance, age the local set marker past
  // the grace window, then reconcile.
  await storage.setSystemSetting(GATE_STATE_KEY, "", "test");
  zoom.__setZoomAuthGateLocalSetAtForTest(Date.now() - 60_000);
  await zoom.reconcileZoomAuthGateFromStore();
  ok("local gate cleared by reconcile", zoom.getZoomAuthGate() === null);

  // ── 5. reconcile keeps a brand-new local gate (persist grace) ────────
  console.log("\n— 5. reconcile keeps a fresh local gate (persist grace) —");
  zoom.clearZoomPermanentFailure("test_reset");
  await zoom.__clearPersistedZoomAuthGateForTest();
  await primeExpiringTokens("expiring_access_5");
  globalThis.fetch = terminalRefreshFetch(originalFetch);
  try {
    await zoom.getAccessToken();
  } catch {
    /* expected */
  }
  ok("gate engaged locally", zoom.getZoomAuthGate() !== null);
  // Simulate the store read racing ahead of our own persist write.
  await storage.setSystemSetting(GATE_STATE_KEY, "", "test");
  await zoom.reconcileZoomAuthGateFromStore();
  ok(
    "fresh local gate survives a stale store read (grace window)",
    zoom.getZoomAuthGate() !== null,
  );
} finally {
  globalThis.fetch = originalFetch;
  await restoreZoomSettings(snap);
  await zoom.__clearPersistedZoomAuthGateForTest();
  zoom.clearZoomPermanentFailure("test");
  zoom.__disableZoomAuthSelfHealForTest(false);
}

console.log(`\n${passed} passed, ${failed} failed`);
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
process.exitCode = failed > 0 ? 1 : 0;
