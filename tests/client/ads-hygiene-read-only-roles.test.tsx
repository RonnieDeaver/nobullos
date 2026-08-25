/* test-registration
{
  "name": "Google Ads Hygiene page renders READ-ONLY for non-CEO staff (Task #4977) — account_manager mounts the real page (no Forbidden wall), read queries fire and render, and the CEO-only trigger buttons (Run new audit, Run keyword analysis, Compute alerts, per-alert ClickUp/Resolve) are ABSENT; CEO control mount proves the same buttons render for the CEO",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4977 opened Ads OS/Hygiene reads to all staff while keeping triggers CEO-only. A page refactor could silently restore the Forbidden wall (locking AMs out again) or re-expose a CEO-only button to AMs (a silent 403 on click). The route tests only prove direct HTTP access — this is the only guard on the rendered role split. Fast deterministic jsdom render, no DB, fully stubbed fetch.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/ads-hygiene-mock-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4977 — Ads OS viewing opened to all team members.
 *
 * GoogleAdsHygieneAudit (/admin/ads-hygiene) used to be CEO-walled: every read
 * query was `enabled: isCeo` and non-CEO users got the Forbidden card. The
 * task relaxed the underlying read routes to requireAccountManager and this
 * page to any authenticated staff role, keeping the trigger mutations
 * (run audit, keyword analysis, compute alerts, per-alert ClickUp/Resolve)
 * CEO-only and HIDDEN from other roles.
 *
 * Scenario 1 — account_manager: the real page mounts (no status-forbidden),
 *   the accounts read query fires and its account renders in the picker, the
 *   alerts tab renders alert data, and ALL CEO-only trigger buttons are absent.
 * Scenario 2 (control) — ceo: the same mount renders the trigger buttons,
 *   proving scenario 1's absences are the role gate and not a harness quirk.
 *
 * Harness mirrors tests/client/ads-hygiene-reconnect-banner.test.tsx (real
 * production queryClient, stubbed fetch, popover shim via the shared
 * ads-hygiene-mock-setup.mjs resolve hook).
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/admin/ads-hygiene" },
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
(dom.window.HTMLElement.prototype as any).hasPointerCapture =
  (dom.window.HTMLElement.prototype as any).hasPointerCapture || function () { return false; };
(dom.window.HTMLElement.prototype as any).releasePointerCapture =
  (dom.window.HTMLElement.prototype as any).releasePointerCapture || function () {};
(dom.window.HTMLElement.prototype as any).setPointerCapture =
  (dom.window.HTMLElement.prototype as any).setPointerCapture || function () {};
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

const CUSTOMER_ID = "1234567890";
const ALERT_ID = "alrt-4977-1";

function makeHandler(role: "account_manager" | "ceo") {
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      {
        path: "/api/auth/user",
        json: {
          id: `${role}-4977`,
          email: `${role}@example.com`,
          firstName: role === "ceo" ? "Cee" : "Amy",
          lastName: "User",
          role,
        },
      },
      {
        path: "/api/admin/google-ads-audit/accounts",
        json: {
          accounts: [
            {
              customerId: CUSTOMER_ID,
              descriptiveName: "NoBull Test Account",
              status: "ENABLED",
              nobullClientId: null,
            },
          ],
        },
      },
      { path: /\/api\/admin\/google-ads-audit\/[^/]+\/runs$/, json: { runs: [] } },
      {
        path: /\/api\/admin\/google-ads-hygiene\/[^/]+\/alerts/,
        json: {
          alerts: [
            {
              id: ALERT_ID,
              customerId: CUSTOMER_ID,
              alertType: "budget_pace",
              severity: "high",
              title: "Pacing hot",
              detail: "Spend is pacing 40% over budget.",
              status: "open",
              clickupTaskId: null,
              clickupTaskStatus: null,
              createdAt: new Date().toISOString(),
            },
          ],
          clickupConfigured: true,
        },
      },
    ],
    defaultJson: {
      rows: [],
      runs: [],
      accounts: [],
      items: [],
      alerts: [],
      results: [],
      runAt: null,
      clickupConfigured: false,
    },
  });
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
const { QueryClientProvider } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const GoogleAdsHygieneAudit = (
  await import("../../client/src/pages/admin/GoogleAdsHygieneAudit")
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

async function clickLikeUser(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
    );
    el.dispatchEvent(
      new dom.window.MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }),
    );
    el.click();
  });
  await flush(8);
}

async function mountPage(): Promise<Root> {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(GoogleAdsHygieneAudit as any),
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

// Picks the seeded account (combobox rendered inline by the popover shim).
async function pickAccount(): Promise<void> {
  const trigger = $("select-account");
  assert(trigger !== null, "account combobox trigger must render");
  await clickLikeUser(trigger!);

  const option = $(`option-account-${CUSTOMER_ID}`);
  assert(option !== null, "account option must render inline via the popover shim");
  await clickLikeUser(option!);
}

async function openTab(tabTestId: string): Promise<void> {
  const tab = $(tabTestId);
  assert(tab !== null, `${tabTestId} trigger must render after picking an account`);
  await clickLikeUser(tab!);
}

// Each tab only mounts its own TabsContent, so the CEO-only controls must be
// asserted per tab: [tab to open (null = default audit tab), button testids].
const CEO_ONLY_BY_TAB: Array<[string | null, string[]]> = [
  [null, ["button-run-audit"]],
  ["tab-keywords", ["button-run-keyword-intel"]],
  [
    "tab-alerts",
    ["button-compute-alerts", `button-create-clickup-${ALERT_ID}`, `button-resolve-alert-${ALERT_ID}`],
  ],
];

// ── Scenario 1: account_manager gets a read-only render ─────────────────────
console.log("\n— Scenario 1: account_manager mounts the page read-only —");
activeFetchHandler = makeHandler("account_manager");
document.getElementById("root")!.innerHTML = "";
{
  const root = await mountPage();
  try {
    assert(
      $("status-forbidden") === null,
      "account_manager must NOT hit the Forbidden wall (reads open to staff, Task #4977)",
    );
    assert(
      $("page-google-ads-hygiene-audit") !== null,
      "the real page shell must render for an account_manager",
    );

    await pickAccount();
    for (const [tab, ids] of CEO_ONLY_BY_TAB) {
      if (tab) await openTab(tab);
      for (const id of ids) {
        assert($(id) === null, `CEO-only control ${id} must be ABSENT for account_manager`);
      }
    }
    assert(
      (document.body.textContent || "").includes("Pacing hot"),
      "alerts read data must render for the account_manager (read query fired and painted)",
    );
    console.log("  ✓ page renders with read data; all CEO-only trigger buttons absent");
  } finally {
    await unmount(root);
  }
}

// ── Scenario 2 (control): CEO still sees every trigger button ────────────────
console.log("\n— Scenario 2 (control): CEO sees the trigger buttons —");
activeFetchHandler = makeHandler("ceo");
document.getElementById("root")!.innerHTML = "";
{
  const root = await mountPage();
  try {
    assert($("status-forbidden") === null, "CEO must not hit the Forbidden wall");
    await pickAccount();
    for (const [tab, ids] of CEO_ONLY_BY_TAB) {
      if (tab) await openTab(tab);
      for (const id of ids) {
        assert($(id) !== null, `CEO-only control ${id} must RENDER for the CEO (control mount)`);
      }
    }
    assert(
      (document.body.textContent || "").includes("Pacing hot"),
      "alerts read data must render for the CEO too",
    );
    console.log("  ✓ every CEO-only trigger button renders for the CEO (absences above are the role gate)");
  } finally {
    await unmount(root);
  }
}

console.log(
  "\nads-hygiene-read-only-roles: account_manager gets the full read-only Google Ads Hygiene page (no Forbidden wall, data renders, zero CEO-only trigger buttons); the CEO control mount renders them all (Task #4977).",
);
