/**
 * Task #5096 — Book-commerce package catalog.
 *
 * Defines the two purchasable packages for the LFRE launch:
 *   - digital    (Digital Edition)     SKU LFRE-DIGITAL-2026   $4.99 USD   enabled by default
 *   - complete   (Complete Collection) SKU LFRE-COMPLETE-2026  $19.99 USD  disabled by default;
 *                selection additionally requires BOTH an explicit `enabled` gate AND an
 *                explicit `approved` gate (fail-closed), AND a configured U.S. shipping
 *                policy (BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS — fail-closed when absent).
 *
 * Design invariants:
 *   - Package codes are mutually exclusive: exactly one code may be selected at a time.
 *   - Gate evaluation is injectable for unit tests (see `evaluateCompleteGate`).
 *   - The production default gate reads process.env; all env reads are lazy
 *     (evaluated at call time, not module load time).
 *   - No network I/O; no DB access; pure functions only.
 *   - No generic update for financial fields — amounts live only in this
 *     catalog constant; storage code reads them here and never writes them
 *     independently.
 *
 * Prices must match the DB CHECK constraints in shared/models/bookCommerce.ts:
 *   digital  → unit_price_cents =  499  ($4.99)
 *   complete → unit_price_cents = 1999  ($19.99)
 *
 * Shipping policy (Task #5097 correction):
 *   digital  → shippingCents = 0 (no physical goods)
 *   complete → shippingCents is SERVER-OWNED configuration, not a catalog
 *              constant. BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS must be set
 *              to a bounded non-negative integer (cents). Absent or invalid →
 *              fail-closed (complete is not selectable). 0 means "U.S. shipping
 *              included"; positive means disclosed shipping cost. Non-U.S.
 *              addresses are always rejected regardless of this value.
 */

// ─── Package codes ────────────────────────────────────────────────────────────

export const BOOK_COMMERCE_PACKAGE_CODES = ["digital", "complete"] as const;
export type BookCommercePackageCode = (typeof BOOK_COMMERCE_PACKAGE_CODES)[number];

// ─── Catalog entry shape ──────────────────────────────────────────────────────

export interface BookCommercePackage {
  /** Stable short identifier, used as the selection key. */
  code: BookCommercePackageCode;
  /** Human-readable display name. */
  name: string;
  /** Globally unique SKU for fulfilment and accounting. */
  sku: string;
  /**
   * Price in USD cents — must match the DB CHECK constraint in
   * book_order_items.catalog_price_check.
   * Financial source of truth — never stored separately in the DB;
   * the order-item row is the immutable stamped snapshot.
   */
  amountCents: number;
  /** ISO-4217 currency code. */
  currency: "USD";
  /**
   * Whether the package is visible / selectable at all without additional
   * gate evaluation.  `false` packages always require gate approval before
   * checkout is permitted.
   */
  enabledByDefault: boolean;
  /**
   * Entitlement codes this package grants at fulfilment.  Must match the
   * closed set in shared/models/bookCommerce.ts (bookEntitlementCodes) and the
   * DB CHECK on book_entitlements.entitlement_code.
   *   digital  → digital_book
   *   complete → digital_book, audiobook, print_fulfillment
   */
  entitlementCodes: ReadonlyArray<BookEntitlementCode>;
}

/**
 * A `BookCommercePackage` with shipping resolved from server-owned
 * configuration.  Only present in the public catalog response; the base
 * `BookCommercePackage` type intentionally omits shipping because it is not
 * a static catalog constant.
 */
export interface BookCommercePackageWithShipping extends BookCommercePackage {
  /**
   * Domestic (U.S.) shipping cost in cents.
   *   digital  → always 0 (no physical goods)
   *   complete → read from BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS;
   *              only present when that setting is validly configured
   */
  shippingCents: number;
}

/**
 * Closed set of entitlement codes.  Mirrors bookEntitlementCodes in
 * shared/models/bookCommerce.ts — kept local to avoid a runtime import from
 * the catalog into the schema (catalog stays dependency-light / pure).
 */
export const BOOK_ENTITLEMENT_CODES = [
  "digital_book",
  "audiobook",
  "print_fulfillment",
] as const;
export type BookEntitlementCode = (typeof BOOK_ENTITLEMENT_CODES)[number];

// ─── Catalog definition ───────────────────────────────────────────────────────

/**
 * Authoritative package catalog.  Immutable at runtime.
 *
 * Prices are validated at the DB layer via CHECK constraints; the values here
 * are the canonical source used to populate those checks.
 */
export const BOOK_COMMERCE_PACKAGES: ReadonlyArray<Readonly<BookCommercePackage>> =
  Object.freeze([
    Object.freeze({
      code: "digital" as const,
      name: "Digital Edition",
      sku: "LFRE-DIGITAL-2026",
      amountCents: 499,
      currency: "USD" as const,
      enabledByDefault: true,
      entitlementCodes: Object.freeze(["digital_book"] as const),
    }),
    Object.freeze({
      code: "complete" as const,
      name: "Complete Collection",
      sku: "LFRE-COMPLETE-2026",
      amountCents: 1999,
      currency: "USD" as const,
      enabledByDefault: false,
      entitlementCodes: Object.freeze([
        "digital_book",
        "audiobook",
        "print_fulfillment",
      ] as const),
    }),
  ]);

// ─── Complete Collection — U.S. shipping policy ───────────────────────────────

/**
 * Maximum plausible U.S. domestic shipping cost (cents).  Used as an upper
 * bound on the env-var value to reject obviously invalid integers before they
 * propagate downstream.  $500 = 50000 cents — generous enough for any
 * foreseeable physical-book shipping cost; tighten if business rules narrow.
 */
const COMPLETE_US_SHIPPING_CENTS_MAX = 50_000;

/**
 * Test-seam override for the U.S. shipping cents value.  `undefined` means
 * "use the env var"; `null` means "explicitly simulate misconfigured/absent".
 * Set via `__setCompleteUsShippingCentsForTest`.  Production code never calls
 * the setter.
 */
let _testShippingCentsOverride: number | null | undefined = undefined;

/**
 * Test seam — inject a specific shipping cents value (or `null` to simulate
 * absent/invalid) without mutating `process.env`.  Call with `undefined` to
 * restore production env-var behaviour.
 */
export function __setCompleteUsShippingCentsForTest(
  value: number | null | undefined,
): void {
  _testShippingCentsOverride = value;
}

/**
 * Resolve the U.S. domestic shipping cost for the Complete Collection from
 * server-owned configuration.
 *
 * Production path: reads `BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS` from
 * `process.env` at call time (never at module load — fail-closed if absent).
 * Test path: returns the value injected via `__setCompleteUsShippingCentsForTest`.
 *
 * Returns:
 *   - A non-negative integer (cents) when validly configured
 *     (0 = included, positive = disclosed cost)
 *   - `null` when absent, blank, non-integer, negative, or above the
 *     sanity ceiling → caller must treat this as fail-closed (not selectable)
 *
 * This is configuration, not browser input — the value is never read from
 * the request body.
 */
export function resolveCompleteUsShippingCents(): number | null {
  // Test seam takes priority.
  if (_testShippingCentsOverride !== undefined) {
    return _testShippingCentsOverride;
  }

  const raw = process.env.BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS?.trim();
  if (!raw) return null;

  // Must be a non-negative integer string, no decimals, no leading sign.
  if (!/^\d+$/.test(raw)) return null;

  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > COMPLETE_US_SHIPPING_CENTS_MAX) {
    return null;
  }

  return parsed;
}

// ─── Catalog accessors ────────────────────────────────────────────────────────

/** Lookup a package by code.  Returns `undefined` for unknown codes. */
export function getPackageByCode(
  code: string,
): BookCommercePackage | undefined {
  return BOOK_COMMERCE_PACKAGES.find((p) => p.code === code);
}

/** Lookup a package by code, throwing for unknown codes. */
export function requirePackageByCode(code: string): BookCommercePackage {
  const pkg = getPackageByCode(code);
  if (!pkg) {
    throw new UnknownPackageCodeError(code);
  }
  return pkg;
}

/** Returns the full package list.  Callers may filter but must not mutate. */
export function listPackages(): ReadonlyArray<BookCommercePackage> {
  return BOOK_COMMERCE_PACKAGES;
}

// ─── Mutual-exclusion guard ───────────────────────────────────────────────────

/**
 * Assert that exactly one package code is selected.
 *
 * Throws `MutualExclusionError` if zero or more than one codes are provided,
 * and `UnknownPackageCodeError` if the single code is not in the catalog.
 *
 * Usage:
 *   assertExclusivePackageCode(["digital"])           // → "digital"
 *   assertExclusivePackageCode(["digital","complete"]) // throws MutualExclusionError
 *   assertExclusivePackageCode([])                     // throws MutualExclusionError
 */
export function assertExclusivePackageCode(
  codes: readonly string[],
): BookCommercePackageCode {
  if (codes.length !== 1) {
    throw new MutualExclusionError(codes);
  }
  const code = codes[0];
  const pkg = getPackageByCode(code);
  if (!pkg) {
    throw new UnknownPackageCodeError(code);
  }
  return pkg.code;
}

// ─── Gate evaluation — Complete Collection ────────────────────────────────────

/**
 * Gate context injected into `evaluateCompleteGate`.
 *
 * All three conditions must pass for the gate to open.  The default production
 * context (from `defaultCompleteGateContext()`) reads environment variables;
 * all conditions default to fail-closed when absent.
 */
export interface CompletePackageGateContext {
  /**
   * The package is explicitly switched on (e.g. via admin toggle or env flag).
   * Maps to BOOK_COMMERCE_COMPLETE_ENABLED=true in production.
   */
  enabled: boolean;
  /**
   * An out-of-band approval step has been satisfied (e.g. manual sign-off,
   * legal clearance). Maps to BOOK_COMMERCE_COMPLETE_APPROVED=true in production.
   */
  approved: boolean;
  /**
   * Server-owned U.S. domestic shipping cost in cents, resolved from
   * BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS.
   *
   * `null` means absent or invalid → gate fails closed.
   * 0     means U.S. shipping included (a valid, configured policy).
   * >0    means disclosed shipping cost (also valid).
   *
   * Never sourced from browser input.
   */
  usShippingCents: number | null;
}

export interface CompletePackageGateResult {
  allowed: boolean;
  /** Human-readable reason; populated when `allowed` is false. */
  reason?: string;
}

export interface PackageLaunchGateContext {
  digitalReady: boolean;
  completeReady: boolean;
}

/**
 * Pure, injectable gate evaluator for the Complete Collection package.
 *
 * All three conditions — `enabled`, `approved`, and `usShippingCents !== null`
 * — must pass for the gate to open.  Any failing condition fails closed.
 *
 * Inject a custom `ctx` in tests:
 *   evaluateCompleteGate({ enabled: true, approved: true, usShippingCents: 0 })
 *     → { allowed: true }
 *   evaluateCompleteGate({ enabled: true, approved: true, usShippingCents: null })
 *     → { allowed: false, reason: "…shipping policy not configured…" }
 *   evaluateCompleteGate({ enabled: true, approved: false, usShippingCents: 0 })
 *     → { allowed: false, reason: "…not received approval" }
 *   evaluateCompleteGate({ enabled: false, approved: true, usShippingCents: 0 })
 *     → { allowed: false, reason: "…not enabled" }
 */
export function evaluateCompleteGate(
  ctx: CompletePackageGateContext,
): CompletePackageGateResult {
  if (!ctx.enabled) {
    return { allowed: false, reason: "Complete Collection is not enabled" };
  }
  if (!ctx.approved) {
    return { allowed: false, reason: "Complete Collection has not received approval" };
  }
  if (ctx.usShippingCents === null) {
    return {
      allowed: false,
      reason: "Complete Collection U.S. shipping policy is not configured",
    };
  }
  return { allowed: true };
}

/**
 * Environment-backed default gate context for production use.
 *
 * Reads env vars at CALL TIME (never at module load) so test environments
 * that configure env vars after import still see the right values.
 *
 * BOOK_COMMERCE_COMPLETE_ENABLED=true              — enables the complete package
 * BOOK_COMMERCE_COMPLETE_APPROVED=true             — grants the approval gate
 * BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS=<int>   — U.S. shipping cents (≥0);
 *                                                    absent/invalid → null → fail-closed
 *
 * Any boolean env var other than exactly "true" → `false` (fail-closed).
 */
export function defaultCompleteGateContext(): CompletePackageGateContext {
  return {
    enabled: process.env.BOOK_COMMERCE_COMPLETE_ENABLED === "true",
    approved: process.env.BOOK_COMMERCE_COMPLETE_APPROVED === "true",
    usShippingCents: resolveCompleteUsShippingCents(),
  };
}

/**
 * Convenience: evaluate the Complete gate using the environment-backed defaults.
 *
 * Tests should call `evaluateCompleteGate(ctx)` directly with an injected `ctx`
 * rather than relying on this function, to avoid process.env coupling.
 */
export function evaluateCompleteGateWithDefaults(): CompletePackageGateResult {
  return evaluateCompleteGate(defaultCompleteGateContext());
}

// ─── Package selectability check ─────────────────────────────────────────────

/**
 * Determine whether a given package code can be selected right now.
 *
 * - every package requires an explicit server-produced launch-readiness context;
 * - `complete` additionally requires `enabled`, `approved`, AND
 *   `usShippingCents !== null`.
 *
 * The `completeGateCtx` parameter is injectable for tests; pass `undefined`
 * to use the env-backed defaults (production path), which includes the
 * shipping-cents resolution.
 */
export function isPackageSelectable(
  code: BookCommercePackageCode,
  completeGateCtx?: CompletePackageGateContext,
  launchGateCtx?: PackageLaunchGateContext,
): { selectable: boolean; reason?: string } {
  const pkg = requirePackageByCode(code);

  if (!launchGateCtx) {
    return {
      selectable: false,
      reason: `${pkg.name} launch readiness has not been established`,
    };
  }
  if (code === "digital" && !launchGateCtx.digitalReady) {
    return { selectable: false, reason: "Digital Edition launch readiness is closed" };
  }
  if (code === "complete" && !launchGateCtx.completeReady) {
    return {
      selectable: false,
      reason: "Complete Collection launch readiness is closed",
    };
  }

  if (!pkg.enabledByDefault) {
    // All non-default packages go through the Complete gate logic.
    const ctx = completeGateCtx ?? defaultCompleteGateContext();
    const gate = evaluateCompleteGate(ctx);
    if (!gate.allowed) {
      return { selectable: false, reason: gate.reason };
    }
  }

  return { selectable: true };
}

/**
 * Return only the packages that are currently selectable, each annotated with
 * the resolved `shippingCents` for client display.
 *
 * - `digital`:  shippingCents = 0 when launch readiness passes
 * - `complete`: shippingCents = configured cents value; omitted from result
 *               when the shipping policy (or any other gate) is not configured
 *
 * The `completeGateCtx` parameter is injectable for tests; pass `undefined`
 * for the production env-backed path.
 *
 * This is the authoritative source for the public catalog endpoint — Stripe
 * IDs, internal codes beyond `code`/`sku`, and gated packages are never
 * surfaced.
 */
export function getEnabledPackagesForCatalog(
  completeGateCtx?: CompletePackageGateContext,
  launchGateCtx?: PackageLaunchGateContext,
): BookCommercePackageWithShipping[] {
  const result: BookCommercePackageWithShipping[] = [];

  for (const pkg of BOOK_COMMERCE_PACKAGES) {
    if (pkg.code === "digital") {
      const sel = isPackageSelectable(pkg.code, completeGateCtx, launchGateCtx);
      if (sel.selectable) {
        result.push({ ...pkg, shippingCents: 0 });
      }
      continue;
    }

    if (pkg.code === "complete") {
      // Resolve the gate context once so we can read usShippingCents from it.
      const ctx = completeGateCtx ?? defaultCompleteGateContext();
      const gate = evaluateCompleteGate(ctx);
      const sel = isPackageSelectable(pkg.code, ctx, launchGateCtx);
      if (!gate.allowed || !sel.selectable) continue; // fail-closed: omit
      // usShippingCents is guaranteed non-null here because evaluateCompleteGate
      // already rejected null above.
      result.push({ ...pkg, shippingCents: ctx.usShippingCents as number });
      continue;
    }

    // Future packages: apply the default gate logic (enabledByDefault flag).
    const sel = isPackageSelectable(pkg.code, completeGateCtx, launchGateCtx);
    if (sel.selectable) {
      // No shipping policy for unknown future packages yet — default 0.
      result.push({ ...pkg, shippingCents: 0 });
    }
  }

  return result;
}

// ─── Entitlement compatibility ────────────────────────────────────────────────

/**
 * True when `entitlementCode` is grantable for the given package.
 *   digital  → digital_book only
 *   complete → digital_book, audiobook, print_fulfillment
 */
export function isEntitlementCompatible(
  packageCode: BookCommercePackageCode,
  entitlementCode: string,
): boolean {
  const pkg = requirePackageByCode(packageCode);
  return (pkg.entitlementCodes as readonly string[]).includes(entitlementCode);
}

/**
 * Assert that `entitlementCode` is grantable for the package, throwing
 * `IncompatibleEntitlementError` otherwise.  Returns the narrowed code.
 */
export function assertEntitlementCompatible(
  packageCode: BookCommercePackageCode,
  entitlementCode: string,
): BookEntitlementCode {
  if (!isEntitlementCompatible(packageCode, entitlementCode)) {
    throw new IncompatibleEntitlementError(packageCode, entitlementCode);
  }
  return entitlementCode as BookEntitlementCode;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class UnknownPackageCodeError extends Error {
  constructor(public readonly code: string) {
    super(`Unknown book-commerce package code: "${code}"`);
    this.name = "UnknownPackageCodeError";
  }
}

export class MutualExclusionError extends Error {
  constructor(public readonly codes: readonly string[]) {
    super(
      codes.length === 0
        ? "At least one package code must be selected"
        : `Exactly one package code must be selected; got: ${codes.join(", ")}`,
    );
    this.name = "MutualExclusionError";
  }
}

export class PackageNotSelectableError extends Error {
  constructor(
    public readonly code: BookCommercePackageCode,
    public readonly reason: string,
  ) {
    super(`Package "${code}" is not selectable: ${reason}`);
    this.name = "PackageNotSelectableError";
  }
}

export class IncompatibleEntitlementError extends Error {
  constructor(
    public readonly packageCode: BookCommercePackageCode,
    public readonly entitlementCode: string,
  ) {
    super(
      `Entitlement "${entitlementCode}" is not grantable for package "${packageCode}"`,
    );
    this.name = "IncompatibleEntitlementError";
  }
}
