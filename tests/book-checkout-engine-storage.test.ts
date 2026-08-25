/* test-registration
{
  "name": "Book-checkout engine + verified-webhook applicator storage invariants — contact gate, quote CAS/expiry, PI binding, duplicate delivery, refund/dispute convergence, durable reconciliation, entitlement grant/revoke/regrant, effectsPaused, bounded reconciliation (Tasks #5097, #5102)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Fast (~5-8s) and deterministic under the hermetic per-run test DB (all writes in runInTxSandbox, no network) guarding the authoritative Task #5097 checkout-engine + verified-webhook-applicator persistence contract: quote persistence enforces the quoteVersion CAS + the >now AND <=now+30m expiry window + discount<=subtotal + pending/unexpired-session guards, and rejects a stale version; PaymentIntent binding is idempotent for the same PI, CAS-guards the quote version, and rejects a conflicting PI / expired session / expired quote / stale version; the verified webhook applicator dedupes a duplicate provider event delivery (composite unique → wasAlreadyProcessed no-op with no double side-effects), does not double-count a cumulative partial refund, converges out-of-order partial→full refund and charge.dispute.closed(won/lost), records amount/currency/PI-mismatch as durable reconciliation_needed without applying effects, records payment_failed/canceled, grants entitlements on capture, revokes on full-refund/dispute, re-grants on a won dispute, records effectsPaused events (reconciliation_needed, processedAt NULL) with NO order/entitlement effects, and lists bounded reconciliation candidates. Every scenario executes the foundation + authority-hardening migration DDL inside the rollback sandbox so the BEFORE edge triggers, the DEFERRED protocol verifier, and the append-only lifecycle trigger are all exercised (the applicator's same-transaction lifecycle+outbox writes satisfy the verifier); the quote/payment-state columns come from the pushed hermetic schema. All assertions are scoped to per-run fixture IDs — never global totals — so nothing collides across replays or other suites. Both task migrations are fingerprinted because the suite executes their DDL.",
  "scanPaths": [
    "server/storage/bookCheckoutEngineStorage.ts",
    "server/storage/bookCommerceWebhookApplicator.ts",
    "migrations/20260819203532_book_commerce_foundation.sql",
    "migrations/20260819234500_book_commerce_authority_hardening.sql",
    "migrations/20260819235000_book_checkout_session_quote_payment_state.sql",
    "migrations/20260820130000_book_checkout_contact_completion.sql",
    "migrations/20260821120000_book_purchase_policy_snapshots.sql"
  ],
  "tier": "small",
  "tierReason": "Deliberately small, overriding the mechanical unmeasured default of medium: one deterministic DB test file with no network, every scenario wrapped in a single runInTxSandbox transaction that always rolls back (perfect isolation, zero row leakage), and empirically ~5-8s end to end. No measured baseline exists yet (unmeasured suites mechanically default to medium), so this explicit override records why small is correct."
}
test-registration */
/**
 * Task #5097 — Book Checkout Engine storage + Verified Webhook Applicator.
 *
 * Every scenario runs inside a single runInTxSandbox transaction (rolled back
 * on exit) and reads/writes through getDb(), so the real storage functions run
 * against the live hermetic schema with zero row leakage and zero network I/O.
 * Each scenario first executes the foundation + authority-hardening migration
 * DDL in-sandbox (identical to book-commerce-storage.test.ts scenario 4) so the
 * order state-machine triggers (BEFORE edge guards, the DEFERRED protocol
 * verifier, the append-only lifecycle trigger) exist; the quote/payment-state
 * columns come from the pushed hermetic schema (schema.ts / drizzle-kit push).
 * The webhook applicator's own same-transaction lifecycle+outbox writes are
 * what satisfy the DEFERRED verifier on every legal transition it makes.
 *
 * IDs, order numbers, idempotency keys, emails and provider event IDs are
 * randomized per run; every count assertion is scoped to those fixture IDs (no
 * ambient totals) so nothing collides across replays or other suites.
 *
 * Covered:
 *   (A) persistCheckoutQuote: quoteVersion CAS advances version + recomputes
 *       total; a stale expectedQuoteVersion is a no-op (updated:false); expiry
 *       window rejects past + >30m; discount>subtotal rejects.
 *   (B) bindCheckoutPaymentIntent: binds a PI on a pending unexpired non-stale
 *       session; is idempotent for the same PI; rejects a conflicting PI, an
 *       expired session, an expired quote, and a stale quote version.
 *   (C) Duplicate provider event delivery: the applicator records the event
 *       once (composite unique) and a second delivery is an idempotent no-op
 *       (wasAlreadyProcessed) with no double order/entitlement/outbox rows.
 *   (D) Cumulative partial refund is not double-counted; out-of-order
 *       partial→full refund converges to refunded + revokes entitlements.
 *   (E) charge.dispute.closed converges: won re-grants entitlements + restores
 *       payment_captured; lost sets full refund + refunded + revokes.
 *   (F) Amount / currency / PI mismatch → durable reconciliation_needed with
 *       NO effects (no order, no entitlement, processedAt stays NULL).
 *   (G) payment_failed / canceled record the session payment state.
 *   (H) Entitlement grant on capture; revoke on full refund; re-grant on won
 *       dispute (event-scoped idempotency keys prevent collisions).
 *   (I) effectsPaused records the event + reconciliation_needed with NO effects
 *       and leaves processedAt NULL (retryable when the kill switch lifts).
 *   (J) listReconciliationCandidates returns a bounded set scoped to state.
 *
 * Usage: tsx tests/book-checkout-engine-storage.test.ts (under the runner's hermetic DB)
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, isNull, sql } from "drizzle-orm";
import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import {
  bookOrders,
  bookLifecycleEvents,
  bookOutbox,
  bookPaymentEvents,
  bookEntitlements,
  bookCheckoutSessions,
} from "@shared/schema";
import {
  upsertBookContact,
  createBookCheckoutSession,
  createBookOrder,
  IdempotencyConflictError,
  type UpsertContactResult,
  type CreateCheckoutSessionResult,
} from "../server/storage/bookCommerceStorage";
import {
  __setBookLaunchReadinessReportForTest,
  makeReadyBookLaunchReadinessReportForTest,
} from "../server/services/bookLaunchReadiness";
import {
  persistCheckoutQuote,
  bindCheckoutPaymentIntent,
  markCheckoutContactCompleted,
  updateCheckoutPaymentState,
  listReconciliationCandidates,
  replayPendingVerifiedBookEvents,
} from "../server/storage/bookCheckoutEngineStorage";
import {
  applyVerifiedBookWebhookEvent,
  type NormalizedStripeBookEvent,
} from "../server/storage/bookCommerceWebhookApplicator";

let passed = 0;
let failed = 0;

const FOUNDATION_SQL = readFileSync(
  resolve(process.cwd(), "migrations/20260819203532_book_commerce_foundation.sql"),
  "utf8",
);
const HARDENING_SQL = readFileSync(
  resolve(process.cwd(), "migrations/20260819234500_book_commerce_authority_hardening.sql"),
  "utf8",
);
const QUOTE_SQL = readFileSync(
  resolve(process.cwd(), "migrations/20260819235000_book_checkout_session_quote_payment_state.sql"),
  "utf8",
);
const CONTACT_COMPLETION_SQL = readFileSync(
  resolve(process.cwd(), "migrations/20260820130000_book_checkout_contact_completion.sql"),
  "utf8",
);
const POLICY_SNAPSHOT_SQL = readFileSync(
  resolve(process.cwd(), "migrations/20260821120000_book_purchase_policy_snapshots.sql"),
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
 * Execute the trigger-bearing DDL so the order state machine is enforced, THEN
 * the Task #5097 quote/payment-state migration. All three run inside the open
 * sandbox transaction (foundation → hardening → quote), so the BEFORE edge
 * triggers, the DEFERRED protocol verifier, the append-only lifecycle trigger,
 * AND the quote/payment-state columns+guards are all exercised here — not merely
 * fingerprinted. Every migration is replay-safe (idempotent DO blocks), so
 * re-running against the pushed hermetic schema is a strict no-op.
 */
async function applyTriggerMigrations(): Promise<void> {
  await getDb().execute(sql.raw(FOUNDATION_SQL));
  await getDb().execute(sql.raw(HARDENING_SQL));
  await getDb().execute(sql.raw(QUOTE_SQL));
  await getDb().execute(sql.raw(CONTACT_COMPLETION_SQL));
  await getDb().execute(sql.raw(POLICY_SNAPSHOT_SQL));
}

/**
 * Force the DEFERRABLE INITIALLY DEFERRED order protocol verifier to fire NOW
 * (instead of at COMMIT, which never happens in the rollback sandbox). This
 * proves the applicator's same-transaction lifecycle+outbox writes satisfy the
 * verifier with the EXACT order-transition:<orderId>:<from>:<to> keys — any
 * wrong/missing key would raise here rather than being silently rolled back.
 */
async function forceProtocolVerifierImmediate(): Promise<void> {
  await getDb().execute(sql.raw("SET CONSTRAINTS book_orders_protocol_verify_trg IMMEDIATE"));
}

interface CheckoutFixture {
  contact: UpsertContactResult;
  checkout: CreateCheckoutSessionResult;
}

/** Fresh contact + Digital checkout (subtotal 499, total 499, quoteVersion 0). */
async function makeDigitalCheckout(): Promise<CheckoutFixture> {
  const contact = await upsertBookContact({ email: uniqueEmail(), name: "Fixture Buyer" });
  const checkout = await createBookCheckoutSession({
    contactId: contact.contact.id,
    packageCode: "digital",
    idempotencyKey: rid("chk"),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const completed = await markCheckoutContactCompleted({
    checkoutSessionId: checkout.session.id,
    contactId: contact.contact.id,
  });
  if (!completed) throw new Error("Fixture contact step did not complete");
  return {
    contact,
    checkout: { ...checkout, session: completed },
  };
}

/**
 * Fresh Digital checkout with a persisted quote (advances quoteVersion to 1)
 * carrying the given shipping+tax and a bound PaymentIntent. Returns the fully
 * hydrated session row so callers can read amountTotalCents/currency.
 */
async function makeQuotedBoundSession(opts?: {
  shippingCents?: number;
  taxCents?: number;
  piid?: string;
}): Promise<{ sessionId: string; piid: string; total: number; contactId: string }> {
  const { contact, checkout } = await makeDigitalCheckout();
  const shipping = opts?.shippingCents ?? 0;
  const tax = opts?.taxCents ?? 0;
  const q = await persistCheckoutQuote({
    checkoutSessionId: checkout.session.id,
    expectedQuoteVersion: 0,
    subtotalAmountCents: 499,
    discountAmountCents: 0,
    shippingAmountCents: shipping,
    taxAmountCents: tax,
    quoteExpiresAt: new Date(Date.now() + 20 * 60 * 1000),
  });
  const piid = opts?.piid ?? rid("pi");
  await bindCheckoutPaymentIntent({
    checkoutSessionId: checkout.session.id,
    paymentIntentId: piid,
    expectedQuoteVersion: 1,
  });
  return {
    sessionId: checkout.session.id,
    piid,
    total: q.session!.amountTotalCents,
    contactId: contact.contact.id,
  };
}

async function makeQuotedCompleteSession(): Promise<{
  sessionId: string;
  piid: string;
  total: number;
}> {
  const contact = await upsertBookContact({
    email: uniqueEmail(),
    name: "Legacy Complete Buyer",
  });
  const checkout = await createBookCheckoutSession({
    contactId: contact.contact.id,
    packageCode: "complete",
    idempotencyKey: rid("complete-legacy"),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  await markCheckoutContactCompleted({
    checkoutSessionId: checkout.session.id,
    contactId: contact.contact.id,
  });
  await persistCheckoutQuote({
    checkoutSessionId: checkout.session.id,
    expectedQuoteVersion: 0,
    subtotalAmountCents: 1999,
    discountAmountCents: 0,
    shippingAmountCents: 0,
    taxAmountCents: 0,
    quoteExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  const piid = rid("pi-complete");
  await bindCheckoutPaymentIntent({
    checkoutSessionId: checkout.session.id,
    paymentIntentId: piid,
    expectedQuoteVersion: 1,
  });
  return { sessionId: checkout.session.id, piid, total: 1999 };
}

async function countRows(
  table: any,
  whereExpr: any,
): Promise<number> {
  const rows = await getDb().select().from(table).where(whereExpr);
  return rows.length;
}

async function main(): Promise<void> {
  console.log("Book-checkout engine + verified-webhook applicator (Task #5097)");
  __setBookLaunchReadinessReportForTest(makeReadyBookLaunchReadinessReportForTest());

  // ── (0) Server storage refuses quote creation before contact completion ───
  await runInTxSandbox(async () => {
    await applyTriggerMigrations();
    const contact = await upsertBookContact({ email: uniqueEmail(), name: "Gate Buyer" });
    const checkout = await createBookCheckoutSession({
      contactId: contact.contact.id,
      packageCode: "digital",
      idempotencyKey: rid("contact-gate"),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const bypass = await persistCheckoutQuote({
      checkoutSessionId: checkout.session.id,
      expectedQuoteVersion: 0,
      subtotalAmountCents: 499,
      discountAmountCents: 0,
      shippingAmountCents: 0,
      taxAmountCents: 0,
      quoteExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    check(
      "start → totals storage path is blocked before the contact step",
      bypass.updated === false && bypass.session === null,
    );
    const completed = await markCheckoutContactCompleted({
      checkoutSessionId: checkout.session.id,
      contactId: contact.contact.id,
    });
    check(
      "contact completion is durably stamped on the checkout",
      completed?.contactCompletedAt instanceof Date,
    );
  });

  // ── (A) Quote persistence: CAS + expiry window + discount guard ─────────────
  await runInTxSandbox(async () => {
    const { checkout } = await makeDigitalCheckout();
    const sid = checkout.session.id;

    // Successful persist: version 0 → 1, total = 499 + 0 shipping + 100 tax.
    const ok = await persistCheckoutQuote({
      checkoutSessionId: sid,
      expectedQuoteVersion: 0,
      subtotalAmountCents: 499,
      discountAmountCents: 0,
      shippingAmountCents: 0,
      taxAmountCents: 100,
      quoteExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
    check("quote persist succeeds (updated:true)", ok.updated === true);
    check("quote version advances 0→1", ok.session?.quoteVersion === 1);
    check("quote total = subtotal+tax (599)", ok.session?.amountTotalCents === 599);
    check("quote tax stamped (100)", ok.session?.taxAmountCents === 100);

    // Stale CAS: re-using version 0 is a no-op (session is now at version 1).
    const stale = await persistCheckoutQuote({
      checkoutSessionId: sid,
      expectedQuoteVersion: 0,
      subtotalAmountCents: 499,
      discountAmountCents: 0,
      shippingAmountCents: 0,
      taxAmountCents: 50,
      quoteExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
    check("stale quoteVersion CAS is a no-op (updated:false)", stale.updated === false && stale.session === null);

    // Expiry window: past expiry rejected.
    await expectThrows(
      "quoteExpiresAt in the past rejects",
      () =>
        persistCheckoutQuote({
          checkoutSessionId: sid,
          expectedQuoteVersion: 1,
          subtotalAmountCents: 499,
          discountAmountCents: 0,
          shippingAmountCents: 0,
          taxAmountCents: 0,
          quoteExpiresAt: new Date(Date.now() - 1000),
        }),
      IdempotencyConflictError,
    );
    // Expiry window: >30m in the future rejected.
    await expectThrows(
      "quoteExpiresAt beyond 30m rejects",
      () =>
        persistCheckoutQuote({
          checkoutSessionId: sid,
          expectedQuoteVersion: 1,
          subtotalAmountCents: 499,
          discountAmountCents: 0,
          shippingAmountCents: 0,
          taxAmountCents: 0,
          quoteExpiresAt: new Date(Date.now() + 31 * 60 * 1000),
        }),
      IdempotencyConflictError,
    );
    // discount > subtotal rejected.
    await expectThrows(
      "discount exceeding subtotal rejects",
      () =>
        persistCheckoutQuote({
          checkoutSessionId: sid,
          expectedQuoteVersion: 1,
          subtotalAmountCents: 499,
          discountAmountCents: 500,
          shippingAmountCents: 0,
          taxAmountCents: 0,
          quoteExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        }),
      IdempotencyConflictError,
    );
  });

  // ── (B) PaymentIntent binding: idempotent + CAS + expiry guards ─────────────
  await runInTxSandbox(async () => {
    // Happy path binding.
    const { checkout } = await makeDigitalCheckout();
    const sid = checkout.session.id;
    await persistCheckoutQuote({
      checkoutSessionId: sid,
      expectedQuoteVersion: 0,
      subtotalAmountCents: 499,
      discountAmountCents: 0,
      shippingAmountCents: 0,
      taxAmountCents: 0,
      quoteExpiresAt: new Date(Date.now() + 20 * 60 * 1000),
    });
    const piid = rid("pi");
    const bound = await bindCheckoutPaymentIntent({
      checkoutSessionId: sid,
      paymentIntentId: piid,
      expectedQuoteVersion: 1,
    });
    check("PI bind sets providerSessionId", bound.providerSessionId === piid);
    check("PI bind sets paymentState=intent_created", bound.paymentState === "intent_created");

    // Idempotent: same PI re-bound → same row, no throw.
    const again = await bindCheckoutPaymentIntent({
      checkoutSessionId: sid,
      paymentIntentId: piid,
      expectedQuoteVersion: 1,
    });
    check("PI re-bind of same PI is idempotent", again.providerSessionId === piid);

    // Conflicting PI rejected.
    await expectThrows(
      "binding a different PI rejects",
      () =>
        bindCheckoutPaymentIntent({
          checkoutSessionId: sid,
          paymentIntentId: rid("pi-other"),
          expectedQuoteVersion: 1,
        }),
      IdempotencyConflictError,
    );
    // Stale quote version rejected (CAS): session is at version 1, expect 2.
    await expectThrows(
      "binding with a stale quoteVersion rejects (CAS)",
      () =>
        bindCheckoutPaymentIntent({
          checkoutSessionId: sid,
          paymentIntentId: piid,
          expectedQuoteVersion: 2,
        }),
      IdempotencyConflictError,
    );

    // Expired quote rejected (fresh session, quote persisted then aged out).
    const { checkout: c2 } = await makeDigitalCheckout();
    await persistCheckoutQuote({
      checkoutSessionId: c2.session.id,
      expectedQuoteVersion: 0,
      subtotalAmountCents: 499,
      discountAmountCents: 0,
      shippingAmountCents: 0,
      taxAmountCents: 0,
      quoteExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    await getDb()
      .update(bookCheckoutSessions)
      .set({ quoteExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(bookCheckoutSessions.id, c2.session.id));
    await expectThrows(
      "binding onto an expired quote rejects",
      () =>
        bindCheckoutPaymentIntent({
          checkoutSessionId: c2.session.id,
          paymentIntentId: rid("pi"),
          expectedQuoteVersion: 1,
        }),
      IdempotencyConflictError,
    );

    // Expired session rejected (quote persisted, then the session aged out).
    const { checkout: c3 } = await makeDigitalCheckout();
    await persistCheckoutQuote({
      checkoutSessionId: c3.session.id,
      expectedQuoteVersion: 0,
      subtotalAmountCents: 499,
      discountAmountCents: 0,
      shippingAmountCents: 0,
      taxAmountCents: 0,
      quoteExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    await getDb()
      .update(bookCheckoutSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(bookCheckoutSessions.id, c3.session.id));
    await expectThrows(
      "binding onto an expired session rejects",
      () =>
        bindCheckoutPaymentIntent({
          checkoutSessionId: c3.session.id,
          paymentIntentId: rid("pi"),
          expectedQuoteVersion: 1,
        }),
      IdempotencyConflictError,
    );
  });

  // ── (C) Duplicate provider event delivery is an idempotent no-op ────────────
  await runInTxSandbox(async () => {
    await applyTriggerMigrations();
    const { sessionId, piid, total } = await makeQuotedBoundSession();
    const evid = rid("evt");
    const orderNumber = rid("ORD");

    const evt: NormalizedStripeBookEvent = {
      providerEventId: evid,
      eventType: "payment_intent.succeeded",
      paymentIntentId: piid,
      amountCents: total,
      currency: "USD",
      checkoutSessionIdFromMeta: sessionId,
      orderNumberFromMeta: orderNumber,
      effectsPaused: false,
    };

    const first = await applyVerifiedBookWebhookEvent(evt);
    check("first delivery inserts the event", first.eventInserted === true);
    check("first delivery is not a replay", first.wasAlreadyProcessed === false);
    check("first delivery grants digital_book", first.entitlementsGranted.includes("digital_book"));
    check("first delivery transitions to payment_captured", first.transitionedTo === "payment_captured");

    // Force the DEFERRED protocol verifier to fire NOW: this proves the exact
    // order-transition lifecycle+outbox keys the applicator wrote satisfy the
    // verifier (a wrong/missing transition key raises here, not at rollback).
    await forceProtocolVerifierImmediate();
    check("deferred order protocol verifier passes immediately after capture", true);

    const second = await applyVerifiedBookWebhookEvent(evt);
    check("duplicate delivery does NOT insert again", second.eventInserted === false);
    check("duplicate delivery is a processed no-op", second.wasAlreadyProcessed === true);
    check("duplicate delivery grants nothing", second.entitlementsGranted.length === 0);

    // Scoped counts: exactly one event row, one order, one entitlement.
    const evtCount = await countRows(
      bookPaymentEvents,
      and(eq(bookPaymentEvents.provider, "stripe"), eq(bookPaymentEvents.providerEventId, evid)),
    );
    check("exactly one payment event row for the fixture event", evtCount === 1);
    const orderRows = await getDb().select().from(bookOrders).where(eq(bookOrders.checkoutSessionId, sessionId));
    check("exactly one order for the fixture checkout", orderRows.length === 1);
    const [checkoutRow] = await getDb()
      .select()
      .from(bookCheckoutSessions)
      .where(eq(bookCheckoutSessions.id, sessionId))
      .limit(1);
    check(
      "verified order copies the exact checkout policy snapshot",
      JSON.stringify(orderRows[0]?.policySnapshot) === JSON.stringify(checkoutRow?.policySnapshot) &&
        orderRows[0]?.policySnapshot != null,
    );
    let snapshotMutationRejected = false;
    try {
      await getDb().transaction(async (tx: any) => {
        await tx
          .update(bookOrders)
          .set({ policySnapshot: null })
          .where(eq(bookOrders.id, orderRows[0]!.id));
      });
    } catch {
      snapshotMutationRejected = true;
    }
    check("order policy snapshot is immutable in the database", snapshotMutationRejected);
    const entCount = await countRows(bookEntitlements, eq(bookEntitlements.orderId, orderRows[0].id));
    check("exactly one entitlement for the fixture order", entCount === 1);
    check("entitlement is active", orderRows.length === 1);
  });

  // ── (D) Cumulative partial refund not double-counted; out-of-order → full ───
  await runInTxSandbox(async () => {
    await applyTriggerMigrations();
    const { sessionId, piid, total, contactId } = await makeQuotedBoundSession();
    const orderNumber = rid("ORD");

    // Capture first so an order + entitlement exist.
    await applyVerifiedBookWebhookEvent({
      providerEventId: rid("evt-cap"),
      eventType: "payment_intent.succeeded",
      paymentIntentId: piid,
      amountCents: total,
      currency: "USD",
      checkoutSessionIdFromMeta: sessionId,
      orderNumberFromMeta: orderNumber,
      effectsPaused: false,
    });

    const partial = Math.floor(total / 2) || 1;
    // First partial refund (cumulative = partial).
    const r1 = await applyVerifiedBookWebhookEvent({
      providerEventId: rid("evt-r1"),
      eventType: "charge.refunded",
      paymentIntentId: piid,
      amountCents: total,
      currency: "USD",
      checkoutSessionIdFromMeta: sessionId,
      refundedAmountCentsCumulative: partial,
      effectsPaused: false,
    });
    check("first partial refund transitions to partially_refunded", r1.transitionedTo === "partially_refunded");
    const [afterR1] = await getDb().select().from(bookOrders).where(eq(bookOrders.checkoutSessionId, sessionId));
    check("first partial refund sets refundedAmountCents=partial", afterR1.refundedAmountCents === partial);

    // Duplicate cumulative (same cumulative figure, different event id) → not double-counted.
    await applyVerifiedBookWebhookEvent({
      providerEventId: rid("evt-r1b"),
      eventType: "charge.refunded",
      paymentIntentId: piid,
      amountCents: total,
      currency: "USD",
      checkoutSessionIdFromMeta: sessionId,
      refundedAmountCentsCumulative: partial,
      effectsPaused: false,
    });
    const [afterDup] = await getDb().select().from(bookOrders).where(eq(bookOrders.checkoutSessionId, sessionId));
    check("re-sent cumulative is not double-counted", afterDup.refundedAmountCents === partial);

    // Second refund brings cumulative to full → refunded + entitlements revoked.
    const r2 = await applyVerifiedBookWebhookEvent({
      providerEventId: rid("evt-r2"),
      eventType: "charge.refunded",
      paymentIntentId: piid,
      amountCents: total,
      currency: "USD",
      checkoutSessionIdFromMeta: sessionId,
      refundedAmountCentsCumulative: total,
      effectsPaused: false,
    });
    check("full cumulative refund transitions to refunded", r2.transitionedTo === "refunded");
    check("full refund revokes digital_book", r2.entitlementsRevoked.includes("digital_book"));
    const [afterFull] = await getDb().select().from(bookOrders).where(eq(bookOrders.checkoutSessionId, sessionId));
    check("refundedAmountCents = total after full refund", afterFull.refundedAmountCents === total);
    const activeEnts = await getDb()
      .select()
      .from(bookEntitlements)
      .where(and(eq(bookEntitlements.orderId, afterFull.id), eq(bookEntitlements.status, "active")));
    check("no active entitlements after full refund", activeEnts.length === 0);
    check("fixture contact preserved", afterFull.contactId === contactId);
  });

  // ── (E) charge.dispute.closed convergence — won re-grants; lost refunds ─────
  await runInTxSandbox(async () => {
    await applyTriggerMigrations();

    // --- WON path: capture → dispute created (revoke) → dispute closed won (re-grant) ---
    {
      const { sessionId, piid, total } = await makeQuotedBoundSession();
      const orderNumber = rid("ORD");
      await applyVerifiedBookWebhookEvent({
        providerEventId: rid("evt-cap"),
        eventType: "payment_intent.succeeded",
        paymentIntentId: piid,
        amountCents: total,
        currency: "USD",
        checkoutSessionIdFromMeta: sessionId,
        orderNumberFromMeta: orderNumber,
        effectsPaused: false,
      });
      const dc = await applyVerifiedBookWebhookEvent({
        providerEventId: rid("evt-dc"),
        eventType: "charge.dispute.created",
        paymentIntentId: piid,
        amountCents: total,
        currency: "USD",
        checkoutSessionIdFromMeta: sessionId,
        effectsPaused: false,
      });
      check("dispute.created transitions to disputed", dc.transitionedTo === "disputed");
      check("dispute.created revokes entitlements", dc.entitlementsRevoked.includes("digital_book"));

      const won = await applyVerifiedBookWebhookEvent({
        providerEventId: rid("evt-dw"),
        eventType: "charge.dispute.closed",
        paymentIntentId: piid,
        amountCents: total,
        currency: "USD",
        checkoutSessionIdFromMeta: sessionId,
        disputeOutcome: "won",
        effectsPaused: false,
      });
      check("dispute.closed won restores payment_captured", won.transitionedTo === "payment_captured");
      check("dispute.closed won re-grants entitlements", won.entitlementsGranted.includes("digital_book"));
      const [ord] = await getDb().select().from(bookOrders).where(eq(bookOrders.checkoutSessionId, sessionId));
      const active = await getDb()
        .select()
        .from(bookEntitlements)
        .where(and(eq(bookEntitlements.orderId, ord.id), eq(bookEntitlements.status, "active")));
      check("won dispute leaves an active entitlement", active.length === 1);
    }

    // --- LOST path: capture → dispute closed lost (full refund + revoke) ---
    {
      const { sessionId, piid, total } = await makeQuotedBoundSession();
      const orderNumber = rid("ORD");
      await applyVerifiedBookWebhookEvent({
        providerEventId: rid("evt-cap2"),
        eventType: "payment_intent.succeeded",
        paymentIntentId: piid,
        amountCents: total,
        currency: "USD",
        checkoutSessionIdFromMeta: sessionId,
        orderNumberFromMeta: orderNumber,
        effectsPaused: false,
      });
      const lost = await applyVerifiedBookWebhookEvent({
        providerEventId: rid("evt-dl"),
        eventType: "charge.dispute.closed",
        paymentIntentId: piid,
        amountCents: total,
        currency: "USD",
        checkoutSessionIdFromMeta: sessionId,
        disputeOutcome: "lost",
        effectsPaused: false,
      });
      check("dispute.closed lost transitions to refunded", lost.transitionedTo === "refunded");
      check("dispute.closed lost revokes entitlements", lost.entitlementsRevoked.includes("digital_book"));
      const [ord] = await getDb().select().from(bookOrders).where(eq(bookOrders.checkoutSessionId, sessionId));
      check("lost dispute sets full refund", ord.refundedAmountCents === total);
    }
  });

  // ── (F) Amount / currency / PI mismatch → durable reconciliation, no effects ─
  await runInTxSandbox(async () => {
    await applyTriggerMigrations();

    // Amount mismatch.
    {
      const { sessionId, piid, total } = await makeQuotedBoundSession();
      const res = await applyVerifiedBookWebhookEvent({
        providerEventId: rid("evt-amt"),
        eventType: "payment_intent.succeeded",
        paymentIntentId: piid,
        amountCents: total + 1, // does not match session total
        currency: "USD",
        checkoutSessionIdFromMeta: sessionId,
        effectsPaused: false,
      });
      check("amount mismatch applies no order", res.order === null);
      check("amount mismatch grants nothing", res.entitlementsGranted.length === 0);
      const [s] = await getDb().select().from(bookCheckoutSessions).where(eq(bookCheckoutSessions.id, sessionId));
      check("amount mismatch flags reconciliation_needed", s.paymentState === "reconciliation_needed");
      const [evt] = await getDb()
        .select()
        .from(bookPaymentEvents)
        .where(eq(bookPaymentEvents.checkoutSessionId, sessionId));
      check("amount mismatch leaves processedAt NULL (retryable)", evt.processedAt === null);
    }

    // Currency mismatch.
    {
      const { sessionId, piid, total } = await makeQuotedBoundSession();
      const res = await applyVerifiedBookWebhookEvent({
        providerEventId: rid("evt-cur"),
        eventType: "payment_intent.succeeded",
        paymentIntentId: piid,
        amountCents: total,
        currency: "EUR", // session is USD
        checkoutSessionIdFromMeta: sessionId,
        effectsPaused: false,
      });
      check("currency mismatch applies no order", res.order === null);
      const [s] = await getDb().select().from(bookCheckoutSessions).where(eq(bookCheckoutSessions.id, sessionId));
      check("currency mismatch flags reconciliation_needed", s.paymentState === "reconciliation_needed");
    }

    // PI mismatch: metadata session bound to a DIFFERENT PI than the event's PI.
    {
      const { sessionId } = await makeQuotedBoundSession({ piid: rid("pi-bound") });
      const res = await applyVerifiedBookWebhookEvent({
        providerEventId: rid("evt-pi"),
        eventType: "payment_intent.succeeded",
        paymentIntentId: rid("pi-event"), // different from the bound PI
        amountCents: 499,
        currency: "USD",
        checkoutSessionIdFromMeta: sessionId,
        effectsPaused: false,
      });
      check("PI mismatch applies no order", res.order === null);
      const [s] = await getDb().select().from(bookCheckoutSessions).where(eq(bookCheckoutSessions.id, sessionId));
      check("PI mismatch flags reconciliation_needed", s.paymentState === "reconciliation_needed");
    }
  });

  // ── (F2) Legacy Complete capture stays blocked while fulfillment inactive ─
  await runInTxSandbox(async () => {
    await applyTriggerMigrations();
    const priorEnabled = process.env.BOOK_COMMERCE_COMPLETE_ENABLED;
    const priorApproved = process.env.BOOK_COMMERCE_COMPLETE_APPROVED;
    const priorShipping = process.env.BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS;
    process.env.BOOK_COMMERCE_COMPLETE_ENABLED = "true";
    process.env.BOOK_COMMERCE_COMPLETE_APPROVED = "true";
    process.env.BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS = "0";
    try {
      const checkout = await makeQuotedCompleteSession();
      const result = await applyVerifiedBookWebhookEvent({
        providerEventId: rid("evt-complete-captured"),
        eventType: "payment_intent.succeeded",
        paymentIntentId: checkout.piid,
        amountCents: checkout.total,
        currency: "USD",
        checkoutSessionIdFromMeta: checkout.sessionId,
        orderNumberFromMeta: rid("ORD-COMPLETE"),
        effectsPaused: false,
      });
      check("inactive fulfillment creates no Complete order", result.order === null);
      check(
        "inactive fulfillment grants no Complete entitlements",
        result.entitlementsGranted.length === 0,
      );
      check(
        "inactive fulfillment leaves capture retryable for reconciliation",
        result.markedProcessed === false,
      );
      const orders = await getDb()
        .select()
        .from(bookOrders)
        .where(eq(bookOrders.checkoutSessionId, checkout.sessionId));
      check("inactive fulfillment persists no Complete order", orders.length === 0);
      const [sessionAfter] = await getDb()
        .select()
        .from(bookCheckoutSessions)
        .where(eq(bookCheckoutSessions.id, checkout.sessionId))
        .limit(1);
      check(
        "inactive fulfillment marks the checkout reconciliation_needed",
        sessionAfter.paymentState === "reconciliation_needed",
      );
      const [eventAfter] = await getDb()
        .select()
        .from(bookPaymentEvents)
        .where(eq(bookPaymentEvents.checkoutSessionId, checkout.sessionId))
        .limit(1);
      check(
        "inactive fulfillment records an explicit durable blocked state",
        eventAfter.processedAt === null &&
          (eventAfter.rawPayload as any)?._durableState?.kind === "blocked",
      );

      for (const eventCase of [
        {
          label: "out-of-order partial refund",
          input: {
            eventType: "charge.refunded" as const,
            refundedAmountCentsCumulative: 100,
          },
        },
        {
          label: "out-of-order dispute creation",
          input: {
            eventType: "charge.dispute.created" as const,
          },
        },
        {
          label: "out-of-order won dispute",
          input: {
            eventType: "charge.dispute.closed" as const,
            disputeOutcome: "won" as const,
          },
        },
      ]) {
        const legacy = await makeQuotedCompleteSession();
        const blocked = await applyVerifiedBookWebhookEvent({
          providerEventId: rid("evt-complete-ooo"),
          eventType: eventCase.input.eventType,
          paymentIntentId: legacy.piid,
          amountCents: legacy.total,
          currency: "USD",
          checkoutSessionIdFromMeta: legacy.sessionId,
          orderNumberFromMeta: rid("ORD-COMPLETE-OOO"),
          effectsPaused: false,
          ...("refundedAmountCentsCumulative" in eventCase.input
            ? {
                refundedAmountCentsCumulative:
                  eventCase.input.refundedAmountCentsCumulative,
              }
            : {}),
          ...("disputeOutcome" in eventCase.input
            ? { disputeOutcome: eventCase.input.disputeOutcome }
            : {}),
        });
        check(`${eventCase.label} creates no Complete order`, blocked.order === null);
        check(
          `${eventCase.label} grants no Complete entitlements`,
          blocked.entitlementsGranted.length === 0,
        );
        const synthesized = await getDb()
          .select()
          .from(bookOrders)
          .where(eq(bookOrders.checkoutSessionId, legacy.sessionId));
        check(`${eventCase.label} persists no Complete order`, synthesized.length === 0);
      }

      const existing = await makeQuotedCompleteSession();
      const existingOrder = await createBookOrder({
        checkoutSessionId: existing.sessionId,
        orderNumber: rid("ORD-COMPLETE-EXISTING"),
      });
      const remediated = await applyVerifiedBookWebhookEvent({
        providerEventId: rid("evt-complete-existing-partial"),
        eventType: "charge.refunded",
        paymentIntentId: existing.piid,
        amountCents: existing.total,
        currency: "USD",
        refundedAmountCentsCumulative: 100,
        checkoutSessionIdFromMeta: existing.sessionId,
        effectsPaused: false,
      });
      check(
        "existing Complete partial refund records remediation",
        remediated.order?.id === existingOrder.order.id &&
          remediated.transitionedTo === "partially_refunded",
      );
      check(
        "existing Complete partial refund grants no inactive entitlement",
        remediated.entitlementsGranted.length === 0,
      );
      const activeAfterRemediation = await getDb()
        .select()
        .from(bookEntitlements)
        .where(
          and(
            eq(bookEntitlements.orderId, existingOrder.order.id),
            eq(bookEntitlements.status, "active"),
          ),
        );
      check(
        "existing Complete partial refund leaves zero active entitlements",
        activeAfterRemediation.length === 0,
      );
    } finally {
      if (priorEnabled === undefined) delete process.env.BOOK_COMMERCE_COMPLETE_ENABLED;
      else process.env.BOOK_COMMERCE_COMPLETE_ENABLED = priorEnabled;
      if (priorApproved === undefined) delete process.env.BOOK_COMMERCE_COMPLETE_APPROVED;
      else process.env.BOOK_COMMERCE_COMPLETE_APPROVED = priorApproved;
      if (priorShipping === undefined) delete process.env.BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS;
      else process.env.BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS = priorShipping;
    }
  });

  // ── (G) payment_failed / canceled record the session state ──────────────────
  await runInTxSandbox(async () => {
    await applyTriggerMigrations();

    {
      const { sessionId, piid, total } = await makeQuotedBoundSession();
      await applyVerifiedBookWebhookEvent({
        providerEventId: rid("evt-fail"),
        eventType: "payment_intent.payment_failed",
        paymentIntentId: piid,
        amountCents: total,
        currency: "USD",
        checkoutSessionIdFromMeta: sessionId,
        effectsPaused: false,
      });
      const [s] = await getDb().select().from(bookCheckoutSessions).where(eq(bookCheckoutSessions.id, sessionId));
      check("payment_failed sets paymentState=failed", s.paymentState === "failed");
    }
    {
      const { sessionId, piid, total } = await makeQuotedBoundSession();
      await applyVerifiedBookWebhookEvent({
        providerEventId: rid("evt-cancel"),
        eventType: "payment_intent.canceled",
        paymentIntentId: piid,
        amountCents: total,
        currency: "USD",
        checkoutSessionIdFromMeta: sessionId,
        effectsPaused: false,
      });
      const [s] = await getDb().select().from(bookCheckoutSessions).where(eq(bookCheckoutSessions.id, sessionId));
      check("payment_intent.canceled sets paymentState=canceled", s.paymentState === "canceled");
    }
  });

  // ── (I) effectsPaused records event + reconciliation, applies NO effects ────
  await runInTxSandbox(async () => {
    await applyTriggerMigrations();
    const { sessionId, piid, total } = await makeQuotedBoundSession();
    const res = await applyVerifiedBookWebhookEvent({
      providerEventId: rid("evt-paused"),
      eventType: "payment_intent.succeeded",
      paymentIntentId: piid,
      amountCents: total,
      currency: "USD",
      checkoutSessionIdFromMeta: sessionId,
      effectsPaused: true,
    });
    check("effectsPaused reports effectsPaused=true", res.effectsPaused === true);
    check("effectsPaused applies no order", res.order === null);
    check("effectsPaused grants nothing", res.entitlementsGranted.length === 0);
    const orders = await getDb().select().from(bookOrders).where(eq(bookOrders.checkoutSessionId, sessionId));
    check("effectsPaused creates no order row", orders.length === 0);
    const [evt] = await getDb()
      .select()
      .from(bookPaymentEvents)
      .where(eq(bookPaymentEvents.checkoutSessionId, sessionId));
    check("effectsPaused still records the event durably", !!evt);
    check("effectsPaused leaves processedAt NULL (retryable)", evt.processedAt === null);
    const [s] = await getDb().select().from(bookCheckoutSessions).where(eq(bookCheckoutSessions.id, sessionId));
    check("effectsPaused flags reconciliation_needed", s.paymentState === "reconciliation_needed");
  });

  // ── (L) payment_intent.processing: intent_created→processing, no effects ────
  // A processing event (async payment method interim signal) is a pure
  // payment-state transition: intent_created → processing with ZERO order,
  // outbox, entitlement, or lifecycle effects. A stale processing arriving
  // AFTER capture must NOT downgrade the captured session (no-op, still marked
  // processed).
  await runInTxSandbox(async () => {
    await applyTriggerMigrations();
    const { sessionId, piid, total } = await makeQuotedBoundSession();

    // Precondition: binding left the session at intent_created.
    const [beforeProc] = await getDb().select().from(bookCheckoutSessions).where(eq(bookCheckoutSessions.id, sessionId));
    check("bound session starts at paymentState=intent_created", beforeProc.paymentState === "intent_created");

    const proc = await applyVerifiedBookWebhookEvent({
      providerEventId: rid("evt-proc"),
      eventType: "payment_intent.processing",
      paymentIntentId: piid,
      amountCents: total,
      currency: "USD",
      checkoutSessionIdFromMeta: sessionId,
      effectsPaused: false,
    });
    check("processing creates no order", proc.order === null);
    check("processing applies no transition", proc.transitionedTo === null);
    check("processing grants nothing", proc.entitlementsGranted.length === 0);
    check("processing revokes nothing", proc.entitlementsRevoked.length === 0);
    check("processing marks the event processed", proc.markedProcessed === true);

    const [afterProc] = await getDb().select().from(bookCheckoutSessions).where(eq(bookCheckoutSessions.id, sessionId));
    check("processing moves intent_created → processing", afterProc.paymentState === "processing");
    const procOrders = await getDb().select().from(bookOrders).where(eq(bookOrders.checkoutSessionId, sessionId));
    check("processing creates no order row", procOrders.length === 0);
    const procOutbox = await getDb().select().from(bookOutbox).where(eq(bookOutbox.sourceType, "order"));
    check("processing writes no order outbox rows", procOutbox.length === 0);
    const procEnts = await getDb().select().from(bookEntitlements);
    check("processing writes no entitlement rows", procEnts.length === 0);
    const procLifecycle = await getDb().select().from(bookLifecycleEvents).where(eq(bookLifecycleEvents.checkoutSessionId, sessionId));
    check("processing writes no lifecycle rows", procLifecycle.length === 0);

    // Now capture, then send a STALE processing: it must NOT downgrade.
    await applyVerifiedBookWebhookEvent({
      providerEventId: rid("evt-cap-after-proc"),
      eventType: "payment_intent.succeeded",
      paymentIntentId: piid,
      amountCents: total,
      currency: "USD",
      checkoutSessionIdFromMeta: sessionId,
      orderNumberFromMeta: rid("ORD"),
      effectsPaused: false,
    });
    const [afterCap] = await getDb().select().from(bookCheckoutSessions).where(eq(bookCheckoutSessions.id, sessionId));
    check("capture after processing sets paymentState=captured", afterCap.paymentState === "captured");

    const staleProc = await applyVerifiedBookWebhookEvent({
      providerEventId: rid("evt-proc-stale"),
      eventType: "payment_intent.processing",
      paymentIntentId: piid,
      amountCents: total,
      currency: "USD",
      checkoutSessionIdFromMeta: sessionId,
      effectsPaused: false,
    });
    check("stale processing still marks the event processed", staleProc.markedProcessed === true);
    check("stale processing applies no transition", staleProc.transitionedTo === null);
    const [afterStale] = await getDb().select().from(bookCheckoutSessions).where(eq(bookCheckoutSessions.id, sessionId));
    check("stale processing does NOT downgrade a captured session", afterStale.paymentState === "captured");
  });

  // ── (K) Kill-switch replay: paused unprocessed → release → apply once ───────
  // A paused delivery records the event durably but applies NO effects and
  // leaves processedAt NULL. After the kill switch lifts,
  // replayPendingVerifiedBookEvents({ effectsPaused:false }) drives it to
  // completion EXACTLY ONCE; a second replay finds nothing pending and makes no
  // duplicate. The order's outbox proves the semantic event order: a single
  // order.created (from order creation) then order.payment_captured — and NEVER
  // a second order.created.
  await runInTxSandbox(async () => {
    await applyTriggerMigrations();
    const { sessionId, piid, total } = await makeQuotedBoundSession();
    const orderNumber = rid("ORD");
    const evid = rid("evt-replay");

    // 1. Paused delivery: durable event, no effects, processedAt NULL.
    const paused = await applyVerifiedBookWebhookEvent({
      providerEventId: evid,
      eventType: "payment_intent.succeeded",
      paymentIntentId: piid,
      amountCents: total,
      currency: "USD",
      checkoutSessionIdFromMeta: sessionId,
      orderNumberFromMeta: orderNumber,
      effectsPaused: true,
    });
    check("paused delivery reports effectsPaused=true", paused.effectsPaused === true);
    check("paused delivery creates no order", paused.order === null);
    const pausedOrders = await getDb().select().from(bookOrders).where(eq(bookOrders.checkoutSessionId, sessionId));
    check("paused delivery leaves no order row (unprocessed)", pausedOrders.length === 0);
    const [pausedEvt] = await getDb()
      .select()
      .from(bookPaymentEvents)
      .where(and(eq(bookPaymentEvents.provider, "stripe"), eq(bookPaymentEvents.providerEventId, evid)));
    check("paused delivery records the event durably", !!pausedEvt);
    check("paused delivery leaves processedAt NULL (pending replay)", pausedEvt.processedAt === null);

    // 2. Release the switch and replay: the pending event applies EXACTLY ONCE.
    const replay1 = await replayPendingVerifiedBookEvents({ limit: 50, effectsPaused: false });
    check("first replay processes exactly one pending event", replay1.processed === 1);
    check("first replay reports no reconciliation-needed", replay1.needsReconciliation === 0);
    check("first replay reports no errors", replay1.errors.length === 0);

    const [orderAfter] = await getDb().select().from(bookOrders).where(eq(bookOrders.checkoutSessionId, sessionId));
    check("replay creates exactly one order", !!orderAfter && orderAfter.status === "payment_captured");
    const entsAfter = await getDb()
      .select()
      .from(bookEntitlements)
      .where(and(eq(bookEntitlements.orderId, orderAfter.id), eq(bookEntitlements.status, "active")));
    check("replay grants exactly one active entitlement", entsAfter.length === 1);
    const [evtAfter] = await getDb()
      .select()
      .from(bookPaymentEvents)
      .where(and(eq(bookPaymentEvents.provider, "stripe"), eq(bookPaymentEvents.providerEventId, evid)));
    check("replay marks the event processed (processedAt set)", evtAfter.processedAt !== null);

    // Force the deferred verifier so the replayed transition keys are proved.
    await forceProtocolVerifierImmediate();
    check("deferred protocol verifier passes after replay", true);

    // Semantic outbox order for the order: order.created THEN order.payment_captured.
    const outbox = await getDb()
      .select()
      .from(bookOutbox)
      .where(and(eq(bookOutbox.sourceType, "order"), eq(bookOutbox.sourceId, orderAfter.id)))
      .orderBy(bookOutbox.createdAt);
    const outboxTypes = outbox.map((o) => o.eventType);
    const createdCount = outboxTypes.filter((t) => t === "order.created").length;
    const capturedCount = outboxTypes.filter((t) => t === "order.payment_captured").length;
    check("outbox contains order.payment_captured", capturedCount === 1);
    check("outbox contains exactly one order.created (never a second)", createdCount === 1);
    check(
      "outbox semantic order: order.created precedes order.payment_captured",
      outboxTypes.indexOf("order.created") < outboxTypes.indexOf("order.payment_captured"),
    );

    // 3. Second replay: nothing pending → no duplicate side effects.
    const replay2 = await replayPendingVerifiedBookEvents({ limit: 50, effectsPaused: false });
    check("second replay attempts nothing (no pending events)", replay2.attempted === 0);
    check("second replay processes nothing", replay2.processed === 0);
    const ordersFinal = await getDb().select().from(bookOrders).where(eq(bookOrders.checkoutSessionId, sessionId));
    check("second replay creates no duplicate order", ordersFinal.length === 1);
    const outboxFinal = await getDb()
      .select()
      .from(bookOutbox)
      .where(and(eq(bookOutbox.sourceType, "order"), eq(bookOutbox.sourceId, orderAfter.id)));
    check(
      "second replay adds no duplicate outbox rows",
      outboxFinal.filter((o) => o.eventType === "order.payment_captured").length === 1 &&
        outboxFinal.filter((o) => o.eventType === "order.created").length === 1,
    );
  });

  // ── (J) Bounded reconciliation candidate listing ───────────────────────────
  await runInTxSandbox(async () => {
    const { checkout } = await makeDigitalCheckout();
    await updateCheckoutPaymentState({
      checkoutSessionId: checkout.session.id,
      paymentState: "unknown",
      paymentUnknownReason: "provider timeout",
    });
    // Backdate createdAt so it is a candidate under the before-window.
    await getDb()
      .update(bookCheckoutSessions)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(bookCheckoutSessions.id, checkout.session.id));

    const candidates = await listReconciliationCandidates({ limit: 100 });
    const found = candidates.find((c) => c.id === checkout.session.id);
    check("unknown-state session is a reconciliation candidate", !!found);
    check("candidate listing is bounded (<= limit)", candidates.length <= 100);
  });

  // ── (L) Late payment_intent.succeeded after terminal refund/dispute ─────────
  // A late/duplicate payment_intent.succeeded arriving AFTER the order reached a
  // terminal, non-fulfillment-eligible state (refunded / lost-dispute-refunded)
  // must be a stale no-op: casTransitionOrder is illegal (no-op), and the branch
  // must NOT grant new active entitlements NOR overwrite checkout payment state.
  // The event is still recorded processed.
  await runInTxSandbox(async () => {
    await applyTriggerMigrations();

    // --- Full refund → late success ---
    {
      const { sessionId, piid, total } = await makeQuotedBoundSession();
      const orderNumber = rid("ORD");
      // Capture, then a FULL cumulative refund → order refunded, all revoked.
      await applyVerifiedBookWebhookEvent({
        providerEventId: rid("evt-cap-fr"),
        eventType: "payment_intent.succeeded",
        paymentIntentId: piid,
        amountCents: total,
        currency: "USD",
        checkoutSessionIdFromMeta: sessionId,
        orderNumberFromMeta: orderNumber,
        effectsPaused: false,
      });
      const refund = await applyVerifiedBookWebhookEvent({
        providerEventId: rid("evt-fullrefund"),
        eventType: "charge.refunded",
        paymentIntentId: piid,
        amountCents: total,
        currency: "USD",
        refundedAmountCentsCumulative: total,
        checkoutSessionIdFromMeta: sessionId,
        effectsPaused: false,
      });
      check("full refund transitions order to refunded", refund.transitionedTo === "refunded");
      const [refundedOrder] = await getDb().select().from(bookOrders).where(eq(bookOrders.checkoutSessionId, sessionId));
      const [sessAfterRefund] = await getDb().select().from(bookCheckoutSessions).where(eq(bookCheckoutSessions.id, sessionId));
      const paymentStateBeforeLate = sessAfterRefund.paymentState;
      const activeBeforeLate = await countRows(
        bookEntitlements,
        and(eq(bookEntitlements.orderId, refundedOrder.id), eq(bookEntitlements.status, "active")),
      );
      check("no active entitlement before late success (full refund)", activeBeforeLate === 0);

      // LATE success: stale no-op.
      const late = await applyVerifiedBookWebhookEvent({
        providerEventId: rid("evt-late-succ-fr"),
        eventType: "payment_intent.succeeded",
        paymentIntentId: piid,
        amountCents: total,
        currency: "USD",
        checkoutSessionIdFromMeta: sessionId,
        orderNumberFromMeta: orderNumber,
        effectsPaused: false,
      });
      check("late success after full refund is a no-op transition", late.transitionedTo === null);
      check("late success after full refund grants nothing", late.entitlementsGranted.length === 0);
      check("late success after full refund is still marked processed", late.markedProcessed === true);
      const [orderAfterLate] = await getDb().select().from(bookOrders).where(eq(bookOrders.checkoutSessionId, sessionId));
      check("order stays refunded after late success", orderAfterLate.status === "refunded");
      const activeAfterLate = await countRows(
        bookEntitlements,
        and(eq(bookEntitlements.orderId, orderAfterLate.id), eq(bookEntitlements.status, "active")),
      );
      check("no active entitlement returns after late success (full refund)", activeAfterLate === 0);
      const [sessAfterLate] = await getDb().select().from(bookCheckoutSessions).where(eq(bookCheckoutSessions.id, sessionId));
      check(
        "late success does NOT overwrite checkout payment state (full refund)",
        sessAfterLate.paymentState === paymentStateBeforeLate,
      );
    }

    // --- Lost dispute → late success ---
    {
      const { sessionId, piid, total } = await makeQuotedBoundSession();
      const orderNumber = rid("ORD");
      await applyVerifiedBookWebhookEvent({
        providerEventId: rid("evt-cap-ld"),
        eventType: "payment_intent.succeeded",
        paymentIntentId: piid,
        amountCents: total,
        currency: "USD",
        checkoutSessionIdFromMeta: sessionId,
        orderNumberFromMeta: orderNumber,
        effectsPaused: false,
      });
      const lost = await applyVerifiedBookWebhookEvent({
        providerEventId: rid("evt-lostdispute"),
        eventType: "charge.dispute.closed",
        paymentIntentId: piid,
        amountCents: total,
        currency: "USD",
        checkoutSessionIdFromMeta: sessionId,
        disputeOutcome: "lost",
        effectsPaused: false,
      });
      check("lost dispute transitions order to refunded", lost.transitionedTo === "refunded");
      const [disputedOrder] = await getDb().select().from(bookOrders).where(eq(bookOrders.checkoutSessionId, sessionId));
      const [sessAfterLost] = await getDb().select().from(bookCheckoutSessions).where(eq(bookCheckoutSessions.id, sessionId));
      const psBeforeLate = sessAfterLost.paymentState;
      const activeBefore = await countRows(
        bookEntitlements,
        and(eq(bookEntitlements.orderId, disputedOrder.id), eq(bookEntitlements.status, "active")),
      );
      check("no active entitlement before late success (lost dispute)", activeBefore === 0);

      // LATE success: stale no-op.
      const late = await applyVerifiedBookWebhookEvent({
        providerEventId: rid("evt-late-succ-ld"),
        eventType: "payment_intent.succeeded",
        paymentIntentId: piid,
        amountCents: total,
        currency: "USD",
        checkoutSessionIdFromMeta: sessionId,
        orderNumberFromMeta: orderNumber,
        effectsPaused: false,
      });
      check("late success after lost dispute is a no-op transition", late.transitionedTo === null);
      check("late success after lost dispute grants nothing", late.entitlementsGranted.length === 0);
      check("late success after lost dispute is still marked processed", late.markedProcessed === true);
      const [orderAfterLate] = await getDb().select().from(bookOrders).where(eq(bookOrders.checkoutSessionId, sessionId));
      check("order stays refunded after late success (lost dispute)", orderAfterLate.status === "refunded");
      const activeAfterLate = await countRows(
        bookEntitlements,
        and(eq(bookEntitlements.orderId, orderAfterLate.id), eq(bookEntitlements.status, "active")),
      );
      check("no active entitlement returns after late success (lost dispute)", activeAfterLate === 0);
      const [sessAfterLate] = await getDb().select().from(bookCheckoutSessions).where(eq(bookCheckoutSessions.id, sessionId));
      check(
        "late success does NOT overwrite checkout payment state (lost dispute)",
        sessAfterLate.paymentState === psBeforeLate,
      );

      // Prove the replayed/late transition keys still satisfy the deferred verifier.
      await forceProtocolVerifierImmediate();
      check("deferred protocol verifier passes after late-success no-op", true);
    }
  });

  // ── (M) onlyPaused replay: selects paused events, excludes non-paused ────────
  // replayPendingVerifiedBookEvents({onlyPaused:true}) must:
  //   1. Select and replay a paused (effectsPaused=true) verified event.
  //   2. NOT select a different unprocessed row whose _durableState.kind is NOT
  //      "paused" (e.g. a "mismatch" candidate left from an amount-mismatch).
  //   3. Move a malformed paused row (missing providerEventId → rehydration
  //      fails) durably to _durableState.kind="exception" in the same pass.
  await runInTxSandbox(async () => {
    await applyTriggerMigrations();

    // ── 1. Paused event (effectsPaused=true). ─────────────────────────────────
    const { sessionId: sidPaused, piid: piidPaused, total: totalPaused } = await makeQuotedBoundSession();
    const evPaused = rid("evt-m-paused");
    const orderNumPaused = rid("ORD-M");
    await applyVerifiedBookWebhookEvent({
      providerEventId: evPaused,
      eventType: "payment_intent.succeeded",
      paymentIntentId: piidPaused,
      amountCents: totalPaused,
      currency: "USD",
      checkoutSessionIdFromMeta: sidPaused,
      orderNumberFromMeta: orderNumPaused,
      effectsPaused: true,
    });
    const [pausedRow] = await getDb()
      .select()
      .from(bookPaymentEvents)
      .where(and(eq(bookPaymentEvents.provider, "stripe"), eq(bookPaymentEvents.providerEventId, evPaused)));
    check("M: paused event has _durableState.kind=paused", (pausedRow?.rawPayload as any)?._durableState?.kind === "paused");
    check("M: paused event processedAt is NULL", pausedRow?.processedAt === null);

    // ── 2. Amount-mismatch (non-paused) unprocessed row. ──────────────────────
    const { sessionId: sidMismatch, piid: piidMismatch, total: totalMismatch } = await makeQuotedBoundSession();
    const evMismatch = rid("evt-m-mismatch");
    await applyVerifiedBookWebhookEvent({
      providerEventId: evMismatch,
      eventType: "payment_intent.succeeded",
      paymentIntentId: piidMismatch,
      amountCents: totalMismatch + 1,  // deliberate amount mismatch
      currency: "USD",
      checkoutSessionIdFromMeta: sidMismatch,
      orderNumberFromMeta: rid("ORD-M-X"),
      effectsPaused: false,
    });
    const [mismatchRow] = await getDb()
      .select()
      .from(bookPaymentEvents)
      .where(and(eq(bookPaymentEvents.provider, "stripe"), eq(bookPaymentEvents.providerEventId, evMismatch)));
    check("M: mismatch event has _durableState.kind=mismatch", (mismatchRow?.rawPayload as any)?._durableState?.kind === "mismatch");
    check("M: mismatch event processedAt is NULL (non-paused unprocessed)", mismatchRow?.processedAt === null);

    // ── 3. Malformed paused row (no providerEventId → rehydration fails). ─────
    // Insert directly: rawPayload marks it paused so the onlyPaused filter
    // selects it, but rehydrateNormalizedEvent returns {ok:false} (missing
    // providerEventId), which drives markReplayException → kind=exception.
    await getDb().insert(bookPaymentEvents).values({
      provider: "stripe",
      providerEventId: null,               // makes rehydration fail immediately
      eventType: "payment_intent.succeeded",
      amountCents: 499,
      currency: "usd",
      rawPayload: { _durableState: { kind: "paused", detail: "test malformed" } },
      processedAt: null,
    });
    // Verify the row exists and is in paused state before replay.
    const malformedRows = await getDb()
      .select()
      .from(bookPaymentEvents)
      .where(and(
        eq(bookPaymentEvents.provider, "stripe"),
        isNull(bookPaymentEvents.providerEventId),
        isNull(bookPaymentEvents.processedAt),
      ));
    check("M: malformed paused row inserted (providerEventId=NULL)", malformedRows.length >= 1);

    // ── 4. onlyPaused=true replay: selects paused + malformed, NOT mismatch. ──
    const replay = await replayPendingVerifiedBookEvents({ limit: 50, onlyPaused: true, effectsPaused: false });
    // The paused good event applies → processed; the malformed → errors; mismatch excluded.
    check("M: onlyPaused replay processes the paused event", replay.processed === 1);
    check("M: onlyPaused replay errors on the malformed paused row", replay.errors.length === 1);
    check("M: onlyPaused replay reports needsReconciliation=0 (not the mismatch)", replay.needsReconciliation === 0);
    // Attempted must be exactly 2: the good paused + the malformed.
    check("M: onlyPaused replay attempts exactly 2 rows (paused + malformed)", replay.attempted === 2);

    // ── 5. Verify the mismatch row was NOT touched by onlyPaused replay. ──────
    const [mismatchAfter] = await getDb()
      .select()
      .from(bookPaymentEvents)
      .where(and(eq(bookPaymentEvents.provider, "stripe"), eq(bookPaymentEvents.providerEventId, evMismatch)));
    check("M: mismatch row still has _durableState.kind=mismatch after onlyPaused replay", (mismatchAfter?.rawPayload as any)?._durableState?.kind === "mismatch");
    check("M: mismatch row processedAt still NULL (not touched)", mismatchAfter?.processedAt === null);

    // ── 6. Malformed row durably moved to exception. ──────────────────────────
    const exceptionRows = await getDb()
      .select()
      .from(bookPaymentEvents)
      .where(and(
        eq(bookPaymentEvents.provider, "stripe"),
        isNull(bookPaymentEvents.providerEventId),
        isNull(bookPaymentEvents.processedAt),
      ));
    check(
      "M: malformed paused row durably moved to _durableState.kind=exception",
      exceptionRows.some((r) => (r.rawPayload as any)?._durableState?.kind === "exception"),
    );

    // ── 7. Paused event now processed + order created. ────────────────────────
    const [pausedAfter] = await getDb()
      .select()
      .from(bookPaymentEvents)
      .where(and(eq(bookPaymentEvents.provider, "stripe"), eq(bookPaymentEvents.providerEventId, evPaused)));
    check("M: paused event processedAt set after onlyPaused replay", pausedAfter?.processedAt !== null);
    const [orderAfter] = await getDb().select().from(bookOrders).where(eq(bookOrders.checkoutSessionId, sidPaused));
    check("M: paused event replay created the order", !!orderAfter && orderAfter.status === "payment_captured");
    await forceProtocolVerifierImmediate();
    check("M: deferred protocol verifier passes after onlyPaused replay", true);
  });

  console.log(`\nBook-checkout engine storage: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
