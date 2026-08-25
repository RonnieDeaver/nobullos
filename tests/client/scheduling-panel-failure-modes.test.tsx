/* test-registration
{
  "name": "Schedule tab failure modes \u2014 silenced toasts (Task #866)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.8s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/setup-mocks.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "notes": "Note: this test passes its tsconfig via TSX_TSCONFIG_PATH (not the shared `--tsconfig` flag) because once `--import` is forwarded to Node, Node \u2014 not tsx \u2014 receives subsequent flags and rejects `--tsconfig` as an unknown option.",
  "tier": "small"
}
test-registration */
/**
 * Task #866 — Frontend regression test for ClientSchedulingPanel's
 * three Schedule-tab failure modes (the silenced toast contract from
 * Task #860).
 *
 * Mounts the real ClientSchedulingPanel against the real
 * `client/src/lib/queryClient` (so the QueryCache.onError → "Request
 * failed" toast pipeline is the production one) with a stubbed
 * `globalThis.fetch` that controls each scenario:
 *
 *   1. GET /api/booking/me/page → 503 { error: "booking_schema_not_ready" }
 *      ⇒ panel renders the "Scheduling is temporarily unavailable" card
 *        (testid `card-client-scheduling-unavailable`) AND no global
 *        "Request failed" toast was dispatched.
 *
 *   2. GET /api/booking/me/page → 200 { page: null }
 *      ⇒ panel falls into the existing fallback card
 *        (testid `card-client-scheduling-error`) — same card the panel
 *        renders today when the page query succeeds without a usable
 *        page row.
 *
 *   3. GET /api/booking/me/page → 200 valid page,
 *      GET /api/booking/clients/:id/meetings → 500
 *      ⇒ inline "Meetings could not be loaded" message renders inside
 *        the meetings card (testid `text-meetings-error`) AND no global
 *        "Request failed" toast was dispatched.
 *
 * The toast assertion is the lock-in: if a future change drops
 * `meta: { silent: true }` on either the page or meetings query, the
 * QueryCache.onError handler in queryClient.ts will dispatch a
 * "Request failed" toast and these tests will fail.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div><div id='spy'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
// wouter's useBrowserLocation reads the bare `location`/`history` globals at
// hook mount (a wouter hook entered the panel's component graph after this
// suite was written), so expose them like a real browser would.
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
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

// ---------------------------------------------------------------------------
// Stub fetch (configurable per scenario via setFetchHandler)
// ---------------------------------------------------------------------------

type FetchHandler = (url: string, init?: any) => Promise<Response> | Response;
let fetchHandler: FetchHandler = async () => {
  throw new Error("no fetch handler set");
};
function setFetchHandler(h: FetchHandler): void {
  fetchHandler = h;
}
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url =
    typeof input === "string" ? input : input?.url ?? String(input);
  return fetchHandler(url, init);
};

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom globals + fetch shim are installed,
// because client modules touch `window` / `document` at import time.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider, QueryClient } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const useToastModule = await import("../../client/src/hooks/use-toast");
const ClientSchedulingPanel = (
  await import("../../client/src/components/booking/ClientSchedulingPanel")
).default;

// ---------------------------------------------------------------------------
// Toast spy: the production `toast()` helper writes to a module-internal
// `memoryState` and notifies subscribers added via `useToast()`. We mount
// a tiny observer component that uses the hook so its listener is wired
// up; every state update appends to `recordedToasts` for the assertions.
// ---------------------------------------------------------------------------

let recordedToasts: Array<{ title?: any; description?: any; variant?: any }> = [];
const seenIds = new Set<string>();

function ToastSpy(): any {
  const { toasts } = useToastModule.useToast();
  for (const t of toasts) {
    if (!seenIds.has(t.id)) {
      seenIds.add(t.id);
      recordedToasts.push({
        title: t.title,
        description: t.description,
        variant: (t as any).variant,
      });
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function mountPanel(): Promise<{ root: Root; spyRoot: Root }> {
  const container = document.getElementById("root")!;
  const spyContainer = document.getElementById("spy")!;
  let root: Root | null = null;
  let spyRoot: Root | null = null;

  await act(async () => {
    spyRoot = createRoot(spyContainer);
    spyRoot.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(ToastSpy as any),
      ),
    );
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(ClientSchedulingPanel as any, {
          clientId: "test-client-866",
        }),
      ),
    );
  });
  await flush();
  return { root: root!, spyRoot: spyRoot! };
}

async function unmount(roots: { root: Root; spyRoot: Root }): Promise<void> {
  await act(async () => {
    roots.root.unmount();
    roots.spyRoot.unmount();
  });
  // Clear any cached query state so the next scenario starts fresh.
  queryClient.clear();
  recordedToasts = [];
  seenIds.clear();
  // Re-mount the spy after clear so we keep observing on the next mount.
}

function hasRequestFailedToast(): boolean {
  return recordedToasts.some(
    (t) =>
      typeof t.title === "string" &&
      (t.title === "Request failed" || /^Request failed/.test(t.title)),
  );
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenario1_schemaNotReady(): Promise<void> {
  console.log("\n— Scenario 1: 503 booking_schema_not_ready → unavailable card, no toast —");
  setFetchHandler(
    createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        {
          path: "/api/booking/me/page",
          status: 503,
          json: {
            error: "booking_schema_not_ready",
            message: "Booking database tables are not installed.",
          },
        },
        { path: "/api/auth/user", status: 401, json: {} },
        { path: "/api/booking/me/meeting-types", json: { meetingTypes: [] } },
        { path: "/api/clients/", json: [] },
      ],
      // Any other call (slots/meetings) should NOT be reached when schema
      // is not ready — fail loudly if it is.
      defaultJson: ({ url }: any) => {
        throw new Error(`Scenario 1: unexpected fetch ${url}`);
      },
    }),
  );

  const roots = await mountPanel();
  try {
    assert(
      $("card-client-scheduling-unavailable") !== null,
      "unavailable card must render when /api/booking/me/page returns 503 booking_schema_not_ready",
    );
    const desc = $("text-scheduling-unavailable");
    assert(
      desc !== null && /temporarily unavailable/i.test(desc.textContent || ""),
      `unavailable card must include the "temporarily unavailable" copy (got "${desc?.textContent}")`,
    );
    assert(
      $("card-client-scheduling") === null &&
        $("card-client-scheduling-error") === null,
      "the normal scheduling card and the generic error card must NOT render in the schema-not-ready branch",
    );
    assert(
      !hasRequestFailedToast(),
      `no global "Request failed" toast must fire (recorded toasts: ${JSON.stringify(
        recordedToasts,
      )})`,
    );
    console.log("  ✓ unavailable card rendered");
    console.log("  ✓ no global 'Request failed' toast fired");
  } finally {
    await unmount(roots);
  }
}

async function scenario2_pageNull(): Promise<void> {
  console.log("\n— Scenario 2: 200 { page: null } → existing fallback card —");
  setFetchHandler(
    createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        { path: "/api/booking/me/page", json: { page: null } },
        { path: "/api/auth/user", status: 401, json: {} },
        { path: "/api/booking/me/meeting-types", json: { meetingTypes: [] } },
        { path: "/api/clients/", json: [] },
      ],
      defaultJson: ({ url }: any) => {
        throw new Error(`Scenario 2: unexpected fetch ${url}`);
      },
    }),
  );

  const roots = await mountPanel();
  try {
    assert(
      $("card-client-scheduling-error") !== null,
      "fallback 'could not load booking page' card must render when /api/booking/me/page returns { page: null }",
    );
    assert(
      $("card-client-scheduling-unavailable") === null,
      "the schema-not-ready card must NOT render when status is 200",
    );
    assert(
      $("card-client-scheduling") === null,
      "the main scheduling card must NOT render without a usable page",
    );
    assert(
      !hasRequestFailedToast(),
      `no global "Request failed" toast must fire on 200 { page: null } (recorded toasts: ${JSON.stringify(
        recordedToasts,
      )})`,
    );
    console.log("  ✓ fallback scheduling-error card rendered");
    console.log("  ✓ no global 'Request failed' toast fired");
  } finally {
    await unmount(roots);
  }
}

async function scenario3_meetings500(): Promise<void> {
  console.log("\n— Scenario 3: meetings 500 → inline error in meetings card, no toast —");
  const validPage = {
    id: "page-866",
    accountManagerUserId: "am-866",
    slug: "probe-866",
    durationMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    timezone: "America/Chicago",
    active: true,
    title: "",
    description: "",
    isDefault: false,
  };
  setFetchHandler(
    createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        {
          path: "/api/booking/me/page",
          json: { page: validPage, recurrenceFeatureEnabled: false },
        },
        { path: "/api/booking/me/meeting-types", json: { meetingTypes: [] } },
        {
          path: "/api/booking/clients/test-client-866/meetings",
          status: 500,
          json: { error: "internal" },
        },
        // Return an empty slots envelope so the slot grid renders the
        // "no availability" path without erroring.
        { path: "/api/booking/clients/test-client-866/slots", json: { slots: [] } },
        { path: "/api/auth/user", status: 401, json: {} },
        { path: "/api/clients/test-client-866/contacts", json: [] },
      ],
      // Any other call is fine — return an empty 200 so the panel doesn't
      // error on incidental requests we don't care about for this assertion.
      defaultJson: {},
    }),
  );

  const roots = await mountPanel();
  try {
    // Wait a few extra frames for the meetings query to fail and the
    // error branch to render.
    await flush(8);

    assert(
      $("card-client-scheduling") !== null,
      "main scheduling card must render when the page query succeeds with a real page",
    );
    assert(
      $("card-client-meetings") !== null,
      "meetings card must render alongside the scheduling card",
    );
    const meetingsErr = $("text-meetings-error");
    assert(
      meetingsErr !== null,
      "inline meetings-error message must render when /meetings returns 500",
    );
    assert(
      /Meetings could not be loaded/i.test(meetingsErr?.textContent || ""),
      `meetings-error message must include the "Meetings could not be loaded" copy (got "${meetingsErr?.textContent}")`,
    );
    assert(
      !hasRequestFailedToast(),
      `no global "Request failed" toast must fire when /meetings returns 500 (recorded toasts: ${JSON.stringify(
        recordedToasts,
      )})`,
    );
    console.log("  ✓ inline 'Meetings could not be loaded' message rendered");
    console.log("  ✓ no global 'Request failed' toast fired");
  } finally {
    await unmount(roots);
  }
}

async function main(): Promise<void> {
  // Sanity: the production queryClient really is a QueryClient — guards
  // against an accidental refactor that swaps the export.
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  await scenario1_schemaNotReady();
  await scenario2_pageNull();
  await scenario3_meetings500();

  console.log("\nscheduling-panel-failure-modes: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
