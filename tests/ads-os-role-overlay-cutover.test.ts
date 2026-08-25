/* test-registration
{
  "name": "Ads OS dashboard live overlays — GAds/LSA/combined Practice Areas stay ClickUp-authoritative and cache-safe while role cutover remains batched and preserves non-overlay fields (Tasks #5157 / #5214)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Tasks #5157/#5214: the three cached dashboard payloads must refresh ClickUp-authoritative roles and Practice Areas without rebuilding metrics, leaking stale Practice Areas during directory degradation, or mutating unrelated row fields. The existing in-process resolver seam plus stubbed ClickUp/Google boundaries exercise that full service contract deterministically; only Ads OS store reads use an isolated schema.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small",
  "tierReason": "This extends the existing lowest-cost service harness instead of adding a suite: one fast isolated-schema run, in-process cutover seam, stubbed vendor reads, and no browser, child process, real network, or long-lived timer."
}
test-registration */
/**
 * Task #5157 — Ads OS dashboard read-call wiring for the paid-search role
 * cutover.
 *
 * The four Ads OS dashboards (GAds, LSA, combined, AM) now resolve each
 * client's display Doer/Checker through a single batched resolver,
 * resolvePaidSearchRoleOverlays, instead of using the raw ClickUp
 * doer/checker directly. This suite proves the WIRING in each dashboard file,
 * with the resolver replaced by a counting spy via the per-module test seam
 * (__setRoleOverlayResolverForTest) so:
 *   - no NoBull cutover DB is needed (deterministic, DB-free resolver), and
 *   - the spy can return controlled overlays to drive each scenario.
 *
 * Proven for every dashboard:
 *   (A) LEGACY passthrough — resolver returns an EMPTY map (mode=legacy in
 *       production returns each row's legacy values; an empty map is the
 *       "no entry for any client" shape): every row keeps its ClickUp
 *       doer/checker byte-for-byte.
 *   (B) COMPARE keeps legacy display — resolver returns entries whose
 *       doer/checker EQUAL the legacy values (compare mode displays ClickUp):
 *       roles unchanged, and (critically) all non-role fields unchanged.
 *   (C) UNIVERSAL override — resolver returns different doer/checker for a
 *       matched client: the dashboard shows the resolver's values, NOT legacy.
 *   (D) UNIVERSAL null-after-cutover — resolver returns an entry with
 *       doer:null/checker:null (matched-but-unassigned client under cutover):
 *       the dashboard shows null, and does NOT silently fall back to the
 *       legacy role. This is the core anti-regression of the task.
 *   (E) MISSING entry — resolver returns a map with NO key for a client:
 *       the dashboard falls back to that client's legacy role (old behavior
 *       preserved on a genuine no-entry).
 *   (F) BATCHING — the resolver is invoked exactly ONCE per dashboard build
 *       (one batch), never once per row.
 *   (G) NON-ROLE INVARIANTS — enrollment (rows/members present), ads_status,
 *       budget/pacing fields, ClickUp client_name canonicalization, combined
 *       grouping, LSA city, and the AM Client Log url are byte-for-byte
 *       identical whether the overlay changes roles or not (the overlay
 *       touches ONLY doer/checker).
 *
 * Hermetic: fetch is stubbed in-process (ClickUp + Google OAuth + GAQL). The
 * Ads OS store tables the overlays read are cloned into an isolated schema.
 * The cutover resolver never runs (spy), so no system_settings / clients /
 * users NoBull rows are involved.
 */

import { strict as assert } from "node:assert";
import {
  isClickUpListFieldPath,
} from "./helpers/clickUpPracticeAreaFixture";

// --- Env BEFORE any module import -------------------------------------------
process.env.NODE_ENV = "test";
process.env.CLICKUP_API_TOKEN = "pk_fake_role_overlay_test";
process.env.ACCOUNT_ENROLLMENT = "auto";
process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "fake-dev-token";
process.env.GOOGLE_ADS_CLIENT_ID = "fake-client-id";
process.env.GOOGLE_ADS_CLIENT_SECRET = "fake-client-secret";
process.env.GOOGLE_ADS_REFRESH_TOKEN = "fake-refresh-token";
process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = "9999999999";

// --- ClickUp Client List fixture (config default field ids) -----------------
const F_CID = "a886aa6f-c7f8-41cc-940b-8afef551bf49";
const F_ADS_STATUS = "e8717288-345d-4a2b-8169-0992b78bc809";
const F_DOER = "21335dc5-98ba-470c-b8a9-944e3cfed343";
const F_CHECKER = "0bfb4a38-47e4-4343-bb83-051a9fd40122";
const F_LOG = "0d573e9c-d786-44f4-a5d3-ac86c20e7510";
const F_PRACTICE_AREA = "237317f2-e612-4983-baf7-97166de73a77";

const PRACTICE_AREA_IDS = {
  immigration: "pa-immigration",
  family: "pa-family",
  criminal: "pa-criminal",
} as const;
const PRACTICE_AREA_FIELDS = {
  fields: [
    {
      id: F_PRACTICE_AREA,
      name: "Practice Area",
      type: "labels",
      type_config: {
        options: [
          { id: PRACTICE_AREA_IDS.criminal, label: "Criminal Defense", orderindex: 2 },
          { id: PRACTICE_AREA_IDS.immigration, label: "Immigration", orderindex: 0 },
          { id: PRACTICE_AREA_IDS.family, label: "Family", orderindex: 1 },
        ],
      },
    },
  ],
};
const alphaPracticeAreaIds: string[] = [
  PRACTICE_AREA_IDS.criminal,
  PRACTICE_AREA_IDS.family,
];
function setAlphaPracticeAreas(ids: string[]): void {
  alphaPracticeAreaIds.splice(0, alphaPracticeAreaIds.length, ...ids);
}

const ADS_STATUS_TYPE_CONFIG = {
  options: [
    { id: "opt_on", name: "On", orderindex: 0 },
    { id: "opt_paused", name: "Paused", orderindex: 1 },
    { id: "opt_off", name: "Off", orderindex: 2 },
  ],
};
const adsStatusField = (optId: string | null) => ({
  id: F_ADS_STATUS,
  value: optId,
  type_config: ADS_STATUS_TYPE_CONFIG,
});

// Two clients:
//  - "Alpha Client": legacy doer/checker + log_url, one GAds + one LSA account
//    (LSA carries a "(City)" suffix so combined/AM city stays intact).
//  - "Beta Client": legacy doer/checker + log_url, one GAds account (paused).
const CID_ALPHA_G = "1111111111";
const CID_ALPHA_L = "2222222222";
const CID_BETA_G = "3333333333";

const ALPHA_DOER = "Alice Alpha";
const ALPHA_CHECKER = "Aaron Check";
const BETA_DOER = "Bob Beta";
const BETA_CHECKER = "Ben Check";
const ALPHA_LOG = "https://app.clickup.com/log/alpha";
const BETA_LOG = "https://app.clickup.com/log/beta";

const CLICKUP_TASKS = {
  last_page: true,
  tasks: [
    {
      id: "p-alpha",
      name: "Alpha Client",
      status: { status: "open" },
      custom_fields: [
        { id: F_DOER, value: [{ username: ALPHA_DOER }] },
        { id: F_CHECKER, value: [{ username: ALPHA_CHECKER }] },
        { id: F_LOG, value: ALPHA_LOG },
        { id: F_PRACTICE_AREA, value: alphaPracticeAreaIds },
      ],
    },
    {
      id: "s-alpha-g",
      parent: "p-alpha",
      name: "GOOGLE ADS – Alpha",
      custom_fields: [{ id: F_CID, value: CID_ALPHA_G }, adsStatusField(null)], // on
    },
    {
      id: "s-alpha-l",
      parent: "p-alpha",
      name: "LSA (Springfield)",
      custom_fields: [{ id: F_CID, value: CID_ALPHA_L }, adsStatusField(null)], // on
    },
    {
      id: "p-beta",
      name: "Beta Client",
      status: { status: "open" },
      custom_fields: [
        { id: F_DOER, value: [{ username: BETA_DOER }] },
        { id: F_CHECKER, value: [{ username: BETA_CHECKER }] },
        { id: F_LOG, value: BETA_LOG },
      ],
    },
    {
      id: "s-beta-g",
      parent: "p-beta",
      name: "GOOGLE ADS – Beta",
      custom_fields: [{ id: F_CID, value: CID_BETA_G }, adsStatusField("opt_paused")], // paused
    },
  ],
};

const GADS_LABEL_RES = "customers/9999999999/labels/77";
const LSA_LABEL_RES = "customers/9999999999/labels/78";

// MCC-enabled accounts (id/name/currency) — reused by both products.
const MCC_ACCOUNTS = [
  { id: CID_ALPHA_G, name: "Alpha GAds", currency: "USD" },
  { id: CID_ALPHA_L, name: "Alpha LSA", currency: "USD" },
  { id: CID_BETA_G, name: "Beta GAds", currency: "USD" },
];

// --- fetch stub (ClickUp + Google OAuth + GAQL) -----------------------------
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const realFetch = globalThis.fetch;
let clickUpReadOutage = false;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === "string" ? input : input?.url ?? input);
  // Dispatch on URL *path shape*, never on live vendor hostnames — naming the
  // real API hosts here would make this test a net-new raw vendor-host caller
  // under lint-vendor-confinement (same convention as the sibling Ads OS
  // dashboard suites).
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Non-absolute input: fall through to realFetch below.
  }

  if (pathname.startsWith("/api/v2/")) {
    if (clickUpReadOutage) {
      return jsonResponse({ err: "stubbed ClickUp outage" }, 503);
    }
    if (isClickUpListFieldPath(pathname)) {
      return jsonResponse(PRACTICE_AREA_FIELDS);
    }
    return jsonResponse(CLICKUP_TASKS);
  }
  if (pathname === "/token") {
    return jsonResponse({ access_token: "fake-access", expires_in: 3599 });
  }
  if (pathname.includes("googleAds:search")) {
    const cid = url.match(/customers\/(\d+)\//)?.[1] ?? "";
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
              appliedLabels: a.id === CID_ALPHA_L ? [LSA_LABEL_RES] : [GADS_LABEL_RES],
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
    // campaign/metric/status queries → empty (zeros; ads_running=false), which
    // is fine: this suite never asserts on spend, only on role wiring +
    // invariants that hold regardless of metrics.
    return jsonResponse([{ results: [] }]);
  }
  return realFetch(input, init);
}) as typeof fetch;

// --- Modules under test (imported AFTER env + fetch stub) -------------------
const directory = await import("../server/services/adsOs/clickUpDirectory");
const gads = await import("../server/services/adsOs/dashboardService");
const lsa = await import("../server/services/adsOs/lsaDashboardService");
const combined = await import("../server/services/adsOs/combinedDashboardService");
const am = await import("../server/services/adsOs/amDashboard");
const { runInIsolatedSchema } = await import("./db-sandbox");

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

const { normClientName } = directory;

// --- Spy resolver -----------------------------------------------------------
type OverlayInput = { clientName: string; legacyDoer: string | null; legacyChecker: string | null };
type OverlayOut = Map<string, { doer: string | null; checker: string | null }>;
type Resolver = (inputs: OverlayInput[]) => Promise<OverlayOut>;

let spyCalls: OverlayInput[][] = [];
/** Install a spy that records every batch and returns `build(inputs)`. */
function installSpy(build: (inputs: OverlayInput[]) => OverlayOut): void {
  spyCalls = [];
  const spy: Resolver = async (inputs) => {
    spyCalls.push(inputs);
    return build(inputs);
  };
  gads.__setRoleOverlayResolverForTest(spy as any);
  lsa.__setRoleOverlayResolverForTest(spy as any);
  combined.__setRoleOverlayResolverForTest(spy as any);
  am.__setRoleOverlayResolverForTest(spy as any);
}
function clearSpy(): void {
  gads.__setRoleOverlayResolverForTest(null);
  lsa.__setRoleOverlayResolverForTest(null);
  combined.__setRoleOverlayResolverForTest(null);
  am.__setRoleOverlayResolverForTest(null);
}

// Overlay builders for each scenario. Keyed by NORMALIZED client name, matching
// the resolver's real contract (and what the dashboards look up).
const emptyMap = (): OverlayOut => new Map();
const legacyEchoMap = (inputs: OverlayInput[]): OverlayOut => {
  // COMPARE mode shape: display the legacy values.
  const m: OverlayOut = new Map();
  for (const i of inputs) {
    m.set(normClientName(i.clientName), { doer: i.legacyDoer, checker: i.legacyChecker });
  }
  return m;
};

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

function same(actual: unknown, expected: unknown, label: string): void {
  assert.deepEqual(actual, expected, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

// Tables every overlay reads. Cloned so store reads don't fall through to the
// real public tables (isolated-schema fallthrough gotcha).
const STORE_TABLES = [
  "ads_os_status_checks",
  "ads_os_account_alerts",
  "ads_os_clickup_tasks",
  "ads_os_audit_scores",
  "ads_os_budget_pacing",
  "ads_os_traffic_quality",
  "ads_os_clients_criteria",
  "ads_os_lsa_audit_scores",
  "ads_os_lsa_budget_pacing",
] as const;

/** Reset every dashboard's metrics cache so each build re-runs the overlay. */
function resetCaches(): void {
  gads.__testResetDashboardCache();
  lsa.__testResetLsaDashboardCache();
  combined.__testResetCombinedDashboardCache();
}

// ---------------------------------------------------------------------------
// GAds dashboard
// ---------------------------------------------------------------------------
async function testGads(): Promise<void> {
  console.log("── GAds dashboard ──");

  // (A) legacy passthrough — empty map ⇒ legacy roles preserved.
  installSpy(emptyMap);
  resetCaches();
  await directory.getClientDirectory({ force: true });
  let { resp } = await gads.buildDashboardCached(true);
  let alpha = resp.rows.find((r: any) => r.customer_id === CID_ALPHA_G)!;
  let beta = resp.rows.find((r: any) => r.customer_id === CID_BETA_G)!;
  ok(!!alpha && !!beta, "GAds: both enrolled accounts present (enrollment untouched)");
  ok(spyCalls.length === 1, "GAds: resolver called exactly ONCE per build (batched, not per row)");
  ok(spyCalls[0].length === resp.rows.length, "GAds: the single batch carried every row");
  ok(
    alpha.doer === ALPHA_DOER && alpha.checker === ALPHA_CHECKER,
    "GAds (empty map): Alpha keeps legacy doer/checker",
  );
  ok(
    beta.doer === BETA_DOER && beta.checker === BETA_CHECKER,
    "GAds (empty map): Beta keeps legacy doer/checker",
  );

  // Snapshot the non-role fields of Alpha's row for a byte-for-byte comparison
  // across overlay scenarios (roles excluded — they are the only mutable field).
  const nonRole = (r: any) => {
    const { doer, checker, ...rest } = r;
    return JSON.stringify(rest);
  };
  const alphaNonRoleBaseline = nonRole(alpha);
  const alphaStatusBaseline = alpha.ads_status;
  const betaStatusBaseline = beta.ads_status;

  // (B) compare — resolver echoes legacy ⇒ roles + all fields unchanged.
  installSpy(legacyEchoMap);
  resetCaches();
  ({ resp } = await gads.buildDashboardCached(true));
  alpha = resp.rows.find((r: any) => r.customer_id === CID_ALPHA_G)!;
  ok(spyCalls.length === 1, "GAds (compare): resolver still called once per build");
  ok(
    alpha.doer === ALPHA_DOER && alpha.checker === ALPHA_CHECKER,
    "GAds (compare echoes legacy): roles display legacy values",
  );
  ok(
    nonRole(alpha) === alphaNonRoleBaseline,
    "GAds (compare): every NON-role field byte-for-byte identical to legacy build",
  );

  // (C)+(D)+(E) universal override + null-after-cutover + missing entry.
  //  - Alpha: universal override (different names) ⇒ show universal, not legacy.
  //  - Beta:  matched-but-unassigned (null/null) ⇒ show null, NOT legacy.
  //  Also verify a MISSING entry (drop Beta from the map) falls back to legacy —
  //  done as a separate build below to keep the two cases unambiguous.
  installSpy((inputs) => {
    const m: OverlayOut = new Map();
    for (const i of inputs) {
      const key = normClientName(i.clientName);
      if (key === normClientName("Alpha Client")) m.set(key, { doer: "U-Doer", checker: "U-Checker" });
      else if (key === normClientName("Beta Client")) m.set(key, { doer: null, checker: null });
    }
    return m;
  });
  resetCaches();
  ({ resp } = await gads.buildDashboardCached(true));
  alpha = resp.rows.find((r: any) => r.customer_id === CID_ALPHA_G)!;
  beta = resp.rows.find((r: any) => r.customer_id === CID_BETA_G)!;
  ok(
    alpha.doer === "U-Doer" && alpha.checker === "U-Checker",
    "GAds (universal): Alpha shows the resolver's roles, NOT the legacy ClickUp names",
  );
  ok(
    beta.doer === null && beta.checker === null,
    "GAds (universal null-after-cutover): Beta shows null, does NOT silently keep the legacy role",
  );
  // Non-role fields must STILL be identical even when roles were overridden.
  ok(
    nonRole(alpha) === alphaNonRoleBaseline,
    "GAds (universal): overriding roles leaves every non-role field unchanged",
  );
  ok(
    alpha.ads_status === alphaStatusBaseline && beta.ads_status === betaStatusBaseline,
    "GAds: ads_status unchanged by the role overlay (paused stays paused)",
  );

  // (E) missing entry ⇒ legacy fallback. Map has ONLY Alpha; Beta absent.
  installSpy((inputs) => {
    const m: OverlayOut = new Map();
    for (const i of inputs) {
      const key = normClientName(i.clientName);
      if (key === normClientName("Alpha Client")) m.set(key, { doer: "U-Doer", checker: "U-Checker" });
      // Beta deliberately absent → overlays.get() is undefined → legacy fallback.
    }
    return m;
  });
  resetCaches();
  ({ resp } = await gads.buildDashboardCached(true));
  beta = resp.rows.find((r: any) => r.customer_id === CID_BETA_G)!;
  ok(
    beta.doer === BETA_DOER && beta.checker === BETA_CHECKER,
    "GAds (missing entry): Beta falls back to its legacy role (old behavior preserved)",
  );
}

// ---------------------------------------------------------------------------
// LSA dashboard
// ---------------------------------------------------------------------------
async function testLsa(): Promise<void> {
  console.log("── LSA dashboard ──");

  installSpy(emptyMap);
  resetCaches();
  await directory.getClientDirectory({ force: true });
  let { resp } = await lsa.buildLsaDashboardCached(true);
  let alpha = resp.rows.find((r: any) => r.customer_id === CID_ALPHA_L)!;
  ok(!!alpha, "LSA: enrolled LSA account present (enrollment untouched)");
  ok(spyCalls.length === 1, "LSA: resolver called exactly ONCE per build (batched, not per row)");
  ok(
    alpha.doer === ALPHA_DOER && alpha.checker === ALPHA_CHECKER,
    "LSA (empty map): Alpha keeps legacy doer/checker",
  );
  const cityBaseline = alpha.lsa_city;
  const nonRole = (r: any) => {
    const { doer, checker, ...rest } = r;
    return JSON.stringify(rest);
  };
  const nonRoleBaseline = nonRole(alpha);

  // universal override + non-role invariants (incl. LSA city).
  installSpy((inputs) => {
    const m: OverlayOut = new Map();
    for (const i of inputs) {
      const key = normClientName(i.clientName);
      if (key === normClientName("Alpha Client")) m.set(key, { doer: "U-Doer", checker: "U-Checker" });
    }
    return m;
  });
  resetCaches();
  ({ resp } = await lsa.buildLsaDashboardCached(true));
  alpha = resp.rows.find((r: any) => r.customer_id === CID_ALPHA_L)!;
  ok(spyCalls.length === 1, "LSA (universal): resolver still called once per build");
  ok(
    alpha.doer === "U-Doer" && alpha.checker === "U-Checker",
    "LSA (universal): Alpha shows the resolver's roles, NOT legacy",
  );
  ok(alpha.lsa_city === cityBaseline, "LSA: lsa_city unchanged by the role overlay");
  ok(
    nonRole(alpha) === nonRoleBaseline,
    "LSA (universal): every non-role field byte-for-byte identical to legacy build",
  );

  // null-after-cutover ⇒ null, not legacy.
  installSpy((inputs) => {
    const m: OverlayOut = new Map();
    for (const i of inputs) m.set(normClientName(i.clientName), { doer: null, checker: null });
    return m;
  });
  resetCaches();
  ({ resp } = await lsa.buildLsaDashboardCached(true));
  alpha = resp.rows.find((r: any) => r.customer_id === CID_ALPHA_L)!;
  ok(
    alpha.doer === null && alpha.checker === null,
    "LSA (universal null-after-cutover): Alpha shows null, does NOT keep the legacy role",
  );

  // missing entry ⇒ legacy fallback.
  installSpy(emptyMap);
  resetCaches();
  ({ resp } = await lsa.buildLsaDashboardCached(true));
  alpha = resp.rows.find((r: any) => r.customer_id === CID_ALPHA_L)!;
  ok(
    alpha.doer === ALPHA_DOER && alpha.checker === ALPHA_CHECKER,
    "LSA (missing entry): Alpha falls back to its legacy role",
  );
}

// ---------------------------------------------------------------------------
// Combined dashboard (client profile inherits this overlay)
// ---------------------------------------------------------------------------
async function testCombined(): Promise<void> {
  console.log("── Combined dashboard ──");

  installSpy(emptyMap);
  resetCaches();
  await directory.getClientDirectory({ force: true });
  let { resp } = await combined.buildCombinedDashboardCached(true);
  let alpha = resp.rows.find((r: any) => r.client === "Alpha Client")!;
  let beta = resp.rows.find((r: any) => r.client === "Beta Client")!;
  ok(!!alpha && !!beta, "Combined: both client rows present (grouping untouched)");
  ok(spyCalls.length === 1, "Combined: resolver called exactly ONCE per build (batched, not per row)");
  ok(spyCalls[0].length === resp.rows.length, "Combined: the single batch carried every client row");
  ok(
    alpha.doer === ALPHA_DOER && alpha.checker === ALPHA_CHECKER,
    "Combined (empty map): Alpha keeps legacy doer/checker",
  );

  // Baseline: canonical client name + grouping + member set (city on LSA member).
  const clientNamesBaseline = resp.rows.map((r: any) => r.client).sort();
  const alphaMemberCids = alpha.members.map((m: any) => m.customer_id).sort();
  const alphaLsaMember = alpha.members.find((m: any) => m.product === "lsa");
  const alphaCityBaseline = alphaLsaMember?.city ?? null;
  const nonRole = (r: any) => {
    const { doer, checker, ...rest } = r;
    return JSON.stringify(rest);
  };
  const alphaNonRoleBaseline = nonRole(alpha);

  // universal override for Alpha, null-after-cutover for Beta.
  installSpy((inputs) => {
    const m: OverlayOut = new Map();
    for (const i of inputs) {
      const key = normClientName(i.clientName);
      if (key === normClientName("Alpha Client")) m.set(key, { doer: "U-Doer", checker: "U-Checker" });
      else if (key === normClientName("Beta Client")) m.set(key, { doer: null, checker: null });
    }
    return m;
  });
  resetCaches();
  ({ resp } = await combined.buildCombinedDashboardCached(true));
  alpha = resp.rows.find((r: any) => r.client === "Alpha Client")!;
  beta = resp.rows.find((r: any) => r.client === "Beta Client")!;
  ok(spyCalls.length === 1, "Combined (universal): resolver still called once per build");
  ok(
    alpha.doer === "U-Doer" && alpha.checker === "U-Checker",
    "Combined (universal): Alpha shows the resolver's roles, NOT legacy",
  );
  ok(
    beta.doer === null && beta.checker === null,
    "Combined (universal null-after-cutover): Beta shows null, does NOT keep the legacy role",
  );
  ok(
    JSON.stringify(resp.rows.map((r: any) => r.client).sort()) === JSON.stringify(clientNamesBaseline),
    "Combined: canonical client names / grouping unchanged by the role overlay",
  );
  ok(
    JSON.stringify(alpha.members.map((m: any) => m.customer_id).sort()) === JSON.stringify(alphaMemberCids),
    "Combined: member set (accounts per client) unchanged by the role overlay",
  );
  ok(
    (alpha.members.find((m: any) => m.product === "lsa")?.city ?? null) === alphaCityBaseline,
    "Combined: LSA member city unchanged by the role overlay",
  );
  ok(
    nonRole(alpha) === alphaNonRoleBaseline,
    "Combined (universal): every non-role field (incl. members) byte-for-byte identical",
  );

  // missing entry ⇒ legacy fallback.
  installSpy((inputs) => {
    const m: OverlayOut = new Map();
    for (const i of inputs) {
      const key = normClientName(i.clientName);
      if (key === normClientName("Alpha Client")) m.set(key, { doer: "U-Doer", checker: "U-Checker" });
      // Beta absent.
    }
    return m;
  });
  resetCaches();
  ({ resp } = await combined.buildCombinedDashboardCached(true));
  beta = resp.rows.find((r: any) => r.client === "Beta Client")!;
  ok(
    beta.doer === BETA_DOER && beta.checker === BETA_CHECKER,
    "Combined (missing entry): Beta falls back to its legacy role",
  );
}

// ---------------------------------------------------------------------------
// Practice Area live payload contract (GAds / LSA / combined)
// ---------------------------------------------------------------------------
async function testPracticeAreaPayloads(): Promise<void> {
  console.log("── Practice Area payload overlays ──");

  installSpy(emptyMap);
  setAlphaPracticeAreas([
    PRACTICE_AREA_IDS.criminal,
    PRACTICE_AREA_IDS.family,
  ]);
  clickUpReadOutage = false;
  await directory.getClientDirectory({ force: true, throwOnError: true });
  resetCaches();

  const initialGads = await gads.buildDashboardCached(true);
  const initialLsa = await lsa.buildLsaDashboardCached(true);
  const initialCombined = await combined.buildCombinedDashboardCached(true);
  const gadsAlpha = initialGads.resp.rows.find((r: any) => r.customer_id === CID_ALPHA_G)!;
  const gadsBeta = initialGads.resp.rows.find((r: any) => r.customer_id === CID_BETA_G)!;
  const lsaAlpha = initialLsa.resp.rows.find((r: any) => r.customer_id === CID_ALPHA_L)!;
  const combinedAlpha = initialCombined.resp.rows.find((r: any) => r.client === "Alpha Client")!;
  const combinedBeta = initialCombined.resp.rows.find((r: any) => r.client === "Beta Client")!;

  same(
    gadsAlpha.practice_areas,
    ["Family", "Criminal Defense"],
    "GAds: account row maps its parent selection in canonical option order",
  );
  same(gadsBeta.practice_areas, [], "GAds: parent with no selection receives an empty array");
  same(
    await directory.dashboardPracticeAreasForCids(["999-000-9999"]),
    [],
    "unmapped account CIDs receive an empty array without local-data inference",
  );
  same(
    lsaAlpha.practice_areas,
    ["Family", "Criminal Defense"],
    "LSA: account row maps the same parent selection in canonical option order",
  );
  same(
    combinedAlpha.practice_areas,
    ["Family", "Criminal Defense"],
    "Combined: two member CIDs deduplicate into one canonical-order union",
  );
  same(combinedBeta.practice_areas, [], "Combined: parent with no selection receives an empty array");

  const withoutPracticeAreas = (row: any): string => {
    const { practice_areas, ...rest } = row;
    return JSON.stringify(rest);
  };
  const baselines = {
    gads: withoutPracticeAreas(gadsAlpha),
    lsa: withoutPracticeAreas(lsaAlpha),
    combined: withoutPracticeAreas(combinedAlpha),
  };

  setAlphaPracticeAreas([
    PRACTICE_AREA_IDS.family,
    PRACTICE_AREA_IDS.immigration,
  ]);
  await directory.getClientDirectory({ force: true, throwOnError: true });
  const updatedGads = await gads.buildDashboardCached(false);
  const updatedLsa = await lsa.buildLsaDashboardCached(false);
  const updatedCombined = await combined.buildCombinedDashboardCached(false);
  ok(
    updatedGads.fromCache && updatedLsa.fromCache && updatedCombined.fromCache,
    "all three Practice Area overlays run on cached metrics responses",
  );

  const updatedGadsAlpha = updatedGads.resp.rows.find((r: any) => r.customer_id === CID_ALPHA_G)!;
  const updatedLsaAlpha = updatedLsa.resp.rows.find((r: any) => r.customer_id === CID_ALPHA_L)!;
  const updatedCombinedAlpha = updatedCombined.resp.rows.find((r: any) => r.client === "Alpha Client")!;
  for (const [label, row] of [
    ["GAds", updatedGadsAlpha],
    ["LSA", updatedLsaAlpha],
    ["Combined", updatedCombinedAlpha],
  ] as const) {
    same(
      row.practice_areas,
      ["Immigration", "Family"],
      `${label}: directory change overlays cached metrics in canonical order`,
    );
  }
  ok(
    withoutPracticeAreas(updatedGadsAlpha) === baselines.gads &&
      withoutPracticeAreas(updatedLsaAlpha) === baselines.lsa &&
      withoutPracticeAreas(updatedCombinedAlpha) === baselines.combined,
    "directory-only change leaves every non-Practice-Area field byte-for-byte unchanged",
  );

  clickUpReadOutage = true;
  await directory.getClientDirectory({ force: true });
  const degradedGads = await gads.buildDashboardCached(false);
  const degradedLsa = await lsa.buildLsaDashboardCached(false);
  const degradedCombined = await combined.buildCombinedDashboardCached(false);
  same(
    degradedGads.resp.rows.find((r: any) => r.customer_id === CID_ALPHA_G)!.practice_areas,
    [],
    "GAds: degraded directory fails closed to an empty array",
  );
  same(
    degradedLsa.resp.rows.find((r: any) => r.customer_id === CID_ALPHA_L)!.practice_areas,
    [],
    "LSA: degraded directory fails closed to an empty array",
  );
  same(
    degradedCombined.resp.rows.find((r: any) => r.client === "Alpha Client")!.practice_areas,
    [],
    "Combined: degraded directory fails closed to an empty array",
  );

  clickUpReadOutage = false;
  setAlphaPracticeAreas([
    PRACTICE_AREA_IDS.criminal,
    PRACTICE_AREA_IDS.family,
  ]);
  await directory.getClientDirectory({ force: true, throwOnError: true });
}

// ---------------------------------------------------------------------------
// AM dashboard (cards + filter options)
// ---------------------------------------------------------------------------
async function testAm(): Promise<void> {
  console.log("── AM dashboard ──");

  installSpy(emptyMap);
  await directory.getClientDirectory({ force: true });
  let payload = await am.buildAmDashboard();
  let alpha = payload.clients.find((c: any) => c.client === "Alpha Client")!;
  let beta = payload.clients.find((c: any) => c.client === "Beta Client")!;
  ok(!!alpha && !!beta, "AM: both client cards present (roster untouched)");
  ok(spyCalls.length === 1, "AM: resolver called exactly ONCE per build (batched, not per client)");
  ok(spyCalls[0].length === payload.clients.length, "AM: the single batch carried every client card");
  ok(
    alpha.doer === ALPHA_DOER && alpha.checker === ALPHA_CHECKER,
    "AM (empty map): Alpha keeps legacy doer/checker",
  );
  // Client Log link must come from ClickUp and never be touched by the overlay.
  ok(alpha.log_url === ALPHA_LOG && beta.log_url === BETA_LOG, "AM: Client Log url from ClickUp, untouched");
  // Filter options derive from the (legacy) roles here.
  assert.deepEqual(
    [...payload.managers].sort(),
    [ALPHA_DOER, BETA_DOER].sort(),
    "AM (empty map): manager filter options derive from legacy doers",
  );
  passed++;
  assert.deepEqual(
    [...payload.checkers].sort(),
    [ALPHA_CHECKER, BETA_CHECKER].sort(),
    "AM (empty map): checker filter options derive from legacy checkers",
  );
  passed++;

  const acctsBaseline = JSON.stringify(
    alpha.accounts.map((a: any) => ({ p: a.product, cid: a.customer_id, s: a.ads_status, l: a.label })),
  );

  // universal override for Alpha, null-after-cutover for Beta.
  installSpy((inputs) => {
    const m: OverlayOut = new Map();
    for (const i of inputs) {
      const key = normClientName(i.clientName);
      if (key === normClientName("Alpha Client")) m.set(key, { doer: "U-Doer", checker: "U-Checker" });
      else if (key === normClientName("Beta Client")) m.set(key, { doer: null, checker: null });
    }
    return m;
  });
  payload = await am.buildAmDashboard();
  alpha = payload.clients.find((c: any) => c.client === "Alpha Client")!;
  beta = payload.clients.find((c: any) => c.client === "Beta Client")!;
  ok(spyCalls.length === 1, "AM (universal): resolver still called once per build");
  ok(
    alpha.doer === "U-Doer" && alpha.checker === "U-Checker",
    "AM (universal): Alpha card shows the resolver's roles, NOT legacy",
  );
  ok(
    beta.doer === null && beta.checker === null,
    "AM (universal null-after-cutover): Beta card shows null, does NOT keep the legacy role",
  );
  // Filter options now reflect the OVERLAID roles (cards + filters share one source).
  assert.deepEqual(payload.managers, ["U-Doer"], "AM (universal): manager options reflect overlaid doer (Beta null dropped)");
  passed++;
  assert.deepEqual(payload.checkers, ["U-Checker"], "AM (universal): checker options reflect overlaid checker (Beta null dropped)");
  passed++;
  ok(alpha.log_url === ALPHA_LOG, "AM (universal): Client Log url still from ClickUp, untouched");
  ok(
    JSON.stringify(
      alpha.accounts.map((a: any) => ({ p: a.product, cid: a.customer_id, s: a.ads_status, l: a.label })),
    ) === acctsBaseline,
    "AM (universal): account list / ads_status / labels unchanged by the role overlay",
  );

  // missing entry ⇒ legacy fallback.
  installSpy((inputs) => {
    const m: OverlayOut = new Map();
    for (const i of inputs) {
      const key = normClientName(i.clientName);
      if (key === normClientName("Alpha Client")) m.set(key, { doer: "U-Doer", checker: "U-Checker" });
      // Beta absent.
    }
    return m;
  });
  payload = await am.buildAmDashboard();
  beta = payload.clients.find((c: any) => c.client === "Beta Client")!;
  ok(
    beta.doer === BETA_DOER && beta.checker === BETA_CHECKER,
    "AM (missing entry): Beta card falls back to its legacy role",
  );
}

// ---------------------------------------------------------------------------
await runInIsolatedSchema(
  async () => {
    await testGads();
    await testLsa();
    await testCombined();
    await testPracticeAreaPayloads();
    await testAm();
  },
  { tables: [...STORE_TABLES], pinGetDbForCrossAsync: true },
);

clearSpy();
resetCaches();
globalThis.fetch = realFetch;

console.log(`\nads-os-role-overlay-cutover: ${passed} assertion(s) passed (Tasks #5157/#5214).`);
