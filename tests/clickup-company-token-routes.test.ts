/* test-registration
{
  "name": "ClickUp company-token admin routes — status never echoes the token + 503 statusUnknown on read-throw, candidate/active probe purity, write-through save + verified refresh with the NEW token, clear→env, RBAC middleware wiring (Task #3662)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3662: company-token admin routes — the credential-security contract (token never echoed, 503 statusUnknown ≠ unconfigured, probe purity, write-through save + verified refresh, RBAC wiring). Injected middlewares + store, local express only, DB-free, fast; a drift here can leak the token or brick the only no-republish recovery path.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3662 — company-token admin routes (Integrations Hub ClickUp card).
 *
 * Against a real express app with INJECTED auth/role middlewares and an
 * injected token store (no real auth, no DB, ClickUp fetch stubbed):
 *  - status reports source/env/db + embedded directory health and NEVER
 *    echoes the token; a THROWN settings read answers 503 statusUnknown,
 *    never a false "not configured" (absent-vs-unknown contract);
 *  - Test connection probes the CANDIDATE token (or active when omitted),
 *    surfaces the exact ClickUp error, and never mutates directory state;
 *  - save is write-through (persists even when the verify-refresh fails),
 *    trims + actor-attributes the token, and the forced refresh already
 *    uses the NEW token; responses never echo it; bad shapes → 400;
 *  - clear reverts to the env source and audits;
 *  - every route sits behind isAuthenticated; writes behind requireWrite,
 *    status behind requireRead (middleware invocation recorded).
 */

import { strict as assert } from "node:assert";
import express from "express";
import http from "node:http";
import {
  EMPTY_CLICKUP_PRACTICE_AREA_FIELDS,
  isClickUpListFieldPath,
} from "./helpers/clickUpPracticeAreaFixture";

const ENV_TOKEN = "pk_env_route_test_123456789";
process.env.CLICKUP_API_TOKEN = ENV_TOKEN;

// ── ClickUp fetch stub ───────────────────────────────────────────────────────
let lastAuthHeader: string | null = null;
let clickupStatus = 200;
const clickupBody = {
  last_page: true,
  tasks: [{ id: "t1", name: "Acme Law", status: { status: "active" }, custom_fields: [] }],
};
const realFetch = global.fetch;
global.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  let pathname = "";
  try { pathname = new URL(u).pathname; } catch {}
  if (!pathname.startsWith("/api/v2/")) return realFetch(url, init); // local express calls pass through
  lastAuthHeader = init?.headers?.Authorization ?? null;
  if (clickupStatus !== 200) {
    return new Response(JSON.stringify({ err: "Oauth token not found" }), { status: clickupStatus });
  }
  if (isClickUpListFieldPath(pathname)) {
    return new Response(JSON.stringify(EMPTY_CLICKUP_PRACTICE_AREA_FIELDS), {
      status: 200,
    });
  }
  return new Response(JSON.stringify(clickupBody), { status: 200 });
}) as any;

async function main() {
  const tok = await import("../server/services/clickUpCompanyToken");
  const dir = await import("../server/services/adsOs/clickUpDirectory");
  const { registerClickUpCompanyTokenRoutes } = await import("../server/routes/clickupCompanyToken");

  dir.__setDirectoryAlertHooksForTest({ onSuccess: async () => {}, onFailure: async () => {} });
  dir.__testResetDirectoryCache();
  tok.__setClickUpCompanyTokenTtlForTest(0); // every resolve re-reads the injected store

  let dbValue: string | null = null;
  let getShouldThrow = false;
  const setCalls: Array<{ value: string; updatedBy?: string }> = [];
  let delCalls = 0;
  const audits: Array<{ event: string; changedBy: string | null }> = [];
  tok.__setClickUpCompanyTokenStoreForTest({
    async get() {
      if (getShouldThrow) throw new Error("db down");
      // updatedAt/updatedBy deliberately null: keeps the status handler off
      // the lastEditedHelper DB path so this suite stays DB-free.
      return dbValue === null ? undefined : { value: dbValue, updatedAt: null, updatedBy: null };
    },
    async set(_key: string, value: string, updatedBy?: string) {
      setCalls.push({ value, updatedBy });
      dbValue = value;
    },
    async del() {
      delCalls++;
      dbValue = null;
    },
    async recordAudit(event: "set" | "cleared", changedBy: string | null) {
      audits.push({ event, changedBy });
    },
  });

  // Express app with recorder middlewares (RBAC wiring assertion).
  const mw = { auth: 0, read: 0, write: 0 };
  const app = express();
  app.use(express.json());
  registerClickUpCompanyTokenRoutes(app, {
    isAuthenticated: ((req: any, _res: any, next: any) => {
      mw.auth++;
      req.user = { claims: { sub: "u-route-test" } };
      next();
    }) as any,
    requireRead: ((_req: any, _res: any, next: any) => {
      mw.read++;
      next();
    }) as any,
    requireWrite: ((_req: any, _res: any, next: any) => {
      mw.write++;
      next();
    }) as any,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  // ── status: env source, embedded health, no token echo ──────────────────
  let r = await call("GET", "/api/integrations/clickup/company-token/status");
  assert.equal(r.status, 200);
  assert.equal(r.body.source, "env");
  assert.equal(r.body.configured, true);
  assert.equal(r.body.dbOverride, false);
  assert.equal(r.body.envPresent, true);
  assert.equal(typeof r.body.directory?.live, "boolean", "embeds directory health");
  assert.equal(r.body.directory.tokenSource, "env");
  assert.ok(!JSON.stringify(r.body).includes(ENV_TOKEN), "status NEVER echoes the token");
  assert.deepEqual(mw, { auth: 1, read: 1, write: 0 }, "status behind isAuthenticated + requireRead");

  // Thrown settings read → 503 statusUnknown, NOT "not configured".
  getShouldThrow = true;
  r = await call("GET", "/api/integrations/clickup/company-token/status");
  assert.equal(r.status, 503);
  assert.equal(r.body.statusUnknown, true);
  assert.ok(!("configured" in r.body), "failed read never reports configured:false");
  getShouldThrow = false;

  // ── test connection ───────────────────────────────────────────────────────
  r = await call("POST", "/api/integrations/clickup/company-token/test", {
    token: "pk_candidate_1234567890123",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.clients, 1);
  assert.equal(r.body.testedToken, "candidate");
  assert.equal(lastAuthHeader, "pk_candidate_1234567890123", "probe used the pasted token");

  r = await call("POST", "/api/integrations/clickup/company-token/test", {});
  assert.equal(r.body.testedToken, "active");
  assert.equal(lastAuthHeader, ENV_TOKEN, "no candidate → probes the ACTIVE token");

  clickupStatus = 401;
  r = await call("POST", "/api/integrations/clickup/company-token/test", {
    token: "pk_candidate_1234567890123",
  });
  assert.equal(r.status, 200, "probe failure is an expected outcome → 200 + ok:false");
  assert.equal(r.body.ok, false);
  assert.equal(r.body.httpStatus, 401);
  assert.ok(String(r.body.error).includes("Oauth token not found"), "EXACT ClickUp error surfaced");
  assert.equal(dir.directoryHealth().lastError, null, "failed probe never mutates directory state");
  assert.equal(dir.directoryHealth().lastSuccessAt, null, "probe success/failure both leave state alone");
  clickupStatus = 200;

  r = await call("POST", "/api/integrations/clickup/company-token/test", { token: "short" });
  assert.equal(r.status, 400, "shape-invalid candidate → 400");

  // ── save: write-through + verified refresh with the NEW token ───────────
  const NEW_TOKEN = "pk_rotated_9876543210zyxw";
  r = await call("POST", "/api/integrations/clickup/company-token", { token: `  ${NEW_TOKEN}  ` });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.equal(r.body.source, "db");
  assert.deepEqual(r.body.refresh, { ok: true, clients: 1 }, "save force-refreshes and reports outcome");
  assert.deepEqual(setCalls.at(-1), { value: NEW_TOKEN, updatedBy: "u-route-test" }, "trimmed + attributed");
  assert.equal(lastAuthHeader, NEW_TOKEN, "the post-save refresh already used the NEW token");
  assert.deepEqual(audits.at(-1), { event: "set", changedBy: "u-route-test" });
  assert.ok(!JSON.stringify(r.body).includes(NEW_TOKEN), "save response never echoes the token");

  r = await call("POST", "/api/integrations/clickup/company-token", {
    token: "with spaces which is invalid",
  });
  assert.equal(r.status, 400);
  r = await call("POST", "/api/integrations/clickup/company-token", {});
  assert.equal(r.status, 400);
  assert.equal(dbValue, NEW_TOKEN, "rejected shapes never overwrite the stored token");

  // Save during a ClickUp outage: token STILL saved (write-through), refresh
  // outcome reported honestly.
  clickupStatus = 500;
  r = await call("POST", "/api/integrations/clickup/company-token", {
    token: "pk_saved_during_outage_111",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.equal(r.body.refresh.ok, false);
  assert.ok(String(r.body.refresh.error).includes("500"));
  assert.equal(dbValue, "pk_saved_during_outage_111", "write-through: saved even when refresh fails");
  clickupStatus = 200;

  // ── clear: revert to env ──────────────────────────────────────────────────
  r = await call("DELETE", "/api/integrations/clickup/company-token");
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.equal(r.body.source, "env");
  assert.equal(delCalls, 1);
  assert.deepEqual(audits.at(-1), { event: "cleared", changedBy: "u-route-test" });

  // ── middleware coverage ───────────────────────────────────────────────────
  assert.equal(mw.auth, 11, "every request passed isAuthenticated");
  assert.equal(mw.read, 2, "only status passed requireRead");
  assert.equal(mw.write, 9, "test/save/clear all passed requireWrite");

  // Cleanup: close server + undici keep-alive sockets (exit-hang guard).
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    const { getGlobalDispatcher } = await import("undici");
    await getGlobalDispatcher().close();
  } catch {
    // undici not resolvable standalone — process.exit below covers it
  }
  dir.__testResetDirectoryCache();
  dir.__setDirectoryAlertHooksForTest(null);
  tok.__resetClickUpCompanyTokenForTest();
  global.fetch = realFetch;
  console.log("clickup-company-token-routes: all assertions passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
