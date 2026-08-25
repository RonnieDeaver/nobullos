/* test-registration
{
  "name": "Deals board keyboard move — KeyboardSensor lift + menu-based stage move (Task #4663)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4663 (impeccable pass 2) a11y contract: a keyboard-only user must be able to move a deal between pipeline stages. Mounts the REAL DealsBoard in jsdom with stubbed fetch/Clerk and proves (1) dnd-kit KeyboardSensor is wired — Enter on the focusable grip handle lifts the card into the DragOverlay, Escape cancels; (2) the pointer-free per-card 'Move to stage' menu drives the same POST /api/deals/:id/move path as drag-end and the card lands in the target column after refetch; (3) the phone layout is stacked single-column (flex-col + lg:flex-row, contained h-scroll only at lg+). Fast, DB-free, network-stubbed jsdom render test.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/deals-board-keyboard-move-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4663 — keyboard equivalents for the deals-board drag interaction.
 *
 * The board's only stage writer is POST /api/deals/:id/move (drag-end calls
 * it via attemptMove). This suite pins the two keyboard paths onto that same
 * contract:
 *
 *   1. KeyboardSensor lift: the grip handle is a real focusable button with
 *      dnd-kit's draggable attributes; keydown Enter lifts the card (the
 *      DragOverlay clone appears), keydown Escape cancels (clone gone).
 *      Arrow-key column jumps are rect-driven and cannot be simulated in
 *      jsdom (all rects are zero), so the drop itself is covered by the
 *      menu path below, which exercises the identical attemptMove call.
 *   2. Menu move: every card has a labeled "Move to <deal> to another stage"
 *      trigger whose items (other stages only) POST the move and re-render
 *      the card in the target column.
 *   3. Layout: the stage row is stacked single-column below lg
 *      (flex-col + lg:flex-row) and the h-scroll container only exists at
 *      lg+ (lg:overflow-x-auto) — the phone pattern the plan promised.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/deals" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// dnd-kit measures/auto-scrolls; give jsdom the inert stubs it lacks.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;
(dom.window as any).ResizeObserver = ResizeObserverStub;
(dom.window.Element.prototype as any).scrollIntoView = () => {};
(dom.window.Element.prototype as any).scrollTo = () => {};
(dom.window.Element.prototype as any).scrollBy = () => {};
(dom.window as any).scrollTo = () => {};
(dom.window as any).scrollBy = () => {};
const matchMediaStub = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
});
(dom.window as any).matchMedia = matchMediaStub;
(globalThis as any).matchMedia = matchMediaStub;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Fetch stub: pipeline with three stages, one deal, mutable stage on move.
// ---------------------------------------------------------------------------

const STAGES = [
  { id: "s1", pipelineId: "p1", name: "Qualified", slug: "qualified", stageType: "open", winProbability: 20, position: 0 },
  { id: "s2", pipelineId: "p1", name: "Proposal", slug: "proposal", stageType: "open", winProbability: 50, position: 1 },
  { id: "s3", pipelineId: "p1", name: "Won", slug: "won", stageType: "won", winProbability: 100, position: 2 },
];
let dealStageId = "s1";
const moveCalls: { url: string; body: any }[] = [];
const NOW_ISO = new Date().toISOString();
const dealRow = () => ({
  id: "d1",
  name: "Acme SEO retainer",
  pipelineId: "p1",
  stageId: dealStageId,
  stageName: STAGES.find((s) => s.id === dealStageId)?.name ?? null,
  clientId: null,
  clientFirmName: "Acme Co",
  ownerId: "u1",
  ownerName: "Alex Doe",
  amount: 5000,
  expectedCloseDate: null,
  notes: null,
  status: "open",
  stageEnteredAt: NOW_ISO,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
  contactIds: [],
  score: null,
  fitScore: null,
  engagementScore: null,
  scoreComputedAt: null,
});

const fetchStub = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      path: "/api/auth/user",
      json: { id: "u1", email: "ceo@nobull.test", firstName: "Alex", lastName: "Doe", role: "ceo", permissions: [] },
    },
    { path: "/api/deals/pipelines", json: () => [{ id: "p1", name: "Sales", isDefault: true, stages: STAGES }] },
    {
      method: "POST",
      path: /\/api\/deals\/d1\/move$/,
      respond: ({ url, init }: { url: string; init: any }) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        moveCalls.push({ url, body });
        dealStageId = body.toStageId;
        return { status: 200, json: { ok: true, deal: dealRow() } };
      },
    },
    { path: "/api/tags", json: { tags: [], assignments: [] } },
    // Prefix route — keep LAST so it doesn't shadow pipelines/move/tags.
    { path: "/api/deals", json: () => [dealRow()] },
  ],
  defaultJson: {},
}) as any;
(globalThis as any).fetch = fetchStub;
(dom.window as any).fetch = fetchStub;

// ---------------------------------------------------------------------------
// Imports — AFTER jsdom globals + fetch shim.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
(globalThis as any).React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { getQueryFn } = await import("../../client/src/lib/queryClient");
const DealsBoard = (await import("../../client/src/pages/DealsBoard")).default;

const queryClient = new QueryClient({
  defaultOptions: {
    // The page's useQuery calls rely on the app default key-derived fetcher.
    queries: { queryFn: getQueryFn({ on401: "throw" }) as any, retry: false },
    mutations: { retry: false },
  },
});

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const qs = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const qsa = (sel: string) => document.querySelectorAll(sel);

async function main(): Promise<void> {
  console.log("Deals board keyboard move (Task #4663)");
  const container = document.getElementById("root")!;
  let root: Root = null as any;

  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(DealsBoard),
      ),
    );
  });
  await flush();

  // ── Board mounted with all three stage columns ───────────────────────────
  assert(qsa('[data-testid^="column-stage-"]').length === 3, "three stage columns render");
  assert(qs('[data-testid="card-deal-d1"]'), "deal card renders");

  // ── 3: stacked single-column phone layout classes ────────────────────────
  const row = qs('[data-testid="row-stage-columns"]')!;
  const rowCls = row.className;
  assert(rowCls.includes("flex-col"), `stage row stacks by default (flex-col) — got "${rowCls}"`);
  assert(rowCls.includes("lg:flex-row"), `stage row becomes a kanban row only at lg+ — got "${rowCls}"`);
  assert(!rowCls.split(/\s+/).includes("min-w-max"), "no unconditional min-w-max on the stage row");
  const wrapperCls = row.parentElement!.className;
  assert(wrapperCls.includes("lg:overflow-x-auto"), `contained h-scroll exists at lg+ — got "${wrapperCls}"`);
  assert(!wrapperCls.split(/\s+/).includes("overflow-x-auto"), "no h-scroll container below lg (phones stack instead)");
  const colCls = qs('[data-testid="column-stage-qualified"]')!.className;
  assert(colCls.includes("w-full") && colCls.includes("lg:w-64"), `columns are full-width below lg — got "${colCls}"`);

  // ── 1: KeyboardSensor — Enter lifts, Escape cancels ──────────────────────
  const handle = qs('[data-testid="handle-drag-deal-d1"]')!;
  assert(handle.tagName === "BUTTON", "grip handle is a real button (focusable)");
  assert(handle.getAttribute("aria-label") === "Drag to move", "grip handle is labeled");
  assert(
    handle.getAttribute("aria-roledescription") === "draggable",
    "grip handle carries dnd-kit draggable attributes",
  );
  await act(async () => {
    handle.focus();
    handle.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { code: "Enter", key: "Enter", bubbles: true, cancelable: true }),
    );
  });
  await flush();
  assert(
    qsa('[data-testid="card-deal-d1"]').length === 2,
    "Enter on the grip handle lifts the card into the DragOverlay (KeyboardSensor wired)",
  );
  await act(async () => {
    handle.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { code: "Escape", key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  await flush();
  assert(qsa('[data-testid="card-deal-d1"]').length === 1, "Escape cancels the keyboard drag (overlay clone removed)");
  assert(moveCalls.length === 0, "cancelled keyboard drag issues no move request");

  // ── 2: menu-based move lands the card in the target column ───────────────
  const trigger = qs('[data-testid="button-move-deal-d1"]')!;
  assert(
    trigger.getAttribute("aria-label") === "Move Acme SEO retainer to another stage",
    `move trigger is labeled per deal — got "${trigger.getAttribute("aria-label")}"`,
  );
  assert(!qs('[data-testid="menuitem-move-d1-qualified"]'), "current stage excluded from the move menu");
  assert(qs('[data-testid="menuitem-move-d1-won"]'), "other stages listed in the move menu");
  const item = qs('[data-testid="menuitem-move-d1-proposal"]')!;
  await act(async () => {
    item.click();
  });
  await flush();
  assert(moveCalls.length === 1, `menu move POSTs exactly once (got ${moveCalls.length})`);
  assert(
    moveCalls[0].url.endsWith("/api/deals/d1/move") && moveCalls[0].body.toStageId === "s2",
    `menu move drives the real move endpoint with the target stage (got ${moveCalls[0]?.url} ${JSON.stringify(moveCalls[0]?.body)})`,
  );
  assert(
    qs('[data-testid="column-stage-proposal"]')!.querySelector('[data-testid="card-deal-d1"]'),
    "card renders in the Proposal column after the menu move",
  );

  await act(async () => {
    root.unmount();
  });
  queryClient.clear();
  console.log("PASS deals-board-keyboard-move");
  process.exit(0);
}

main().catch((err) => {
  console.error("deals-board-keyboard-move: fatal error", err);
  process.exit(1);
});
