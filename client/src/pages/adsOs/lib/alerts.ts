/**
 * Alert display semantics shared by the GAds + LSA dashboards (spec §9).
 *
 * "Needs attention" counts ROWS, not alerts: a row qualifies when it carries
 * ≥1 critical or high alert. Medium-only rows are excluded — they still show a
 * grey ⚠ badge, they just never inflate the tile or the "Needs attention only"
 * filter. Keeping the predicate here (one module, both dashboards) is what
 * stops the tile, the filter, and the row marker from drifting apart.
 */
import type {
  Alert,
  ClientAlertItem,
  ClientAlertSummary,
  Product,
} from "./types";

export type ClientAlertSummaryLike = Partial<ClientAlertSummary> | null | undefined;

export function needsAttention(r: { alerts: Alert[] }): boolean {
  return r.alerts.some((a) => a.severity === "critical" || a.severity === "high");
}

/** The "Need attention" tile value: number of qualifying rows (accounts). */
export function countNeedsAttention(rows: Array<{ alerts: Alert[] }>): number {
  return rows.reduce((n, r) => n + (needsAttention(r) ? 1 : 0), 0);
}

function count(summary: ClientAlertSummaryLike, severity: Alert["severity"]): number {
  const value = summary?.[severity];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/**
 * Client-level equivalent of needsAttention. Current payloads carry explicit
 * severity counts; pre-rollup cached payloads may carry only items or the
 * legacy boolean, so those are used only when the count fields are absent.
 */
export function clientNeedsAttention(
  summary: ClientAlertSummaryLike,
): boolean {
  if (!summary) return false;
  const hasCounts =
    typeof summary.critical === "number" || typeof summary.high === "number";
  if (hasCounts) return count(summary, "critical") + count(summary, "high") > 0;
  if (Array.isArray(summary.items)) {
    return summary.items.some(
      (item) => item.severity === "critical" || item.severity === "high",
    );
  }
  return summary.needs_attention === true;
}

/** Main's portfolio tile counts qualifying CLIENT rows, never alert items. */
export function countClientsNeedingAttention(
  rows: ReadonlyArray<{ alerts?: ClientAlertSummaryLike }>,
): number {
  return rows.reduce((total, row) => total + (clientNeedsAttention(row.alerts) ? 1 : 0), 0);
}

export function clientAlertCounts(summary: ClientAlertSummaryLike): {
  critical: number;
  high: number;
  medium: number;
  total: number;
  attention: number;
} {
  const critical = count(summary, "critical");
  const high = count(summary, "high");
  const medium = count(summary, "medium");
  const countedTotal = critical + high + medium;
  const itemTotal = Array.isArray(summary?.items) ? summary.items.length : 0;
  const declaredTotal =
    typeof summary?.total === "number" && Number.isFinite(summary.total) && summary.total > 0
      ? Math.floor(summary.total)
      : 0;
  return {
    critical,
    high,
    medium,
    total: Math.max(countedTotal, itemTotal, declaredTotal),
    attention: critical + high,
  };
}

const CLIENT_SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
};

/** Stable worst-first ordering for every client-level dropdown. */
export function sortedClientAlertItems(
  summary: ClientAlertSummaryLike,
): ClientAlertItem[] {
  if (!Array.isArray(summary?.items)) return [];
  return summary.items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        (CLIENT_SEVERITY_RANK[a.item.severity ?? ""] ?? 3) -
          (CLIENT_SEVERITY_RANK[b.item.severity ?? ""] ?? 3) ||
        a.index - b.index,
    )
    .map(({ item }) => item);
}

const PRODUCT_LABEL: Record<Product, string> = { gads: "Google Ads", lsa: "LSA" };

/**
 * Zero-enrollment notice for a run-alerts summary (§14): if ANY product the
 * Refresh covered resolved 0 enrolled accounts, name it — a partial combined
 * recompute (LSA enrollment empty while GAds ran fine) must not pass for
 * fresh. Returns null when every covered product resolved ≥1 account.
 *
 * `products` must be exactly the products that dashboard's Refresh recomputes:
 * per-product run summaries report the OTHER (un-requested) product as 0, so
 * an unscoped check would false-alarm on every GAds/LSA Refresh.
 */
export function zeroAccountNotice(
  r: { gads_accounts: number; lsa_accounts: number },
  products: Product[]
): string | null {
  const zero = products.filter(
    (p) => (p === "gads" ? r.gads_accounts : r.lsa_accounts) === 0
  );
  if (zero.length === 0) return null;
  const names = zero.map((p) => PRODUCT_LABEL[p]).join(" and ");
  return `Alerts recompute resolved 0 enrolled ${names} accounts — their ⚠ badges and Need-attention counts may be stale. Check the ClickUp directory / enrollment.`;
}
