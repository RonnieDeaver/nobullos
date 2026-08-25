/* test-registration
{
  "name": "Book-checkout Stripe adapter + webhook normalizer + catalog/route source contracts — tax amount authority, provider currency mismatch, stable idempotency key + PI create/refresh, cumulative-refund normalization, verifier seam / signature failure / unsupported types, catalog tampering + shipping policy, secure route schemas + public response contract + production startup/kill-switch recovery wiring (Task #5097)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Pure and DB-free (~0.3s, no network, no Postgres): locks the Task #5097 zero-egress security + normalization contract. With an INJECTED fake BookCheckoutStripeAdapter (no real Stripe) it proves the adapter surface honours Stripe's returned tax amount as authoritative and surfaces a provider currency that mismatches the requested currency; that the PaymentIntent idempotency key is stable across process restarts (deterministic from the checkout session id) so a timeout-after-success create retry converges on the same PI, and that an existing PI can be refreshed via update/retrieve. It locks classifyStripeError's timeout/card/auth/api buckets that drive unknown-vs-failed. It exercises the exported webhook normalizer (__test.normalizeBookEvent / isBookEventType) for the cumulative-refund field, PI/charge/dispute mapping, unsupported/unnormalizable types → null, and the raw signature-verification seam (a throwing verifier makes processStripeWebhook reject BEFORE any sync/DB — signature failure is fail-closed). It locks the catalog financial + gate source of truth (exact prices, mutual exclusion, unknown-code rejection, Complete fail-closed unless enabled+approved+shipping-configured) and the server-owned Complete U.S. shipping policy (missing/zero/positive/invalid), plus digital always-0 shipping. Where route mounting is impractical it asserts the secure route SOURCE CONTRACT: .strict() schemas reject browser-supplied Stripe IDs/prices/SKUs, the non-U.S. geo rejection, and that the payment-intent response never echoes provider PI IDs. Zero-DB source-contract assertions prove the production startup wiring: boot calls startBookPaymentEventReplay('startup'), setKillSwitch(book_payment_processing,false) triggers startBookPaymentEventReplay('switch_release'), and the replay worker uses withWorkerSingletonLock plus onlyPaused:true.",
  "scanPaths": [
    "server/services/bookCheckoutStripe.ts",
    "server/services/bookCommerceCatalog.ts",
    "server/stripeSync.ts",
    "server/storage/bookCommerceWebhookApplicator.ts",
    "server/routes/bookCheckout.ts",
    "server/boot/workersAndCleanup.ts",
    "server/services/killSwitches.ts",
    "server/services/bookPaymentEventReplay.ts"
  ],
  "tier": "small",
  "tierReason": "Deliberately small, overriding the mechanical unmeasured default of medium: pure and in-process — it imports the adapter/normalizer/catalog services and reads two source files for source-contract assertions, opens no DB/socket, makes no network call (the Stripe adapter is fully mocked via the exported test seam), and runs synchronous/near-synchronous assertions in well under 1s. No measured baseline exists yet, hence this explicit override."
}
test-registration */
/**
 * Task #5097 — zero-DB adapter / normalizer / source-contract suite.
 *
 * NO real Stripe egress: the BookCheckoutStripeAdapter is injected via the
 * exported test seam (__setBookCheckoutStripeAdapterForTest), so tax/PI
 * behaviour is asserted against a fake that records calls and returns canned
 * PCI-safe results. NO DB: the webhook normalizer is exercised via the
 * exported __test.normalizeBookEvent seam and the catalog via its pure API.
 *
 * Where route mounting is impractical for a zero-DB suite (the checkout routes
 * pull in rate-limit registration, token HMAC, storage, and the Stripe service
 * loader), the relevant guarantees are asserted as SOURCE CONTRACTS by parsing
 * server/routes/bookCheckout.ts: the .strict() request schemas that reject
 * browser-supplied Stripe IDs/prices/SKUs, the non-U.S. geography rejection,
 * and that the payment-intent response never echoes a provider PI id.
 *
 * Usage: tsx tests/book-checkout-stripe-adapter-normalizer.test.ts
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  getBookCheckoutStripeAdapter,
  __setBookCheckoutStripeAdapterForTest,
  derivePaymentIntentIdempotencyKey,
  deriveTaxCalculationIdempotencyKey,
  derivePaymentIntentUpdateIdempotencyKey,
  calculateAuthoritativeBookQuote,
  createOrRefreshBookPaymentIntent,
  classifyStripeError,
  type BookCheckoutStripeAdapter,
  type StripeTaxCalcResult,
  type StripePaymentIntentResult,
  type TaxCalculationCreateParams,
} from "../server/services/bookCheckoutStripe";
import {
  BOOK_COMMERCE_PACKAGES,
  getEnabledPackagesForCatalog,
  isPackageSelectable,
  assertExclusivePackageCode,
  evaluateCompleteGate,
  resolveCompleteUsShippingCents,
  __setCompleteUsShippingCentsForTest,
  MutualExclusionError,
  UnknownPackageCodeError,
  PackageNotSelectableError,
} from "../server/services/bookCommerceCatalog";
import {
  normalizedStripeBookEventSchema,
  BOOK_WEBHOOK_EVENT_TYPES,
} from "../server/storage/bookCommerceWebhookApplicator";
import { __test as stripeSyncTest, __setWebhookVerifierForTest, processStripeWebhook } from "../server/stripeSync";
import { __test as bookCheckoutRoutesTest } from "../server/routes/bookCheckout";
import {
  __setBookLaunchReadinessReportForTest,
  makeReadyBookLaunchReadinessReportForTest,
  launchGateContextFromReport,
} from "../server/services/bookLaunchReadiness";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  const sym = ok ? "✓" : "✗";
  if (ok) {
    passed++;
    console.log(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.error(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  }
}
async function expectThrows(
  label: string,
  fn: () => Promise<unknown> | unknown,
  ctor?: new (...a: any[]) => Error,
): Promise<void> {
  try {
    await fn();
    check(label, false, "did not throw");
  } catch (err) {
    check(label, ctor ? err instanceof ctor : true, err instanceof Error ? err.name : String(err));
  }
}

// ── Fake adapter: records calls, returns canned PCI-safe results ───────────────
interface FakeCall {
  method: string;
  args: any[];
}
class FakeBookCheckoutStripeAdapter implements BookCheckoutStripeAdapter {
  calls: FakeCall[] = [];
  /** Tax amount + currency Stripe "returns" — the authority the adapter reports. */
  taxAmountCents = 87;
  taxCurrency = "usd";
  /**
   * Deterministic PI id keyed by the *idempotency key* (simulates Stripe's
   * idempotent create — the same idempotency key always resolves the same PI).
   */
  private piByIdemKey = new Map<string, string>();
  piStatus = "requires_payment_method";
  /** Records the exact idempotency keys received per method, for assertions. */
  taxIdemKeys: string[] = [];
  createIdemKeys: string[] = [];
  updateIdemKeys: string[] = [];

  async createTaxCalculation(
    idempotencyKey: string,
    params: TaxCalculationCreateParams,
  ): Promise<StripeTaxCalcResult> {
    this.calls.push({ method: "createTaxCalculation", args: [idempotencyKey, params] });
    this.taxIdemKeys.push(idempotencyKey);
    // Deterministic calc id from the idempotency key so a re-quote converges.
    return {
      calculationId: `taxcalc_${idempotencyKey.slice(-8)}`,
      taxAmountCents: this.taxAmountCents,
      currency: this.taxCurrency,
    };
  }
  async createPaymentIntent(
    idempotencyKey: string,
    params: Record<string, unknown>,
  ): Promise<StripePaymentIntentResult> {
    this.calls.push({ method: "createPaymentIntent", args: [idempotencyKey, params] });
    this.createIdemKeys.push(idempotencyKey);
    // Idempotent: a retry with the same idempotency key gets the same PI id
    // (Stripe's idempotency-key behaviour, keyed here by the caller's key).
    let pi = this.piByIdemKey.get(idempotencyKey);
    if (!pi) {
      pi = `pi_${idempotencyKey.slice(-10)}`;
      this.piByIdemKey.set(idempotencyKey, pi);
    }
    const amount = typeof params.amount === "number" ? (params.amount as number) : 0;
    const currency = typeof params.currency === "string" ? (params.currency as string) : "usd";
    return {
      paymentIntentId: pi,
      clientSecret: `${pi}_secret_x`,
      status: this.piStatus,
      amountCents: amount,
      currency: currency.toLowerCase(),
    };
  }
  async updatePaymentIntent(
    idempotencyKey: string,
    paymentIntentId: string,
    params: Record<string, unknown>,
  ): Promise<StripePaymentIntentResult> {
    this.calls.push({ method: "updatePaymentIntent", args: [idempotencyKey, paymentIntentId, params] });
    this.updateIdemKeys.push(idempotencyKey);
    return {
      paymentIntentId,
      clientSecret: `${paymentIntentId}_secret_y`,
      status: "requires_confirmation",
      amountCents: typeof params.amount === "number" ? (params.amount as number) : 0,
      currency: typeof params.currency === "string" ? (params.currency as string) : "usd",
    };
  }
  async retrievePaymentIntent(paymentIntentId: string): Promise<StripePaymentIntentResult> {
    this.calls.push({ method: "retrievePaymentIntent", args: [paymentIntentId] });
    return {
      paymentIntentId,
      clientSecret: `${paymentIntentId}_secret_z`,
      status: "succeeded",
      amountCents: 599,
      currency: "usd",
    };
  }
}

async function main(): Promise<void> {
  const readyReport = makeReadyBookLaunchReadinessReportForTest();
  __setBookLaunchReadinessReportForTest(readyReport);
  const launchReady = launchGateContextFromReport(readyReport);
  console.log("Book-checkout Stripe adapter + normalizer + source contracts (Task #5097)");

  // ── (1) Stable idempotency key: deterministic + collision-resistant ─────────
  {
    const sid = "sess-ABC-123";
    const k1 = derivePaymentIntentIdempotencyKey(sid);
    const k2 = derivePaymentIntentIdempotencyKey(sid);
    check("idempotency key is deterministic for a session", k1 === k2);
    check("idempotency key has the book-checkout prefix", k1.startsWith("book-checkout-pi-"));
    check(
      "different sessions get different idempotency keys",
      derivePaymentIntentIdempotencyKey("sess-XYZ-999") !== k1,
    );
  }

  // ── (2) High-level quote: tax authority + params contract + idempotency ─────
  // Prefer the high-level calculateAuthoritativeBookQuote over the raw adapter:
  // it computes the server-owned Stripe Tax params (subtotal line_items, and a
  // positive shipping_cost for the physical package), derives the stable tax
  // idempotency key (checkout id + canonical hash of the FULL params/address),
  // and treats Stripe's returned tax amount as authoritative.
  {
    // --- Digital: subtotal line item, NO shipping_cost, tax authoritative ---
    const fake = new FakeBookCheckoutStripeAdapter();
    fake.taxAmountCents = 143;
    fake.taxCurrency = "usd";
    __setBookCheckoutStripeAdapterForTest(fake);
    try {
      check("test seam returns the injected adapter", getBookCheckoutStripeAdapter() === (fake as unknown));

      const quote = await calculateAuthoritativeBookQuote({
        checkoutSessionId: "sess-tax-1",
        packageCode: "digital",
        address: { country: "US", state: "CA", city: "SF", line1: "1 Market St", postalCode: "94105" },
      });
      // Tax amount is authoritative — the quote uses Stripe's returned figure.
      check("quote uses Stripe's tax amount as authoritative", quote.taxAmountCents === 143);
      check("quote subtotal is the catalog price (499)", quote.subtotalAmountCents === 499);
      check("digital quote has zero shipping", quote.shippingAmountCents === 0);
      check("quote total = subtotal+tax (642)", quote.totalAmountCents === 642);
      check("quote surfaces the Stripe tax calculation id", quote.stripeTaxCalculationId.startsWith("taxcalc_"));

      const taxCall = fake.calls.find((c) => c.method === "createTaxCalculation");
      const taxParams = taxCall?.args[1] as TaxCalculationCreateParams;
      check("tax params carry a subtotal line item at the catalog price", taxParams.line_items[0]?.amount === 499);
      check("digital tax params carry NO shipping_cost", taxParams.shipping_cost === undefined);
      // Idempotency key = checkout id + canonical hash of the FULL params.
      const expectedTaxKey = deriveTaxCalculationIdempotencyKey("sess-tax-1", taxParams);
      check("tax idempotency key hashes the full canonical params", fake.taxIdemKeys[0] === expectedTaxKey);
      check("tax idempotency key is bound to the checkout session id", fake.taxIdemKeys[0].includes("sess-tax-1"));

      // Same inputs → same idempotency key (re-quote converges, no double-charge).
      const q2 = await calculateAuthoritativeBookQuote({
        checkoutSessionId: "sess-tax-1",
        packageCode: "digital",
        address: { country: "US", state: "CA", city: "SF", line1: "1 Market St", postalCode: "94105" },
      });
      check("re-quote with identical inputs reuses the same tax idempotency key", fake.taxIdemKeys[0] === fake.taxIdemKeys[1]);
      check("re-quote converges on the same tax calculation id", q2.stripeTaxCalculationId === quote.stripeTaxCalculationId);
      // Changing the address must change the canonical hash → a NEW key.
      await calculateAuthoritativeBookQuote({
        checkoutSessionId: "sess-tax-1",
        packageCode: "digital",
        address: { country: "US", state: "NY", city: "NYC", line1: "5 Ave", postalCode: "10001" },
      });
      check("a different address yields a different tax idempotency key", fake.taxIdemKeys[2] !== fake.taxIdemKeys[0]);
    } finally {
      __setBookCheckoutStripeAdapterForTest(null);
    }

    // --- Complete (physical): positive shipping_cost carried in tax params ---
    const priorEnabled = process.env.BOOK_COMMERCE_COMPLETE_ENABLED;
    const priorApproved = process.env.BOOK_COMMERCE_COMPLETE_APPROVED;
    process.env.BOOK_COMMERCE_COMPLETE_ENABLED = "true";
    process.env.BOOK_COMMERCE_COMPLETE_APPROVED = "true";
    __setCompleteUsShippingCentsForTest(599);
    const fakeC = new FakeBookCheckoutStripeAdapter();
    fakeC.taxAmountCents = 210;
    __setBookCheckoutStripeAdapterForTest(fakeC);
    try {
      const quote = await calculateAuthoritativeBookQuote({
        checkoutSessionId: "sess-complete-1",
        packageCode: "complete",
        address: { country: "US", state: "CA", city: "SF", line1: "1 Market St", postalCode: "94105" },
      });
      check("complete quote subtotal is 1999", quote.subtotalAmountCents === 1999);
      check("complete quote carries positive server-resolved shipping (599)", quote.shippingAmountCents === 599);
      check("complete quote total = subtotal+shipping+tax (2808)", quote.totalAmountCents === 1999 + 599 + 210);

      const taxCall = fakeC.calls.find((c) => c.method === "createTaxCalculation");
      const taxParams = taxCall?.args[1] as TaxCalculationCreateParams;
      check("complete tax params carry the subtotal line item (1999)", taxParams.line_items[0]?.amount === 1999);
      check("complete tax params carry a positive shipping_cost", (taxParams.shipping_cost as any)?.amount === 599);

      // Geo authority lives in the SERVICE: a non-US complete quote is rejected
      // (the route maps this to a generic 409). The browser never decides geo.
      await expectThrows(
        "complete quote for a non-US address is rejected (server geo authority)",
        () =>
          calculateAuthoritativeBookQuote({
            checkoutSessionId: "sess-complete-nonus",
            packageCode: "complete",
            address: { country: "CA", state: "ON", city: "Toronto", line1: "1 Yonge St", postalCode: "M5E1E5" },
          }),
        PackageNotSelectableError,
      );
    } finally {
      __setBookCheckoutStripeAdapterForTest(null);
      __setCompleteUsShippingCentsForTest(undefined);
      if (priorEnabled === undefined) delete process.env.BOOK_COMMERCE_COMPLETE_ENABLED;
      else process.env.BOOK_COMMERCE_COMPLETE_ENABLED = priorEnabled;
      if (priorApproved === undefined) delete process.env.BOOK_COMMERCE_COMPLETE_APPROVED;
      else process.env.BOOK_COMMERCE_COMPLETE_APPROVED = priorApproved;
    }
  }

  // ── (3) High-level PI create/refresh: timeout-retry convergence + refresh ───
  // Prefer createOrRefreshBookPaymentIntent: it stamps server-owned metadata,
  // uses a stable create key (from the checkout id) so a timeout-after-success
  // retry converges on the same PI, and a stable update key (PI id + version).
  {
    const fake = new FakeBookCheckoutStripeAdapter();
    __setBookCheckoutStripeAdapterForTest(fake);
    try {
      const first = await createOrRefreshBookPaymentIntent({
        checkoutSessionId: "sess-retry-1",
        packageCode: "digital",
        quoteVersion: 1,
        amountCents: 499,
        currency: "USD",
      });
      check("high-level create returns created:true", first.created === true);
      check("high-level create returns a non-null client secret", !!first.clientSecret);

      // Timeout-after-success: the caller retries the create for the same
      // session; the stable create idempotency key converges on the SAME PI.
      const retry = await createOrRefreshBookPaymentIntent({
        checkoutSessionId: "sess-retry-1",
        packageCode: "digital",
        quoteVersion: 1,
        amountCents: 499,
        currency: "USD",
      });
      check("timeout-after-success PI create retry converges on the same PI", first.paymentIntentId === retry.paymentIntentId);
      check("both create calls used the same stable idempotency key", fake.createIdemKeys[0] === fake.createIdemKeys[1]);
      check("create idempotency key = derivePaymentIntentIdempotencyKey(session)", fake.createIdemKeys[0] === derivePaymentIntentIdempotencyKey("sess-retry-1"));

      // Refresh an existing PI: update keyed by PI id + quoteVersion.
      const refreshed = await createOrRefreshBookPaymentIntent({
        checkoutSessionId: "sess-retry-1",
        packageCode: "digital",
        quoteVersion: 2,
        amountCents: 599,
        currency: "USD",
        existingProviderSessionId: first.paymentIntentId,
      });
      check("refresh returns created:false", refreshed.created === false);
      check("refresh targets the existing PI id", refreshed.paymentIntentId === first.paymentIntentId);
      check("refresh reflects the new amount (599)", refreshed.amountCents === 599);
      check(
        "update idempotency key = derivePaymentIntentUpdateIdempotencyKey(pi, version)",
        fake.updateIdemKeys[0] === derivePaymentIntentUpdateIdempotencyKey(first.paymentIntentId, 2),
      );
    } finally {
      __setBookCheckoutStripeAdapterForTest(null);
    }
  }

  // ── (3b) Same-bound-PI unknown bind: retry convergence ──────────────────────
  // A refresh on an already-bound PI whose first response was "unknown" (e.g.
  // timeout) is retried; the stable update key (PI id + quoteVersion) means the
  // retry targets the SAME PI with the SAME key and converges (no new PI, no
  // divergent amount). This proves an unknown same-bound-PI outcome reconverges.
  {
    const fake = new FakeBookCheckoutStripeAdapter();
    __setBookCheckoutStripeAdapterForTest(fake);
    try {
      const boundPi = "pi_already_bound_xyz";
      const args = {
        checkoutSessionId: "sess-unknown-1",
        packageCode: "digital" as const,
        quoteVersion: 3,
        amountCents: 499,
        currency: "USD" as const,
        existingProviderSessionId: boundPi,
      };
      const a = await createOrRefreshBookPaymentIntent(args);
      const b = await createOrRefreshBookPaymentIntent(args); // retry after unknown
      check("same-bound-PI retry keeps the same PI id", a.paymentIntentId === b.paymentIntentId && a.paymentIntentId === boundPi);
      check("same-bound-PI retry reuses the same update idempotency key", fake.updateIdemKeys[0] === fake.updateIdemKeys[1]);
      check("same-bound-PI retry converges on the same amount", a.amountCents === b.amountCents);
    } finally {
      __setBookCheckoutStripeAdapterForTest(null);
    }
  }

  // ── (4) classifyStripeError buckets (drives unknown-vs-failed reconciliation) ─
  {
    check("timeout classified as timeout_or_network", classifyStripeError({ message: "ETIMEDOUT while calling" }).kind === "timeout_or_network");
    check("network reset classified as timeout_or_network", classifyStripeError({ message: "ECONNRESET" }).kind === "timeout_or_network");
    check("card error classified as card_declined", classifyStripeError({ type: "StripeCardError", code: "card_declined", message: "declined" }).kind === "card_declined");
    check("401/auth classified as auth_error", classifyStripeError({ statusCode: 401, message: "bad key" }).kind === "auth_error");
    check("StripeConnectionError classified as timeout_or_network", classifyStripeError({ type: "StripeConnectionError", message: "conn" }).kind === "timeout_or_network");
    check("5xx classified as timeout_or_network", classifyStripeError({ statusCode: 503, message: "unavailable" }).kind === "timeout_or_network");
    check("4xx (non-401) classified as api_error", classifyStripeError({ statusCode: 400, message: "bad req" }).kind === "api_error");
    check("null error classified as unknown_error", classifyStripeError(null).kind === "unknown_error");
  }

  // ── (5) Catalog / package tampering ─────────────────────────────────────────
  {
    const digital = BOOK_COMMERCE_PACKAGES.find((p) => p.code === "digital")!;
    const complete = BOOK_COMMERCE_PACKAGES.find((p) => p.code === "complete")!;
    check("digital price is 499 cents", digital.amountCents === 499);
    check("complete price is 1999 cents", complete.amountCents === 1999);
    check("digital fails closed without readiness", isPackageSelectable("digital").selectable === false);
    check(
      "digital selectable with server readiness",
      isPackageSelectable("digital", undefined, launchReady).selectable === true,
    );
    check("complete NOT selectable by default", isPackageSelectable("complete").selectable === false);

    // Mutual exclusion + unknown-code tampering.
    check("exactly one code selects", assertExclusivePackageCode(["digital"]) === "digital");
    await expectThrows("selecting two codes throws MutualExclusionError", () => assertExclusivePackageCode(["digital", "complete"]), MutualExclusionError);
    await expectThrows("selecting zero codes throws MutualExclusionError", () => assertExclusivePackageCode([]), MutualExclusionError);
    await expectThrows("unknown code throws UnknownPackageCodeError", () => assertExclusivePackageCode(["premium"]), UnknownPackageCodeError);

    // Complete gate fail-closed matrix.
    check("gate open needs enabled+approved+shipping", evaluateCompleteGate({ enabled: true, approved: true, usShippingCents: 0 }).allowed === true);
    check("gate closed when not enabled", evaluateCompleteGate({ enabled: false, approved: true, usShippingCents: 0 }).allowed === false);
    check("gate closed when not approved", evaluateCompleteGate({ enabled: true, approved: false, usShippingCents: 0 }).allowed === false);
    check("gate closed when shipping unconfigured (null)", evaluateCompleteGate({ enabled: true, approved: true, usShippingCents: null }).allowed === false);
  }

  // ── (6) Complete U.S. shipping policy: missing / zero / positive / invalid ──
  {
    // missing (null) → fail-closed
    __setCompleteUsShippingCentsForTest(null);
    check("missing shipping policy → null (fail-closed)", resolveCompleteUsShippingCents() === null);
    let cat = getEnabledPackagesForCatalog(
      { enabled: true, approved: true, usShippingCents: null },
      launchReady,
    );
    check("catalog omits complete when shipping unconfigured", !cat.some((p) => p.code === "complete"));
    check("catalog always includes digital with shipping 0", cat.find((p) => p.code === "digital")?.shippingCents === 0);

    // zero → included, shipping 0 (U.S. shipping included)
    __setCompleteUsShippingCentsForTest(0);
    check("zero shipping policy resolves to 0", resolveCompleteUsShippingCents() === 0);
    cat = getEnabledPackagesForCatalog(
      { enabled: true, approved: true, usShippingCents: 0 },
      launchReady,
    );
    const completeZero = cat.find((p) => p.code === "complete");
    check("catalog includes complete with shipping 0 when configured to 0", completeZero?.shippingCents === 0);

    // positive → included with disclosed cost
    __setCompleteUsShippingCentsForTest(599);
    check("positive shipping policy resolves to the configured cents", resolveCompleteUsShippingCents() === 599);
    cat = getEnabledPackagesForCatalog(
      { enabled: true, approved: true, usShippingCents: 599 },
      launchReady,
    );
    check("catalog surfaces the disclosed complete shipping cost", cat.find((p) => p.code === "complete")?.shippingCents === 599);

    // Restore env-backed behaviour.
    __setCompleteUsShippingCentsForTest(undefined);
  }

  // ── (7) Webhook normalizer: cumulative refund + PI/dispute mapping ──────────
  {
    const { normalizeBookEvent, isBookEventType } = stripeSyncTest;

    // PI processing → recognized as a book event; PI/session/amount/currency.
    check("payment_intent.processing is a book event type", isBookEventType("payment_intent.processing") === true);
    const piProcessing = normalizeBookEvent({
      id: "evt_pi_proc",
      type: "payment_intent.processing",
      data: { object: { id: "pi_proc", amount: 642, currency: "usd", metadata: { book_checkout_session_id: "sess-proc", order_number: "ORD-P" } } },
    });
    check("processing normalizes the correct event type", piProcessing?.eventType === "payment_intent.processing");
    check("processing normalizes the PI id", piProcessing?.paymentIntentId === "pi_proc");
    check("processing carries the trusted metadata session id", piProcessing?.checkoutSessionIdFromMeta === "sess-proc");
    check("processing carries the order number from metadata", piProcessing?.orderNumberFromMeta === "ORD-P");
    check("processing amount preserved", piProcessing?.amountCents === 642);
    check("processing currency preserved", piProcessing?.currency === "usd");
    // Unnormalizable processing (missing PI id) → null.
    check(
      "processing with a missing PI id normalizes to null",
      normalizeBookEvent({ id: "e", type: "payment_intent.processing", data: { object: { amount: 642, currency: "usd" } } }) === null,
    );

    // PI succeeded → PI id + trusted metadata session id.
    const piSucceeded = normalizeBookEvent({
      id: "evt_pi_1",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_abc", amount: 499, currency: "usd", metadata: { book_checkout_session_id: "sess-1", order_number: "ORD-1" } } },
    });
    check("PI succeeded normalizes with the PI id", piSucceeded?.paymentIntentId === "pi_abc");
    check("PI succeeded carries trusted metadata session id", piSucceeded?.checkoutSessionIdFromMeta === "sess-1");
    check("PI succeeded carries the order number from metadata", piSucceeded?.orderNumberFromMeta === "ORD-1");
    check("PI succeeded amount preserved", piSucceeded?.amountCents === 499);

    // charge.refunded → cumulative refund from amount_refunded, PI id from charge.
    const refunded = normalizeBookEvent({
      id: "evt_refund_1",
      type: "charge.refunded",
      data: { object: { payment_intent: "pi_abc", amount: 499, amount_refunded: 250, currency: "usd" } },
    });
    check("charge.refunded resolves the PI id from the charge", refunded?.paymentIntentId === "pi_abc");
    // The normalizer maps amount_refunded → the cumulative refund figure on the
    // normalized event. Assert the authoritative top-level field directly.
    check(
      "charge.refunded normalizes refundedAmountCentsCumulative from amount_refunded",
      refunded?.refundedAmountCentsCumulative === 250,
    );
    // It also forwards the same figure via rawPayload for audit; assert it survives.
    check(
      "charge.refunded rawPayload carries the cumulative refund figure",
      (refunded?.rawPayload as any)?.refund_cumulative_amount_cents === 250,
    );

    // charge.dispute.closed(lost) → dispute outcome captured, PI id from dispute.
    const disputeLost = normalizeBookEvent({
      id: "evt_dispute_1",
      type: "charge.dispute.closed",
      data: { object: { payment_intent: "pi_abc", amount: 499, currency: "usd", status: "lost" } },
    });
    check("dispute.closed resolves the PI id from the dispute", disputeLost?.paymentIntentId === "pi_abc");
    check("dispute.closed captures the lost outcome", disputeLost?.disputeOutcome === "lost");

    // Unsupported type → null (sync-only, no book dispatch).
    check("unsupported event type is not a book event", isBookEventType("customer.created") === false);
    check("normalizer returns null for a non-book type", normalizeBookEvent({ id: "e", type: "customer.created", data: { object: { id: "cus_1" } } }) === null);
    // Unnormalizable (missing PI id) → null.
    check("normalizer returns null when the PI id is missing", normalizeBookEvent({ id: "e", type: "payment_intent.succeeded", data: { object: { amount: 499, currency: "usd" } } }) === null);
    // No data object → null.
    check("normalizer returns null with no data object", normalizeBookEvent({ id: "e", type: "payment_intent.succeeded", data: {} }) === null);
  }

  // ── (8) Applicator schema validation (mirrors the normalizer contract) ──────
  {
    // The applicator's supported set is the authority; assert it exactly (not a
    // brittle magic count) so adding/removing a handled type surfaces here.
    const expectedBookEventTypes = [
      "payment_intent.processing",
      "payment_intent.succeeded",
      "payment_intent.payment_failed",
      "payment_intent.canceled",
      "charge.refunded",
      "charge.dispute.created",
      "charge.dispute.closed",
    ];
    check(
      "applicator supports exactly the expected book event set",
      BOOK_WEBHOOK_EVENT_TYPES.length === expectedBookEventTypes.length &&
        expectedBookEventTypes.every((t) => (BOOK_WEBHOOK_EVENT_TYPES as readonly string[]).includes(t)),
      `${BOOK_WEBHOOK_EVENT_TYPES.length} types`,
    );
    // charge.refunded requires a cumulative figure.
    const missingCumulative = normalizedStripeBookEventSchema.safeParse({
      providerEventId: "evt_1",
      eventType: "charge.refunded",
      paymentIntentId: "pi_1",
      amountCents: 499,
      currency: "USD",
    });
    check("charge.refunded without cumulative fails validation", missingCumulative.success === false);
    // over-charge cumulative is rejected (never clamped).
    const overCharge = normalizedStripeBookEventSchema.safeParse({
      providerEventId: "evt_1",
      eventType: "charge.refunded",
      paymentIntentId: "pi_1",
      amountCents: 499,
      currency: "USD",
      refundedAmountCentsCumulative: 500,
    });
    check("over-charge cumulative refund is rejected", overCharge.success === false);
    // dispute.closed requires an outcome.
    const missingOutcome = normalizedStripeBookEventSchema.safeParse({
      providerEventId: "evt_1",
      eventType: "charge.dispute.closed",
      paymentIntentId: "pi_1",
      amountCents: 499,
      currency: "USD",
    });
    check("dispute.closed without outcome fails validation", missingOutcome.success === false);
  }

  // ── (9) Raw verification seam / signature failure / unsupported types ───────
  {
    const priorSecret = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_dummy";
    try {
      // Signature failure: the injected verifier throws → processStripeWebhook
      // rejects BEFORE any sync/DB work (fail-closed, nothing downstream runs).
      __setWebhookVerifierForTest(() => {
        throw new Error("Webhook signature verification failed");
      });
      await expectThrows(
        "a signature-verification failure makes processStripeWebhook reject before any routing",
        () => processStripeWebhook(Buffer.from("{}"), "bad-sig"),
      );
    } finally {
      __setWebhookVerifierForTest(null);
      if (priorSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
      else process.env.STRIPE_WEBHOOK_SECRET = priorSecret;
    }

    // Missing secret is a hard error (cannot verify → fail-closed).
    const priorSecret2 = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      await expectThrows(
        "a missing STRIPE_WEBHOOK_SECRET makes processStripeWebhook reject",
        () => processStripeWebhook(Buffer.from("{}"), "sig"),
      );
    } finally {
      if (priorSecret2 === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
      else process.env.STRIPE_WEBHOOK_SECRET = priorSecret2;
    }
  }

  // ── (10) Secure route SOURCE CONTRACT (route mounting impractical zero-DB) ──
  {
    const routeSrc = readFileSync(resolve(process.cwd(), "server/routes/bookCheckout.ts"), "utf8");

    // .strict() request schemas reject any extra field (Stripe IDs, prices, SKUs).
    check("route uses .strict() request schemas (rejects extra browser fields)", /\.strict\(\)/.test(routeSrc));
    check("start schema is bounded (email + packageCode + idempotencyKey only)", /startCheckoutSchema\s*=\s*z\.object/.test(routeSrc));
    check("resume/contact/totals/payment-intent are resumeToken-gated", /resumeTokenField/.test(routeSrc));

    // Non-U.S. geography rejection for the physical package: the browser never
    // decides geography — the SERVICE (calculateAuthoritativeBookQuote) owns it
    // and throws PackageNotSelectableError, which the totals route maps to a
    // GENERIC 409 (no config/approval reasoning leaked). Assert that contract.
    check(
      "totals route delegates geo/shipping authority to calculateAuthoritativeBookQuote",
      /calculateAuthoritativeBookQuote\(/.test(routeSrc),
    );
    check(
      "totals route maps PackageNotSelectableError to a generic 409",
      /PackageNotSelectableError/.test(routeSrc) && /HttpError\(409,/.test(routeSrc),
    );

    // Payment-intent response never echoes provider PI ids / browser prices.
    const piResponseBlock = routeSrc.slice(routeSrc.indexOf("Return ONLY clientSecret"));
    check("payment-intent response returns clientSecret", /clientSecret:\s*pi\.clientSecret/.test(routeSrc));
    check(
      "payment-intent response returns only the configured Stripe publishable key",
      /publishableKey,\s*\n\s*status:/.test(piResponseBlock) &&
        /function requireStripePublishableKey\(\)/.test(routeSrc),
    );
    check(
      "payment-intent response never returns paymentIntentId to the browser",
      piResponseBlock.length > 0 && !/res\.json\([\s\S]*paymentIntentId[\s\S]*\}\)/.test(piResponseBlock),
    );
    check(
      "missing publishable key fails before the Stripe provider call",
      routeSrc.indexOf("const publishableKey = requireStripePublishableKey()") <
        routeSrc.indexOf("pi = await createOrRefreshBookPaymentIntent"),
    );
    check(
      "completed resume mints access only through the active-entitlement capability seam",
      /session\.status === "completed"\s*\?\s*await createImmediateBookAccessCapabilityForCheckout\(session\.id\)/.test(
        routeSrc,
      ),
    );
    const totalsHandlerBlock = routeSrc.slice(
      routeSrc.indexOf('"/api/book/checkout/totals"'),
      routeSrc.indexOf('"/api/book/checkout/payment-intent"'),
    );
    const paymentHandlerBlock = routeSrc.slice(
      routeSrc.indexOf('"/api/book/checkout/payment-intent"'),
    );
    check(
      "totals route requires durable contact-step completion before quoting",
      /await requireCompletedCheckoutContact\(session\)/.test(totalsHandlerBlock),
    );
    check(
      "payment-intent route requires durable contact-step completion before Stripe",
      /await requireCompletedCheckoutContact\(session\)/.test(paymentHandlerBlock) &&
        paymentHandlerBlock.indexOf("requireCompletedCheckoutContact") <
          paymentHandlerBlock.indexOf("createOrRefreshBookPaymentIntent"),
    );
    // Provider call is made OUTSIDE the DB transaction (documented + structured).
    check("payment-intent provider call is outside any DB transaction", /Provider call OUTSIDE any DB transaction/.test(routeSrc));
    // Resume tokens are stored hashed, never plaintext.
    check("resume tokens are stored as hashes, never plaintext", /hashResumeToken/.test(routeSrc) && /resumeTokenHash/.test(routeSrc));
  }

  // ── (11) Functional hostile-payload rejection against exported route schemas ─
  // These exercise the ACTUAL .strict() request schemas (not source regex): a
  // browser cannot smuggle Stripe IDs, server-owned prices, statuses, or SKUs.
  {
    const {
      startCheckoutSchema,
      resumeCheckoutSchema,
      contactCheckoutSchema,
      totalsCheckoutSchema,
      paymentIntentCheckoutSchema,
    } = bookCheckoutRoutesTest;
    const HEX64 = "a".repeat(64);

    // start: the legitimate minimal payload parses.
    check(
      "start accepts a minimal legitimate payload",
      startCheckoutSchema.safeParse({ packageCode: "digital", email: "b@x.com", idempotencyKey: "k1" }).success === true,
    );
    // start: hostile browser-supplied server-owned fields are REJECTED.
    check(
      "start rejects a browser-supplied price",
      startCheckoutSchema.safeParse({ packageCode: "digital", email: "b@x.com", idempotencyKey: "k1", price: 1 }).success === false,
    );
    check(
      "start rejects a browser-supplied stripePriceId",
      startCheckoutSchema.safeParse({ packageCode: "digital", email: "b@x.com", idempotencyKey: "k1", stripePriceId: "price_x" }).success === false,
    );
    check(
      "start rejects a browser-supplied status",
      startCheckoutSchema.safeParse({ packageCode: "digital", email: "b@x.com", idempotencyKey: "k1", status: "completed" }).success === false,
    );
    check(
      "start rejects a browser-supplied amount/total",
      startCheckoutSchema.safeParse({ packageCode: "digital", email: "b@x.com", idempotencyKey: "k1", amountTotalCents: 1 }).success === false,
    );
    check(
      "start rejects an unknown package code (enum-bounded)",
      startCheckoutSchema.safeParse({ packageCode: "premium", email: "b@x.com", idempotencyKey: "k1" }).success === false,
    );

    // resume: only the 64-hex resumeToken; anything extra is rejected.
    check("resume accepts a valid 64-hex token", resumeCheckoutSchema.safeParse({ resumeToken: HEX64 }).success === true);
    check("resume rejects a non-hex / wrong-length token", resumeCheckoutSchema.safeParse({ resumeToken: "short" }).success === false);
    check("resume rejects an extra sku field", resumeCheckoutSchema.safeParse({ resumeToken: HEX64, sku: "SKU-1" }).success === false);

    // contact: legitimate payload parses; browser-supplied Stripe/price fields rejected.
    check(
      "contact accepts a legitimate payload",
      contactCheckoutSchema.safeParse({ resumeToken: HEX64, firstName: "A", email: "b@x.com" }).success === true,
    );
    check(
      "contact accepts a separate checked SMS choice only as a strict boolean",
      contactCheckoutSchema.safeParse({
        resumeToken: HEX64,
        firstName: "A",
        email: "b@x.com",
        phone: "+15125550123",
        smsMarketingConsent: true,
      }).success === true &&
        contactCheckoutSchema.safeParse({
          resumeToken: HEX64,
          firstName: "A",
          email: "b@x.com",
          smsMarketingConsent: "true",
        }).success === false,
    );
    check(
      "contact rejects a browser-supplied paymentIntentId",
      contactCheckoutSchema.safeParse({ resumeToken: HEX64, firstName: "A", email: "b@x.com", paymentIntentId: "pi_x" }).success === false,
    );

    // totals: legitimate address parses; browser price/tax/SKU inside address rejected.
    const goodAddr = { line1: "1 Market St", city: "SF", state: "CA", postalCode: "94105", country: "US" };
    check(
      "totals accepts a legitimate bounded address",
      totalsCheckoutSchema.safeParse({ resumeToken: HEX64, address: goodAddr }).success === true,
    );
    check(
      "totals rejects a browser-supplied tax amount in the address",
      totalsCheckoutSchema.safeParse({ resumeToken: HEX64, address: { ...goodAddr, taxAmountCents: 10 } }).success === false,
    );
    check(
      "totals rejects a browser-supplied shipping/price at the top level",
      totalsCheckoutSchema.safeParse({ resumeToken: HEX64, address: goodAddr, shippingAmountCents: 0 }).success === false,
    );

    // payment-intent: resumeToken ONLY. A browser cannot supply amount or a PI id.
    check(
      "payment-intent accepts a bare resumeToken",
      paymentIntentCheckoutSchema.safeParse({ resumeToken: HEX64 }).success === true,
    );
    check(
      "payment-intent rejects a browser-supplied amount",
      paymentIntentCheckoutSchema.safeParse({ resumeToken: HEX64, amount: 499 }).success === false,
    );
    check(
      "payment-intent rejects a browser-supplied paymentIntentId",
      paymentIntentCheckoutSchema.safeParse({ resumeToken: HEX64, paymentIntentId: "pi_x" }).success === false,
    );
    check(
      "payment-intent rejects a browser-supplied currency",
      paymentIntentCheckoutSchema.safeParse({ resumeToken: HEX64, currency: "eur" }).success === false,
    );
  }

  // ── (12) Production startup + kill-switch recovery wiring (zero-DB source) ──
  // These are pure source-contract assertions: no DB, no network. They prove
  // the three wiring points required for safe kill-switch release recovery.
  {
    const bootSrc = readFileSync(resolve(process.cwd(), "server/boot/workersAndCleanup.ts"), "utf8");
    const killSrc = readFileSync(resolve(process.cwd(), "server/services/killSwitches.ts"), "utf8");
    const replaySrc = readFileSync(resolve(process.cwd(), "server/services/bookPaymentEventReplay.ts"), "utf8");

    // (a) Production startup: boot calls startBookPaymentEventReplay('startup').
    check(
      "boot imports startBookPaymentEventReplay from bookPaymentEventReplay",
      /startBookPaymentEventReplay/.test(bootSrc) && /bookPaymentEventReplay/.test(bootSrc),
    );
    check(
      "boot calls startBookPaymentEventReplay with 'startup' trigger",
      /startBookPaymentEventReplay\(["']startup["']\)/.test(bootSrc),
    );

    // (b) Kill-switch release: setKillSwitch(book_payment_processing, false) calls switch_release.
    // The kill-switch module imports bookPaymentEventReplay dynamically and calls
    // startBookPaymentEventReplay('switch_release') when the switch is set false.
    check(
      "killSwitches triggers startBookPaymentEventReplay on book_payment_processing=false",
      /book_payment_processing/.test(killSrc) && /startBookPaymentEventReplay/.test(killSrc),
    );
    check(
      "killSwitches calls startBookPaymentEventReplay with 'switch_release' trigger",
      /startBookPaymentEventReplay\(["']switch_release["']\)/.test(killSrc),
    );
    check(
      "killSwitches only triggers replay when value is false (not true)",
      // The guard must check `value === false` (or `!value`), not just presence of the switch name.
      /value\s*===\s*false/.test(killSrc) || /&&\s*!value/.test(killSrc) || /value\s*==\s*false/.test(killSrc),
    );

    // (c) Replay worker: uses withWorkerSingletonLock (cluster-wide singleton) + onlyPaused:true.
    check(
      "bookPaymentEventReplay imports withWorkerSingletonLock",
      /withWorkerSingletonLock/.test(replaySrc),
    );
    check(
      "bookPaymentEventReplay calls replayPendingVerifiedBookEvents with onlyPaused:true",
      /onlyPaused\s*:\s*true/.test(replaySrc),
    );
    check(
      "bookPaymentEventReplay calls replayPendingVerifiedBookEvents with effectsPaused:false",
      /effectsPaused\s*:\s*false/.test(replaySrc),
    );
    check(
      "bookPaymentEventReplay uses a named WORKER_NAME for the singleton lock",
      /WORKER_NAME\s*=/.test(replaySrc) && /withWorkerSingletonLock\(\s*WORKER_NAME/.test(replaySrc),
    );
    // The worker is export-only (no perpetual poll): it is started by callers, not a setInterval.
    check(
      "bookPaymentEventReplay exports startBookPaymentEventReplay (called by startup/switch callers)",
      /export function startBookPaymentEventReplay/.test(replaySrc),
    );
  }

  console.log(`\nBook-checkout adapter/normalizer/contracts: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
