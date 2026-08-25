import type {
  ClientAlertAccountFreshness,
  ClientAlertItem,
  ClientAlertSummary,
  KnownAlertSeverity,
  Product,
} from "./types";

export const CLIENT_ALERT_DETAIL_MAX = 200;
export const CLIENT_ALERT_ITEMS_MAX = 100;

const TITLE_MAX = 160;
const SEVERITY_RANK: Record<KnownAlertSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
};

export interface ClientAlertContribution {
  product: Product;
  customer_id: string;
  account: string;
  document?: Record<string, any> | null;
}

function normalizedSeverity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const severity = value.trim().toLowerCase();
  return severity || null;
}

function normalizedTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizedText(value: unknown, fallback: string, max: number): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return (text || fallback).slice(0, max);
}

function normalizedDeepLink(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Normalize and roll up stored account-alert documents.
 *
 * Input order is the stable account order for equal-severity items. Known
 * severities count even when the item cap is reached; unknown severities are
 * listed after known severities but never counted.
 */
export function normalizeClientAlertSummary(
  contributions: ReadonlyArray<ClientAlertContribution>,
): ClientAlertSummary {
  const counts: Record<KnownAlertSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
  };
  const freshness: ClientAlertAccountFreshness[] = [];
  const indexedItems: Array<{ item: ClientAlertItem; index: number }> = [];
  let index = 0;

  for (const contribution of contributions) {
    const alertsAt = normalizedTimestamp(contribution.document?.generated_at);
    freshness.push({
      product: contribution.product,
      customer_id: contribution.customer_id,
      account: contribution.account,
      alerts_at: alertsAt,
    });

    const alerts = Array.isArray(contribution.document?.alerts)
      ? contribution.document!.alerts
      : [];
    for (const raw of alerts) {
      const alert = raw && typeof raw === "object" ? raw as Record<string, any> : {};
      const severity = normalizedSeverity(alert.severity);
      if (severity && severity in counts) counts[severity as KnownAlertSeverity] += 1;
      indexedItems.push({
        index: index++,
        item: {
          severity,
          title: normalizedText(alert.title || alert.code, "Alert", TITLE_MAX),
          detail: normalizedText(alert.detail, "", CLIENT_ALERT_DETAIL_MAX),
          product: contribution.product,
          customer_id: contribution.customer_id,
          account: contribution.account,
          deep_link: normalizedDeepLink(alert.deep_link),
          alerts_at: alertsAt,
        },
      });
    }
  }

  indexedItems.sort((a, b) => {
    const aRank = a.item.severity && a.item.severity in SEVERITY_RANK
      ? SEVERITY_RANK[a.item.severity as KnownAlertSeverity]
      : 3;
    const bRank = b.item.severity && b.item.severity in SEVERITY_RANK
      ? SEVERITY_RANK[b.item.severity as KnownAlertSeverity]
      : 3;
    return aRank - bRank || a.index - b.index;
  });

  const total = counts.critical + counts.high + counts.medium;
  return {
    ...counts,
    total,
    needs_attention: counts.critical > 0 || counts.high > 0,
    items: indexedItems.slice(0, CLIENT_ALERT_ITEMS_MAX).map(({ item }) => item),
    items_truncated: Math.max(0, indexedItems.length - CLIENT_ALERT_ITEMS_MAX),
    accounts: freshness,
  };
}