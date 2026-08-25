/**
 * OsTable — the shared virtualized table primitive (Task #4343; design
 * audit §8.3 P0-1).
 *
 * Turns the `.os-table-wrap` / `.os-sticky-col` CSS convention
 * (client/src/index.css — white surface, pinned identity column, overflow
 * shadows) into a real component with a sticky header row, built-in row
 * virtualization, sortable headers, a density toggle, and an optional
 * server-pagination footer. Styling is tokens-only per the design
 * constitution; corners are square.
 *
 * ## Client mode (default)
 * Pass the FULL row array. Above `virtualizeAbove` rows (default 100 =
 * OS_TABLE_VIRTUALIZE_ABOVE) the body windows itself via
 * `@tanstack/react-virtual`: the viewport is bounded by `maxHeight`
 * (default 70vh), rows take a fixed per-density height, and only the
 * visible window plus overscan exists in the DOM. Sortable columns sort
 * locally through `sortValue` (falling back to `row[key]`), cycling
 * asc → desc → cleared.
 *
 * ```tsx
 * <OsTable
 *   columns={[
 *     { key: "name", header: "Client", sortable: true, cell: (r) => r.name },
 *     { key: "mrr", header: "MRR", sortable: true, align: "right",
 *       sortValue: (r) => r.mrr, cell: (r) => fmtUsd(r.mrr) },
 *   ]}
 *   rows={clients}
 *   rowKey={(r) => r.id}
 * />
 * ```
 *
 * ## Server mode (controlled sort and/or pagination)
 * Provide `sort` + `onSortChange` to own ordering — the component then
 * NEVER reorders rows; refetch with the new sort. Provide `pagination`
 * to render the footer pager; `rows` is just the current page.
 *
 * ```tsx
 * <OsTable
 *   columns={columns}
 *   rows={pageData.items}
 *   rowKey={(r) => r.id}
 *   sort={sort}
 *   onSortChange={setSort}
 *   pagination={{ page, pageSize, total: pageData.total,
 *     onPageChange: setPage, onPageSizeChange: setPageSize }}
 * />
 * ```
 *
 * ## Behavior notes for adopters
 * - Virtualized rows are FIXED-HEIGHT (44px comfortable / 32px compact,
 *   OS_TABLE_ROW_HEIGHTS) and single-line; wide content scrolls
 *   horizontally inside the wrap per the convention. Variable-height rows
 *   are a deliberate non-feature until an adopter needs them (task 4343
 *   impact review).
 * - Sticky header + sticky first column default on. The sticky header
 *   engages when the viewport is bounded (virtualized or `maxHeight`
 *   given); page-level stickiness is out of scope because the app nav
 *   overlays `top: 0`. Disable `stickyFirstColumn` when the first column
 *   is not an identity (e.g. a checkbox).
 * - Tinted rows must supply a solid `--os-sticky-col-bg` via
 *   `rowClassName` (existing convention, documented in index.css). Compose
 *   it over the table surface token so it flips with the theme, e.g.
 *   `[--os-sticky-col-bg:color-mix(in_srgb,hsl(var(--primary))_5%,hsl(var(--os-table-surface)))]`
 *   — a raw light hex (or literal `white`) turns the pinned column
 *   near-white in dark mode while the row text stays light.
 * - `renderExpandedRow` (Task #4484): when provided, each row may render a
 *   full-width companion row below itself (return non-null to expand —
 *   inline editors, detail panes). Expansion rows are variable-height, so
 *   providing the seam DISABLES virtualization; it is meant for short
 *   admin lists (the RIS Setup checks list), not long data tables.
 * - Test ids: `os-table` (override via `data-testid`), `os-table-viewport`,
 *   `os-table-sort-<key>`, `os-table-row-<rowKey>`,
 *   `os-table-expanded-row-<rowKey>`,
 *   `os-table-spacer-top|bottom`, `button-os-table-density-<density>`,
 *   `button-os-table-page-prev|next`, `select-os-table-page-size`,
 *   `os-table-pagination-range`.
 */
import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Rows2,
  Rows4,
} from "lucide-react";

import { cn } from "@/lib/utils";

export type OsTableDensity = "comfortable" | "compact";

export type OsTableAlign = "left" | "right" | "center";

export interface OsTableSort {
  /** `OsTableColumn.key` of the sorted column. */
  key: string;
  direction: "asc" | "desc";
}

export interface OsTableColumn<Row> {
  /** Stable identifier — React key, sort-callback key, testid suffix. */
  key: string;
  header: React.ReactNode;
  cell: (row: Row, rowIndex: number) => React.ReactNode;
  /**
   * Renders the sort affordance. Client mode sorts locally via
   * `sortValue` (or `row[key]`); controlled mode only reports through
   * `onSortChange`.
   */
  sortable?: boolean;
  sortValue?: (row: Row) => unknown;
  align?: OsTableAlign;
  /**
   * Fixed width (px number or CSS length). Recommended for virtualized
   * tables so column widths cannot shift as the row window moves.
   */
  width?: number | string;
  headerClassName?: string;
  cellClassName?: string;
}

export interface OsTablePagination {
  /** 1-based current page. */
  page: number;
  pageSize: number;
  /** Total row count across all pages — drives the range label and bounds. */
  total: number;
  onPageChange: (page: number) => void;
  /** When present, renders the rows-per-page select. */
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];
}

export interface OsTableProps<Row> {
  columns: Array<OsTableColumn<Row>>;
  rows: Row[];
  rowKey: (row: Row, index: number) => string | number;
  /** Controlled sort (server mode). `null` = explicitly unsorted. */
  sort?: OsTableSort | null;
  /** Initial sort for uncontrolled (client) mode. */
  defaultSort?: OsTableSort | null;
  onSortChange?: (sort: OsTableSort | null) => void;
  /** Server-pagination mode: renders the footer pager. */
  pagination?: OsTablePagination;
  /** Controlled density. */
  density?: OsTableDensity;
  defaultDensity?: OsTableDensity;
  onDensityChange?: (density: OsTableDensity) => void;
  /** The built-in density toggle; on unless the host page supplies its own. */
  showDensityToggle?: boolean;
  /** Row count above which the body virtualizes. */
  virtualizeAbove?: number;
  overscan?: number;
  /**
   * Viewport bound. Applied automatically when virtualized (default
   * 70vh); providing it explicitly bounds the viewport at any row count.
   */
  maxHeight?: number | string;
  stickyHeader?: boolean;
  stickyFirstColumn?: boolean;
  emptyState?: React.ReactNode;
  /** Rendered left of the density toggle, above the table. */
  toolbar?: React.ReactNode;
  onRowClick?: (row: Row, index: number) => void;
  rowClassName?: (row: Row, index: number) => string | undefined;
  /**
   * Expansion-row seam (Task #4484): return non-null to render a
   * full-width row (colSpan across every column) directly below the data
   * row — e.g. an inline edit form. Because expansion rows are
   * variable-height, providing this prop disables virtualization; use it
   * only on short lists.
   */
  renderExpandedRow?: (row: Row, index: number) => React.ReactNode;
  className?: string;
  "data-testid"?: string;
}

/** Row count above which OsTable virtualizes by default. */
export const OS_TABLE_VIRTUALIZE_ABOVE = 100;

/** Fixed virtualized row heights per density (px). */
export const OS_TABLE_ROW_HEIGHTS: Record<OsTableDensity, number> = {
  comfortable: 44,
  compact: 32,
};

const DEFAULT_MAX_HEIGHT = "70vh";
const DEFAULT_PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

const ALIGN_TEXT: Record<OsTableAlign, string> = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
};

const ALIGN_JUSTIFY: Record<OsTableAlign, string> = {
  left: "justify-start",
  right: "justify-end",
  center: "justify-center",
};

/**
 * Mixed-type comparator: numbers/dates/booleans natively, everything else
 * as natural-order strings. Nullish values sort after real values in
 * ascending order (and before them descending — pure inversion).
 */
function compareSortValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") {
    return a === b ? 0 : a ? -1 : 1;
  }
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function OsTable<Row>(props: OsTableProps<Row>) {
  const {
    columns,
    rows,
    rowKey,
    sort: sortProp,
    defaultSort = null,
    onSortChange,
    pagination,
    density: densityProp,
    defaultDensity = "comfortable",
    onDensityChange,
    showDensityToggle = true,
    virtualizeAbove = OS_TABLE_VIRTUALIZE_ABOVE,
    overscan = 12,
    maxHeight,
    stickyHeader = true,
    stickyFirstColumn = true,
    emptyState,
    toolbar,
    onRowClick,
    rowClassName,
    renderExpandedRow,
    className,
    "data-testid": testId,
  } = props;

  const isSortControlled = sortProp !== undefined;
  const [internalSort, setInternalSort] = React.useState<OsTableSort | null>(
    defaultSort,
  );
  const activeSort = isSortControlled ? sortProp : internalSort;

  const isDensityControlled = densityProp !== undefined;
  const [internalDensity, setInternalDensity] =
    React.useState<OsTableDensity>(defaultDensity);
  const density = isDensityControlled ? densityProp : internalDensity;
  const rowHeight = OS_TABLE_ROW_HEIGHTS[density];

  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  const [scrollState, setScrollState] = React.useState({
    x: false,
    y: false,
    moreRight: false,
  });

  const updateScrollState = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const x = el.scrollLeft > 0;
    const y = el.scrollTop > 0;
    const moreRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setScrollState((prev) =>
      prev.x === x && prev.y === y && prev.moreRight === moreRight
        ? prev
        : { x, y, moreRight },
    );
  }, []);

  // Re-sync the edge-shadow state after every commit: content changes
  // (rows, density, column set) move the scroll extents without firing a
  // scroll event. The prev-equality guard keeps this loop-free.
  React.useEffect(() => {
    updateScrollState();
  });

  const clientSorted = !isSortControlled && activeSort != null;
  const sortedRows = React.useMemo(() => {
    if (!clientSorted || activeSort == null) return rows;
    const column = columns.find((c) => c.key === activeSort.key);
    if (!column) return rows;
    const getValue =
      column.sortValue ??
      ((row: Row) => (row as Record<string, unknown>)[column.key]);
    const factor = activeSort.direction === "asc" ? 1 : -1;
    return [...rows].sort(
      (a, b) => factor * compareSortValues(getValue(a), getValue(b)),
    );
  }, [rows, columns, activeSort, clientSorted]);

  // Expansion rows are variable-height, which the fixed-height windowing
  // math cannot express — the seam therefore opts the table out of
  // virtualization entirely (documented above; short-list use only).
  const expandable = renderExpandedRow != null;
  const virtualized = !expandable && sortedRows.length > virtualizeAbove;
  const bounded = virtualized || maxHeight != null;

  const rowVirtualizer = useVirtualizer({
    count: virtualized ? sortedRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
    getItemKey: (index: number) => rowKey(sortedRows[index], index),
  });

  // estimateSize changed (density toggle) — re-measure so spacer math
  // uses the new fixed row height.
  const lastDensityRef = React.useRef(density);
  React.useEffect(() => {
    if (lastDensityRef.current !== density) {
      lastDensityRef.current = density;
      rowVirtualizer.measure();
    }
  }, [density, rowVirtualizer]);

  const virtualItems = virtualized ? rowVirtualizer.getVirtualItems() : [];
  const totalSize = virtualized ? rowVirtualizer.getTotalSize() : 0;
  const padTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const padBottom =
    virtualItems.length > 0
      ? Math.max(0, totalSize - virtualItems[virtualItems.length - 1].end)
      : 0;

  const handleSortClick = (column: OsTableColumn<Row>) => {
    const current =
      activeSort && activeSort.key === column.key ? activeSort : null;
    const next: OsTableSort | null =
      current == null
        ? { key: column.key, direction: "asc" }
        : current.direction === "asc"
          ? { key: column.key, direction: "desc" }
          : null;
    if (!isSortControlled) setInternalSort(next);
    onSortChange?.(next);
  };

  const handleDensityChange = (next: OsTableDensity) => {
    if (!isDensityControlled) setInternalDensity(next);
    onDensityChange?.(next);
  };

  const headerCellPad =
    density === "compact" ? "h-8 px-2" : "h-10 px-3";
  const bodyCellPad =
    density === "compact" ? "px-2 py-1" : "px-3 py-2.5";

  const renderRow = (row: Row, index: number) => {
    const key = rowKey(row, index);
    const dataRow = (
      <tr
        key={key}
        data-testid={`os-table-row-${key}`}
        data-index={index}
        aria-rowindex={virtualized ? index + 2 : undefined}
        style={virtualized ? { height: rowHeight } : undefined}
        className={cn(
          "border-b border-border",
          onRowClick && "cursor-pointer",
          rowClassName?.(row, index),
        )}
        onClick={onRowClick ? () => onRowClick(row, index) : undefined}
      >
        {columns.map((column) => (
          <td
            key={column.key}
            className={cn(
              bodyCellPad,
              "align-middle text-body text-foreground",
              ALIGN_TEXT[column.align ?? "left"],
              column.cellClassName,
            )}
          >
            {column.cell(row, index)}
          </td>
        ))}
      </tr>
    );
    if (!expandable) return dataRow;
    const expanded = renderExpandedRow?.(row, index);
    return (
      <React.Fragment key={key}>
        {dataRow}
        {expanded != null && (
          <tr
            data-testid={`os-table-expanded-row-${key}`}
            className="border-b border-border"
          >
            <td colSpan={columns.length} className={bodyCellPad}>
              {expanded}
            </td>
          </tr>
        )}
      </React.Fragment>
    );
  };

  const renderSpacer = (edge: "top" | "bottom", size: number) => (
    <tr
      key={`os-table-spacer-${edge}`}
      data-os-spacer="true"
      aria-hidden="true"
      data-testid={`os-table-spacer-${edge}`}
    >
      <td colSpan={columns.length} style={{ height: size }} />
    </tr>
  );

  const pageCount = pagination
    ? Math.max(1, Math.ceil(pagination.total / Math.max(1, pagination.pageSize)))
    : 1;
  const rangeStart = pagination
    ? pagination.total === 0
      ? 0
      : (pagination.page - 1) * pagination.pageSize + 1
    : 0;
  const rangeEnd = pagination
    ? Math.min(pagination.page * pagination.pageSize, pagination.total)
    : 0;

  const pagerButton =
    "flex h-7 w-7 items-center justify-center text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <div
      data-testid={testId ?? "os-table"}
      data-density={density}
      data-scrolled-x={scrollState.x ? "true" : "false"}
      data-scrolled-y={scrollState.y ? "true" : "false"}
      data-can-scroll-right={scrollState.moreRight ? "true" : "false"}
      className={cn("os-table-shell", className)}
    >
      {(toolbar != null || showDensityToggle) && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">{toolbar}</div>
          {showDensityToggle && (
            <div
              role="group"
              aria-label="Table density"
              className="inline-flex shrink-0 border border-border bg-background"
            >
              <button
                type="button"
                data-testid="button-os-table-density-comfortable"
                aria-pressed={density === "comfortable"}
                title="Comfortable rows"
                onClick={() => handleDensityChange("comfortable")}
                className={cn(
                  "flex h-7 w-7 items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  density === "comfortable"
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-muted/60",
                )}
              >
                <Rows2 className="h-3.5 w-3.5" />
                <span className="sr-only">Comfortable density</span>
              </button>
              <button
                type="button"
                data-testid="button-os-table-density-compact"
                aria-pressed={density === "compact"}
                title="Compact rows"
                onClick={() => handleDensityChange("compact")}
                className={cn(
                  "flex h-7 w-7 items-center justify-center border-l border-border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  density === "compact"
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-muted/60",
                )}
              >
                <Rows4 className="h-3.5 w-3.5" />
                <span className="sr-only">Compact density</span>
              </button>
            </div>
          )}
        </div>
      )}

      <div className="os-table-frame">
        <div
          ref={scrollRef}
          data-testid="os-table-viewport"
          className={cn("os-table-wrap", bounded && "os-table-wrap--bounded")}
          style={bounded ? { maxHeight: maxHeight ?? DEFAULT_MAX_HEIGHT } : undefined}
          onScroll={updateScrollState}
        >
          <table
            data-density={density}
            aria-rowcount={virtualized ? sortedRows.length + 1 : undefined}
            className={cn(
              "w-full caption-bottom text-body os-table--hover",
              stickyFirstColumn && "os-sticky-col",
              stickyHeader && bounded && "os-table--sticky-header",
              virtualized && "os-table--fixed-rows",
            )}
          >
            <thead>
              <tr aria-rowindex={virtualized ? 1 : undefined}>
                {columns.map((column) => {
                  const align = column.align ?? "left";
                  const columnSort =
                    activeSort != null && activeSort.key === column.key
                      ? activeSort
                      : null;
                  const ariaSort = columnSort
                    ? columnSort.direction === "asc"
                      ? "ascending"
                      : "descending"
                    : undefined;
                  const headerLabel =
                    typeof column.header === "string"
                      ? column.header
                      : column.key;
                  return (
                    <th
                      key={column.key}
                      aria-sort={ariaSort}
                      style={
                        column.width != null
                          ? { width: column.width, minWidth: column.width }
                          : undefined
                      }
                      className={cn(
                        headerCellPad,
                        "whitespace-nowrap align-middle text-caption font-semibold uppercase tracking-wider text-muted-foreground",
                        ALIGN_TEXT[align],
                        column.headerClassName,
                      )}
                    >
                      {column.sortable ? (
                        <button
                          type="button"
                          data-testid={`os-table-sort-${column.key}`}
                          aria-label={`Sort by ${headerLabel}`}
                          onClick={() => handleSortClick(column)}
                          className={cn(
                            "flex w-full items-center gap-1 uppercase tracking-wider focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                            ALIGN_JUSTIFY[align],
                            columnSort
                              ? "text-foreground"
                              : "hover:text-foreground",
                          )}
                        >
                          <span>{column.header}</span>
                          {columnSort ? (
                            columnSort.direction === "asc" ? (
                              <ArrowUp className="h-3 w-3 shrink-0" />
                            ) : (
                              <ArrowDown className="h-3 w-3 shrink-0" />
                            )
                          ) : (
                            <ArrowUpDown className="h-3 w-3 shrink-0 opacity-50" />
                          )}
                        </button>
                      ) : (
                        column.header
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sortedRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={columns.length}
                    className="px-4 py-10 text-center text-body text-muted-foreground"
                  >
                    {emptyState ?? "No rows to show."}
                  </td>
                </tr>
              ) : virtualized ? (
                <>
                  {padTop > 0 && renderSpacer("top", padTop)}
                  {virtualItems.map((item: { index: number }) =>
                    renderRow(sortedRows[item.index], item.index),
                  )}
                  {padBottom > 0 && renderSpacer("bottom", padBottom)}
                </>
              ) : (
                sortedRows.map((row, index) => renderRow(row, index))
              )}
            </tbody>
          </table>
        </div>
        <div aria-hidden="true" className="os-table-edge-right" />
      </div>

      {pagination && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span
            data-testid="os-table-pagination-range"
            className="text-caption text-muted-foreground"
          >
            {rangeStart}–{rangeEnd} of {pagination.total}
          </span>
          <div className="flex items-center gap-3">
            {pagination.onPageSizeChange && (
              <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
                Rows per page
                <select
                  data-testid="select-os-table-page-size"
                  value={pagination.pageSize}
                  onChange={(event) =>
                    pagination.onPageSizeChange?.(Number(event.target.value))
                  }
                  className="h-7 border border-border bg-background px-1 text-body text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {(pagination.pageSizeOptions ?? DEFAULT_PAGE_SIZE_OPTIONS).map(
                    (option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ),
                  )}
                </select>
              </label>
            )}
            <span className="text-caption text-muted-foreground">
              Page {pagination.page} of {pageCount}
            </span>
            <div className="inline-flex border border-border bg-background">
              <button
                type="button"
                data-testid="button-os-table-page-prev"
                aria-label="Previous page"
                disabled={pagination.page <= 1}
                onClick={() => pagination.onPageChange(pagination.page - 1)}
                className={pagerButton}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                data-testid="button-os-table-page-next"
                aria-label="Next page"
                disabled={pagination.page >= pageCount}
                onClick={() => pagination.onPageChange(pagination.page + 1)}
                className={cn(pagerButton, "border-l border-border")}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
