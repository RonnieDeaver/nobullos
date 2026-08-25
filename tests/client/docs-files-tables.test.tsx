/* test-registration
{
  "name": "Docs & Files tables — bounded page slice, pagination range, pager, search, kind filter, column sort (Tasks #4489 + #4523 + #4601 + #4627)",
  "regression": true,
  "sweepOnlyReason": "Tasks #4489 + #4523 + #4601 + #4627 — pure client-side jsdom render (no DB/network); DocumentsSection + FilesLibrary OsTable refit (Task #4371): page-size-bounded rows, range text, pager next/prev, FilesLibrary search filtering, the file-type (kind) dropdown narrowing + page-1 reset, and server-side column sort on BOTH tables (header click fires sort/dir with offset=0 + page-1 range reset); composes the sheets-library resolve-hook setup with the interactive select shim, not a smoke-gate candidate.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/docs-files-tables-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/components/docs/DocumentsSection.tsx",
    "client/src/pages/FilesLibrary.tsx"
  ],
  "tier": "small"
}
test-registration */
/**
 * DocumentsSection + FilesLibrary — paged-table regression tests (Task #4489).
 *
 * After the #4371 OsTable refit only the Sheets library had a jsdom suite;
 * these two tables were screenshot-verified only. Covers, for each table:
 *   - rendered row count equals the page size, NEVER the full dataset
 *     (unbounded-render regression guard)
 *   - the pagination range text ("1–10 of N")
 *   - pager next/prev behavior (row set + range update, prev restores page 1)
 *   - search filtering (FilesLibrary — DocumentsSection has no search box)
 *
 * Task #4523 adds section D: the file-type (kind) dropdown — picking a type
 * must fire /api/files?kind=…, render only matching rows, and reset paging to
 * page 1.
 *
 * Harness mirrors tests/sheets-library.test.tsx: jsdom globals, the
 * docs-files-tables-setup.mjs resolve hooks (@clerk/react stub + Radix dialog
 * shims + the interactive @radix-ui/react-select shim so the kind dropdown is
 * drivable in jsdom), and the shared createFetchStub. Fixtures exceed one page.
 */

import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

// ── jsdom environment ─────────────────────────────────────────────────────────

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/files" },
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

function rowsOf(root: Element): Element[] {
  return Array.from(root.querySelectorAll('[data-testid^="os-table-row-"]'));
}

function rangeText(root: Element): string {
  return (
    byTestId(root, "os-table-pagination-range")?.textContent?.replace(/\s+/g, " ").trim() ?? ""
  );
}

async function flush(times = 8): Promise<void> {
  const { act } = await import("react");
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

// Server mode (upstream 329ccf19a): the components no longer slice client-side
// — /api/docs/documents and /api/files(/recent) take limit/offset and return
// the page slice + total. Emulate that here so the bounded-render assertions
// keep exercising the real contract.
function pageParamsOf(url: string): { limit: number; offset: number; params: URLSearchParams } {
  const params = new URLSearchParams(url.split("?")[1] ?? "");
  return {
    limit: Number(params.get("limit") ?? 25),
    offset: Number(params.get("offset") ?? 0),
    params,
  };
}

function pageSlice<T>(all: T[], url: string): { slice: T[]; total: number } {
  const { limit, offset } = pageParamsOf(url);
  return { slice: all.slice(offset, offset + limit), total: all.length };
}

async function click(el: Element): Promise<void> {
  const { act } = await import("react");
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush(2);
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

// 12 documents — exceeds DocumentsSection's default page size of 10.
const DOCUMENTS = Array.from({ length: 12 }, (_, i) => ({
  id: `doc-${String(i + 1).padStart(2, "0")}`,
  name: `Fixture Doc ${String(i + 1).padStart(2, "0")}`,
  ownerId: "user-1",
  clientId: null,
  revision: 1,
  createdAt: "2026-07-01T00:00:00.000Z",
  // Distinct updatedAt so the default updated-desc sort is deterministic:
  // doc-12 is newest → first row on page 1; doc-01 and doc-02 land on page 2.
  updatedAt: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
}));

function makeFile(i: number, name: string) {
  const n = String(i).padStart(2, "0");
  return {
    id: `file-${n}`,
    clientId: `client-${n}`,
    folderId: null,
    name,
    mimeType: "application/pdf",
    sizeBytes: 1000 + i,
    objectKey: `objects/file-${n}`,
    uploadedBy: "user-1",
    trashedAt: null,
    trashedBy: null,
    trashedFromFolderId: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    contentUpdatedAt: `2026-07-01T${String(i % 24).padStart(2, "0")}:0${i % 6}:00.000Z`,
    updatedAt: "2026-07-01T00:00:00.000Z",
    folderName: null,
    firmName: `Firm ${n}`,
  };
}

// 30 recent files — exceeds FilesLibrary's default page size of 25.
const RECENT_FILES = Array.from({ length: 30 }, (_, i) =>
  makeFile(i + 1, `Recent File ${String(i + 1).padStart(2, "0")}.pdf`),
);

// Server-filtered search results for q="alpha".
const ALPHA_FILES = [makeFile(91, "Alpha Report.pdf"), makeFile(92, "alpha notes.pdf")];

// Server-filtered results for kind="image" (Task #4523). Distinct ids from
// every recent fixture so a leaked unfiltered row is detectable.
const IMAGE_FILES = [
  { ...makeFile(81, "Logo.png"), mimeType: "image/png" },
  { ...makeFile(82, "Banner.jpg"), mimeType: "image/jpeg" },
  { ...makeFile(83, "Icon.svg"), mimeType: "image/svg+xml" },
];

// ── mount plumbing ────────────────────────────────────────────────────────────

let _root: any = null;
let _queryClient: any = null;
const container = dom.window.document.getElementById("root")!;

async function mount(
  fetchHandler: (url: string, init?: any) => Promise<any>,
  element: () => Promise<any>,
): Promise<HTMLElement> {
  dom.window.history.pushState({}, "", "/files");

  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { act } = await import("react");
  const { getQueryFn } = await import("../../client/src/lib/queryClient");
  const { TooltipProvider } = await import("../../client/src/components/ui/tooltip");

  (globalThis as any).fetch = fetchHandler;

  _queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // FilesLibrary's queries rely on the app-level default queryFn.
        queryFn: getQueryFn({ on401: "throw" }),
        retry: false,
        staleTime: 0,
        gcTime: 0,
      },
      mutations: { retry: false },
    },
  });

  const child = await element();

  await act(async () => {
    if (!_root) _root = createRoot(container);
    _root.render(
      React.createElement(
        QueryClientProvider,
        { client: _queryClient },
        React.createElement(TooltipProvider, null, child),
      ),
    );
  });

  return container as HTMLElement;
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
  // ── A — DocumentsSection: bounded page slice + range text + pager ──────────
  {
    console.log("\n— A: DocumentsSection renders one page slice, range text, and pages —");

    const handler = createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        { path: "/api/auth/user", json: USER },
        {
          path: "/api/docs/documents",
          json: ({ url }: { url: string }) => {
            // Server sort: updated desc (the component's default).
            const sorted = [...DOCUMENTS].sort((a, b) =>
              b.updatedAt.localeCompare(a.updatedAt),
            );
            const { slice, total } = pageSlice(sorted, url);
            return { documents: slice, total };
          },
        },
      ],
      defaultJson: {},
    });

    const root = await mount(handler, async () => {
      const React = await import("react");
      const { default: DocumentsSection } = await import(
        "../../client/src/components/docs/DocumentsSection"
      );
      return React.createElement(DocumentsSection as any, {});
    });
    await flush(8);

    assert.ok(!byTestId(root, "documents-loading"), "A: loading spinner gone after load");
    assert.ok(byTestId(root, "documents-table"), "A: documents OsTable renders");

    // Bounded render: page size (10), never the full 12-row dataset.
    assert.strictEqual(
      rowsOf(root).length,
      10,
      "A: rendered row count must equal the page size (10), never the full dataset (12)",
    );
    assert.strictEqual(rangeText(root), "1–10 of 12", "A: page-1 range text");

    // Default sort is updated desc → newest doc-12 first; doc-02/doc-01 on page 2.
    assert.ok(
      byTestId(root, "text-document-name-doc-12"),
      "A: newest document on page 1",
    );
    assert.ok(
      !byTestId(root, "text-document-name-doc-01"),
      "A: oldest document must NOT render on page 1",
    );

    // Pager: next → the remaining 2 rows.
    const next = byTestId(root, "button-os-table-page-next")!;
    assert.ok(next, "A: next-page button present");
    await click(next);

    assert.strictEqual(rowsOf(root).length, 2, "A: page 2 renders the remaining 2 rows");
    assert.strictEqual(rangeText(root), "11–12 of 12", "A: page-2 range text");
    assert.ok(byTestId(root, "text-document-name-doc-01"), "A: oldest doc on page 2");
    assert.ok(
      (byTestId(root, "button-os-table-page-next") as HTMLButtonElement).disabled,
      "A: next disabled on the last page",
    );

    // Pager: prev → back to page 1.
    await click(byTestId(root, "button-os-table-page-prev")!);
    assert.strictEqual(rowsOf(root).length, 10, "A: prev restores the page-1 slice");
    assert.strictEqual(rangeText(root), "1–10 of 12", "A: prev restores page-1 range text");

    console.log("  ✓ A: DocumentsSection bounded slice + pager");
    await unmount();
  }

  // ── B — FilesLibrary: bounded page slice + range text + pager ──────────────
  {
    console.log("\n— B: FilesLibrary renders one page slice, range text, and pages —");

    const handler = createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        { path: "/api/auth/user", json: USER },
        {
          path: "/api/files/recent",
          json: ({ url }: { url: string }) => {
            const { slice, total } = pageSlice(RECENT_FILES, url);
            return { files: slice, total };
          },
        },
      ],
      defaultJson: {},
    });

    const root = await mount(handler, async () => {
      const React = await import("react");
      const { default: FilesLibrary } = await import(
        "../../client/src/pages/FilesLibrary"
      );
      return React.createElement(FilesLibrary as any);
    });
    await flush(8);

    assert.ok(byTestId(root, "files-results-table"), "B: files OsTable renders");
    assert.strictEqual(
      rowsOf(root).length,
      25,
      "B: rendered row count must equal the page size (25), never the full dataset (30)",
    );
    assert.strictEqual(rangeText(root), "1–25 of 30", "B: page-1 range text");

    await click(byTestId(root, "button-os-table-page-next")!);
    assert.strictEqual(rowsOf(root).length, 5, "B: page 2 renders the remaining 5 rows");
    assert.strictEqual(rangeText(root), "26–30 of 30", "B: page-2 range text");
    assert.ok(
      (byTestId(root, "button-os-table-page-next") as HTMLButtonElement).disabled,
      "B: next disabled on the last page",
    );

    await click(byTestId(root, "button-os-table-page-prev")!);
    assert.strictEqual(rowsOf(root).length, 25, "B: prev restores the page-1 slice");
    assert.strictEqual(rangeText(root), "1–25 of 30", "B: prev restores page-1 range text");

    console.log("  ✓ B: FilesLibrary bounded slice + pager");
    await unmount();
  }

  // ── C — FilesLibrary: search filters the row set ────────────────────────────
  {
    console.log("\n— C: FilesLibrary search filters rows (and resets to page 1) —");

    let searchCalls = 0;
    const handler = createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        { path: "/api/auth/user", json: USER },
        {
          path: "/api/files/recent",
          json: ({ url }: { url: string }) => {
            const { slice, total } = pageSlice(RECENT_FILES, url);
            return { files: slice, total };
          },
        },
        {
          path: /\/api\/files\?/,
          json: () => {
            searchCalls++;
            return { files: ALPHA_FILES, total: ALPHA_FILES.length };
          },
        },
      ],
      defaultJson: {},
    });

    const root = await mount(handler, async () => {
      const React = await import("react");
      const { default: FilesLibrary } = await import(
        "../../client/src/pages/FilesLibrary"
      );
      return React.createElement(FilesLibrary as any);
    });
    await flush(8);

    // Go to page 2 first so search's page reset is exercised.
    await click(byTestId(root, "button-os-table-page-next")!);
    assert.strictEqual(rangeText(root), "26–30 of 30", "C: on page 2 before searching");

    const { act } = await import("react");
    const search = byTestId(root, "input-global-file-search") as HTMLInputElement | null;
    assert.ok(search, "C: search input present");
    await act(async () => {
      setInputValue(search!, "alpha");
    });
    await flush(8);

    assert.ok(searchCalls >= 1, "C: search query must hit /api/files?q=…");
    assert.strictEqual(
      rowsOf(root).length,
      ALPHA_FILES.length,
      "C: only the filtered rows render while searching",
    );
    assert.ok(byTestId(root, "global-file-name-file-91"), "C: matching file visible");
    assert.ok(
      !byTestId(root, "global-file-name-file-01"),
      "C: non-matching recent file hidden while searching",
    );
    assert.strictEqual(rangeText(root), "1–2 of 2", "C: search resets to page 1 with the filtered total");

    // Clearing the search restores the recent set.
    await act(async () => {
      setInputValue(search!, "");
    });
    await flush(8);
    assert.strictEqual(rowsOf(root).length, 25, "C: clearing search restores the recent page slice");
    assert.strictEqual(rangeText(root), "1–25 of 30", "C: clearing search restores the recent range");

    console.log("  ✓ C: FilesLibrary search filters and resets paging");
    await unmount();
  }

  // ── D — FilesLibrary: kind filter narrows rows and resets paging ────────────
  {
    console.log("\n— D: FilesLibrary kind filter fires ?kind=…, narrows rows, resets to page 1 —");

    const kindUrls: string[] = [];
    const handler = createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        { path: "/api/auth/user", json: USER },
        {
          path: "/api/files/recent",
          json: ({ url }: { url: string }) => {
            const { slice, total } = pageSlice(RECENT_FILES, url);
            return { files: slice, total };
          },
        },
        {
          path: /\/api\/files\?/,
          json: ({ url }: { url: string }) => {
            kindUrls.push(url);
            return { files: IMAGE_FILES, total: IMAGE_FILES.length };
          },
        },
      ],
      defaultJson: {},
    });

    const root = await mount(handler, async () => {
      const React = await import("react");
      const { default: FilesLibrary } = await import(
        "../../client/src/pages/FilesLibrary"
      );
      return React.createElement(FilesLibrary as any);
    });
    await flush(8);

    // Go to page 2 first so the filter's page reset is exercised.
    await click(byTestId(root, "button-os-table-page-next")!);
    assert.strictEqual(rangeText(root), "26–30 of 30", "D: on page 2 before filtering");

    // Drive the Radix Select through the interactive shim: items render
    // inline with data-select-item-value and click → onValueChange.
    assert.ok(byTestId(root, "select-kind-filter"), "D: kind-filter select trigger present");
    const imageItem = root.querySelector(
      '[data-select-item-value="image"]',
    ) as HTMLElement | null;
    assert.ok(imageItem, "D: 'Image' kind option rendered by the select shim");
    await click(imageItem!);
    await flush(8);

    // The filtered query fired with the chosen kind AND a page-1 offset.
    assert.ok(kindUrls.length >= 1, "D: kind filter must hit /api/files?kind=…");
    const lastUrl = kindUrls[kindUrls.length - 1];
    const params = new URLSearchParams(lastUrl.split("?")[1] ?? "");
    assert.strictEqual(params.get("kind"), "image", "D: query carries kind=image");
    assert.strictEqual(
      params.get("offset"),
      "0",
      "D: choosing a kind resets pagination to page 1 (offset 0)",
    );

    // Only the server-filtered rows render.
    assert.strictEqual(
      rowsOf(root).length,
      IMAGE_FILES.length,
      "D: only matching rows render while the kind filter is active",
    );
    assert.ok(byTestId(root, "global-file-name-file-81"), "D: matching image file visible");
    assert.ok(
      !byTestId(root, "global-file-name-file-01"),
      "D: non-matching recent file hidden while the kind filter is active",
    );
    assert.strictEqual(
      rangeText(root),
      "1–3 of 3",
      "D: kind filter resets to page 1 with the filtered total",
    );

    // Switching back to "All types" restores the recent set on page 1.
    const allItem = root.querySelector(
      '[data-select-item-value="all"]',
    ) as HTMLElement | null;
    assert.ok(allItem, "D: 'All types' option rendered by the select shim");
    await click(allItem!);
    await flush(8);
    assert.strictEqual(
      rowsOf(root).length,
      25,
      "D: 'All types' restores the recent page slice",
    );
    assert.strictEqual(rangeText(root), "1–25 of 30", "D: 'All types' restores the recent range");

    console.log("  ✓ D: FilesLibrary kind filter narrows rows and resets paging");
    await unmount();
  }

  // ── E — FilesLibrary: column-sort fires server sort/dir and resets paging ───
  // Task #4601 — since upstream 329ccf19a sorting is server-side: a header
  // click must refetch with sort=<key>&dir=<direction> and offset=0.
  {
    console.log("\n— E: FilesLibrary header click fires ?sort=…&dir=… with offset=0 —");

    const recentUrls: string[] = [];
    const handler = createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        { path: "/api/auth/user", json: USER },
        {
          path: "/api/files/recent",
          json: ({ url }: { url: string }) => {
            recentUrls.push(url);
            const { slice, total } = pageSlice(RECENT_FILES, url);
            return { files: slice, total };
          },
        },
      ],
      defaultJson: {},
    });

    const root = await mount(handler, async () => {
      const React = await import("react");
      const { default: FilesLibrary } = await import(
        "../../client/src/pages/FilesLibrary"
      );
      return React.createElement(FilesLibrary as any);
    });
    await flush(8);

    // Default sort is modified desc — visible in the initial request.
    {
      const first = new URLSearchParams(recentUrls[0]?.split("?")[1] ?? "");
      assert.strictEqual(first.get("sort"), "modified", "E: initial query sorts by modified");
      assert.strictEqual(first.get("dir"), "desc", "E: initial query sorts desc");
    }

    // Go to page 2 first so the sort's page reset is exercised.
    await click(byTestId(root, "button-os-table-page-next")!);
    assert.strictEqual(rangeText(root), "26–30 of 30", "E: on page 2 before sorting");
    {
      const page2 = new URLSearchParams(
        recentUrls[recentUrls.length - 1]?.split("?")[1] ?? "",
      );
      assert.strictEqual(page2.get("offset"), "25", "E: page 2 fetched with offset=25");
    }

    // Click the Name header: a column not currently sorted starts at asc.
    const nameSort = byTestId(root, "os-table-sort-name") as HTMLElement | null;
    assert.ok(nameSort, "E: Name column sort button present");
    const callsBefore = recentUrls.length;
    await click(nameSort!);
    await flush(8);

    assert.ok(
      recentUrls.length > callsBefore,
      "E: header click must fire a new /api/files/recent request",
    );
    const afterAsc = new URLSearchParams(
      recentUrls[recentUrls.length - 1].split("?")[1] ?? "",
    );
    assert.strictEqual(afterAsc.get("sort"), "name", "E: query carries sort=name");
    assert.strictEqual(afterAsc.get("dir"), "asc", "E: first click sorts asc");
    assert.strictEqual(
      afterAsc.get("offset"),
      "0",
      "E: sorting resets pagination to page 1 (offset 0)",
    );
    assert.strictEqual(rangeText(root), "1–25 of 30", "E: range text returns to page 1");

    // Second click on the same header flips to desc, still at offset 0.
    await click(byTestId(root, "os-table-sort-name")!);
    await flush(8);
    const afterDesc = new URLSearchParams(
      recentUrls[recentUrls.length - 1].split("?")[1] ?? "",
    );
    assert.strictEqual(afterDesc.get("sort"), "name", "E: second click keeps sort=name");
    assert.strictEqual(afterDesc.get("dir"), "desc", "E: second click flips to desc");
    assert.strictEqual(afterDesc.get("offset"), "0", "E: still page 1 after flipping direction");
    assert.strictEqual(rangeText(root), "1–25 of 30", "E: range text stays on page 1");

    console.log("  ✓ E: FilesLibrary column sort drives the server query and resets paging");
    await unmount();
  }

  // ── F — DocumentsSection: column-sort fires server sort/dir and resets paging
  // Task #4627 — same OsTable server-sort contract as FilesLibrary (section E),
  // but against /api/docs/documents: a header click must refetch with
  // sort=<key>&dir=<direction> and offset=0, and range text returns to page 1.
  {
    console.log("\n— F: DocumentsSection header click fires ?sort=…&dir=… with offset=0 —");

    const docUrls: string[] = [];
    const handler = createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        { path: "/api/auth/user", json: USER },
        {
          path: "/api/docs/documents",
          json: ({ url }: { url: string }) => {
            docUrls.push(url);
            const { params } = pageParamsOf(url);
            const dir = params.get("dir") === "asc" ? 1 : -1;
            const key = params.get("sort") ?? "updated";
            const sorted = [...DOCUMENTS].sort((a, b) =>
              key === "name"
                ? dir * a.name.localeCompare(b.name)
                : dir * a.updatedAt.localeCompare(b.updatedAt),
            );
            const { slice, total } = pageSlice(sorted, url);
            return { documents: slice, total };
          },
        },
      ],
      defaultJson: {},
    });

    const root = await mount(handler, async () => {
      const React = await import("react");
      const { default: DocumentsSection } = await import(
        "../../client/src/components/docs/DocumentsSection"
      );
      return React.createElement(DocumentsSection as any, {});
    });
    await flush(8);

    // Default sort is updated desc — visible in the initial request.
    {
      const first = new URLSearchParams(docUrls[0]?.split("?")[1] ?? "");
      assert.strictEqual(first.get("sort"), "updated", "F: initial query sorts by updated");
      assert.strictEqual(first.get("dir"), "desc", "F: initial query sorts desc");
    }

    // Go to page 2 first so the sort's page reset is exercised.
    await click(byTestId(root, "button-os-table-page-next")!);
    assert.strictEqual(rangeText(root), "11–12 of 12", "F: on page 2 before sorting");
    {
      const page2 = new URLSearchParams(
        docUrls[docUrls.length - 1]?.split("?")[1] ?? "",
      );
      assert.strictEqual(page2.get("offset"), "10", "F: page 2 fetched with offset=10");
    }

    // Click the Name header: a column not currently sorted starts at asc.
    const nameSort = byTestId(root, "os-table-sort-name") as HTMLElement | null;
    assert.ok(nameSort, "F: Name column sort button present");
    const callsBefore = docUrls.length;
    await click(nameSort!);
    await flush(8);

    assert.ok(
      docUrls.length > callsBefore,
      "F: header click must fire a new /api/docs/documents request",
    );
    const afterAsc = new URLSearchParams(
      docUrls[docUrls.length - 1].split("?")[1] ?? "",
    );
    assert.strictEqual(afterAsc.get("sort"), "name", "F: query carries sort=name");
    assert.strictEqual(afterAsc.get("dir"), "asc", "F: first click sorts asc");
    assert.strictEqual(
      afterAsc.get("offset"),
      "0",
      "F: sorting resets pagination to page 1 (offset 0)",
    );
    assert.strictEqual(rangeText(root), "1–10 of 12", "F: range text returns to page 1");
    // Name asc → "Fixture Doc 01" leads the page-1 slice.
    assert.ok(
      byTestId(root, "text-document-name-doc-01"),
      "F: name-asc puts doc-01 on page 1",
    );

    // Second click on the same header flips to desc, still at offset 0.
    await click(byTestId(root, "os-table-sort-name")!);
    await flush(8);
    const afterDesc = new URLSearchParams(
      docUrls[docUrls.length - 1].split("?")[1] ?? "",
    );
    assert.strictEqual(afterDesc.get("sort"), "name", "F: second click keeps sort=name");
    assert.strictEqual(afterDesc.get("dir"), "desc", "F: second click flips to desc");
    assert.strictEqual(afterDesc.get("offset"), "0", "F: still page 1 after flipping direction");
    assert.strictEqual(rangeText(root), "1–10 of 12", "F: range text stays on page 1");

    console.log("  ✓ F: DocumentsSection column sort drives the server query and resets paging");
    await unmount();
  }
}

main()
  .then(() => {
    console.log("\ndocs-files-tables: all assertions passed.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\ndocs-files-tables: FAILED —", err);
    process.exit(1);
  });
