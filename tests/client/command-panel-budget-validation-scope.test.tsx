/* test-registration
{
  "name": "Command Panel product & budget save rules — non-products saves unblocked (Task #4022), budget checks scoped to gap-creating edits + legacy product aliases editable (Task #4510), read-view missing-budget indicators (Task #4027)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4022 scoped the product-budget validations to the flows that render the product fields (Products & Budget / edit-all) so a stored product-without-budget state can't block Identity/Onboarding/Strategy saves. Task #4510 narrowed them further after a real operator lockout (a prod panel stored legacy plural 'webinars' — invisible to the canonical-id checkboxes — plus two unrelated budget gaps, making the Webinars product unremovable): a products/edit-all save is now blocked ONLY when it newly adds a product without entering its budget or clears the stored budget of a still-selected product; removal-only saves and untouched pre-existing gaps go through, and stored legacy aliases render as checked checkboxes, are removable, and always PUT canonical ids. This DB-free stubbed jsdom render pins all of that plus the Task #4027 read-view 'Budget missing' notices (which now also cover legacy-valued products). A regression re-blocking removal-only or unrelated saves, silently dropping the add/clear enforcement, or re-hiding legacy values from the edit UI fails the routine gate.",
  "timeoutMs": 300000,
  "extraNodeArgs": [
    "--import",
    "./tests/command-panel-budget-scope-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json",
    "NODE_ENV": "test"
  },
  "notes": "CommandPanel's component graph is large and tsx must transpile it cold in the smoke child (same harness weight as tests/client/command-panel-gbp-location-error.test.tsx) — keep the generous wall-clock so it finishes under load instead of SIGKILL-flaking the gate.",
  "tier": "small"
}
test-registration */
/**
 * Tasks #4022 / #4027 / #4510 — Frontend regression test for the Command
 * Panel's product & budget save rules.
 *
 * Task #4022: the product-budget validations (Google Ads / Webinar / LSA
 * "Budget is required when … is selected") are scoped to the editing flows
 * that actually expose the product fields — the Products & Budget section and
 * the edit-all/create flow ("all") — and never block saves from other
 * sections (startEditing copies the WHOLE panel into every section's draft,
 * so an unscoped check blocked Identity/Onboarding/Strategy saves too).
 *
 * Task #4510: within those flows the checks are further scoped to edits that
 * CREATE or WORSEN a budget gap. The reported bug: an operator could not
 * remove the Webinars product because (1) the stored value was the legacy
 * plural "webinars", which the canonical-id checkboxes could neither display
 * nor remove, and (2) unrelated products' pre-existing budget gaps (allowed
 * to persist since Task #4027) blocked every products-section save. Now:
 *
 *   - Removal-only saves and saves carrying untouched pre-existing gaps go
 *     through (PUT fires, no block toast).
 *   - Adding a product without entering its budget is still blocked, with the
 *     same product-specific destructive toast.
 *   - Clearing the stored budget of a still-selected product is still blocked.
 *   - Stored legacy aliases ("webinars", and the alias+canonical double-entry
 *     artifact) render as checked canonical checkboxes, are removable, and
 *     drafts always PUT canonical ids.
 *   - The Task #4027 read-view "Budget missing" notices now also render for
 *     legacy-valued products (they previously missed them).
 *
 * Fixture shapes for the legacy cases are pinned from the prod replica
 * (2026-08-11): 26 panels store plural "webinars", 4 carry the double-entry
 * artifact, 10+ combine legacy values with NULL budgets on selected products.
 *
 * This test mounts the REAL `CommandPanel` in jsdom (fetch fully stubbed,
 * toast surface captured via the shared use-toast stub loader).
 *
 * Prior tasks consulted (per replit.md prior-task research rule): #2488/#2545
 * (the jsdom CommandPanel mount + stubbed-fetch harness and Radix shim setup
 * this copies), #2675 (the use-toast recording stub loader reused here).
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(dom.window as any).matchMedia =
  (dom.window as any).matchMedia ||
  ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const CLIENT_ID = "client-1";

const CEO_USER = {
  id: "ceo-1",
  email: "ceo@example.com",
  firstName: "Cee",
  lastName: "Oh",
  role: "ceo",
};

const CLIENT = {
  id: CLIENT_ID,
  firmName: "Acme Law",
  ownerId: "ceo-1",
  terminology: {},
  practiceAreas: [],
  productTypes: [],
};

// A stored panel in the poisoned state the bug fires on: the scenario mutates
// `productTypes` per variant while all three budgets stay null.
const BASE_PANEL = {
  id: "panel-1",
  clientId: CLIENT_ID,
  productTypes: [] as string[],
  productStatusNotes: null,
  currentBottleneck: null,
  budgetPosture: null,
  googleAdsBudget: null,
  webinarBudget: null,
  lsaBudget: null,
  googleAdsTargetAreas: [],
  googleAdsTargetingMethod: null,
  googleAdsExcludedAreas: [],
  googleAdsGeoNotes: null,
  webinarTargetAreas: [],
  webinarGeoNotes: null,
  onboardingNotes: null,
  annualRevenueGoal: null,
  priorityMarkets: [],
  secondaryMarkets: [],
  externalSystemLinks: [],
  clientPreferences: null,
  internalHandlingNotes: null,
};

let panelData: Record<string, any> = { ...BASE_PANEL };

// Every body the component PUTs to the command-panel endpoint, in order.
const putCalls: Array<Record<string, any>> = [];

// Routes are evaluated top-to-bottom, first match wins, and `path` strings
// match by exact-or-prefix — deeper `command-panel/*` routes come BEFORE the
// shallower `command-panel` prefix. The PUT route is method-scoped, so GETs
// fall through it.
function makeFetchHandler(): (url: string, init?: any) => Promise<Response> {
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      {
        method: "PUT",
        path: `/api/clients/${CLIENT_ID}/command-panel`,
        respond: ({ init }: any) => {
          const body = JSON.parse(init?.body ?? "{}");
          putCalls.push(body);
          return { status: 200, json: { ...panelData, ...body } };
        },
      },
      { path: `/api/clients/${CLIENT_ID}/command-panel/unmatched-zoom`, json: [] },
      { path: `/api/clients/${CLIENT_ID}/command-panel/history`, json: [] },
      { path: `/api/clients/${CLIENT_ID}/command-panel/key-calls`, json: [] },
      { path: `/api/clients/${CLIENT_ID}/command-panel/rer-recordings`, json: [] },
      { path: `/api/clients/${CLIENT_ID}/command-panel`, json: () => panelData },
      { path: `/api/clients/${CLIENT_ID}/locations/audit`, json: [] },
      { path: `/api/clients/${CLIENT_ID}/locations`, json: [] },
      { path: `/api/clients/${CLIENT_ID}/contacts/audit`, json: [] },
      { path: `/api/clients/${CLIENT_ID}/contacts`, json: [] },
      { path: `/api/clients/${CLIENT_ID}/communications`, json: [] },
      { path: "/api/import-suggestions", json: { items: [] } },
      // Data Access card reads an array of entries; its advisory detection map
      // reads an object — the empty default below covers detection.
      { path: `/api/clients/${CLIENT_ID}/data-access`, json: [] },
      // Contracts card maps over the PandaDoc documents array.
      { path: `/api/clients/${CLIENT_ID}/pandadoc-documents`, json: [] },
    ],
    // Benign empty payload for anything incidental (activity log POSTs etc.).
    defaultJson: {},
  });
}

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom globals + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider, QueryClient } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const CommandPanel = (await import("../../client/src/components/CommandPanel")).default;

let activeFetchHandler: (url: string, init?: any) => Promise<Response> = async () => {
  throw new Error("no fetch handler set");
};
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  return activeFetchHandler(url, init);
};

async function flush(times = 16): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

function click(testId: string): void {
  const el = $(testId);
  assert(el !== null, `element ${testId} must be in the DOM to click`);
  el!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

function setInputValue(testId: string, value: string): void {
  const el = $(testId) as HTMLInputElement | null;
  assert(el !== null, `input ${testId} must be in the DOM`);
  const proto = Object.getPrototypeOf(el!);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else (el as any).value = value;
  el!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  el!.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

// Radix Checkbox reflects its checked state in the data-state attribute of the
// rendered role="checkbox" button.
function checkboxState(testId: string): string {
  const el = $(testId);
  assert(el !== null, `checkbox ${testId} must be in the DOM`);
  return el!.getAttribute("data-state") ?? "";
}

// ---------------------------------------------------------------------------
// Toast capture (see tests/dashboard-toast-stub-loader.mjs).
// ---------------------------------------------------------------------------

function capturedToasts(): Array<{ title?: unknown; variant?: unknown }> {
  return ((globalThis as any).__capturedToasts ?? []) as Array<{ title?: unknown; variant?: unknown }>;
}

function resetToasts(): void {
  (globalThis as any).__capturedToasts = [];
}

function toastTitles(): string[] {
  return capturedToasts().map((t) => String(t.title ?? ""));
}

function budgetBlockToast(): string | undefined {
  return toastTitles().find((t) => t.includes("Budget is required"));
}

async function mountPanel(extraProps: Record<string, any> = {}): Promise<Root> {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(CommandPanel as any, {
          clientId: CLIENT_ID,
          client: CLIENT,
          currentUser: CEO_USER,
          allUsers: [CEO_USER],
          primaryReady: true,
          ...extraProps,
        }),
      ),
    );
  });
  await flush();
  return root!;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  queryClient.clear();
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

type Variant = {
  label: string;
  product: string;
  /** A non-products section that must save despite the budget gap. */
  section: "identity" | "onboarding" | "strategy";
};

// One variant per product (their budget checks shared both bugs), each paired
// with a different non-products section so Identity, Onboarding, and Strategy
// are all exercised. The three product-specific block-toast strings stay
// pinned verbatim in the gap-creating and edit-all scenarios below.
const VARIANTS: Variant[] = [
  { label: "LSA × Identity & Ownership", product: "lsa", section: "identity" },
  { label: "Google Ads × Onboarding", product: "google_ads", section: "onboarding" },
  { label: "Webinar × Strategic Direction", product: "webinar", section: "strategy" },
];

const BUDGET_INPUT_BY_PRODUCT: Record<string, string> = {
  lsa: "input-lsa-budget",
  google_ads: "input-google-ads-budget",
  webinar: "input-webinar-budget",
};

const BUDGET_FIELD_BY_PRODUCT: Record<string, string> = {
  lsa: "lsaBudget",
  google_ads: "googleAdsBudget",
  webinar: "webinarBudget",
};

async function runVariant(v: Variant): Promise<void> {
  console.log(`\n— ${v.label} —`);
  panelData = { ...BASE_PANEL, productTypes: [v.product] };
  putCalls.length = 0;
  resetToasts();

  const root = await mountPanel();
  try {
    // ---- A. Non-products section save goes through -----------------------
    click(`button-edit-${v.section}`);
    await flush();
    assert($("button-save-section") !== null, `${v.label}: entering ${v.section} edit mode renders the save actions`);
    assert(
      $(BUDGET_INPUT_BY_PRODUCT[v.product]) === null,
      `${v.label}: the ${v.product} budget input must NOT render in the ${v.section} section (the operator couldn't fix it here)`,
    );

    click("button-save-section");
    await flush();

    assert(
      putCalls.length === 1,
      `${v.label}: the ${v.section} save must fire the PUT despite the ${v.product}-without-budget state ` +
        `(got ${putCalls.length} PUTs; toasts: ${JSON.stringify(toastTitles())})`,
    );
    assert(
      JSON.stringify(putCalls[0].productTypes) === JSON.stringify([v.product]),
      `${v.label}: the whole-panel draft carried productTypes [${v.product}] through the save`,
    );
    assert(
      putCalls[0][BUDGET_FIELD_BY_PRODUCT[v.product]] === null,
      `${v.label}: the draft still carried the null ${BUDGET_FIELD_BY_PRODUCT[v.product]} (proving the validation WOULD have tripped pre-fix)`,
    );
    assert(
      budgetBlockToast() === undefined,
      `${v.label}: no "Budget is required" toast may fire on a ${v.section} save — got ${JSON.stringify(toastTitles())}`,
    );
    assert(
      toastTitles().includes("Command Panel updated"),
      `${v.label}: the success toast fires — got ${JSON.stringify(toastTitles())}`,
    );
    assert($("button-save-section") === null, `${v.label}: ${v.section} edit mode exits after the successful save`);
    console.log(`  ✓ ${v.section} save went through (PUT fired, no budget toast)`);

    // ---- B. Products & Budget save with the UNTOUCHED gap goes through ---
    // Task #4510 inversion: pre-#4510 this exact save was blocked by the
    // product's own pre-existing budget gap, which (combined with Task #4027
    // allowing gaps to persist) made it impossible to save ANY subtractive
    // products edit without inventing budgets. The gap is untouched here —
    // the product was already selected and its budget was already null — so
    // the save must now fire the PUT.
    resetToasts();
    click("button-edit-products");
    await flush();
    assert(
      $(BUDGET_INPUT_BY_PRODUCT[v.product]) !== null,
      `${v.label}: the ${v.product} budget input renders in Products & Budget edit mode`,
    );

    click("button-save-section");
    await flush();

    assert(
      putCalls.length === 2,
      `${v.label}: the products save with the untouched ${v.product} budget gap must fire the PUT (got ${putCalls.length} total; toasts: ${JSON.stringify(toastTitles())})`,
    );
    assert(
      JSON.stringify(putCalls[1].productTypes) === JSON.stringify([v.product]),
      `${v.label}: the products save carried productTypes [${v.product}]`,
    );
    assert(
      putCalls[1][BUDGET_FIELD_BY_PRODUCT[v.product]] === null,
      `${v.label}: the PUT still carries the null ${BUDGET_FIELD_BY_PRODUCT[v.product]} (the untouched gap persists by design)`,
    );
    assert(
      budgetBlockToast() === undefined,
      `${v.label}: no "Budget is required" toast may fire for an untouched pre-existing gap — got ${JSON.stringify(toastTitles())}`,
    );
    assert(
      toastTitles().includes("Command Panel updated"),
      `${v.label}: the success toast fires — got ${JSON.stringify(toastTitles())}`,
    );
    assert($("button-save-section") === null, `${v.label}: products edit mode exits after the successful save`);
    console.log(`  ✓ products save with the untouched gap went through (Task #4510)`);
  } finally {
    await unmount(root);
  }
}

// Task #4510 — the reported production shape: legacy plural "webinars" stored
// in productTypes (invisible to the pre-fix checkboxes) AND multiple other
// selected products with null budgets. Removing Webinars must work end to end.
// Fixture pinned from the prod replica (2026-08-11): e.g.
// ["gbp","google_ads","lsa","webinars"] with google_ads/lsa/webinar budgets
// all NULL — 10+ live panels combine a legacy value with budget gaps.
async function runLegacyRemovalScenario(): Promise<void> {
  console.log(`\n— legacy "webinars" removal with unrelated budget gaps (Task #4510) —`);
  panelData = { ...BASE_PANEL, productTypes: ["gbp", "google_ads", "lsa", "webinars"] };
  putCalls.length = 0;
  resetToasts();

  const root = await mountPanel();
  try {
    // Read view: the legacy value must surface like the canonical id would —
    // the Webinars section renders, and its missing-budget notice (previously
    // skipped for legacy values) renders too.
    assert(
      $("display-webinar-targeting") !== null,
      'legacy: the Webinars read section renders for stored "webinars"',
    );
    assert(
      $("warning-missing-budget-webinar") !== null,
      'legacy: the missing-budget notice renders for stored "webinars" (pre-fix it was silently skipped)',
    );

    click("button-edit-products");
    await flush();
    assert(
      checkboxState("checkbox-product-webinar") === "checked",
      `legacy: the Webinars checkbox reflects the stored legacy value (got "${checkboxState("checkbox-product-webinar")}") — pre-fix it rendered unchecked and could never remove it`,
    );

    click("checkbox-product-webinar");
    await flush();
    assert(
      checkboxState("checkbox-product-webinar") === "unchecked",
      "legacy: unchecking the Webinars checkbox flips its state",
    );

    click("button-save-section");
    await flush();

    assert(
      putCalls.length === 1,
      `legacy: the removal save must fire the PUT despite google_ads and lsa having no budgets (got ${putCalls.length}; toasts: ${JSON.stringify(toastTitles())})`,
    );
    assert(
      JSON.stringify(putCalls[0].productTypes) === JSON.stringify(["gbp", "google_ads", "lsa"]),
      `legacy: the PUT carries the canonical list with webinar removed (got ${JSON.stringify(putCalls[0].productTypes)})`,
    );
    assert(budgetBlockToast() === undefined, `legacy: no budget toast on a removal-only save — got ${JSON.stringify(toastTitles())}`);
    assert($("button-save-section") === null, "legacy: edit mode exits after the removal save");
    console.log('  ✓ stored "webinars" rendered checked, was removable, and the PUT carried canonical ids');
  } finally {
    await unmount(root);
  }

  // The alias+canonical double-entry artifact (4 prod rows, left behind by
  // failed uncheck attempts against the raw-persisting server): the draft
  // dedupes it, so ONE uncheck removes the product entirely.
  panelData = { ...BASE_PANEL, productTypes: ["gbp", "webinars", "webinar"] };
  putCalls.length = 0;
  resetToasts();
  const root2 = await mountPanel();
  try {
    click("button-edit-products");
    await flush();
    assert(
      checkboxState("checkbox-product-webinar") === "checked",
      "artifact: the double-entry value renders as one checked checkbox",
    );
    click("checkbox-product-webinar");
    await flush();
    click("button-save-section");
    await flush();
    assert(putCalls.length === 1, `artifact: the removal save fires the PUT (got ${putCalls.length})`);
    assert(
      JSON.stringify(putCalls[0].productTypes) === JSON.stringify(["gbp"]),
      `artifact: one uncheck removes BOTH stored entries (got ${JSON.stringify(putCalls[0].productTypes)})`,
    );
    console.log("  ✓ alias+canonical double entry dedupes — one uncheck removes the product");
  } finally {
    await unmount(root2);
  }
}

// Task #4510 — the two block modes that survive the narrowing, in one mount:
// clearing a stored budget while keeping its product selected, and adding a
// product without entering its budget. Both must still show the exact
// product-specific destructive toast and suppress the PUT.
async function runGapCreatingEditsStillBlockedScenario(): Promise<void> {
  console.log(`\n— gap-creating edits still blocked (Task #4510) —`);
  panelData = { ...BASE_PANEL, productTypes: ["lsa"], lsaBudget: 500 };
  putCalls.length = 0;
  resetToasts();

  const root = await mountPanel();
  try {
    click("button-edit-products");
    await flush();

    // (1) Clearing a stored budget while its product stays selected → blocked.
    setInputValue("input-lsa-budget", "");
    await flush();
    click("button-save-section");
    await flush();
    assert(putCalls.length === 0, `clear: no PUT may fire when the save clears a stored budget (got ${putCalls.length})`);
    const clearBlocked = capturedToasts().find((t) => t.title === "LSA Budget is required when LSA is selected");
    assert(clearBlocked !== undefined, `clear: the LSA block toast must fire — got ${JSON.stringify(toastTitles())}`);
    assert(clearBlocked!.variant === "destructive", "clear: the block toast is destructive");
    assert($("button-save-section") !== null, "clear: edit mode stays open after the block");
    console.log("  ✓ clearing a stored budget is still blocked");

    // Restore the stored value before the next step.
    resetToasts();
    setInputValue("input-lsa-budget", "500");
    await flush();

    // (2) Adding a product without entering its budget → blocked.
    click("checkbox-product-google_ads");
    await flush();
    assert(checkboxState("checkbox-product-google_ads") === "checked", "add: the Google Ads checkbox checks");
    click("button-save-section");
    await flush();
    assert(putCalls.length === 0, `add: no PUT may fire when the save adds a product without a budget (got ${putCalls.length})`);
    const addBlocked = capturedToasts().find((t) => t.title === "Google Ads Budget is required when Google Ads is selected");
    assert(addBlocked !== undefined, `add: the Google Ads block toast must fire — got ${JSON.stringify(toastTitles())}`);
    assert(addBlocked!.variant === "destructive", "add: the block toast is destructive");
    console.log("  ✓ adding a product without its budget is still blocked");

    // (3) Entering the new product's budget unblocks the same save.
    resetToasts();
    setInputValue("input-google-ads-budget", "1000");
    await flush();
    click("button-save-section");
    await flush();
    assert(putCalls.length === 1, `add: entering the budget unblocks the save (got ${putCalls.length})`);
    assert(
      JSON.stringify(putCalls[0].productTypes) === JSON.stringify(["lsa", "google_ads"]),
      `add: the PUT carries both products (got ${JSON.stringify(putCalls[0].productTypes)})`,
    );
    assert(putCalls[0].googleAdsBudget === 1000, `add: the PUT carries the entered budget (got ${JSON.stringify(putCalls[0].googleAdsBudget)})`);
    assert(putCalls[0].lsaBudget === 500, `add: the restored LSA budget rides along (got ${JSON.stringify(putCalls[0].lsaBudget)})`);
    assert(budgetBlockToast() === undefined, "add: no block toast once the budget is entered");
    console.log("  ✓ entering the new product's budget unblocks the save");
  } finally {
    await unmount(root);
  }
}

// Task #4027 — the product-without-budget state persists indefinitely by
// design (see the decision comment in handleSave), so the READ view must make
// the gap visible: each selected product with a null budget renders a
// "Budget missing" notice, and it disappears once a budget is stored.
async function runMissingBudgetIndicatorScenario(): Promise<void> {
  console.log(`\n— missing-budget read-view indicator (Task #4027) —`);

  // All three products selected, all budgets null → all three notices render.
  panelData = { ...BASE_PANEL, productTypes: ["lsa", "google_ads", "webinar"] };
  putCalls.length = 0;
  resetToasts();
  let root = await mountPanel();
  try {
    for (const product of ["lsa", "google_ads", "webinar"]) {
      assert(
        $(`warning-missing-budget-${product}`) !== null,
        `indicator: warning-missing-budget-${product} must render when ${product} is selected with a null budget`,
      );
    }
    // The LSA block itself must render (pre-#4027 it was hidden entirely when
    // the budget was null — the exact invisibility this task closes).
    assert($("display-lsa-budget") !== null, "indicator: the LSA display block renders even with a null budget");
    console.log("  ✓ all three notices render for null budgets (LSA block no longer hidden)");
  } finally {
    await unmount(root);
  }

  // Budgets stored → no notices.
  panelData = {
    ...BASE_PANEL,
    productTypes: ["lsa", "google_ads", "webinar"],
    lsaBudget: 500,
    googleAdsBudget: 1000,
    webinarBudget: 750,
  };
  root = await mountPanel();
  try {
    for (const product of ["lsa", "google_ads", "webinar"]) {
      assert(
        $(`warning-missing-budget-${product}`) === null,
        `indicator: warning-missing-budget-${product} must NOT render once the budget is stored`,
      );
    }
    assert($("display-lsa-budget") !== null, "indicator: the LSA display block still renders with a stored budget");
    console.log("  ✓ notices absent once budgets are stored");
  } finally {
    await unmount(root);
  }

  // Task #4510: a legacy-valued product gets the same notice. Pre-fix the
  // read view's includes("webinar") check missed stored "webinars", so the
  // gap was invisible exactly where the data was dirtiest.
  panelData = { ...BASE_PANEL, productTypes: ["lsa", "google_ads", "webinars"] };
  root = await mountPanel();
  try {
    for (const product of ["lsa", "google_ads", "webinar"]) {
      assert(
        $(`warning-missing-budget-${product}`) !== null,
        `indicator: warning-missing-budget-${product} must render for the legacy-valued fixture too`,
      );
    }
    assert(
      $("display-webinar-targeting") !== null,
      'indicator: the Webinars read section renders for stored "webinars"',
    );
    console.log('  ✓ notices also render for legacy "webinars" (Task #4510)');
  } finally {
    await unmount(root);
  }
}

async function runEditAllScenario(): Promise<void> {
  console.log(`\n— edit-all flow (prefill) —`);
  panelData = { ...BASE_PANEL, productTypes: ["lsa"] };
  putCalls.length = 0;
  resetToasts();

  // A non-null prefillData drops the panel into the edit-all flow
  // (editingSection === "all") once the panel query resolves — the same flow
  // the Promote workflow and initial full-panel setup use. Products fields
  // are editable there, so the gap-creating checks apply to it exactly like
  // the products section.
  //
  // Task #4510 inversion: pre-#4510 this immediate save was blocked by the
  // stored LSA gap the prefill flow didn't touch. The gap is pre-existing, so
  // the save must now go through.
  let root = await mountPanel({ prefillData: {} });
  try {
    assert($("button-save-section") !== null, "edit-all: the prefill flow lands in edit-all mode (save actions rendered)");
    assert($("input-lsa-budget") !== null, "edit-all: the LSA budget input renders (products fields ARE editable here)");

    click("button-save-section");
    await flush();

    assert(
      putCalls.length === 1,
      `edit-all: the save with the untouched LSA gap must fire the PUT (got ${putCalls.length}; toasts: ${JSON.stringify(toastTitles())})`,
    );
    assert(putCalls[0].lsaBudget === null, "edit-all: the PUT still carries the null lsaBudget (untouched gap persists)");
    assert(budgetBlockToast() === undefined, `edit-all: no block toast for the untouched gap — got ${JSON.stringify(toastTitles())}`);
    console.log("  ✓ edit-all save with the untouched gap went through (Task #4510)");
  } finally {
    await unmount(root);
  }

  // Adding a product in the edit-all flow still requires its budget — and the
  // unrelated stored LSA gap must not block the eventual save.
  panelData = { ...BASE_PANEL, productTypes: ["lsa"] };
  putCalls.length = 0;
  resetToasts();
  root = await mountPanel({ prefillData: {} });
  try {
    click("checkbox-product-webinar");
    await flush();
    assert(checkboxState("checkbox-product-webinar") === "checked", "edit-all: the Webinars checkbox checks");

    click("button-save-section");
    await flush();
    assert(putCalls.length === 0, `edit-all: adding Webinars without a budget stays blocked (got ${putCalls.length} PUTs)`);
    const blocked = capturedToasts().find((t) => t.title === "Webinar Budget is required when Webinars is selected");
    assert(blocked !== undefined, `edit-all: the Webinar block toast must fire — got ${JSON.stringify(toastTitles())}`);
    console.log("  ✓ edit-all add-without-budget still blocked");

    resetToasts();
    setInputValue("input-webinar-budget", "750");
    await flush();
    click("button-save-section");
    await flush();

    assert(putCalls.length === 1, "edit-all: entering the Webinar budget unblocks the save");
    assert(putCalls[0].webinarBudget === 750, `edit-all: the PUT carries the entered budget (got ${JSON.stringify(putCalls[0].webinarBudget)})`);
    assert(
      putCalls[0].lsaBudget === null,
      "edit-all: the unrelated stored LSA gap rides along untouched — it must not block the add-fix save",
    );
    console.log("  ✓ entering the added product's budget unblocks the edit-all save");
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  activeFetchHandler = makeFetchHandler();

  for (const v of VARIANTS) {
    await runVariant(v);
  }
  await runLegacyRemovalScenario();
  await runGapCreatingEditsStillBlockedScenario();
  await runEditAllScenario();
  await runMissingBudgetIndicatorScenario();

  console.log("\ncommand-panel-budget-validation-scope: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
