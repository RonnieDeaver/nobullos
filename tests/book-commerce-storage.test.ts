/* test-registration
{
  "name": "Book-commerce storage invariants — contact/checkout/order authority, consent evidence, transitions, entitlements, secure paid delivery (Tasks #5096, #5098, #5102)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Fast (~3-5s) and deterministic under the hermetic per-run test DB (all writes in runInTxSandbox, no network) guarding the authoritative persistence contract for the Task #5096 book-commerce slice: contact upsert derives SMS-consent state/phone/evidenceRef/capturedAt from the trusted sms_consent_ledger (callers cannot assert them), never clears an omitted consent snapshot, refreshes when the ledger state moves, and rejects a missing ledger row / a phone that conflicts with the ledger (ConsentEvidenceConflictError); checkout requires a contact, fail-closed-gates Complete under the production default, and rejects an idempotency replay bound to a different package/contact (IdempotencyConflictError); the order derives package/contact/499-cent financials + attribution + SMS snapshot from checkout+contact, is one-per-checkout, replays the full aggregate; the DB authority scenario executes the foundation migration then the authority-hardening migration (push-first reconciliation: SET NOT NULL + RESTRICT FK rewrites) before raw assertions — so the NOT NULL and FK constraints are tested against a fully reconciled schema; after hardening, the state machine is enforced directly (illegal-edge BEFORE triggers, the DEFERRED protocol verifier that demands the same-transaction lifecycle+outbox evidence — checked via SET CONSTRAINTS IMMEDIATE, passing only when transitionBookOrderStatus wrote them — the append-only lifecycle-events trigger, application/appointment illegal edges, and the sms_consent_evidence_ref FK); entitlement grant derives package/contact from a payment_captured order and rejects an ineligible pending order / incompatible code; payment dedupe is provider-scoped and rejects a mismatched order/checkout link; correlations reject a conflicting mapping. Both task migrations are fingerprinted because the suite executes their DDL inside the rollback sandbox.",
  "scanPaths": [
    "migrations/20260819203532_book_commerce_foundation.sql",
    "migrations/20260819234500_book_commerce_authority_hardening.sql",
    "migrations/20260820010000_book_paid_delivery.sql",
    "server/storage/bookDeliveryStorage.ts",
    "server/services/bookDelivery.ts",
    "server/services/smsConsent.ts"
  ],
  "tier": "small",
  "tierReason": "Deliberately small, overriding the mechanical unmeasured default of medium: this is one deterministic DB test file with no network, every scenario wrapped in a single runInTxSandbox transaction that always rolls back (perfect isolation, zero row leakage), and empirically ~3-5s end to end. There is no measured baseline yet (unmeasured suites mechanically default to medium), so this explicit override records why small is correct."
}
test-registration */
/**
 * Task #5096 — Book Commerce Foundation, storage layer (authoritative signatures).
 *
 * Every scenario runs inside a single runInTxSandbox transaction (rolled back
 * on exit) and reads/writes through getDb(), so the real storage methods run
 * against the live hermetic schema — including the migration-applied freeze
 * TRIGGERS and composite FKs — with zero row leakage and zero network I/O.
 * IDs, order numbers, idempotency keys, emails and provider IDs are randomized
 * per run and every assertion is scoped to those fixture IDs (no ambient
 * totals), so nothing collides across replays or depends on other suites.
 *
 * Migration replay is intentionally NOT re-implemented — tests/
 * migration-replay.test.ts already applies every timestamp migration twice.
 * This suite fingerprints and executes both task migrations because fresh
 * hermetic templates are push-first and intentionally baseline new raw SQL
 * migrations as applied. Scenario (4) executes foundation first, then the
 * authority-hardening companion (which reconciles push-first tables: SET NOT
 * NULL on checkout_session_id / audit_application_id and RESTRICT FK rewrites
 * for the four authority columns). The enclosing sandbox rolls all DDL and
 * fixture writes back together.
 *
 * Covered:
 *   (1)  Contact upsert: SMS-consent state/phone/evidenceRef/capturedAt are
 *        DERIVED from a trusted sms_consent_ledger row (callers pass only
 *        ledgerId + disclosure fields, never state/evidenceRef/capturedAt);
 *        evidenceRef equals the ledger id; an omitted consent snapshot is not
 *        cleared; moving the ledger state and re-upserting the same ledgerId
 *        refreshes the snapshot; a missing ledger row and a caller phone that
 *        conflicts with the ledger both throw ConsentEvidenceConflictError. The
 *        full attribution blueprint + immutable first-touch still hold.
 *   (2)  Checkout requires a contactId; the public function (no gate override)
 *        rejects Complete under the production default; the same idempotency key
 *        with a different package or contact throws IdempotencyConflictError.
 *   (3)  Order derives package/contact/499-cent financials from checkout+catalog
 *        and full first/latest attribution + SMS snapshot from contact+checkout;
 *        one order per checkout; replay returns the complete aggregate; a second
 *        different orderNumber for the same checkout throws IdempotencyConflictError.
 *   (4)  DB authority (migration DDL executed in-sandbox): freeze triggers reject
 *        mutating a valid order total and item metadata; one-item unique + the
 *        composite package-snapshot FK reject second/cross-package items;
 *        checkout_session_id / audit_application_id NOT NULL reject minimal
 *        rows; the BEFORE edge triggers reject an illegal raw order status jump;
 *        the DEFERRED protocol verifier rejects a legal raw status update lacking
 *        the same-transaction lifecycle+outbox evidence (via SET CONSTRAINTS
 *        book_orders_protocol_verify_trg IMMEDIATE) yet passes once
 *        transitionBookOrderStatus wrote them; the append-only trigger rejects a
 *        lifecycle-events UPDATE and DELETE; application/appointment illegal
 *        edges reject; a nonexistent sms_consent_evidence_ref rejects the FK.
 *   (5)  Provider-scoped payment dedupe converges; the same external ID under a
 *        different provider is allowed; a mismatched order/checkout link rejects.
 *   (6)  Entitlement grant (payment_captured order) derives package/contact from
 *        the order (caller cannot forge them), is idempotent, rejects an
 *        incompatible code, and rejects an ineligible pending order.
 *   (7)  Application idempotency + a mismatched contact/order is rejected.
 *   (8)  Appointment upsert/reschedule (no contactId/orderId input) converges to
 *        one row.
 *   (9)  Provider correlation replay converges; a conflicting mapping rejects.
 *
 * The order status state machine is exercised end-to-end inside scenario (4):
 * the storage transitionBookOrderStatus is the positive path that satisfies the
 * DB protocol verifier, so a separate transition-only scenario would duplicate
 * it. Legal application/appointment transitions are exercised via their storage
 * functions in scenarios (7)/(8).
 *
 * Usage: tsx tests/book-commerce-storage.test.ts (under the runner's hermetic DB)
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "book-delivery-test-secret-at-least-32-bytes";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import {
  bookContacts,
  bookOrders,
  bookOrderItems,
  bookLifecycleEvents,
  bookOutbox,
  bookPaymentEvents,
  bookEntitlements,
  bookAppointments,
  bookProviderCorrelations,
  bookDeliveryLinks,
  bookDeliverySessions,
  bookDeliveryAssets,
  bookDeliveryAudit,
  smsConsentLedger,
  smsConsentEvents,
} from "@shared/schema";
import {
  upsertBookContact,
  createBookCheckoutSession,
  createBookOrder,
  orderCreatedLifecycleKey,
  orderCreatedOutboxKey,
  IllegalTransitionError,
  IdempotencyConflictError,
  OrderNotEligibleForEntitlementError,
  CorrelationConflictError,
  ConsentEvidenceConflictError,
  type UpsertContactResult,
  type CreateCheckoutSessionResult,
  type CreateOrderResult,
} from "../server/storage/bookCommerceStorage";
import {
  __setBookLaunchReadinessReportForTest,
  makeReadyBookLaunchReadinessReportForTest,
} from "../server/services/bookLaunchReadiness";
import {
  insertBookPaymentEvent,
  transitionBookOrderStatus,
  grantBookEntitlement,
  revokeBookEntitlement,
  orderTransitionLifecycleKey,
  orderTransitionOutboxKey,
} from "../server/storage/bookCommerceEventStorage";
import {
  createBookDeliveryLink,
  exchangeBookDeliveryLink,
  resolveBookDeliverySession,
  revokeBookDeliveryCredentials,
} from "../server/storage/bookDeliveryStorage";
import {
  BOOK_IMMEDIATE_ACCESS_LINK_TTL_MS,
  createImmediateBookAccessCapabilityForCheckout,
  deriveBookDeliveryToken,
  authorizeBookDeliveryDownload,
  getBookDeliveryOrderStatusForSession,
  hashBookDeliverySession,
  hashBookDeliveryToken,
  listBookDeliveryAssetsForSession,
} from "../server/services/bookDelivery";
import {
  createBookAuditApplication,
  transitionBookAuditApplication,
  upsertBookAppointment,
  insertBookProviderCorrelation,
} from "../server/storage/bookCommerceEngagementStorage";
import {
  PackageNotSelectableError,
  IncompatibleEntitlementError,
} from "../server/services/bookCommerceCatalog";
import {
  BOOK_CHECKOUT_SMS_DISCLOSURE_COPY,
  BOOK_CHECKOUT_SMS_DISCLOSURE_VERSION,
  recordBookCheckoutSmsChoice,
} from "../server/services/smsConsent";

let passed = 0;
let failed = 0;

const BOOK_COMMERCE_FOUNDATION_SQL = readFileSync(
  resolve(process.cwd(), "migrations/20260819203532_book_commerce_foundation.sql"),
  "utf8",
);

const BOOK_COMMERCE_HARDENING_SQL = readFileSync(
  resolve(process.cwd(), "migrations/20260819234500_book_commerce_authority_hardening.sql"),
  "utf8",
);

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

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
function rid(prefix: string): string {
  return `${prefix}-${RUN}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}
function uniqueEmail(): string {
  return `buyer.${rid("e")}@example.com`;
}

async function expectThrows(
  label: string,
  fn: () => Promise<unknown>,
  ctor: new (...a: any[]) => Error,
): Promise<void> {
  try {
    await fn();
    check(label, false, "did not throw");
  } catch (err) {
    check(label, err instanceof ctor, err instanceof Error ? err.name : String(err));
  }
}

/**
 * Assert that a raw DB write is rejected by a constraint / trigger. Such a
 * failure aborts the enclosing Postgres transaction, so we run the write inside
 * a nested transaction (a SAVEPOINT under the sandbox tx): the failure rolls
 * back only to the savepoint and the outer sandbox stays usable for follow-up
 * assertions.
 */
async function expectDbReject(
  label: string,
  write: (tx: any) => Promise<unknown>,
): Promise<void> {
  let threw = false;
  try {
    await getDb().transaction(async (tx: any) => {
      await write(tx);
    });
  } catch {
    threw = true;
  }
  check(label, threw, threw ? "rejected" : "was NOT rejected");
}

/**
 * Fixture: create a fresh contact, a required Digital checkout tied to it, then
 * an order derived from that checkout. All IDs are unique per call. Used by the
 * order/transition/entitlement scenarios so each starts from a clean, valid
 * payment-captured-eligible aggregate anchor.
 */
interface OrderFixture {
  contact: UpsertContactResult;
  checkout: CreateCheckoutSessionResult;
  order: CreateOrderResult;
  orderNumber: string;
}
async function makeDigitalOrder(): Promise<OrderFixture> {
  const contact = await upsertBookContact({ email: uniqueEmail(), name: "Fixture Buyer" });
  const checkout = await createBookCheckoutSession({
    contactId: contact.contact.id,
    packageCode: "digital",
    idempotencyKey: rid("chk"),
  });
  const orderNumber = rid("ORD");
  const order = await createBookOrder({ checkoutSessionId: checkout.session.id, orderNumber });
  return { contact, checkout, order, orderNumber };
}

async function main(): Promise<void> {
  console.log("Book-commerce storage invariants (Task #5096)");
  __setBookLaunchReadinessReportForTest(makeReadyBookLaunchReadinessReportForTest());

  // ── (1) Contact upsert: trusted ledger-derived consent + blueprint ──────────
  await runInTxSandbox(async () => {
    const rawEmail = `Buyer.${RUN}@Example.COM`;
    const normalized = rawEmail.toLowerCase();

    // Seed a trusted sms_consent_ledger row directly (the consent authority).
    const ledgerId = rid("ledger");
    const phone = `+1512${Math.floor(1000000 + Math.random() * 8999999)}`;
    const ledgerUpdatedAt = new Date("2026-08-01T12:00:00.000Z");
    await getDb()
      .insert(smsConsentLedger)
      .values({
        id: ledgerId,
        phoneNormalized: phone,
        phoneMatchKey: phone.slice(-10),
        state: "opted_in",
        source: "book-commerce-test",
        evidence: "seed-evidence",
        updatedAt: ledgerUpdatedAt,
      });

    const first = await upsertBookContact({
      email: rawEmail,
      name: "First Name",
      firstTouch: {
        utmSource: "google",
        utmCampaign: "launch",
        landingUrl: "https://ex.com/lp",
        gbraid: "GB123",
        wbraid: "WB456",
        sessionId: "sess-1",
        deviceId: "dev-1",
      },
      latestTouch: { utmSource: "google", utmMedium: "cpc" },
      // Trusted signature: ledgerId + disclosure fields ONLY. Never
      // state/evidenceRef/capturedAt — those come from the ledger.
      smsConsent: {
        ledgerId,
        copyVersion: "v2",
        sourceUrl: "https://ex.com/consent",
        confirmationStatus: "confirmed",
      },
    });
    check("first upsert reports created", first.created === true);
    check("email is normalized (lowercase)", first.contact.email === normalized);
    // Full attribution blueprint (the newly-required fields).
    check("first-touch landingUrl stamped", first.contact.firstTouchLandingUrl === "https://ex.com/lp");
    check("first-touch gbraid stamped", first.contact.firstTouchGbraid === "GB123");
    check("first-touch wbraid stamped", first.contact.firstTouchWbraid === "WB456");
    check("first-touch sessionId stamped", first.contact.firstTouchSessionId === "sess-1");
    check("first-touch deviceId stamped", first.contact.firstTouchDeviceId === "dev-1");
    check("latest-touch medium stamped", first.contact.latestTouchUtmMedium === "cpc");
    // Authority fields DERIVED from the ledger (not caller-asserted).
    check("consent phone derived from ledger", first.contact.phone === phone);
    check("consent state derived from ledger (opted_in)", first.contact.smsConsentState === "opted_in");
    check("consent evidenceRef equals ledger id", first.contact.smsConsentEvidenceRef === ledgerId);
    check("consent capturedAt derived from ledger updatedAt", first.contact.smsConsentCapturedAt?.getTime() === ledgerUpdatedAt.getTime());
    // Caller disclosure fields are stamped verbatim.
    check("consent copyVersion stamped from input", first.contact.smsConsentCopyVersion === "v2");
    check("consent sourceUrl stamped from input", first.contact.smsConsentSourceUrl === "https://ex.com/consent");
    check("consent confirmationStatus stamped from input", first.contact.smsConsentConfirmationStatus === "confirmed");

    // Second touch (same email, no consent snapshot, partial latest):
    // first-touch + the consent snapshot must survive; only supplied latest updates.
    const second = await upsertBookContact({
      email: `BUYER.${RUN}@example.com`,
      latestTouch: { utmSource: "newsletter" },
    });
    check("second upsert reports NOT created (same row)", second.created === false);
    check("same contact id on conflict", second.contact.id === first.contact.id);
    check("first-touch campaign preserved", second.contact.firstTouchUtmCampaign === "launch");
    check("first-touch landingUrl preserved", second.contact.firstTouchLandingUrl === "https://ex.com/lp");
    check("latest-touch source updated to newsletter", second.contact.latestTouchUtmSource === "newsletter");
    check("omitted latest-touch medium keeps prior value (cpc)", second.contact.latestTouchUtmMedium === "cpc");
    // Omitted consent snapshot is NOT cleared.
    check("omitted consent state preserved (opted_in)", second.contact.smsConsentState === "opted_in");
    check("omitted consent evidenceRef preserved (ledger id)", second.contact.smsConsentEvidenceRef === ledgerId);
    check("omitted consent confirmationStatus preserved", second.contact.smsConsentConfirmationStatus === "confirmed");
    check("identity name preserved when omitted", second.contact.name === "First Name");

    // Move the ledger state, then re-upsert with the SAME ledgerId: the trusted
    // snapshot must refresh from the new ledger state.
    const ledgerUpdated2 = new Date("2026-08-15T09:30:00.000Z");
    await getDb()
      .update(smsConsentLedger)
      .set({ state: "opted_out", updatedAt: ledgerUpdated2 })
      .where(eq(smsConsentLedger.id, ledgerId));
    const third = await upsertBookContact({ email: normalized, smsConsent: { ledgerId } });
    check("re-upsert refreshes consent state from ledger (opted_out)", third.contact.smsConsentState === "opted_out");
    check("re-upsert refreshes capturedAt from ledger", third.contact.smsConsentCapturedAt?.getTime() === ledgerUpdated2.getTime());
    check("evidenceRef still equals ledger id after refresh", third.contact.smsConsentEvidenceRef === ledgerId);

    // Negative: a consent pointer to a non-existent ledger row is rejected.
    await expectThrows(
      "missing ledger row throws ConsentEvidenceConflictError",
      () => upsertBookContact({ email: uniqueEmail(), smsConsent: { ledgerId: rid("no-ledger") } }),
      ConsentEvidenceConflictError,
    );

    // Negative: a caller phone that conflicts with the ledger phone is rejected.
    await expectThrows(
      "mismatched phone vs ledger throws ConsentEvidenceConflictError",
      () => upsertBookContact({ email: uniqueEmail(), phone: "+15550000000", smsConsent: { ledgerId } }),
      ConsentEvidenceConflictError,
    );
  });

  // ── (1b) Checkout SMS choice: evidence, pending DOI, preservation ───────────
  await runInTxSandbox(async () => {
    const selectedAt = new Date("2026-08-20T14:15:16.000Z");
    const selectedPhone = `+1513${Math.floor(1000000 + Math.random() * 8999999)}`;
    const selected = await recordBookCheckoutSmsChoice({
      phone: selectedPhone,
      selected: true,
      capturedAt: selectedAt,
      sourceUrl: "https://nobullmarketing.com/book/checkout/",
      ipAddress: "203.0.113.10",
      userAgent: "checkout-consent-test",
    });
    if ("error" in selected) throw new Error(selected.error);
    check("checkout-selected ledger starts unknown pending double opt-in", selected.state === "unknown");
    check("checkout-selected snapshot status is pending", selected.confirmationStatus === "pending");
    const [selectedLedger] = await getDb()
      .select()
      .from(smsConsentLedger)
      .where(eq(smsConsentLedger.id, selected.ledgerId))
      .limit(1);
    const evidence = JSON.parse(selectedLedger.evidence) as Record<string, unknown>;
    check(
      "checkout-selected evidence carries approved disclosure version",
      evidence.disclosureVersion === BOOK_CHECKOUT_SMS_DISCLOSURE_VERSION,
    );
    check("checkout evidence records selected=true", evidence.selected === true);
    check(
      "checkout evidence records exact approved disclosure",
      evidence.disclosureCopy === BOOK_CHECKOUT_SMS_DISCLOSURE_COPY,
    );
    check(
      "checkout evidence records source page and timestamp",
      evidence.sourceUrl === "https://nobullmarketing.com/book/checkout/" &&
        evidence.capturedAt === selectedAt.toISOString(),
    );
    check(
      "checkout evidence records request IP and user agent",
      evidence.ipAddress === "203.0.113.10" &&
        evidence.userAgent === "checkout-consent-test",
    );

    const [event] = await getDb()
      .select()
      .from(smsConsentEvents)
      .where(
        and(
          eq(smsConsentEvents.phoneNormalized, selected.phoneE164),
          eq(smsConsentEvents.eventType, "checkout_choice"),
        ),
      )
      .limit(1);
    check(
      "checkout choice appends canonical event evidence",
      event?.source === "book_checkout" &&
        event?.detail?.includes(BOOK_CHECKOUT_SMS_DISCLOSURE_VERSION) === true,
    );

    await getDb()
      .update(smsConsentLedger)
      .set({ state: "opted_out" })
      .where(eq(smsConsentLedger.id, selected.ledgerId));
    const preservedOptOut = await recordBookCheckoutSmsChoice({
      phone: selectedPhone,
      selected: true,
      capturedAt: new Date(selectedAt.getTime() + 1000),
      sourceUrl: "https://nobullmarketing.com/book/checkout/",
      ipAddress: null,
      userAgent: null,
    });
    if ("error" in preservedOptOut) throw new Error(preservedOptOut.error);
    check(
      "checkout choice never overwrites an existing authoritative opt-out",
      preservedOptOut.state === "opted_out",
    );
    check(
      "checked choice remains pending until independent opt-in confirmation",
      preservedOptOut.confirmationStatus === "pending",
    );

    const declinedPhone = `+1514${Math.floor(1000000 + Math.random() * 8999999)}`;
    const declined = await recordBookCheckoutSmsChoice({
      phone: declinedPhone,
      selected: false,
      capturedAt: selectedAt,
      sourceUrl: "https://nobullmarketing.com/book/checkout/",
      ipAddress: null,
      userAgent: null,
    });
    if ("error" in declined) throw new Error(declined.error);
    const [declinedLedger] = await getDb()
      .select()
      .from(smsConsentLedger)
      .where(eq(smsConsentLedger.id, declined.ledgerId))
      .limit(1);
    const declinedEvidence = JSON.parse(declinedLedger.evidence) as Record<string, unknown>;
    check(
      "unchecked choice is evidence-only unknown, never an opt-in",
      declined.state === "unknown" &&
        declined.confirmationStatus === "declined" &&
        declinedEvidence.selected === false,
    );

    const invalid = await recordBookCheckoutSmsChoice({
      phone: "not-a-phone",
      selected: true,
      capturedAt: selectedAt,
      sourceUrl: "https://nobullmarketing.com/book/checkout/",
      ipAddress: null,
      userAgent: null,
    });
    check(
      "checkout choice rejects an invalid phone",
      "error" in invalid && invalid.error.includes("valid mobile number"),
    );
  });

  // ── (2) Checkout requires contact; production gate; idempotency conflicts ───
  await runInTxSandbox(async () => {
    const contact = await upsertBookContact({ email: uniqueEmail() });
    const key = rid("chk");
    const a = await createBookCheckoutSession({
      contactId: contact.contact.id,
      packageCode: "digital",
      idempotencyKey: key,
    });
    check("checkout create reports created", a.created === true);
    check("checkout amount is the 499-cent digital price", a.session.amountTotalCents === 499);

    // Same key, same package + contact → converges.
    const b = await createBookCheckoutSession({
      contactId: contact.contact.id,
      packageCode: "digital",
      idempotencyKey: key,
    });
    check("checkout replay converges (created:false)", b.created === false && b.session.id === a.session.id);

    // Enable the modeled Complete package only long enough to reach the
    // idempotency identity check; otherwise the fail-closed gate correctly wins.
    const priorEnabled = process.env.BOOK_COMMERCE_COMPLETE_ENABLED;
    const priorApproved = process.env.BOOK_COMMERCE_COMPLETE_APPROVED;
    const priorShipping = process.env.BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS;
    process.env.BOOK_COMMERCE_COMPLETE_ENABLED = "true";
    process.env.BOOK_COMMERCE_COMPLETE_APPROVED = "true";
    process.env.BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS = "0";
    try {
      await expectThrows(
        "checkout replay with a different package throws IdempotencyConflictError",
        () =>
          createBookCheckoutSession({
            contactId: contact.contact.id,
            packageCode: "complete",
            idempotencyKey: key,
          }),
        IdempotencyConflictError,
      );
    } finally {
      if (priorEnabled === undefined) delete process.env.BOOK_COMMERCE_COMPLETE_ENABLED;
      else process.env.BOOK_COMMERCE_COMPLETE_ENABLED = priorEnabled;
      if (priorApproved === undefined) delete process.env.BOOK_COMMERCE_COMPLETE_APPROVED;
      else process.env.BOOK_COMMERCE_COMPLETE_APPROVED = priorApproved;
      if (priorShipping === undefined) delete process.env.BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS;
      else process.env.BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS = priorShipping;
    }

    // Same key, DIFFERENT contact → IdempotencyConflictError.
    const other = await upsertBookContact({ email: uniqueEmail() });
    await expectThrows(
      "checkout replay with a different contact throws IdempotencyConflictError",
      () =>
        createBookCheckoutSession({
          contactId: other.contact.id,
          packageCode: "digital",
          idempotencyKey: key,
        }),
      IdempotencyConflictError,
    );

    // Production default gate: temporarily clear both env flags so the public
    // function (no override) rejects Complete; restore in finally.
    const prevEnabled = process.env.BOOK_COMMERCE_COMPLETE_ENABLED;
    const prevApproved = process.env.BOOK_COMMERCE_COMPLETE_APPROVED;
    delete process.env.BOOK_COMMERCE_COMPLETE_ENABLED;
    delete process.env.BOOK_COMMERCE_COMPLETE_APPROVED;
    try {
      await expectThrows(
        "disabled Complete checkout is rejected by the production gate",
        () =>
          createBookCheckoutSession({
            contactId: contact.contact.id,
            packageCode: "complete",
            idempotencyKey: rid("chk-complete"),
          }),
        PackageNotSelectableError,
      );
    } finally {
      if (prevEnabled === undefined) delete process.env.BOOK_COMMERCE_COMPLETE_ENABLED;
      else process.env.BOOK_COMMERCE_COMPLETE_ENABLED = prevEnabled;
      if (prevApproved === undefined) delete process.env.BOOK_COMMERCE_COMPLETE_APPROVED;
      else process.env.BOOK_COMMERCE_COMPLETE_APPROVED = prevApproved;
    }
  });

  // ── (3) Order derives everything; one-per-checkout; replay; number conflict ─
  await runInTxSandbox(async () => {
    const ledgerId = rid("ledger");
    const phone = `+1512${Math.floor(1000000 + Math.random() * 8999999)}`;
    await getDb()
      .insert(smsConsentLedger)
      .values({
        id: ledgerId,
        phoneNormalized: phone,
        phoneMatchKey: phone.slice(-10),
        state: "opted_in",
        source: "book-commerce-test",
      });
    const contact = await upsertBookContact({
      email: uniqueEmail(),
      firstTouch: { utmSource: "google", landingUrl: "https://ex.com/lp" },
      latestTouch: { utmSource: "contact-latest" },
      smsConsent: { ledgerId },
    });
    const checkout = await createBookCheckoutSession({
      contactId: contact.contact.id,
      packageCode: "digital",
      idempotencyKey: rid("chk"),
      currentTouch: { utmSource: "checkout-current", utmMedium: "email" },
    });
    const orderNumber = rid("ORD");
    const created = await createBookOrder({ checkoutSessionId: checkout.session.id, orderNumber });

    // Derived package/contact/financials.
    check("order package derived from checkout (digital)", created.order.packageCode === "digital");
    check("order contact derived from checkout", created.order.contactId === contact.contact.id);
    check("order total is 499 cents (catalog)", created.order.totalAmountCents === 499);
    check("order subtotal is 499 cents", created.order.subtotalAmountCents === 499);
    check("order item snapshot is 499 cents", created.item.unitPriceCents === 499);
    check("order item line total is 499 cents", created.item.lineTotalCents === 499);
    check("order status starts pending_payment", created.order.status === "pending_payment");
    check("lifecycle event is order_created", created.lifecycleEvent.eventType === "order_created");
    check("outbox event is order.created", created.outboxEntry.eventType === "order.created");

    // Attribution + SMS snapshot derived from contact + checkout.
    check("order first-touch derived from contact", created.order.firstTouchUtmSource === "google");
    check("order first-touch landingUrl derived from contact", created.order.firstTouchLandingUrl === "https://ex.com/lp");
    check("order latest-touch prefers checkout current-touch", created.order.latestTouchUtmSource === "checkout-current");
    check("order latest-touch medium from checkout current-touch", created.order.latestTouchUtmMedium === "email");
    check("order sms consent snapshot from contact", created.order.smsConsentState === "opted_in");
    check("order sms consent evidenceRef from contact (ledger id)", created.order.smsConsentEvidenceRef === ledgerId);

    // Replay (same checkout + same orderNumber) → complete aggregate, same rows.
    const replay = await createBookOrder({ checkoutSessionId: checkout.session.id, orderNumber });
    check("order replay returns same order id", replay.order.id === created.order.id);
    check("order replay returns same item id", replay.item.id === created.item.id);

    // Exactly one order per checkout / one item / one lifecycle / one outbox.
    const orders = await getDb().select().from(bookOrders).where(eq(bookOrders.checkoutSessionId, checkout.session.id));
    check("exactly one order for the checkout", orders.length === 1);
    const items = await getDb().select().from(bookOrderItems).where(eq(bookOrderItems.orderId, created.order.id));
    check("exactly one order item row", items.length === 1);
    const lc = await getDb().select().from(bookLifecycleEvents).where(eq(bookLifecycleEvents.idempotencyKey, orderCreatedLifecycleKey(created.order.id)));
    check("exactly one order_created lifecycle row", lc.length === 1);
    const ob = await getDb().select().from(bookOutbox).where(eq(bookOutbox.idempotencyKey, orderCreatedOutboxKey(created.order.id)));
    check("exactly one order.created outbox row", ob.length === 1);

    // A second DIFFERENT orderNumber for the same checkout → conflict.
    await expectThrows(
      "second orderNumber for the same checkout throws IdempotencyConflictError",
      () => createBookOrder({ checkoutSessionId: checkout.session.id, orderNumber: rid("ORD2") }),
      IdempotencyConflictError,
    );
  });

  // ── (4) DB authority: financial freeze, item integrity, state machine ───────
  //
  // Foundation DDL is executed first (triggers, composite FKs, protocol
  // verifier). Then the authority-hardening migration reconciles the push-first
  // table shape: the DO blocks are no-ops when columns are already NOT NULL /
  // FKs already RESTRICT (push-first hardened schema), and apply SET NOT NULL
  // + RESTRICT FK rewrites when coming from the nullable push-first baseline.
  // All raw assertions therefore run against the fully reconciled schema.
  await runInTxSandbox(async () => {
    await getDb().execute(sql.raw(BOOK_COMMERCE_FOUNDATION_SQL));
    await getDb().execute(sql.raw(BOOK_COMMERCE_HARDENING_SQL));

    const fx = await makeDigitalOrder();
    const orderId = fx.order.order.id;
    const itemId = fx.order.item.id;

    // ---- Financial immutability (freeze triggers) --------------------------
    // Freeze trigger rejects mutating a VALID (unchanged-value-shaped) total.
    await expectDbReject(
      "mutating a valid order total is rejected by the freeze trigger",
      (tx) => tx.update(bookOrders).set({ totalAmountCents: 999 }).where(eq(bookOrders.id, orderId)),
    );
    // Freeze trigger rejects ANY item update — even to free-form metadata.
    await expectDbReject(
      "mutating item metadata is rejected by the freeze trigger",
      (tx) => tx.update(bookOrderItems).set({ metadata: { tampered: true } }).where(eq(bookOrderItems.id, itemId)),
    );

    // ---- Item-integrity constraints ----------------------------------------
    // A second item for the SAME order rejects on the one-item unique index.
    await expectDbReject(
      "a second item for the same order is rejected by the one-item unique",
      (tx) =>
        tx.insert(bookOrderItems).values({
          orderId,
          packageCode: "digital",
          packageLabel: "Digital Edition",
          quantity: 1,
          unitPriceCents: 499,
          lineTotalCents: 499,
          currency: "USD",
          discountAmountCents: 0,
        }),
    );
    // A cross-package item (complete price under a digital order) rejects on
    // the composite package-snapshot FK (order pkg/currency/subtotal mismatch).
    await expectDbReject(
      "a cross-package item is rejected by the composite package-snapshot FK",
      (tx) =>
        tx.insert(bookOrderItems).values({
          orderId,
          packageCode: "complete",
          packageLabel: "Complete Collection",
          quantity: 1,
          unitPriceCents: 1999,
          lineTotalCents: 1999,
          currency: "USD",
          discountAmountCents: 0,
        }),
    );

    // ---- Authority NOT NULL columns ----------------------------------------
    // A minimally valid order that omits checkout_session_id rejects NOT NULL.
    await expectDbReject(
      "order insert omitting checkout_session_id rejects NOT NULL",
      (tx) =>
        tx.execute(sql`
          INSERT INTO book_orders
            (order_number, package_code, subtotal_amount_cents, total_amount_cents, currency, status)
          VALUES (${rid("ORDX")}, 'digital', 499, 499, 'USD', 'pending_payment')
        `),
    );
    // A minimally valid appointment that omits audit_application_id rejects NOT NULL.
    await expectDbReject(
      "appointment insert omitting audit_application_id rejects NOT NULL",
      (tx) => tx.execute(sql`INSERT INTO book_appointments (status) VALUES ('pending')`),
    );

    // ---- Order status state machine (raw + deferred protocol verifier) ------
    // An illegal raw status jump (pending_payment → fulfilled) rejects on the
    // BEFORE-UPDATE edge guard.
    await expectDbReject(
      "raw illegal order status jump (pending_payment→fulfilled) rejects edge trigger",
      (tx) => tx.execute(sql`UPDATE book_orders SET status = 'fulfilled' WHERE id = ${orderId}`),
    );

    // A LEGAL raw status update with NO lifecycle/outbox evidence must reject
    // via the DEFERRED protocol verifier — forced to fire mid-transaction with
    // SET CONSTRAINTS … IMMEDIATE inside the savepoint.
    await expectDbReject(
      "raw legal transition without lifecycle/outbox rejects the deferred protocol verifier",
      async (tx) => {
        await tx.execute(sql`UPDATE book_orders SET status = 'payment_captured' WHERE id = ${orderId}`);
        await tx.execute(sql`SET CONSTRAINTS book_orders_protocol_verify_trg IMMEDIATE`);
      },
    );

    // The order is still pending_payment after the rejected raw updates.
    const [afterRaw] = await getDb().select().from(bookOrders).where(eq(bookOrders.id, orderId));
    check("order status unchanged after rejected raw transitions", afterRaw.status === "pending_payment");

    // The storage path DOES write the mandated lifecycle + outbox evidence, so
    // the same deferred verifier passes when forced immediate.
    const ok = await transitionBookOrderStatus({ orderId, fromStatus: "pending_payment", toStatus: "payment_captured" });
    check("storage transition succeeds under live triggers", ok.transitioned === true);
    check("storage transition advanced to payment_captured", ok.order?.status === "payment_captured");
    let verifierPassed = true;
    try {
      await getDb().execute(sql`SET CONSTRAINTS book_orders_protocol_verify_trg IMMEDIATE`);
    } catch {
      verifierPassed = false;
    }
    check("deferred protocol verifier passes because storage wrote the evidence", verifierPassed);
    const lc = await getDb().select().from(bookLifecycleEvents).where(eq(bookLifecycleEvents.idempotencyKey, orderTransitionLifecycleKey(orderId, "pending_payment", "payment_captured")));
    check("storage transition wrote exactly one lifecycle row", lc.length === 1);
    const ob = await getDb().select().from(bookOutbox).where(eq(bookOutbox.idempotencyKey, orderTransitionOutboxKey(orderId, "pending_payment", "payment_captured")));
    check("storage transition wrote exactly one outbox row", ob.length === 1);

    // ---- Append-only lifecycle-events audit trigger ------------------------
    const anyLifecycle = lc[0];
    await expectDbReject(
      "updating a lifecycle-events row rejects the append-only trigger",
      (tx) => tx.execute(sql`UPDATE book_lifecycle_events SET reason = 'tamper' WHERE id = ${anyLifecycle.id}`),
    );
    await expectDbReject(
      "deleting a lifecycle-events row rejects the append-only trigger",
      (tx) => tx.execute(sql`DELETE FROM book_lifecycle_events WHERE id = ${anyLifecycle.id}`),
    );

    // ---- Application + appointment illegal edges (raw) ----------------------
    const app = await createBookAuditApplication({ contactId: fx.contact.contact.id, orderId, idempotencyKey: rid("app-edge") });
    await expectDbReject(
      "raw illegal application edge (draft→qualified) rejects edge trigger",
      (tx) => tx.execute(sql`UPDATE book_audit_applications SET status = 'qualified' WHERE id = ${app.application.id}`),
    );
    const appt = await upsertBookAppointment({
      auditApplicationId: app.application.id,
      scheduledAt: new Date(Date.now() + 30 * 86_400_000),
    });
    await expectDbReject(
      "raw illegal appointment edge (pending→completed) rejects edge trigger",
      (tx) => tx.execute(sql`UPDATE book_appointments SET status = 'completed' WHERE id = ${appt.appointment.id}`),
    );

    // ---- sms_consent_evidence_ref FK ---------------------------------------
    // A nonexistent evidence pointer rejects the RESTRICT FK to the ledger.
    // (sms_consent_evidence_ref is not a frozen financial column, so the freeze
    //  trigger permits the UPDATE and the FK is what rejects.)
    await expectDbReject(
      "order sms_consent_evidence_ref pointing at a nonexistent ledger row rejects the FK",
      (tx) => tx.execute(sql`UPDATE book_orders SET sms_consent_evidence_ref = 'nonexistent' WHERE id = ${orderId}`),
    );

    // Item snapshot integrity survived every rejected mutation above.
    const allItems = await getDb().select().from(bookOrderItems).where(eq(bookOrderItems.orderId, orderId));
    check("still exactly one item after rejected second/cross-package inserts", allItems.length === 1);
  });

  // ── (5) Payment dedupe (provider-scoped) + mismatched link rejection ────────
  await runInTxSandbox(async () => {
    const extId = rid("evt");
    const a = await insertBookPaymentEvent({ provider: "stripe", providerEventId: extId, eventType: "payment_intent_succeeded" });
    check("first payment event inserted", a.inserted === true);
    const b = await insertBookPaymentEvent({ provider: "stripe", providerEventId: extId, eventType: "payment_intent_succeeded" });
    check("payment event replay converges (inserted:false)", b.inserted === false);
    const c = await insertBookPaymentEvent({ provider: "paypal", providerEventId: extId, eventType: "payment_intent_succeeded" });
    check("same external ID under a different provider is allowed", c.inserted === true);

    const rows = await getDb().select().from(bookPaymentEvents).where(eq(bookPaymentEvents.providerEventId, extId));
    check("exactly two payment rows for the shared external ID", rows.length === 2);

    // Mismatched order/checkout link: an order that references a DIFFERENT
    // checkout than the one supplied → rejected before insert.
    const fx = await makeDigitalOrder();
    await expectThrows(
      "payment event with a mismatched order/checkout link throws IdempotencyConflictError",
      () =>
        insertBookPaymentEvent({
          provider: "stripe",
          providerEventId: rid("evt-mismatch"),
          eventType: "payment_intent_succeeded",
          orderId: fx.order.order.id,
          checkoutSessionId: rid("wrong-checkout"),
        }),
      IdempotencyConflictError,
    );
  });

  // ── (5b) Storage-layer transition guard (application validator + CAS miss) ──
  // The DB trigger illegal-edge, the legal positive path, and its lifecycle +
  // outbox evidence are proven directly in scenario (4); this scenario keeps
  // only the storage-layer behavior that is NOT a DB trigger: the pre-DB
  // IllegalTransitionError from the TS validator (nothing is mutated) and the
  // stale-CAS no-op.
  await runInTxSandbox(async () => {
    const fx = await makeDigitalOrder();
    const orderId = fx.order.order.id;

    await expectThrows(
      "storage transition rejects an illegal edge with IllegalTransitionError (pre-DB)",
      () => transitionBookOrderStatus({ orderId, fromStatus: "pending_payment", toStatus: "fulfilled" }),
      IllegalTransitionError,
    );
    const afterIllegal = await getDb().select().from(bookLifecycleEvents).where(eq(bookLifecycleEvents.orderId, orderId));
    check("illegal transition left the lifecycle log untouched (only order_created)", afterIllegal.length === 1);
    const [orderStill] = await getDb().select().from(bookOrders).where(eq(bookOrders.id, orderId));
    check("order status unchanged after illegal attempt", orderStill.status === "pending_payment");

    // Stale-CAS (wrong fromStatus) is a legal target but non-matching guard →
    // a no-op that returns transitioned:false without side effects.
    const miss = await transitionBookOrderStatus({ orderId, fromStatus: "payment_captured", toStatus: "fulfillment_queued" });
    check("stale CAS miss returns transitioned:false", miss.transitioned === false);
    const [stillPending] = await getDb().select().from(bookOrders).where(eq(bookOrders.id, orderId));
    check("stale CAS miss did not change status", stillPending.status === "pending_payment");
  });

  // ── (6) Entitlement grant derives package/contact; ineligibility rejects ────
  await runInTxSandbox(async () => {
    // Ineligible pending order is rejected before any grant.
    const pending = await makeDigitalOrder();
    await expectThrows(
      "granting on a pending_payment order throws OrderNotEligibleForEntitlementError",
      () => grantBookEntitlement({ orderId: pending.order.order.id, entitlementCode: "digital_book" }),
      OrderNotEligibleForEntitlementError,
    );

    // Advance to payment_captured, then grant using ONLY orderId + code.
    const fx = await makeDigitalOrder();
    const orderId = fx.order.order.id;
    await transitionBookOrderStatus({ orderId, fromStatus: "pending_payment", toStatus: "payment_captured" });

    const g1 = await grantBookEntitlement({ orderId, entitlementCode: "digital_book" });
    check("entitlement granted on first call", g1.granted === true);
    // package/contact are DERIVED from the order — caller cannot forge them.
    check("granted entitlement package derived from order (digital)", g1.entitlement.packageCode === "digital");
    check("granted entitlement contact derived from order", g1.entitlement.contactId === fx.contact.contact.id);

    const g2 = await grantBookEntitlement({ orderId, entitlementCode: "digital_book" });
    check("entitlement grant is idempotent (granted:false)", g2.granted === false && g2.entitlement.id === g1.entitlement.id);

    const active = await getDb().select().from(bookEntitlements).where(and(eq(bookEntitlements.orderId, orderId), eq(bookEntitlements.status, "active")));
    check("exactly one active entitlement on the order", active.length === 1);

    // A digital order cannot grant audiobook (derived-package incompatibility).
    await expectThrows(
      "digital order cannot grant audiobook (IncompatibleEntitlementError)",
      () => grantBookEntitlement({ orderId, entitlementCode: "audiobook" }),
      IncompatibleEntitlementError,
    );
  });

  // ── (7) Secure paid delivery: hash-only, single-use, live revoke gate ──────
  await runInTxSandbox(async () => {
    const fx = await makeDigitalOrder();
    const orderId = fx.order.order.id;
    await transitionBookOrderStatus({ orderId, fromStatus: "pending_payment", toStatus: "payment_captured" });
    const grant = await grantBookEntitlement({ orderId, entitlementCode: "digital_book" });
    const immediateStartedAt = Date.now();
    const immediateToken = await createImmediateBookAccessCapabilityForCheckout(
      fx.checkout.session.id,
    );
    const [immediateLink] = await getDb()
      .select()
      .from(bookDeliveryLinks)
      .where(
        and(
          eq(bookDeliveryLinks.entitlementId, grant.entitlement.id),
          eq(bookDeliveryLinks.purpose, "reissue"),
        ),
      )
      .limit(1);
    check(
      "verified-checkout access capability is hash-only and five-minute bounded",
      typeof immediateToken === "string" &&
        immediateLink?.tokenHash === hashBookDeliveryToken(immediateToken) &&
        immediateLink.expiresAt.getTime() >=
          immediateStartedAt + BOOK_IMMEDIATE_ACCESS_LINK_TTL_MS - 1000 &&
        immediateLink.expiresAt.getTime() <=
          Date.now() + BOOK_IMMEDIATE_ACCESS_LINK_TTL_MS + 1000,
    );
    const key = rid("delivery-initial");
    const token = deriveBookDeliveryToken(grant.entitlement.id, key);
    const tokenHash = hashBookDeliveryToken(token);
    const first = await createBookDeliveryLink({
      entitlementId: grant.entitlement.id,
      purpose: "initial",
      idempotencyKey: key,
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const duplicate = await createBookDeliveryLink({
      entitlementId: grant.entitlement.id,
      purpose: "initial",
      idempotencyKey: key,
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    });
    check(
      "delivery link stores evidence rather than raw capability and converges on idempotent replay",
      first.created && !duplicate.created && first.link.id === duplicate.link.id &&
        first.link.tokenHash === tokenHash && !first.link.tokenHash.includes(token),
    );

    const session = `session-${rid("delivery")}`;
    const redeemed = await exchangeBookDeliveryLink({
      tokenHash,
      sessionHash: hashBookDeliverySession(session),
      sessionExpiresAt: new Date(Date.now() + 60_000),
    });
    check("delivery capability exchanges once into a browser-session hash", redeemed?.entitlementId === grant.entitlement.id);
    const replay = await exchangeBookDeliveryLink({
      tokenHash,
      sessionHash: hashBookDeliverySession(`${session}-replay`),
      sessionExpiresAt: new Date(Date.now() + 60_000),
    });
    check("redeemed delivery capability cannot be replayed", replay === null);
    const liveSession = await resolveBookDeliverySession(hashBookDeliverySession(session));
    check("exchanged session is live while entitlement remains active", liveSession?.id === grant.entitlement.id);

    await revokeBookDeliveryCredentials({
      entitlementIds: [grant.entitlement.id],
      reason: "test_refund",
    });
    const revokedSession = await resolveBookDeliverySession(hashBookDeliverySession(session));
    const [link] = await getDb().select().from(bookDeliveryLinks).where(eq(bookDeliveryLinks.id, first.link.id));
    const sessions = await getDb().select().from(bookDeliverySessions)
      .where(eq(bookDeliverySessions.entitlementId, grant.entitlement.id));
    check(
      "revocation deterministically invalidates prior links and sessions",
      revokedSession === null && !!link.revokedAt && sessions.every((row) => !!row.revokedAt),
    );

    const expiredKey = rid("delivery-expired");
    const expiredToken = deriveBookDeliveryToken(grant.entitlement.id, expiredKey);
    await createBookDeliveryLink({
      entitlementId: grant.entitlement.id,
      purpose: "resend",
      idempotencyKey: expiredKey,
      tokenHash: hashBookDeliveryToken(expiredToken),
      expiresAt: new Date(Date.now() - 1_000),
    });
    const expired = await exchangeBookDeliveryLink({
      tokenHash: hashBookDeliveryToken(expiredToken),
      sessionHash: hashBookDeliverySession(`expired-${session}`),
      sessionExpiresAt: new Date(Date.now() + 60_000),
    });
    check("expired delivery capability is denied uniformly", expired === null);
  });

  // ── (7b) Access center: order-scoped rights, asset gates, safe summary ──────
  await runInTxSandbox(async () => {
    const priorEnabled = process.env.BOOK_COMMERCE_COMPLETE_ENABLED;
    const priorApproved = process.env.BOOK_COMMERCE_COMPLETE_APPROVED;
    const priorShipping = process.env.BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS;
    process.env.BOOK_COMMERCE_COMPLETE_ENABLED = "true";
    process.env.BOOK_COMMERCE_COMPLETE_APPROVED = "true";
    process.env.BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS = "0";
    let fx: OrderFixture;
    try {
      const contact = await upsertBookContact({
        email: uniqueEmail(),
        name: "Private Complete Buyer",
      });
      const checkout = await createBookCheckoutSession({
        contactId: contact.contact.id,
        packageCode: "complete",
        idempotencyKey: rid("complete-checkout"),
      });
      const orderNumber = rid("COMPLETE");
      const order = await createBookOrder({
        checkoutSessionId: checkout.session.id,
        orderNumber,
      });
      fx = { contact, checkout, order, orderNumber };
    } finally {
      if (priorEnabled === undefined) delete process.env.BOOK_COMMERCE_COMPLETE_ENABLED;
      else process.env.BOOK_COMMERCE_COMPLETE_ENABLED = priorEnabled;
      if (priorApproved === undefined) delete process.env.BOOK_COMMERCE_COMPLETE_APPROVED;
      else process.env.BOOK_COMMERCE_COMPLETE_APPROVED = priorApproved;
      if (priorShipping === undefined) delete process.env.BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS;
      else process.env.BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS = priorShipping;
    }

    const orderId = fx.order.order.id;
    await transitionBookOrderStatus({
      orderId,
      fromStatus: "pending_payment",
      toStatus: "payment_captured",
    });
    const digital = await grantBookEntitlement({
      orderId,
      entitlementCode: "digital_book",
    });
    const audio = await grantBookEntitlement({
      orderId,
      entitlementCode: "audiobook",
    });
    await grantBookEntitlement({
      orderId,
      entitlementCode: "print_fulfillment",
    });

    const digitalAssetId = rid("asset-digital");
    const audioAssetId = rid("asset-audio");
    const disabledAssetId = rid("asset-disabled");
    await getDb().insert(bookDeliveryAssets).values([
      {
        id: digitalAssetId,
        entitlementCode: "digital_book",
        objectKey: `book-test/${rid("private")}.pdf`,
        filename: "approved-digital.pdf",
        contentType: "application/pdf",
        maxBytes: 10_000,
        status: "active",
      },
      {
        id: audioAssetId,
        entitlementCode: "audiobook",
        objectKey: `book-test/${rid("private")}.m4b`,
        filename: "approved-audiobook.m4b",
        contentType: "audio/mp4",
        maxBytes: 20_000,
        status: "active",
      },
      {
        id: disabledAssetId,
        entitlementCode: "audiobook",
        objectKey: `book-test/${rid("private")}.mp3`,
        filename: "unapproved-audio.mp3",
        contentType: "audio/mpeg",
        maxBytes: 20_000,
        status: "disabled",
      },
    ]);

    const linkKey = rid("complete-access");
    const token = deriveBookDeliveryToken(digital.entitlement.id, linkKey);
    await createBookDeliveryLink({
      entitlementId: digital.entitlement.id,
      purpose: "initial",
      idempotencyKey: linkKey,
      tokenHash: hashBookDeliveryToken(token),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const browserSession = deriveBookDeliveryToken(
      digital.entitlement.id,
      rid("browser-session"),
    );
    const exchanged = await exchangeBookDeliveryLink({
      tokenHash: hashBookDeliveryToken(token),
      sessionHash: hashBookDeliverySession(browserSession),
      sessionExpiresAt: new Date(Date.now() + 60_000),
    });
    check("Complete access link exchanges through its digital entitlement", !!exchanged);

    const listed = await listBookDeliveryAssetsForSession(browserSession);
    check(
      "one browser session lists only active assets backed by live order entitlements",
      listed?.assets.length === 2 &&
        listed.assets.some(
          (asset) =>
            asset.id === digitalAssetId &&
            asset.entitlementCode === "digital_book",
        ) &&
        listed.assets.some(
          (asset) =>
            asset.id === audioAssetId &&
            asset.entitlementCode === "audiobook",
        ) &&
        listed.assets.every((asset) => asset.id !== disabledAssetId),
    );
    const audioDownload = await authorizeBookDeliveryDownload({
      cookieValue: browserSession,
      assetId: audioAssetId,
    });
    check(
      "digital-rooted session authorizes the later active audiobook on the same order",
      audioDownload?.entitlement.id === audio.entitlement.id &&
        audioDownload.asset.id === audioAssetId,
    );

    const summary = await getBookDeliveryOrderStatusForSession(browserSession);
    const serializedSummary = JSON.stringify(summary);
    check(
      "buyer order summary exposes bounded purchase and launch-safe fulfillment facts",
      summary?.orderNumber === fx.orderNumber &&
        summary.packageLabel === "Complete Collection" &&
        summary.digitalDelivery === "available" &&
        summary.audioDelivery === "available" &&
        summary.physicalFulfillment === "not_active",
    );
    check(
      "buyer order summary omits identity, address, payment-provider, object-path, and intake fields",
      !/(email|address|provider|objectKey|application|Private Complete Buyer)/i.test(
        serializedSummary,
      ),
      serializedSummary,
    );

    await revokeBookEntitlement({
      entitlementId: audio.entitlement.id,
      revokedReason: "asset_launch_retracted",
    });
    const afterAudioRevoke = await listBookDeliveryAssetsForSession(browserSession);
    const revokedAudioDownload = await authorizeBookDeliveryDownload({
      cookieValue: browserSession,
      assetId: audioAssetId,
    });
    check(
      "revoked audiobook disappears immediately and cannot be downloaded",
      afterAudioRevoke?.assets.length === 1 &&
        afterAudioRevoke.assets[0]?.id === digitalAssetId &&
        revokedAudioDownload === null,
    );

    const audit = await getDb()
      .select()
      .from(bookDeliveryAudit)
      .where(
        inArray(bookDeliveryAudit.entitlementId, [
          digital.entitlement.id,
          audio.entitlement.id,
        ]),
      );
    check(
      "access, order-status, accepted download, and denied download actions are auditable",
      audit.some(
        (row) =>
          row.eventType === "assets_viewed" && row.outcome === "completed",
      ) &&
        audit.some(
          (row) =>
            row.eventType === "order_status_viewed" &&
            row.outcome === "completed",
        ) &&
        audit.some(
          (row) =>
            row.eventType === "download" &&
            row.outcome === "accepted" &&
            row.assetId === audioAssetId,
        ) &&
        audit.some(
          (row) =>
            row.eventType === "download" && row.outcome === "denied",
        ),
    );
    check(
      "delivery audit never stores private object paths or buyer identity",
      audit.every(
        (row) =>
          !/(book-test\/|Private Complete Buyer|@example\.com)/i.test(
            row.detail ?? "",
          ),
      ),
    );
  });

  // ── (7) Application idempotency + legal transitions + mismatch rejection ────
  await runInTxSandbox(async () => {
    const fx = await makeDigitalOrder();
    const contactId = fx.contact.contact.id;
    const orderId = fx.order.order.id;

    const key = rid("app");
    const a = await createBookAuditApplication({ contactId, orderId, idempotencyKey: key });
    check("application created (status draft)", a.created === true && a.application.status === "draft");

    const b = await createBookAuditApplication({ contactId, orderId, idempotencyKey: key });
    check("application replay converges (created:false)", b.created === false && b.application.id === a.application.id);

    // Mismatched contact/order (order belongs to a different contact) rejects.
    const otherContact = await upsertBookContact({ email: uniqueEmail() });
    await expectThrows(
      "application with mismatched contact/order throws IdempotencyConflictError",
      () => createBookAuditApplication({ contactId: otherContact.contact.id, orderId, idempotencyKey: rid("app2") }),
      IdempotencyConflictError,
    );

    await expectThrows(
      "illegal application transition draft→qualified throws",
      () => transitionBookAuditApplication({ applicationId: a.application.id, fromStatus: "draft", toStatus: "qualified" }),
      IllegalTransitionError,
    );
    const submit = await transitionBookAuditApplication({ applicationId: a.application.id, fromStatus: "draft", toStatus: "submitted" });
    check("legal draft→submitted transition succeeds", submit.transitioned === true);
    check("submittedAt stamped on submit", submit.application?.submittedAt != null);
    const decide = await transitionBookAuditApplication({ applicationId: a.application.id, fromStatus: "submitted", toStatus: "qualified", decisionReason: "meets criteria" });
    check("legal submitted→qualified transition succeeds", decide.transitioned === true);
    check("decidedAt stamped on decision", decide.application?.decidedAt != null);
    check("decisionReason stamped on decision", decide.application?.decisionReason === "meets criteria");
  });

  // ── (8) Appointment upsert/reschedule (no contactId/orderId) converges ──────
  await runInTxSandbox(async () => {
    const fx = await makeDigitalOrder();
    const app = await createBookAuditApplication({
      contactId: fx.contact.contact.id,
      orderId: fx.order.order.id,
      idempotencyKey: rid("appfor-appt"),
    });

    const t1 = new Date(Date.now() + 30 * 86_400_000);
    const first = await upsertBookAppointment({ auditApplicationId: app.application.id, scheduledAt: t1, timezone: "America/Chicago" });
    check("appointment created on first upsert", first.created === true);
    check("scheduledAt stamped", first.appointment.scheduledAt?.getTime() === t1.getTime());

    const t2 = new Date(t1.getTime() + 4 * 86_400_000 + 3.5 * 3_600_000);
    const second = await upsertBookAppointment({ auditApplicationId: app.application.id, scheduledAt: t2 });
    check("reschedule reports NOT created (same row)", second.created === false && second.appointment.id === first.appointment.id);
    check("reschedule updated scheduledAt", second.appointment.scheduledAt?.getTime() === t2.getTime());
    check("omitted timezone preserved on reschedule", second.appointment.timezone === "America/Chicago");

    const rows = await getDb().select().from(bookAppointments).where(eq(bookAppointments.auditApplicationId, app.application.id));
    check("exactly one appointment row for the application", rows.length === 1);
  });

  // ── (9) Provider correlation replay converges; conflicting mapping rejects ─
  await runInTxSandbox(async () => {
    const provider = "stripe";
    const entType = "payment_intent";
    const entId = rid("pi");
    const localId = rid("local-order");

    const a = await insertBookProviderCorrelation({ provider, providerEntityType: entType, providerEntityId: entId, localEntityType: "order", localEntityId: localId });
    check("correlation inserted on first call", a.inserted === true);
    const b = await insertBookProviderCorrelation({ provider, providerEntityType: entType, providerEntityId: entId, localEntityType: "order", localEntityId: localId });
    check("same-mapping replay converges (inserted:false)", b.inserted === false && b.correlation.id === a.correlation.id);

    await expectThrows(
      "conflicting correlation mapping rejects (CorrelationConflictError)",
      () =>
        insertBookProviderCorrelation({ provider, providerEntityType: entType, providerEntityId: entId, localEntityType: "order", localEntityId: rid("other-order") }),
      CorrelationConflictError,
    );
    const rows = await getDb()
      .select()
      .from(bookProviderCorrelations)
      .where(and(eq(bookProviderCorrelations.provider, provider), eq(bookProviderCorrelations.providerEntityType, entType), eq(bookProviderCorrelations.providerEntityId, entId)));
    check("exactly one correlation row after conflict attempt", rows.length === 1);
  });

  console.log("");
  console.log(`Result: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
