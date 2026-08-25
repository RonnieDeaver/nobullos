/* test-registration
{
  "name": "NoBull Sheets — library page: list, create button, search, workbook navigation (Task #2931)",
  "regression": true,
  "sweepOnlyReason": "Task #2931 — pure client-side jsdom render (no DB/network); SheetsLibrary library page: list, create button, search, navigation; no @univerjs so no resolve-hook needed, not a smoke-gate candidate.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/sheets-library-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * SheetsLibrary — rendered smoke test (Task #2931).
 *
 * Covers:
 *   A. Loading state — spinner renders while the folder/workbook fetches are
 *      in flight.
 *   B. Loaded state — workbook names AND owner labels appear; create buttons
 *      are present; the single OsTable presentation (Task #4371) shows the
 *      folder name in the Folder column for workbooks assigned to folders.
 *   C. Navigation — clicking a workbook row navigates to /sheets/:id.
 *   D. Search — typing in the search box filters the workbook list by name.
 *   E. Empty state — when there are no workbooks at all, the empty state
 *      prompt is shown instead of the workbook table.
 *   F. Create workbook — submitting the "New Workbook" dialog fires a POST to
 *      /api/sheets/workbooks and then redirects to /sheets/:id.
 *
 * Radix Dialog renders into document.body via a portal in jsdom — query from
 * there, not from the route container.
 *
 * Registered in tests/run-all.ts.
 */

import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { createFetchStub } from "./helpers/createFetchStub.mjs";

// ── jsdom environment ─────────────────────────────────────────────────────────

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/sheets" },
);

(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).sessionStorage = dom.window.sessionStorage;
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).SVGElement = (dom.window as any).SVGElement ?? dom.window.Element;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).PointerEvent =
  (dom.window as any).PointerEvent ?? (dom.window as any).MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

(dom.window.HTMLElement.prototype as any).scrollIntoView ??= function () {};
(dom.window.HTMLElement.prototype as any).hasPointerCapture ??= () => false;
(dom.window.HTMLElement.prototype as any).releasePointerCapture ??= function () {};
(dom.window.HTMLElement.prototype as any).setPointerCapture ??= function () {};

(dom.window as any).matchMedia ??= (q: string) => ({
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
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;
(dom.window as any).ResizeObserver = ResizeObserverStub;

class MutationObserverStub {
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
}
(globalThis as any).MutationObserver =
  (dom.window as any).MutationObserver ?? MutationObserverStub;
(dom.window as any).MutationObserver ??= MutationObserverStub;

// Radix FocusScope tries to call getComputedStyle on dialog content elements.
// No-op scrollIntoView is also needed for focus management.
(globalThis as any).IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(dom.window as any).IntersectionObserver ??= (globalThis as any).IntersectionObserver;

// ── helpers ───────────────────────────────────────────────────────────────────

function byTestId(root: Element | Document, id: string): Element | null {
  return root.querySelector(`[data-testid="${id}"]`) as Element | null;
}

function hasTestId(root: Element | Document, id: string): boolean {
  return byTestId(root, id) !== null;
}

/** Query from the whole document body (for Radix portal-mounted dialogs). */
function bodyTestId(id: string): Element | null {
  return dom.window.document.body.querySelector(`[data-testid="${id}"]`) as Element | null;
}

async function flush(times = 8): Promise<void> {
  const { act } = await import("react");
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

/** Reset the jsdom location to /sheets so each scenario starts fresh. */
function resetLocation(): void {
  dom.window.history.pushState({}, "", "/sheets");
}

/** Trigger a React controlled input change. */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

// ── fixtures ──────────────────────────────────────────────────────────────────

const USER = {
  id: "user-1",
  email: "editor@example.com",
  firstName: "Ed",
  lastName: "Itor",
  role: "account_manager",
  authorityLevel: "standard",
  functions: [],
};

const FOLDER_A = {
  id: "folder-a",
  name: "Q3 Campaigns",
  ownerId: "user-1",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const WB_1 = {
  id: "wb-001",
  name: "Q3 Budget",
  ownerId: "user-1",
  folderId: null,
  updatedAt: "2026-07-10T00:00:00.000Z",
};

const WB_2 = {
  id: "wb-002",
  name: "Campaign Tracker",
  ownerId: "user-1",
  folderId: "folder-a",
  updatedAt: "2026-07-12T00:00:00.000Z",
};

const WB_SHARED = {
  id: "wb-003",
  name: "Shared Doc",
  ownerId: "user-other",
  folderId: null,
  updatedAt: "2026-07-08T00:00:00.000Z",
};

// ── module-level root — created once, reused, unmounted between scenarios ─────

let _root: any = null;
let _queryClient: any = null;
const container = dom.window.document.getElementById("root")!;

async function mountLibrary(
  fetchHandler: (url: string, init?: any) => Promise<any>,
): Promise<{ root: HTMLElement; queryClient: any }> {
  resetLocation();

  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { Router, Route } = await import("wouter");
  const { act } = await import("react");
  const { default: SheetsLibrary } = await import(
    "../client/src/pages/SheetsLibrary"
  );
  const { TooltipProvider } = await import(
    "../client/src/components/ui/tooltip"
  );

  (globalThis as any).fetch = fetchHandler;

  _queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  await act(async () => {
    if (!_root) {
      _root = createRoot(container);
    }
    _root.render(
      React.createElement(
        QueryClientProvider,
        { client: _queryClient },
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(
            Router,
            { base: "" },
            React.createElement(Route, {
              path: "/sheets",
              component: SheetsLibrary as any,
            }),
          ),
        ),
      ),
    );
  });

  return { root: container as HTMLElement, queryClient: _queryClient };
}

async function unmount(): Promise<void> {
  const { act } = await import("react");
  const React = await import("react");
  if (_root) {
    await act(async () => {
      _root.render(React.createElement("div"));
    });
  }
  _queryClient?.clear();
  _queryClient = null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  Main test runner
// ══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  // ── A — Loading state ──────────────────────────────────────────────────────
  {
    console.log("\n— A: loading spinner shows while fetches are in flight —");

    let resolveWorkbooks!: (v: any) => void;
    const deferredWorkbooks = new Promise<any>((resolve) => {
      resolveWorkbooks = resolve;
    });

    const handler = createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        { path: "/api/auth/user", json: USER },
        { path: "/api/sheets/folders", json: { folders: [] } },
        {
          path: "/api/sheets/workbooks",
          method: "GET",
          respond: async () => deferredWorkbooks,
        },
      ],
      defaultJson: {},
    });

    const { root } = await mountLibrary(handler);
    await flush(2);

    assert.ok(
      hasTestId(root, "sheets-loading"),
      "A: loading spinner must be visible while fetch is in flight",
    );
    assert.ok(
      !hasTestId(root, "sheets-empty-state"),
      "A: empty state must not appear during loading",
    );

    console.log("  ✓ A: loading spinner shows");

    resolveWorkbooks({
      ok: true,
      status: 200,
      headers: new dom.window.Headers({ "Content-Type": "application/json" }),
      json: async () => ({ workbooks: [] }),
      text: async () => JSON.stringify({ workbooks: [] }),
    });
    await unmount();
  }

  // ── B — Loaded state: workbook names, owner labels, folders, create buttons ─
  {
    console.log(
      "\n— B: loaded state renders workbooks, owner labels, folders, and create buttons —",
    );

    const handler = createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        { path: "/api/auth/user", json: USER },
        { path: "/api/sheets/folders", json: { folders: [FOLDER_A] } },
        {
          path: "/api/sheets/workbooks",
          json: { workbooks: [WB_1, WB_2, WB_SHARED] },
        },
      ],
      defaultJson: {},
    });

    const { root } = await mountLibrary(handler);
    await flush(8);

    assert.ok(
      hasTestId(root, "sheets-library-root"),
      "B: library root must be present after load",
    );
    assert.ok(
      !hasTestId(root, "sheets-loading"),
      "B: loading spinner must be gone after load",
    );

    // Workbook names
    assert.ok(
      hasTestId(root, `text-workbook-name-${WB_1.id}`),
      "B: unfiled workbook name must appear",
    );
    assert.ok(
      hasTestId(root, `text-workbook-name-${WB_2.id}`),
      "B: folder workbook name must appear",
    );
    assert.strictEqual(
      byTestId(root, `text-workbook-name-${WB_1.id}`)?.textContent,
      WB_1.name,
      "B: unfiled workbook name text matches",
    );

    // Owner labels
    assert.strictEqual(
      byTestId(root, `text-workbook-owner-${WB_1.id}`)?.textContent,
      "You",
      "B: own workbook must show 'You' as owner",
    );
    assert.strictEqual(
      byTestId(root, `text-workbook-owner-${WB_SHARED.id}`)?.textContent,
      "Shared",
      "B: shared workbook must show 'Shared' as owner",
    );

    // Single-table presentation (Task #4371): one OsTable, folder shown as a
    // column value on the row instead of per-folder card sections.
    assert.ok(
      hasTestId(root, "sheets-workbooks-table"),
      "B: the workbook OsTable must render",
    );
    const wb2Row = byTestId(root, `os-table-row-${WB_2.id}`);
    assert.ok(wb2Row, "B: WB_2 must render as a table row");
    assert.ok(
      wb2Row!.textContent?.includes(FOLDER_A.name),
      "B: WB_2's row must show its folder name in the Folder column",
    );

    // Create buttons
    assert.ok(
      hasTestId(root, "btn-create-workbook"),
      "B: create workbook button must be present",
    );
    assert.ok(
      hasTestId(root, "btn-create-folder"),
      "B: create folder button must be present",
    );

    console.log("  ✓ B: loaded state renders correctly with owner labels");
    await unmount();
  }

  // ── C — Navigation: click workbook card → navigates to /sheets/:id ─────────
  {
    console.log(
      "\n— C: clicking a workbook card updates the location to /sheets/:id —",
    );

    const handler = createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        { path: "/api/auth/user", json: USER },
        { path: "/api/sheets/folders", json: { folders: [] } },
        { path: "/api/sheets/workbooks", json: { workbooks: [WB_1] } },
      ],
      defaultJson: {},
    });

    const { root } = await mountLibrary(handler);
    await flush(8);

    const row = byTestId(root, `os-table-row-${WB_1.id}`) as HTMLElement | null;
    assert.ok(row, "C: workbook table row must exist");

    const { act } = await import("react");
    await act(async () => { row!.click(); });
    await flush(2);

    const href = dom.window.location.href;
    assert.ok(
      href.includes(`/sheets/${WB_1.id}`),
      `C: location must contain /sheets/${WB_1.id} after click, got: ${href}`,
    );

    console.log("  ✓ C: clicking workbook card navigates to /sheets/:id");
    await unmount();
  }

  // ── D — Search: typing in search box filters workbooks ────────────────────
  {
    console.log(
      "\n— D: typing in search box filters workbooks by name —",
    );

    const handler = createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        { path: "/api/auth/user", json: USER },
        { path: "/api/sheets/folders", json: { folders: [] } },
        {
          path: "/api/sheets/workbooks",
          // Task #4488: search is server-side now — the page sends ?q= and
          // renders whatever the server returns, so the stub filters by q.
          json: (ctx: { url: string }) => {
            const q = new URL(ctx.url, "http://localhost").searchParams.get("q");
            const workbooks = [WB_1, WB_2].filter(
              (w) => !q || w.name.toLowerCase().includes(q.toLowerCase()),
            );
            return { workbooks, total: workbooks.length };
          },
        },
      ],
      defaultJson: {},
    });

    const { root } = await mountLibrary(handler);
    await flush(8);

    assert.ok(
      hasTestId(root, `text-workbook-name-${WB_1.id}`),
      "D: WB_1 visible before search",
    );
    assert.ok(
      hasTestId(root, `text-workbook-name-${WB_2.id}`),
      "D: WB_2 visible before search",
    );

    const { act } = await import("react");
    const searchInput = byTestId(root, "input-search-workbooks") as HTMLInputElement | null;
    assert.ok(searchInput, "D: search input must be present");

    await act(async () => {
      setInputValue(searchInput!, "Campaign");
    });
    // The search box is debounced (250 ms) before the paged refetch fires.
    await flush(20);

    assert.ok(
      hasTestId(root, `text-workbook-name-${WB_2.id}`),
      "D: WB_2 (Campaign Tracker) must remain visible when search='Campaign'",
    );
    assert.ok(
      !hasTestId(root, `text-workbook-name-${WB_1.id}`),
      "D: WB_1 (Q3 Budget) must be hidden when search='Campaign'",
    );

    console.log("  ✓ D: search filters workbooks correctly");
    await unmount();
  }

  // ── E — Empty state ────────────────────────────────────────────────────────
  {
    console.log(
      "\n— E: empty state shown when there are no workbooks at all —",
    );

    const handler = createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        { path: "/api/auth/user", json: USER },
        { path: "/api/sheets/folders", json: { folders: [] } },
        { path: "/api/sheets/workbooks", json: { workbooks: [] } },
      ],
      defaultJson: {},
    });

    const { root } = await mountLibrary(handler);
    await flush(8);

    assert.ok(
      hasTestId(root, "sheets-empty-state"),
      "E: empty state must be present when there are no workbooks",
    );
    assert.ok(
      !hasTestId(root, "sheets-workbooks-table"),
      "E: the workbook table must not render when library is empty",
    );
    assert.ok(
      hasTestId(root, "btn-empty-create-workbook"),
      "E: empty state must include a create workbook CTA",
    );

    console.log("  ✓ E: empty state renders correctly");
    await unmount();
  }

  // ── F — Create workbook dialog: submit fires POST and navigates ────────────
  {
    console.log(
      "\n— F: create workbook dialog fires POST /api/sheets/workbooks and navigates —",
    );

    const NEW_WB = {
      id: "wb-new",
      name: "My New Sheet",
      ownerId: "user-1",
      folderId: null,
      updatedAt: new Date().toISOString(),
    };

    let postCalls = 0;
    let postBody: any = null;

    const handler = createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        { path: "/api/auth/user", json: USER },
        { path: "/api/sheets/folders", json: { folders: [] } },
        { path: "/api/sheets/workbooks", method: "GET", json: { workbooks: [] } },
        {
          path: "/api/sheets/workbooks",
          method: "POST",
          respond: async (ctx: any) => {
            postCalls++;
            const rawBody = ctx?.init?.body;
            postBody = rawBody ? JSON.parse(typeof rawBody === "string" ? rawBody : String(rawBody)) : null;
            return {
              ok: true,
              status: 200,
              headers: new dom.window.Headers({ "Content-Type": "application/json" }),
              json: async () => ({ workbook: NEW_WB }),
              text: async () => JSON.stringify({ workbook: NEW_WB }),
            };
          },
        },
      ],
      defaultJson: {},
    });

    const { root } = await mountLibrary(handler);
    await flush(8);

    // Library starts empty — create button should be present
    assert.ok(
      hasTestId(root, "btn-create-workbook"),
      "F: create workbook button must be present",
    );

    const { act } = await import("react");

    // Open the create dialog
    const createBtn = byTestId(root, "btn-create-workbook") as HTMLElement;
    await act(async () => { createBtn.click(); });
    await flush(4);

    // Dialog renders in document.body via Radix portal
    const nameInput = bodyTestId("input-new-workbook-name") as HTMLInputElement | null;
    assert.ok(
      nameInput,
      "F: workbook name input must be present in the create dialog (queried from document.body)",
    );

    // Type the workbook name
    await act(async () => {
      setInputValue(nameInput!, "My New Sheet");
    });
    await flush(2);

    // Submit the form
    const submitBtn = bodyTestId("btn-submit-create-workbook") as HTMLElement | null;
    assert.ok(submitBtn, "F: create dialog submit button must be present");

    await act(async () => { submitBtn!.click(); });
    await flush(6);

    assert.strictEqual(postCalls, 1, "F: exactly one POST to /api/sheets/workbooks must be fired");
    assert.strictEqual(
      postBody?.name,
      "My New Sheet",
      "F: POST body must include the typed workbook name",
    );

    // After success the mutation navigates to /sheets/:id
    const href = dom.window.location.href;
    assert.ok(
      href.includes(`/sheets/${NEW_WB.id}`),
      `F: location must be /sheets/${NEW_WB.id} after successful create, got: ${href}`,
    );

    console.log("  ✓ F: create dialog fires POST and navigates to new workbook");
    await unmount();
  }
}

main().then(() => {
  console.log("\nsheets-library: all assertions passed.");
  process.exit(0);
}).catch((err) => {
  console.error("\nsheets-library: FAILED —", err);
  process.exit(1);
});
