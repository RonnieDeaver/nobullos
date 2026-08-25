/* test-registration
{
  "name": "Prod-actions apply toast \u2014 reconnect (default) vs error (destructive) (Task #2213)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
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
 * Task #2213 — Frontend regression test for the post-apply TOAST in the
 * CEO prod-actions / maintenance panel (`ProdActionsPanel`).
 *
 * Task #2176 locked the *visual* row treatment (amber "Needs reconnect"
 * vs red "Error"). This locks the sibling contract: the toast fired by
 * `applyMutation.onSuccess` after an "Apply all" run.
 *
 * The panel counts `outcome.state:"blocked"` (login-expired / reconnect-
 * needed) separately from `outcome.state:"error"`, and only fires the red
 * `destructive` toast for genuine errors:
 *
 *   - an apply whose results carry a `blocked` row NAMING an integration
 *     + an `applied` row (no `error`) → calm default toast titled
 *     "Applied — some integrations need reconnect" (variant "default",
 *     NOT "destructive"),
 *   - Task #4840: an apply whose results carry a `blocked` row WITHOUT an
 *     integration (a precondition wait-state, e.g. the Zoom retirement
 *     soak) → calm default toast titled "Applied — some actions are
 *     waiting on preconditions", tallied as "blocked/waiting", never
 *     "needs reconnect", and
 *   - an apply whose results carry an `error` + an `applied` row → the
 *     red "Applied with N error(s)" toast (variant "destructive"),
 *
 * so a future refactor can't re-fold `blocked` into the error count, fire
 * the scary destructive toast for a recoverable reconnect, or phrase a
 * healthy-integration wait-state as reconnect work.
 *
 * Mounts the real `ProdActionsPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. The
 * panel only fetches statuses once opened (clicks the header toggle), and
 * the apply confirm dialog is a Radix AlertDialog — shimmed to an inline
 * pass-through (see `tests/alert-dialog-shim.mjs`) so its confirm button
 * is reachable in the raw jsdom harness. Toast is inspected via a tiny
 * recorder component that subscribes through the real `useToast()` store.
 * Harness pattern: #2176 (styling test) + #2058 (toast recorder).
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
// apply RESULTS (what drives the toast) are independent of this list and
// come from the POST response configured per-scenario below.
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

// Configured per-scenario: the body returned by POST /apply.
let applyResults: any[] = [];

const fetchHandler = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      method: "POST",
      path: "/api/admin/prod-actions/apply",
      json: () => ({ results: applyResults }),
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

// The panel surfaces its post-apply result as a toast. The toast store is
// a module-level singleton (TOAST_LIMIT = 1); a tiny recorder that
// subscribes via useToast() lets us read the most-recent toast's
// title/variant without mounting the Radix <Toaster /> (which never
// portals in the raw jsdom harness).
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
// applyMutation.mutate()), and let the POST + onSuccess toast settle.
async function runApply(): Promise<void> {
  const applyBtn = $("button-prod-actions-apply") as HTMLButtonElement | null;
  assert(applyBtn !== null, "the 'Apply all' button must render");
  assert(!applyBtn!.disabled, "'Apply all' must be enabled when a pending action exists");
  await clickById("button-prod-actions-apply");
  await clickById("button-prod-actions-confirm");
}

async function scenarioBlockedNoError(): Promise<void> {
  console.log("\n— Apply result has blocked + applied (no error) → calm default reconnect toast —");
  applyResults = [
    {
      id: "rebuild_rollups",
      title: "Rebuild hourly rollups",
      description: "Recompute the external-call audit rollups.",
      change: "rebuild rollups",
      outcome: { state: "applied", detail: "Rebuilt 24 rollup rows.", rowsAffected: 24 },
      appliedAt: "2026-06-02T00:00:00.000Z",
    },
    {
      id: "semrush_demand_refresh",
      title: "SEMrush demand refresh",
      description: "Re-run the stale SEMrush demand sweep.",
      change: "refresh demand keywords",
      // Task #4840 — the reconnect headline requires the outcome to NAME
      // the integration (that is what makes it auth-dead, not waiting).
      outcome: {
        state: "blocked",
        detail: "SEMrush login expired before the sweep could run.",
        integration: "SEMrush",
      },
      appliedAt: "2026-06-02T00:00:00.000Z",
    },
  ];
  const root = await mountPanel();
  try {
    await runApply();

    assert(lastToast !== null, "an apply must raise a toast");
    assert(
      lastToast!.title === "Applied — some integrations need reconnect",
      `blocked-only apply toast title must be the reconnect headline — got "${lastToast!.title}"`,
    );
    assert(
      lastToast!.variant === "default",
      `blocked-only apply toast must be the calm "default" variant — got "${lastToast!.variant}"`,
    );
    assert(
      lastToast!.variant !== "destructive",
      "blocked-only apply toast must NOT be destructive (red)",
    );
    assert(
      String(lastToast!.description ?? "").includes("1 needs reconnect"),
      `toast description must tally the reconnect outcome — got "${lastToast!.description}"`,
    );
    assert(
      !String(lastToast!.description ?? "").includes("errored"),
      `toast description must NOT count blocked as an error — got "${lastToast!.description}"`,
    );
    console.log('  ✓ "Applied — some integrations need reconnect" (default variant, not destructive)');
  } finally {
    await unmount(root);
  }
}

// Task #4840 — blocked WITHOUT an integration is a precondition wait-state:
// the toast must phrase it as waiting, never as reconnect work.
async function scenarioWaitingNoError(): Promise<void> {
  console.log("\n— Apply result has waiting-blocked (no integration) + applied → calm waiting toast —");
  applyResults = [
    {
      id: "rebuild_rollups",
      title: "Rebuild hourly rollups",
      description: "Recompute the external-call audit rollups.",
      change: "rebuild rollups",
      outcome: { state: "applied", detail: "Rebuilt 24 rollup rows.", rowsAffected: 24 },
      appliedAt: "2026-06-02T00:00:00.000Z",
    },
    {
      id: "zoom_legacy_retirement",
      title: "Retire legacy Zoom OAuth token rows",
      description: "Delete the legacy Zoom OAuth rows once the S2S cutover has soaked.",
      change: "delete legacy zoom oauth token rows",
      // No `integration` — waiting on preconditions, NOT auth-dead.
      outcome: {
        state: "blocked",
        detail: "Waiting for live S2S webhook evidence; soak window not yet elapsed.",
      },
      appliedAt: "2026-06-02T00:00:00.000Z",
    },
  ];
  const root = await mountPanel();
  try {
    await runApply();

    assert(lastToast !== null, "an apply must raise a toast");
    assert(
      lastToast!.title === "Applied — some actions are waiting on preconditions",
      `waiting-blocked apply toast title must be the waiting headline — got "${lastToast!.title}"`,
    );
    assert(
      lastToast!.variant === "default",
      `waiting-blocked apply toast must be the calm "default" variant — got "${lastToast!.variant}"`,
    );
    const desc = String(lastToast!.description ?? "");
    assert(
      desc.includes("1 blocked/waiting"),
      `toast description must tally the waiting outcome as "blocked/waiting" — got "${desc}"`,
    );
    assert(
      !desc.includes("needs reconnect"),
      `toast description must NOT phrase a waiting block as reconnect work — got "${desc}"`,
    );
    assert(
      !desc.includes("errored"),
      `toast description must NOT count waiting-blocked as an error — got "${desc}"`,
    );
    console.log('  ✓ "Applied — some actions are waiting on preconditions" (default variant, honest tally)');
  } finally {
    await unmount(root);
  }
}

async function scenarioError(): Promise<void> {
  console.log("\n— Apply result has error + applied → destructive error toast —");
  applyResults = [
    {
      id: "rebuild_rollups",
      title: "Rebuild hourly rollups",
      description: "Recompute the external-call audit rollups.",
      change: "rebuild rollups",
      outcome: { state: "applied", detail: "Rebuilt 24 rollup rows.", rowsAffected: 24 },
      appliedAt: "2026-06-02T00:00:00.000Z",
    },
    {
      id: "semrush_demand_refresh",
      title: "SEMrush demand refresh",
      description: "Re-run the stale SEMrush demand sweep.",
      change: "refresh demand keywords",
      outcome: { state: "error", detail: "Unexpected null in demand aggregation." },
      appliedAt: "2026-06-02T00:00:00.000Z",
    },
  ];
  const root = await mountPanel();
  try {
    await runApply();

    assert(lastToast !== null, "an apply must raise a toast");
    assert(
      lastToast!.title === "Applied with 1 error(s)",
      `error apply toast title must be the error headline — got "${lastToast!.title}"`,
    );
    assert(
      lastToast!.variant === "destructive",
      `error apply toast must be the red "destructive" variant — got "${lastToast!.variant}"`,
    );
    assert(
      String(lastToast!.description ?? "").includes("1 errored"),
      `toast description must tally the error outcome — got "${lastToast!.description}"`,
    );
    console.log('  ✓ "Applied with 1 error(s)" (destructive variant)');
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  console.log("Prod-actions apply toast: reconnect (default) vs error (destructive) (Task #2213)");

  await scenarioBlockedNoError();
  await scenarioWaitingNoError();
  await scenarioError();

  console.log("\nprod-actions-apply-toast-reconnect-vs-error: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
