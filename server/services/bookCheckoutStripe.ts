/**
 * Task #5097 — Book-checkout Stripe adapter + high-level checkout operations.
 *
 * Provides:
 *   - A narrow, injectable low-level Stripe adapter (BookCheckoutStripeAdapter)
 *     for Tax Calculation create + PaymentIntent create/update/retrieve.
 *   - High-level functions the routes call:
 *       calculateAuthoritativeBookQuote  — catalog-authoritative quote + Stripe Tax
 *       createOrRefreshBookPaymentIntent — create-or-refresh a PaymentIntent
 *
 * Security / correctness invariants:
 *   - IMPLEMENTATION SAFETY: the production adapter permits ONLY sk_test_ keys
 *     in EVERY NODE_ENV. Task #5097 explicitly forbids live charges during
 *     implementation, so a resolved sk_live_ (or any non-sk_test_) key is
 *     REJECTED. An injected fake adapter bypasses key resolution entirely.
 *   - No direct Stripe constructor here — the pinned client is built via
 *     stripeClient.createPinnedStripeClient (single version-pinned call site).
 *   - No request body, webhook secret, or full address is logged.
 *   - Metadata is server-owned only: book_checkout_session_id, package_code,
 *     quote_version. Additional PI params can never overwrite metadata/amount/
 *     currency.
 *   - All vendor calls are made OUTSIDE any DB transaction.
 *   - Stable idempotency:
 *       Tax create: derived from checkout id + canonical hash of server params.
 *       PI create:  derived from checkout id.
 *       PI update:  derived from PI id + quoteVersion.
 *
 * Test seam:
 *   - Inject a fake adapter via __setBookCheckoutStripeAdapterForTest().
 *   - The adapter interface is exported and fully mockable without egress.
 */

import { createHash } from "node:crypto";
import { createPinnedStripeClient, getStripeSecretKey } from "../stripeClient";
import { auditOutboundCall } from "./externalCallAudit";
import {
  requirePackageByCode,
  resolveCompleteUsShippingCents,
  PackageNotSelectableError,
  type BookCommercePackageCode,
} from "./bookCommerceCatalog";
import { requireBookPackageLaunchReady } from "./bookLaunchReadiness";

// ─── Key validation ────────────────────────────────────────────────────────────

/**
 * Guard: the production adapter must use ONLY sk_test_ keys, in EVERY NODE_ENV.
 *
 * Task #5097 explicitly forbids live charges during implementation. A resolved
 * key that is sk_live_ (or any other non-test format) is REJECTED so a
 * misconfigured production secret can never issue a real charge through this
 * adapter. Tests that need to bypass key resolution inject a fake adapter via
 * __setBookCheckoutStripeAdapterForTest — that path never reaches this guard.
 */
function assertTestKeyOnly(key: string): void {
  if (!key.startsWith("sk_test_")) {
    throw new Error(
      "[BookCheckoutStripe] Only sk_test_ keys are permitted for book-checkout " +
        "charge/tax operations. Live charges are forbidden during implementation " +
        "(Task #5097). Configure a Stripe test secret key.",
    );
  }
}

// ─── Adapter interface (injectable test seam) ─────────────────────────────────

/** Normalized Tax Calculation result (PCI-safe subset). */
export interface StripeTaxCalcResult {
  /** Stripe Tax Calculation ID (e.g. taxcalc_XXXXXXXX). */
  calculationId: string;
  /** Tax amount in cents from Stripe. */
  taxAmountCents: number;
  /** Currency (lowercase ISO 4217). */
  currency: string;
}

/**
 * Normalized PaymentIntent result (PCI-safe subset).
 * No raw card data, no raw address, no secret fields beyond client_secret
 * (returned for frontend confirmation, never logged).
 */
export interface StripePaymentIntentResult {
  /** Stripe PaymentIntent ID (e.g. pi_XXXXXXXX). */
  paymentIntentId: string;
  /** Client secret for frontend confirmation (not logged). */
  clientSecret: string | null;
  /** PI status as returned by Stripe. */
  status: string;
  /** Amount in cents. */
  amountCents: number;
  /** Currency (lowercase ISO 4217). */
  currency: string;
}

/**
 * Minimal typed shape for the Stripe Tax Calculation create params.
 * Full params are passed through to the SDK; this typing keeps the adapter
 * contract testable without importing Stripe types.
 */
export interface TaxCalculationCreateParams {
  currency: string;
  /** Line items for tax calculation. */
  line_items: Array<{
    amount: number;
    reference: string;
    quantity?: number;
    tax_behavior?: string;
  }>;
  /** Customer address details (never logged). */
  customer_details?: Record<string, unknown>;
  /** Shipping cost details (never logged). */
  shipping_cost?: Record<string, unknown>;
  /** Expand fields. */
  expand?: string[];
}

/**
 * Narrow adapter interface — injectable for zero-egress signed-event tests.
 * All methods are async and return PCI-safe normalized results. Each accepts a
 * caller-computed stable idempotency key so idempotency policy lives with the
 * high-level operations, not the transport.
 */
export interface BookCheckoutStripeAdapter {
  /** Create a Stripe Tax Calculation. Must run OUTSIDE any DB transaction. */
  createTaxCalculation(
    idempotencyKey: string,
    params: TaxCalculationCreateParams,
  ): Promise<StripeTaxCalcResult>;

  /** Create a PaymentIntent. Must run OUTSIDE any DB transaction. */
  createPaymentIntent(
    idempotencyKey: string,
    params: Record<string, unknown>,
  ): Promise<StripePaymentIntentResult>;

  /** Update an existing PaymentIntent. Must run OUTSIDE any DB transaction. */
  updatePaymentIntent(
    idempotencyKey: string,
    paymentIntentId: string,
    params: Record<string, unknown>,
  ): Promise<StripePaymentIntentResult>;

  /** Retrieve a PaymentIntent by ID. Must run OUTSIDE any DB transaction. */
  retrievePaymentIntent(
    paymentIntentId: string,
  ): Promise<StripePaymentIntentResult>;
}

// ─── Idempotency keys ─────────────────────────────────────────────────────────

/** Canonical, order-independent hash of an arbitrary JSON-serialisable value. */
function canonicalHash(value: unknown): string {
  const canon = (v: any): any => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(canon);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
    return out;
  };
  return createHash("sha256")
    .update(JSON.stringify(canon(value)))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Stable PaymentIntent-create idempotency key from a checkout session ID.
 * Deterministic across process restarts so the same session never
 * double-creates a PaymentIntent.
 */
export function derivePaymentIntentIdempotencyKey(checkoutSessionId: string): string {
  const hash = createHash("sha256")
    .update(`book-checkout-pi:${checkoutSessionId}`)
    .digest("hex")
    .slice(0, 32);
  return `book-checkout-pi-${hash}`;
}

/**
 * Stable Tax-Calculation idempotency key, derived from the checkout session ID
 * plus a canonical hash of the server-computed tax params. Re-quoting with the
 * same inputs is idempotent; changing amount/address/currency yields a new key.
 */
export function deriveTaxCalculationIdempotencyKey(
  checkoutSessionId: string,
  serverParams: unknown,
): string {
  return `book-checkout-tax-${checkoutSessionId}-${canonicalHash(serverParams)}`;
}

/**
 * Stable PaymentIntent-update idempotency key, keyed by the PI ID and the
 * quoteVersion so each quote revision produces exactly one update attempt.
 */
export function derivePaymentIntentUpdateIdempotencyKey(
  paymentIntentId: string,
  quoteVersion: number,
): string {
  return `book-checkout-pi-upd-${paymentIntentId}-v${quoteVersion}`;
}

// ─── Production adapter ───────────────────────────────────────────────────────

async function getPinnedStripeForChargeOps(): Promise<any> {
  const key = await getStripeSecretKey();
  if (!key) {
    throw new Error(
      "[BookCheckoutStripe] No Stripe secret key configured. " +
        "Set STRIPE_SECRET_KEY or configure it via system settings.",
    );
  }
  assertTestKeyOnly(key);
  return createPinnedStripeClient(key);
}

/**
 * Production Stripe adapter — uses the shared pinned client accessor and wraps
 * every call in auditOutboundCall. Never logs address/customer/body content.
 */
class ProductionBookCheckoutStripeAdapter implements BookCheckoutStripeAdapter {
  async createTaxCalculation(
    idempotencyKey: string,
    params: TaxCalculationCreateParams,
  ): Promise<StripeTaxCalcResult> {
    const stripe = await getPinnedStripeForChargeOps();

    // Never log: customer_details (address/email), shipping_cost.
    const safeLogParams = {
      currency: params.currency,
      line_item_count: params.line_items?.length ?? 0,
      line_item_refs: params.line_items?.map((li) => li.reference),
    };

    return auditOutboundCall(
      {
        integration: "stripe",
        endpoint: "/v1/tax/calculations",
        method: "POST",
        dedupeParams: { op: "tax.calculations.create", idempotencyKey, ...safeLogParams },
        callerLabel: "stripe:book:taxCalc",
      },
      async () => {
        const calc = await stripe.tax.calculations.create(params, { idempotencyKey });
        return {
          value: {
            calculationId: calc.id as string,
            taxAmountCents: calc.tax_amount_exclusive as number,
            currency: calc.currency as string,
          } satisfies StripeTaxCalcResult,
          statusCode: 200,
        };
      },
    );
  }

  async createPaymentIntent(
    idempotencyKey: string,
    params: Record<string, unknown>,
  ): Promise<StripePaymentIntentResult> {
    const stripe = await getPinnedStripeForChargeOps();
    return auditOutboundCall(
      {
        integration: "stripe",
        endpoint: "/v1/payment_intents",
        method: "POST",
        dedupeParams: {
          op: "paymentIntents.create",
          idempotencyKey,
          amount: typeof params.amount === "number" ? params.amount : undefined,
          currency: typeof params.currency === "string" ? params.currency : undefined,
        },
        callerLabel: "stripe:book:pi.create",
      },
      async () => {
        const pi = await stripe.paymentIntents.create(params, { idempotencyKey });
        return { value: normalizePaymentIntent(pi), statusCode: 200 };
      },
    );
  }

  async updatePaymentIntent(
    idempotencyKey: string,
    paymentIntentId: string,
    params: Record<string, unknown>,
  ): Promise<StripePaymentIntentResult> {
    const stripe = await getPinnedStripeForChargeOps();
    return auditOutboundCall(
      {
        integration: "stripe",
        endpoint: `/v1/payment_intents/${paymentIntentId}`,
        method: "POST",
        dedupeParams: {
          op: "paymentIntents.update",
          paymentIntentId,
          idempotencyKey,
          amount: typeof params.amount === "number" ? params.amount : undefined,
          currency: typeof params.currency === "string" ? params.currency : undefined,
        },
        callerLabel: "stripe:book:pi.update",
      },
      async () => {
        const pi = await stripe.paymentIntents.update(paymentIntentId, params, {
          idempotencyKey,
        });
        return { value: normalizePaymentIntent(pi), statusCode: 200 };
      },
    );
  }

  async retrievePaymentIntent(
    paymentIntentId: string,
  ): Promise<StripePaymentIntentResult> {
    const stripe = await getPinnedStripeForChargeOps();
    return auditOutboundCall(
      {
        integration: "stripe",
        endpoint: `/v1/payment_intents/${paymentIntentId}`,
        method: "GET",
        dedupeParams: { op: "paymentIntents.retrieve", paymentIntentId },
        callerLabel: "stripe:book:pi.retrieve",
      },
      async () => {
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
        return { value: normalizePaymentIntent(pi), statusCode: 200 };
      },
    );
  }
}

/**
 * Normalize a Stripe PaymentIntent SDK response to our PCI-safe subset.
 * Excludes payment_method, charges, and any raw card data.
 */
function normalizePaymentIntent(pi: any): StripePaymentIntentResult {
  return {
    paymentIntentId: pi.id as string,
    clientSecret: (pi.client_secret as string | null) ?? null,
    status: pi.status as string,
    amountCents: pi.amount as number,
    currency: pi.currency as string,
  };
}

// ─── Normalize timeout/unknown outcomes ──────────────────────────────────────

export type StripeCallOutcome =
  | { kind: "success" }
  | { kind: "timeout_or_network"; message: string }
  | { kind: "card_declined"; code?: string; message: string }
  | { kind: "api_error"; statusCode?: number; message: string }
  | { kind: "auth_error"; message: string }
  | { kind: "unknown_error"; message: string };

/**
 * Classify a Stripe SDK error into a normalized outcome. Callers use this to
 * decide whether to mark checkout 'unknown' (retryable) vs 'failed' (terminal).
 */
export function classifyStripeError(err: unknown): StripeCallOutcome {
  if (!err) return { kind: "unknown_error", message: "null/undefined error" };
  const e = err as any;
  const msg = String(e?.message ?? e ?? "");

  if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network/i.test(msg)) {
    return { kind: "timeout_or_network", message: msg.slice(0, 200) };
  }

  const type: string = e?.type ?? "";
  const code: string | undefined = e?.code ?? e?.decline_code ?? undefined;
  const statusCode: number | undefined =
    typeof e?.statusCode === "number" ? e.statusCode : undefined;

  if (statusCode === 401 || type === "StripeAuthenticationError") {
    return { kind: "auth_error", message: msg.slice(0, 200) };
  }
  if (type === "StripeCardError") {
    return { kind: "card_declined", code, message: msg.slice(0, 200) };
  }
  if (type === "StripeConnectionError" || type === "StripeAPIError") {
    return { kind: "timeout_or_network", message: msg.slice(0, 200) };
  }
  if (typeof statusCode === "number" && statusCode >= 500) {
    return { kind: "timeout_or_network", message: msg.slice(0, 200) };
  }
  if (typeof statusCode === "number" && statusCode >= 400) {
    return { kind: "api_error", statusCode, message: msg.slice(0, 200) };
  }
  return { kind: "unknown_error", message: msg.slice(0, 200) };
}

// ─── Bounded address ──────────────────────────────────────────────────────────

/**
 * Bounded address input for tax calculation. Never logged. Only these fields
 * are forwarded to Stripe; unknown fields are dropped. `country` must be "US"
 * for the Complete package (physical fulfilment) — enforced by the caller.
 */
export interface BookCheckoutAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  /** ISO-3166-1 alpha-2 country code (uppercase). */
  country: string;
}

const ADDR_MAX = 256;

function boundStr(v: string | undefined, max = ADDR_MAX): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

/** Build the Stripe `customer_details.address` object from a bounded address. */
function toStripeAddress(addr: BookCheckoutAddress): Record<string, unknown> {
  const out: Record<string, unknown> = { country: boundStr(addr.country, 2) };
  const line1 = boundStr(addr.line1);
  const line2 = boundStr(addr.line2);
  const city = boundStr(addr.city);
  const state = boundStr(addr.state, 64);
  const postal = boundStr(addr.postalCode, 32);
  if (line1) out.line1 = line1;
  if (line2) out.line2 = line2;
  if (city) out.city = city;
  if (state) out.state = state;
  if (postal) out.postal_code = postal;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// High-level: calculateAuthoritativeBookQuote
// ═══════════════════════════════════════════════════════════════════════════

export interface CalculateBookQuoteInput {
  /** Local checkout session ID (correlation + idempotency seed). */
  checkoutSessionId: string;
  /** Selected package. */
  packageCode: BookCommercePackageCode;
  /** Bounded billing/shipping address. Complete requires country === "US". */
  address: BookCheckoutAddress;
}

export interface CalculateBookQuoteResult {
  packageCode: BookCommercePackageCode;
  /** Catalog subtotal (server authority). */
  subtotalAmountCents: number;
  /** Always 0 for the fixed catalog. */
  discountAmountCents: number;
  /** Digital = 0; Complete = server-resolved US shipping cents. */
  shippingAmountCents: number;
  /** Stripe-Tax-owned tax amount (validated: nonnegative, bounded). */
  taxAmountCents: number;
  /** subtotal - discount + shipping + tax. */
  totalAmountCents: number;
  /** Uppercase ISO-4217. */
  currency: "USD";
  /** Stripe Tax Calculation ID for the quote. */
  stripeTaxCalculationId: string;
}

/** Upper bound on tax to reject a nonsensical Stripe response. */
const TAX_CENTS_MAX = 1_000_000; // $10,000 — generous ceiling for a book order.

/**
 * Compute the authoritative, catalog-backed quote for a checkout session.
 *
 * Authority model:
 *   - subtotal comes from the catalog (requirePackageByCode) — never the client.
 *   - discount is always 0 (fixed catalog).
 *   - shipping: digital = 0; complete = server-resolved US shipping cents only;
 *     a non-US country for Complete is rejected (physical fulfilment is US-only).
 *   - tax is owned by Stripe Tax; the returned currency is validated to match
 *     the quote currency and the tax amount must be a nonnegative bounded int.
 *   - total = subtotal - discount + shipping + tax.
 *
 * No DB access here — the caller persists the returned quote.
 */
export async function calculateAuthoritativeBookQuote(
  input: CalculateBookQuoteInput,
): Promise<CalculateBookQuoteResult> {
  const pkg = requirePackageByCode(input.packageCode);

  // Full local launch-readiness gate. This performs no provider probe or
  // network I/O and fails before Stripe Tax is called.
  await requireBookPackageLaunchReady(pkg.code);

  const currency: "USD" = "USD";
  const subtotalAmountCents = pkg.amountCents;
  const discountAmountCents = 0;

  // Shipping authority.
  let shippingAmountCents = 0;
  if (pkg.code === "complete") {
    if (input.address.country?.toUpperCase() !== "US") {
      throw new PackageNotSelectableError(
        pkg.code,
        "Complete Collection ships to U.S. addresses only",
      );
    }
    const shipping = resolveCompleteUsShippingCents();
    if (shipping === null) {
      throw new PackageNotSelectableError(
        pkg.code,
        "Complete Collection U.S. shipping policy is not configured",
      );
    }
    shippingAmountCents = shipping;
  }
  // digital → shippingAmountCents stays 0.

  // Build the server-owned Stripe Tax params (no client-supplied amounts).
  const line_items = [
    {
      amount: subtotalAmountCents,
      reference: `${pkg.sku}:${input.checkoutSessionId}`,
      quantity: 1,
      tax_behavior: "exclusive",
    },
  ];
  const taxParams: TaxCalculationCreateParams = {
    currency: currency.toLowerCase(),
    line_items,
    customer_details: {
      address: toStripeAddress(input.address),
      address_source: "billing",
    },
    ...(shippingAmountCents > 0
      ? {
          shipping_cost: {
            amount: shippingAmountCents,
            tax_behavior: "exclusive",
          },
        }
      : {}),
  };

  // Stable idempotency from checkout id + canonical hash of the server params.
  const idempotencyKey = deriveTaxCalculationIdempotencyKey(
    input.checkoutSessionId,
    taxParams,
  );

  const adapter = getBookCheckoutStripeAdapter();
  const calc = await adapter.createTaxCalculation(idempotencyKey, taxParams);

  // Validate Stripe Tax result: currency must match, tax nonnegative + bounded.
  if (typeof calc.currency !== "string" || calc.currency.toUpperCase() !== currency) {
    throw new Error(
      `[BookCheckoutStripe] Tax calculation currency mismatch: expected ${currency}, got ${calc.currency}`,
    );
  }
  const taxAmountCents = calc.taxAmountCents;
  if (
    !Number.isInteger(taxAmountCents) ||
    taxAmountCents < 0 ||
    taxAmountCents > TAX_CENTS_MAX
  ) {
    throw new Error(
      `[BookCheckoutStripe] Tax calculation amount out of bounds: ${taxAmountCents}`,
    );
  }

  const totalAmountCents =
    subtotalAmountCents - discountAmountCents + shippingAmountCents + taxAmountCents;

  return {
    packageCode: pkg.code,
    subtotalAmountCents,
    discountAmountCents,
    shippingAmountCents,
    taxAmountCents,
    totalAmountCents,
    currency,
    stripeTaxCalculationId: calc.calculationId,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// High-level: createOrRefreshBookPaymentIntent
// ═══════════════════════════════════════════════════════════════════════════

export interface CreateOrRefreshPaymentIntentInput {
  /** Local checkout session ID (metadata + create idempotency seed). */
  checkoutSessionId: string;
  packageCode: BookCommercePackageCode;
  /** Optimistic quote version — drives PI-update idempotency + metadata. */
  quoteVersion: number;
  /** Authoritative total in cents (from calculateAuthoritativeBookQuote). */
  amountCents: number;
  /** Uppercase ISO-4217. */
  currency: "USD";
  /** Existing bound PaymentIntent ID (providerSessionId). Null → create. */
  existingProviderSessionId?: string | null;
  /** Optional receipt email (not logged). */
  receiptEmail?: string | null;
  /**
   * Optional additional PaymentIntent params (e.g. description). These can
   * NEVER overwrite server-owned metadata/amount/currency — they are applied
   * first and the server-owned fields are stamped last.
   */
  additionalParams?: Record<string, unknown>;
}

export interface CreateOrRefreshPaymentIntentResult {
  paymentIntentId: string;
  /** Non-null client secret (validated). */
  clientSecret: string;
  status: string;
  amountCents: number;
  currency: string;
  /** True when a new PaymentIntent was created; false when refreshed. */
  created: boolean;
}

/**
 * Stripe returned a PaymentIntent, but its authoritative fields are unusable or
 * disagree with the server-owned quote. The provider may already have changed
 * remote state, so callers must persist reconciliation_needed.
 */
export class BookPaymentIntentReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookPaymentIntentReconciliationError";
  }
}

/**
 * Create a PaymentIntent (when none is bound) or refresh an existing one
 * (amount/metadata) when a providerSessionId is supplied.
 *
 * Invariants:
 *   - Metadata is server-owned only: book_checkout_session_id, package_code,
 *     quote_version. additionalParams cannot overwrite metadata/amount/currency.
 *   - Create uses a stable idempotency key from the checkout id.
 *   - Update uses a stable idempotency key from the PI id + quoteVersion.
 *   - automatic_payment_methods is enabled.
 *   - The returned amount/currency are validated and client_secret must be non-null.
 */
export async function createOrRefreshBookPaymentIntent(
  input: CreateOrRefreshPaymentIntentInput,
): Promise<CreateOrRefreshPaymentIntentResult> {
  const adapter = getBookCheckoutStripeAdapter();

  // Server-owned metadata — stamped last so additionalParams cannot override it.
  const metadata = {
    book_checkout_session_id: input.checkoutSessionId,
    package_code: input.packageCode,
    quote_version: String(input.quoteVersion),
  };

  const currencyLower = input.currency.toLowerCase();

  // Start from additionalParams, then stamp server-owned fields LAST.
  const baseParams: Record<string, unknown> = {
    ...(input.additionalParams ?? {}),
  };
  // Server-owned fields — overwrite whatever additionalParams tried to set.
  baseParams.amount = input.amountCents;
  baseParams.currency = currencyLower;
  baseParams.metadata = metadata;
  if (input.receiptEmail) baseParams.receipt_email = input.receiptEmail;

  let result: StripePaymentIntentResult;
  let created: boolean;

  if (input.existingProviderSessionId) {
    // Refresh an existing PaymentIntent.
    const idempotencyKey = derivePaymentIntentUpdateIdempotencyKey(
      input.existingProviderSessionId,
      input.quoteVersion,
    );
    // automatic_payment_methods is set at create time; not re-sent on update.
    result = await adapter.updatePaymentIntent(
      idempotencyKey,
      input.existingProviderSessionId,
      baseParams,
    );
    created = false;
  } else {
    // Create a new PaymentIntent.
    const createParams: Record<string, unknown> = {
      ...baseParams,
      automatic_payment_methods: { enabled: true },
    };
    const idempotencyKey = derivePaymentIntentIdempotencyKey(input.checkoutSessionId);
    result = await adapter.createPaymentIntent(idempotencyKey, createParams);
    created = true;
  }

  // Validate returned amount/currency and non-null client secret.
  if (result.amountCents !== input.amountCents) {
    throw new BookPaymentIntentReconciliationError(
      `[BookCheckoutStripe] PaymentIntent amount mismatch: expected ${input.amountCents}, got ${result.amountCents}`,
    );
  }
  if (result.currency.toUpperCase() !== input.currency) {
    throw new BookPaymentIntentReconciliationError(
      `[BookCheckoutStripe] PaymentIntent currency mismatch: expected ${input.currency}, got ${result.currency}`,
    );
  }
  if (!result.clientSecret) {
    throw new BookPaymentIntentReconciliationError(
      "[BookCheckoutStripe] PaymentIntent returned a null client_secret",
    );
  }

  return {
    paymentIntentId: result.paymentIntentId,
    clientSecret: result.clientSecret,
    status: result.status,
    amountCents: result.amountCents,
    currency: result.currency,
    created,
  };
}

// ─── Test seam ────────────────────────────────────────────────────────────────

let _adapterForTest: BookCheckoutStripeAdapter | null = null;

/**
 * Test seam: inject a fake adapter for zero-egress tests. The fake bypasses
 * key resolution entirely (never hits assertTestKeyOnly). Pass null to restore
 * the production adapter. Production code never calls this.
 */
export function __setBookCheckoutStripeAdapterForTest(
  adapter: BookCheckoutStripeAdapter | null,
): void {
  _adapterForTest = adapter;
}

/**
 * Get the active BookCheckoutStripeAdapter — the injected test adapter if set,
 * otherwise the production adapter.
 */
export function getBookCheckoutStripeAdapter(): BookCheckoutStripeAdapter {
  if (_adapterForTest !== null) return _adapterForTest;
  return new ProductionBookCheckoutStripeAdapter();
}
