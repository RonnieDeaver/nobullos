/* test-registration
{
  "name": "Ads OS combined dashboard status-check overlay — paused/off member rows carry ads_status + status_check, on members get null, overlay reads the store doc once per build (Task #4878)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4878: the combined (Main) dashboard's member rows must carry the same Paused/Off verification verdict the AM Dashboard and per-product dashboards show. A regression here makes the combined view silently drop the chip for every paused/off account. Fetch fully stubbed, DB-free via test seam, deterministic, fast.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Ads OS — combined dashboard status-check overlay (Task #4878).
 *
 * Asserts that buildCombinedDashboardCached overlays status_check onto every
 * paused/off member from the stored verification doc, and leaves it null for
 * On members. Uses __setStatusCheckDocOverrideForTest so no DB is needed.
 *
 * Network is fully stubbed (ClickUp + Google OAuth + GAQL). No DB, no timers.
 */

import { strict as assert } from "node:assert";
import {
  EMPTY_CLICKUP_PRACTICE_AREA_FIELDS,
  isClickUpListFieldPath,
} from "./helpers/clickUpPracticeAreaFixture";

// --- Env BEFORE any module import -------------------------------------------
process.env.CLICKUP_API_TOKEN = "pk_fake_status_check_test";
process.env.ACCOUNT_ENROLLMENT = "auto";
process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "fake-dev-token";
process.env.GOOGLE_ADS_CLIENT_ID = "fake-client-id";
process.env.GOOGLE_ADS_CLIENT_SECRET = "fake-client-secret";
process.env.GOOGLE_ADS_REFRESH_TOKEN = "fake-refresh-token";
process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = "9999999999";

// --- Fixtures ---------------------------------------------------------------
// Field IDs from config defaults (CLICKUP_CLIENT_CID_FIELD_ID / _ADS_STATUS_FIELD_ID).
const F_CID        = "a886aa6f-c7f8-41cc-940b-8afef551bf49";
const F_ADS_STATUS = "e8717288-345d-4a2b-8169-0992b78bc809"; // CLICKUP_CLIENT_ADS_STATUS_FIELD_ID default

const CID_PAUSED = "1111111111";
const CID_ON     = "2222222222";
const CID_OFF    = "3333333333";

// ClickUp dropdown: value is an option ID resolved via type_config.options.
// dropdownName() reads byId[val] → name (lowercase). Use opt_* ids + matching names.
const ADS_STATUS_FIELD_TYPE_CONFIG = {
  options: [
    { id: "opt_on",     name: "On",     orderindex: 0 },
    { id: "opt_paused", name: "Paused", orderindex: 1 },
    { id: "opt_off",    name: "Off",    orderindex: 2 },
  ],
};

function adsStatusField(optId: string | null) {
  return {
    id: F_ADS_STATUS,
    value: optId,
    type_config: ADS_STATUS_FIELD_TYPE_CONFIG,
  };
}

const CLICKUP_TASKS = {
  last_page: true,
  tasks: [
    { id: "p1", name: "Alpha Client", status: { status: "open" }, custom_fields: [] },
    {
      id: "s1",
      parent: "p1",
      name: "GOOGLE ADS – Alpha (paused)",
      custom_fields: [
        { id: F_CID, value: CID_PAUSED },
        adsStatusField("opt_paused"),
      ],
    },
    {
      id: "s2",
      parent: "p1",
      name: "GOOGLE ADS – Alpha (on)",
      custom_fields: [
        { id: F_CID, value: CID_ON },
        adsStatusField(null), // blank = on
      ],
    },
    { id: "p2", name: "Beta Client", status: { status: "open" }, custom_fields: [] },
    {
      id: "s3",
      parent: "p2",
      name: "LSA – Beta (off)",
      custom_fields: [
        { id: F_CID, value: CID_OFF },
        adsStatusField("opt_off"),
      ],
    },
  ],
};

const GADS_LABEL_RES = "customers/9999999999/labels/77";
const LSA_LABEL_RES  = "customers/9999999999/labels/78";

const MCC_ACCOUNTS = [
  { id: CID_PAUSED, name: "Alpha Paused GAds", currency: "USD" },
  { id: CID_ON,     name: "Alpha On GAds",     currency: "USD" },
  { id: CID_OFF,    name: "Beta Off LSA",       currency: "USD" },
];

// Pre-built verification doc: paused and off accounts have entries.
const STATUS_CHECK_DOC = {
  generated_at: new Date().toISOString(),
  checks: {
    [`gads:${CID_PAUSED}`]: {
      expected: "paused",
      matches: true,
      enabled_campaigns: 0,
      enabled_campaign_names: [],
      checked_at: new Date().toISOString(),
    },
    [`lsa:${CID_OFF}`]: {
      expected: "off",
      matches: false,
      enabled_campaigns: 1,
      enabled_campaign_names: ["Summer LSA"],
      checked_at: new Date().toISOString(),
    },
  },
};

// --- fetch stub -------------------------------------------------------------
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
              appliedLabels:
                a.id === CID_OFF ? [LSA_LABEL_RES] : [GADS_LABEL_RES],
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
    return jsonResponse([{ results: [] }]); // metric queries → zeros
  }
  return realFetch(input, init);
}) as typeof fetch;

// --- Modules under test (imported AFTER env + fetch stub) -------------------
const directory = await import("../server/services/adsOs/clickUpDirectory");
const combined  = await import("../server/services/adsOs/combinedDashboardService");

const __tok = await import("../server/services/clickUpCompanyToken");
__tok.__setClickUpCompanyTokenStoreForTest({
  async get() { return undefined; },
  async set() {},
  async del() {},
  async recordAudit() {},
});
directory.__setDirectoryAlertHooksForTest({ onSuccess: async () => {}, onFailure: async () => {} });

// Inject the pre-built status-check doc so no DB is needed.
combined.__setStatusCheckDocOverrideForTest(STATUS_CHECK_DOC);

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

// --- Build the combined dashboard -------------------------------------------
console.log("building combined dashboard with paused + on + off members");
const { resp } = await combined.buildCombinedDashboardCached(false);

// --- Find members by product+CID --------------------------------------------
const allMembers = resp.rows.flatMap((r) => r.members);

const pausedMember = allMembers.find((m) => m.customer_id === CID_PAUSED);
const onMember     = allMembers.find((m) => m.customer_id === CID_ON);
const offMember    = allMembers.find((m) => m.customer_id === CID_OFF);

ok(!!pausedMember, "paused account member row found");
ok(!!onMember,     "on account member row found");
ok(!!offMember,    "off account member row found");

// --- Paused member carries ads_status + matching status_check ---------------
ok(
  pausedMember?.ads_status === "paused",
  "paused member has ads_status=paused",
);
ok(
  pausedMember?.status_check !== undefined,
  "paused member has status_check field (not absent)",
);
ok(
  pausedMember?.status_check?.expected === "paused",
  "paused member status_check.expected is paused",
);
ok(
  pausedMember?.status_check?.matches === true,
  "paused member status_check.matches reflects the stored verdict",
);

// --- On member gets null status_check --------------------------------------
ok(
  onMember?.ads_status === null || onMember?.ads_status === "on",
  "on member ads_status is on/null",
);
ok(
  onMember?.status_check === null || onMember?.status_check === undefined,
  "on member status_check is null/absent (not a paused/off account)",
);

// --- Off member carries the mismatch entry ----------------------------------
ok(
  offMember?.ads_status === "off",
  "off member has ads_status=off",
);
ok(
  offMember?.status_check?.expected === "off",
  "off member status_check.expected is off",
);
ok(
  offMember?.status_check?.matches === false,
  "off member status_check.matches=false (mismatch: campaigns still enabled)",
);
ok(
  (offMember?.status_check?.enabled_campaigns ?? 0) === 1,
  "off member status_check.enabled_campaigns=1",
);

// --- Cleanup ----------------------------------------------------------------
combined.__setStatusCheckDocOverrideForTest(null);

console.log(`\nads-os-combined-status-check: ${passed} assertion(s) passed.`);
