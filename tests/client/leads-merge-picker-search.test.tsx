/* test-registration
{
  "name": "Leads merge picker \u2014 debounced search \u2192 candidates \u2192 confirm \u2192 merge mutation (Task #4619)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Pure jsdom mount test (no DB, stubbed fetch, manually-fired debounce timers) \u2014 fast and deterministic, and it is the only client-side guard on the Task #4584 server-backed merge picker, whose rendering regressions would otherwise ship silently.",
  "extraNodeArgs": [
    "--import",
    "./tests/leads-merge-picker-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4619 — Client-side regression test for the "Merge into…" picker in the
 * lead detail dialog (`client/src/pages/Leads.tsx`, LeadDetail).
 *
 * Task #4584 replaced the list-fed merge dropdown with a server-backed search
 * box (GET /api/leads/merge-candidates). The API is covered end-to-end in
 * tests/lead-lifecycle.test.ts (step 12), but the browser flow had no mount
 * test. This locks in:
 *
 *   1. Typing <2 chars never fires the candidates query; typing a real query
 *      does nothing until the 250 ms debounce timer fires (timers at exactly
 *      that delay are captured and fired manually, per the mount-kit
 *      convention), then the candidate list renders the stubbed rows and the
 *      request URL carries the encoded query + exclude=<open lead id>.
 *   2. Selecting a candidate swaps the input for the selected-target row and
 *      shows the confirm block naming BOTH the target and the to-be-deleted
 *      lead, with a destructive-variant confirm button.
 *   3. Clicking confirm POSTs /api/leads/:loserId/merge with exactly the
 *      selected targetClientId.
 *
 * Mounts the real `Leads` page (as a CEO) against the production
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. Radix
 * Dialog + Select are shimmed (see `tests/leads-merge-picker-setup.mjs`)
 * because neither portals into the raw jsdom harness.
 */

import { JSDOM } from "jsdom";
import { createFetchStub, createJsonResponse } from "../helpers/createFetchStub.mjs";

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
(globalThis as any).HTMLSelectElement = dom.window.HTMLSelectElement;
(globalThis as any).HTMLFormElement = dom.window.HTMLFormElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).FocusEvent = dom.window.FocusEvent;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).InputEvent = dom.window.InputEvent;
(globalThis as any).MutationObserver = dom.window.MutationObserver;
(globalThis as any).DOMRect = dom.window.DOMRect;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
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
// Debounce timer capture — the merge search debounce is `setTimeout(..., 250)`
// in LeadDetail. Per the mount-kit convention, timers at exactly that delay
// are captured (never scheduled) and fired manually so the test is
// deterministic; every other delay passes through to real timers so act/flush
// loops keep working. clearTimeout on a captured handle marks it inactive
// (the effect cleanup clears the previous keystroke's timer).
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 250;
type CapturedTimer = { fn: () => void; active: boolean };
const capturedDebounce: CapturedTimer[] = [];
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
(globalThis as any).setTimeout = (fn: any, delay?: number, ...args: any[]) => {
  if (delay === DEBOUNCE_MS) {
    const entry: CapturedTimer = { fn: () => fn(...args), active: true };
    capturedDebounce.push(entry);
    return { __captured: entry } as any;
  }
  return realSetTimeout(fn as any, delay, ...args);
};
(globalThis as any).clearTimeout = (handle: any) => {
  if (handle && handle.__captured) {
    handle.__captured.active = false;
    return;
  }
  return realClearTimeout(handle);
};

function activeDebounceTimers(): CapturedTimer[] {
  return capturedDebounce.filter((t) => t.active);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CEO_USER = {
  id: "ceo-4619",
  email: "ceo@example.com",
  firstName: "Cee",
  lastName: "Oh",
  role: "ceo",
};

const LOSER = {
  id: "lead-loser-4619",
  clientCode: null,
  firmName: "Acme Duplicate LLC",
  contactName: "Pat Dupe",
  contactEmail: "pat@acmedupe.law",
  contactPhone: null,
  lifecycleStage: "lead",
  leadSource: "website_inquiry",
  firstTouchSource: null,
  firstTouchCampaign: null,
  leadLastActivityAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const LEAD_ROW = { ...LOSER, openDealId: null, openDealName: null };

const DETAIL_RESPONSE = {
  client: LOSER,
  history: [],
  inquiries: [
    {
      id: "inq-4619",
      createdAt: "2026-08-01T00:00:00.000Z",
      sourcePage: "/contact",
      message: "New address, please update.",
    },
  ],
  meetings: [],
  deals: [],
};

const CANDIDATES = [
  {
    id: "cand-acme-original",
    firmName: "Acme Original Law",
    contactName: "Pat Partner",
    contactEmail: "pat@acme.law",
    lifecycleStage: "customer",
  },
  {
    id: "cand-acme-west",
    firmName: "Acme West",
    contactName: null,
    contactEmail: null,
    lifecycleStage: "opportunity",
  },
];

let candidateRequests: string[] = [];
let mergeCalls: { url: string; method: string; body: any }[] = [];

const jsonResponse = createJsonResponse(dom.window.Headers) as (
  status: number,
  body: any,
) => Response;

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    // Server-backed merge-target search — record every request URL. Fresh
    // clones per call (setState bail-out safety).
    {
      test: (url: string) => url.includes("/api/leads/merge-candidates"),
      respond: ({ url }: any) => {
        candidateRequests.push(url);
        return jsonResponse(200, { data: CANDIDATES.map((c) => ({ ...c })) });
      },
    },
    // The destructive merge itself.
    {
      method: "POST",
      test: (url: string) => /\/api\/leads\/[^/?]+\/merge$/.test(url),
      respond: ({ url, method, init }: any) => {
        let body: any = null;
        try {
          body = init?.body ? JSON.parse(String(init.body)) : null;
        } catch {
          body = null;
        }
        mergeCalls.push({ url, method, body });
        return jsonResponse(200, {
          merged: true,
          moved: { inquiries: 1, meetings: 0, deals: 0 },
        });
      },
    },
    { path: "/api/auth/user", json: CEO_USER },
    // Lead detail (deeper than the list route, so it goes first).
    {
      test: (url: string) => /\/api\/leads\/[^/?]+$/.test(url),
      json: () => ({ ...DETAIL_RESPONSE }),
    },
    // Leads list (with or without filter query string).
    {
      test: (url: string) => /\/api\/leads(\?|$)/.test(url),
      json: () => ({ data: [{ ...LEAD_ROW }], total: 1 }),
    },
  ],
  defaultJson: {},
});

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom globals + fetch/timer shims are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const Leads = (await import("../../client/src/pages/Leads")).default;

async function flush(times = 16): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => realSetTimeout(r, 5));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function clickById(testId: string): Promise<void> {
  const el = $(testId);
  assert(el !== null, `expected [data-testid="${testId}"] to exist before click`);
  await act(async () => {
    el!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

// Drive the controlled merge-search input like a user typing: set the value
// through the native setter (so React's value tracker sees the change) and
// dispatch a bubbling input event.
async function typeIntoMergeSearch(value: string): Promise<void> {
  const input = $("input-merge-search") as HTMLInputElement | null;
  assert(input !== null, "expected the merge search input to be rendered");
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await flush(4);
}

// Fire the single active captured debounce timer (the latest keystroke's).
async function fireDebounce(): Promise<void> {
  const active = activeDebounceTimers();
  assert(
    active.length === 1,
    `expected exactly one active debounce timer, got ${active.length}`,
  );
  const entry = active[0];
  entry.active = false;
  await act(async () => {
    entry.fn();
  });
  await flush();
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
        React.createElement(Leads as any),
      ),
    );
  });
  await flush();
  return root!;
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    "\n— Leads merge picker: debounced search → candidates → select → confirm → mutation —",
  );
  const root = await mountPage();
  try {
    // Open the lead detail dialog.
    await clickById(`button-lead-detail-${LOSER.id}`);
    assert($("section-merge-lead") !== null, "merge section must render for a manager role");
    assert($("input-merge-search") !== null, "merge search input must render before a target is picked");

    // 1a. A sub-minimum query (1 char) sets a debounce timer, but even after
    // it fires nothing is searched (length < 2 keeps the query disabled).
    await typeIntoMergeSearch("a");
    await fireDebounce();
    assert($("list-merge-candidates") === null, "no candidate list for a 1-char query");
    assert(candidateRequests.length === 0, "no candidates request for a 1-char query");

    // 1b. A real query: nothing happens until the debounce timer fires.
    await typeIntoMergeSearch("acme or");
    assert(
      $("list-merge-candidates") === null,
      "candidate list must NOT appear before the debounce timer fires",
    );
    assert(
      candidateRequests.length === 0,
      "candidates must NOT be fetched before the debounce timer fires",
    );
    await fireDebounce();

    const list = $("list-merge-candidates");
    assert(list !== null, "candidate list must render after the debounce fires");
    assert(candidateRequests.length === 1, `exactly one candidates request, got ${candidateRequests.length}`);
    const reqUrl = candidateRequests[0];
    assert(
      reqUrl.includes(`q=${encodeURIComponent("acme or")}`),
      `request must carry the encoded query — got ${reqUrl}`,
    );
    assert(
      reqUrl.includes(`exclude=${LOSER.id}`),
      `request must exclude the open lead — got ${reqUrl}`,
    );
    for (const c of CANDIDATES) {
      const btn = $(`button-merge-candidate-${c.id}`);
      assert(btn !== null, `candidate row for ${c.id} must render`);
      assert(
        btn!.textContent!.includes(c.firmName),
        `candidate row must show the firm name "${c.firmName}"`,
      );
    }

    // 2. Select a candidate → confirm block names the target AND the loser,
    // the search input is replaced by the selected-target row, and the
    // confirm button is destructive-variant.
    const target = CANDIDATES[0];
    await clickById(`button-merge-candidate-${target.id}`);
    assert($("input-merge-search") === null, "search input must be replaced once a target is selected");
    const selected = $("text-merge-target-selected");
    assert(selected !== null, "selected-target row must render");
    assert(
      selected!.textContent!.includes(target.firmName),
      "selected-target row must name the target firm",
    );
    const confirm = $("text-merge-confirm");
    assert(confirm !== null, "confirm block must render after selecting a target");
    assert(
      confirm!.textContent!.includes(target.firmName),
      `confirm block must name the merge target "${target.firmName}"`,
    );
    assert(
      confirm!.textContent!.includes(LOSER.firmName),
      `confirm block must name the to-be-deleted lead "${LOSER.firmName}"`,
    );
    const confirmBtn = $("button-confirm-merge");
    assert(confirmBtn !== null, "confirm merge button must render");
    assert(
      confirmBtn!.className.includes("destructive"),
      `confirm merge button must use the destructive variant — got class "${confirmBtn!.className}"`,
    );
    assert(mergeCalls.length === 0, "merge must not fire before the confirm click");

    // 3. Confirm → the mutation POSTs the loser's merge route with exactly
    // the selected targetClientId.
    await clickById("button-confirm-merge");
    assert(mergeCalls.length === 1, `exactly one merge call, got ${mergeCalls.length}`);
    const call = mergeCalls[0];
    assert(call.method === "POST", `merge must POST — got ${call.method}`);
    assert(
      call.url.includes(`/api/leads/${LOSER.id}/merge`),
      `merge must target the open lead's route — got ${call.url}`,
    );
    assert(
      call.body?.targetClientId === target.id,
      `merge body must carry targetClientId "${target.id}" — got ${JSON.stringify(call.body)}`,
    );

    console.log(
      "  ✓ debounced search fetched with q+exclude, candidates rendered, confirm named the target, merge fired with the right targetClientId",
    );
  } finally {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  }
  console.log("\nleads-merge-picker-search: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
