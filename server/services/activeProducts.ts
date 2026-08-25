/**
 * Task #1028: Canonical resolver for the per-report Active-Products set.
 *
 * Every report-import / report-render / report-cleanup path that needs to know
 * which products a client owns must go through this helper instead of reaching
 * for `commandPanel.productTypes` or `client.products` directly. That keeps the
 * resolution rule (CP wins, fallback to clients.products) in one place AND
 * surfaces metadata so callers can:
 *
 *   - log a structured audit (`source`, `unknownValues`),
 *   - refuse to mutate when resolution is ambiguous (`source === "none"`),
 *   - emit dashboards/alerts when imports drop unrecognized product strings.
 */
import { storage } from "../storage";
import {
  resolveEffectiveProducts,
  normalizeProductName,
  type CanonicalProduct,
} from "../../shared/productResolution";

export type ActiveProductsSource = "command_panel" | "client_products" | "none";

export interface ActiveProductsResolution {
  /** Canonical, deduplicated, lowercase. Empty when nothing could be resolved. */
  products: CanonicalProduct[];
  /** Where the products came from. `"none"` means we have no signal at all. */
  source: ActiveProductsSource;
  /** Raw values from the chosen source that didn't normalize. Useful for alerts. */
  unknownValues: string[];
  clientId: string;
  reportId?: string;
}

function collectUnknown(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !v.trim()) continue;
    if (normalizeProductName(v) == null) out.push(v);
  }
  return out;
}

export async function getActiveProductsForClient(
  clientId: string,
): Promise<ActiveProductsResolution> {
  const [client, cp] = await Promise.all([
    storage.getClient(clientId).catch(() => null),
    storage.getCommandPanel(clientId).catch(() => null),
  ]);

  const cpRaw = cp?.productTypes ?? null;
  const clientRaw = client?.products ?? null;

  // Task #1028 spec (lines 147-151): "commandPanel.productTypes wins. Fall
  // back to clients.products only when no Command Panel product list
  // exists." Per the spec, the *existence* of the CP row makes it
  // authoritative — an empty productTypes on an existing CP row means
  // "this client owns no products" and must NOT be silently overridden by
  // a stale clients.products mirror. Operators with truly mis-configured
  // CP rows should fix the CP row (or run cleanup with --force).
  if (cp != null) {
    return {
      products: resolveEffectiveProducts(cp, clientRaw),
      source: "command_panel",
      unknownValues: collectUnknown(cpRaw),
      clientId,
    };
  }
  if (Array.isArray(clientRaw) && clientRaw.length > 0) {
    return {
      products: resolveEffectiveProducts(null, clientRaw),
      source: "client_products",
      unknownValues: collectUnknown(clientRaw),
      clientId,
    };
  }
  return { products: [], source: "none", unknownValues: [], clientId };
}

export async function getActiveProductsForReport(
  reportId: string,
): Promise<ActiveProductsResolution | null> {
  const report = await storage.getReport(reportId).catch(() => null);
  if (!report) return null;
  const r = await getActiveProductsForClient(report.clientId);
  return { ...r, reportId };
}

export function logResolution(prefix: string, r: ActiveProductsResolution) {
  // eslint-disable-next-line no-console
  console.log(
    `[ActiveProducts] ${prefix} client=${r.clientId} report=${r.reportId ?? "-"} ` +
    `source=${r.source} products=[${r.products.join(",") || "(none)"}]` +
    (r.unknownValues.length ? ` unknown=${JSON.stringify(r.unknownValues)}` : ""),
  );
}
