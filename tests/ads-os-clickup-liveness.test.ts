/* test-registration
{
  "name": "Ads OS ClickUp liveness — post-success outage flips clickup_live false, stale bundle still serves display data, auto enrollment falls back to labels minus remembered-offboarded CIDs (Task #3597)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3597 (Phase 1 review): ClickUp directory liveness is CURRENT health, not \"ever fetched\" — a post-success outage must flip clickup_live false, keep serving the stale bundle for display, and swing auto enrollment to the label fallback (minus remembered-offboarded CIDs), recovering on the next good fetch. Stubbed fetch for ClickUp/OAuth/GAQL: no DB, no network.",
  "tier": "small"
}
test-registration */
/**
 * Ads OS — ClickUp directory liveness + auto-enrollment outage fallback (Task #3597).
 *
 * Phase 1 review findings under test:
 *  (a) post-success outage: a failed refresh flips bundleIsLive() → false
 *      (liveness is CURRENT health — the most recent completed fetch attempt —
 *      not "ever fetched");
 *  (b) stale-cache serving: the failed refresh still serves the last good
 *      bundle for display (people/cities/budgets), never a blank page;
 *  (c) auto fallback: with ClickUp not live, ACCOUNT_ENROLLMENT=auto resolves
 *      from the legacy account labels — minus CIDs the stale bundle remembers
 *      as deliberately dropped (known to ClickUp but under no live client) —
 *      and recovers to ClickUp authority on the next successful fetch.
 *  (d) healthy auto union: a CID known under one ClickUp product cannot gain a
 *      second product solely from a stale legacy label; a completely unknown
 *      label-only CID still bridges the migration gap.
 *
 * The dashboards' clickup_live payload flag (UI banner) reads the SAME
 * bundleIsLive() the enrollment gate uses, so (a) also pins the banner signal.
 *
 * All network is stubbed at global.fetch (ClickUp API + Google OAuth + GAQL
 * searchStream): no DB, no real network, no timers.
 */

import { strict as assert } from "node:assert";
import {
  EMPTY_CLICKUP_PRACTICE_AREA_FIELDS,
  isClickUpListFieldPath,
} from "./helpers/clickUpPracticeAreaFixture";

// --- Env BEFORE any module import: config constants read at load time. ------
process.env.CLICKUP_API_TOKEN = "pk_fake_liveness_test";
process.env.ACCOUNT_ENROLLMENT = "auto";
process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "fake-dev-token";
process.env.GOOGLE_ADS_CLIENT_ID = "fake-client-id";
process.env.GOOGLE_ADS_CLIENT_SECRET = "fake-client-secret";
process.env.GOOGLE_ADS_REFRESH_TOKEN = "fake-refresh-token";
process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = "9999999999";

// --- ClickUp Client List fixture (config default field ids). ----------------
const F_CID = "a886aa6f-c7f8-41cc-940b-8afef551bf49";
const F_STATUS = "e8717288-345d-4a2b-8169-0992b78bc809";
const F_DOER = "21335dc5-98ba-470c-b8a9-944e3cfed343";

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

const CID_CLICKUP_ON = "1111111111"; // live client, status On, NOT labeled
const CID_OFFBOARDED = "2222222222"; // offboarded client's account, labeled
const CID_LSA = "3333333333"; // live client's LSA account
const CID_LABEL_ONLY = "4444444444"; // labeled, unknown to ClickUp

const CLICKUP_TASKS = {
  last_page: true,
  tasks: [
    {
      id: "p1",
      name: "Acme Law",
      status: { status: "open" },
      custom_fields: [{ id: F_DOER, value: [{ username: "Dana Doer" }] }],
    },
    {
      id: "s1",
      parent: "p1",
      name: "GOOGLE ADS – Acme",
      custom_fields: [{ id: F_CID, value: CID_CLICKUP_ON }, statusField("On")],
    },
    {
      id: "s2",
      parent: "p1",
      name: "LSA (Springfield)",
      custom_fields: [{ id: F_CID, value: CID_LSA }],
    },
    // Offboarded parent: dropped from clients/blocks, but its CID must land in
    // `known` so no label path ever resurrects it.
    { id: "p2", name: "Gone LLC", status: { status: "offboarded" }, custom_fields: [] },
    {
      id: "s3",
      parent: "p2",
      name: "GOOGLE ADS – Gone",
      custom_fields: [{ id: F_CID, value: CID_OFFBOARDED }],
    },
  ],
};

// --- Google Ads GAQL fixtures. -----------------------------------------------
const GADS_LABEL_RES = "customers/9999999999/labels/77";
const LSA_LABEL_RES = "customers/9999999999/labels/78";
// NBM_GADS_MONITOR carries the offboarded CID (stale label) + a label-only CID.
// Deliberately NOT the ClickUp-On CID, so the live-mode set and the fallback
// set differ — the resolved set proves WHICH path ran.
const GADS_LABELED_CIDS = [CID_OFFBOARDED, CID_LABEL_ONLY];
// The GAds-only ClickUp CID also carries a stale LSA label. Healthy auto mode
// must suppress that ghost product; outage fallback must retain the label.
const LSA_LABELED_CIDS = [CID_CLICKUP_ON, CID_LABEL_ONLY];
const MCC_ACCOUNTS = [
  { id: CID_CLICKUP_ON, name: "Acme GAds" },
  { id: CID_OFFBOARDED, name: "Gone GAds" },
  { id: CID_LSA, name: "Acme LSA" },
  { id: CID_LABEL_ONLY, name: "Label Only Firm" },
];

// --- fetch stub. --------------------------------------------------------------
let clickUpDown = false;
let clickUpFetches = 0;

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
    if (!isClickUpListFieldPath(pathname)) clickUpFetches++;
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
    return jsonResponse([{ results: [] }]);
  }
  return realFetch(input, init);
}) as typeof fetch;

// --- The modules under test (imported AFTER env + fetch stub). ---------------
const directory = await import("../server/services/adsOs/clickUpDirectory");
const enrollment = await import("../server/services/adsOs/enrollment");

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

const cidSet = (accounts: { cid: string }[]) => new Set(accounts.map((a) => a.cid));

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

// (1) Healthy fetch: bundle built, liveness true, auto mode = ClickUp + union.
console.log("phase 1: healthy ClickUp");
{
  const bundle = await directory.getClientDirectory();
  ok(bundle.clients["acme law"]?.doer === "Dana Doer", "bundle built from fixture (doer resolved)");
  ok(bundle.known.gads.has(CID_OFFBOARDED), "offboarded CID recorded in known set");
  ok(
    (await directory.knownCidsAcrossProducts()).has(CID_CLICKUP_ON),
    "cross-product known-CID set includes the GAds-only ClickUp CID",
  );
  ok(directory.bundleIsLive() === true, "bundleIsLive() true after a successful fetch");

  const monitored = cidSet(await enrollment.monitoredAccounts("gads"));
  assert.deepEqual(
    monitored,
    new Set([CID_CLICKUP_ON, CID_LABEL_ONLY]),
    "live auto mode: ClickUp monitored + label-only union, offboarded excluded",
  );
  passed++;
  console.log("  ✓ live auto mode resolves ClickUp set + label-only union");

  const monitoredLsa = cidSet(await enrollment.monitoredAccounts("lsa"));
  assert.deepEqual(
    monitoredLsa,
    new Set([CID_LSA, CID_LABEL_ONLY]),
    "live auto mode: stale LSA label cannot add a second product to a GAds-known CID",
  );
  passed++;
  console.log("  ✓ live auto mode suppresses the ghost LSA and retains unknown label-only LSA");
}

// (2) Outage after success: refresh fails → stale bundle served, liveness false.
console.log("phase 2: ClickUp outage (post-success)");
{
  clickUpDown = true;
  const before = clickUpFetches;
  const bundle = await directory.getClientDirectory({ force: true });
  ok(clickUpFetches > before, "forced refresh attempted a real fetch");
  ok(bundle.clients["acme law"]?.name === "Acme Law", "stale bundle still served for display");
  ok(directory.bundleIsLive() === false, "bundleIsLive() false once the latest attempt failed");

  const people = await directory.peopleFor("gads", CID_CLICKUP_ON);
  ok(people.client_name === "Acme Law", "stale directory still resolves Doer/Checker display data");

  // (3) Auto fallback: labels minus the remembered-offboarded CID. The
  // ClickUp-On CID is not labeled, so its absence proves the label path ran.
  const monitored = cidSet(await enrollment.monitoredAccounts("gads"));
  assert.deepEqual(
    monitored,
    new Set([CID_LABEL_ONLY]),
    "outage auto mode: label enrollment, offboarded CID stays excluded via stale known set",
  );
  passed++;
  console.log("  ✓ outage auto mode falls back to labels minus remembered-offboarded");

  const monitoredLsa = cidSet(await enrollment.monitoredAccounts("lsa"));
  assert.deepEqual(
    monitoredLsa,
    new Set([CID_CLICKUP_ON, CID_LABEL_ONLY]),
    "outage auto mode retains the label safety net for a CID known only under GAds",
  );
  passed++;
  console.log("  ✓ outage auto mode retains the cross-product label safety net");
}

// (4) Recovery: next successful refresh restores liveness + ClickUp authority.
console.log("phase 3: ClickUp recovers");
{
  clickUpDown = false;
  await directory.getClientDirectory({ force: true });
  ok(directory.bundleIsLive() === true, "bundleIsLive() true again after a successful refresh");

  const monitored = cidSet(await enrollment.monitoredAccounts("gads"));
  assert.deepEqual(
    monitored,
    new Set([CID_CLICKUP_ON, CID_LABEL_ONLY]),
    "recovered auto mode returns to ClickUp authority",
  );
  passed++;
  console.log("  ✓ recovery restores ClickUp authority");

  const monitoredLsa = cidSet(await enrollment.monitoredAccounts("lsa"));
  assert.deepEqual(
    monitoredLsa,
    new Set([CID_LSA, CID_LABEL_ONLY]),
    "recovered auto mode suppresses the stale cross-product LSA label again",
  );
  passed++;
  console.log("  ✓ recovery suppresses the ghost LSA again");
}

console.log(`\nads-os-clickup-liveness: ${passed} assertion(s) passed.`);
