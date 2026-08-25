/* test-registration
{
  "name": "OsTable primitive: windowing, sort, pagination, density (Task 4343)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Contract test for the shared virtualized-table primitive every long-list adopter builds on (audit P0-1). Pure jsdom: no DB, no network, no loaders, single tsx child, deterministic fixed-height windowing, ~10s.",
  "extraEnv": { "TSX_TSCONFIG_PATH": "./tsconfig.tests.json" },
  "tier": "small"
}
test-registration */

/**
 * Task #4343 — OsTable virtualized table primitive.
 *
 * Covers the component contracts the adopter tasks rely on:
 *  1. Client mode renders every row below the threshold; sort cycles
 *     asc → desc → cleared and reorders locally.
 *  2. Controlled (server) sort reports through onSortChange and never
 *     reorders the given rows.
 *  3. Above the threshold the body virtualizes: only the visible window
 *     exists in the DOM, spacer rows carry the remaining height, and the
 *     window tracks viewport scroll.
 *  4. Threshold boundary: exactly 100 rows stays fully rendered; 101
 *     virtualizes.
 *  5. Pagination footer: range label, callbacks, and disabled bounds.
 *  6. Density toggle: data-density, virtualized row heights, callback.
 *  7. Sticky/empty-state affordances: sticky classes, opt-outs, and the
 *     empty-state cell.
 */
import { JSDOM } from "jsdom";
import { installJsdomGlobals } from "../helpers/installJsdomGlobals";

const dom = new JSDOM(
  "<!doctype html><html><body></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
installJsdomGlobals(dom);
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no layout, so every element measures 0x0 and virtual-core
// refuses to window (calculateRange bails when the viewport size is 0).
// Its getRect reads offsetWidth/offsetHeight, so report a fixed 800x600
// viewport for the OsTable scroller; with the 44px comfortable row
// height that yields a ~14-row visible window plus overscan.
const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;
const elementProto = dom.window.HTMLElement.prototype;
Object.defineProperty(elementProto, "offsetWidth", {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList?.contains("os-table-wrap") ? VIEWPORT_WIDTH : 0;
  },
});
Object.defineProperty(elementProto, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList?.contains("os-table-wrap") ? VIEWPORT_HEIGHT : 0;
  },
});

// Bound as `React` so both JSX transforms work: the classic transform
// references this binding directly; the automatic transform ignores it.
const React = (await import("react")).default;
const { act } = React as unknown as { act: typeof import("react").act };
const { createRoot } = await import("react-dom/client");
const { OsTable, OS_TABLE_VIRTUALIZE_ABOVE, OS_TABLE_ROW_HEIGHTS } =
  await import("../../client/src/components/ui/os-table");
import type {
  OsTableColumn,
  OsTableSort,
} from "../../client/src/components/ui/os-table";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`ok — ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL — ${label}${detail ? ` :: ${detail}` : ""}`);
  }
}

async function flush(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const doc = dom.window.document;
const $ = (sel: string) => doc.querySelector(sel);
const $$ = (sel: string) => Array.from(doc.querySelectorAll(sel));
const byTestId = (id: string) => $(`[data-testid="${id}"]`) as HTMLElement | null;

async function mount(element: React.ReactElement) {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  let root!: ReturnType<typeof createRoot>;
  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });
  await flush();
  return {
    container,
    rerender: async (next: React.ReactElement) => {
      await act(async () => {
        root.render(next);
      });
      await flush();
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  await flush(2);
}

function renderedRowTestIds(): string[] {
  return $$('tr[data-testid^="os-table-row-"]').map(
    (tr) => tr.getAttribute("data-testid") ?? "",
  );
}

function firstCellTexts(): string[] {
  return $$('tr[data-testid^="os-table-row-"]').map(
    (tr) => tr.querySelector("td")?.textContent?.trim() ?? "",
  );
}

function setScrollTop(el: HTMLElement, value: number) {
  el.scrollTop = value;
  if (el.scrollTop !== value) {
    // jsdom has no layout; if the setter clamped against a zero scroll
    // range, pin the property so the virtualizer reads the intended offset.
    Object.defineProperty(el, "scrollTop", {
      value,
      configurable: true,
      writable: true,
    });
  }
}

interface FixtureRow {
  id: string;
  name: string;
  amount: number | null;
  note: string;
}

const smallRows: FixtureRow[] = [
  { id: "r0", name: "delta", amount: 30, note: "n0" },
  { id: "r1", name: "alpha", amount: 10, note: "n1" },
  { id: "r2", name: "charlie", amount: 20, note: "n2" },
  { id: "r3", name: "echo", amount: null, note: "n3" },
  { id: "r4", name: "bravo", amount: 40, note: "n4" },
];

const columns: Array<OsTableColumn<FixtureRow>> = [
  { key: "name", header: "Name", sortable: true, cell: (r) => r.name },
  {
    key: "amount",
    header: "Amount",
    sortable: true,
    align: "right",
    sortValue: (r) => r.amount,
    cell: (r) => (r.amount == null ? "-" : String(r.amount)),
  },
  { key: "note", header: "Note", cell: (r) => r.note },
];

function makeRows(count: number): FixtureRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `b${i}`,
    name: `Row ${i}`,
    amount: i,
    note: `note ${i}`,
  }));
}

const rowKey = (r: FixtureRow) => r.id;

try {
  // ── 1. Client mode: full render below threshold + local sort cycle ──
  {
    const sortCalls: Array<OsTableSort | null> = [];
    const view = await mount(
      <OsTable
        columns={columns}
        rows={smallRows}
        rowKey={rowKey}
        onSortChange={(s) => sortCalls.push(s)}
      />,
    );

    check(
      "small table renders every row without spacers",
      renderedRowTestIds().length === 5 &&
        byTestId("os-table-spacer-top") == null &&
        byTestId("os-table-spacer-bottom") == null,
      `rows=${renderedRowTestIds().length}`,
    );
    check(
      "input order preserved when unsorted",
      firstCellTexts().join(",") === "delta,alpha,charlie,echo,bravo",
      firstCellTexts().join(","),
    );
    const table = $("table");
    check(
      "sticky first column class on by default; sticky header waits for a bounded viewport",
      table != null &&
        table.classList.contains("os-sticky-col") &&
        !table.classList.contains("os-table--sticky-header"),
      table?.className,
    );
    check(
      "unbounded small table has no aria-rowcount and no bounded wrap",
      table?.getAttribute("aria-rowcount") == null &&
        !byTestId("os-table-viewport")!.classList.contains(
          "os-table-wrap--bounded",
        ),
    );

    const nameSort = byTestId("os-table-sort-name")!;
    await click(nameSort);
    check(
      "first click sorts ascending by name",
      firstCellTexts().join(",") === "alpha,bravo,charlie,delta,echo",
      firstCellTexts().join(","),
    );
    check(
      "aria-sort=ascending on the active header",
      $('th[aria-sort="ascending"]') != null,
    );

    await click(nameSort);
    check(
      "second click sorts descending",
      firstCellTexts().join(",") === "echo,delta,charlie,bravo,alpha",
      firstCellTexts().join(","),
    );

    await click(nameSort);
    check(
      "third click clears the sort back to input order",
      firstCellTexts().join(",") === "delta,alpha,charlie,echo,bravo",
      firstCellTexts().join(","),
    );
    check(
      "onSortChange saw asc, desc, then null",
      sortCalls.length === 3 &&
        sortCalls[0]?.key === "name" &&
        sortCalls[0]?.direction === "asc" &&
        sortCalls[1]?.direction === "desc" &&
        sortCalls[2] === null,
      JSON.stringify(sortCalls),
    );

    const amountSort = byTestId("os-table-sort-amount")!;
    await click(amountSort);
    check(
      "numeric sort via sortValue puts nullish last ascending",
      firstCellTexts().join(",") === "alpha,charlie,delta,bravo,echo",
      firstCellTexts().join(","),
    );

    await view.unmount();
  }

  // ── 2. Controlled (server) sort never reorders locally ──
  {
    const sortCalls: Array<OsTableSort | null> = [];
    const view = await mount(
      <OsTable
        columns={columns}
        rows={smallRows}
        rowKey={rowKey}
        sort={{ key: "amount", direction: "asc" }}
        onSortChange={(s) => sortCalls.push(s)}
      />,
    );

    check(
      "controlled sort leaves row order to the server",
      firstCellTexts().join(",") === "delta,alpha,charlie,echo,bravo",
      firstCellTexts().join(","),
    );
    check(
      "controlled sort still reflects aria-sort",
      $('th[aria-sort="ascending"]') != null,
    );

    await click(byTestId("os-table-sort-amount")!);
    check(
      "controlled click reports desc without reordering",
      sortCalls.length === 1 &&
        sortCalls[0]?.key === "amount" &&
        sortCalls[0]?.direction === "desc" &&
        firstCellTexts().join(",") === "delta,alpha,charlie,echo,bravo",
      JSON.stringify(sortCalls),
    );

    await view.unmount();
  }

  // ── 3. Virtualization: windowing, scroll tracking, density heights ──
  {
    const total = 1000;
    const densityCalls: string[] = [];
    const view = await mount(
      <OsTable
        columns={columns}
        rows={makeRows(total)}
        rowKey={rowKey}
        onDensityChange={(d) => densityCalls.push(d)}
      />,
    );

    const table = $("table")!;
    const viewport = byTestId("os-table-viewport")!;
    const rendered = renderedRowTestIds();

    check(
      "virtualized table renders only a small window of rows",
      rendered.length >= 1 && rendered.length <= 60,
      `rendered=${rendered.length} of ${total}`,
    );
    check(
      "window starts at the top: row 0 present, row 500 absent",
      rendered.includes("os-table-row-b0") &&
        !rendered.includes("os-table-row-b500"),
    );
    const bottomSpacer = byTestId("os-table-spacer-bottom");
    const bottomHeight = bottomSpacer
      ? Number.parseInt(
          (bottomSpacer.querySelector("td") as HTMLElement).style.height,
          10,
        )
      : 0;
    check(
      "bottom spacer carries the unrendered height",
      bottomHeight > 30000,
      `bottomHeight=${bottomHeight}`,
    );
    check(
      "bounded viewport + fixed-row class + aria-rowcount when virtualized",
      viewport.classList.contains("os-table-wrap--bounded") &&
        table.classList.contains("os-table--fixed-rows") &&
        table.classList.contains("os-table--sticky-header") &&
        table.getAttribute("aria-rowcount") === String(total + 1),
    );
    const comfortableHeight = OS_TABLE_ROW_HEIGHTS.comfortable;
    const firstRow = $(`tr[data-testid="os-table-row-b0"]`) as HTMLElement;
    check(
      "virtualized rows pin the comfortable fixed height",
      firstRow.style.height === `${comfortableHeight}px`,
      firstRow.style.height,
    );

    // Scroll deep into the list and confirm the window follows.
    await act(async () => {
      setScrollTop(viewport, 500 * comfortableHeight);
      viewport.dispatchEvent(new dom.window.Event("scroll"));
    });
    await flush(3);

    const afterScroll = renderedRowTestIds();
    const topSpacer = byTestId("os-table-spacer-top");
    const topHeight = topSpacer
      ? Number.parseInt(
          (topSpacer.querySelector("td") as HTMLElement).style.height,
          10,
        )
      : 0;
    check(
      "scrolled window contains row 500 and dropped row 0",
      afterScroll.includes("os-table-row-b500") &&
        !afterScroll.includes("os-table-row-b0"),
      afterScroll.slice(0, 3).join(","),
    );
    check(
      "top spacer replaces the scrolled-past rows",
      topHeight >= (500 - 40) * comfortableHeight,
      `topHeight=${topHeight}`,
    );
    check(
      "window stays small after scrolling",
      afterScroll.length <= 60,
      `rendered=${afterScroll.length}`,
    );

    // Density toggle: compact rows shrink the fixed height.
    await click(byTestId("button-os-table-density-compact")!);
    const shell = byTestId("os-table")!;
    const compactRow = $$('tr[data-testid^="os-table-row-"]')[0] as HTMLElement;
    check(
      "density toggle flips data-density and reports the change",
      shell.getAttribute("data-density") === "compact" &&
        densityCalls.join(",") === "compact",
      `${shell.getAttribute("data-density")} calls=${densityCalls.join(",")}`,
    );
    check(
      "compact density pins the compact fixed row height",
      compactRow.style.height === `${OS_TABLE_ROW_HEIGHTS.compact}px`,
      compactRow.style.height,
    );

    await view.unmount();
  }

  // ── 4. Threshold boundary ──
  {
    check(
      "exported threshold constant is 100",
      OS_TABLE_VIRTUALIZE_ABOVE === 100,
    );
    const at = await mount(
      <OsTable columns={columns} rows={makeRows(100)} rowKey={rowKey} />,
    );
    check(
      "exactly 100 rows stays fully rendered (no virtualization)",
      renderedRowTestIds().length === 100 &&
        byTestId("os-table-spacer-bottom") == null,
      `rows=${renderedRowTestIds().length}`,
    );
    await at.unmount();

    const above = await mount(
      <OsTable columns={columns} rows={makeRows(101)} rowKey={rowKey} />,
    );
    check(
      "101 rows virtualizes",
      renderedRowTestIds().length < 101 &&
        $("table")!.classList.contains("os-table--fixed-rows"),
      `rows=${renderedRowTestIds().length}`,
    );
    await above.unmount();
  }

  // ── 5. Pagination footer ──
  {
    const pageCalls: number[] = [];
    const sizeCalls: number[] = [];
    const makePaged = (page: number) => (
      <OsTable
        columns={columns}
        rows={smallRows}
        rowKey={rowKey}
        pagination={{
          page,
          pageSize: 50,
          total: 230,
          onPageChange: (p) => pageCalls.push(p),
          onPageSizeChange: (s) => sizeCalls.push(s),
          pageSizeOptions: [50, 100],
        }}
      />
    );
    const view = await mount(makePaged(2));

    check(
      "range label reflects the server window",
      byTestId("os-table-pagination-range")?.textContent === "51–100 of 230",
      byTestId("os-table-pagination-range")?.textContent ?? "missing",
    );
    await click(byTestId("button-os-table-page-next")!);
    await click(byTestId("button-os-table-page-prev")!);
    check(
      "pager buttons report 1-based page changes",
      pageCalls.join(",") === "3,1",
      pageCalls.join(","),
    );

    const select = byTestId("select-os-table-page-size") as HTMLSelectElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLSelectElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      valueSetter.call(select, "100");
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await flush(2);
    check(
      "page-size select reports the numeric size",
      sizeCalls.join(",") === "100",
      sizeCalls.join(","),
    );

    await view.rerender(makePaged(1));
    check(
      "first page disables prev",
      (byTestId("button-os-table-page-prev") as HTMLButtonElement).disabled &&
        !(byTestId("button-os-table-page-next") as HTMLButtonElement).disabled,
    );

    await view.rerender(makePaged(5));
    check(
      "last page disables next and clamps the range label",
      (byTestId("button-os-table-page-next") as HTMLButtonElement).disabled &&
        byTestId("os-table-pagination-range")?.textContent === "201–230 of 230",
      byTestId("os-table-pagination-range")?.textContent ?? "missing",
    );

    await view.unmount();
  }

  // ── 6. Empty state ──
  {
    const view = await mount(
      <OsTable columns={columns} rows={[]} rowKey={rowKey} />,
    );
    check(
      "default empty state renders",
      doc.body.textContent?.includes("No rows to show.") === true,
    );
    await view.rerender(
      <OsTable
        columns={columns}
        rows={[]}
        rowKey={rowKey}
        emptyState={<span data-testid="custom-empty">Nothing yet</span>}
      />,
    );
    check("custom empty state renders", byTestId("custom-empty") != null);
    await view.unmount();
  }

  // ── 7. Sticky affordance toggles ──
  {
    const view = await mount(
      <OsTable
        columns={columns}
        rows={smallRows}
        rowKey={rowKey}
        maxHeight={240}
        stickyFirstColumn={false}
        showDensityToggle={false}
      />,
    );
    const table = $("table")!;
    check(
      "explicit maxHeight bounds the viewport and engages the sticky header",
      byTestId("os-table-viewport")!.classList.contains(
        "os-table-wrap--bounded",
      ) && table.classList.contains("os-table--sticky-header"),
    );
    check(
      "stickyFirstColumn=false drops the pinned-column class",
      !table.classList.contains("os-sticky-col"),
    );
    check(
      "showDensityToggle=false hides the toggle",
      byTestId("button-os-table-density-compact") == null,
    );
    await view.unmount();
  }
  // ── 8. Expansion-row seam (Task #4484) ──
  {
    const makeExpandable = (expandedId: string | null, rows: FixtureRow[]) => (
      <OsTable
        columns={columns}
        rows={rows}
        rowKey={rowKey}
        renderExpandedRow={(r) =>
          r.id === expandedId ? (
            <div data-testid="expanded-editor">editing {r.name}</div>
          ) : null
        }
      />
    );
    const view = await mount(makeExpandable(null, smallRows));
    check(
      "no expansion rows render while every renderExpandedRow returns null",
      $$('tr[data-testid^="os-table-expanded-row-"]').length === 0,
    );
    await view.rerender(makeExpandable("r2", smallRows));
    const expandedTr = byTestId("os-table-expanded-row-r2");
    check(
      "non-null renderExpandedRow renders a full-width companion row",
      expandedTr != null &&
        expandedTr.querySelector("td")?.getAttribute("colspan") ===
          String(columns.length) &&
        byTestId("expanded-editor")?.textContent === "editing charlie",
    );
    check(
      "expansion row sits directly below its data row",
      expandedTr?.previousElementSibling ===
        byTestId("os-table-row-r2"),
    );
    // Variable-height expansion rows cannot be windowed: the seam must
    // pin the table to the fully-rendered path even above the threshold.
    await view.rerender(
      makeExpandable("b3", makeRows(OS_TABLE_VIRTUALIZE_ABOVE + 50)),
    );
    check(
      "renderExpandedRow disables virtualization above the threshold",
      renderedRowTestIds().length === OS_TABLE_VIRTUALIZE_ABOVE + 50 &&
        !$("table")!.classList.contains("os-table--fixed-rows") &&
        byTestId("os-table-expanded-row-b3") != null,
      `rows=${renderedRowTestIds().length}`,
    );
    await view.unmount();
  }
} catch (error) {
  failures += 1;
  console.error("FAIL — unhandled test error", error);
}

console.log(
  failures === 0
    ? "OsTable primitive test: all checks passed"
    : `OsTable primitive test: ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
