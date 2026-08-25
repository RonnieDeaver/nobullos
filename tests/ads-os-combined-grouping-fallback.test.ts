/* test-registration
{
  "name": "Ads OS Main dashboard blended grouping — cold-boot build kicks a directory fetch before reading liveness (blended client rows on first request), ClickUp-down fallback is tagged clickup_grouped=false + short-TTL cached, recovery re-groups within minutes (Task #3648)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3648: Main dashboard blended ClickUp grouping — cold-boot builds must kick a directory fetch before the liveness-based grouping decision, tag fallback builds clickup_grouped=false, cache them only at the short degraded TTL, and re-group once ClickUp recovers. Fetch fully stubbed, no DB writes, deterministic, fast; a drift here re-pins the hour-long wrongly-grouped Main dashboard.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Ads OS — Main dashboard blended ClickUp grouping resilience (Task #3648).
 *
 * Findings under test:
 *  (a) COLD BOOT: the very first combined build on a fresh process kicks a
 *      directory fetch BEFORE reading liveness, so with ClickUp healthy the
 *      rows come out grouped per ClickUp client (blended GAds + LSA), never
 *      per-account.
 *  (b) OUTAGE FALLBACK IS SHORT-LIVED: a build made while ClickUp is down is
 *      per-account, tagged clickup_grouped=false, and cached only at the short
 *      degraded TTL (~2 min) — not the full hour.
 *  (c) RECOVERY: once ClickUp is back and the short TTL elapses, the next
 *      request rebuilds with correct blended client grouping (clickup_grouped
 *      true) without waiting the full hour.
 *  (d) PRODUCT AUTHORITY: when ClickUp knows a CID only under GAds, a stale LSA
 *      label cannot add an LSA member to the healthy grouped row. Completely
 *      unknown label-only accounts still bridge the migration gap.
 *
 * All network is stubbed at global.fetch (ClickUp API + Google OAuth + GAQL):
 * no DB, no real network, no timers.
 */

import { strict as assert } from "node:assert";
import {
  EMPTY_CLICKUP_PRACTICE_AREA_FIELDS,
  isClickUpListFieldPath,
} from "./helpers/clickUpPracticeAreaFixture";

// --- Env BEFORE any module import: config constants read at load time. ------
process.env.CLICKUP_API_TOKEN = "pk_fake_grouping_test";
process.env.ACCOUNT_ENROLLMENT = "auto";
process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "fake-dev-token";
process.env.GOOGLE_ADS_CLIENT_ID = "fake-client-id";
process.env.GOOGLE_ADS_CLIENT_SECRET = "fake-client-secret";
process.env.GOOGLE_ADS_REFRESH_TOKEN = "fake-refresh-token";
process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = "9999999999";

// --- ClickUp Client List fixture (config default field ids). ----------------
const F_CID = "a886aa6f-c7f8-41cc-940b-8afef551bf49";

const CID_GADS = "1111111111";
const CID_LSA = "3333333333";
const CID_PROVET = "5555555555";
const CID_LABEL_ONLY = "6666666666";

const CLICKUP_TASKS = {
  last_page: true,
  tasks: [
    { id: "p1", name: "Acme Law", status: { status: "open" }, custom_fields: [] },
    {
      id: "s1",
      parent: "p1",
      name: "GOOGLE ADS – Acme",
      custom_fields: [{ id: F_CID, value: CID_GADS }],
    },
    {
      id: "s2",
      parent: "p1",
      name: "LSA (Springfield)",
      custom_fields: [{ id: F_CID, value: CID_LSA }],
    },
    { id: "p2", name: "ProVet", status: { status: "open" }, custom_fields: [] },
    {
      id: "s3",
      parent: "p2",
      name: "GOOGLE ADS – ProVet",
      custom_fields: [{ id: F_CID, value: CID_PROVET }],
    },
  ],
};

const GADS_LABEL_RES = "customers/9999999999/labels/77";
const LSA_LABEL_RES = "customers/9999999999/labels/78";
// ProVet carries both legacy labels even though ClickUp enrolls it only in
// GAds. The label-only account is completely unknown to ClickUp.
const GADS_LABELED_CIDS = [CID_GADS, CID_PROVET];
const LSA_LABELED_CIDS = [CID_LSA, CID_PROVET, CID_LABEL_ONLY];
const MCC_ACCOUNTS = [
  { id: CID_GADS, name: "Acme GAds Account" },
  { id: CID_LSA, name: "Acme LSA Account" },
  { id: CID_PROVET, name: "ProVet Account" },
  { id: CID_LABEL_ONLY, name: "Label Only Account" },
];

// --- fetch stub. -------------------------------------------------------------
let clickUpDown = false;
let googleSearchCalls = 0;

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
  // under lint-vendor-confinement.
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Non-absolute input: fall through to realFetch below.
  }

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
    googleSearchCalls += 1;
    const query: string = JSON.parse(String(init?.body ?? "{}"))?.query ?? "";
    if (query.includes("FROM label")) {
      if (query.includes("NBM_GADS_MONITOR")) {
        return jsonResponse([{ results: [{ label: { resourceName: GADS_LABEL_RES } }] }]);
      }
      if (query.includes("NBM_LSA_MONITOR")) {
        return jsonResponse([{ results: [{ label: { resourceName: LSA_LABEL_RES } }] }]);
      }
      return jsonResponse([{ results: [] }]);
    }
    if (query.includes("applied_labels")) {
      return jsonResponse([
        {
          results: MCC_ACCOUNTS.map((a) => ({
            customerClient: {
              id: a.id,
              manager: false,
              appliedLabels: [
                ...(GADS_LABELED_CIDS.includes(a.id) ? [GADS_LABEL_RES] : []),
                ...(LSA_LABELED_CIDS.includes(a.id) ? [LSA_LABEL_RES] : []),
              ],
            },
          })),
        },
      ]);
    }
    if (query.includes("FROM customer_client")) {
      return jsonResponse([
        {
          results: MCC_ACCOUNTS.map((a) => ({
            customerClient: {
              id: a.id,
              descriptiveName: a.name,
              currencyCode: "USD",
              manager: false,
            },
          })),
        },
      ]);
    }
    return jsonResponse([{ results: [] }]); // metric queries → zeros
  }
  return realFetch(input, init);
}) as typeof fetch;

// --- Modules under test (imported AFTER env + fetch stub). -------------------
const directory = await import("../server/services/adsOs/clickUpDirectory");
const combined = await import("../server/services/adsOs/combinedDashboardService");

const GADS_ALERTS_AT = "2026-08-23T10:00:00.000Z";
const LSA_ALERTS_AT = "2026-08-23T10:05:00.000Z";
let alertBulkCalls = 0;
let lastAlertPairs: Array<{ product: string; cid: string }> = [];
let alertDocs: Record<string, Record<string, any>> = {
  [`gads:${CID_GADS}`]: {
    generated_at: GADS_ALERTS_AT,
    alerts: [
      {
        severity: "medium",
        title: "Budget pacing",
        detail: "medium detail",
        deep_link: "/ads-os/gads/budget",
      },
      {
        severity: "critical",
        title: "Billing issue",
        detail: "critical detail",
        deep_link: "/ads-os/gads/alerts",
      },
    ],
  },
  [`lsa:${CID_LSA}`]: {
    generated_at: LSA_ALERTS_AT,
    alerts: [
      {
        severity: "high",
        title: "LSA not serving",
        detail: "high detail",
        deep_link: "/ads-os/lsa/alerts",
      },
      { severity: "novel", title: "Future severity", detail: "listed only" },
    ],
  },
};
combined.__setAlertsMapLoaderForTest(async (pairs) => {
  alertBulkCalls += 1;
  lastAlertPairs = pairs.map((pair) => ({ ...pair }));
  return alertDocs;
});

// Task #3662 preamble — the company token now resolves via the runtime
// accessor: stub its store (env-only fallback, no settings/DB read) and
// inject noop directory alert hooks so the real dispatcher chain never loads.
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

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

// (1) Cold boot, ClickUp healthy: the FIRST build must already group by client.
console.log("phase 1: cold boot with healthy ClickUp");
{
  const { resp } = await combined.buildCombinedDashboardCached(false);
  ok(resp.clickup_grouped === true, "cold-boot build tagged clickup_grouped=true");
  ok(resp.rows.length === 3, "ClickUp clients plus one unknown label-only account are shown");
  const acme = resp.rows.find((r) => r.client === "Acme Law");
  ok(
    acme?.members.length === 2 &&
      acme.members.some((m) => m.product === "gads") &&
      acme.members.some((m) => m.product === "lsa"),
    "legitimate GAds + LSA accounts remain blended into one ClickUp client row",
  );
  assert.deepEqual(
    {
      critical: acme?.alerts.critical,
      high: acme?.alerts.high,
      medium: acme?.alerts.medium,
      total: acme?.alerts.total,
      needs_attention: acme?.alerts.needs_attention,
    },
    { critical: 1, high: 1, medium: 1, total: 3, needs_attention: true },
    "mixed GAds/LSA alerts roll up with critical/high qualifying the client",
  );
  passed++;
  assert.deepEqual(
    acme?.alerts.items.map((item) => item.severity),
    ["critical", "high", "medium", "novel"],
    "Main alert details use the shared stable severity order",
  );
  passed++;
  ok(
    acme?.alerts.items[0].product === "gads" &&
      acme.alerts.items[0].customer_id === CID_GADS &&
      acme.alerts.items[0].account === "Acme GAds Account" &&
      acme.alerts.items[0].deep_link === "/ads-os/gads/alerts",
    "Main details preserve product, customer ID, account label, and deep link",
  );
  assert.deepEqual(
    acme?.alerts.accounts,
    [
      {
        product: "gads",
        customer_id: CID_GADS,
        account: "Acme GAds Account",
        alerts_at: GADS_ALERTS_AT,
      },
      {
        product: "lsa",
        customer_id: CID_LSA,
        account: "Springfield",
        alerts_at: LSA_ALERTS_AT,
      },
    ],
    "Main preserves each member document timestamp for freshness context",
  );
  passed++;
  ok(alertBulkCalls === 1, "first Main request performs exactly one bulk alert read");
  assert.deepEqual(
    new Set(lastAlertPairs.map((pair) => `${pair.product}:${pair.cid}`)),
    new Set([
      `gads:${CID_GADS}`,
      `lsa:${CID_LSA}`,
      `gads:${CID_PROVET}`,
      `lsa:${CID_LABEL_ONLY}`,
    ]),
    "the one bulk read covers every combined member, including missing documents",
  );
  passed++;
  const provet = resp.rows.find((r) => r.client === "ProVet");
  ok(
    provet?.members.length === 1 &&
      provet.members[0].product === "gads" &&
      provet.has_gads === true &&
      provet.has_lsa === false,
    "ProVet stays GAds-only despite its stale legacy LSA label",
  );
  const labelOnly = resp.rows.find((r) => r.client === "Label Only Account");
  ok(
    labelOnly?.members.length === 1 && labelOnly.members[0].product === "lsa",
    "a completely unknown label-only account still bridges the migration gap",
  );
  ok(
    provet?.alerts.total === 0 &&
      provet.alerts.items.length === 0 &&
      provet.alerts.accounts[0]?.alerts_at === null,
    "missing stored document contributes an empty rollup with null freshness",
  );

  // Change only the stored-alert snapshot. The next response must keep the
  // metrics cache hit while replacing the alert overlay via exactly one new
  // bulk read and zero new Google Ads requests.
  const searchesAfterBuild = googleSearchCalls;
  const refreshedAt = "2026-08-23T11:00:00.000Z";
  alertDocs = {
    [`gads:${CID_GADS}`]: {
      generated_at: refreshedAt,
      alerts: [{ severity: "medium", title: "Watch", detail: "no urgent issue" }],
    },
  };
  const refreshed = await combined.buildCombinedDashboardCached(false);
  const refreshedAcme = refreshed.resp.rows.find((r) => r.client === "Acme Law");
  ok(refreshed.fromCache === true, "alert-only refresh keeps the combined metrics cache hit");
  ok(alertBulkCalls === 2, "cache-hit Main request performs one fresh bulk alert read");
  ok(googleSearchCalls === searchesAfterBuild, "cache-hit alert refresh makes no Google Ads API call");
  assert.deepEqual(
    {
      critical: refreshedAcme?.alerts.critical,
      high: refreshedAcme?.alerts.high,
      medium: refreshedAcme?.alerts.medium,
      total: refreshedAcme?.alerts.total,
      needs_attention: refreshedAcme?.alerts.needs_attention,
    },
    { critical: 0, high: 0, medium: 1, total: 1, needs_attention: false },
    "cache-hit response reflects the new medium-only alert state immediately",
  );
  passed++;
  assert.deepEqual(
    refreshedAcme?.alerts.accounts.map((account) => account.alerts_at),
    [refreshedAt, null],
    "cache-hit refresh updates stored freshness and keeps missing member empty",
  );
  passed++;
}

// (2) ClickUp down at build time: per-account fallback, tagged + short-cached.
console.log("phase 2: build while ClickUp is down");
{
  combined.__testResetCombinedDashboardCache();
  directory.__testResetDirectoryCache();
  clickUpDown = true;

  const { resp } = await combined.buildCombinedDashboardCached(false);
  ok(resp.clickup_grouped === false, "fallback build tagged clickup_grouped=false");
  ok(resp.rows.length === 4, "fallback shows one row per labeled account");
  ok(
    resp.rows.every((r) => r.client.endsWith("Account")),
    "each fallback row stands alone under its account name rather than a ClickUp client",
  );
  const provet = resp.rows.find((r) => r.client === "ProVet Account");
  ok(
    provet?.members.length === 2 &&
      provet.members.some((m) => m.product === "gads") &&
      provet.members.some((m) => m.product === "lsa"),
    "ClickUp-down fallback retains both legacy labels for ProVet",
  );

  // Immediately after: still served from cache (no thundering rebuild churn).
  const again = await combined.buildCombinedDashboardCached(false);
  ok(again.fromCache === true, "fallback build IS cached briefly (no churn)");
}

// (3) ClickUp recovers: after the short degraded TTL (not the full hour) the
//     next request rebuilds with blended client grouping.
console.log("phase 3: ClickUp recovers");
{
  clickUpDown = false;
  // Simulate ~2.5 minutes passing: past the 120s degraded TTL and the
  // directory's 60s failure backoff, but far short of the 1-hour full TTL.
  combined.__testAgeCombinedDashboardCache(150_000);
  directory.__testAgeBundle(150_000);

  const { resp, fromCache } = await combined.buildCombinedDashboardCached(false);
  ok(fromCache === false, "short degraded TTL expired → rebuilt (not the 1-hour cache)");
  ok(resp.clickup_grouped === true, "rebuild tagged clickup_grouped=true");
  const acme = resp.rows.find((r) => r.client === "Acme Law");
  ok(
    resp.rows.length === 3 && acme?.members.length === 2,
    "rebuild re-groups into the blended ClickUp client row",
  );
  const provet = resp.rows.find((r) => r.client === "ProVet");
  ok(
    provet?.members.length === 1 &&
      provet.members[0].product === "gads" &&
      provet.has_lsa === false,
    "recovery removes ProVet's ghost LSA member again",
  );
}

console.log(`\nads-os-combined-grouping-fallback: ${passed} assertion(s) passed.`);
