/* test-registration
{
  "name": "Google Ads platform surfaces mint via the shared env-trio path (Task #4008)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4008's core auth contract: EVERY platform Google Ads surface (Ads Hygiene, Discover Customers, campaign sync) mints access tokens through the ONE shared env-trio mint that Ads OS uses — no stored connection row, no second token path. Locks the trio parameters POSTed to Google, the one-shared-cache invariant (an Ads OS mint serves a platform call without a second POST), the terminal-rejection negative cache (fail fast, no re-POST, phrases recognized by isGoogleAdsAuthDeadError), and that transient failures never read as disconnected. Pure in-process unit test with a stubbed fetch — fast, deterministic, no DB writes.",
  "tier": "small"
}
test-registration */
/**
 * Task #4008 — unified single-credential model, auth-path proof.
 *
 * Cases:
 *   A. getValidAccessToken() POSTs Google's token endpoint with EXACTLY the
 *      GOOGLE_ADS_* env trio (client_id / client_secret / refresh_token,
 *      grant_type=refresh_token) and returns the minted token; a second
 *      call is served from the shared cache (no second POST).
 *   B. ONE shared mint: after a reset, an Ads OS mint (getEnvAccessToken)
 *      followed by a platform mint (getValidAccessToken) performs exactly
 *      one POST — the platform surface reuses the Ads OS token.
 *   C. Real surfaces carry the env-minted token: gaqlSearchStream (hygiene/
 *      sync path) and listAccessibleCustomerIds (discover path) send
 *      `Authorization: Bearer <minted>` + developer-token headers to
 *      googleads.googleapis.com.
 *   D. Terminal rejection (HTTP 400 invalid_grant): getValidAccessToken
 *      throws the "credential rejected … rotate the GOOGLE_ADS_* secret
 *      trio" phrase (recognized by isGoogleAdsAuthDeadError), the negative
 *      cache arms (isConnected() → false), and the next call fails fast
 *      WITHOUT re-POSTing Google.
 *   E. Secrets incomplete: the "not connected" phrase (also matching the
 *      pattern) with ZERO network calls.
 *   F. Transient failure (HTTP 500): the error does NOT match the
 *      auth-dead pattern and the negative cache stays disarmed — a blip
 *      must never render as disconnected.
 *
 * Server route mapping for these phrases: tests/google-ads-routes-disconnected-503.test.ts.
 */

import {
  getEnvAccessToken,
  getAdsOsClientAuthSnapshot,
  __adsOsResetAuthStateForTest,
} from "../server/services/adsOs/googleAdsClient";
import {
  getValidAccessToken,
  isConnected,
  gaqlSearchStream,
  listAccessibleCustomerIds,
} from "../server/services/googleAdsIntegration";
import { isGoogleAdsAuthDeadError } from "../server/routes/googleAdsDisconnected";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Env pinning — snapshot + restore so batch siblings never inherit fakes.
// ---------------------------------------------------------------------------

const GADS_ENV_KEYS = [
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
] as const;

const envSnapshot = new Map<string, string | undefined>();
for (const k of GADS_ENV_KEYS) envSnapshot.set(k, process.env[k]);

const FAKE = {
  GOOGLE_ADS_CLIENT_ID: "fake-client-id-4008.apps.googleusercontent.com",
  GOOGLE_ADS_CLIENT_SECRET: "fake-client-secret-4008",
  GOOGLE_ADS_REFRESH_TOKEN: "fake-refresh-token-4008",
  GOOGLE_ADS_DEVELOPER_TOKEN: "fake-dev-token-4008",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "8578363654",
};

function pinFakeEnv(): void {
  for (const k of GADS_ENV_KEYS) process.env[k] = FAKE[k];
}

function restoreEnv(): void {
  for (const k of GADS_ENV_KEYS) {
    const v = envSnapshot.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ---------------------------------------------------------------------------
// Fetch stub — intercepts Google's token endpoint + the Ads API host.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;

type TokenPost = { params: URLSearchParams };
let tokenPosts: TokenPost[] = [];
let adsApiCalls: { url: string; headers: Record<string, string> }[] = [];
let tokenResponder: () => Response = () => okToken("tok-A");

function okToken(accessToken: string): Response {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: 3600 }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function headersToRecord(h: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (typeof h.forEach === "function") {
    h.forEach((v: string, k: string) => { out[k.toLowerCase()] = v; });
  } else {
    for (const [k, v] of Object.entries(h)) out[String(k).toLowerCase()] = String(v);
  }
  return out;
}

function installFetchStub(): void {
  (globalThis as any).fetch = async (input: any, init?: any): Promise<Response> => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      const params = new URLSearchParams(String(init?.body ?? ""));
      tokenPosts.push({ params });
      return tokenResponder();
    }
    if (url.includes("googleads.googleapis.com")) {
      adsApiCalls.push({ url, headers: headersToRecord(init?.headers) });
      if (url.includes("googleAds:searchStream")) {
        return new Response(JSON.stringify([{ results: [{ campaign: { id: "1" } }] }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("customers:listAccessibleCustomers")) {
        return new Response(
          JSON.stringify({ resourceNames: ["customers/1112223334", "customers/5556667778"] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`google-ads-env-mint test: unexpected fetch to ${url} — the env-mint path must only reach Google hosts`);
  };
}

function resetCounters(): void {
  tokenPosts = [];
  adsApiCalls = [];
}

async function main(): Promise<void> {
  console.log("Google Ads platform surfaces mint via the shared env-trio path (Task #4008)");

  pinFakeEnv();
  installFetchStub();
  try {
    // ── A: platform mint POSTs the exact env trio, then caches ──
    __adsOsResetAuthStateForTest();
    resetCounters();
    tokenResponder = () => okToken("tok-A");
    const tokA = await getValidAccessToken();
    assert(tokA === "tok-A", `mint returns Google's access token — got "${tokA}"`);
    assert(tokenPosts.length === 1, `exactly one token POST — got ${tokenPosts.length}`);
    const p = tokenPosts[0].params;
    assert(p.get("client_id") === FAKE.GOOGLE_ADS_CLIENT_ID, "POST carries GOOGLE_ADS_CLIENT_ID");
    assert(p.get("client_secret") === FAKE.GOOGLE_ADS_CLIENT_SECRET, "POST carries GOOGLE_ADS_CLIENT_SECRET");
    assert(p.get("refresh_token") === FAKE.GOOGLE_ADS_REFRESH_TOKEN, "POST carries GOOGLE_ADS_REFRESH_TOKEN");
    assert(p.get("grant_type") === "refresh_token", "grant_type=refresh_token");
    const tokA2 = await getValidAccessToken();
    assert(tokA2 === "tok-A", "second platform call returns the cached token");
    assert(tokenPosts.length === 1, `cached call must not re-POST — got ${tokenPosts.length}`);
    console.log("  ✓ A: getValidAccessToken POSTs the env trio once, then serves from cache");

    // ── B: ONE shared mint across Ads OS + platform surfaces ──
    __adsOsResetAuthStateForTest();
    resetCounters();
    tokenResponder = () => okToken("tok-B");
    const adsOsTok = await getEnvAccessToken();
    const platformTok = await getValidAccessToken();
    assert(adsOsTok === "tok-B" && platformTok === "tok-B", "both surfaces hold the same token");
    assert(
      tokenPosts.length === 1,
      `Ads OS mint must serve the platform surface too (ONE shared cache) — got ${tokenPosts.length} POSTs`,
    );
    console.log("  ✓ B: Ads OS mint + platform call = one POST (shared token cache)");

    // ── C: real surfaces carry the env-minted token to the Ads API ──
    __adsOsResetAuthStateForTest();
    resetCounters();
    tokenResponder = () => okToken("tok-C");
    const rows = await gaqlSearchStream("111-222-3334", "SELECT campaign.id FROM campaign");
    assert(rows.length === 1, "searchStream rows parsed");
    const ids = await listAccessibleCustomerIds();
    assert(
      ids.join(",") === "1112223334,5556667778",
      `accessible customer ids parsed — got ${ids.join(",")}`,
    );
    assert(tokenPosts.length === 1, `both surfaces share one mint — got ${tokenPosts.length}`);
    assert(adsApiCalls.length === 2, `two Ads API calls recorded — got ${adsApiCalls.length}`);
    for (const call of adsApiCalls) {
      assert(
        call.headers["authorization"] === "Bearer tok-C",
        `surface call sends the env-minted bearer — got "${call.headers["authorization"]}" for ${call.url}`,
      );
      assert(
        call.headers["developer-token"] === FAKE.GOOGLE_ADS_DEVELOPER_TOKEN,
        "surface call sends the developer token",
      );
    }
    assert(
      adsApiCalls.some((c) => (c.headers["login-customer-id"] || "") === FAKE.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
      "GAQL surface sends login-customer-id",
    );
    console.log("  ✓ C: hygiene/sync (gaqlSearchStream) + discover (listAccessibleCustomerIds) carry the env-minted token");

    // ── D: terminal rejection → auth-dead phrase + fail-fast negative cache ──
    __adsOsResetAuthStateForTest();
    resetCounters();
    tokenResponder = () =>
      new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    let terminalMsg = "";
    try {
      await getValidAccessToken();
      assert(false, "terminal rejection must throw");
    } catch (err: any) {
      terminalMsg = String(err?.message || err);
    }
    assert(
      terminalMsg.includes("Google Ads credential rejected by Google:"),
      `terminal phrase present — got "${terminalMsg}"`,
    );
    assert(
      /rotate the GOOGLE_ADS_\* secret trio and restart/.test(terminalMsg),
      `rotation runbook pointer present — got "${terminalMsg}"`,
    );
    assert(
      isGoogleAdsAuthDeadError(new Error(terminalMsg)),
      "terminal phrase is recognized by isGoogleAdsAuthDeadError (503 mapping)",
    );
    assert(tokenPosts.length === 1, "one POST before the negative cache arms");
    const snapDead = getAdsOsClientAuthSnapshot();
    assert(snapDead.authDead === true, "negative cache armed after terminal 4xx");
    assert(isConnected() === false, "isConnected() reports false while auth-dead");
    let failFastMsg = "";
    try {
      await getValidAccessToken();
    } catch (err: any) {
      failFastMsg = String(err?.message || err);
    }
    assert(
      isGoogleAdsAuthDeadError(new Error(failFastMsg)),
      `fail-fast retry keeps the auth-dead phrase — got "${failFastMsg}"`,
    );
    assert(
      tokenPosts.length === 1,
      `negative cache must prevent re-POSTing dead credentials — got ${tokenPosts.length}`,
    );
    console.log("  ✓ D: terminal 400 → rejected phrase + armed negative cache + no re-POST");

    // ── E: incomplete secrets → not-connected phrase, zero network ──
    __adsOsResetAuthStateForTest();
    resetCounters();
    delete process.env.GOOGLE_ADS_REFRESH_TOKEN;
    let missingMsg = "";
    try {
      await getValidAccessToken();
    } catch (err: any) {
      missingMsg = String(err?.message || err);
    }
    assert(
      missingMsg.includes("Google Ads not connected — the GOOGLE_ADS_* env secrets are incomplete"),
      `missing-secrets phrase present — got "${missingMsg}"`,
    );
    assert(isGoogleAdsAuthDeadError(new Error(missingMsg)), "missing-secrets phrase matches the pattern");
    assert(tokenPosts.length === 0 && adsApiCalls.length === 0, "zero network calls when secrets are incomplete");
    assert(isConnected() === false, "isConnected() false when secrets are incomplete");
    pinFakeEnv();
    console.log("  ✓ E: incomplete secrets → not-connected phrase, zero POSTs");

    // ── F: transient 500 → NOT auth-dead, negative cache stays disarmed ──
    __adsOsResetAuthStateForTest();
    resetCounters();
    tokenResponder = () =>
      new Response(JSON.stringify({ error: "internal_failure" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    let transientMsg = "";
    try {
      await getValidAccessToken();
    } catch (err: any) {
      transientMsg = String(err?.message || err);
    }
    assert(transientMsg.length > 0, "transient failure still throws");
    assert(
      !isGoogleAdsAuthDeadError(new Error(transientMsg)),
      `transient failure must NOT match the auth-dead pattern — got "${transientMsg}"`,
    );
    assert(getAdsOsClientAuthSnapshot().authDead === false, "negative cache stays disarmed on 5xx");
    assert(isConnected() === true, "isConnected() stays true through a transient blip");
    console.log("  ✓ F: transient 500 → plain error, no disconnected state");
  } finally {
    (globalThis as any).fetch = realFetch;
    restoreEnv();
    __adsOsResetAuthStateForTest();
  }

  console.log("\ngoogle-ads-env-mint-platform-surfaces: all cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
