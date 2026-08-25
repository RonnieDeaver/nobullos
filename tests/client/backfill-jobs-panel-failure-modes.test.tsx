/* test-registration
{
  "name": "Backfill Jobs panel failure modes \u2014 silenced toasts (Task #1614)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #1614 — Frontend regression test for BackfillJobsPanel's silenced
 * toast contract. The panel already renders an inline `backfill-jobs-error`
 * row when `GET /api/backfill-jobs` fails; this test locks in that the
 * shared QueryCache.onError handler in `client/src/lib/queryClient.ts`
 * does NOT also fire a global "Request failed" destructive toast on top
 * of that inline row.
 *
 * Mirrors the structure of `tests/client/scheduling-panel-failure-modes.test.tsx`
 * (Task #866) — mounts the real component against the real production
 * queryClient with a stubbed fetch and a ToastSpy.
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

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider, QueryClient } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const useToastModule = await import("../../client/src/hooks/use-toast");
const { BackfillJobsPanel } = await import(
  "../../client/src/components/admin/BackfillJobsPanel"
);

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
        React.createElement(BackfillJobsPanel as any),
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
  queryClient.clear();
  recordedToasts = [];
  seenIds.clear();
}

function hasRequestFailedToast(): boolean {
  return recordedToasts.some(
    (t) =>
      typeof t.title === "string" &&
      (t.title === "Request failed" || /^Request failed/.test(t.title)),
  );
}

async function scenario_listFails500(): Promise<void> {
  console.log(
    "\n— Scenario: GET /api/backfill-jobs → 500 ⇒ inline error row, no global toast —",
  );
  setFetchHandler(
    createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        { path: "/api/backfill-jobs", status: 500, json: { error: "internal" } },
      ],
      // Any incidental call (auth probes, etc.) — return an empty 200.
      defaultJson: {},
    }),
  );

  const roots = await mountPanel();
  try {
    await flush(8);

    const inline = $("backfill-jobs-error");
    assert(
      inline !== null,
      "inline `backfill-jobs-error` row must render when /api/backfill-jobs returns 500",
    );
    assert(
      /Failed to load backfill jobs/i.test(inline?.textContent || ""),
      `inline error must include the "Failed to load backfill jobs" copy (got "${inline?.textContent}")`,
    );
    assert(
      !hasRequestFailedToast(),
      `no global "Request failed" toast must fire when /api/backfill-jobs returns 500 (recorded toasts: ${JSON.stringify(
        recordedToasts,
      )})`,
    );
    console.log("  ✓ inline 'Failed to load backfill jobs' row rendered");
    console.log("  ✓ no global 'Request failed' toast fired");
  } finally {
    await unmount(roots);
  }
}

async function main(): Promise<void> {
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  await scenario_listFails500();

  console.log("\nbackfill-jobs-panel-failure-modes: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
