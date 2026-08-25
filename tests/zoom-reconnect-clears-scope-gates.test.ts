/* test-registration
{
  "name": "Zoom reconnect clears scope gates (Task #1615)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "scanPaths": [
    "server/services/zoomIntegration.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #1615: Zoom OAuth reconnect must clear in-memory scope/auth gates.
 *
 * The Integrations Hub renders a "Missing Zoom scopes for: <endpoint>" banner
 * whenever `getZoomScopeGates()` is non-empty. That gate is set by
 * `zoomApiRequest` when Zoom returns a scope-rejection (e.g. 400 with body
 * "does not contain scopes:[...]"). When an operator reconnects Zoom with the
 * missing scope granted, the banner must clear immediately rather than wait
 * for the next access-token refresh (~1h) or a server restart.
 *
 * The reconnect path today is:
 *   exchangeCodeForToken
 *     → storeTokens
 *       → clearZoomValidationBreaker
 *         → clearZoomPermanentFailure("token_refreshed")
 *           → zoomAuthGate = null; zoomScopeGates.clear()
 *
 * This test drives the full runtime path (mocked fetch + real storage) and
 * asserts that BOTH gates are empty after `exchangeCodeForToken` resolves,
 * even when a scope gate was primed beforehand.
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

const originalFetch = globalThis.fetch;
const snap = await snapshotZoomSettings();

try {
  // ── 1. Static guard — exchangeCodeForToken must continue to await storeTokens.
  console.log("— 1. Static — exchangeCodeForToken awaits storeTokens —");
  const fs = await import("fs/promises");
  const src = await fs.readFile("server/services/zoomIntegration.ts", "utf8");
  const exchangeMatch = src.match(
    /export async function exchangeCodeForToken[\s\S]*?\n\}\n/,
  );
  ok("located exchangeCodeForToken in source", !!exchangeMatch);
  ok(
    "exchangeCodeForToken awaits storeTokens(...)",
    /await\s+storeTokens\s*\(/.test(exchangeMatch?.[0] ?? ""),
  );
  ok(
    "storeTokens still calls clearZoomValidationBreaker() at end of function",
    /clearZoomValidationBreaker\(\);\s*\n\}/.test(src),
  );
  ok(
    "clearZoomValidationBreaker still calls clearZoomPermanentFailure(...)",
    /export function clearZoomValidationBreaker[\s\S]*?clearZoomPermanentFailure\(/.test(
      src,
    ),
  );

  // ── 2. Runtime — clearZoomPermanentFailure empties both gates synchronously.
  console.log(
    "\n— 2. Runtime — clearZoomPermanentFailure empties auth + scope gates —",
  );
  zoom.clearZoomPermanentFailure("test");
  ok("auth gate is null on clean baseline", zoom.getZoomAuthGate() === null);
  ok(
    "scope gates list is empty on clean baseline",
    zoom.getZoomScopeGates().length === 0,
  );

  // ── 3. Runtime — drive validateConnection through a mocked fetch that
  // returns a scope rejection, then assert the scope gate is primed.
  console.log(
    "\n— 3. Runtime — scope gate is primed by a Zoom scope-rejection response —",
  );
  const farFutureExpiry = Math.floor(Date.now() / 1000) + 3600;
  await storage.setSystemSetting(SETTINGS.ACCESS, "primed_access", "test");
  await storage.setSystemSetting(SETTINGS.REFRESH, "primed_refresh", "test");
  await storage.setSystemSetting(
    SETTINGS.EXPIRES,
    String(farFutureExpiry),
    "test",
  );

  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    // Task #1819: pass Upstash Redis REST calls through to the real
    // fetch. The system_settings read-through cache hits Upstash on
    // every storage.getSystemSetting; without this passthrough the
    // mock throws "Unexpected fetch" during gate priming and at least
    // one scope gate fails to engage.
    if (u.includes(".upstash.io")) {
      return originalFetch(u as any, init);
    }
    if (u.startsWith(ZOOM_API_BASE + "/users/me")) {
      return new Response(
        JSON.stringify({
          code: 4711,
          message:
            "Invalid access token, does not contain scopes:[meeting:read:meeting:admin]",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.startsWith(ZOOM_API_BASE + "/users?")) {
      // Drive the fallback path to the same scope rejection so validateConnection
      // returns { valid: false } without throwing test-fatal errors.
      return new Response(
        JSON.stringify({
          code: 4711,
          message:
            "Invalid access token, does not contain scopes:[user:read:user:admin]",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch during gate priming: ${u}`);
  }) as any;

  const validation = await zoom.validateConnection();
  ok(
    "validateConnection reports invalid after scope rejection",
    validation.valid === false,
    `got ${JSON.stringify(validation)}`,
  );
  const primedGates = zoom.getZoomScopeGates();
  ok(
    "at least one scope gate is primed after scope rejection",
    primedGates.length >= 1,
    `gates=${JSON.stringify(primedGates.map((g) => g.scopeKey))}`,
  );

  // ── 4. Runtime — exchangeCodeForToken with a mocked token response must
  // clear both the scope gate(s) and the auth gate via the storeTokens chain.
  console.log(
    "\n— 4. Runtime — exchangeCodeForToken clears scope + auth gates —",
  );
  let tokenEndpointCalls = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    // Task #1819: pass Upstash Redis REST calls through. The token
    // store-back path calls storage.setSystemSetting, which invokes
    // cacheDel against Upstash; without this passthrough the mock
    // would throw "Unexpected fetch" mid-storeTokens.
    if (u.includes(".upstash.io")) {
      return originalFetch(u as any, init);
    }
    if (u === ZOOM_TOKEN_URL) {
      tokenEndpointCalls++;
      ok(
        `token request #${tokenEndpointCalls} uses POST`,
        init?.method === "POST",
      );
      return new Response(
        JSON.stringify({
          access_token: "fresh_access_token",
          refresh_token: "fresh_refresh_token",
          expires_in: 3600,
          scope:
            "meeting:read:meeting:admin user:read:user:admin meeting:write:meeting:admin",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch during token exchange: ${u}`);
  }) as any;

  // Pass updatedBy="system" (a synthetic marker) so the audit-trail FK
  // check doesn't log an expected-but-noisy violation on `changed_by`.
  const result = await zoom.exchangeCodeForToken("fake_auth_code", "system");
  ok("token exchange called Zoom token endpoint", tokenEndpointCalls === 1);
  ok(
    "exchangeCodeForToken returned a fresh access_token",
    result.access_token === "fresh_access_token",
  );

  // Behavioral assertions — the contract this regression pins.
  ok(
    "scope gates are EMPTY after reconnect (gate-clear chain ran)",
    zoom.getZoomScopeGates().length === 0,
    `still has gates: ${JSON.stringify(zoom.getZoomScopeGates().map((g) => g.scopeKey))}`,
  );
  ok(
    "auth gate is NULL after reconnect (gate-clear chain ran)",
    zoom.getZoomAuthGate() === null,
  );

  // Sanity check — the new granted scopes string was persisted so the Hub
  // banner re-render reads the new value (this is what visually clears the
  // banner the user sees).
  const grantedAfter = (await storage.getSystemSetting(SETTINGS.GRANTED))?.value ?? "";
  ok(
    "zoom_granted_scopes was persisted from the token response",
    grantedAfter.includes("meeting:read:meeting:admin"),
    `got: ${grantedAfter.slice(0, 200)}`,
  );
} finally {
  globalThis.fetch = originalFetch;
  await restoreZoomSettings(snap);
  // Final clear so we don't pollute subsequent tests in the same process.
  zoom.clearZoomPermanentFailure("test");
}

console.log(`\n${passed} passed, ${failed} failed`);
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
process.exitCode = failed > 0 ? 1 : 0;
