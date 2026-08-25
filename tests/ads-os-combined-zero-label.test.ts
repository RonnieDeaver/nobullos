/* test-registration
{
  "name": "Ads OS combined dashboard zero-label surfacing — 'setup needed' flag on active-but-unlabeled GAds members, distinct from genuine zero spend, metrics_failed, and detection errors; profile passthrough (Task #4964)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4964: without this flag, an enrolled account whose active campaigns lost their monitor labels silently renders a misleading $0.00 on the Main board and client profile (the Geman Law failure mode). A regression here also risks flagging genuinely idle accounts or masking real fetch failures. Fetch fully stubbed, DB-free via test seams, deterministic.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4964 — zero-label "Setup needed" surfacing contract:
 *
 *   • GAds member with zero campaign_label rows but ACTIVE non-LSA campaigns
 *     → zero_label === true (metrics stay $0 placeholders, metrics_failed false).
 *   • GAds member with labeled campaigns → no flag.
 *   • GAds member with zero labels AND zero active campaigns (genuinely idle)
 *     → no flag (a real zero-spend account is not "setup needed").
 *   • Active-campaign probe failure → flag left unset (never guessed).
 *   • LSA members never carry the flag (label gating doesn't apply).
 *
 * Network fully stubbed (ClickUp + Google OAuth + GAQL). No DB, no timers.
 */
import { strict as assert } from "node:assert";
import {
  EMPTY_CLICKUP_PRACTICE_AREA_FIELDS,
  isClickUpListFieldPath,
} from "./helpers/clickUpPracticeAreaFixture";

// --- Env BEFORE any module import -------------------------------------------
process.env.CLICKUP_API_TOKEN = "pk_fake_zero_label_test";
process.env.ACCOUNT_ENROLLMENT = "auto";
process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "fake-dev-token";
process.env.GOOGLE_ADS_CLIENT_ID = "fake-client-id";
process.env.GOOGLE_ADS_CLIENT_SECRET = "fake-client-secret";
process.env.GOOGLE_ADS_REFRESH_TOKEN = "fake-refresh-token";
process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = "9999999999";

const F_CID = "a886aa6f-c7f8-41cc-940b-8afef551bf49";

const CID_LABELED = "1111111111"; // labeled campaigns → no flag
const CID_ZERO = "1085092927"; // active campaigns, zero labels → flag (the Geman Law shape)
const CID_IDLE = "4444444444"; // zero labels, zero active campaigns → no flag
const CID_PROBE_ERR = "5555555555"; // zero labels, active probe 500s → no flag
const CID_LSA = "3333333333"; // LSA member → never flagged

const CLICKUP_TASKS = {
  last_page: true,
  tasks: [
    { id: "p1", name: "Labeled Client", status: { status: "open" }, custom_fields: [] },
    { id: "s1", parent: "p1", name: "GOOGLE ADS – Labeled", custom_fields: [{ id: F_CID, value: CID_LABELED }] },
    { id: "p2", name: "Geman Law", status: { status: "open" }, custom_fields: [] },
    { id: "s2", parent: "p2", name: "GOOGLE ADS – Geman", custom_fields: [{ id: F_CID, value: CID_ZERO }] },
    { id: "p3", name: "Idle Client", status: { status: "open" }, custom_fields: [] },
    { id: "s3", parent: "p3", name: "GOOGLE ADS – Idle", custom_fields: [{ id: F_CID, value: CID_IDLE }] },
    { id: "p4", name: "Flaky Client", status: { status: "open" }, custom_fields: [] },
    { id: "s4", parent: "p4", name: "GOOGLE ADS – Flaky", custom_fields: [{ id: F_CID, value: CID_PROBE_ERR }] },
    { id: "p5", name: "LSA Client", status: { status: "open" }, custom_fields: [] },
    { id: "s5", parent: "p5", name: "LSA – Only", custom_fields: [{ id: F_CID, value: CID_LSA }] },
  ],
};

const GADS_LABEL_RES = "customers/9999999999/labels/77";
const LSA_LABEL_RES = "customers/9999999999/labels/78";

const MCC_ACCOUNTS = [
  { id: CID_LABELED, name: "Labeled GAds", currency: "USD" },
  { id: CID_ZERO, name: "Geman Law GAds", currency: "USD" },
  { id: CID_IDLE, name: "Idle GAds", currency: "USD" },
  { id: CID_PROBE_ERR, name: "Flaky GAds", currency: "USD" },
  { id: CID_LSA, name: "LSA Only", currency: "USD" },
];

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
  // the customers/{cid}/googleAds:searchStream endpoint.
  let pathname = "";
  try { pathname = new URL(url).pathname; } catch { /* fall through */ }
  if (pathname.startsWith("/api/v2/")) {
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
    const cid = url.match(/customers\/(\d+)\//)?.[1] ?? "";

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
              appliedLabels: a.id === CID_LSA ? [LSA_LABEL_RES] : [GADS_LABEL_RES],
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
              currencyCode: a.currency,
              manager: false,
            },
          })),
        },
      ]);
    }
    // Per-account monitor-label membership: only CID_LABELED has labeled campaigns.
    if (query.includes("FROM campaign_label")) {
      if (cid === CID_LABELED) {
        return jsonResponse([{ results: [{ campaign: { id: "101" } }, { campaign: { id: "102" } }] }]);
      }
      return jsonResponse([{ results: [] }]);
    }
    // Task #4964 active-campaign probe (status ENABLED, non-LSA).
    if (query.includes("campaign.status = 'ENABLED'") && query.includes("LOCAL_SERVICES")) {
      if (cid === CID_PROBE_ERR) {
        return jsonResponse({ error: { message: "internal" } }, 500);
      }
      if (cid === CID_ZERO) {
        return jsonResponse([{ results: [{ campaign: { id: "201" } }, { campaign: { id: "202" } }] }]);
      }
      return jsonResponse([{ results: [] }]); // idle account: no active campaigns
    }
    return jsonResponse([{ results: [] }]); // metric queries → zeros
  }
  return realFetch(input, init);
}) as typeof fetch;

// --- Modules under test (imported AFTER env + fetch stub) -------------------
const directory = await import("../server/services/adsOs/clickUpDirectory");
const combined = await import("../server/services/adsOs/combinedDashboardService");

const __tok = await import("../server/services/clickUpCompanyToken");
__tok.__setClickUpCompanyTokenStoreForTest({
  async get() { return undefined; },
  async set() {},
  async del() {},
  async recordAudit() {},
});
directory.__setDirectoryAlertHooksForTest({ onSuccess: async () => {}, onFailure: async () => {} });
combined.__setStatusCheckDocOverrideForTest({ generated_at: new Date().toISOString(), checks: {} });

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

const { resp } = await combined.buildCombinedDashboardCached(false);
const allMembers = resp.rows.flatMap((r) => r.members);
const byCid = (cid: string) => allMembers.find((m) => m.customer_id === cid);

const labeled = byCid(CID_LABELED);
const zero = byCid(CID_ZERO);
const idle = byCid(CID_IDLE);
const flaky = byCid(CID_PROBE_ERR);
const lsa = byCid(CID_LSA);

ok(!!labeled && !!zero && !!idle && !!flaky && !!lsa, "all five member rows present");
ok(zero!.zero_label === true, "active-but-unlabeled account flagged zero_label (setup needed)");
ok(zero!.metrics_failed === false, "zero-label is DISTINCT from metrics_failed");
ok(zero!.spend_30d === 0, "zero-label metrics stay $0 placeholders");
ok(!labeled!.zero_label, "labeled account never flagged");
ok(!idle!.zero_label, "genuinely idle account (no active campaigns) never flagged");
ok(!flaky!.zero_label, "active-probe failure leaves the flag unset — never guessed");
ok(flaky!.metrics_failed === false, "probe failure alone does not mark metrics_failed");
ok(!lsa!.zero_label, "LSA members never carry the flag");

// Row-level: the Geman row's members expose the flag the UI chip keys on.
const gemanRow = resp.rows.find((r) => r.client === "Geman Law");
ok(!!gemanRow && gemanRow.members.some((m) => m.zero_label === true), "row members carry zero_label for the UI chip");

// Cache invalidation seam used by the prod action exists and clears.
combined.invalidateCombinedDashboardCache();
const rebuilt = await combined.buildCombinedDashboardCached(false);
ok(rebuilt.fromCache === false, "invalidateCombinedDashboardCache drops the cached build");

// Client-profile passthrough: the profile payload marks the same account.
const profile = await import("../server/services/adsOs/clientProfile");
const prof = await profile.buildClientProfile("Geman Law");
ok(
  (prof as any).accounts.some((a: any) => a.customer_id === CID_ZERO && a.zero_label === true),
  "client profile account row carries zero_label",
);

console.log(`ads-os-combined-zero-label: ${passed} assertions passed`);
process.exit(0);
