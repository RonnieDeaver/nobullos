/* test-registration
{
  "name": "ClickUp OAuth state security — tampered signature, expired state, nonce replay all rejected with no token written (Task #3403)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3403: ClickUp OAuth state security. Real routes over HTTP: a tampered payload (user id swapped), a garbage signature, an expired (11-minute-old but otherwise valid) state, and a replayed already-consumed state are all rejected with 400 — no token exchange, no clickup_user_tokens row. Guards validateOAuthState's signature/TTL/ nonce checks. Host-filtered fetch stub; per-run ids; rows cleaned up.",
  "tier": "small"
}
test-registration */
/**
 * Task #3403 — ClickUp OAuth state security: a tampered or expired sign-in
 * link must never connect a token to a user.
 *
 * Covers the callback rejection paths in validateOAuthState
 * (server/services/clickUpIntegration.ts):
 *   1. Bad signature — state payload tampered after signing (user id swapped
 *      to a victim) → rejected, no token exchange, no token row.
 *   2. Garbage signature — same payload, random sig → rejected.
 *   3. Expired state — a correctly-signed state whose issuedAt is older than
 *      the 10-minute TTL (forged in-test with the known secret + a matching
 *      stored nonce, so ONLY the TTL check can reject it) → rejected.
 *   4. Nonce replay — a legitimate state used once (connects successfully),
 *      then replayed → second use rejected, exactly one token exchange total.
 *
 * In every rejection case we assert:
 *   • the callback does NOT redirect with clickup=connected (400, since the
 *    test app carries no session fallback),
 *   • zero token exchanges hit ClickUp,
 *   • no clickup_user_tokens row exists for the targeted user id.
 *
 * Harness mirrors tests/clickup-oauth-flow.test.ts: real routes + real DB,
 * host-filtered fetch stub (.agents/memory/test-fetch-override-host-filter.md),
 * app-level auth injection (.agents/memory/sheets-test-auth-pattern.md),
 * per-run random ids (.agents/memory/route-test-public-schema-collision.md),
 * undici + pool close for natural drain
 * (.agents/memory/route-test-undici-drain-hang.md).
 */
import assert from "node:assert/strict";
import crypto, { randomBytes } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher } from "undici";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

const ENV_KEYS = ["CLICKUP_CLIENT_ID", "CLICKUP_CLIENT_SECRET", "CLICKUP_REDIRECT_URI"] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];


async function run(): Promise<void> {
  let passed = 0;
  const ok = (cond: boolean, msg: string) => {
    assert.ok(cond, msg);
    passed++;
    console.log(`  ok  ${msg}`);
  };

  const { registerClickUpRoutes } = await import("../server/routes/clickup");
  const { getDb, closeDbPools } = await import("../server/db");
  const { clickupUserTokens, systemSettings, users } = await import("../shared/schema");
  const { storage } = await import("../server/storage");
  const { eq, like, inArray } = await import("drizzle-orm");

  const RUN = randomBytes(4).toString("hex");
  const AUTH_USER_ID = `clickup-3403-auth-${RUN}`; // the "attacker's" own account
  const VICTIM_USER_ID = `clickup-3403-victim-${RUN}`; // account a forged state targets
  const EXPIRED_USER_ID = `clickup-3403-expired-${RUN}`; // account with a real-but-stale nonce
  const REPLAY_USER_ID = `clickup-3403-replay-${RUN}`; // legitimate connect, then replay
  const ALL_USER_IDS = [AUTH_USER_ID, VICTIM_USER_ID, EXPIRED_USER_ID, REPLAY_USER_ID];

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): authenticates as
    // this user id. (The pre-Clerk passport-shape injection stopped working
    // when auth migrated — requireAuth ignores req.user/req.isAuthenticated.)
    req.__test_clerkUserId = AUTH_USER_ID;
    next();
  });
  registerClickUpRoutes(app);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // Host-filtered fetch override: stub only ClickUp hosts.
  const realFetch = globalThis.fetch;
  let tokenExchangeCalls = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    let pathname = "";
    try { pathname = new URL(url).pathname; } catch {}
    if (pathname === "/api/v2/oauth/token") {
      tokenExchangeCalls++;
      return new Response(JSON.stringify({ access_token: `fake-token-${RUN}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (pathname.startsWith("/api/v2/")) {
      return new Response("{}", { status: 503 });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  process.env.CLICKUP_CLIENT_ID = `test-client-id-${RUN}`;
  process.env.CLICKUP_CLIENT_SECRET = `test-client-secret-${RUN}`;
  process.env.CLICKUP_REDIRECT_URI = `${baseUrl}/api/integrations/clickup/callback`;

  // Mirror of the service's state-signing recipe so the test can forge
  // states with arbitrary payloads (the secret is test-controlled above).
  const signingKey = crypto
    .createHash("sha256")
    .update(`clickup-oauth-state:${process.env.CLICKUP_CLIENT_SECRET}`)
    .digest();
  const forgeState = (payload: Record<string, unknown>): string => {
    const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const sig = crypto.createHmac("sha256", signingKey).update(b64).digest("base64url");
    return `${b64}.${sig}`;
  };

  const callback = (state: string) =>
    fetch(
      `${baseUrl}/api/integrations/clickup/callback?code=fake-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );

  const tokenRowsFor = async (userId: string) => {
    const db = getDb();
    return db
      .select({ userId: clickupUserTokens.userId })
      .from(clickupUserTokens)
      .where(eq(clickupUserTokens.userId, userId));
  };

  const issueRealState = async (): Promise<string> => {
    const r = await fetch(`${baseUrl}/api/integrations/clickup/authorize`);
    assert.equal(r.status, 200, "authorize must succeed to issue a state");
    const body: any = await r.json();
    return new URL(body.url).searchParams.get("state") || "";
  };

  // Seed real users rows so system_settings.updated_by FK accepts the
  // per-run ids (.agents/memory/isolated-schema-fk-attribution-tests.md).
  {
    const db = getDb();
    await db
      .insert(users)
      .values(
        ALL_USER_IDS.map((id) => ({ id, email: `${id}@example.test` })),
      )
      .onConflictDoNothing();
  }

  try {
    // ── 1. Tampered payload: swap the user id inside a legitimately issued
    //       state. Signature no longer matches → must be rejected.
    {
      const state = await issueRealState();
      const [payloadB64, sig] = [state.slice(0, state.lastIndexOf(".")), state.slice(state.lastIndexOf(".") + 1)];
      const parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
      parsed.u = VICTIM_USER_ID; // attacker rebinds the state to a victim
      const tamperedB64 = Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
      const tampered = `${tamperedB64}.${sig}`;

      const before = tokenExchangeCalls;
      const r = await callback(tampered);
      ok(r.status === 400, `tampered-payload state is rejected with 400 — got ${r.status}`);
      ok(
        tokenExchangeCalls === before,
        "tampered-payload state triggered no token exchange",
      );
      const rows = await tokenRowsFor(VICTIM_USER_ID);
      ok(rows.length === 0, "no token row was written for the victim user id");
    }

    // ── 2. Garbage signature on an otherwise-valid payload ──────────────────
    {
      const state = await issueRealState();
      const payloadB64 = state.slice(0, state.lastIndexOf("."));
      const badSig = randomBytes(32).toString("base64url");
      const before = tokenExchangeCalls;
      const r = await callback(`${payloadB64}.${badSig}`);
      ok(r.status === 400, `garbage-signature state is rejected with 400 — got ${r.status}`);
      ok(tokenExchangeCalls === before, "garbage-signature state triggered no token exchange");
      const rows = await tokenRowsFor(AUTH_USER_ID);
      ok(rows.length === 0, "no token row was written for the state's user id");
    }

    // ── 3. Expired state: correctly signed, matching nonce stored, but
    //       issuedAt is 11 minutes old (> the 10-minute TTL). Only the TTL
    //       check can reject this one.
    {
      const nonce = randomBytes(24).toString("hex");
      const issuedAt = Date.now() - 11 * 60 * 1000;
      await storage.setSystemSetting(
        `clickup_oauth_nonce:${EXPIRED_USER_ID}`,
        JSON.stringify({ nonce, issuedAt }),
        EXPIRED_USER_ID,
      );
      const expiredState = forgeState({ u: EXPIRED_USER_ID, n: nonce, t: issuedAt });

      const before = tokenExchangeCalls;
      const r = await callback(expiredState);
      ok(r.status === 400, `expired (11-minute-old) state is rejected with 400 — got ${r.status}`);
      ok(tokenExchangeCalls === before, "expired state triggered no token exchange");
      const rows = await tokenRowsFor(EXPIRED_USER_ID);
      ok(rows.length === 0, "no token row was written for the expired state's user id");
    }

    // ── 4. Nonce replay: one legitimate connect, then the same link again ────
    {
      // Forge a fresh, valid state for a dedicated replay user (same recipe
      // the service uses), with its nonce persisted — equivalent to that user
      // hitting /authorize themselves.
      const nonce = randomBytes(24).toString("hex");
      const issuedAt = Date.now();
      await storage.setSystemSetting(
        `clickup_oauth_nonce:${REPLAY_USER_ID}`,
        JSON.stringify({ nonce, issuedAt }),
        REPLAY_USER_ID,
      );
      const state = forgeState({ u: REPLAY_USER_ID, n: nonce, t: issuedAt });

      const before = tokenExchangeCalls;
      const r1 = await callback(state);
      const loc1 = r1.headers.get("location") || "";
      ok(
        r1.status === 302 && loc1.includes("clickup=connected"),
        `first use of a valid state connects successfully — got ${r1.status} ${loc1}`,
      );
      ok(tokenExchangeCalls === before + 1, "first use performed exactly one token exchange");
      const rowsAfterFirst = await tokenRowsFor(REPLAY_USER_ID);
      ok(rowsAfterFirst.length === 1, "first use stored exactly one token row");

      // Remove the token row so a (hypothetical) successful replay would be
      // visible as a fresh row — proves rejection isn't masked by upsert.
      const db = getDb();
      await db.delete(clickupUserTokens).where(eq(clickupUserTokens.userId, REPLAY_USER_ID));

      const r2 = await callback(state);
      ok(
        r2.status === 400,
        `replaying the already-consumed state is rejected with 400 — got ${r2.status}`,
      );
      ok(
        tokenExchangeCalls === before + 1,
        "replay triggered no additional token exchange",
      );
      const rowsAfterReplay = await tokenRowsFor(REPLAY_USER_ID);
      ok(rowsAfterReplay.length === 0, "replay wrote no token row");
    }
  } finally {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    globalThis.fetch = realFetch;

    try {
      const db = getDb();
      await db.delete(clickupUserTokens).where(inArray(clickupUserTokens.userId, ALL_USER_IDS));
      await db
        .delete(systemSettings)
        .where(like(systemSettings.key, `clickup_oauth_nonce:clickup-3403-%-${RUN}`));
      await db.delete(users).where(inArray(users.id, ALL_USER_IDS));
    } catch (err) {
      console.error("cleanup failed:", err);
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await getGlobalDispatcher().close();
    await closeDbPools();
  }

  console.log(`\nclickup-oauth-state-security: ${passed} assertion(s) passed.`);
  console.log("clickup-oauth-state-security: verified");
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
