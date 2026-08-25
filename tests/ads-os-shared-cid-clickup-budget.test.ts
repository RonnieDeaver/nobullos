/* test-registration
{
  "name": "Ads OS shared-CID authoritative ClickUp budgets — product-separated positives persist, healthy zero/blank clears stale GAds+LSA summaries, and ClickUp outages preserve last-known rows (Tasks #4975/#5057)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Tasks #4975/#5057: shared-CID GAds/LSA budgets must stay product-separated; a healthy ClickUp zero/blank must clear stale summaries while an outage preserves last-known data. Fetch fully stubbed (ClickUp + Google OAuth/GAQL), store puts captured in-process, no DB.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Ads OS — shared-CID two-product ClickUp budget resolution (Task #4975).
 *
 * Prod scenario: one client ("Geman Law") has an `LSA (Denver)` subtask AND a
 * `Google Ads` subtask carrying the SAME Google CID, with per-product Paid
 * Search Budgets ($2,000 LSA / $8,000 GAds) in ClickUp. The GAds account had
 * no `NBM_GADS_MONITOR_CAMPAIGN`-labeled campaigns yet (onboarding), so
 * runBudgetPacing returned its ineligible report with monthly_budget null /
 * budget_source "none" — DROPPING the resolved ClickUp budget — and
 * persistSummary skipped the write. Result: no pacing row at all and a
 * misleading "no budget" dashboard state.
 *
 * Covers:
 *   (A) Directory ingest: both subtasks under one CID land in the bundle's
 *       budget map ({ gads: 8000, lsa: 2000 }).
 *   (B) Budget seam: getSheetBudgets returns the authoritative ClickUp map;
 *       resolveBudget → 8000/"clickup", resolveLsaBudget →
 *       2000/"clickup" for the SAME CID.
 *   (C) THE FIX: runBudgetPacing for the unlabeled GAds account returns
 *       eligible:false but CARRIES monthly_budget 8000 / budget_source
 *       "clickup", and runBudgetPacingCached persists a budget-only row
 *       (mtd_spend/expected_to_date null via the eligible guards). The LSA
 *       engine mirrors this for a no-LSA-campaigns account.
 *   (D) Authoritative empty state: a client with zero/blank ClickUp budgets
 *       persists an all-null row that clears any stale nonzero summary.
 *   (E) Outage state: the same null result is non-authoritative, so neither
 *       GAds nor LSA overwrites the last-known stored summary.
 *
 * Hermetic: env pinned before import; fetch stubbed per endpoint path shape
 * (ClickUp + Google OAuth + GAQL); store persistence observed by patching the exported
 * store objects' `put` methods in-process. DB-free.
 */

import { strict as assert } from "node:assert";
import {
  EMPTY_CLICKUP_PRACTICE_AREA_FIELDS,
  isClickUpListFieldPath,
} from "./helpers/clickUpPracticeAreaFixture";

// --- Env BEFORE any module import: config constants read at load time. ------
process.env.NODE_ENV = "test";
process.env.CLICKUP_API_TOKEN = "pk_fake_4975";
process.env.ACCOUNT_ENROLLMENT = "clickup"; // ClickUp-authoritative; no label-union GAQL
process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "fake-dev-token";
process.env.GOOGLE_ADS_CLIENT_ID = "fake-client-id";
process.env.GOOGLE_ADS_CLIENT_SECRET = "fake-client-secret";
process.env.GOOGLE_ADS_REFRESH_TOKEN = "fake-refresh-token";
process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = "9999999999";

// ── CIDs ─────────────────────────────────────────────────────────────────────

const SHARED_CID = "4975000001"; // LSA + Google Ads subtasks both carry this
const EMPTY_CID = "4975000002"; // enrolled, but no budget anywhere

// --- ClickUp Client List fixture (config default field ids). ----------------
const F_CID = "a886aa6f-c7f8-41cc-940b-8afef551bf49";
const F_BUDGET = "c57d3b29-e7a0-4373-82bf-b5590547f78c";

const sub = (id: string, parent: string, name: string, cid: string, budget: string | null) => ({
  id,
  parent,
  name,
  custom_fields: [
    { id: F_CID, value: cid },
    ...(budget !== null ? [{ id: F_BUDGET, value: budget, type: "currency" }] : []),
  ],
});

const CLICKUP_TASKS = {
  last_page: true,
  tasks: [
    { id: "p1", name: "Geman Test Law", status: { status: "active" }, custom_fields: [] },
    // Same CID on both subtasks — the prod shape that dropped the GAds budget.
    sub("s1", "p1", "LSA (Denver)", "497-500-0001", "2000"),
    sub("s2", "p1", "Google Ads", "497-500-0001", "8000"),
    { id: "p2", name: "No Budget Firm", status: { status: "active" }, custom_fields: [] },
    sub("s3", "p2", "Google Ads", "497-500-0002", null),
    sub("s4", "p2", "LSA (Austin)", "497-500-0002", null),
  ],
};
let clickUpOutage = false;

// --- fetch stub (ClickUp + Google OAuth + GAQL; nothing else leaves). --------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === "string" ? input : (input?.url ?? input));
  // Dispatch on URL *path shape*, never on live vendor hostnames — naming the
  // real API hosts here would make this test a net-new raw vendor-host caller
  // under lint-vendor-confinement. The paths mirror how the owning adapters
  // build their URLs: clickUpDirectory prefixes every call with /api/v2/,
  // googleAdsClient mints at GOOGLE_TOKEN_URL (path /token) and queries via
  // the customers/{cid}/googleAds:searchStream endpoint.
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Non-absolute input: fall through to realFetch below.
  }
  if (pathname.startsWith("/api/v2/")) {
    if (isClickUpListFieldPath(pathname)) {
      return clickUpOutage
        ? jsonResponse({ err: "stubbed ClickUp outage" }, 503)
        : jsonResponse(EMPTY_CLICKUP_PRACTICE_AREA_FIELDS);
    }
    return clickUpOutage
      ? jsonResponse({ err: "stubbed ClickUp outage" }, 503)
      : jsonResponse(CLICKUP_TASKS);
  }
  if (pathname === "/token") {
    return jsonResponse({ access_token: "fake-access", expires_in: 3599 });
  }
  if (pathname.includes("googleAds:search")) {
    const query: string = JSON.parse(String(init?.body ?? "{}"))?.query ?? "";
    if (query.includes("FROM customer_client")) {
      return jsonResponse([
        {
          results: [SHARED_CID, EMPTY_CID].map((id) => ({
            customerClient: {
              id,
              descriptiveName: `Acct ${id}`,
              currencyCode: "USD",
              manager: false,
            },
          })),
        },
      ]);
    }
    // Label / campaign / metric queries: EMPTY — the account has no labeled
    // campaigns (and no Local Services campaigns) yet. This is the exact
    // ineligible path that used to drop the budget.
    return jsonResponse([{ results: [] }]);
  }
  return realFetch(input, init);
}) as typeof fetch;

// --- Modules under test (imported AFTER env + fetch stub). -------------------
const directory = await import("../server/services/adsOs/clickUpDirectory");

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

const { getSheetBudgets } = await import("../server/services/adsOs/budgetSource");
const { resolveBudget, runBudgetPacing, runBudgetPacingCached } = await import(
  "../server/services/adsOs/pacingEngine"
);
const { resolveLsaBudget, runLsaPacingCached } = await import(
  "../server/services/adsOs/lsaPacingEngine"
);
const store = await import("../server/services/adsOs/store");

// Capture persistence in-process (no DB): patch the store objects' methods.
const gadsPuts = new Map<string, Record<string, any>>();
const lsaPuts = new Map<string, Record<string, any>>();
(store.budgetPacingStore as any).put = async (key: string, data: Record<string, any>) => {
  gadsPuts.set(key, data);
};
(store.lsaBudgetPacingStore as any).put = async (key: string, data: Record<string, any>) => {
  lsaPuts.set(key, data);
};

// ── (A) Directory ingest: shared CID carries BOTH product budgets ───────────
{
  const budgets = await directory.clickUpBudgets();
  assert.deepEqual(budgets[SHARED_CID], { lsa: 2000, gads: 8000 });
  // The ingest may record an empty per-CID object for a budget-less client —
  // what matters is that neither product carries a positive budget.
  assert.ok(!budgets[EMPTY_CID]?.gads && !budgets[EMPTY_CID]?.lsa, "no positive budget recorded");
  console.log("  ✓ A: bundle budget map holds { gads: 8000, lsa: 2000 } under the shared CID");
}

// ── (B) Budget seam: both products resolve from the ONE CID ─────────────────
{
  const { budgets, authoritative } = await getSheetBudgets();
  assert.equal(authoritative, true);
  assert.deepEqual(resolveBudget(budgets, SHARED_CID), { budget: 8000, source: "clickup" });
  assert.deepEqual(resolveLsaBudget(budgets, SHARED_CID), { budget: 2000, source: "clickup" });
  assert.deepEqual(resolveBudget(budgets, EMPTY_CID), { budget: null, source: "none" });
  assert.deepEqual(resolveLsaBudget(budgets, EMPTY_CID), { budget: null, source: "none" });
  console.log("  ✓ B: resolveBudget/resolveLsaBudget both positive for the shared CID; null/none when unset");
}

// ── (C) THE FIX: ineligible (no labeled campaigns) still carries + persists the budget ──
{
  const report = await runBudgetPacing(SHARED_CID);
  assert.equal(report.eligible, false, "no labeled campaigns → ineligible");
  assert.equal(report.monthly_budget, 8000, "ineligible report must carry the ClickUp budget");
  assert.equal(report.budget_source, "clickup");
  assert.equal(report.budget_authoritative, true);

  await runBudgetPacingCached(SHARED_CID, true);
  const doc = gadsPuts.get(SHARED_CID);
  assert.ok(doc, "budget-only row must be persisted for the unlabeled account");
  assert.equal(doc!.monthly_budget, 8000);
  assert.equal(doc!.budget_source, "clickup");
  assert.equal(doc!.mtd_spend, null, "ineligible run persists no spend");
  assert.equal(doc!.expected_to_date, null);

  // LSA mirror: no Local Services campaigns → budget-only row with $2,000.
  await runLsaPacingCached(SHARED_CID, true);
  const lsaDoc = lsaPuts.get(SHARED_CID);
  assert.ok(lsaDoc, "LSA budget-only row must be persisted");
  assert.equal(lsaDoc!.monthly_budget, 2000);
  assert.equal(lsaDoc!.budget_source, "clickup");
  assert.equal(lsaDoc!.mtd_spend, null);
  console.log("  ✓ C: ineligible runs carry the resolved budget and persist budget-only rows");
}

// ── (D) Healthy zero/blank clears stale summaries for both products ─────────
{
  const report = await runBudgetPacing(EMPTY_CID);
  assert.equal(report.eligible, false);
  assert.equal(report.monthly_budget, null);
  assert.equal(report.budget_source, "none");
  assert.equal(report.budget_authoritative, true);

  await runBudgetPacingCached(EMPTY_CID, true);
  const gadsClear = gadsPuts.get(EMPTY_CID);
  assert.ok(gadsClear, "authoritative GAds zero/blank must overwrite the stale summary");
  assert.equal(gadsClear!.monthly_budget, null);
  assert.equal(gadsClear!.budget_source, "none");
  assert.equal(gadsClear!.mtd_spend, null);
  assert.equal(gadsClear!.budget_pacing_pct, null);
  assert.equal(gadsClear!.recommended_daily_budget, null);
  assert.equal(gadsClear!.expected_to_date, null);

  await runLsaPacingCached(EMPTY_CID, true);
  const lsaClear = lsaPuts.get(EMPTY_CID);
  assert.ok(lsaClear, "authoritative LSA zero/blank must overwrite the stale summary");
  assert.equal(lsaClear!.monthly_budget, null);
  assert.equal(lsaClear!.budget_source, "none");
  assert.equal(lsaClear!.mtd_spend, null);
  assert.equal(lsaClear!.pacing_pct, null);
  assert.equal(lsaClear!.recommended_weekly_budget, null);
  assert.equal(lsaClear!.expected_to_date, null);
  console.log("  ✓ D: healthy zero/blank persists all-null summaries for GAds and LSA");
}

// ── (E) ClickUp outage preserves the last-known GAds + LSA summaries ────────
{
  const oldGads = { monthly_budget: 1652, budget_source: "clickup" };
  const oldLsa = { monthly_budget: 1000, budget_source: "clickup" };
  gadsPuts.set(EMPTY_CID, oldGads);
  lsaPuts.set(EMPTY_CID, oldLsa);

  clickUpOutage = true;
  const unavailable = await getSheetBudgets(true);
  assert.equal(unavailable.authoritative, false, "failed forced read is not authoritative");

  const report = await runBudgetPacing(EMPTY_CID);
  assert.equal(report.monthly_budget, null);
  assert.equal(report.budget_authoritative, false);

  await runBudgetPacingCached(EMPTY_CID, true);
  await runLsaPacingCached(EMPTY_CID, true);
  assert.equal(gadsPuts.get(EMPTY_CID), oldGads, "outage must not overwrite GAds last-known data");
  assert.equal(lsaPuts.get(EMPTY_CID), oldLsa, "outage must not overwrite LSA last-known data");
  console.log("  ✓ E: ClickUp outage skips destructive clears and preserves last-known rows");
}

console.log("ads-os-shared-cid-clickup-budget: all assertions passed");
