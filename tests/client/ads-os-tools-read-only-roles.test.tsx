/* test-registration
{
  "name": "Ads OS tools keep the standalone Re-run control CEO-only while every signed-in user can edit criteria — account_manager saves force a fresh recompute on budget pacing/LSA pacing/pyramid/keyword-intel (Task #5331) but never reload on hygiene; Re-run remains absent for non-CEO everywhere and CEO Re-run still forces",
  "regression": true,
  "smoke": true,
  "smokeReason": "Forced recompute (?force=) persists fresh vendor/AI results. The standalone Re-run button remains CEO-only everywhere, but the server intentionally leaves the read-side force cache-bust open to every staff role (server/routes/adsOs.ts header comment), so budget pacing/LSA pacing/pyramid/keyword-intel must force a fresh reload after ANY role saves criteria (Task #5331) — hygiene audit/LSA hygiene tools don't reload on save at all and stay force-free. A refactor could hide the shared editor from account managers, re-expose Re-run, or regress either save-reload behavior. Route tests only prove direct HTTP access; this rendered-DOM and issued-URL guard is fast, deterministic, DB-free, and fully stubbed.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/ads-os-tools-read-only-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Ads OS tools keep the standalone Re-run control CEO-only while criteria
 * editing — and, for three of the six tools, the post-save reload — are
 * shared with every signed-in role.
 *
 * The account tools (BudgetPacingTool here, same shape across the pacing/
 * hygiene/keyword/pyramid tools) auto-load the stored/cached report on open
 * and offer a standalone "Re-run" button that re-requests with a force
 * parameter — which makes the server recompute via Google Ads / OpenAI and
 * persist the result. That standalone trigger stays CEO-only; criteria
 * editing remains available to every signed-in user through the shared
 * editor.
 *
 * Task #5331: budget pacing, LSA pacing, pyramid, and keyword intel also
 * force a fresh recompute on the reload that follows a saved criteria edit —
 * the server's read-side force cache-bust is intentionally open to every
 * staff role (see server/routes/adsOs.ts header comment), so a non-CEO
 * editor must see their own change reflected immediately rather than
 * waiting for the 1h cache to expire. Hygiene audit and LSA hygiene don't
 * reload at all on save, so they stay force-free for every role —
 * unchanged by this task.
 *
 * Scenario 1 — account_manager: each real tool mounts, Edit criteria opens and
 *   saves through the shared editor, Re-run is absent throughout. Budget
 *   pacing/LSA pacing/pyramid/keyword intel must issue exactly one forced
 *   reload after Save; hygiene audit/LSA hygiene must issue zero forced
 *   requests before or after Save.
 * Scenario 2 (control) — ceo: both controls render; clicking Re-run issues the
 *   budget-pacing request with force=1 (proves CEO-only operational wiring
 *   remains intact).
 *
 * Harness mirrors tests/client/ads-hygiene-read-only-roles.test.tsx (real
 * production queryClient not needed — the tool uses plain fetch via its api
 * module; the ads-os-tools-read-only-setup.mjs harness supplies the signed-in Clerk
 * stub so the REAL use-auth hook fetches /api/auth/user through our stub).
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const CID = "1234567890";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: `http://localhost/ads-os/a/${CID}/pacing` },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
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
(globalThis as any).PointerEvent =
  (dom.window as any).PointerEvent ?? (dom.window as any).MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(dom.window.HTMLElement.prototype as any).scrollIntoView =
  (dom.window.HTMLElement.prototype as any).scrollIntoView || function () {};
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
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;
(dom.window as any).ResizeObserver = ResizeObserverStub;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// Minimal not-enrolled report — the report-top action row (Edit criteria +
// Re-run) renders regardless of eligibility, which is all this test needs.
const PACING_REPORT = {
  customer_id: CID,
  account_name: "NoBull Test Account",
  currency_code: "USD",
  generated_at: new Date().toISOString(),
  monthly_budget: null,
  budget_source: "none",
  mtd_spend: 0,
  on_off_track_pct: null,
  recommended_daily_budget: null,
  avg_daily_spend_mtd: 0,
  expected_to_date: null,
  schedule_days: [],
  scheduled_days_elapsed: 0,
  total_scheduled_days: 0,
  days_in_month: 30,
  campaigns: [],
  daily_spend: [],
  eligible: false,
  monitored_campaigns: 0,
  scope_note: "Not labeled for Budget Pacing.",
  has_criteria: false,
  warnings: [],
  from_cache: true,
};

const CRITERIA_RESPONSE = {
  criteria: {
    business_name: "",
    website: "",
    practice_areas: [],
    service_area: "",
    services_offered: "",
    services_not_offered: "",
    competitors: "",
    extra_protected_terms: "",
    notes: "",
    schedule_days: [],
    lsa_schedule_days: [],
  },
  derived: { business_name: "", service_area: "" },
  practice_area_options: [],
  practice_area_sync_available: true,
  practice_area_sync_reason: null,
};

let fetchedUrls: string[] = [];
let criteriaPutCount = 0;

function makeHandler(role: "account_manager" | "ceo") {
  const stub = createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      {
        path: "/api/auth/user",
        json: {
          id: `${role}-4977-tools`,
          email: `${role}@example.com`,
          firstName: role === "ceo" ? "Cee" : "Amy",
          lastName: "User",
          role,
        },
      },
      { path: /\/api\/ads-os\/budget-pacing\//, json: PACING_REPORT },
      { path: "/api/ads-os/monitored-accounts", json: { accounts: [] } },
      {
        path: `/api/ads-os/clients/${CID}/criteria`,
        json: CRITERIA_RESPONSE,
      },
    ],
    defaultJson: { accounts: [], clients: [], ok: true },
  });
  return async (url: string, init?: any) => {
    fetchedUrls.push(url);
    return stub(url, init);
  };
}

function makeNonCeoToolHandler() {
  const stub = createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      {
        path: "/api/auth/user",
        json: {
          id: "account-manager-criteria-tools",
          email: "account-manager@example.com",
          firstName: "Amy",
          lastName: "User",
          role: "account_manager",
        },
      },
      {
        path: `/api/ads-os/clients/${CID}/criteria`,
        json: CRITERIA_RESPONSE,
      },
    ],
  });
  return async (url: string, init?: any) => {
    fetchedUrls.push(url);
    if (
      url.includes(`/api/ads-os/clients/${CID}/criteria`) &&
      String(init?.method ?? "GET").toUpperCase() === "PUT"
    ) {
      criteriaPutCount++;
    }
    if (
      url.includes("/api/auth/user") ||
      url.includes(`/api/ads-os/clients/${CID}/criteria`)
    ) {
      return stub(url, init);
    }
    // Keep each report's ordinary initial read pending. The action row renders
    // while loading, which lets this role smoke cover six real pages without
    // fabricating six unrelated report payloads.
    return new Promise<Response>(() => {});
  };
}

let activeFetchHandler: (url: string, init?: any) => Promise<Response> = async () => {
  throw new Error("no fetch handler set");
};
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  return activeFetchHandler(url, init);
};

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const BudgetPacingTool = (
  await import("../../client/src/pages/adsOs/BudgetPacingTool")
).default;
const LsaPacingTool = (
  await import("../../client/src/pages/adsOs/LsaPacingTool")
).default;
const HygieneAuditTool = (
  await import("../../client/src/pages/adsOs/HygieneAuditTool")
).default;
const LsaHygieneTool = (
  await import("../../client/src/pages/adsOs/LsaHygieneTool")
).default;
const KeywordIntelTool = (
  await import("../../client/src/pages/adsOs/KeywordIntelTool")
).default;
const PyramidTool = (
  await import("../../client/src/pages/adsOs/PyramidTool")
).default;

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function mountPage(
  Page: typeof BudgetPacingTool = BudgetPacingTool,
): Promise<{ root: Root; qc: InstanceType<typeof QueryClient> }> {
  const container = document.getElementById("root")!;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: qc } as any,
        React.createElement(Page as any),
      ),
    );
  });
  await flush();
  return { root: root!, qc };
}

async function unmount(root: Root, qc: InstanceType<typeof QueryClient>): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  qc.clear();
}

// ── Scenario 1: account_manager — all six criteria saves, Re-run always absent ──
console.log("\n— Scenario 1: account_manager saves criteria on all six tools; Re-run stays hidden —");
// Task #5331: these four force a fresh recompute on the post-save reload —
// the read-side force cache-bust is intentionally open to every staff role.
const FORCE_ON_SAVE_TOOL_CASES = [
  {
    name: "Google Ads pacing",
    route: `/ads-os/a/${CID}/pacing`,
    pageTestId: "page-ads-os-pacing",
    rerunTestId: "button-rerun-pacing",
    Page: BudgetPacingTool,
  },
  {
    name: "LSA pacing",
    route: `/ads-os/lsa/a/${CID}/pacing`,
    pageTestId: "page-ads-os-lsa-pacing",
    rerunTestId: "button-rerun-pacing",
    Page: LsaPacingTool,
  },
  {
    name: "pyramid",
    route: `/ads-os/a/${CID}/pyramid`,
    pageTestId: "page-ads-os-pyramid",
    rerunTestId: "button-rerun-pyramid",
    Page: PyramidTool,
  },
  {
    name: "keyword intelligence",
    route: `/ads-os/a/${CID}/analyzer/negatives`,
    pageTestId: "page-ads-os-analyzer-negatives",
    rerunTestId: "button-rerun-negatives",
    Page: KeywordIntelTool,
  },
] as const;

// Unchanged by Task #5331: these don't reload at all after Save, so they
// stay force-free for every role.
const NO_RELOAD_ON_SAVE_TOOL_CASES = [
  {
    name: "Google Ads hygiene",
    route: `/ads-os/a/${CID}/audit`,
    pageTestId: "page-ads-os-audit",
    rerunTestId: "button-rerun-audit",
    Page: HygieneAuditTool,
  },
  {
    name: "LSA hygiene",
    route: `/ads-os/lsa/a/${CID}/hygiene`,
    pageTestId: "page-ads-os-lsa-hygiene",
    rerunTestId: "button-rerun-audit",
    Page: LsaHygieneTool,
  },
] as const;

async function runNonCeoSaveCase(tool: {
  name: string;
  route: string;
  pageTestId: string;
  rerunTestId: string;
  Page: typeof BudgetPacingTool;
}): Promise<void> {
  fetchedUrls = [];
  criteriaPutCount = 0;
  activeFetchHandler = makeNonCeoToolHandler();
  history.pushState({}, "", tool.route);
  document.getElementById("root")!.innerHTML = "";
  const { root, qc } = await mountPage(tool.Page);
  try {
    assert(
      $(tool.pageTestId) !== null,
      `${tool.name} must mount for an account_manager`,
    );
    assert(
      $(tool.rerunTestId) === null,
      `${tool.name} Re-run (forced recompute) must be ABSENT for account_manager`,
    );
    assert(
      $("button-edit-criteria") !== null,
      `${tool.name} Edit criteria must RENDER for account_manager`,
    );
    await act(async () => {
      $("button-edit-criteria")!.click();
    });
    await flush();
    assert(
      $("button-criteria-save") !== null,
      `account_manager can open the loaded shared criteria editor from ${tool.name}`,
    );
    await act(async () => {
      $("button-criteria-save")!.click();
    });
    await flush();
    assert(
      criteriaPutCount === 1,
      `${tool.name} criteria editor must complete exactly one successful Save`,
    );
    assert(
      $("modal-criteria") === null,
      `${tool.name} criteria editor must close through its existing post-save callback`,
    );
    assert(
      $(tool.rerunTestId) === null,
      `${tool.name} Re-run (forced recompute) must remain ABSENT for account_manager after Save`,
    );
    const forced = fetchedUrls.filter((u) => /[?&]force(=|&|$)/.test(u));
    if (FORCE_ON_SAVE_TOOL_CASES.some((t) => t.name === tool.name)) {
      assert(
        forced.length === 1,
        `${tool.name} account_manager Save must force exactly one fresh reload (Task #5331) — got: ${forced.join(", ")}`,
      );
      console.log(`  ✓ ${tool.name}: criteria saves; Re-run absent; one forced reload after Save`);
    } else {
      assert(
        forced.length === 0,
        `${tool.name} non-CEO mount must never issue a force= request — got: ${forced.join(", ")}`,
      );
      console.log(`  ✓ ${tool.name}: criteria saves; Re-run absent; zero force= requests`);
    }
  } finally {
    await unmount(root, qc);
  }
}

for (const tool of [...FORCE_ON_SAVE_TOOL_CASES, ...NO_RELOAD_ON_SAVE_TOOL_CASES]) {
  await runNonCeoSaveCase(tool);
}

// ── Scenario 2 (control): CEO — controls render, Re-run issues force=1 ──────
console.log("\n— Scenario 2 (control): CEO sees criteria + Re-run; Re-run forces —");
fetchedUrls = [];
activeFetchHandler = makeHandler("ceo");
history.pushState({}, "", `/ads-os/a/${CID}/pacing`);
document.getElementById("root")!.innerHTML = "";
{
  const { root, qc } = await mountPage();
  try {
    assert($("button-rerun-pacing") !== null, "Re-run must RENDER for the CEO (control mount)");
    assert($("button-edit-criteria") !== null, "Edit criteria must RENDER for the CEO (control mount)");

    await act(async () => {
      $("button-rerun-pacing")!.click();
    });
    await flush();
    const forced = fetchedUrls.filter((u) => u.includes(`/api/ads-os/budget-pacing/${CID}`) && u.includes("force=1"));
    assert(
      forced.length === 1,
      `CEO Re-run must issue exactly one force=1 budget-pacing request — got ${forced.length} (urls: ${fetchedUrls.join(", ")})`,
    );
    console.log("  ✓ both buttons render for the CEO; Re-run issues force=1 (wiring intact)");
  } finally {
    await unmount(root, qc);
  }
}

console.log(
  "\nads-os-tools-read-only-roles: account_manager can save criteria on all six tools but never sees Re-run; budget pacing/LSA pacing/pyramid/keyword-intel force a fresh reload after Save (Task #5331) while hygiene tools stay force-free; the CEO control retains Re-run force wiring.",
);
