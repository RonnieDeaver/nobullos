/* test-registration
{
  "name": "New integration probe classification — Zoom/PandaDoc/Stripe (Task #1900)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3115: the outcome-aware probeConnection() classification contract for Zoom / PandaDoc / Stripe (Task #1900), plus the Task #4008 pin that Google Ads' probeConnection stays retired (env-credential model — status is the Ads OS lane). Gated so a future accidental key overwrite or a refactor that flips 401→probe_failed (or 5xx→unauthorized) is caught in the next validation cycle instead of surfacing in prod. All provider HTTP is driven through a global.fetch stub — no real calls escape the suite.",
  "tier": "small"
}
test-registration */
/**
 * Task #1900 — Unit coverage for the Task #1888 outcome-aware
 * `probeConnection()` contracts on Zoom / PandaDoc /
 * Stripe / Google Ads.
 *
 * Mirrors the Slack/Front probe-classification tests so that a future
 * refactor that turns a 401 into a `probe_failed` (or vice versa) is
 * caught before it can pin the Integrations Hub badge to the wrong
 * value (or transiently flip it to Not Connected on a 5xx blip).
 *
 * Contract under test (per integration):
 *   - missing config            → unauthorized
 *   - transient 5xx / 429       → probe_failed
 *   - 401 / 403 / auth error    → unauthorized
 *   - success                   → connected
 *
 * Every probe is driven through `global.fetch`; no real HTTP escapes
 * the suite. Stripe's full SDK transport is the node `https` agent (not
 * `global.fetch`), so the Stripe section exercises only the no-secret
 * unauthorized path plus a synthetic-error classification check by
 * temporarily replacing `(await import("stripe")).default` on the
 * cached module — see the Stripe section's comment.
 */
import assert from "node:assert/strict";
import { storage } from "../server/storage";

const originalFetch: typeof fetch = global.fetch;
type FetchHandler = (url: string, init?: RequestInit) => Promise<Response> | Response;
let fetchHandler: FetchHandler | null = null;

const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  const url = typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (
    url.includes("api.zoom.us") ||
    url.includes("zoom.us/oauth") ||
    url.includes("api.pandadoc.com") ||
    url.includes("googleapis.com") ||
    url.includes("accounts.google.com") ||
    url.includes("oauth2.googleapis.com")
  ) {
    if (fetchHandler) return fetchHandler(url, init);
    throw new Error(`Unexpected fetch in probe test: ${url}`);
  }
  return originalFetch(input as any, init);
}) as any;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  fetchHandler = null;
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}: ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
  } finally {
    fetchHandler = null;
  }
}

// ── snapshot/restore helper for system_settings ───────────────────────
async function withSetting<T>(
  key: string,
  value: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = await storage.getSystemSetting(key).catch(() => null);
  const restore = prior ? (prior.value ?? "") : null;
  try {
    if (value === null) {
      await storage.setSystemSetting(key, "", "system");
    } else {
      await storage.setSystemSetting(key, value, "system");
    }
    return await fn();
  } finally {
    if (restore === null) {
      try {
        await storage.deleteSystemSetting(key);
      } catch {}
    } else {
      await storage.setSystemSetting(key, restore, "system");
    }
  }
}

async function main(): Promise<void> {
  console.log("New integration probe classification (Task #1900)");

  // ═════════════════════════════════════════════════════════════════
  // PandaDoc — `fetch`-based, fully testable.
  // ═════════════════════════════════════════════════════════════════
  console.log("\nPandaDoc probeConnection()");
  const pandadocMod = await import("../server/services/pandadocIntegration");

  await step("pandadoc: missing api key → unauthorized/no_api_key", async () => {
    await withSetting("pandadoc_api_key", null, async () => {
      const r = await pandadocMod.probeConnection();
      assert.equal(r.outcome, "unauthorized");
      assert.equal(r.reason, "no_api_key");
    });
  });

  await step("pandadoc: 401 → unauthorized/http_401", async () => {
    await withSetting("pandadoc_api_key", "pd-fake", async () => {
      fetchHandler = () => new Response("unauthorized", { status: 401 });
      const r = await pandadocMod.probeConnection();
      assert.equal(r.outcome, "unauthorized");
      assert.equal(r.reason, "http_401");
    });
  });

  await step("pandadoc: 403 → unauthorized/http_403", async () => {
    await withSetting("pandadoc_api_key", "pd-fake", async () => {
      fetchHandler = () => new Response("forbidden", { status: 403 });
      const r = await pandadocMod.probeConnection();
      assert.equal(r.outcome, "unauthorized");
      assert.equal(r.reason, "http_403");
    });
  });

  await step("pandadoc: 429 → probe_failed (preserve badge)", async () => {
    await withSetting("pandadoc_api_key", "pd-fake", async () => {
      fetchHandler = () => new Response("slow down", { status: 429 });
      const r = await pandadocMod.probeConnection();
      assert.equal(r.outcome, "probe_failed");
      assert.equal(r.reason, "http_429");
    });
  });

  await step("pandadoc: 503 → probe_failed (preserve badge)", async () => {
    await withSetting("pandadoc_api_key", "pd-fake", async () => {
      fetchHandler = () => new Response("boom", { status: 503 });
      const r = await pandadocMod.probeConnection();
      assert.equal(r.outcome, "probe_failed");
      assert.equal(r.reason, "http_503");
    });
  });

  await step("pandadoc: network error → probe_failed", async () => {
    await withSetting("pandadoc_api_key", "pd-fake", async () => {
      fetchHandler = () => { throw new Error("ECONNREFUSED simulated"); };
      const r = await pandadocMod.probeConnection();
      assert.equal(r.outcome, "probe_failed");
      assert.ok(/network_error/.test(r.reason ?? ""), `reason should mention network_error (got: ${r.reason})`);
    });
  });

  await step("pandadoc: 200 OK → connected", async () => {
    await withSetting("pandadoc_api_key", "pd-fake", async () => {
      fetchHandler = () => jsonResponse({ results: [] }, 200);
      const r = await pandadocMod.probeConnection();
      assert.equal(r.outcome, "connected");
      assert.equal(r.status, 200);
    });
  });

  // ── Task #2101: distinguish "confirmed no key" from "couldn't determine".
  // A degraded-DB settings read that THROWS must never be mis-resolved as
  // `no_api_key` (which flips the badge); it must surface as `probe_failed`
  // (preserve) or recover from the in-process last-good.
  await step("pandadoc: read throws WITH last-good → connected (resilient)", async () => {
    pandadocMod.__resetPandadocKeyCacheForTest();
    await withSetting("pandadoc_api_key", "pd-lastgood", async () => {
      // Prime the in-process last-good from a healthy read.
      assert.equal(await pandadocMod.isConnected(), true);
      // Now simulate the production DB read failing mid-probe.
      const origGet = (storage as any).getSystemSetting;
      (storage as any).getSystemSetting = async () => {
        throw new Error("Connection terminated unexpectedly");
      };
      try {
        fetchHandler = () => jsonResponse({ results: [] }, 200);
        const r = await pandadocMod.probeConnection();
        assert.equal(
          r.outcome,
          "connected",
          `should fall back to last-good (got ${r.outcome}/${r.reason})`,
        );
      } finally {
        (storage as any).getSystemSetting = origGet;
      }
    });
  });

  await step("pandadoc: read throws WITHOUT last-good → probe_failed (preserve, not no_api_key)", async () => {
    pandadocMod.__resetPandadocKeyCacheForTest();
    const origGet = (storage as any).getSystemSetting;
    (storage as any).getSystemSetting = async () => {
      throw new Error("DB latency exceeds critical threshold");
    };
    try {
      const r = await pandadocMod.probeConnection();
      assert.equal(
        r.outcome,
        "probe_failed",
        `degraded-DB read must not flip to no_api_key (got ${r.outcome}/${r.reason})`,
      );
      assert.ok(
        /key_lookup_failed/.test(r.reason ?? ""),
        `reason should mention key_lookup_failed (got: ${r.reason})`,
      );
    } finally {
      (storage as any).getSystemSetting = origGet;
    }
  });


  // ═════════════════════════════════════════════════════════════════
  // Zoom — multi-step (auth gate + validateConnection → /users/me with
  // fallback to /users?page_size=1). We only need the outcome
  // classification to be right; both endpoints share the same handler.
  // ═════════════════════════════════════════════════════════════════
  console.log("\nZoom probeConnection()");
  const zoomMod = await import("../server/services/zoomIntegration");

  await step("zoom: no tokens stored → unauthorized/no_tokens_stored", async () => {
    await withSetting("zoom_access_token", null, async () => {
      await withSetting("zoom_refresh_token", null, async () => {
        // Make sure the auth gate is clear so we hit the no-tokens branch.
        zoomMod.clearZoomPermanentFailure("test_setup");
        const r = await zoomMod.probeConnection();
        assert.equal(r.outcome, "unauthorized");
        assert.equal(r.reason, "no_tokens_stored");
      });
    });
  });

  await step("zoom: token + 401 → unauthorized (persistent auth error)", async () => {
    await withSetting("zoom_access_token", "tok-fake-401", async () => {
      const farFutureSec = Math.floor(Date.now() / 1000) + 3600;
      await withSetting("zoom_token_expires_at", String(farFutureSec), async () => {
        await withSetting("zoom_refresh_token", "rfr-fake-401", async () => {
          zoomMod.clearZoomPermanentFailure("test_setup");
          fetchHandler = (url) => {
            if (url.includes("/oauth/token")) {
              // Terminal refresh: 400 invalid_grant — keeps the
              // refresh-and-retry path from quietly recovering.
              return jsonResponse({ error: "invalid_grant" }, 400);
            }
            return new Response('{"code":124,"message":"Invalid access token"}', { status: 401 });
          };
          const r = await zoomMod.probeConnection();
          assert.equal(
            r.outcome,
            "unauthorized",
            `401 should classify as unauthorized (got outcome=${r.outcome} reason=${r.reason})`,
          );
          assert.ok(
            /401|invalid|token|auth|unauthorized|forbidden/i.test(r.reason ?? ""),
            `reason should describe an auth failure (got: ${r.reason})`,
          );
          zoomMod.clearZoomPermanentFailure("test_cleanup");
        });
      });
    });
  });

  await step("zoom: token + 5xx on both endpoints → probe_failed", async () => {
    await withSetting("zoom_access_token", "tok-fake-2", async () => {
      // Far-future expiry so getAccessToken skips refresh.
      const farFutureSec = Math.floor(Date.now() / 1000) + 3600;
      await withSetting("zoom_token_expires_at", String(farFutureSec), async () => {
        await withSetting("zoom_refresh_token", "rfr-fake-2", async () => {
          zoomMod.clearZoomPermanentFailure("test_setup");
          fetchHandler = () => new Response("upstream busy", { status: 503 });
          const r = await zoomMod.probeConnection();
          assert.equal(r.outcome, "probe_failed");
          assert.ok(
            /503/.test(r.reason ?? "") || /error/i.test(r.reason ?? ""),
            `reason should describe upstream error (got: ${r.reason})`,
          );
          zoomMod.clearZoomPermanentFailure("test_cleanup");
        });
      });
    });
  });

  await step("zoom: token + 200 on /users/me → connected", async () => {
    await withSetting("zoom_access_token", "tok-fake-3", async () => {
      const farFutureSec = Math.floor(Date.now() / 1000) + 3600;
      await withSetting("zoom_token_expires_at", String(farFutureSec), async () => {
        await withSetting("zoom_refresh_token", "rfr-fake-3", async () => {
          zoomMod.clearZoomPermanentFailure("test_setup");
          fetchHandler = (url) =>
            url.includes("/users/me")
              ? jsonResponse({ id: "u1", email: "probe@example.com" }, 200)
              : new Response("unexpected", { status: 500 });
          const r = await zoomMod.probeConnection();
          assert.equal(r.outcome, "connected");
          zoomMod.clearZoomPermanentFailure("test_cleanup");
        });
      });
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // Google Ads — probeConnection() RETIRED by Task #4008. The platform
  // connection row + OAuth machinery are gone; Google Ads now runs on
  // the GOOGLE_ADS_* env trio and its hub status is the Ads OS lane
  // (see tests/google-ads-status-adsos-lane.test.ts and
  // tests/google-ads-status-route-unknown.test.ts). This section pins
  // the retirement: the seam must not quietly come back, and the
  // env-based configured/not-configured classification still works
  // without any network.
  // ═════════════════════════════════════════════════════════════════
  console.log("\nGoogle Ads (env model — probeConnection retired, Task #4008)");
  const googleAdsMod = await import("../server/services/googleAdsIntegration");

  await step("google ads: probeConnection seam stays retired", async () => {
    assert.equal(
      (googleAdsMod as Record<string, unknown>).probeConnection,
      undefined,
      "googleAdsIntegration must not re-grow probeConnection — Task #4008 moved " +
        "status to the Ads OS env lane (integrationStatusLoaders)",
    );
  });

  await step("google ads: env classification — all five secrets present ⇒ configured", async () => {
    const envKeys = [
      "GOOGLE_ADS_CLIENT_ID",
      "GOOGLE_ADS_CLIENT_SECRET",
      "GOOGLE_ADS_REFRESH_TOKEN",
      "GOOGLE_ADS_DEVELOPER_TOKEN",
      "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
    ] as const;
    const snapshot: Record<string, string | undefined> = {};
    for (const k of envKeys) snapshot[k] = process.env[k];
    try {
      for (const k of envKeys) process.env[k] = `fake-${k.toLowerCase()}`;
      assert.equal(googleAdsMod.isGoogleAdsConfigured(), true, "full trio+2 ⇒ configured");
      delete process.env.GOOGLE_ADS_REFRESH_TOKEN;
      assert.equal(
        googleAdsMod.isGoogleAdsConfigured(),
        false,
        "a missing refresh token ⇒ not configured (no partial-credential limbo)",
      );
    } finally {
      for (const k of envKeys) {
        if (snapshot[k] === undefined) delete (process.env as any)[k];
        else (process.env as any)[k] = snapshot[k];
      }
    }
  });

  // ═════════════════════════════════════════════════════════════════
  // Stripe — uses the `__setStripeCtorForTest` DI seam so the SDK
  // namespace doesn't need to be monkey-patched. All four outcomes
  // (no-secret, 401, 429, 503, success) are always exercised.
  // ═════════════════════════════════════════════════════════════════
  console.log("\nStripe probeConnection()");
  const stripeMod = await import("../server/stripeClient");

  await step("stripe: missing secret key → unauthorized/no_secret_key", async () => {
    const priorEnv = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      await withSetting("stripe_secret_key", null, async () => {
        const r = await stripeMod.probeConnection();
        assert.equal(r.outcome, "unauthorized");
        assert.equal(r.reason, "no_secret_key");
      });
    } finally {
      if (priorEnv !== undefined) process.env.STRIPE_SECRET_KEY = priorEnv;
    }
  });

  function makeFakeStripeCtor(errToThrow: any | null, successPayload: any = { data: [] }) {
    return class FakeStripe {
      customers: { list: (opts: any) => Promise<any> };
      constructor(_key: string) {
        this.customers = {
          list: async () => {
            if (errToThrow) throw errToThrow;
            return successPayload;
          },
        };
      }
    } as unknown as new (key: string) => { customers: { list: (...args: any[]) => Promise<any> } };
  }

  async function withFakeStripe<T>(
    errToThrow: any | null,
    successPayload: any,
    fn: () => Promise<T>,
  ): Promise<T> {
    stripeMod.__setStripeCtorForTest(makeFakeStripeCtor(errToThrow, successPayload));
    try {
      return await fn();
    } finally {
      stripeMod.__setStripeCtorForTest(null);
    }
  }

  await withSetting("stripe_secret_key", "sk_fake", async () => {
    await step("stripe: 401 from SDK → unauthorized", async () => {
      const err: any = new Error("Invalid API key");
      err.statusCode = 401;
      err.code = "authentication_error";
      await withFakeStripe(err, null, async () => {
        const r = await stripeMod.probeConnection();
        assert.equal(r.outcome, "unauthorized");
        assert.ok(
          /authentication_error|http_401/i.test(r.reason ?? ""),
          `reason should describe auth (got: ${r.reason})`,
        );
      });
    });

    await step("stripe: 429 from SDK → probe_failed/rate_limited", async () => {
      const err: any = new Error("Too many requests");
      err.statusCode = 429;
      err.code = "rate_limit_error";
      await withFakeStripe(err, null, async () => {
        const r = await stripeMod.probeConnection();
        assert.equal(r.outcome, "probe_failed");
        assert.equal(r.reason, "rate_limited");
      });
    });

    await step("stripe: 503 from SDK → probe_failed/http_503", async () => {
      const err: any = new Error("Service unavailable");
      err.statusCode = 503;
      await withFakeStripe(err, null, async () => {
        const r = await stripeMod.probeConnection();
        assert.equal(r.outcome, "probe_failed");
        assert.equal(r.reason, "http_503");
      });
    });

    await step("stripe: SDK success → connected", async () => {
      await withFakeStripe(null, { data: [] }, async () => {
        const r = await stripeMod.probeConnection();
        assert.equal(r.outcome, "connected");
      });
    });
  });

  // ── Task #2099: distinguish "confirmed no key" from "couldn't determine".
  // A degraded-DB settings read that THROWS must never be mis-resolved as
  // `no_secret_key` (which flips the badge); it must surface as
  // `probe_failed` (preserve) or recover from the in-process last-good.
  await step("stripe: read throws WITH last-good → connected (resilient)", async () => {
    stripeMod.__resetStripeKeyCacheForTest();
    const priorEnv = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      await withSetting("stripe_secret_key", "sk_lastgood", async () => {
        // Prime the in-process last-good from a healthy read.
        const primed = await stripeMod.getStripeSecretKey();
        assert.equal(primed, "sk_lastgood");
        // Now simulate the production DB read failing mid-probe.
        const origGet = (storage as any).getSystemSetting;
        (storage as any).getSystemSetting = async () => {
          throw new Error("Connection terminated unexpectedly");
        };
        try {
          await withFakeStripe(null, { data: [] }, async () => {
            const r = await stripeMod.probeConnection();
            assert.equal(
              r.outcome,
              "connected",
              `should fall back to last-good (got ${r.outcome}/${r.reason})`,
            );
          });
        } finally {
          (storage as any).getSystemSetting = origGet;
        }
      });
    } finally {
      if (priorEnv !== undefined) process.env.STRIPE_SECRET_KEY = priorEnv;
    }
  });

  await step("stripe: read throws WITHOUT last-good → probe_failed (preserve, not no_secret_key)", async () => {
    stripeMod.__resetStripeKeyCacheForTest();
    const priorEnv = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    const origGet = (storage as any).getSystemSetting;
    (storage as any).getSystemSetting = async () => {
      throw new Error("DB latency exceeds critical threshold");
    };
    try {
      const r = await stripeMod.probeConnection();
      assert.equal(
        r.outcome,
        "probe_failed",
        `degraded-DB read must not flip to no_secret_key (got ${r.outcome}/${r.reason})`,
      );
      assert.ok(
        /key_lookup_failed/.test(r.reason ?? ""),
        `reason should mention key_lookup_failed (got: ${r.reason})`,
      );
    } finally {
      (storage as any).getSystemSetting = origGet;
      if (priorEnv !== undefined) process.env.STRIPE_SECRET_KEY = priorEnv;
    }
  });

  if (failures > 0) throw new Error(`${failures} test(s) failed`);
  console.log("\nAll new integration probe classification tests passed");
}

let exitCode = 0;
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    if (err?.stack) console.error(err.stack);
    exitCode = 1;
  })
  .finally(() => {
    global.fetch = originalFetch;
    process.exitCode = exitCode;
  });
