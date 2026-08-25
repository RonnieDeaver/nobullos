/* test-registration
{
  "name": "SectionAuditInfo editor-name rendering (Task #1277)",
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
 * Task #1277 — UI regression test for `SectionAuditInfo`'s editor-name
 * rendering.
 *
 * The companion API test (`tests/report-section-history-editor-user.test.ts`)
 * pins that `GET /api/reports/:id/sections/:sectionKey/history` returns
 * `editorUser` populated for `user:<id>` rows and null for `system:*` /
 * `unknown` rows. This test pins the OTHER half of Task #833: the
 * `SectionAuditInfo` component must turn those editor tokens into the
 * "First Last (email)" / "System (...)" / "Unknown user (<id>)" /
 * "Unknown" strings the audit panel actually shows.
 *
 * Without these assertions, a future refactor of the editor token format
 * (e.g. switching `user:<id>` to a different prefix, or dropping the
 * `editorUser` enrichment on the server) would silently regress the
 * panel back to raw IDs without anything failing in CI.
 *
 * Coverage:
 *   • last-edited badge:
 *       1. known user → "Edie Torr (editor.user@example.com)"
 *       2. system:pdf-webhook (no editorUser) → "PDF webhook"
 *       3. unrecognized system:* (no editorUser) → "System (<label>)"
 *       4. literal "unknown" → "Unknown"
 *       5. user:<id> with no editorUser → "Unknown user (<id>)"
 *   • per-history-row editor cells render the same labels for the same
 *     four token shapes after the history list is fetched and expanded.
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
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).SVGElement = dom.window.SVGElement;
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

// ---------------------------------------------------------------------------
// Stub fetch: serves the history endpoint with one row per editor-token
// shape so the expanded history list renders all four labels.
// ---------------------------------------------------------------------------

const REPORT_ID = "report-test";
const SECTION_KEY = "sales";
const GHOST_USER_ID = "ghost-user-id";

const HISTORY_ROWS = [
  {
    id: "hist-user",
    reportId: REPORT_ID,
    sectionKey: SECTION_KEY,
    previousData: null,
    newData: { totalCases: 1 },
    dataChanged: true,
    editedBy: "user:known-editor",
    editSource: "ui_edit",
    webhookImportLogId: null,
    createdAt: "2026-05-01T12:00:00.000Z",
    editorUser: {
      id: "known-editor",
      firstName: "Edie",
      lastName: "Torr",
      email: "editor.user@example.com",
    },
  },
  {
    id: "hist-pdf",
    reportId: REPORT_ID,
    sectionKey: SECTION_KEY,
    previousData: null,
    newData: { totalCases: 2 },
    dataChanged: true,
    editedBy: "system:pdf-webhook",
    editSource: "pdf_webhook",
    webhookImportLogId: null,
    createdAt: "2026-05-01T11:00:00.000Z",
    editorUser: null,
  },
  {
    id: "hist-system-other",
    reportId: REPORT_ID,
    sectionKey: SECTION_KEY,
    previousData: null,
    newData: { totalCases: 3 },
    dataChanged: true,
    editedBy: "system:nightly-job",
    editSource: "system",
    webhookImportLogId: null,
    createdAt: "2026-05-01T10:00:00.000Z",
    editorUser: null,
  },
  {
    id: "hist-ghost",
    reportId: REPORT_ID,
    sectionKey: SECTION_KEY,
    previousData: null,
    newData: { totalCases: 4 },
    dataChanged: true,
    editedBy: `user:${GHOST_USER_ID}`,
    editSource: "ui_edit",
    webhookImportLogId: null,
    createdAt: "2026-05-01T09:00:00.000Z",
    editorUser: null,
  },
  {
    id: "hist-unknown",
    reportId: REPORT_ID,
    sectionKey: SECTION_KEY,
    previousData: null,
    newData: { totalCases: 5 },
    dataChanged: false,
    editedBy: "unknown",
    editSource: "unknown",
    webhookImportLogId: null,
    createdAt: "2026-05-01T08:00:00.000Z",
    editorUser: null,
  },
];

let historyFetchCount = 0;
(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      path: new RegExp(
        `/api/reports/${REPORT_ID}/sections/${SECTION_KEY}/history`,
      ),
      respond: () => {
        historyFetchCount += 1;
        return { status: 200, json: HISTORY_ROWS };
      },
    },
  ],
  defaultJson: {},
});

// ---------------------------------------------------------------------------
// Imports — after jsdom globals + fetch stub are in place.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const SectionAuditInfo = (
  await import("../../client/src/components/SectionAuditInfo")
).default;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function renderHeader(props: {
  lastEditedBy: string | null;
  lastEditedByUser?: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
  } | null;
  lastEditSource?: string | null;
}): Promise<{ root: Root; queryClient: any }> {
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(SectionAuditInfo, {
          reportId: REPORT_ID,
          sectionKey: SECTION_KEY,
          lastEditedBy: props.lastEditedBy,
          lastEditedByUser: props.lastEditedByUser ?? null,
          lastEditSource: props.lastEditSource ?? "ui_edit",
          lastEditAt: "2026-05-01T12:00:00.000Z",
        }),
      ),
    );
  });
  await flush();
  return { root: root!, queryClient };
}

async function unmount(root: Root, queryClient: any): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  queryClient.clear();
}

// ---------------------------------------------------------------------------
// Section 1 — last-edited badge label for each token shape
// ---------------------------------------------------------------------------

async function testHeaderLabels(): Promise<void> {
  const cases: Array<{
    label: string;
    props: Parameters<typeof renderHeader>[0];
    expected: string;
  }> = [
    {
      label: "known user (editorUser populated)",
      props: {
        lastEditedBy: "user:known-editor",
        lastEditedByUser: {
          id: "known-editor",
          firstName: "Edie",
          lastName: "Torr",
          email: "editor.user@example.com",
        },
      },
      expected: "Edie Torr (editor.user@example.com)",
    },
    {
      label: "system:pdf-webhook (mapped label)",
      props: { lastEditedBy: "system:pdf-webhook", lastEditSource: "pdf_webhook" },
      expected: "PDF webhook",
    },
    {
      label: "unrecognized system:* (generic System (...) label)",
      props: { lastEditedBy: "system:nightly-job", lastEditSource: "system" },
      expected: "System (nightly job)",
    },
    {
      label: "literal 'unknown' editor",
      props: { lastEditedBy: "unknown", lastEditSource: "unknown" },
      expected: "Unknown",
    },
    {
      label: "user:<id> with no resolved editorUser → fallback",
      props: { lastEditedBy: `user:${GHOST_USER_ID}` },
      expected: `Unknown user (${GHOST_USER_ID})`,
    },
  ];

  for (const c of cases) {
    const { root, queryClient } = await renderHeader(c.props);
    try {
      const el = $(`text-last-editor-${SECTION_KEY}`);
      assert(
        el !== null,
        `[${c.label}] last-editor badge must render (testid=text-last-editor-${SECTION_KEY})`,
      );
      const text = (el!.textContent ?? "").trim();
      assert(
        text === c.expected,
        `[${c.label}] expected last-editor text "${c.expected}", got "${text}"`,
      );
    } finally {
      await unmount(root, queryClient);
    }
  }
}

// ---------------------------------------------------------------------------
// Section 2 — expanded history list renders one row per editor-token shape
// with the correct label.
// ---------------------------------------------------------------------------

async function testHistoryRowLabels(): Promise<void> {
  const before = historyFetchCount;
  const { root, queryClient } = await renderHeader({
    lastEditedBy: "user:known-editor",
    lastEditedByUser: {
      id: "known-editor",
      firstName: "Edie",
      lastName: "Torr",
      email: "editor.user@example.com",
    },
  });
  try {
    // Click the toggle button to expand history; this enables the useQuery.
    const toggle = $(`button-toggle-history-${SECTION_KEY}`);
    assert(toggle !== null, "toggle button must render");
    await act(async () => {
      toggle!.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await flush(20);

    assert(
      historyFetchCount > before,
      `expected history endpoint to be fetched after expansion (before=${before}, after=${historyFetchCount})`,
    );

    const expected: Array<{ rowId: string; label: string }> = [
      { rowId: "hist-user", label: "Edie Torr (editor.user@example.com)" },
      { rowId: "hist-pdf", label: "PDF webhook" },
      { rowId: "hist-system-other", label: "System (nightly job)" },
      { rowId: "hist-ghost", label: `Unknown user (${GHOST_USER_ID})` },
      { rowId: "hist-unknown", label: "Unknown" },
    ];

    for (const e of expected) {
      const el = $(`text-history-editor-${SECTION_KEY}-${e.rowId}`);
      assert(
        el !== null,
        `history row ${e.rowId} must render editor cell (testid=text-history-editor-${SECTION_KEY}-${e.rowId})`,
      );
      const text = (el!.textContent ?? "").trim();
      assert(
        text === e.label,
        `history row ${e.rowId}: expected editor text "${e.label}", got "${text}"`,
      );
    }
  } finally {
    await unmount(root, queryClient);
  }
}

async function main(): Promise<void> {
  await testHeaderLabels();
  await testHistoryRowLabels();
  console.log("section-audit-info-editor-names: PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("section-audit-info-editor-names: FAILED", err);
    process.exit(1);
  });
