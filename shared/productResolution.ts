// Task #1028: "other" is a canonical product representing the
// `marketing.otherLeads` bucket (Social Media / Direct Calls / Referrals).
// It participates in the Active-Products invariant alongside gbp / google_ads
// / lsa / webinar — clients that don't own it must not have those rows
// contribute to any aggregate or render. It is intentionally NOT included in
// CLIENT_PRODUCT_OPTIONS (the UI selector); inclusion is via auto-detection
// or explicit data import.
export const CANONICAL_PRODUCTS = ["gbp", "google_ads", "lsa", "webinar", "other"] as const;
export type CanonicalProduct = typeof CANONICAL_PRODUCTS[number];

export function normalizeProductName(raw: string): CanonicalProduct | null {
  const lower = raw.trim().toLowerCase();
  switch (lower) {
    case "gbp":
    case "google business profile":
    case "google business profile (gbp)":
    case "google_business_profile":
    case "google-business-profile":
      return "gbp";
    case "google_ads":
    case "google ads":
      return "google_ads";
    case "lsa":
    case "local service ads":
    case "local services ads":
      return "lsa";
    case "webinar":
    case "webinars":
      return "webinar";
    case "other":
    case "other leads":
    case "other_leads":
    case "otherleads":
      return "other";
    case "google_ads_lsa":
      return null;
    default:
      return null;
  }
}

export type ClientProductOption = {
  value: CanonicalProduct;
  label: string;
  description: string;
};

export const CLIENT_PRODUCT_OPTIONS: ClientProductOption[] = [
  { value: "gbp", label: "Google Business Profile (GBP)", description: "Local search optimization" },
  { value: "google_ads", label: "Google Ads", description: "Paid search advertising" },
  { value: "lsa", label: "Local Service Ads (LSA)", description: "Local Services Ads" },
  { value: "webinar", label: "Webinars", description: "Lead generation webinars" },
];

/**
 * Strict validation variant of normalizeProductList for use at the API
 * boundary. Returns the canonical normalized list AND any input values that
 * could not be resolved to a known canonical product. Empty/whitespace-only
 * strings are ignored (not treated as invalid) so callers can decide whether
 * an empty list is acceptable. Non-string entries are reported as invalid.
 */
export function validateProductList(raw: unknown): {
  normalized: CanonicalProduct[];
  invalid: string[];
} {
  const normalized: CanonicalProduct[] = [];
  const invalid: string[] = [];
  if (!Array.isArray(raw)) {
    return { normalized, invalid };
  }
  for (const p of raw) {
    if (typeof p !== "string") {
      invalid.push(String(p));
      continue;
    }
    const trimmed = p.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (lower === "google_ads_lsa") {
      if (!normalized.includes("google_ads")) normalized.push("google_ads");
      if (!normalized.includes("lsa")) normalized.push("lsa");
      continue;
    }
    const norm = normalizeProductName(lower);
    if (norm) {
      if (!normalized.includes(norm)) normalized.push(norm);
    } else {
      invalid.push(p);
    }
  }
  return { normalized, invalid };
}

export function normalizeProductList(raw: string[]): CanonicalProduct[] {
  const result: CanonicalProduct[] = [];
  for (const p of raw) {
    if (typeof p !== 'string' || !p) continue;
    const lower = p.trim().toLowerCase();
    if (lower === "google_ads_lsa") {
      if (!result.includes("google_ads")) result.push("google_ads");
      if (!result.includes("lsa")) result.push("lsa");
    } else {
      const norm = normalizeProductName(lower);
      if (norm && !result.includes(norm)) result.push(norm);
    }
  }
  return result;
}

export function resolveEffectiveProducts(
  commandPanel: { productTypes?: string[] | null } | null | undefined,
  clientProducts: string[] | null | undefined,
): CanonicalProduct[] {
  if (commandPanel != null) {
    const cpProducts = commandPanel.productTypes;
    if (!Array.isArray(cpProducts) || cpProducts.length === 0) {
      return [];
    }
    return normalizeProductList(cpProducts);
  }

  if (Array.isArray(clientProducts) && clientProducts.length > 0) {
    return normalizeProductList(clientProducts);
  }

  return [];
}

export function hasProduct(products: CanonicalProduct[], product: CanonicalProduct): boolean {
  return products.includes(product);
}

export const PRODUCT_DISPLAY_NAMES: Record<CanonicalProduct, string> = {
  gbp: "GBP",
  google_ads: "Google Ads",
  lsa: "LSA",
  webinar: "Webinar",
  other: "Other",
};

export function getProductLabel(product: string): string {
  return PRODUCT_DISPLAY_NAMES[product as CanonicalProduct] || product;
}
