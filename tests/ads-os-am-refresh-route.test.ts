/* test-registration
{
  "name": "Ads OS AM Dashboard routes — GET payload (401 unauth, 200 for any staff role per Task #4977, refresh POST CEO-only), refresh POST phase isolation both directions (skip markers + kept batch survive an alerts blowup, alerts still run past a verification skip), verification-before-alerts order, creds 503, morning job prepends verification (Task #3988)",
  "regression": true,
  "sweepOnlyReason": "Task #3988 — real HTTP server + isolated-schema DB clones (users + 4 ads_os stores); the pure guard/payload logic already gates in the smoke suite via ads-os-am-status-check.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * AM Dashboard HTTP surface (Task #3988) — the two new routes plus the
 * morning job's prepended verification phase.
 *
 *  (A) GET /api/ads-os/am/dashboard: 401 unauthenticated, 200 for
 *      account_manager (reads open to all staff — Task #4977), 403 for the
 *      account_manager on the refresh POST (triggers stay CEO-only), 200
 *      with the payload for the CEO.
 *  (B) POST /api/ads-os/am/dashboard/refresh happy path: 200 with BOTH
 *      per-phase outcomes — status_checks {checked,mismatches,errors,saved}
 *      and the alerts summary — and the verification queries hit Google
 *      BEFORE the alert sweep's (cheapest-and-most-fragile first).
 *  (C) Refresh during an MCC-wide Ads outage: still 200; status_checks
 *      reports {skipped:"all_errored"} (kept batch — a follow-up GET serves
 *      the previous batch's verdicts and timestamp untouched); the alerts
 *      phase reports its own outcome independently (isolation direction 1:
 *      an alerts blowup can't discard the verification's result).
 *  (D) Refresh with ClickUp down: status_checks {skipped:"clickup_unavailable"}
 *      while the alert sweep still RUNS and reports (isolation direction 2:
 *      a verification failure never blocks alerts).
 *  (E) Missing Google Ads creds → 503 AdsOsCredsMissing with {detail}, before
 *      either phase runs.
 *  (F) runAdsOsPacingRefresh (the morning job body the cron route + scheduler
 *      share): its result carries status_checks alongside gads/lsa/alerts —
 *      the verification phase is prepended and isolated, so a skip marker
 *      rides a successful pacing run instead of aborting it.
 *
 * Hermetic: fetch stubbed in-process (ClickUp + OAuth + GAQL + Slack
 * belt-and-braces); runInIsolatedSchema clones users + the four ads_os store
 * tables the phases write (pinGetDbForCrossAsync: Express handlers run
 * outside the sandbox's async scope).
 */

process.env.NODE_ENV = "test";
process.env.CLICKUP_API_TOKEN = "pk_fake_am_routes_test";
process.env.ACCOUNT_ENROLLMENT = "auto";
process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "fake-dev-token";
process.env.GOOGLE_ADS_CLIENT_ID = "fake-client-id";
process.env.GOOGLE_ADS_CLIENT_SECRET = "fake-client-secret";
process.env.GOOGLE_ADS_REFRESH_TOKEN = "fake-refresh-token";
process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = "9999999999";

import { strict as assert } from "node:assert";
import { randomInt } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { getGlobalDispatcher } from "undici";
import {
  EMPTY_CLICKUP_PRACTICE_AREA_FIELDS,
  isClickUpListFieldPath,
} from "./helpers/clickUpPracticeAreaFixture";

// ── ClickUp fixture: one client, paused GAds + off LSA ──────────────────────
const F_CID = "a886aa6f-c7f8-41cc-940b-8afef551bf49";
const F_STATUS = "e8717288-345d-4a2b-8169-0992b78bc809";
const CID_A = "7771110001"; // GAds, Paused
const CID_B = "7771110002"; // LSA, Off

const statusField = (optName: "On" | "Paused" | "Off") => ({
  id: F_STATUS,
  value: `opt-${optName.toLowerCase()}`,
  type_config: {
    options: [
      { id: "opt-on", name: "On", orderindex: 0 },
      { id: "opt-paused", name: "Paused", orderindex: 1 },
      { id: "opt-off", name: "Off", orderindex: 2 },
    ],
  },
});

const CLICKUP_TASKS = {
  last_page: true,
  tasks: [
    { id: "p1", name: "Route Client", status: { status: "open" }, custom_fields: [] },
    {
      id: "s1",
      parent: "p1",
      name: "GOOGLE ADS – Route",
      custom_fields: [{ id: F_CID, value: CID_A }, statusField("Paused")],
    },
    {
      id: "s2",
      parent: "p1",
      name: "LSA (Reno)",
      custom_fields: [{ id: F_CID, value: CID_B }, statusField("Off")],
    },
  ],
};

// ── fetch stub ───────────────────────────────────────────────────────────────
let clickUpDown = false;
let gaqlAllError = false;
const gaqlQueries: string[] = []; // every googleads query, in call order

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === "string" ? input : input?.url ?? input);
  // Dispatch on URL path shape, never on live vendor hostnames — naming the
  // real API hosts here would make this test a net-new raw vendor-host caller
  // under lint-vendor-confinement. The paths mirror how the owning adapters
  // build their URLs: clickUpDirectory prefixes every call with /api/v2/,
  // googleAdsClient mints at GOOGLE_TOKEN_URL (path /token) and queries via
  // the customers/{cid}/googleAds:searchStream endpoint; Slack incoming
  // webhooks use /services/... paths.
  let pathname = "";
  try { pathname = new URL(url).pathname; } catch { /* fall through */ }
  if (pathname.startsWith("/api/v2/")) {
    if (clickUpDown) return jsonResponse({ err: "outage" }, 503);
    if (isClickUpListFieldPath(pathname)) {
      return jsonResponse(EMPTY_CLICKUP_PRACTICE_AREA_FIELDS);
    }
    return jsonResponse(CLICKUP_TASKS);
  }
  if (pathname === "/token") {
    return jsonResponse({ access_token: "fake-access", expires_in: 3599 });
  }
  if (pathname.includes("googleAds:search")) {
    const query: string = JSON.parse(String(init?.body ?? "{}"))?.query ?? "";
    gaqlQueries.push(query);
    if (gaqlAllError) {
      return jsonResponse(
        { error: { code: 500, message: "stubbed MCC-wide outage", status: "INTERNAL" } },
        500,
      );
    }
    // Empty result set for everything: status checks see zero enabled
    // campaigns (claims hold), the alert sweep sees no labeled campaigns.
    return jsonResponse([{ results: [] }]);
  }
  if (pathname.startsWith("/services/")) {
    // Belt-and-braces: nothing here should notify, but a real webhook POST
    // from a test would page the channel.
    return jsonResponse({ ok: true });
  }
  return realFetch(input, init);
}) as typeof fetch;

// ── Modules under test (AFTER env + fetch stub) ──────────────────────────────
const directory = await import("../server/services/adsOs/clickUpDirectory");
const { registerAdsOsRoutes } = await import("../server/routes/adsOs");
const { runAdsOsPacingRefresh } = await import("../server/services/adsOs/morningPacingScheduler");
const { runInIsolatedSchema } = await import("./db-sandbox");
const { __test_markUserReconciled, __test_resetReconciledUsers } = await import(
  "../server/middlewares/requireAuth"
);

const __tok = await import("../server/services/clickUpCompanyToken");
__tok.__setClickUpCompanyTokenStoreForTest({
  async get() {
    return undefined;
  },
  async set() {},
  async del() {},
  async recordAudit() {},
});
directory.__setDirectoryAlertHooksForTest({ onSuccess: async () => {}, onFailure: async () => {} });

// ── App scaffolding (Clerk test seam; real requireAuth/requireCeo after) ────
const RUN = `${Date.now()}${randomInt(1000, 9999)}`;
const CEO_ID = `test-3988-ceo-${RUN}`;
const AM_ID = `test-3988-am-${RUN}`;
let activeUserId: string | null = CEO_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = activeUserId;
    next();
  });
  registerAdsOsRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
  });
  const text = await r.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

await runInIsolatedSchema(
  async ({ db }) => {
    await db.execute(sql`
      INSERT INTO users (id, role, first_name)
      VALUES (${CEO_ID}, 'ceo', 'CEO 3988')
      ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
    `);
    await db.execute(sql`
      INSERT INTO users (id, role, first_name)
      VALUES (${AM_ID}, 'account_manager', 'AM 3988')
      ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
    `);

    // Users are seeded inside the isolated schema; requireAuth resolves the
    // acting identity against its ambient public-schema `db`, so pre-register
    // the profiles in the module registry to keep the real middleware in the
    // loop (role gating) without a JIT-provisioned public row.
    __test_markUserReconciled(CEO_ID, { id: CEO_ID, role: "ceo", firstName: "CEO 3988" });
    __test_markUserReconciled(AM_ID, {
      id: AM_ID,
      role: "account_manager",
      firstName: "AM 3988",
    });

    const app = buildApp();
    const { server, baseUrl } = await listen(app);

    try {
      // ── (A) Auth gates ──────────────────────────────────────────────────
      console.log("phase A: auth gates");
      activeUserId = null;
      ok((await call(baseUrl, "GET", "/api/ads-os/am/dashboard")).status === 401, "GET unauthenticated → 401");
      activeUserId = AM_ID;
      // Task #4977: reads are open to any staff role; the refresh POST stays CEO-only.
      ok((await call(baseUrl, "GET", "/api/ads-os/am/dashboard")).status === 200, "GET as account_manager → 200 (read open to staff, Task #4977)");
      ok(
        (await call(baseUrl, "POST", "/api/ads-os/am/dashboard/refresh")).status === 403,
        "POST refresh as account_manager → 403 (trigger stays CEO-only)",
      );
      activeUserId = CEO_ID;

      const g0 = await call(baseUrl, "GET", "/api/ads-os/am/dashboard");
      ok(g0.status === 200, "GET as CEO → 200");
      ok(g0.body.clients?.length === 1 && g0.body.clients[0].client === "Route Client", "payload lists the roster");
      ok(g0.body.clickup_ok === true, "clickup_ok true with a live roster");
      ok(g0.body.status_checked_at === null, "no verification batch yet");
      assert.deepEqual(
        g0.body.clients[0].accounts.map((a: any) => a.product),
        ["gads", "lsa"],
        "gads row precedes lsa row",
      );
      passed++;

      // ── (B) Refresh happy path + phase order ────────────────────────────
      console.log("phase B: refresh happy path");
      gaqlQueries.length = 0;
      const r1 = await call(baseUrl, "POST", "/api/ads-os/am/dashboard/refresh");
      ok(r1.status === 200, "refresh → 200");
      assert.deepEqual(
        r1.body.status_checks,
        { checked: 2, mismatches: 0, errors: 0, saved: true },
        "status_checks phase outcome (both claims hold)",
      );
      passed++;
      ok(
        r1.body.alerts && r1.body.alerts.error === undefined,
        "alerts phase reports its own summary (no error)",
      );
      ok(r1.body.alerts.total_alerts === 0, "no alerts from the empty fixture");
      const firstVerify = gaqlQueries.findIndex((q) => q.includes("serving_status"));
      const firstAlert = gaqlQueries.findIndex((q) => !q.includes("serving_status"));
      ok(firstVerify === 0, "verification queries run first…");
      ok(firstAlert === -1 || firstAlert > firstVerify, "…before any alert-sweep query");

      const g1 = await call(baseUrl, "GET", "/api/ads-os/am/dashboard");
      const batchStamp = g1.body.status_checked_at;
      ok(typeof batchStamp === "string", "GET now serves the batch timestamp");
      const acctsB = g1.body.clients[0].accounts;
      ok(acctsB[0].status_check?.matches === true, "paused gads account carries its ✓ verdict");
      ok(acctsB[1].status_check?.matches === true, "off lsa account carries its ✓ verdict");

      // ── (C) MCC-wide outage: kept batch + isolated alerts outcome ───────
      console.log("phase C: Ads outage");
      gaqlAllError = true;
      const r2 = await call(baseUrl, "POST", "/api/ads-os/am/dashboard/refresh");
      ok(r2.status === 200, "outage refresh still → 200");
      assert.deepEqual(
        r2.body.status_checks,
        { skipped: "all_errored", errors: 2 },
        "verification skips with all_errored (no-persist guard)",
      );
      passed++;
      ok("alerts" in r2.body, "alerts phase still reported its own outcome");

      const g2 = await call(baseUrl, "GET", "/api/ads-os/am/dashboard");
      ok(g2.body.status_checked_at === batchStamp, "kept batch: timestamp untouched by the skipped run");
      ok(
        g2.body.clients[0].accounts[0].status_check?.matches === true,
        "kept batch: previous verdicts still served",
      );
      gaqlAllError = false;

      // ── (D) ClickUp down: verification skips, alerts still run ──────────
      console.log("phase D: ClickUp outage");
      clickUpDown = true;
      await directory.getClientDirectory({ force: true }); // flip liveness false
      const r3 = await call(baseUrl, "POST", "/api/ads-os/am/dashboard/refresh");
      ok(r3.status === 200, "ClickUp-down refresh still → 200");
      assert.deepEqual(
        r3.body.status_checks,
        { skipped: "clickup_unavailable" },
        "verification reports the ClickUp-down skip",
      );
      passed++;
      ok(
        r3.body.alerts && typeof r3.body.alerts === "object",
        "alert phase still ran and reported (isolation: verification skip never blocks alerts)",
      );

      // ── (E) Creds gate ──────────────────────────────────────────────────
      console.log("phase E: creds gate");
      const savedTok = process.env.GOOGLE_ADS_REFRESH_TOKEN;
      delete process.env.GOOGLE_ADS_REFRESH_TOKEN;
      const r4 = await call(baseUrl, "POST", "/api/ads-os/am/dashboard/refresh");
      ok(r4.status === 503, "missing creds → 503 before either phase");
      ok(
        String(r4.body?.detail ?? "").toLowerCase().includes("credentials"),
        "503 carries the creds detail",
      );
      process.env.GOOGLE_ADS_REFRESH_TOKEN = savedTok;

      // ── (F) Morning job: verification prepended + isolated ──────────────
      console.log("phase F: morning job");
      // ClickUp still down: the verification phase must SKIP (not abort) and
      // the pacing/alert phases still complete and report.
      const job = await runAdsOsPacingRefresh();
      assert.deepEqual(
        job.status_checks,
        { skipped: "clickup_unavailable" },
        "morning job carries the verification phase's outcome",
      );
      passed++;
      ok("gads" in job && "lsa" in job && "alerts" in job, "pacing + alert phases still ran to completion");
      clickUpDown = false;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      __test_resetReconciledUsers();
    }
  },
  {
    tables: [
      "users",
      "ads_os_status_checks",
      "ads_os_account_alerts",
      "ads_os_budget_pacing",
      "ads_os_lsa_budget_pacing",
    ],
    pinGetDbForCrossAsync: true,
  },
);

// Route tests leave undici keep-alive sockets behind; close the dispatcher so
// the process can drain naturally.
await getGlobalDispatcher().close();

console.log(`\nads-os-am-refresh-route: ${passed} assertion(s) passed.`);
