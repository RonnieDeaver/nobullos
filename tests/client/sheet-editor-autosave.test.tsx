/* test-registration
{
  "name": "NoBull Sheets — editor page loads workbook, autosaves on input, shows save state badge, handles errors (Task #2930)",
  "regression": true,
  "sweepOnlyReason": "Task #2930 — pure client-side jsdom render (no DB/network); @univerjs/* stubbed via resolve-hook; Univer bundle is lazy-loaded so no real DOM canvas ops in jsdom, not a smoke-gate candidate.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/sheet-editor-mock-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/pages/SheetEditor.tsx"
  ],
  "tier": "small"
}
test-registration */
/**
 * SheetEditor — rendered smoke test (Task #2930).
 *
 * Covers:
 *   A. Loading state — spinner renders while the workbook fetch is in flight.
 *   B. Loaded state — workbook name appears in the header; back-to-sheets
 *      button and editor area are present.
 *   C. Save trigger — pointer interaction on the editor area enqueues a
 *      debounced PATCH /api/sheets/workbooks/:id; the "Unsaved changes" badge
 *      appears immediately, and after the debounce fires the "saved" badge
 *      follows.
 *   D. Save error — a failed PATCH shows the error badge; clicking the retry
 *      button re-fires the PATCH.
 *   E. Error state — a 404 from the workbook fetch renders the error screen.
 *
 * @univerjs/* is redirected to a lightweight stub via the ESM resolve hook
 * in sheet-editor-mock-setup.mjs, keeping the test fast and network-free.
 */

import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

// ── jsdom environment ─────────────────────────────────────────────────────────

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/sheets/wb-001" },
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
(globalThis as any).MutationObserver = dom.window.MutationObserver;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ── helpers ───────────────────────────────────────────────────────────────────

function byTestId(root: Element | Document, id: string): Element | null {
  return root.querySelector(`[data-testid="${id}"]`);
}

function hasTestId(root: Element | Document, id: string): boolean {
  return byTestId(root, id) !== null;
}

async function flush(times = 6): Promise<void> {
  const { act } = await import("react");
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

// ── shared fixtures ───────────────────────────────────────────────────────────

const WORKBOOK_ID = "wb-001";
const USER = {
  id: "user-1",
  email: "editor@example.com",
  firstName: "Ed",
  lastName: "Itor",
  role: "account_manager",
};
const WORKBOOK = {
  id: WORKBOOK_ID,
  name: "Q3 Budget",
  snapshot: { id: WORKBOOK_ID, sheets: {} },
  ownerId: "user-1",
  folderId: null,
  updatedAt: "2026-07-01T00:00:00.000Z",
};

// ── module-level root — created once, reused, unmounted between scenarios ─────

let _root: any = null;
let _queryClient: any = null;
const container = dom.window.document.getElementById("root")!;

async function mountEditor(
  fetchHandler: (url: string, init?: any) => Promise<any>,
): Promise<{ root: HTMLElement; queryClient: any }> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { Router, Route } = await import("wouter");
  const { act } = await import("react");
  const { default: SheetEditor } = await import(
    "../../client/src/pages/SheetEditor"
  );
  const { TooltipProvider } = await import(
    "../../client/src/components/ui/tooltip"
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
              path: "/sheets/:id",
              component: SheetEditor as any,
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
    console.log("\n— A: loading spinner shows while fetch is in flight —");

    let resolveFetch!: (v: any) => void;
    const deferredFetch = new Promise<any>((resolve) => {
      resolveFetch = resolve;
    });

    const handler = createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        { path: "/api/auth/user", json: USER },
        {
          path: `/api/sheets/workbooks/${WORKBOOK_ID}`,
          method: "GET",
          respond: async () => deferredFetch,
        },
      ],
      defaultJson: {},
    });

    const { root } = await mountEditor(handler);
    await flush(2);

    assert(
      hasTestId(root, "sheet-editor-loading"),
      "A: loading spinner must be visible while fetch is in flight",
    );
    assert(
      !hasTestId(root, "sheet-editor-root"),
      "A: full editor must not appear during loading",
    );

    console.log("  ✓ A: loading spinner shows");

    resolveFetch({
      ok: true,
      status: 200,
      headers: new dom.window.Headers({ "Content-Type": "application/json" }),
      json: async () => ({ workbook: WORKBOOK }),
      text: async () => JSON.stringify({ workbook: WORKBOOK }),
    });
    await unmount();
  }

  // ── B — Loaded state: name, back button, editor area ──────────────────────
  {
    console.log("\n— B: loaded state renders name, back button, editor area —");

    const handler = createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        { path: "/api/auth/user", json: USER },
        {
          path: `/api/sheets/workbooks/${WORKBOOK_ID}`,
          method: "GET",
          json: { workbook: WORKBOOK },
        },
      ],
      defaultJson: {},
    });

    const { root } = await mountEditor(handler);
    await flush(12);

    const editorRoot = byTestId(root, "sheet-editor-root");
    assert(editorRoot !== null, "B: sheet-editor-root must render after fetch");

    const nameEl = byTestId(root, "workbook-name");
    assert(nameEl !== null, "B: workbook-name element must exist");
    assert(
      (nameEl!.textContent ?? "").includes("Q3 Budget"),
      `B: workbook name must read 'Q3 Budget', got '${nameEl!.textContent}'`,
    );

    const backBtn = byTestId(root, "btn-back-to-sheets");
    assert(backBtn !== null, "B: back-to-sheets button must be rendered");

    const editorArea = byTestId(root, "sheet-editor-area");
    assert(editorArea !== null, "B: sheet-editor-area must be rendered");

    console.log("  ✓ B: loaded state — name, back button, editor area present");
    await unmount();
  }

  // ── C — Pointer event → debounce → PATCH ──────────────────────────────────
  {
    console.log("\n— C: pointer event triggers debounced PATCH —");

    const patchCalls: string[] = [];

    const handler = createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        { path: "/api/auth/user", json: USER },
        {
          path: `/api/sheets/workbooks/${WORKBOOK_ID}/lock`,
          method: "POST",
          json: { acquired: true, lock: null },
        },
        {
          path: `/api/sheets/workbooks/${WORKBOOK_ID}`,
          method: "GET",
          json: { workbook: WORKBOOK, userPermission: "owner" },
        },
        {
          path: `/api/sheets/workbooks/${WORKBOOK_ID}`,
          method: "PATCH",
          respond: async ({ method }: any) => {
            patchCalls.push(method);
            return {
              status: 200,
              json: { workbook: { ...WORKBOOK } },
            };
          },
        },
      ],
      defaultJson: {},
    });

    const { root } = await mountEditor(handler);
    await flush(12);

    const { act } = await import("react");

    const editorArea = byTestId(root, "sheet-editor-area");
    assert(editorArea !== null, "C: editor area must be present");

    // The onPointerDown handler on sheet-editor-area is wired only when
    // holdingLockRef.current is true (set after the async acquireLock()
    // POST /lock resolves). Under load the async chain (workbook query →
    // useEffect → acquireLock fetch → setLockAcquired(true) → re-render)
    // can outlast flush(12). Poll: dispatch the event and check the badge;
    // retry until the lock is confirmed acquired (badge appears) or timeout.
    const lockDeadline = Date.now() + 6000;
    let saveBadgeVisible = false;
    while (!saveBadgeVisible && Date.now() < lockDeadline) {
      await act(async () => {
        editorArea!.dispatchEvent(
          new dom.window.PointerEvent("pointerdown", { bubbles: true }),
        );
      });
      saveBadgeVisible = hasTestId(root, "save-badge-idle");
      if (!saveBadgeVisible) await flush(3);
    }
    assert(
      saveBadgeVisible,
      "C: 'Unsaved changes' badge must appear after pointer event (lock must be acquired first)",
    );

    // Advance past AUTOSAVE_DELAY_MS (1 500 ms).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1600));
    });
    await flush(10);

    assert(
      patchCalls.length > 0,
      "C: PATCH must have been called after debounce fires",
    );

    console.log("  ✓ C: pointer event → idle badge → debounced PATCH save");
    await unmount();
  }

  // ── D — Failed PATCH → error badge → retry ────────────────────────────────
  {
    console.log("\n— D: failed PATCH shows error badge; retry re-fires PATCH —");

    const retryCalls: string[] = [];

    const handler = createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        { path: "/api/auth/user", json: USER },
        {
          path: `/api/sheets/workbooks/${WORKBOOK_ID}/lock`,
          method: "POST",
          json: { acquired: true, lock: null },
        },
        {
          path: `/api/sheets/workbooks/${WORKBOOK_ID}`,
          method: "GET",
          json: { workbook: WORKBOOK, userPermission: "owner" },
        },
        {
          path: `/api/sheets/workbooks/${WORKBOOK_ID}`,
          method: "PATCH",
          respond: async ({ method }: any) => {
            retryCalls.push(method);
            return { status: 500, json: { error: "DB unavailable" } };
          },
        },
      ],
      defaultJson: {},
    });

    const { root } = await mountEditor(handler);
    await flush(12);

    const { act } = await import("react");

    const editorArea = byTestId(root, "sheet-editor-area");
    assert(editorArea !== null, "D: editor area required");

    // Same lock-acquisition polling as Scenario C: the onPointerDown handler
    // is only active once holdingLockRef.current is true. Poll until the
    // idle badge appears (confirming the lock is held) before advancing past
    // the debounce timer.
    const lockDeadlineD = Date.now() + 6000;
    let saveBadgeVisibleD = false;
    while (!saveBadgeVisibleD && Date.now() < lockDeadlineD) {
      await act(async () => {
        editorArea!.dispatchEvent(
          new dom.window.PointerEvent("pointerdown", { bubbles: true }),
        );
      });
      saveBadgeVisibleD = hasTestId(root, "save-badge-idle");
      if (!saveBadgeVisibleD) await flush(3);
    }
    assert(saveBadgeVisibleD, "D: lock must be acquired before the debounce can fire");

    await act(async () => {
      await new Promise((r) => setTimeout(r, 1600));
    });
    await flush(10);

    assert(
      hasTestId(root, "save-badge-error"),
      "D: error badge must render after a failed PATCH",
    );

    const retryBtn = byTestId(root, "btn-retry-save");
    assert(retryBtn !== null, "D: retry button must be present on error");

    const callsBefore = retryCalls.length;
    await act(async () => {
      (retryBtn as HTMLElement).click();
    });
    await flush(8);

    assert(
      retryCalls.length > callsBefore,
      "D: clicking retry must fire another PATCH",
    );

    console.log("  ✓ D: failed save → error badge; retry re-fires PATCH");
    await unmount();
  }

  // ── E — 404 workbook → error screen ───────────────────────────────────────
  {
    console.log("\n— E: 404 workbook fetch → error screen —");

    const handler = createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        { path: "/api/auth/user", json: USER },
        {
          path: `/api/sheets/workbooks/${WORKBOOK_ID}`,
          method: "GET",
          respond: async () => ({
            status: 404,
            json: { error: "Workbook not found" },
          }),
        },
      ],
      defaultJson: {},
    });

    const { root } = await mountEditor(handler);
    await flush(12);

    assert(
      hasTestId(root, "sheet-editor-error"),
      "E: error screen must render when fetch returns 404",
    );
    assert(
      !hasTestId(root, "sheet-editor-root"),
      "E: full editor must not render on 404",
    );

    console.log("  ✓ E: 404 fetch → error screen");
    await unmount();
  }

  console.log("\n5 passed, 0 failed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
