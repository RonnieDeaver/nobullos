/* test-registration
{
  "name": "Prod-actions calm bucket renders nextEligibleAt as a friendly local time (Task #4768)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Fast (~0.5s), deterministic jsdom mount with a fully stubbed fetch — no DB, no timers beyond flush; guards the CEO-facing calm-bucket time formatting from silently reverting to raw ISO.",
  "tier": "small"
}
test-registration */
/**
 * Task #4768 — the calm auto-managed bucket's "auto-applies by ~{time}"
 * detail arrives from the server with the scheduler's raw `nextEligibleAt`
 * ISO string embedded. The panel must render it as a friendly LOCAL time
 * ("in 4h" / "today 21:00" / short local date) instead of the raw
 * "2026-…T…Z" form, while leaving the absent-time branch ("auto-applies on
 * an upcoming pass.") untouched.
 *
 * Mounts the real `ProdActionsPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch` (prior-task
 * harness pattern: tests/client/prod-actions-blocked-vs-error-styling.test.tsx).
 * Fixture times are clock-derived offsets, never absolute date literals.
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
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
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

// Clock-derived fixture times (absolute future literals rot — see the
// future-date-literal lint). ~4h ahead exercises the relative "in Nh"
// form regardless of the runner's timezone or local day boundary; ~10
// days ahead exercises the short-local-date fallback.
const NEXT_IN_4H_ISO = new Date(Date.now() + 4 * 3600_000).toISOString();
const NEXT_FAR_ISO = new Date(Date.now() + 10 * 24 * 3600_000).toISOString();

const STATUSES = {
  actions: [],
  active: [],
  autoManaged: [
    {
      id: "enrolled_calm",
      title: "Backfill stale rollups",
      description: "Enrolled converging action a healthy scheduler will press.",
      change: "backfill rollups",
      status: { state: "pending", detail: "12 rows pending." },
      convergence: { kind: "converging" },
      autoManaged: true,
      autoManagedDetail: `Enrolled in self-heal — auto-applies by ~${NEXT_IN_4H_ISO} (next eligible pass).`,
    },
    {
      id: "enrolled_far",
      title: "Prune old snapshots",
      description: "Enrolled action whose next pass is far out.",
      change: "prune snapshots",
      status: { state: "pending", detail: "3 rows pending." },
      convergence: { kind: "converging" },
      autoManaged: true,
      autoManagedDetail: `Enrolled in self-heal — auto-applies by ~${NEXT_FAR_ISO} (next eligible pass).`,
    },
    {
      id: "enrolled_no_time",
      title: "Reconcile counters",
      description: "Enrolled action without a known next-eligible time.",
      change: "reconcile counters",
      status: { state: "pending", detail: "2 rows pending." },
      convergence: { kind: "converging" },
      autoManaged: true,
      autoManagedDetail: "Enrolled in self-heal — auto-applies on an upcoming pass.",
    },
  ],
  completed: [],
  selfHealEnabled: true,
  selfHealLastRun: null,
};

const fetchHandler = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { method: "POST", json: { results: [] } },
    { path: "/api/admin/prod-actions/runs", json: { runs: [] } },
    { path: "/api/admin/prod-actions", json: STATUSES },
  ],
  defaultJson: {},
});

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom globals + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
(globalThis as any).React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider, QueryClient } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const { ProdActionsPanel } = await import(
  "../../client/src/components/admin/ProdActionsPanel"
);

(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  return fetchHandler(url, init);
};

async function flush(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

const RAW_ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

async function main(): Promise<void> {
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  console.log(
    "Prod-actions calm bucket renders nextEligibleAt as a friendly local time (Task #4768)",
  );

  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(ProdActionsPanel as any),
      ),
    );
  });
  await flush();

  try {
    // The panel only fetches once opened — click the header toggle.
    const header = $("header-prod-actions-toggle");
    assert(header !== null, "panel header toggle must render");
    await act(async () => {
      header!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // ---- near-term row: relative friendly form, no raw ISO ----
    const near = $("text-prod-action-automanaged-detail-enrolled_calm");
    assert(near !== null, "enrolled_calm auto-managed detail must render");
    const nearText = near!.textContent || "";
    assert(
      !RAW_ISO_RE.test(nearText),
      `near-term detail must NOT contain a raw ISO timestamp — got "${nearText}"`,
    );
    assert(
      /auto-applies by ~in [34]h/.test(nearText),
      `near-term detail must read "auto-applies by ~in 4h" (rounded) — got "${nearText}"`,
    );
    assert(
      nearText.includes("(next eligible pass)"),
      `surrounding copy must be preserved — got "${nearText}"`,
    );

    // ---- far-future row: short local date, no raw ISO, no Invalid ----
    const far = $("text-prod-action-automanaged-detail-enrolled_far");
    assert(far !== null, "enrolled_far auto-managed detail must render");
    const farText = far!.textContent || "";
    assert(
      !RAW_ISO_RE.test(farText),
      `far-future detail must NOT contain a raw ISO timestamp — got "${farText}"`,
    );
    assert(
      !farText.includes("Invalid"),
      `far-future detail must never render "Invalid Date" — got "${farText}"`,
    );
    // Short local form always includes the numeric day-of-month of the
    // target date (locale-independent enough for jsdom's en-US default).
    const farDay = String(new Date(NEXT_FAR_ISO).getDate());
    assert(
      farText.includes(farDay),
      `far-future detail must include the local day-of-month "${farDay}" — got "${farText}"`,
    );

    // ---- absent-time row: fallback branch passes through untouched ----
    const none = $("text-prod-action-automanaged-detail-enrolled_no_time");
    assert(none !== null, "enrolled_no_time auto-managed detail must render");
    assert(
      (none!.textContent || "").includes(
        "auto-applies on an upcoming pass.",
      ),
      `absent-nextEligibleAt fallback copy must be untouched — got "${none!.textContent}"`,
    );

    console.log("ok — calm-bucket nextEligibleAt renders friendly local time");
  } finally {
    if (root) {
      await act(async () => {
        (root as unknown as Root).unmount();
      });
    }
    queryClient.clear();
  }
}

await main();
