/* test-registration
{
  "name": "Zoom proactive-expiry auth-gate gap (Task #2102)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.9s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2102 regression coverage for the Zoom proactive-expiry auth gap.
 *
 * Background: Task #1843 added the Zoom auth gate + refresh-and-retry on
 * the reactive 401 path (`tests/zoom-auth-recovery.test.ts` covers that).
 * But `getAccessToken()` has a SECOND refresh path — the *proactive*
 * expiry refresh that fires when the cached access token is within 300s of
 * expiry. Before Task #2102 that path called `refreshAccessToken()`
 * without engaging the gate, so when the stored refresh token was revoked
 * every Zoom surface (recording sync, review queue, validation) re-drove
 * the doomed refresh, flooding production logs.
 *
 * Per Zoom's OAuth docs the refresh exchange POSTs to
 * https://zoom.us/oauth/token; a revoked refresh token returns a 4xx
 * `invalid_grant`. Zoom reuses the existing Task #1843 gate (NOT a new
 * breaker module) so this suite locks:
 *   1. An OPEN gate short-circuits `getAccessToken()` immediately — no
 *      network refresh POST.
 *   2. A proactive-expiry refresh that fails TERMINALLY (invalid_grant)
 *      engages the gate + latches the self-heal terminal state.
 *   3. A proactive-expiry refresh that fails TRANSIENTLY (500) does NOT
 *      engage the gate (the next tick retries on its own cadence).
 *   4. A successful proactive-expiry refresh returns the fresh token and
 *      leaves the gate clear.
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

// Prime a token that is WITHIN the 300s proactive-expiry window so
// getAccessToken() takes the refresh branch (now >= expiresAt - 300).
async function primeExpiringTokens(accessValue = "expiring_access") {
  const nearExpiry = Math.floor(Date.now() / 1000) + 60; // 60s out → inside 300s window
  await storage.setSystemSetting(SETTINGS.ACCESS, accessValue, "test");
  await storage.setSystemSetting(SETTINGS.REFRESH, "primed_refresh", "test");
  await storage.setSystemSetting(SETTINGS.EXPIRES, String(nearExpiry), "test");
}

const originalFetch = globalThis.fetch;
const snap = await snapshotZoomSettings();

// Stop the live self-heal timer from firing — we only exercise the
// synchronous proactive-expiry refresh behavior in getAccessToken().
zoom.__disableZoomAuthSelfHealForTest(true);

try {
  // ── 1. Open gate short-circuits getAccessToken (no network) ──────────
  console.log("— 1. open gate → getAccessToken short-circuits without a refresh POST —");
  zoom.clearZoomPermanentFailure("test_reset");
  await primeExpiringTokens("expiring_access_1");
  // Engage the gate via a terminal refresh first, then assert a second
  // call does NOT hit the network.
  let tokenCalls1 = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes(".upstash.io")) return originalFetch(u as any, init);
    if (u === ZOOM_TOKEN_URL) {
      tokenCalls1++;
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  }) as any;
  let firstThrew = false;
  try {
    await zoom.getAccessToken();
  } catch {
    firstThrew = true;
  }
  ok("first proactive-expiry refresh threw (terminal)", firstThrew);
  ok("gate engaged after terminal proactive refresh", zoom.getZoomAuthGate() !== null);
  const callsAfterFirst = tokenCalls1;
  // Second call must short-circuit on the gate (no further token POST).
  let secondThrew = false;
  try {
    await zoom.getAccessToken();
  } catch {
    secondThrew = true;
  }
  ok("second getAccessToken short-circuited (threw on gate)", secondThrew);
  ok(
    "no additional token POST while gate open",
    tokenCalls1 === callsAfterFirst,
    `tokenCalls=${tokenCalls1}, expected ${callsAfterFirst}`,
  );

  // ── 2. Terminal proactive refresh engages gate + latches terminal ────
  console.log("\n— 2. proactive-expiry refresh invalid_grant → gate engaged + self-heal terminal —");
  zoom.clearZoomPermanentFailure("test_reset");
  await primeExpiringTokens("expiring_access_2");
  globalThis.fetch = (async (url: any, init: any) => {
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
  let threw2 = false;
  try {
    await zoom.getAccessToken();
  } catch {
    threw2 = true;
  }
  ok("getAccessToken threw on terminal proactive refresh", threw2);
  const gate2 = zoom.getZoomAuthGate();
  ok("auth gate IS engaged", gate2 !== null, `gate=${JSON.stringify(gate2)}`);
  ok(
    "gate reason mentions the OAuth error code",
    !!gate2 && /invalid_grant/i.test(gate2.reason),
    `reason=${gate2?.reason}`,
  );
  const selfHeal2 = zoom.getZoomAuthSelfHealState();
  ok(
    "self-heal latched terminal (oauthError invalid_grant)",
    selfHeal2.terminal !== null && selfHeal2.terminal.oauthError === "invalid_grant",
    `state=${JSON.stringify(selfHeal2)}`,
  );

  // ── 3. Transient proactive refresh does NOT engage the gate ──────────
  console.log("\n— 3. proactive-expiry refresh 500 → transient → gate stays clear —");
  zoom.clearZoomPermanentFailure("test_reset");
  await primeExpiringTokens("expiring_access_3");
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes(".upstash.io")) return originalFetch(u as any, init);
    if (u === ZOOM_TOKEN_URL) {
      return new Response("internal error", { status: 500 });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  }) as any;
  let threw3 = false;
  try {
    await zoom.getAccessToken();
  } catch {
    threw3 = true;
  }
  ok("getAccessToken threw on transient refresh", threw3);
  ok(
    "auth gate is NOT engaged after a transient refresh failure",
    zoom.getZoomAuthGate() === null,
    `gate=${JSON.stringify(zoom.getZoomAuthGate())}`,
  );

  // ── 4. Successful proactive refresh returns fresh token, no gate ─────
  console.log("\n— 4. proactive-expiry refresh succeeds → fresh token, gate clear —");
  zoom.clearZoomPermanentFailure("test_reset");
  await primeExpiringTokens("expiring_access_4");
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes(".upstash.io")) return originalFetch(u as any, init);
    if (u === ZOOM_TOKEN_URL) {
      return new Response(
        JSON.stringify({
          access_token: "fresh_proactive_access",
          refresh_token: "rotated_refresh",
          expires_in: 3600,
          scope: "user:read:user:admin",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${u}`);
  }) as any;
  const token4 = await zoom.getAccessToken();
  ok("getAccessToken returned the refreshed token", token4 === "fresh_proactive_access", `got ${token4}`);
  ok("auth gate is NULL after a successful proactive refresh", zoom.getZoomAuthGate() === null);
  ok(
    "rotated refresh_token persisted",
    (await storage.getSystemSetting(SETTINGS.REFRESH))?.value === "rotated_refresh",
  );
  // ── 5. Task #2267: a non-authoritative (zoom_probe) terminal refresh
  //       must NOT engage the gate or wipe tokens ──────────────────────
  console.log("\n— 5. proactive-expiry refresh invalid_grant on zoom_probe → gate stays clear (Task #2267) —");
  zoom.clearZoomPermanentFailure("test_reset");
  await primeExpiringTokens("expiring_access_5");
  let probeTokenCalls = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes(".upstash.io")) return originalFetch(u as any, init);
    if (u === ZOOM_TOKEN_URL) {
      probeTokenCalls++;
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  }) as any;
  // The badge probe / read-only health route tag their refresh `zoom_probe`.
  // Zoom rotates its refresh token on every refresh, so a probe that loses
  // the rotation race gets a terminal invalid_grant on an already-consumed
  // token. Engaging the gate from THAT would back off every healthy Zoom
  // surface on a transient blip. The probe must surface the failure to its
  // caller WITHOUT engaging the gate; a real surface still engages the gate
  // when IT hits the same wall (proven by section 2 above).
  let threw5 = false;
  try {
    await zoom.getAccessToken({ purpose: "zoom_probe" });
  } catch {
    threw5 = true;
  }
  ok("getAccessToken({zoom_probe}) still surfaced the terminal failure", threw5);
  ok("the probe still attempted the refresh", probeTokenCalls >= 1, `tokenCalls=${probeTokenCalls}`);
  ok(
    "auth gate is NOT engaged after a non-authoritative terminal refresh",
    zoom.getZoomAuthGate() === null,
    `gate=${JSON.stringify(zoom.getZoomAuthGate())}`,
  );
  ok(
    "stored refresh token preserved on a non-authoritative terminal",
    (await storage.getSystemSetting(SETTINGS.REFRESH))?.value === "primed_refresh",
  );
} finally {
  globalThis.fetch = originalFetch;
  await restoreZoomSettings(snap);
  zoom.clearZoomPermanentFailure("test");
  zoom.__disableZoomAuthSelfHealForTest(false);
}

console.log(`\n${passed} passed, ${failed} failed`);
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
process.exitCode = failed > 0 ? 1 : 0;
