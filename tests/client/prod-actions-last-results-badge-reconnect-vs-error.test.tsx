/* test-registration
{
  "name": "Prod-actions last-results badge \u2014 reconnect (amber) vs error (red) (Task #2252)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
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
 * Task #2252 — Frontend regression test for the persistent "Last apply
 * results" panel (`panel-prod-actions-last-results`) in the CEO
 * prod-actions / maintenance panel (`ProdActionsPanel`).
 *
 * Task #2213 locked the post-apply *toast* (default vs destructive) for
 * `blocked` (login-expired / reconnect-needed) vs `error` outcomes. This
 * locks the sibling contract: the per-row `StateBadge` rendered inside the
 * persistent results panel after an apply.
 *
 * Each result row derives its badge from `outcome.state` (and, for
 * `blocked`, the Task #4840 flavor discriminator `outcome.integration`):
 *
 *   - a `{ outcome.state: "blocked", integration: "…" }` row (auth-dead)
 *     → the amber/orange "Needs reconnect" badge
 *     (`badge-prod-action-state-blocked`, `bg-orange-*` / `text-orange-*`,
 *     NOT red),
 *   - Task #4840: a `{ outcome.state: "blocked" }` row WITHOUT an
 *     integration (precondition wait-state) → the calm amber
 *     "Blocked — waiting" badge (same testid, `bg-amber-*`, never the
 *     word "reconnect"), and
 *   - an `{ outcome.state: "error" }` row → the red "Error" badge
 *     (`badge-prod-action-state-error`, `bg-red-*` / `text-red-*`, NOT
 *     orange),
 *
 * so a future refactor of the results-panel badge mapping can't re-fold
 * `blocked` into the red error treatment (or vice-versa), nor blur the
 * reconnect vs waiting flavors back together, without this test catching
 * it.
 *
 * Task #4842 additions — the results panel is now PARTITIONED: rows that
 * did work (applied → errored → needs-reconnect → waiting) render first,
 * each group sorted by title, with a summary line that reuses the toast's
 * count phrasing; the "not needed" tail collapses behind a count toggle.
 * The Apply-all scope explainer (footer + confirm dialog) must state that
 * Apply all runs every registered action with the live registry count
 * (`actions.length` from the statuses payload).
 *
 * Mounts the real `ProdActionsPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. The
 * panel only fetches statuses once opened (clicks the header toggle), and
 * the apply confirm dialog is a Radix AlertDialog — shimmed to an inline
 * pass-through (see `tests/alert-dialog-shim.mjs`) so its confirm button
 * is reachable in the raw jsdom harness. Harness pattern: #2176 (styling
 * test) + #2213 (apply-driven badge/toast harness).
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
// apply RESULTS (what drive the per-row badges) are independent of this
// list and come from the POST response configured below.
// Task #4842 — `actions` is the FULL registry slice; its length (3) drives
// the "Apply all runs every registered action (N)" scope explainer.
const STATUSES = {
  actions: [
    {
      id: "semrush_demand_refresh",
      title: "SEMrush demand refresh",
      description: "Re-run the stale SEMrush demand sweep.",
      change: "refresh demand keywords",
      status: { state: "pending", detail: "Stale demand keywords detected." },
    },
    {
      id: "rebuild_rollups",
      title: "Rebuild hourly rollups",
      description: "Recompute the external-call audit rollups.",
      change: "rebuild rollups",
      status: { state: "applied", detail: "Up to date." },
    },
    {
      id: "front_backlog_drain",
      title: "Front backlog drain",
      description: "Drain the stuck Front discovered apply tail.",
      change: "drain apply tail",
      status: { state: "applied", detail: "Nothing stuck." },
    },
    {
      id: "lever_alpha",
      title: "Lever Alpha",
      description: "First independent manual lever.",
      change: "run alpha",
      manualLever: true,
      status: { state: "not-needed", detail: "Ready." },
    },
    {
      id: "lever_beta",
      title: "Lever Beta",
      description: "Second independent manual lever.",
      change: "run beta",
      manualLever: true,
      status: { state: "not-needed", detail: "Ready." },
    },
  ],
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

const leverCalls = new Map<string, number>();
const leverResolvers = new Map<string, (value: any) => void>();

// The body returned by POST /apply — one applied, one blocked
// (reconnect-needed) and one error row so the persistent results panel
// renders all three StateBadge treatments at once.
const applyResults = [
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
    // Task #4840 — the "Needs reconnect" badge requires the outcome to
    // NAME the integration (that is what makes it auth-dead).
    outcome: {
      state: "blocked",
      detail: "SEMrush login expired before the sweep could run.",
      integration: "SEMrush",
    },
    appliedAt: "2026-06-02T00:00:00.000Z",
  },
  // Task #4840 — blocked WITHOUT an integration: precondition wait-state
  // (e.g. the Zoom retirement soak) → neutral "Blocked — waiting" badge.
  {
    id: "zoom_legacy_retirement",
    title: "Retire legacy Zoom OAuth token rows",
    description: "Delete the legacy Zoom OAuth rows once the S2S cutover has soaked.",
    change: "delete legacy zoom oauth token rows",
    outcome: {
      state: "blocked",
      detail: "Waiting for live S2S webhook evidence; soak window not yet elapsed.",
    },
    appliedAt: "2026-06-02T00:00:00.000Z",
  },
  {
    id: "front_backlog_drain",
    title: "Front backlog drain",
    description: "Drain the stuck Front discovered apply tail.",
    change: "drain apply tail",
    outcome: { state: "error", detail: "Unexpected null in apply-tail reconciliation." },
    appliedAt: "2026-06-02T00:00:00.000Z",
  },
  // Task #4842 — two settled rows: the "not needed" tail must collapse
  // behind a count instead of drowning the rows that did work. Titles
  // chosen so the expanded tail proves by-title sorting (AA before ZZ).
  {
    id: "zz_rollup_prune",
    title: "ZZ prune rollup orphans",
    description: "Remove orphaned rollup rows.",
    change: "prune rollup orphans",
    outcome: { state: "not-needed", detail: "No orphaned rollup rows." },
    appliedAt: "2026-06-02T00:00:00.000Z",
  },
  {
    id: "aa_noop_reconcile",
    title: "AA reconcile noop ledger",
    description: "Reconcile the noop ledger.",
    change: "reconcile noop ledger",
    outcome: { state: "not-needed", detail: "Ledger already reconciled." },
    appliedAt: "2026-06-02T00:00:00.000Z",
  },
];

const fetchHandler = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      method: "POST",
      path: "/api/admin/prod-actions/apply",
      json: { results: applyResults },
    },
    {
      method: "POST",
      path: /\/api\/admin\/prod-actions\/lever_(alpha|beta)\/apply$/,
      respond: ({ url }: any) =>
        new Promise((resolve) => {
          const id = url.includes("lever_alpha") ? "lever_alpha" : "lever_beta";
          leverCalls.set(id, (leverCalls.get(id) ?? 0) + 1);
          leverResolvers.set(id, resolve);
        }),
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
}

// Drive a full apply: open the confirm dialog, click confirm (which fires
// applyMutation.mutate()), and let the POST + onSuccess settle.
async function runApply(): Promise<void> {
  const applyBtn = $("button-prod-actions-apply") as HTMLButtonElement | null;
  assert(applyBtn !== null, "the 'Apply all' button must render");
  assert(!applyBtn!.disabled, "'Apply all' must be enabled when a pending action exists");
  await clickById("button-prod-actions-apply");
  await clickById("button-prod-actions-confirm");
}

async function startLever(actionId: string): Promise<void> {
  await clickById(`button-prod-action-lever-${actionId}`);
  await clickById("button-prod-action-lever-confirm");
}

async function settleLever(actionId: string): Promise<void> {
  const resolve = leverResolvers.get(actionId);
  assert(resolve, `${actionId} request must be waiting`);
  await act(async () => {
    resolve!({
      status: 200,
      json: {
        result: {
          id: actionId,
          title: actionId === "lever_alpha" ? "Lever Alpha" : "Lever Beta",
          description: "fixture",
          change: "fixture",
          outcome: { state: "applied", detail: `${actionId} settled` },
          appliedAt: "2026-08-27T00:00:00.000Z",
        },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush();
}

// Returns the StateBadge element rendered inside the given result row of
// the persistent results panel, asserting both panel and row exist.
function badgeInResultRow(rowId: string): HTMLElement {
  const panel = $("panel-prod-actions-last-results");
  assert(panel !== null, "the persistent 'Last apply results' panel must render after an apply");
  const row = $(`row-prod-action-result-${rowId}`);
  assert(row !== null, `the results panel must render a row for "${rowId}"`);
  const badge = row!.querySelector('[data-testid^="badge-prod-action-state-"]') as HTMLElement | null;
  assert(badge !== null, `the "${rowId}" result row must render a StateBadge`);
  return badge!;
}

function hasClass(el: HTMLElement, substr: string): boolean {
  return (el.getAttribute("class") || "").split(/\s+/).some((c) => c.includes(substr));
}

async function main(): Promise<void> {
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  console.log(
    "Prod-actions last-results badge: reconnect (amber) vs error (red) (Task #2252)",
  );

  const root = await mountPanel();
  try {
    await runApply();

    // --- blocked row → amber/orange "Needs reconnect" badge ---
    console.log("\n— blocked result row → amber 'Needs reconnect' badge —");
    const blockedBadge = badgeInResultRow("semrush_demand_refresh");
    assert(
      blockedBadge.getAttribute("data-testid") === "badge-prod-action-state-blocked",
      `blocked row badge must be the blocked StateBadge — got "${blockedBadge.getAttribute("data-testid")}"`,
    );
    assert(
      (blockedBadge.textContent || "").trim() === "Needs reconnect",
      `blocked row badge must read "Needs reconnect" — got "${(blockedBadge.textContent || "").trim()}"`,
    );
    assert(
      hasClass(blockedBadge, "bg-orange-") && hasClass(blockedBadge, "text-orange-"),
      `blocked row badge must carry the amber/orange treatment — got class="${blockedBadge.getAttribute("class")}"`,
    );
    assert(
      !hasClass(blockedBadge, "bg-red-") && !hasClass(blockedBadge, "text-red-"),
      `blocked row badge must NOT use the red error treatment — got class="${blockedBadge.getAttribute("class")}"`,
    );
    console.log('  ✓ amber "Needs reconnect" badge (no red treatment)');

    // --- waiting-blocked row (no integration) → "Blocked — waiting" badge ---
    console.log("\n— waiting-blocked result row → calm 'Blocked — waiting' badge (Task #4840) —");
    const waitingBadge = badgeInResultRow("zoom_legacy_retirement");
    assert(
      waitingBadge.getAttribute("data-testid") === "badge-prod-action-state-blocked",
      `waiting row badge must still be the blocked StateBadge — got "${waitingBadge.getAttribute("data-testid")}"`,
    );
    assert(
      (waitingBadge.textContent || "").trim() === "Blocked — waiting",
      `waiting row badge must read "Blocked — waiting" — got "${(waitingBadge.textContent || "").trim()}"`,
    );
    assert(
      !(waitingBadge.textContent || "").toLowerCase().includes("reconnect"),
      `waiting row badge must NOT mention reconnect — got "${waitingBadge.textContent}"`,
    );
    assert(
      hasClass(waitingBadge, "bg-amber-") && !hasClass(waitingBadge, "bg-red-"),
      `waiting row badge must carry the calm amber (not red) treatment — got class="${waitingBadge.getAttribute("class")}"`,
    );
    console.log('  ✓ calm "Blocked — waiting" badge (no reconnect claim)');

    // --- error row → red "Error" badge ---
    console.log("\n— error result row → red 'Error' badge —");
    const errorBadge = badgeInResultRow("front_backlog_drain");
    assert(
      errorBadge.getAttribute("data-testid") === "badge-prod-action-state-error",
      `error row badge must be the error StateBadge — got "${errorBadge.getAttribute("data-testid")}"`,
    );
    assert(
      (errorBadge.textContent || "").trim() === "Error",
      `error row badge must read "Error" — got "${(errorBadge.textContent || "").trim()}"`,
    );
    assert(
      hasClass(errorBadge, "bg-red-") && hasClass(errorBadge, "text-red-"),
      `error row badge must carry the red treatment — got class="${errorBadge.getAttribute("class")}"`,
    );
    assert(
      !hasClass(errorBadge, "bg-orange-") && !hasClass(errorBadge, "text-orange-"),
      `error row badge must NOT use the amber reconnect treatment — got class="${errorBadge.getAttribute("class")}"`,
    );
    console.log('  ✓ red "Error" badge (no amber treatment)');

    // --- the two treatments must be distinct ---
    assert(
      blockedBadge.getAttribute("class") !== errorBadge.getAttribute("class"),
      "the blocked (reconnect) and error badges must use distinct class treatments",
    );

    // --- Task #4842: partition — work rows first, tail collapsed ---
    console.log(
      "\n— Task #4842: partitioned results (applied → errored → blocked), collapsed not-needed tail —",
    );
    const summary = $("text-prod-actions-results-summary");
    assert(summary !== null, "the results summary line must render");
    assert(
      (summary!.textContent || "").trim() ===
        "1 applied, 2 not needed, 1 needs reconnect, 1 blocked/waiting, 1 errored.",
      `summary line must carry the partition counts in the toast's phrasing — got "${(summary!.textContent || "").trim()}"`,
    );
    const FOLLOWING = dom.window.Node.DOCUMENT_POSITION_FOLLOWING;
    const rowOrder = [
      "rebuild_rollups", // applied
      "front_backlog_drain", // errored
      "semrush_demand_refresh", // blocked — needs reconnect
      "zoom_legacy_retirement", // blocked — waiting
    ];
    for (let i = 0; i + 1 < rowOrder.length; i++) {
      const a = $(`row-prod-action-result-${rowOrder[i]}`);
      const b = $(`row-prod-action-result-${rowOrder[i + 1]}`);
      assert(a !== null && b !== null, `partitioned rows "${rowOrder[i]}"/"${rowOrder[i + 1]}" must render`);
      assert(
        (a!.compareDocumentPosition(b!) & FOLLOWING) !== 0,
        `"${rowOrder[i]}" must render before "${rowOrder[i + 1]}" (group order applied → errored → reconnect → waiting)`,
      );
    }
    console.log("  ✓ work rows render first, in group order");

    assert(
      $("row-prod-action-result-aa_noop_reconcile") === null &&
        $("row-prod-action-result-zz_rollup_prune") === null,
      "not-needed rows must start collapsed (hidden behind the count toggle)",
    );
    const toggle = $("button-prod-actions-results-not-needed-toggle");
    assert(toggle !== null, "the not-needed collapse toggle must render");
    assert(
      (toggle!.textContent || "").includes("2 not needed"),
      `the toggle must carry the tail count — got "${toggle!.textContent}"`,
    );
    await clickById("button-prod-actions-results-not-needed-toggle");
    const aaRow = $("row-prod-action-result-aa_noop_reconcile");
    const zzRow = $("row-prod-action-result-zz_rollup_prune");
    assert(aaRow !== null && zzRow !== null, "expanding the tail must render the not-needed rows");
    assert(
      (aaRow!.compareDocumentPosition(zzRow!) & FOLLOWING) !== 0,
      "the expanded tail must be sorted by title (AA before ZZ)",
    );
    assert(
      aaRow!.querySelector('[data-testid="badge-prod-action-state-not-needed"]') !== null,
      "expanded not-needed rows must carry the muted 'Not needed' badge",
    );
    await clickById("button-prod-actions-results-not-needed-toggle");
    assert(
      $("row-prod-action-result-aa_noop_reconcile") === null,
      "collapsing the toggle must hide the tail again",
    );
    console.log('  ✓ "not needed" tail collapses behind its count and expands sorted');

    // --- Task #4842: Apply-all scope explainer with the live count ---
    const scope = $("text-prod-actions-apply-scope");
    assert(scope !== null, "the Apply-all scope explainer must render next to the control");
    assert(
      (scope!.textContent || "").includes("every registered action (5)"),
      `the scope explainer must state the live registered count — got "${scope!.textContent}"`,
    );
    const dialogScope = $("text-prod-actions-confirm-scope");
    assert(dialogScope !== null, "the confirm-dialog scope line must render");
    assert(
      (dialogScope!.textContent || "").includes("every registered action (5)"),
      `the confirm dialog must state the full-registry scope with the live count — got "${dialogScope!.textContent}"`,
    );
    assert(
      (dialogScope!.textContent || "").includes("Manual levers are excluded"),
      "the confirm dialog must keep the manual-lever exclusion statement",
    );
    console.log("  ✓ scope explainer states the full-registry run with live count (footer + dialog)");

    // Per-action manual-lever concurrency: Alpha stays disabled/busy while
    // Beta can open and submit. Re-clicking Alpha cannot duplicate its POST.
    await startLever("lever_alpha");
    const alphaButton = $("button-prod-action-lever-lever_alpha") as HTMLButtonElement;
    const betaButton = $("button-prod-action-lever-lever_beta") as HTMLButtonElement;
    assert(alphaButton.disabled, "active Alpha lever must be disabled");
    assert((alphaButton.textContent || "").includes("Firing"), "active Alpha shows firing feedback");
    assert(!betaButton.disabled, "unrelated Beta lever remains enabled");
    await clickById("button-prod-action-lever-lever_alpha");
    assert(leverCalls.get("lever_alpha") === 1, "same active lever cannot submit twice");

    await startLever("lever_beta");
    assert(leverCalls.get("lever_alpha") === 1, "Alpha has one in-flight request");
    assert(leverCalls.get("lever_beta") === 1, "Beta can submit while Alpha is in flight");
    assert(alphaButton.disabled && betaButton.disabled, "each active lever disables only itself");

    await settleLever("lever_beta");
    assert(alphaButton.disabled, "Alpha remains busy until its own request settles");
    assert(!betaButton.disabled, "Beta re-enables after its request settles");
    await settleLever("lever_alpha");
    assert(!alphaButton.disabled, "Alpha re-enables after its request settles");
    console.log("  ✓ manual levers track busy state per action and prevent same-action duplicates");
  } finally {
    await unmount(root);
  }

  console.log("\nprod-actions-last-results-badge-reconnect-vs-error: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
