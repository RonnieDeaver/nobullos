/* test-registration
{
  "name": "Ads OS Search Term Analyzer direct pages expose the persistent mode switch — both routes render both destinations with the current mode selected and support keyboard switching in either direction",
  "regression": true,
  "smoke": true,
  "smokeReason": "The port previously left the existing New Keywords route undiscoverable from the direct Negative Keywords page. This fast DB-free jsdom mount guards both real tool pages, route destinations, active tab semantics, and bidirectional keyboard switching without exercising vendor or analyzer logic.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/ads-os-tools-read-only-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small",
  "tierReason": "Although it imports two real tool pages, the shared loader stubs CSS/Clerk only, both mounts use local fetch fixtures, and the focused cold run completes in about 2 seconds with no DB or network work."
}
test-registration */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const CID = "1234567890";
const NEGATIVES_PATH = `/ads-os/a/${CID}/analyzer/negatives`;
const KEYWORDS_PATH = `/ads-os/a/${CID}/analyzer/keywords`;

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: `http://localhost${NEGATIVES_PATH}` },
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

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const NEGATIVES_REPORT = {
  customer_id: CID,
  account_name: "NoBull Test Account",
  currency_code: "USD",
  generated_at: new Date().toISOString(),
  lookback_days: 7,
  candidate_count: 0,
  reviewed_cost: 0,
  waste_terms: 0,
  wasted_spend: 0,
  keyword_spend: 0,
  traffic_quality: null,
  coverage: null,
  suggestions: [],
  eligible: false,
  monitored_campaigns: 0,
  scope_note: "Not enrolled for this test.",
  has_criteria: false,
  warnings: [],
  from_cache: true,
};

const KEYWORDS_REPORT = {
  customer_id: CID,
  account_name: "NoBull Test Account",
  currency_code: "USD",
  generated_at: new Date().toISOString(),
  lookback_days: 30,
  converting_terms: 0,
  actioned_hidden: 0,
  account_blocked: 0,
  suggestions: [],
  conflicts: [],
  negatives_checked: false,
  negatives_generated_at: null,
  negatives_window_days: null,
  eligible: false,
  monitored_campaigns: 0,
  scope_note: "Not enrolled for this test.",
  warnings: [],
  from_cache: true,
};

const fetchStub = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      path: "/api/auth/user",
      json: {
        id: "account-manager-analyzer-tabs",
        email: "account-manager@example.com",
        firstName: "Amy",
        lastName: "User",
        role: "account_manager",
      },
    },
    {
      path: new RegExp(`/api/ads-os/keyword-intel/${CID}/keywords(?:\\?|$)`),
      json: KEYWORDS_REPORT,
    },
    {
      path: new RegExp(`/api/ads-os/keyword-intel/${CID}(?:\\?|$)`),
      json: NEGATIVES_REPORT,
    },
    {
      path: "/api/ads-os/monitored-accounts",
      json: { accounts: [] },
    },
    {
      path: `/api/ads-os/clients/${CID}/sibling`,
      json: { sibling_cid: null, sibling_product: null },
    },
  ],
  defaultJson: ({ url }: { url: string }) => {
    throw new Error(`Unexpected fetch in analyzer mode test: ${url}`);
  },
});
(globalThis as any).fetch = fetchStub;

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const KeywordIntelTool = (
  await import("../../client/src/pages/adsOs/KeywordIntelTool")
).default;
const KeywordFinderTool = (
  await import("../../client/src/pages/adsOs/KeywordFinderTool")
).default;

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function tab(mode: "negatives" | "keywords"): HTMLAnchorElement {
  const element = document.querySelector(
    `[data-testid="tab-analyzer-${mode}"]`,
  ) as HTMLAnchorElement | null;
  assert(element, `${mode} tab must render`);
  return element;
}

async function mountPage(Component: typeof KeywordIntelTool): Promise<{
  root: Root;
  qc: InstanceType<typeof QueryClient>;
}> {
  const container = document.getElementById("root")!;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: qc } as any,
        React.createElement(Component as any),
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
  document.getElementById("root")!.innerHTML = "";
}

function assertTabContract(activeMode: "negatives" | "keywords") {
  const negatives = tab("negatives");
  const keywords = tab("keywords");
  const inactive = activeMode === "negatives" ? keywords : negatives;
  const active = activeMode === "negatives" ? negatives : keywords;

  assert(document.querySelector('[role="tablist"][aria-label="Analyzer mode"]'), "tablist semantics");
  assert(negatives.getAttribute("href") === NEGATIVES_PATH, "negative destination must stay unchanged");
  assert(keywords.getAttribute("href") === KEYWORDS_PATH, "keyword destination must stay unchanged");
  assert(active.getAttribute("aria-selected") === "true", `${activeMode} must be selected`);
  assert(active.tabIndex === 0, `${activeMode} must be the tab stop`);
  assert(inactive.getAttribute("aria-selected") === "false", "the other mode must not be selected");
  assert(inactive.tabIndex === -1, "the inactive mode must use roving tab focus");
  assert(active.getAttribute("aria-controls") === "analyzer-mode-panel", "active tab must own the panel");
  assert(
    document.getElementById("analyzer-mode-panel")?.getAttribute("role") === "tabpanel",
    "tool content must expose its tabpanel",
  );
}

console.log("\n— Negative Keywords direct route exposes both analyzer modes —");
{
  const { root, qc } = await mountPage(KeywordIntelTool);
  try {
    assertTabContract("negatives");
    await act(async () => {
      tab("negatives").dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    assert(
      dom.window.location.pathname === KEYWORDS_PATH,
      "ArrowRight must switch from Negative Keywords to New Keywords",
    );
    console.log("  ✓ both destinations render; negatives selected; ArrowRight opens keywords");
  } finally {
    await unmount(root, qc);
  }
}

console.log("\n— New Keywords direct route exposes both analyzer modes —");
{
  const { root, qc } = await mountPage(KeywordFinderTool);
  try {
    assertTabContract("keywords");
    await act(async () => {
      tab("keywords").dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
    });
    assert(
      dom.window.location.pathname === NEGATIVES_PATH,
      "ArrowLeft must switch from New Keywords to Negative Keywords",
    );
    console.log("  ✓ both destinations render; keywords selected; ArrowLeft opens negatives");
  } finally {
    await unmount(root, qc);
  }
}

console.log(
  "\nads-os-analyzer-mode-tabs: both direct analyzer pages preserve their deep links, expose the active mode with tab semantics, and switch bidirectionally by keyboard.",
);