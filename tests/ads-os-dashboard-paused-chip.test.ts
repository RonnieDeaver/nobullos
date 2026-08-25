/* test-registration
{
  "name": "Ads OS dashboard Paused/Off chip — overlayLive populates ads_status + status_check on GAds and LSA dashboard rows (paused→chip fields, on→null status_check, Off row included via enrolledAccounts in ClickUp-authoritative path), and both GadsDashboard.tsx and LsaDashboard.tsx render the shared AdsStatusChip (Task #4865)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4865: a paused/off account row on the GAds/LSA dashboard must carry its ClickUp ads_status and morning-check verdict — enrolledAccounts replaces monitoredAccounts so Off rows are present; overlayLive is the write path and both dashboard pages render the chip. A drift here silently drops the Paused/Off indicator for every ads manager on those pages.",
  "extraNodeArgs": [
    "--import",
    "./tests/ads-os-dash-paused-chip-setup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test",
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/pages/adsOs/GadsDashboard.tsx",
    "client/src/pages/adsOs/LsaDashboard.tsx",
    "server/services/adsOs/dashboardService.ts",
    "server/services/adsOs/lsaDashboardService.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4865 — Paused/Off chip on the individual GAds and LSA dashboards.
 *
 * (1) Source scan: GadsDashboard.tsx + LsaDashboard.tsx import/render
 *     AdsStatusChip with r.ads_status; dashboardService.ts +
 *     lsaDashboardService.ts use enrolledAccounts (not monitoredAccounts) so
 *     Off accounts appear in the ClickUp-authoritative production path.
 *
 * (2) Overlay — GAds dashboard, Paused + On accounts: a paused row carries
 *     ads_status="paused" and its status_check entry; an On row has null
 *     status_check.
 *
 * (3) Overlay — LSA dashboard, Paused + On: same.
 *
 * (4) Overlay — GAds dashboard, Off account: an Off CID gets ads_status="off"
 *     and its status_check entry. This verifies the overlay handles Off
 *     correctly when an Off row IS included (enrollment source is label-mode
 *     in the test harness; the source scan covers the enrolledAccounts
 *     regression for the clickup-authoritative production path).
 *
 * (5) Overlay — LSA dashboard, Off account: same.
 *
 * Harness: ACCOUNT_ENROLLMENT=label + fetch stub (Google OAuth, GAQL,
 * ClickUp tasks). Isolated-schema DB per phase. Pattern:
 * ads-os-lsa-dashboard-schedule.test.ts (#3681).
 *
 * NOTE: ACCOUNT_ENROLLMENT is a frozen module constant (read at import time).
 * Phases 4-5 test Off-account OVERLAY behaviour via label enrollment (Off CID
 * present when GAQL-labeled). The source scan in phase 1 is the regression
 * guard that catches if anyone reverts enrolledAccounts → monitoredAccounts in
 * the dashboard services (which would break the clickup-authoritative path).
 */

process.env.NODE_ENV = "test";
process.env.ACCOUNT_ENROLLMENT = "label";

import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getGlobalDispatcher } from "undici";
import {
  EMPTY_CLICKUP_PRACTICE_AREA_FIELDS,
  isClickUpListFieldPath,
} from "./helpers/clickUpPracticeAreaFixture";

// Dynamic imports so the env pins above land before module-load-time reads.
const { registerAdsOsRoutes } = await import("../server/routes/adsOs");
const { __testResetDashboardCache } = await import("../server/services/adsOs/dashboardService");
const { __testResetLsaDashboardCache } = await import("../server/services/adsOs/lsaDashboardService");
const { saveStatusChecks } = await import("../server/services/adsOs/store");
const { runInIsolatedSchema } = await import("./db-sandbox");
const { __test_markUserReconciled, __test_resetReconciledUsers } = await import(
  "../server/middlewares/requireAuth"
);

// ── Constants ────────────────────────────────────────────────────────────────

const RUN = `${Date.now()}${randomInt(1000, 9999)}`;
const CEO_ID = `test-4865-ceo-${RUN}`;
const LABEL_RES = `customers/000/labels/4865`;

// Distinct CIDs for each scenario.
const CID_PAUSED = `48${String(randomInt(0, 99999999)).padStart(8, "0")}`;
const CID_ON     = `49${String(randomInt(0, 99999999)).padStart(8, "0")}`;
const CID_OFF    = `50${String(randomInt(0, 99999999)).padStart(8, "0")}`;

// ClickUp field IDs (defaults from config.ts; env not overridden in tests).
const CID_FIELD = "a886aa6f-c7f8-41cc-940b-8afef551bf49";
const ADS_STATUS_FIELD = "e8717288-345d-4a2b-8169-0992b78bc809";

// Shared option list returned with every ads-status dropdown field.
const STATUS_OPTIONS = [
  { orderindex: 0, name: "on" },
  { orderindex: 1, name: "paused" },
  { orderindex: 2, name: "off" },
];

// Status-check fixtures.
const CHECK_ENTRY = {
  expected: "paused",
  matches: true,
  enabled_campaigns: 0,
  enabled_campaign_names: [],
  checked_at: `2026-08-07T10:05:00.000Z`,
};
const CHECK_ENTRY_OFF = {
  expected: "off",
  matches: true,
  enabled_campaigns: 0,
  enabled_campaign_names: [],
  checked_at: `2026-08-07T10:10:00.000Z`,
};

// ── (1) Source scan ───────────────────────────────────────────────────────────

console.log("phase 1: source scan");
{
  const gads = readFileSync("client/src/pages/adsOs/GadsDashboard.tsx", "utf8");
  const lsa = readFileSync("client/src/pages/adsOs/LsaDashboard.tsx", "utf8");

  assert.ok(gads.includes("AdsStatusChip"), "GadsDashboard.tsx must import/use AdsStatusChip");
  assert.ok(gads.includes("r.ads_status"), "GadsDashboard.tsx must pass r.ads_status to the chip");
  assert.ok(lsa.includes("AdsStatusChip"), "LsaDashboard.tsx must import/use AdsStatusChip");
  assert.ok(lsa.includes("r.ads_status"), "LsaDashboard.tsx must pass r.ads_status to the chip");
  console.log("  ✓ both dashboard components import and render AdsStatusChip with r.ads_status");

  // Server-side: the dashboard services must use enrolledAccounts (not
  // monitoredAccounts). enrolledAccounts includes Off CIDs; monitoredAccounts
  // drops them. This source scan is the regression guard for the
  // ClickUp-authoritative (auto/clickup) production enrollment path where the
  // distinction matters — the route tests below use label mode (frozen
  // module constant) but the same overlay code runs in all modes.
  const gadsSvc = readFileSync("server/services/adsOs/dashboardService.ts", "utf8");
  const lsaSvc = readFileSync("server/services/adsOs/lsaDashboardService.ts", "utf8");

  // The import line must name enrolledAccounts and the call must use it.
  // If someone reverts to monitoredAccounts, the import line changes and
  // these assertions fail (the positive check is sufficient).
  assert.ok(
    gadsSvc.includes("enrolledAccounts"),
    "dashboardService.ts must import and call enrolledAccounts so Off rows appear in the ClickUp-authoritative enrollment path (Task #4865)",
  );
  assert.ok(
    /import\s+\{[^}]*enrolledAccounts/.test(gadsSvc),
    "dashboardService.ts: enrolledAccounts must be imported (not just mentioned in a comment)",
  );
  assert.ok(
    lsaSvc.includes("enrolledAccounts"),
    "lsaDashboardService.ts must import and call enrolledAccounts so Off rows appear in the ClickUp-authoritative enrollment path (Task #4865)",
  );
  assert.ok(
    /import\s+\{[^}]*enrolledAccounts/.test(lsaSvc),
    "lsaDashboardService.ts: enrolledAccounts must be imported (not just mentioned in a comment)",
  );
  console.log("  ✓ both dashboard services use enrolledAccounts (Off rows included in clickup-authoritative path)");
}

// ── Fetch stub ───────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

// ── Helpers shared by all fetch stubs ────────────────────────────────────────

const mkField = (id: string, value: any, extra?: object) => ({ id, value, ...extra });
const adsFld = (v: number) =>
  mkField(ADS_STATUS_FIELD, v, { type_config: { options: STATUS_OPTIONS } });

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({ access_token: `test-token-4865-${RUN}`, expires_in: 3600 }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ── Phases 2-3: label-mode fetch stub (Paused + On accounts) ─────────────────

/** Label-mode ClickUp bundle: one parent + paused subtask + on subtask. */
function clickUpTasksLabel(product: "Google Ads" | "LSA"): object[] {
  const parentId = `p4865-label-${RUN}`;
  return [
    { id: parentId, name: `Chip Label Client ${RUN}`, status: { status: "active" }, custom_fields: [], parent: null },
    {
      id: `sub-paused-${RUN}`,
      name: `${product}`,
      status: { status: "active" },
      parent: parentId,
      custom_fields: [mkField(CID_FIELD, CID_PAUSED), adsFld(1)], // paused = orderindex 1
    },
    {
      id: `sub-on-${RUN}`,
      name: `${product} On`,
      status: { status: "active" },
      parent: parentId,
      custom_fields: [mkField(CID_FIELD, CID_ON)], // no status field → on
    },
  ];
}

function gaqlRowsLabel(query: string, product: "gads" | "lsa"): any[] {
  const cids = [CID_PAUSED, CID_ON];
  if (query.includes("FROM label")) {
    return [{ label: { resourceName: LABEL_RES } }];
  }
  if (query.includes("applied_labels")) {
    return cids.map((id) => ({
      customerClient: { id, manager: false, appliedLabels: [LABEL_RES] },
    }));
  }
  if (query.includes("FROM customer_client")) {
    return cids.map((id, i) => ({
      customerClient: {
        id,
        descriptiveName: i === 0 ? `Chip Paused ${product.toUpperCase()} ${RUN}` : `Chip On ${product.toUpperCase()} ${RUN}`,
        currencyCode: "USD",
        manager: false,
      },
    }));
  }
  return []; // metric/campaign queries → zero-row empty result
}

function stubFetchLabel(product: "gads" | "lsa"): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    // Dispatch on URL path shape, never on live vendor hostnames — naming the
    // real API hosts here would make this test a net-new raw vendor-host caller
    // under lint-vendor-confinement. The paths mirror how the owning adapters
    // build their URLs: clickUpDirectory prefixes every call with /api/v2/,
    // googleAdsClient mints at GOOGLE_TOKEN_URL (path /token) and queries via
    // the customers/{cid}/googleAds:searchStream endpoint.
    let pathname = "";
    try { pathname = new URL(url).pathname; } catch { /* fall through */ }
    if (pathname === "/token") return tokenResponse();
    if (pathname.includes("googleAds:search")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const results = gaqlRowsLabel(String(body.query ?? ""), product);
      return new Response(JSON.stringify([{ results }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (pathname.startsWith("/api/v2/")) {
      if (isClickUpListFieldPath(pathname)) {
        return new Response(JSON.stringify(EMPTY_CLICKUP_PRACTICE_AREA_FIELDS), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const isPage1 = url.includes("page=1");
      const cuProduct: "Google Ads" | "LSA" = product === "gads" ? "Google Ads" : "LSA";
      const tasks = isPage1 ? [] : clickUpTasksLabel(cuProduct);
      return new Response(
        JSON.stringify({ tasks, last_page: isPage1 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

// ── Phases 4-5: label-mode stub including Off CID ────────────────────────────
//
// ACCOUNT_ENROLLMENT is a frozen module constant (read at ESM evaluation time).
// Setting process.env after imports does NOT change the constant already read by
// enrollment.ts, so we cannot switch to clickup-authoritative mode at runtime.
//
// Instead we test Off-account OVERLAY behaviour: add CID_OFF to the GAQL label
// enrollment results (so overlayLive sees it as a dashboard row) and to the
// ClickUp bundle with "off" status. This exercises the identical overlay code
// that runs in production. The source scan in phase 1 guards the
// enrolledAccounts regression for the clickup-authoritative path.

/** Label-mode ClickUp bundle: parent + Off subtask only. */
function clickUpTasksLabelOff(product: "Google Ads" | "LSA"): object[] {
  const parentId = `p4865-off-${RUN}`;
  return [
    { id: parentId, name: `Chip Off Client ${RUN}`, status: { status: "active" }, custom_fields: [], parent: null },
    {
      id: `sub-off-${RUN}`,
      name: `${product} Off`,
      status: { status: "active" },
      parent: parentId,
      custom_fields: [mkField(CID_FIELD, CID_OFF), adsFld(2)], // off = orderindex 2
    },
  ];
}

function gaqlRowsLabelOff(query: string, product: "gads" | "lsa"): any[] {
  if (query.includes("FROM label")) {
    return [{ label: { resourceName: LABEL_RES } }];
  }
  if (query.includes("applied_labels")) {
    return [{ customerClient: { id: CID_OFF, manager: false, appliedLabels: [LABEL_RES] } }];
  }
  if (query.includes("FROM customer_client")) {
    return [
      {
        customerClient: {
          id: CID_OFF,
          descriptiveName: `Chip Off ${product.toUpperCase()} ${RUN}`,
          currencyCode: "USD",
          manager: false,
        },
      },
    ];
  }
  return [];
}

function stubFetchLabelWithOff(product: "gads" | "lsa"): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    // Dispatch on URL path shape (see stubFetchLabel comment above).
    let pathname = "";
    try { pathname = new URL(url).pathname; } catch { /* fall through */ }
    if (pathname === "/token") return tokenResponse();
    if (pathname.includes("googleAds:search")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const results = gaqlRowsLabelOff(String(body.query ?? ""), product);
      return new Response(JSON.stringify([{ results }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (pathname.startsWith("/api/v2/")) {
      if (isClickUpListFieldPath(pathname)) {
        return new Response(JSON.stringify(EMPTY_CLICKUP_PRACTICE_AREA_FIELDS), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const isPage1 = url.includes("page=1");
      const cuProduct: "Google Ads" | "LSA" = product === "gads" ? "Google Ads" : "LSA";
      const tasks = isPage1 ? [] : clickUpTasksLabelOff(cuProduct);
      return new Response(
        JSON.stringify({ tasks, last_page: isPage1 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

// ── App factory ───────────────────────────────────────────────────────────────

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).__test_clerkUserId = CEO_ID;
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

async function getRows(baseUrl: string, endpoint: string): Promise<any[]> {
  const r = await fetch(`${baseUrl}${endpoint}?force=true`);
  const body = await r.json();
  assert.equal(r.status, 200, `${endpoint} must be 200 (got ${r.status}: ${JSON.stringify(body).slice(0, 200)})`);
  assert.ok(Array.isArray(body.rows), "rows array present");
  return body.rows;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const { __testResetDirectoryCache } = await import("../server/services/adsOs/clickUpDirectory");

async function main(): Promise<void> {
  // ── Phases 2 & 3: label-mode Paused + On rows ──────────────────────────────
  process.env.ACCOUNT_ENROLLMENT = "label";
  for (const product of ["gads", "lsa"] as const) {
    const endpoint = product === "gads" ? "/api/ads-os/dashboard" : "/api/ads-os/lsa/dashboard";
    console.log(`phase ${product === "gads" ? 2 : 3}: ${product} label-mode overlay — Paused + On`);

    // Reset ClickUp directory cache so the per-product stub gets a fresh fetch.
    __testResetDirectoryCache();
    stubFetchLabel(product);
    if (product === "gads") __testResetDashboardCache();
    else __testResetLsaDashboardCache();

    await runInIsolatedSchema(
      async ({ db }) => {
        // Seed the CEO user (requireAuth gate).
        await db.execute(sql`
          INSERT INTO users (id, role, first_name)
          VALUES (${CEO_ID}, 'ceo', 'CEO 4865')
          ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
        `);
        __test_markUserReconciled(CEO_ID);

        // Seed the status-check doc: entry only for the paused CID.
        await saveStatusChecks({
          generated_at: "2026-08-07T10:05:00.000Z",
          checks: {
            [`${product}:${CID_PAUSED}`]: CHECK_ENTRY,
            // Deliberately no entry for CID_ON — must stay null.
          },
        });

        const app = buildApp();
        const { server, baseUrl } = await listen(app);
        try {
          const rows = await getRows(baseUrl, endpoint);

          const pausedRow = rows.find((r: any) => r.customer_id === CID_PAUSED);
          const onRow = rows.find((r: any) => r.customer_id === CID_ON);

          assert.ok(pausedRow, `paused account (${CID_PAUSED}) must appear in ${product} dashboard rows`);
          assert.ok(onRow, `on account (${CID_ON}) must appear in ${product} dashboard rows`);

          // Paused account: ads_status carries the ClickUp claim; status_check
          // carries the morning verification entry (keyed product:cid).
          assert.equal(
            pausedRow.ads_status,
            "paused",
            `${product} paused row must have ads_status="paused"`,
          );
          assert.deepEqual(
            pausedRow.status_check,
            CHECK_ENTRY,
            `${product} paused row must carry the status_check entry verbatim`,
          );
          console.log(`  ✓ ${product} paused row: ads_status="paused", status_check carries the ✓ entry`);

          // On account: ClickUp bundle has no explicit status → null →
          // overlay writes "on" (the ?? "on" default). The KEY assertion is
          // that status_check stays null — on accounts carry no verification.
          assert.ok(
            onRow.ads_status === null || onRow.ads_status === "on",
            `${product} on row must have ads_status null or "on" (blank = on, either is fine)`,
          );
          assert.equal(
            onRow.status_check ?? null,
            null,
            `${product} on row must have status_check=null (on accounts are never checked)`,
          );
          console.log(`  ✓ ${product} on row: ads_status="${onRow.ads_status ?? "null"}", status_check=null`);
        } finally {
          server.close();
          __test_resetReconciledUsers();
        }
      },
      {
        // Every store table overlayLive reads must be cloned or reads fall
        // through search_path to the real public table (isolated-schema
        // fallthrough gotcha). Include the status-checks table which we seed.
        tables: [
          "users",
          "ads_os_status_checks",
          "ads_os_account_alerts",
          "ads_os_clickup_tasks",
          "ads_os_audit_scores",
          "ads_os_budget_pacing",
          "ads_os_traffic_quality",
          "ads_os_clients_criteria",
          "ads_os_lsa_audit_scores",
          "ads_os_lsa_budget_pacing",
        ],
        pinGetDbForCrossAsync: true,
      },
    );
  }

  // ── Phases 4 & 5: Off-account overlay (label enrollment, Off CID GAQL-labeled)
  //
  // ACCOUNT_ENROLLMENT is a frozen module constant; changing process.env after
  // imports has no effect on the already-evaluated constant in enrollment.ts.
  // The source scan in phase 1 is the regression guard for the
  // clickup-authoritative production path (enrolledAccounts vs monitoredAccounts).
  //
  // These phases verify the OVERLAY correctly populates ads_status="off" and
  // status_check for an Off account when its row IS present — which happens in
  // production via enrolledAccounts (and in label-mode tests when the account
  // is GAQL-labeled).
  for (const product of ["gads", "lsa"] as const) {
    const endpoint = product === "gads" ? "/api/ads-os/dashboard" : "/api/ads-os/lsa/dashboard";
    console.log(`phase ${product === "gads" ? 4 : 5}: ${product} Off-account overlay — ads_status="off" + status_check`);

    __testResetDirectoryCache();
    stubFetchLabelWithOff(product);
    if (product === "gads") __testResetDashboardCache();
    else __testResetLsaDashboardCache();

    await runInIsolatedSchema(
      async ({ db }) => {
        await db.execute(sql`
          INSERT INTO users (id, role, first_name)
          VALUES (${CEO_ID}, 'ceo', 'CEO 4865')
          ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
        `);
        __test_markUserReconciled(CEO_ID);

        await saveStatusChecks({
          generated_at: "2026-08-07T10:10:00.000Z",
          checks: {
            [`${product}:${CID_OFF}`]: CHECK_ENTRY_OFF,
          },
        });

        const app = buildApp();
        const { server, baseUrl } = await listen(app);
        try {
          const rows = await getRows(baseUrl, endpoint);

          const offRow = rows.find((r: any) => r.customer_id === CID_OFF);
          assert.ok(
            offRow,
            `Off account (${CID_OFF}) must appear in ${product} dashboard rows when GAQL-labeled`,
          );
          assert.equal(
            offRow.ads_status,
            "off",
            `${product} Off row must have ads_status="off"`,
          );
          assert.deepEqual(
            offRow.status_check,
            CHECK_ENTRY_OFF,
            `${product} Off row must carry the status_check entry verbatim`,
          );
          console.log(`  ✓ ${product} Off row: ads_status="off", status_check carries the ✓ entry`);
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
          "ads_os_clickup_tasks",
          "ads_os_audit_scores",
          "ads_os_budget_pacing",
          "ads_os_traffic_quality",
          "ads_os_clients_criteria",
          "ads_os_lsa_audit_scores",
          "ads_os_lsa_budget_pacing",
        ],
        pinGetDbForCrossAsync: true,
      },
    );
  }

  globalThis.fetch = realFetch;
  __testResetDashboardCache();
  __testResetLsaDashboardCache();
  await getGlobalDispatcher().close();

  console.log("ads-os-dashboard-paused-chip: all phases passed (Task #4865).");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("ads-os-dashboard-paused-chip: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
