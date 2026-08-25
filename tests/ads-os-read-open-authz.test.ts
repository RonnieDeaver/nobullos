/* test-registration
{
  "name": "Ads OS read-open authorization split (Task #4977) — any staff role gets 200 on representative read GETs (combined dashboard, clients, criteria-adjacent history, clickup/enabled, admin audit accounts), 403 on representative write/trigger endpoints and on the CEO-only diagnostics lane (/proofs/*, /status, probe); unauthenticated stays 401",
  "regression": true,
  "sweepOnlyReason": "Task #4977 — real HTTP server + isolated-schema DB clones (users + ads_os stores + google_ads_customers); the pure role-gate logic is already smoke-covered by middleware suites.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4977 — Ads OS viewing opened to all team members.
 *
 * Policy under test:
 *  - Read-only GETs are open to ANY authenticated staff role
 *    (requireAccountManager): account_manager and team_lead get 200.
 *  - Criteria GET/PUT is the owner-approved session-only exception.
 *  - Every other mutating/trigger endpoint (POST/PUT) stays requireCeo → 403
 *    for non-CEO.
 *  - The diagnostics lane (/api/ads-os/proofs/*, /api/ads-os/status,
 *    /api/ads-os/health, /api/ads-os/accounts/:cid/probe) stays CEO-only.
 *  - Unauthenticated stays 401 everywhere.
 *
 * Hermetic: fetch stubbed in-process (ClickUp directory + OAuth + GAQL return
 * empty fixtures so the read handlers complete with empty payloads);
 * runInIsolatedSchema clones users + the ads_os store tables the dashboard
 * reads + google_ads_customers for the /api/admin/google-ads-audit list.
 */

process.env.NODE_ENV = "test";
process.env.CLICKUP_API_TOKEN = "pk_fake_read_open_authz";
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

// ── fetch stub: empty ClickUp roster, fake OAuth, empty GAQL ────────────────
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === "string" ? input : input?.url ?? input);
  // Dispatch on URL *path shape*, never on live vendor hostnames — naming the
  // real API hosts here would make this test a net-new raw vendor-host caller
  // under lint-vendor-confinement. ClickUp API routes are all under /api/v2/;
  // the Google OAuth token endpoint uses path /token; GAQL requests use paths
  // containing googleAds:search.
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Non-absolute input: fall through to realFetch below.
  }
  if (pathname.startsWith("/api/v2/")) {
    if (isClickUpListFieldPath(pathname)) {
      return jsonResponse(EMPTY_CLICKUP_PRACTICE_AREA_FIELDS);
    }
    return jsonResponse({ last_page: true, tasks: [] });
  }
  if (pathname === "/token") {
    return jsonResponse({ access_token: "fake-access", expires_in: 3599 });
  }
  if (pathname.includes("googleAds:search")) return jsonResponse([{ results: [] }]);
  return realFetch(input, init);
}) as typeof fetch;

// ── Modules under test (AFTER env + fetch stub) ──────────────────────────────
const directory = await import("../server/services/adsOs/clickUpDirectory");
const { registerAdsOsRoutes } = await import("../server/routes/adsOs");
const { registerGoogleAdsAuditRoutes } = await import("../server/routes/googleAdsAudit");
const { registerGoogleAdsHygieneRoutes } = await import("../server/routes/googleAdsHygiene");
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

// ── App scaffolding (Clerk test seam; real requireAuth + role gates after) ──
const RUN = `${Date.now()}${randomInt(1000, 9999)}`;
const CEO_ID = `test-4977-ceo-${RUN}`;
const AM_ID = `test-4977-am-${RUN}`;
const TL_ID = `test-4977-tl-${RUN}`;
let activeUserId: string | null = AM_ID;

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
  registerGoogleAdsAuditRoutes(app);
  registerGoogleAdsHygieneRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://${"127.0.0.1"}:${addr.port}` };
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(method === "GET" ? {} : { body: "{}" }),
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

// Representative READ endpoints — must be 200 for any staff role.
const READS: string[] = [
  "/api/ads-os/combined/dashboard",
  "/api/ads-os/clients",
  "/api/ads-os/clickup/enabled",
  "/api/ads-os/audit/1234567890/history",
  "/api/admin/google-ads-audit/accounts",
  "/api/admin/google-ads-hygiene/1234567890/alerts",
];

// Representative non-criteria WRITE/TRIGGER endpoints — must stay 403 for non-CEO.
const WRITES: Array<[string, string]> = [
  ["POST", "/api/ads-os/dashboard/run-alerts"],
  ["POST", "/api/ads-os/directory/refresh"],
  ["POST", "/api/ads-os/clickup/task"],
  ["POST", "/api/ads-os/keyword-intel/1234567890/keywords/actioned"],
  ["POST", "/api/ads-os/am/dashboard/refresh"],
  ["POST", "/api/admin/google-ads-audit/1234567890/run"],
  ["POST", "/api/admin/google-ads-hygiene/1234567890/keyword-intel/run"],
];

// CEO-only diagnostics lane — GETs, but deliberately NOT opened (Task #4977).
const DIAGNOSTICS: string[] = [
  "/api/ads-os/proofs/accounts",
  "/api/ads-os/proofs/store",
  "/api/ads-os/status",
  "/api/ads-os/health",
  "/api/ads-os/accounts/1234567890/probe",
];

await runInIsolatedSchema(
  async ({ db }) => {
    for (const [id, role, name] of [
      [CEO_ID, "ceo", "CEO 4977"],
      [AM_ID, "account_manager", "AM 4977"],
      [TL_ID, "team_lead", "TL 4977"],
    ] as const) {
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES (${id}, ${role}, ${name})
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);
      __test_markUserReconciled(id, { id, role, firstName: name });
    }

    const app = buildApp();
    const { server, baseUrl } = await listen(app);
    try {
      // ── (A) unauthenticated → 401 on a read and a write ─────────────────
      console.log("phase A: unauthenticated");
      activeUserId = null;
      ok(
        (await call(baseUrl, "GET", "/api/ads-os/combined/dashboard")).status === 401,
        "unauthenticated GET combined dashboard → 401",
      );
      ok(
        (await call(baseUrl, "POST", "/api/ads-os/dashboard/run-alerts")).status === 401,
        "unauthenticated POST run-alerts → 401",
      );

      // ── (B) account_manager: reads 200 ───────────────────────────────────
      console.log("phase B: account_manager reads");
      activeUserId = AM_ID;
      for (const path of READS) {
        const r = await call(baseUrl, "GET", path);
        ok(
          r.status === 200,
          `AM GET ${path} → 200 (got ${r.status}: ${JSON.stringify(r.body).slice(0, 120)})`,
        );
      }

      // ── (C) team_lead: representative read 200 ───────────────────────────
      console.log("phase C: team_lead read");
      activeUserId = TL_ID;
      const tl = await call(baseUrl, "GET", "/api/ads-os/combined/dashboard");
      ok(tl.status === 200, `team_lead GET combined dashboard → 200 (got ${tl.status})`);

      // ── (D) account_manager: writes + diagnostics 403 ────────────────────
      console.log("phase D: account_manager writes/diagnostics");
      activeUserId = AM_ID;
      for (const [method, path] of WRITES) {
        const r = await call(baseUrl, method, path);
        ok(r.status === 403, `AM ${method} ${path} → 403 (got ${r.status})`);
      }
      for (const path of DIAGNOSTICS) {
        const r = await call(baseUrl, "GET", path);
        ok(r.status === 403, `AM GET ${path} → 403 (diagnostics lane stays CEO; got ${r.status})`);
      }

      // ── (E) CEO sanity: diagnostics + a write are NOT broken by the split ─
      console.log("phase E: CEO sanity");
      activeUserId = CEO_ID;
      const ceoStatus = await call(baseUrl, "GET", "/api/ads-os/status");
      ok(ceoStatus.status === 200, `CEO GET /api/ads-os/status → 200 (got ${ceoStatus.status})`);
      const ceoHealth = await call(baseUrl, "GET", "/api/ads-os/health");
      ok(ceoHealth.status === 200, `CEO GET /api/ads-os/health → 200 (got ${ceoHealth.status})`);
    } finally {
      server.close();
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
      "ads_os_audit_scores",
      "google_ads_customers",
      "google_ads_hygiene_alerts",
    ],
    pinGetDbForCrossAsync: true,
  },
);

// Route tests leave undici keep-alive sockets behind; close the dispatcher so
// the process can drain naturally.
await getGlobalDispatcher().close();
console.log(`ads-os-read-open-authz: all ${passed} assertions passed (Task #4977).`);
