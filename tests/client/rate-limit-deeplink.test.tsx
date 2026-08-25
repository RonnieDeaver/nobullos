/* test-registration
{
  "name": "Per-user rate-limit deep-link (Task #1234)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.4s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/rate-limit-deeplink-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #1234 — Regression test for the per-user deep-link added by Task #776
 * to the Rate Limit admin page.
 *
 * Three scenarios:
 *
 *   1. Loading `/admin/rate-limits?userId=<id>` mounts RateLimitUsers and the
 *      on-mount handler:
 *        - flips activeTab to "users",
 *        - expands the matching user card (UserTimeSeriesChart renders, which
 *          emits `button-download-buckets-csv-<id>`),
 *        - strips the consumed query params off `window.location.search`.
 *
 *   2. The BlockedEventHistory rows render the plain "anonymous" label for
 *      rows whose `userId` is null and do NOT render the
 *      `link-history-open-user-<id>` deep-link anchor for them.
 *
 *   3. Cmd/ctrl-click on the deep-link anchor for an authenticated-user row
 *      is allowed to navigate — the click handler must NOT preventDefault on
 *      modified clicks, so the browser can open the URL in a new tab.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/admin/rate-limits" },
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
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(dom.window.HTMLElement.prototype as any).scrollIntoView =
  (dom.window.HTMLElement.prototype as any).scrollIntoView || function () {};
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

// ---------------------------------------------------------------------------
// Fetch stub
// ---------------------------------------------------------------------------

const ADMIN_USER = {
  id: "admin-1234",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};

const DEEPLINK_USER_ID = "u-deeplink-1";

const BY_USER_RESPONSE = {
  users: [
    {
      userId: DEEPLINK_USER_ID,
      totalBlocked: 3,
      categories: { api: 3 },
      recentEvents: [],
      firstSeen: Date.now() - 60_000,
      lastSeen: Date.now() - 1_000,
    },
  ],
  anonymous: [],
};

const SUMMARY_RESPONSE = {
  totalBlocked: 3,
  categories: {
    api: {
      totalBlocked: 3,
      windowMs: 60_000,
      maxRequests: 100,
      recentEvents: [],
      uniqueIPs: 1,
      topIPs: [],
      uniqueUsers: 1,
      topUsers: [{ userId: DEEPLINK_USER_ID, count: 3 }],
    },
  },
  collectedSince: Date.now() - 3_600_000,
};

// Everything the deep-link scenario doesn't care about is stubbed as an
// error so that the component tree falls back to its "loading/error" UI
// (data === undefined → conditionally-rendered children skipped) instead
// of rendering with a `{}`-shaped payload that crashes downstream readers
// like `growth.config.warnAt`.
(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: ADMIN_USER },
    { path: "/api/users", json: [ADMIN_USER] },
    { path: "/api/health/rate-limits/by-user", json: BY_USER_RESPONSE },
    { path: "/api/health/rate-limits/alerts", json: { alerts: [] } },
    { path: "/api/health/rate-limits/events", json: { events: [], total: 0, limit: 50, offset: 0 } },
    { path: "/api/health/rate-limits", json: SUMMARY_RESPONSE },
  ],
  defaultJson: { error: "stubbed_out_in_test" },
  defaultStatus: 500,
});

// ---------------------------------------------------------------------------
// Imports — after jsdom globals + fetch shim are set up
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const RateLimitUsersMod = await import("../../client/src/pages/admin/RateLimitUsers");
const RateLimitUsers = RateLimitUsersMod.default as any;
const { BlockedEventHistory } = RateLimitUsersMod as any;

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

function makeClient(): InstanceType<typeof QueryClient> {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 5 * 60 * 1000 },
    },
  });
  // Preload the queries the page reads synchronously on first render so that
  // `user` resolves immediately (which keeps `persistKey` stable across the
  // first commit and prevents the usePersistentState hydrate effect from
  // clobbering the deep-link's `setExpandedUser`).
  qc.setQueryData(["/api/auth/user"], ADMIN_USER);
  qc.setQueryData(["/api/health/rate-limits/by-user"], BY_USER_RESPONSE);
  qc.setQueryData(["/api/health/rate-limits"], SUMMARY_RESPONSE);
  qc.setQueryData(["/api/users"], [ADMIN_USER]);
  qc.setQueryData(["/api/health/rate-limits/alerts"], { alerts: [] });
  return qc;
}

async function mount(node: any): Promise<Root> {
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(node);
  });
  await flush();
  return root!;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

function setLocation(search: string): void {
  // jsdom supports replaceState — use it to drive both pathname + search.
  dom.window.history.replaceState({}, "", `/admin/rate-limits${search}`);
}

// ---------------------------------------------------------------------------
// Scenario 1: ?userId=<id> deep-link → users tab + expanded row + URL stripped
// ---------------------------------------------------------------------------

async function scenario1_deepLinkUserId(): Promise<void> {
  console.log("\n— Scenario 1: ?userId=<id> activates By User tab + expands the row + strips URL —");

  // Clean slate: no persisted state from a prior scenario.
  dom.window.localStorage.clear();
  setLocation(`?userId=${encodeURIComponent(DEEPLINK_USER_ID)}`);

  const qc = makeClient();
  const root = await mount(
    React.createElement(QueryClientProvider, { client: qc }, React.createElement(RateLimitUsers)),
  );
  try {
    // The By User tab is what the deep-link selects; the matching card must
    // render and its expanded-state children (UserTimeSeriesChart) must be
    // mounted.
    assert($("tab-users") !== null, "tab-users must render");

    const card = $(`card-user-${DEEPLINK_USER_ID}`);
    assert(card !== null, `card-user-${DEEPLINK_USER_ID} must render on the By User tab`);

    const expandedMarker = $(`button-download-buckets-csv-${DEEPLINK_USER_ID}`);
    assert(
      expandedMarker !== null,
      `expected the deep-linked user card to be expanded — the UserTimeSeriesChart's button-download-buckets-csv-${DEEPLINK_USER_ID} should be present`,
    );

    // The on-mount handler must strip the consumed `userId` (+ `tab`) params.
    const search = dom.window.location.search;
    assert(
      !search.includes("userId="),
      `window.location.search must not still contain userId= (got '${search}')`,
    );
    assert(
      !search.includes("tab="),
      `window.location.search must not still contain tab= (got '${search}')`,
    );

    console.log("  ✓ By User tab active, row expanded, URL params stripped");
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: anonymous history rows render plain "anonymous", no link anchor.
// Scenario 3: cmd/ctrl-click on the user link is allowed (no preventDefault).
//
// These exercise BlockedEventHistory directly — the deep-link anchor lives
// inside this child component, and isolating it avoids re-mounting the full
// page just to assert two table rows.
// ---------------------------------------------------------------------------

const HISTORY_USER_ID = "u-history-1";
const ANON_EVENT_ID = 9001;
const USER_EVENT_ID = 9002;

function makeHistoryFetch(): (url: string) => Promise<Response> {
  const baseTime = Date.now();
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      {
        path: "/api/health/rate-limits/events",
        json: {
          events: [
            {
              id: ANON_EVENT_ID,
              timestamp: baseTime - 30_000,
              category: "api",
              method: "GET",
              path: "/api/widgets",
              ip: "10.0.0.1",
              userId: null,
            },
            {
              id: USER_EVENT_ID,
              timestamp: baseTime - 60_000,
              category: "api",
              method: "POST",
              path: "/api/widgets",
              ip: "10.0.0.2",
              userId: HISTORY_USER_ID,
            },
          ],
          total: 2,
          limit: 50,
          offset: 0,
        },
      },
    ],
    defaultJson: {},
  });
}

async function scenario2_anonymousHasNoLink(): Promise<void> {
  console.log("\n— Scenario 2: anonymous history rows render 'anonymous' with no open-details link —");

  const originalFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    return makeHistoryFetch()(url);
  };

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const root = await mount(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(BlockedEventHistory, {
        dbUsers: [
          {
            id: HISTORY_USER_ID,
            firstName: "His",
            lastName: "Tory",
            email: "history@example.com",
            role: "account_manager",
          },
        ],
        summary: SUMMARY_RESPONSE,
        onJumpToUser: () => {},
        onJumpToIp: () => {},
      }),
    ),
  );
  try {
    await flush(8);

    const anonRow = $(`row-history-event-${ANON_EVENT_ID}`);
    assert(anonRow !== null, `row-history-event-${ANON_EVENT_ID} (anonymous) must render`);
    assert(
      anonRow!.textContent?.includes("anonymous") === true,
      `anonymous row must render the plain 'anonymous' label (got '${anonRow!.textContent}')`,
    );
    assert(
      $(`link-history-open-user-${ANON_EVENT_ID}`) === null,
      `anonymous row must NOT render link-history-open-user-${ANON_EVENT_ID}`,
    );
    assert(
      anonRow!.querySelector(`[data-testid="button-history-jump-user-${ANON_EVENT_ID}"]`) === null,
      `anonymous row must NOT render a Jump-to-user button either`,
    );

    const userRow = $(`row-history-event-${USER_EVENT_ID}`);
    assert(userRow !== null, `row-history-event-${USER_EVENT_ID} (user) must render`);
    const userLink = $(`link-history-open-user-${USER_EVENT_ID}`) as HTMLAnchorElement | null;
    assert(
      userLink !== null,
      `user row must render link-history-open-user-${USER_EVENT_ID}`,
    );
    assert(
      userLink!.getAttribute("href") ===
        `/admin/rate-limits?tab=users&userId=${encodeURIComponent(HISTORY_USER_ID)}`,
      `user-row link href must be the shareable per-user deep-link (got '${userLink!.getAttribute("href")}')`,
    );

    console.log("  ✓ anonymous row: plain label, no link / no jump button");
    console.log("  ✓ user row: open-details link present with shareable href");

    // ---- Scenario 3 — cmd-click must NOT preventDefault ----
    console.log("\n— Scenario 3: cmd/ctrl-click on the open-details link is allowed (no preventDefault) —");

    const metaClick = new dom.window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
      button: 0,
    });
    await act(async () => {
      userLink!.dispatchEvent(metaClick);
    });
    assert(
      metaClick.defaultPrevented === false,
      `cmd-click (metaKey:true) must NOT be preventDefault'd — defaultPrevented=${metaClick.defaultPrevented}`,
    );

    const ctrlClick = new dom.window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      button: 0,
    });
    await act(async () => {
      userLink!.dispatchEvent(ctrlClick);
    });
    assert(
      ctrlClick.defaultPrevented === false,
      `ctrl-click (ctrlKey:true) must NOT be preventDefault'd — defaultPrevented=${ctrlClick.defaultPrevented}`,
    );

    // Sanity counter-check: a plain left-click WITHOUT modifiers must be
    // preventDefault'd (so the in-page jumpToUser handler runs instead of the
    // browser navigating away). This pins down both halves of the contract.
    const plainClick = new dom.window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    await act(async () => {
      userLink!.dispatchEvent(plainClick);
    });
    assert(
      plainClick.defaultPrevented === true,
      `plain left-click (no modifiers) must be preventDefault'd (defaultPrevented=${plainClick.defaultPrevented})`,
    );

    console.log("  ✓ cmd-click and ctrl-click are allowed to navigate; plain click is intercepted");
  } finally {
    await unmount(root);
    (globalThis as any).fetch = originalFetch;
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await scenario1_deepLinkUserId();
  await scenario2_anonymousHasNoLink();
  console.log("\nrate-limit-deeplink: all scenarios passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
