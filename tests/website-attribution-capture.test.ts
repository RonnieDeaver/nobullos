/* test-registration
{
  "name": "Marketing attribution first/latest capture privacy",
  "regression": true,
  "smoke": true,
  "smokeReason": "Fast deterministic jsdom coverage for immutable first touch, signaled latest touch, approved click IDs, URL scrubbing, and session-only identifiers.",
  "scanPaths": [
    "website/src/client-shared/attribution.ts",
    "website/src/book-client/main.ts",
    "website/src/book-checkout-client/main.ts"
  ],
  "tier": "small",
  "tierReason": "Single in-memory jsdom; no server, database, timers, or network."
}
test-registration */

import "./helpers/forceTestEnv";
import { JSDOM } from "jsdom";
import {
  captureAttribution,
  getLatestTouchAttribution,
  getOrCreateSessionId,
  getStoredAttribution,
  getStoredSessionId,
} from "../website/src/client-shared/attribution";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

async function main(): Promise<void> {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  let dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url:
      "https://www.nobullmarketing.com/book/?utm_source=google&utm_medium=cpc" +
      "&utm_campaign=launch&utm_term=buyer%40example.com" +
      "&utm_content=detailed%20private%20answer&gclid=GCLID_123&gbraid=GBRAID-456" +
      "&wbraid=WBRAID.789&fbclid=bad%20value&email=private%40example.com" +
      "&access_token=secret#capability-token",
    referrer:
      "https://search.example/results?q=private%20name&session=secret#fragment",
  });

  try {
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
    });

    captureAttribution();
    const first = getStoredAttribution();
    const initialLatest = getLatestTouchAttribution();

    equal(first.utmSource, "google", "first source");
    equal(first.utmCampaign, "launch", "first campaign");
    equal(first.utmTerm, undefined, "email disguised as UTM term is dropped");
    equal(first.utmContent, undefined, "free-form private UTM content is dropped");
    equal(first.gclid, "GCLID_123", "GCLID preserved");
    equal(first.gbraid, "GBRAID-456", "GBRAID preserved");
    equal(first.wbraid, "WBRAID.789", "WBRAID preserved");
    equal(first.fbclid, undefined, "malformed click ID dropped");
    equal(
      first.referrer,
      "https://search.example/results",
      "referrer reduced to public origin/path",
    );
    check(first.landingUrl, "signaled visit should store a landing URL");
    check(first.landingUrl.includes("utm_source=google"), "approved campaign query preserved");
    check(first.landingUrl.includes("gclid=GCLID_123"), "approved click query preserved");
    check(!first.landingUrl.includes("private"), "arbitrary query PII removed");
    check(!first.landingUrl.includes("utm_term"), "unsafe approved-key query value removed");
    check(!first.landingUrl.includes("utm_content"), "free-form approved-key value removed");
    check(!first.landingUrl.includes("access_token"), "token query removed");
    check(!first.landingUrl.includes("#"), "URL fragment removed");
    equal(initialLatest.utmSource, "google", "initial latest source");
    check(first.sessionId, "signaled first touch stores its originating session ID");
    equal(
      initialLatest.sessionId,
      first.sessionId,
      "first and latest share the originating session on initial capture",
    );
    check(
      !("capturedAt" in initialLatest),
      "internal capture timestamp is not attached to checkout payloads",
    );

    const firstTouchRaw = dom.window.localStorage.getItem("nb_first_touch_v1");
    const latestTouchRaw = dom.window.localStorage.getItem("nb_latest_touch_v1");
    const directDom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "https://www.nobullmarketing.com/book/checkout/",
      referrer: "https://www.nobullmarketing.com/book/",
    });
    if (firstTouchRaw) directDom.window.localStorage.setItem("nb_first_touch_v1", firstTouchRaw);
    if (latestTouchRaw) directDom.window.localStorage.setItem("nb_latest_touch_v1", latestTouchRaw);
    dom.window.close();
    dom = directDom;
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
    });
    captureAttribution();
    equal(getStoredAttribution().utmSource, "google", "direct navigation preserves first touch");
    equal(
      getLatestTouchAttribution().utmSource,
      "google",
      "untagged in-funnel navigation preserves latest touch",
    );

    const preservedFirstRaw = dom.window.localStorage.getItem("nb_first_touch_v1");
    const preservedLatestRaw = dom.window.localStorage.getItem("nb_latest_touch_v1");
    const taggedDom = new JSDOM("<!doctype html><html><body></body></html>", {
      url:
        "https://www.nobullmarketing.com/book/checkout/?utm_source=newsletter" +
        "&utm_medium=email&fbclid=FBCLICK_321&debug=secret",
      referrer: "https://www.nobullmarketing.com/book/",
    });
    if (preservedFirstRaw) taggedDom.window.localStorage.setItem("nb_first_touch_v1", preservedFirstRaw);
    if (preservedLatestRaw) taggedDom.window.localStorage.setItem("nb_latest_touch_v1", preservedLatestRaw);
    dom.window.close();
    dom = taggedDom;
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
    });
    captureAttribution();
    equal(getStoredAttribution().utmSource, "google", "first touch remains immutable");
    const updatedLatest = getLatestTouchAttribution();
    equal(updatedLatest.utmSource, "newsletter", "latest source updates on signal");
    equal(updatedLatest.utmMedium, "email", "latest medium updates on signal");
    equal(updatedLatest.fbclid, "FBCLICK_321", "valid FBCLID preserved");
    check(
      !updatedLatest.landingUrl?.includes("debug"),
      "latest landing URL also drops arbitrary query data",
    );

    const sessionId = getOrCreateSessionId();
    check(sessionId.length >= 16, "session ID is opaque and non-trivial");
    equal(getOrCreateSessionId(), sessionId, "session ID remains stable in this tab");
    equal(getStoredSessionId(), sessionId, "session ID is readable from session storage");
    check(
      dom.window.localStorage.getItem("nb_device_id_v1") === null,
      "capture must not create a cross-session device identifier",
    );

    console.log("website-attribution-capture: all checks passed");
  } finally {
    Object.assign(globalThis, {
      window: originalWindow,
      document: originalDocument,
    });
    dom.window.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});