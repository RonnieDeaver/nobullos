/* test-registration
{
  "name": "Ads OS combined pacing aggregation + Off-account freshness — counted unbudgeted spend contributes to total MTD, budget/expected stay budget-only, stale Off records are excluded, and reconciliation fields identify included members",
  "regression": true,
  "sweepOnlyReason": "Combined pacing contract — Off-account freshness, unbudgeted-spend aggregation, and reconciliation overlay fields require the isolated pacing/criteria stores plus a full combined-dashboard build; not a smoke-gate candidate.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Ads OS — Off-account pacing freshness guard (Task #3613).
 *
 * The Main (combined) dashboard's pacing overlay counts an Off account toward
 * the client's blended budget/MTD/pace ONLY while its stored pacing record has
 * month-to-date spend AND that record was generated in the CURRENT calendar
 * month (combinedDashboardService.isCurrentMonth). A wound-down Off account
 * whose pacing stops being persisted would otherwise freeze last month's
 * mtd_spend and leak it into the client total forever (hand-reasoned in Phase
 * 2, Task #3598 — this is its dedicated regression test).
 *
 * Scenario (both store tables, both roles):
 *   Client "Acme Law":
 *     - G_ON        GAds, status On,  current-month record  → always counts
 *     - G_OFF_FRESH GAds, status Off, current-month record, mtd>0 → counts
 *     - L_OFF_STALE LSA,  status Off, PRIOR-month record, mtd>0 → must NOT
 *       count (no budget, no mtd, no expected contribution; not "shown")
 *   Client "Beta Firm":
 *     - G_OFF_STALE GAds, status Off, PRIOR-month record → must NOT count
 *     - L_OFF_FRESH LSA,  status Off, current-month record → counts
 *
 * Asserts the combined blend math (expected-to-date weighting) exactly — a
 * leaked stale record would shift pacing_budget/pacing_mtd/pacing_pct — plus
 * the member-level exclusion (has_gads/has_lsa/has_active_monitoring reflect
 * only fresh-or-On members; the stale member's own pacing fields stay attached
 * for the hover breakdown but contribute nothing to the row).
 *
 * Task #3897 rides the same build: the overlay attaches per-member
 * reconciliation fields for the combined pill's breakdown — expected-to-date,
 * budget_source (from the store doc; absent → null), the applied schedule
 * (GAds: the stored run's schedule_days + schedule_source; LSA: a live
 * criteria-store read — saved days, else the every-day default), and
 * generated_at. Asserted per member shape: a modern GAds doc, a LEGACY GAds
 * doc persisted before the fields existed (all null, never a crash), an LSA
 * member with saved criteria + sheet budget source, and a criteria-less LSA
 * member whose prior-month generated_at stays attached so the UI can flag the
 * stale run.
 *
 * Hermetic: runInIsolatedSchema clones the pacing store + criteria tables
 * (pinGetDbForCrossAsync so the service's store reads hit the clones); all
 * network (ClickUp directory + Google OAuth/GAQL) is fetch-stubbed in-process.
 * GAQL metric queries return empty results, so every member has zero window
 * spend — the Off members' visibility is decided purely by the store guard.
 */

import { strict as assert } from "node:assert";
import {
  EMPTY_CLICKUP_PRACTICE_AREA_FIELDS,
  isClickUpListFieldPath,
} from "./helpers/clickUpPracticeAreaFixture";

// --- Env BEFORE any module import: config constants read at load time. ------
process.env.NODE_ENV = "test";
process.env.CLICKUP_API_TOKEN = "pk_fake_3613";
process.env.ACCOUNT_ENROLLMENT = "clickup"; // ClickUp-authoritative; no label-union GAQL
process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "fake-dev-token";
process.env.GOOGLE_ADS_CLIENT_ID = "fake-client-id";
process.env.GOOGLE_ADS_CLIENT_SECRET = "fake-client-secret";
process.env.GOOGLE_ADS_REFRESH_TOKEN = "fake-refresh-token";
process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = "9999999999";

// ── CIDs ─────────────────────────────────────────────────────────────────────

const G_ON = "3613000001";
const G_OFF_FRESH = "3613000002";
const L_OFF_STALE = "3613000003";
const G_OFF_STALE = "3613000004";
const L_OFF_FRESH = "3613000005";
const L_ON_NO_BUDGET = "3613000006";

const MCC_ACCOUNTS = [
  { id: G_ON, name: "Acme GAds On" },
  { id: G_OFF_FRESH, name: "Acme GAds Off Fresh" },
  { id: L_OFF_STALE, name: "Acme LSA Off Stale" },
  { id: G_OFF_STALE, name: "Beta GAds Off Stale" },
  { id: L_OFF_FRESH, name: "Beta LSA Off Fresh" },
  { id: L_ON_NO_BUDGET, name: "Acme LSA On No Budget" },
];

// --- ClickUp Client List fixture (config default field ids). ----------------
const F_CID = "a886aa6f-c7f8-41cc-940b-8afef551bf49";
const F_STATUS = "e8717288-345d-4a2b-8169-0992b78bc809";

const statusField = (optName: "On" | "Off") => ({
  id: F_STATUS,
  value: `opt-${optName.toLowerCase()}`,
  type_config: {
    options: [
      { id: "opt-on", name: "On", orderindex: 0 },
      { id: "opt-off", name: "Off", orderindex: 1 },
    ],
  },
});

const gadsSub = (id: string, parent: string, cid: string, status: "On" | "Off") => ({
  id, parent, name: `GOOGLE ADS – ${id}`,
  custom_fields: [{ id: F_CID, value: cid }, statusField(status)],
});
const lsaSub = (id: string, parent: string, cid: string, status: "On" | "Off") => ({
  id, parent, name: `LSA (Testville ${id})`,
  custom_fields: [{ id: F_CID, value: cid }, statusField(status)],
});

const CLICKUP_TASKS = {
  last_page: true,
  tasks: [
    { id: "p1", name: "Acme Law", status: { status: "open" }, custom_fields: [] },
    gadsSub("s1", "p1", G_ON, "On"),
    gadsSub("s2", "p1", G_OFF_FRESH, "Off"),
    lsaSub("s3", "p1", L_OFF_STALE, "Off"),
    lsaSub("s6", "p1", L_ON_NO_BUDGET, "On"),
    { id: "p2", name: "Beta Firm", status: { status: "open" }, custom_fields: [] },
    gadsSub("s4", "p2", G_OFF_STALE, "Off"),
    lsaSub("s5", "p2", L_OFF_FRESH, "Off"),
  ],
};

// --- fetch stub (ClickUp + Google OAuth + GAQL; nothing else leaves). --------

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
    if (query.includes("FROM customer_client")) {
      return jsonResponse([
        {
          results: MCC_ACCOUNTS.map((a) => ({
            customerClient: { id: a.id, descriptiveName: a.name, currencyCode: "USD", manager: false },
          })),
        },
      ]);
    }
    // Every metric/label/campaign query: empty → zero window spend everywhere.
    return jsonResponse([{ results: [] }]);
  }
  return realFetch(input, init);
}) as typeof fetch;

// --- Modules under test (imported AFTER env + fetch stub). -------------------
const directory = await import("../server/services/adsOs/clickUpDirectory");

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

const { budgetPacingStore, lsaBudgetPacingStore, putCriteria } =
  await import("../server/services/adsOs/store");
const { buildCombinedDashboardCached, __testResetCombinedDashboardCache } =
  await import("../server/services/adsOs/combinedDashboardService");
const { runInIsolatedSchema } = await import("./db-sandbox");

// ── Store fixtures ────────────────────────────────────────────────────────────

const now = new Date();
const CURRENT_MONTH_ISO = now.toISOString();
// Mid-day on the 15th of the PREVIOUS month: unambiguous across any UTC
// boundary slop the coarse year-month guard tolerates.
const PRIOR_MONTH_ISO = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12, 0, 0),
).toISOString();

// `extra` = Task #3897 reconciliation fields (budget_source, schedule_days,
// schedule_source). Omitted for "legacy" docs persisted before those fields
// existed — the overlay surfaces those as nulls, never crashes on them.
const gadsRecord = (
  budget: number, mtd: number, expected: number, generatedAt: string,
  extra: Record<string, unknown> = {},
) => ({
  monthly_budget: budget,
  mtd_spend: mtd,
  expected_to_date: expected,
  budget_pacing_pct: Math.round((mtd / expected - 1) * 1000) / 10,
  generated_at: generatedAt,
  ...extra,
});
const lsaRecord = (
  budget: number | null, mtd: number, expected: number | null, generatedAt: string,
  extra: Record<string, unknown> = {},
) => ({
  monthly_budget: budget,
  mtd_spend: mtd,
  expected_to_date: expected,
  pacing_pct: expected && expected > 0 ? Math.round((mtd / expected - 1) * 1000) / 10 : null,
  generated_at: generatedAt,
  ...extra,
});

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

async function main(): Promise<void> {
  // Warm the ClickUp directory so combinedTasks takes the client-blocks path.
  await directory.getClientDirectory({ force: true, throwOnError: true });
  assert.equal(directory.bundleIsLive(), true, "ClickUp fixture bundle must be live");

  await runInIsolatedSchema(
    async () => {
      // Seed the pacing stores (writes land in the cloned tables). G_ON is a
      // modern doc carrying the Task #3897 reconciliation fields; G_OFF_FRESH
      // stays a LEGACY doc (no budget_source / schedule keys).
      await budgetPacingStore.put(G_ON, gadsRecord(1000, 400, 500, CURRENT_MONTH_ISO, {
        budget_source: "clickup",
        schedule_days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        schedule_source: "inferred",
      }));
      await budgetPacingStore.put(G_OFF_FRESH, gadsRecord(500, 100, 250, CURRENT_MONTH_ISO));
      await lsaBudgetPacingStore.put(L_OFF_STALE, lsaRecord(900, 600, 450, PRIOR_MONTH_ISO));
      await budgetPacingStore.put(G_OFF_STALE, gadsRecord(800, 700, 400, PRIOR_MONTH_ISO));
      await lsaBudgetPacingStore.put(L_OFF_FRESH, lsaRecord(400, 200, 200, CURRENT_MONTH_ISO, {
        budget_source: "sheet",
      }));
      await lsaBudgetPacingStore.put(
        L_ON_NO_BUDGET,
        lsaRecord(null, 300, null, CURRENT_MONTH_ISO, { budget_source: "none" }),
      );
      // L_OFF_FRESH has SAVED criteria (weekend LSA schedule) — the overlay
      // reads it live, exactly like the LSA dashboard's Schedule column.
      // L_OFF_STALE has no criteria row → every-day default.
      await putCriteria(L_OFF_FRESH, {
        lsa_schedule_days: ["Sat", "Sun"],
        updated_at: new Date().toISOString(),
      });

      __testResetCombinedDashboardCache();
      const { resp } = await buildCombinedDashboardCached(true);

      const acme = resp.rows.find((r) => r.client === "Acme Law");
      const beta = resp.rows.find((r) => r.client === "Beta Firm");
      assert.ok(acme, "Acme Law row present");
      assert.ok(beta, "Beta Firm row present");

      // ── Acme: On + fresh Off + unbudgeted spend count; stale Off excluded ─
      // Blend = G_ON(1000/400/500) + G_OFF_FRESH(500/100/250)
      //       + L_ON_NO_BUDGET(null/300/null).
      // The unbudgeted LSA adds spend only; the stale LSA adds nothing.
      ok(acme!.pacing_budget === 1500, "Acme blended budget = On + fresh Off only (1500, stale LSA's 900 excluded)");
      ok(acme!.pacing_mtd === 800, "Acme blended MTD includes the unbudgeted LSA's 300 spend");
      ok(acme!.pacing_expected === 750, "Acme expected target sums only budgeted accounts (750)");
      // pct = round((800/750 - 1) * 1000) / 10 — all spend over budgeted targets.
      ok(acme!.pacing_pct === 6.7, "Acme blended pace uses all MTD against budgeted expected-to-date (+6.7)");
      ok(acme!.has_gads === true, "Acme tagged GAds (On + fresh Off members shown)");
      ok(acme!.has_lsa === true, "Acme tagged LSA via its active unbudgeted member");
      ok(acme!.has_active_monitoring === true, "Acme active via its counting members");

      // Member-level: the stale member keeps its own pacing fields for the
      // hover breakdown, it just contributes nothing to the row totals.
      const stale = acme!.members.find((m) => m.customer_id === L_OFF_STALE);
      assert.ok(stale, "stale Off LSA member still listed");
      ok(stale!.pacing_budget === 900 && stale!.pacing_mtd === 600,
        "stale member's own pacing stays attached to the member (hover breakdown)");
      ok(stale!.pacing_included === false, "stale Off member is explicitly excluded from the breakdown totals");
      const freshOff = acme!.members.find((m) => m.customer_id === G_OFF_FRESH);
      ok(freshOff!.pacing_mtd === 100, "fresh Off member's pacing attached too");
      ok(freshOff!.pacing_included === true, "fresh current-month Off member is explicitly included");
      const unbudgeted = acme!.members.find((m) => m.customer_id === L_ON_NO_BUDGET);
      assert.ok(unbudgeted, "unbudgeted active LSA member present");
      ok(
        unbudgeted!.pacing_budget === null &&
          unbudgeted!.pacing_mtd === 300 &&
          unbudgeted!.pacing_included === true,
        "active LSA with no configured budget remains an included $300 spend contribution",
      );

      // ── Beta: ONLY the fresh Off LSA counts; stale Off GAds is excluded ──
      // A leaked G_OFF_STALE(800/700/400) would make budget 1200, mtd 900,
      // pct +50 — instead the row is exactly the fresh LSA record, on pace.
      ok(beta!.pacing_budget === 400, "Beta blended budget = fresh Off LSA only (400, stale GAds' 800 excluded)");
      ok(beta!.pacing_mtd === 200, "Beta blended MTD = 200 (stale GAds' 700 mtd_spend does not leak in)");
      ok(beta!.pacing_pct === 0, "Beta pace % = 0.0 from the fresh member alone");
      ok(beta!.has_gads === false, "Beta NOT tagged GAds — its only GAds member is Off with a stale record");
      ok(beta!.has_lsa === true, "Beta tagged LSA via the fresh current-month Off member");
      ok(beta!.has_active_monitoring === true, "Beta active via the fresh Off member");

      // ── Task #3897: per-member reconciliation fields for the pill ────────
      const gOn = acme!.members.find((m) => m.customer_id === G_ON);
      assert.ok(gOn, "G_ON member present");
      ok(gOn!.pacing_expected === 500, "expected-to-date attached from the store doc (G_ON 500)");
      ok(gOn!.pacing_budget_source === "clickup", "GAds budget source surfaced from the doc (clickup)");
      assert.deepEqual(gOn!.pacing_schedule_days, ["Mon", "Tue", "Wed", "Thu", "Fri"],
        "GAds applied schedule surfaced from the stored run");
      ok(gOn!.pacing_schedule_source === "inferred",
        "schedule source kept — the pill marks inferred schedules");
      ok(gOn!.pacing_generated_at === CURRENT_MONTH_ISO,
        "generated_at attached — feeds the pill's per-account as-of line");

      // Legacy doc (persisted before Task #3897): nulls, never a crash.
      ok(freshOff!.pacing_expected === 250,
        "legacy doc still yields expected-to-date (that key always existed)");
      ok(
        freshOff!.pacing_budget_source === null &&
          freshOff!.pacing_schedule_days === null &&
          freshOff!.pacing_schedule_source === null,
        "legacy GAds doc without the new keys surfaces nulls (UI omits the lines)",
      );

      // LSA member: budget source from its doc; schedule from SAVED criteria.
      const lFresh = beta!.members.find((m) => m.customer_id === L_OFF_FRESH);
      assert.ok(lFresh, "L_OFF_FRESH member present");
      ok(lFresh!.pacing_expected === 200, "LSA expected-to-date attached (200)");
      ok(lFresh!.pacing_budget_source === "sheet", "LSA budget source surfaced from the doc (sheet)");
      assert.deepEqual(lFresh!.pacing_schedule_days, ["Sat", "Sun"],
        "LSA schedule read live from saved criteria (weekend schedule)");
      ok(lFresh!.pacing_schedule_source === "saved", "saved criteria schedule tagged 'saved'");
      ok(lFresh!.pacing_generated_at === CURRENT_MONTH_ISO, "LSA generated_at attached");

      // Criteria-less LSA member: every-day default; its prior-month
      // generated_at stays attached so the pill can flag the run as stale.
      assert.deepEqual(stale!.pacing_schedule_days, [],
        "criteria-less LSA member reports the every-day default schedule");
      ok(stale!.pacing_schedule_source === "default", "criteria-less LSA schedule tagged 'default'");
      ok(stale!.pacing_generated_at === PRIOR_MONTH_ISO,
        "prior-month generated_at stays attached — the UI flags the stale run");
    },
    {
      tables: ["ads_os_budget_pacing", "ads_os_lsa_budget_pacing", "ads_os_clients_criteria"],
      pinGetDbForCrossAsync: true,
    },
  );

  globalThis.fetch = realFetch;
  console.log(`\nads-os-combined-pacing-staleness: ${passed} assertion(s) passed (Tasks #3613/#3897).`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("ads-os-combined-pacing-staleness: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
