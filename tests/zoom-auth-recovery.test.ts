/* test-registration
{
  "name": "Zoom auth-gate 401 refresh-and-retry recovery (Task #1843)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.8s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1843: Zoom auth-gate auto-recovery from stale 401s.
 *
 * The Zoom auth gate must NOT trip on the first 401 a Zoom API call sees.
 * Instead the API client should force a token refresh and retry the call
 * once; the gate is only engaged when:
 *   - the retried call also returns auth-failure, or
 *   - the refresh itself returns a terminal OAuth error
 *     (`invalid_grant`, `invalid_request`, `unauthorized_client`, etc.).
 *
 * Transient refresh failures (5xx, network blip, 429-after-retries) must
 * propagate without engaging the gate so the next call can try again.
 *
 * This test drives the full runtime path with mocked fetch and asserts
 * the behavioral contract above. It also covers `classifyZoomRefreshError`
 * directly to pin the terminal-vs-transient verdicts.
 */

process.env.ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID || "test_client_id";
process.env.ZOOM_CLIENT_SECRET =
  process.env.ZOOM_CLIENT_SECRET || "test_client_secret";
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
const ZOOM_API_BASE = "https://api.zoom.us/v2";

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

async function primeValidTokens(accessValue = "primed_access") {
  const farFutureExpiry = Math.floor(Date.now() / 1000) + 3600;
  await storage.setSystemSetting(SETTINGS.ACCESS, accessValue, "test");
  await storage.setSystemSetting(SETTINGS.REFRESH, "primed_refresh", "test");
  await storage.setSystemSetting(
    SETTINGS.EXPIRES,
    String(farFutureExpiry),
    "test",
  );
}

const originalFetch = globalThis.fetch;
const snap = await snapshotZoomSettings();

// Stop the live self-heal timer from firing during the test — we only
// exercise the synchronous classification + refresh-and-retry behavior.
zoom.__disableZoomAuthSelfHealForTest(true);

try {
  // ── 1. Static — classifyZoomRefreshError verdicts ──────────────────────
  console.log("— 1. classifyZoomRefreshError — terminal vs transient —");
  const c1 = zoom.classifyZoomRefreshError(400, '{"error":"invalid_grant"}');
  ok("invalid_grant → terminal", c1.terminal === true);
  ok("invalid_grant → oauthError captured", c1.oauthError === "invalid_grant");
  ok(
    "invalid_request → terminal",
    zoom.classifyZoomRefreshError(400, '{"error":"invalid_request"}').terminal === true,
  );
  ok(
    "unauthorized_client → terminal",
    zoom.classifyZoomRefreshError(401, '{"error":"unauthorized_client"}').terminal === true,
  );
  ok(
    '"Invalid Token!" body → terminal',
    zoom.classifyZoomRefreshError(401, '{"reason":"Invalid Token!"}').terminal === true,
  );
  ok(
    "500 → transient (server hiccup)",
    zoom.classifyZoomRefreshError(500, "internal error").terminal === false,
  );
  ok(
    "503 → transient (server hiccup)",
    zoom.classifyZoomRefreshError(503, "<html>503</html>").terminal === false,
  );

  // ── 2. Runtime — 401 then successful refresh + retry should NOT engage gate
  console.log(
    "\n— 2. 401 → forced refresh succeeds → retry succeeds → no auth gate —",
  );
  zoom.clearZoomPermanentFailure("test_reset");
  await primeValidTokens("stale_access_token_2");

  let usersMeCalls = 0;
  let tokenCalls = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes(".upstash.io")) return originalFetch(u as any, init);
    if (u === ZOOM_TOKEN_URL) {
      tokenCalls++;
      return new Response(
        JSON.stringify({
          access_token: "fresh_access_after_refresh",
          refresh_token: "rotated_refresh_token",
          expires_in: 3600,
          scope: "meeting:read:meeting:admin user:read:user:admin",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.startsWith(ZOOM_API_BASE + "/users/me")) {
      usersMeCalls++;
      // First call: stale token → 401. Second call (after refresh): 200.
      const auth = init?.headers?.["Authorization"] || init?.headers?.authorization;
      if (auth === "Bearer fresh_access_after_refresh") {
        return new Response(JSON.stringify({ id: "me" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ code: 124, message: "Invalid access token." }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${u}`);
  }) as any;

  const validation = await zoom.validateConnection();
  ok("validateConnection succeeded after refresh-and-retry", validation.valid === true);
  ok(
    "GET /users/me was called twice (initial + retry)",
    usersMeCalls === 2,
    `usersMeCalls=${usersMeCalls}`,
  );
  ok(
    "POST /oauth/token was called once (forced refresh)",
    tokenCalls === 1,
    `tokenCalls=${tokenCalls}`,
  );
  ok(
    "auth gate is NOT engaged after a recovered 401",
    zoom.getZoomAuthGate() === null,
    `gate=${JSON.stringify(zoom.getZoomAuthGate())}`,
  );
  ok(
    "rotated refresh_token was persisted (not the old value)",
    (await storage.getSystemSetting(SETTINGS.REFRESH))?.value === "rotated_refresh_token",
  );

  // ── 3. Runtime — 401 with terminal refresh error MUST engage the gate ─
  //
  // Task #2267 / #2285: only an AUTHORITATIVE, on-demand attempt (a real
  // Zoom operation with the default/unset refresh purpose) may commit the
  // durable disconnect. `validateConnection` deliberately tags its calls
  // `zoom_probe` (non-authoritative) so a rotation-race blip on a background
  // health check no longer trips the global gate — see
  // scripts/lint-probe-refresh-purpose.ts. To exercise the gate-engaging
  // path we drive an authoritative surface (`listAllAccountUsers`, which
  // issues `zoomApiRequest` with no purpose). Probe-safety of the same
  // failure is covered separately by section 6 below.
  console.log(
    "\n— 3. 401 → refresh returns invalid_grant → gate engaged + self-heal terminal —",
  );
  zoom.clearZoomPermanentFailure("test_reset");
  await primeValidTokens("stale_access_token_3");

  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes(".upstash.io")) return originalFetch(u as any, init);
    if (u === ZOOM_TOKEN_URL) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.startsWith(ZOOM_API_BASE + "/users")) {
      return new Response(
        JSON.stringify({ code: 124, message: "Invalid access token." }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${u}`);
  }) as any;

  let authoritativeThrew3 = false;
  try {
    await zoom.listAllAccountUsers();
  } catch {
    authoritativeThrew3 = true;
  }
  ok(
    "authoritative Zoom call throws when refresh is terminal",
    authoritativeThrew3,
  );
  const gate3 = zoom.getZoomAuthGate();
  ok(
    "auth gate IS engaged after terminal refresh failure",
    gate3 !== null,
    `gate=${JSON.stringify(gate3)}`,
  );
  ok(
    "auth gate reason mentions the OAuth error code",
    !!gate3 && /invalid_grant/i.test(gate3.reason),
    `reason=${gate3?.reason}`,
  );
  const selfHeal3 = zoom.getZoomAuthSelfHealState();
  ok(
    "self-heal latched terminal — will NOT keep retrying refresh",
    selfHeal3.terminal !== null && selfHeal3.terminal.oauthError === "invalid_grant",
    `state=${JSON.stringify(selfHeal3)}`,
  );

  // ── 4. Runtime — operator reconnect clears the terminal latch ─────────
  console.log(
    "\n— 4. exchangeCodeForToken clears auth gate AND terminal self-heal latch —",
  );
  let codeExchangeCalls = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes(".upstash.io")) return originalFetch(u as any, init);
    if (u === ZOOM_TOKEN_URL) {
      codeExchangeCalls++;
      return new Response(
        JSON.stringify({
          access_token: "reconnect_access",
          refresh_token: "reconnect_refresh",
          expires_in: 3600,
          scope: "user:read:user:admin",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${u}`);
  }) as any;
  await zoom.exchangeCodeForToken("fake_code", "system");
  ok("token endpoint called once for code exchange", codeExchangeCalls === 1);
  ok(
    "auth gate is NULL after operator reconnect",
    zoom.getZoomAuthGate() === null,
  );
  const selfHeal4 = zoom.getZoomAuthSelfHealState();
  ok(
    "self-heal terminal latch CLEARED by reconnect",
    selfHeal4.terminal === null,
    `state=${JSON.stringify(selfHeal4)}`,
  );

  // ── 5. Runtime — 401 then retried call ALSO 401 → gate engaged ────────
  //
  // As in section 3, we drive an AUTHORITATIVE surface so the "retried call
  // still 401s" path is allowed to commit the disconnect (a `zoom_probe`
  // would surface `unauthorized` without engaging the gate — covered by
  // section 6).
  console.log(
    "\n— 5. 401 → refresh-OK → retried call still 401 → gate engaged —",
  );
  zoom.clearZoomPermanentFailure("test_reset");
  await primeValidTokens("stale_access_token_5");

  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes(".upstash.io")) return originalFetch(u as any, init);
    if (u === ZOOM_TOKEN_URL) {
      return new Response(
        JSON.stringify({
          access_token: "fresh_but_still_rejected",
          refresh_token: "rotated_again",
          expires_in: 3600,
          scope: "user:read:user:admin",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.startsWith(ZOOM_API_BASE + "/users")) {
      // Every users call returns 401 even with the fresh token.
      return new Response(
        JSON.stringify({ code: 124, message: "Invalid access token." }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${u}`);
  }) as any;

  let authoritativeThrew5 = false;
  try {
    await zoom.listAllAccountUsers();
  } catch {
    authoritativeThrew5 = true;
  }
  ok(
    "authoritative Zoom call throws when the retried call also 401s",
    authoritativeThrew5,
  );
  const gate5 = zoom.getZoomAuthGate();
  ok(
    "auth gate IS engaged after second 401 on an authoritative surface",
    gate5 !== null,
    `gate=${JSON.stringify(gate5)}`,
  );

  // ── 6. Runtime — probe-tagged calls NEVER engage the gate ─────────────
  //
  // Task #2267 / #2285: `validateConnection` tags every call `zoom_probe`.
  // Even a full 401 storm (refresh succeeds, retried call still 401s, on
  // both the /users/me primary and the /users fallback) must surface
  // `valid: false` WITHOUT engaging the global auth gate — a background
  // health check can never back off every healthy Zoom surface.
  console.log(
    "\n— 6. probe 401 storm → validateConnection invalid, gate stays open —",
  );
  zoom.clearZoomPermanentFailure("test_reset");
  await primeValidTokens("stale_access_token_6");

  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes(".upstash.io")) return originalFetch(u as any, init);
    if (u === ZOOM_TOKEN_URL) {
      return new Response(
        JSON.stringify({
          access_token: "probe_fresh_token",
          refresh_token: "probe_rotated_refresh",
          expires_in: 3600,
          scope: "user:read:user:admin",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.startsWith(ZOOM_API_BASE + "/users")) {
      return new Response(
        JSON.stringify({ code: 124, message: "Invalid access token." }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${u}`);
  }) as any;

  const validation6 = await zoom.validateConnection();
  ok(
    "validateConnection reports invalid when probe retry also fails",
    validation6.valid === false,
    `got ${JSON.stringify(validation6)}`,
  );
  ok(
    "auth gate is NOT engaged by a non-authoritative probe 401 storm",
    zoom.getZoomAuthGate() === null,
    `gate=${JSON.stringify(zoom.getZoomAuthGate())}`,
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
