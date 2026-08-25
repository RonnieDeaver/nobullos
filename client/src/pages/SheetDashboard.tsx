/**
 * SheetDashboard — read-only published dashboard view.
 *
 * Renders a snapshot from a published workbook as a lightweight cell grid
 * without loading the full Univer editor bundle. Shows only the tabs
 * selected by the owner at publish time (all tabs if none specified).
 *
 * Route: /sheets/dashboard/:id
 */

import { useState, useMemo } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ChevronLeft,
  RefreshCw,
  Loader2,
  AlertTriangle,
  LayoutDashboard,
} from "lucide-react";

// ── Univer snapshot types (lightweight — only fields we consume) ──────────────

interface UniverCellData {
  v?: string | number | boolean | null;
  s?: string;
  t?: number;
}

interface UniverStyle {
  bl?: number;
  it?: number;
  ul?: { s?: number };
  st?: { s?: number };
  bg?: { rgb?: string };
  cl?: { rgb?: string };
  fs?: number;
  ht?: number;
  vt?: number;
  wb?: number;
}

interface UniverSheetData {
  id?: string;
  name?: string;
  tabColor?: string;
  cellData?: Record<string, Record<string, UniverCellData>>;
  columnData?: Record<string, { w?: number; hd?: number }>;
  rowData?: Record<string, { h?: number; hd?: number }>;
  mergeData?: Array<{ startRow: number; startColumn: number; endRow: number; endColumn: number }>;
  rowCount?: number;
  columnCount?: number;
  hidden?: number;
}

interface UniverSnapshot {
  sheets?: Record<string, UniverSheetData>;
  styles?: Record<string, UniverStyle>;
  sheetOrder?: string[];
}

// ── Cell renderer helpers ─────────────────────────────────────────────────────

function formatCellValue(cell: UniverCellData | undefined): string {
  if (!cell) return "";
  const v = cell.v;
  if (v === null || v === undefined) return "";
  return String(v);
}

function buildCellStyle(style: UniverStyle | undefined): React.CSSProperties {
  if (!style) return {};
  const css: React.CSSProperties = {};
  if (style.bl) css.fontWeight = "bold";
  if (style.it) css.fontStyle = "italic";
  if (style.ul?.s) css.textDecoration = "underline";
  if (style.bg?.rgb) css.backgroundColor = style.bg.rgb;
  if (style.cl?.rgb) css.color = style.cl.rgb;
  if (style.fs) css.fontSize = `${style.fs}px`;
  if (style.ht === 2) css.textAlign = "center";
  else if (style.ht === 3) css.textAlign = "right";
  else css.textAlign = "left";
  if (style.wb) css.whiteSpace = "normal";
  return css;
}

const DEFAULT_COL_WIDTH = 100;
const DEFAULT_ROW_HEIGHT = 25;
const MAX_RENDER_ROWS = 500;
const MAX_RENDER_COLS = 52;

// ── Sheet tab renderer ────────────────────────────────────────────────────────

interface SheetGridProps {
  sheet: UniverSheetData;
  styles: Record<string, UniverStyle>;
}

function SheetGrid({ sheet, styles }: SheetGridProps) {
  const cellData = sheet.cellData ?? {};
  const columnData = sheet.columnData ?? {};
  const rowData = sheet.rowData ?? {};
  const rowCount = Math.min(sheet.rowCount ?? 50, MAX_RENDER_ROWS);
  const colCount = Math.min(sheet.columnCount ?? 26, MAX_RENDER_COLS);

  // Build merge map: key = "row,col" → { rowSpan, colSpan }
  const mergeMap = new Map<string, { rowSpan: number; colSpan: number }>();
  const mergedCells = new Set<string>();
  for (const m of sheet.mergeData ?? []) {
    const key = `${m.startRow},${m.startColumn}`;
    mergeMap.set(key, {
      rowSpan: m.endRow - m.startRow + 1,
      colSpan: m.endColumn - m.startColumn + 1,
    });
    for (let r = m.startRow; r <= m.endRow; r++) {
      for (let c = m.startColumn; c <= m.endColumn; c++) {
        if (r !== m.startRow || c !== m.startColumn) {
          mergedCells.add(`${r},${c}`);
        }
      }
    }
  }

  // Determine the last non-empty row and col to trim whitespace.
  let lastRow = 0;
  let lastCol = 0;
  for (const rStr of Object.keys(cellData)) {
    const r = parseInt(rStr, 10);
    if (isNaN(r)) continue;
    for (const cStr of Object.keys(cellData[rStr] ?? {})) {
      const c = parseInt(cStr, 10);
      if (isNaN(c)) continue;
      const cell = cellData[rStr][cStr];
      if (cell?.v !== undefined && cell.v !== null && cell.v !== "") {
        if (r > lastRow) lastRow = r;
        if (c > lastCol) lastCol = c;
      }
    }
  }
  // Also account for mergeData
  for (const m of sheet.mergeData ?? []) {
    if (m.endRow > lastRow) lastRow = m.endRow;
    if (m.endColumn > lastCol) lastCol = m.endColumn;
  }

  const displayRows = Math.min(lastRow + 1, rowCount);
  const displayCols = Math.min(lastCol + 1, colCount);

  if (displayRows === 0 || displayCols === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-gray-400 italic">
        This tab is empty.
      </div>
    );
  }

  return (
    <div className="overflow-auto">
      <table
        className="border-collapse text-xs"
        style={{ tableLayout: "fixed" }}
        data-testid="sheet-grid-table"
      >
        <colgroup>
          {Array.from({ length: displayCols }, (_, c) => {
            const colDef = columnData[String(c)];
            const w = colDef?.hd ? 0 : (colDef?.w ?? DEFAULT_COL_WIDTH);
            return <col key={c} style={{ width: w || DEFAULT_COL_WIDTH }} />;
          })}
        </colgroup>
        <tbody>
          {Array.from({ length: displayRows }, (_, r) => {
            const rowDef = rowData[String(r)];
            const h = rowDef?.h ?? DEFAULT_ROW_HEIGHT;
            return (
              <tr key={r} style={{ height: h }}>
                {Array.from({ length: displayCols }, (_, c) => {
                  const cellKey = `${r},${c}`;
                  if (mergedCells.has(cellKey)) return null;
                  const merge = mergeMap.get(cellKey);
                  const cell = cellData[String(r)]?.[String(c)];
                  const styleId = cell?.s;
                  const style = styleId ? styles[styleId] : undefined;
                  const cellStyle = buildCellStyle(style);
                  const value = formatCellValue(cell);

                  return (
                    <td
                      key={c}
                      rowSpan={merge?.rowSpan}
                      colSpan={merge?.colSpan}
                      style={{
                        ...cellStyle,
                        borderRight: "1px solid #e5e7eb",
                        borderBottom: "1px solid #e5e7eb",
                        padding: "2px 4px",
                        overflow: "hidden",
                        whiteSpace: cellStyle.whiteSpace ?? "nowrap",
                        textOverflow: "ellipsis",
                        verticalAlign: "middle",
                        maxWidth: 0,
                      }}
                      title={value}
                      data-testid={`cell-${r}-${c}`}
                    >
                      {value}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Dashboard types ───────────────────────────────────────────────────────────

interface DashboardTab {
  sheetId: string;
  sheetName: string;
}

interface DashboardInfo {
  workbookId: string;
  title: string;
  publishedBy: string;
  publishedAt: string;
  tabs: DashboardTab[];
  audienceUserIds: string[];
  audienceRoles: string[];
  updatedAt: string;
}

interface DashboardResponse {
  dashboard: DashboardInfo;
  snapshot: unknown;
  workbookName: string;
  updatedAt: string;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SheetDashboard() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const query = useQuery<DashboardResponse>({
    queryKey: [`/api/sheets/dashboards/${id}`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/sheets/dashboards/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      return data;
    },
    staleTime: 30_000,
    retry: 1,
  });

  // Parse the Univer snapshot once.
  const parsed = useMemo<UniverSnapshot | null>(() => {
    if (!query.data?.snapshot) return null;
    try {
      const raw = query.data.snapshot;
      return (typeof raw === "string" ? JSON.parse(raw) : raw) as UniverSnapshot;
    } catch {
      return null;
    }
  }, [query.data?.snapshot]);

  // Determine which sheet tabs to show.
  const visibleTabs = useMemo(() => {
    if (!parsed?.sheets) return [];
    const dashboard = query.data?.dashboard;
    const sheetOrder = parsed.sheetOrder ?? Object.keys(parsed.sheets);

    if (dashboard?.tabs && dashboard.tabs.length > 0) {
      // Only show selected tabs, in the configured order.
      return dashboard.tabs
        .map((t) => ({ id: t.sheetId, name: t.sheetName, sheet: parsed.sheets![t.sheetId] }))
        .filter((t) => t.sheet && !t.sheet.hidden);
    }

    // Show all non-hidden tabs in snapshot order.
    return sheetOrder
      .map((sid) => ({
        id: sid,
        name: parsed.sheets![sid]?.name ?? sid,
        sheet: parsed.sheets![sid],
      }))
      .filter((t) => t.sheet && !t.sheet.hidden);
  }, [parsed, query.data?.dashboard]);

  // Resolve active tab (default to first).
  const resolvedActiveId =
    activeTabId && visibleTabs.some((t) => t.id === activeTabId)
      ? activeTabId
      : (visibleTabs[0]?.id ?? null);

  const activeTabData = visibleTabs.find((t) => t.id === resolvedActiveId);

  function formatTs(iso: string | undefined) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  }

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-background flex flex-col" data-testid="sheet-dashboard-root">
      {/* Header */}
      <header className="border-b bg-card px-4 py-3">
        <div className="container mx-auto max-w-7xl flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => setLocation("/sheets")}
              data-testid="btn-back-to-library"
              aria-label="Back to Sheets library"
            >
              <ChevronLeft className="h-5 w-5" />
            </Button>

            <LayoutDashboard className="h-5 w-5 shrink-0 text-primary" />

            {query.isLoading ? (
              <div className="h-5 w-40 animate-pulse rounded bg-muted" />
            ) : (
              <div className="min-w-0">
                <h1
                  className="text-base font-semibold text-foreground truncate"
                  data-testid="text-dashboard-title"
                >
                  {query.data?.dashboard.title ?? "Dashboard"}
                </h1>
                <p className="text-xs text-muted-foreground truncate">
                  {query.data?.workbookName ?? ""}
                </p>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {query.data && (
              <span
                className="text-xs text-muted-foreground hidden sm:block"
                data-testid="text-last-updated"
              >
                Updated {formatTs(query.data.updatedAt)}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
              data-testid="btn-refresh-dashboard"
            >
              {query.isFetching ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-4 w-4" />
              )}
              Refresh
            </Button>
          </div>
        </div>
      </header>

      {/* Tab bar */}
      {!query.isLoading && !query.isError && visibleTabs.length > 1 && (
        <div
          className="border-b bg-card px-4"
          data-testid="dashboard-tab-bar"
        >
          <div className="container mx-auto max-w-7xl flex gap-0 overflow-x-auto">
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                  tab.id === resolvedActiveId
                    ? "border-primary-ink text-primary-ink"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setActiveTabId(tab.id)}
                data-testid={`btn-tab-${tab.id}`}
                aria-selected={tab.id === resolvedActiveId}
              >
                {tab.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Body */}
      <main className="flex-1 container mx-auto max-w-7xl px-4 py-6">
        {query.isLoading ? (
          <div
            className="flex items-center justify-center py-32"
            data-testid="dashboard-loading"
          >
            <Loader2 className="h-8 w-8 animate-spin text-primary/60" />
          </div>
        ) : query.isError ? (
          <div
            className="rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-10 text-center"
            data-testid="dashboard-error"
          >
            <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-destructive/60" />
            <p className="text-sm font-medium text-destructive">
              {(query.error as any)?.message?.includes("Forbidden")
                ? "You don't have access to this dashboard."
                : "Could not load the dashboard. It may have been unpublished."}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => setLocation("/sheets")}
            >
              Back to Sheets
            </Button>
          </div>
        ) : visibleTabs.length === 0 ? (
          <div
            className="rounded-lg border bg-card px-6 py-10 text-center"
            data-testid="dashboard-empty"
          >
            <LayoutDashboard className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              This dashboard has no tabs to display.
            </p>
          </div>
        ) : (
          <div
            className="rounded-lg border bg-card overflow-hidden"
            data-testid="dashboard-grid-container"
          >
            {/* Single tab label (when only one tab) */}
            {visibleTabs.length === 1 && (
              <div className="border-b px-4 py-2 flex items-center gap-2">
                <Badge variant="secondary" className="text-xs">
                  {visibleTabs[0].name}
                </Badge>
              </div>
            )}

            {activeTabData?.sheet && (
              <SheetGrid
                sheet={activeTabData.sheet}
                styles={parsed?.styles ?? {}}
              />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
