/* test-registration
{
  "name": "Prod-actions apply toast \u2014 whole-apply failure \u2192 'Apply failed' (Task #2253)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.5s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/alert-dialog-mock-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2253 — Frontend regression test for the apply `onError` TOAST in
 * the CEO prod-actions / maintenance panel (`ProdActionsPanel`).
 *
 * Task #2213 locked the `applyMutation.onSuccess` toast paths (calm
 * reconnect headline vs. destructive "Applied with N error(s)"). This
 * locks the sibling contract: the toast fired by `applyMutation.onError`
 * when the POST /api/admin/prod-actions/apply request itself rejects
 * (network blip / 5xx / non-2xx) rather than returning a results body.
 *
 * `apiRequest` throws `Error("<status>: <text>")` for any non-2xx
 * response (see `throwIfResNotOk` in client/src/lib/queryClient), so the
 * mutation rejects and `onError` fires a SEPARATE destructive toast
 * titled "Apply failed" with the server error surfaced as the
 * description. A refactor that re-folded this into the success handler,
 * dropped the toast, or mis-titled it would silently hide a hard apply
 * failure from the operator.
 *
 * Mounts the real `ProdActionsPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. The
 * panel only fetches statuses once opened (clicks the header toggle), and
 * the apply confirm dialog is a Radix AlertDialog — shimmed to an inline
 * pass-through (see `tests/alert-dialog-shim.mjs`) so its confirm button
 * is reachable in the raw jsdom harness. Toast is inspected via a tiny
 * recorder component that subscribes through the real `useToast()` store.
 * Harness pattern copied from #2213 (toast recorder + alert-dialog shim).
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

// One actionable (pending) row so the "Apply all" button is enabled. The
// apply itself is configured per-scenario to REJECT (non-2xx), so the
// success-results body is irrelevant here.
const STATUSES = {
  actions: [],
  active: [
    {
      id: "semrush_demand_refresh",
      title: "SEMrush demand refresh",
      description: "Re-run the stale SEMrush demand sweep.",
      change: "refresh demand keywords",
      status: { state: "pending", detail: "Stale demand keywords detected." },
    },
  ],
  completed: [],
  selfHealEnabled: false,
  selfHealLastRun: null,
};

// Configured per-scenario: the status + body returned by POST /apply. A
// non-2xx status makes `apiRequest` throw, rejecting the mutation and
// driving `applyMutation.onError`.
let applyStatus = 500;
let applyBody: any = { message: "boom" };

const fetchHandler = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      method: "POST",
      path: "/api/admin/prod-actions/apply",
      respond: () => ({ status: applyStatus, json: applyBody }),
    },
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
const { useToast } = await import("../../client/src/hooks/use-toast");

(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  return fetchHandler(url, init);
};

// The panel surfaces its apply outcome as a toast. The toast store is a
// module-level singleton (TOAST_LIMIT = 1); a tiny recorder that
// subscribes via useToast() lets us read the most-recent toast's
// title/variant/description without mounting the Radix <Toaster /> (which
// never portals in the raw jsdom harness).
let lastToast: { title?: any; description?: any; variant?: any } | null = null;
function ToastRecorder(): null {
  const { toasts } = (useToast as any)();
  if (Array.isArray(toasts) && toasts.length > 0) {
    lastToast = toasts[0];
  }
  return null;
}

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

async function clickById(testId: string): Promise<void> {
  const el = $(testId);
  assert(el !== null, `expected element [data-testid="${testId}"] to exist before click`);
  await act(async () => {
    el!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function mountPanel(): Promise<Root> {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(ProdActionsPanel as any),
        React.createElement(ToastRecorder as any),
      ),
    );
  });
  await flush();
  // The panel only fetches statuses once opened — click the header toggle.
  await clickById("header-prod-actions-toggle");
  return root!;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  queryClient.clear();
  lastToast = null;
}

// Drive a full apply: open the confirm dialog, click confirm (which fires
// applyMutation.mutate()), and let the POST + onError toast settle.
async function runApply(): Promise<void> {
  const applyBtn = $("button-prod-actions-apply") as HTMLButtonElement | null;
  assert(applyBtn !== null, "the 'Apply all' button must render");
  assert(!applyBtn!.disabled, "'Apply all' must be enabled when a pending action exists");
  await clickById("button-prod-actions-apply");
  await clickById("button-prod-actions-confirm");
}

async function scenarioApplyRejects(): Promise<void> {
  console.log("\n— Apply POST rejects (500) → destructive 'Apply failed' toast —");
  applyStatus = 500;
  applyBody = { message: "Demand aggregation crashed" };
  const root = await mountPanel();
  try {
    await runApply();

    assert(lastToast !== null, "a failed apply must raise a toast");
    assert(
      lastToast!.title === "Apply failed",
      `failed-apply toast title must be "Apply failed" — got "${lastToast!.title}"`,
    );
    assert(
      lastToast!.variant === "destructive",
      `failed-apply toast must be the red "destructive" variant — got "${lastToast!.variant}"`,
    );
    assert(
      String(lastToast!.description ?? "").includes("Demand aggregation crashed"),
      `failed-apply toast description must surface the server error — got "${lastToast!.description}"`,
    );
    // It must NOT borrow the success-path headlines.
    assert(
      !String(lastToast!.title ?? "").startsWith("Applied"),
      `failed-apply toast must NOT use a success "Applied…" headline — got "${lastToast!.title}"`,
    );
    console.log('  ✓ "Apply failed" (destructive variant, server error in description)');
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  console.log("Prod-actions apply toast: whole-apply failure → 'Apply failed' (Task #2253)");

  await scenarioApplyRejects();

  console.log("\nprod-actions-apply-toast-failed: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
