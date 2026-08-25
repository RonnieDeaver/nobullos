/* test-registration
{
  "name": "Ads OS authoritative budget source — ClickUp-only per-product budgets, successful zero/blank finality, stale outage preservation, and no legacy-sheet fallback (Task #5057)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #5057: ClickUp is Ads OS's sole budget authority. A successful zero/blank must clear stale pacing, while an outage may serve stale ClickUp data but must never fall back to the retired sheet or authorize destructive clears. Fetch fully stubbed, DB-free, fast.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Covers the budget-source contract at the ClickUp adapter boundary:
 *   (A) A healthy fetch returns positive GAds/LSA values independently,
 *       including both products under one CID.
 *   (B) A later healthy zero/blank is authoritative and is not gap-filled from
 *       the legacy sheet.
 *   (C) A ClickUp outage serves the stale ClickUp bundle with
 *       authoritative=false and never fetches the sheet.
 *   (D) A cold outage returns an empty, non-authoritative result.
 */

import { strict as assert } from "node:assert";
import {
  EMPTY_CLICKUP_PRACTICE_AREA_FIELDS,
  isClickUpListFieldPath,
} from "./helpers/clickUpPracticeAreaFixture";

process.env.NODE_ENV = "test";
process.env.CLICKUP_API_TOKEN = "pk_fake_5057";
// These retired settings are deliberately populated: the source seam must
// ignore them and make zero legacy-sheet requests.
process.env.BUDGET_SOURCE = "sheet";
process.env.BUDGET_SHEET_CSV_URL = "https://budget-sheet.test/pub?output=csv";

const SHARED_CID = "5057000001";
const ZERO_CID = "5057000002";
const F_CID = "a886aa6f-c7f8-41cc-940b-8afef551bf49";
const F_BUDGET = "c57d3b29-e7a0-4373-82bf-b5590547f78c";

type Mode = "positive" | "zero" | "outage";
let mode: Mode = "positive";
let clickUpFetches = 0;
let sheetFetches = 0;

const sub = (
  id: string,
  parent: string,
  name: string,
  cid: string,
  budget: string | null,
) => ({
  id,
  parent,
  name,
  custom_fields: [
    { id: F_CID, value: cid },
    ...(budget === null ? [] : [{ id: F_BUDGET, value: budget, type: "currency" }]),
  ],
});

function clickUpTasks(): Record<string, unknown> {
  return {
    last_page: true,
    tasks: [
      { id: "p1", name: "Shared CID Law", status: { status: "active" }, custom_fields: [] },
      sub("s1", "p1", "Google Ads", SHARED_CID, "1200"),
      // A successful later blank for the same (product, CID) must clear the
      // earlier positive; ClickUp list order is the deterministic tie-break.
      ...(mode === "zero" ? [sub("s1-clear", "p1", "Google Ads", SHARED_CID, null)] : []),
      sub("s2", "p1", "LSA (Denver)", SHARED_CID, "400"),
      { id: "p2", name: "Zero Budget Law", status: { status: "active" }, custom_fields: [] },
      sub("s3", "p2", "Google Ads", ZERO_CID, null),
      sub("s4", "p2", "LSA (Austin)", ZERO_CID, "0"),
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any) => {
  const url = String(typeof input === "string" ? input : (input?.url ?? input));
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Non-absolute input falls through to the real fetch below.
  }
  if (pathname.startsWith("/api/v2/")) {
    if (isClickUpListFieldPath(pathname)) {
      return mode === "outage"
        ? jsonResponse({ err: "stubbed outage" }, 503)
        : jsonResponse(EMPTY_CLICKUP_PRACTICE_AREA_FIELDS);
    }
    clickUpFetches++;
    return mode === "outage"
      ? jsonResponse({ err: "stubbed outage" }, 503)
      : jsonResponse(clickUpTasks());
  }
  if (url.includes("budget-sheet.test") || url.includes("docs.google.com")) {
    sheetFetches++;
    return new Response("legacy sheet must not be read", { status: 500 });
  }
  return realFetch(input);
}) as typeof fetch;

const tokenStore = await import("../server/services/clickUpCompanyToken");
tokenStore.__setClickUpCompanyTokenStoreForTest({
  async get() {
    return undefined;
  },
  async set() {},
  async del() {},
  async recordAudit() {},
});

const directory = await import("../server/services/adsOs/clickUpDirectory");
directory.__setDirectoryAlertHooksForTest({
  onSuccess: async () => {},
  onFailure: async () => {},
});
const { getSheetBudgets } = await import("../server/services/adsOs/budgetSource");

try {
  directory.__testResetDirectoryCache();

  // (A) Healthy positive values remain separated by product under one CID.
  const first = await getSheetBudgets(true);
  assert.equal(first.authoritative, true);
  assert.equal(first.warning, null);
  assert.deepEqual(first.budgets.get(SHARED_CID), { gads: 1200, lsa: 400 });
  assert.deepEqual(first.budgets.get(ZERO_CID), { gads: 0, lsa: 0 });
  assert.equal(sheetFetches, 0, "legacy sheet is never fetched");
  console.log("  ✓ A: healthy ClickUp budgets are authoritative and product-separated");

  // (B) A successful later blank replaces an older duplicate positive; the LSA
  // sibling survives independently.
  mode = "zero";
  const zero = await getSheetBudgets(true);
  assert.equal(zero.authoritative, true);
  assert.deepEqual(zero.budgets.get(SHARED_CID), { gads: 0, lsa: 400 });
  assert.equal(sheetFetches, 0, "authoritative zero is never sheet-gap-filled");
  console.log("  ✓ B: later ClickUp zero/blank defeats an older duplicate positive");

  // (C) Outage serves the stale ClickUp copy but marks it non-authoritative.
  mode = "outage";
  const stale = await getSheetBudgets(true);
  assert.equal(stale.authoritative, false);
  assert.match(stale.warning ?? "", /last cached ClickUp copy/i);
  assert.deepEqual(stale.budgets.get(SHARED_CID), { gads: 0, lsa: 400 });
  assert.equal(sheetFetches, 0);
  console.log("  ✓ C: outage serves stale ClickUp data without authorizing clears");

  // (D) A cold outage is empty/non-authoritative, still with no sheet request.
  directory.__testResetDirectoryCache();
  const cold = await getSheetBudgets(true);
  assert.equal(cold.authoritative, false);
  assert.equal(cold.budgets.size, 0);
  assert.equal(sheetFetches, 0);
  assert.ok(clickUpFetches >= 4, "each forced proof performed a ClickUp attempt");
  console.log("  ✓ D: cold outage is empty/non-authoritative and never falls back");
} finally {
  globalThis.fetch = realFetch;
  directory.__testResetDirectoryCache();
  await directory.__test_drainDirectoryAlertWork();
}

console.log("ads-os-budget-source: all assertions passed");
