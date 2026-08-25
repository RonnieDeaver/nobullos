/* test-registration
{
  "name": "ClickUp OAuth connect flow — authorize 503/200, callback returnTo + fallback + error redirect (Task #3386)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3386: ClickUp OAuth connect flow smoke. Real routes over HTTP: authorize 503 without secrets / 200 + valid URL with secrets, callback returnTo redirect, /admin/integrations fallback, error redirect on a failed token exchange, 400 without a code. ClickUp HTTP stubbed via a host-filtered fetch override; per-run user id, rows cleaned up. Fast.",
  "tier": "small"
}
test-registration */
/**
 * Task #3386 — ClickUp OAuth connect flow smoke test.
 *
 * Covers the end-to-end connect flow surface:
 *   1. GET /api/integrations/clickup/authorize
 *        • 503 when CLICKUP_CLIENT_ID / CLICKUP_CLIENT_SECRET are absent
 *        • 200 + a valid authorization URL when credentials are present
 *   2. GET /api/integrations/clickup/callback
 *        • success redirect honors returnTo carried in the signed state
 *        • success redirect falls back to /admin/integrations without returnTo
 *        • failure redirect (token exchange error) also falls back correctly
 *
 * Real routes + real DB (state nonce persistence, token storage). Outbound
 * ClickUp HTTP is stubbed via a host-filtered global fetch override
 * (.agents/memory/test-fetch-override-host-filter.md) — every non-ClickUp
 * host passes through untouched (local test server, Upstash, etc.).
 *
 * Auth injection follows the app-level middleware pattern
 * (.agents/memory/sheets-test-auth-pattern.md); per-run random user ids
 * avoid shared dev-DB collisions
 * (.agents/memory/route-test-public-schema-collision.md); undici dispatcher
 * + DB pools are closed for a natural drain
 * (.agents/memory/route-test-undici-drain-hang.md).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
  const { eq, like } = await import("drizzle-orm");

  const RUN = randomBytes(4).toString("hex");
  const TEST_USER_ID = `clickup-3386-user-${RUN}`;

  // Seed a real users row (committed public schema) so requireAuth admits the
  // Clerk-seam identity AND the OAuth nonce write's system_settings.updated_by
  // FK resolves. A registry-only entry would satisfy admission but leave the
  // FK dangling (.agents/memory/isolated-schema-fk-attribution-tests.md).
  await getDb()
    .insert(users)
    .values({ id: TEST_USER_ID, email: `${TEST_USER_ID}@example.test` })
    .onConflictDoNothing();

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): authenticates as
    // this user id. (The pre-Clerk passport-shape injection stopped working
    // when auth migrated — requireAuth ignores req.user/req.isAuthenticated.)
    req.__test_clerkUserId = TEST_USER_ID;
    next();
  });
  registerClickUpRoutes(app);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // Host-filtered fetch override: stub only ClickUp hosts, pass everything
  // else (local server, Upstash cache writes) to the real fetch.
  const realFetch = globalThis.fetch;
  let tokenExchangeMode: "success" | "fail" = "success";
  let tokenExchangeCalls = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    let pathname = "";
    try { pathname = new URL(url).pathname; } catch {}
    if (pathname === "/api/v2/oauth/token") {
      tokenExchangeCalls++;
      if (tokenExchangeMode === "fail") {
        return new Response("boom", { status: 500 });
      }
      return new Response(JSON.stringify({ access_token: `fake-token-${RUN}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (pathname.startsWith("/api/v2/")) {
      // /user and /team enrichment calls — return non-ok so the route's
      // best-effort enrichment degrades gracefully.
      return new Response("{}", { status: 503 });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    // ── 1. Authorize: 503 when credentials are absent ────────────────────────
    delete process.env.CLICKUP_CLIENT_ID;
    delete process.env.CLICKUP_CLIENT_SECRET;

    {
      const r = await fetch(`${baseUrl}/api/integrations/clickup/authorize`);
      ok(
        r.status === 503,
        `authorize returns 503 when CLICKUP_CLIENT_ID/SECRET are absent — got ${r.status}`,
      );
      const body: any = await r.json();
      ok(
        typeof body.error === "string" && body.error.includes("CLICKUP_CLIENT_ID"),
        "503 body names the missing secrets so the admin knows what to add",
      );
    }

    // ── 2. Authorize: 200 + valid URL when credentials are present ───────────
    process.env.CLICKUP_CLIENT_ID = `test-client-id-${RUN}`;
    process.env.CLICKUP_CLIENT_SECRET = `test-client-secret-${RUN}`;
    process.env.CLICKUP_REDIRECT_URI = `${baseUrl}/api/integrations/clickup/callback`;

    let stateWithReturnTo = "";
    {
      const r = await fetch(
        `${baseUrl}/api/integrations/clickup/authorize?returnTo=${encodeURIComponent("/profile?tab=integrations")}`,
      );
      ok(r.status === 200, `authorize returns 200 with credentials present — got ${r.status}`);
      const body: any = await r.json();
      ok(typeof body.url === "string" && body.url.length > 0, "authorize response contains a url");
      const u = new URL(body.url);
      ok(
        u.origin + u.pathname === "https://app.clickup.com/api",
        `authorization URL points at ClickUp's OAuth endpoint — got ${u.origin + u.pathname}`,
      );
      ok(
        u.searchParams.get("client_id") === process.env.CLICKUP_CLIENT_ID,
        "authorization URL carries the configured client_id",
      );
      ok(
        u.searchParams.get("redirect_uri") === process.env.CLICKUP_REDIRECT_URI,
        "authorization URL carries the configured redirect_uri",
      );
      stateWithReturnTo = u.searchParams.get("state") || "";
      ok(stateWithReturnTo.includes("."), "authorization URL carries a signed state (payload.sig)");
    }

    // ── 3. Callback: success redirect honors returnTo from state ─────────────
    {
      tokenExchangeMode = "success";
      const r = await fetch(
        `${baseUrl}/api/integrations/clickup/callback?code=fake-code&state=${encodeURIComponent(stateWithReturnTo)}`,
        { redirect: "manual" },
      );
      ok(r.status === 302, `callback responds with a redirect — got ${r.status}`);
      const loc = r.headers.get("location") || "";
      ok(
        loc.endsWith("/profile?tab=integrations&clickup=connected"),
        `callback success redirect honors returnTo from state — got ${loc}`,
      );
      ok(tokenExchangeCalls === 1, "callback performed exactly one token exchange");

      const db = getDb();
      const rows = await db
        .select({ userId: clickupUserTokens.userId, status: clickupUserTokens.status })
        .from(clickupUserTokens)
        .where(eq(clickupUserTokens.userId, TEST_USER_ID));
      ok(rows.length === 1, "token row stored for the connecting user");
      ok(rows[0].status === "connected", `stored token row has status connected — got ${rows[0]?.status}`);
    }

    // ── 4. Callback: success redirect falls back to /admin/integrations ──────
    {
      const r1 = await fetch(`${baseUrl}/api/integrations/clickup/authorize`);
      const body: any = await r1.json();
      const state = new URL(body.url).searchParams.get("state") || "";
      ok(state.length > 0, "second authorize (no returnTo) issued a fresh state");

      const r = await fetch(
        `${baseUrl}/api/integrations/clickup/callback?code=fake-code&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      const loc = r.headers.get("location") || "";
      ok(
        r.status === 302 && loc.endsWith("/admin/integrations?clickup=connected"),
        `callback without returnTo falls back to /admin/integrations — got ${r.status} ${loc}`,
      );
    }

    // ── 5. Callback: failed token exchange redirects with clickup=error ──────
    {
      const r1 = await fetch(
        `${baseUrl}/api/integrations/clickup/authorize?returnTo=${encodeURIComponent("/profile")}`,
      );
      const body: any = await r1.json();
      const state = new URL(body.url).searchParams.get("state") || "";

      tokenExchangeMode = "fail";
      const r = await fetch(
        `${baseUrl}/api/integrations/clickup/callback?code=fake-code&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      const loc = r.headers.get("location") || "";
      ok(
        r.status === 302 && loc.endsWith("/profile?clickup=error"),
        `failed exchange redirects back to returnTo with clickup=error (no raw error page) — got ${r.status} ${loc}`,
      );
    }

    // ── 6. Callback: missing code is a 400, not a crash ──────────────────────
    {
      const r = await fetch(`${baseUrl}/api/integrations/clickup/callback`, {
        redirect: "manual",
      });
      ok(r.status === 400, `callback without code returns 400 — got ${r.status}`);
    }
  } finally {
    // Restore env exactly as found.
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    globalThis.fetch = realFetch;

    // Clean up per-run rows from the shared dev DB.
    try {
      const db = getDb();
      await db.delete(clickupUserTokens).where(eq(clickupUserTokens.userId, TEST_USER_ID));
      await db
        .delete(systemSettings)
        .where(like(systemSettings.key, `clickup_oauth_nonce:${TEST_USER_ID}`));
      await db.delete(users).where(eq(users.id, TEST_USER_ID));
    } catch (err) {
      console.error("cleanup failed:", err);
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await getGlobalDispatcher().close();
    await closeDbPools();
  }

  console.log(`\nclickup-oauth-flow: ${passed} assertion(s) passed.`);
  console.log("clickup-oauth-flow: verified");
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
