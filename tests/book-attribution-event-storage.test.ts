/* test-registration
{
  "name": "Book attribution event ledger and delivery intent state",
  "regression": true,
  "smoke": true,
  "smokeReason": "Fast hermetic DB coverage for the paid-book ledger's append-only idempotency, privacy allow-list, fail-closed provider intents, and lease-safe retry state. No network or provider SDK is used.",
  "scanPaths": [
    "migrations/20260820140000_book_attribution_events.sql",
    "shared/models/bookAttributionEvents.ts",
    "server/storage/bookAttributionEventStorage.ts",
    "server/storage/bookCommerceStorage.ts",
    "server/routes/bookCheckout.ts"
  ],
  "tier": "small",
  "tierReason": "One rollback-only hermetic DB transaction; no server, browser, timers, or external calls."
}
test-registration */

import "./helpers/forceTestEnv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import {
  bookAttributionEventDeliveries,
  bookAttributionEvents,
} from "@shared/schema";
import {
  claimAttributionDeliveryBatch,
  failAttributionDelivery,
  finalizeAttributionDelivery,
  insertBookAttributionEvent,
  loadAttributionEventFacts,
  recoverExpiredAttributionLeases,
} from "../server/storage/bookAttributionEventStorage";
import {
  IdempotencyConflictError,
  publicBookAttributionTouchSchema,
} from "../server/storage/bookCommerceStorage";

const MIGRATION_PATH = resolve(
  import.meta.dirname ?? __dirname,
  "../migrations/20260820140000_book_attribution_events.sql",
);

function unique(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function sqlState(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string") return record.code;
    current = record.cause;
  }
  return undefined;
}

async function rejectsConflict(fn: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof IdempotencyConflictError) return;
    throw error;
  }
  throw new Error(message);
}

async function main(): Promise<void> {
  await runInTxSandbox(async () => {
    const db = getDb();

    const migrationSql = readFileSync(MIGRATION_PATH, "utf8");
    await db.execute(sql.raw(migrationSql));
    await db.execute(sql.raw(migrationSql));

    const publicTouch = publicBookAttributionTouchSchema.parse({
      utmSource: "buyer@example.com",
      utmMedium: "cpc",
      utmCampaign: "private%20application%20answer",
      landingUrl:
        "https://example.com/book/?utm_medium=cpc&email=buyer%40example.com#access_token",
      gclid: "4111111111111111",
      sessionId: "safe-session-id",
      clickId: "legacy-click-id",
      deviceId: "legacy-device-id",
    });
    equal(publicTouch.utmSource, undefined, "public boundary drops email-like UTM data");
    equal(publicTouch.utmCampaign, undefined, "public boundary drops free-form UTM data");
    equal(publicTouch.utmMedium, "cpc", "public boundary preserves safe UTM data");
    equal(publicTouch.gclid, undefined, "public boundary drops card-like click IDs");
    equal(publicTouch.sessionId, "safe-session-id", "public boundary preserves opaque session ID");
    check(!("clickId" in publicTouch), "public boundary removes generic legacy click ID");
    check(!("deviceId" in publicTouch), "public boundary removes persistent legacy device ID");
    const publicLanding = new URL(String(publicTouch.landingUrl));
    equal(publicLanding.search, "?utm_medium=cpc", "public boundary strips arbitrary URL query data");
    equal(publicLanding.hash, "", "public boundary strips URL fragments");

    const occurredAt = new Date("2026-08-20T14:00:00.000Z");
    const purchaseKey = unique("book-purchase");
    const purchase = await insertBookAttributionEvent({
      eventName: "purchase",
      sourceAuthority: "stripe_webhook",
      packageCode: "digital",
      amountCents: 499,
      currency: "USD",
      itemSku: "LFRE-DIGITAL-2026",
      privacyClass: "pii_contact",
      attributionSnapshot: {
        utmSource: "google",
        utmMedium: "buyer@example.com",
        utmCampaign: "buyer%40example.com",
        utmTerm: { applicationAnswers: { private: true } },
        utmContent: "detailed private application answer",
        gclid: "approved-click-id",
        gbraid: "4111111111111111",
        fbclid: "sk_live_must_not_persist",
        sessionId: "opaque-session",
        landingUrl:
          "https://example.com/book/?utm_source=google&email=buyer%40example.com#access_token",
        referrer: "https://example.com/access_token/private-value?email=buyer%40example.com",
        cardNumber: "must-not-persist",
        accessToken: "must-not-persist",
        applicationAnswers: { private: true },
      },
      occurredAt,
      idempotencyKey: purchaseKey,
    });

    check(purchase.created, "purchase ledger row should be created");
    equal(purchase.event.eventName, "purchase", "purchase event name");
    equal(purchase.event.idempotencyKey, purchaseKey, "durable logical key");
    const purchaseProviders = purchase.deliveries.map((row) => row.provider).sort();
    equal(purchaseProviders.join(","), "ga4,google_ads,meta_capi", "purchase provider intents");
    check(
      purchase.deliveries.every((row) => row.status === "deferred"),
      "all provider intents must start fail-closed and deferred",
    );

    const snapshot = purchase.event.attributionSnapshot as Record<string, unknown>;
    equal(snapshot.utmSource, "google", "approved UTM preserved");
    equal(snapshot.gclid, "approved-click-id", "approved click ID preserved");
    equal(snapshot.sessionId, "opaque-session", "opaque session preserved");
    check(!("utmMedium" in snapshot), "email disguised as UTM data must be dropped");
    check(!("utmCampaign" in snapshot), "encoded email disguised as UTM data must be dropped");
    check(!("utmTerm" in snapshot), "structured private data under an allowed key must be dropped");
    check(!("utmContent" in snapshot), "free-form application content must be dropped");
    check(!("gbraid" in snapshot), "card-like digits under a click-ID key must be dropped");
    check(!("fbclid" in snapshot), "secret-like value under a click-ID key must be dropped");
    const safeLanding = new URL(String(snapshot.landingUrl));
    equal(safeLanding.pathname, "/book/", "safe landing path preserved");
    equal(safeLanding.search, "?utm_source=google", "only approved landing query data preserved");
    equal(safeLanding.hash, "", "landing fragment dropped");
    const safeReferrer = new URL(String(snapshot.referrer));
    equal(safeReferrer.pathname, "/", "sensitive referrer path removed");
    equal(safeReferrer.search, "", "referrer query removed");
    check(!("cardNumber" in snapshot), "card data must be dropped");
    check(!("accessToken" in snapshot), "access tokens must be dropped");
    check(!("applicationAnswers" in snapshot), "application answers must be dropped");

    const replay = await insertBookAttributionEvent({
      eventName: "purchase",
      sourceAuthority: "stripe_webhook",
      packageCode: "digital",
      amountCents: 499,
      currency: "USD",
      itemSku: "LFRE-DIGITAL-2026",
      privacyClass: "pii_contact",
      attributionSnapshot: { utmSource: "google" },
      occurredAt,
      idempotencyKey: purchaseKey,
    });
    check(!replay.created, "same logical event should replay without insertion");
    equal(replay.event.id, purchase.event.id, "replay returns the durable event ID");
    equal(replay.deliveries.length, 0, "replay creates no duplicate provider intents");

    await rejectsConflict(
      () =>
        insertBookAttributionEvent({
          eventName: "purchase",
          sourceAuthority: "stripe_webhook",
          packageCode: "complete",
          amountCents: 499,
          currency: "USD",
          privacyClass: "pii_contact",
          occurredAt,
          idempotencyKey: purchaseKey,
        }),
      "changed conversion identity must be rejected",
    );

    const browserOnly = await insertBookAttributionEvent({
      eventName: "view_item",
      sourceAuthority: "book_commerce",
      privacyClass: "public",
      occurredAt,
      idempotencyKey: unique("book-view"),
    });
    equal(
      browserOnly.deliveries.length,
      0,
      "browser-only interactions must not create server delivery work",
    );

    const lead = await insertBookAttributionEvent({
      eventName: "audit_application_submit",
      sourceAuthority: "book_commerce",
      privacyClass: "pii_contact",
      occurredAt,
      idempotencyKey: unique("book-application-submit"),
    });
    equal(
      lead.deliveries.map((row) => row.provider).sort().join(","),
      "ga4,meta_capi",
      "verified application submit maps only to approved lead providers",
    );
    check(lead.deliveries.every((row) => row.status === "deferred"), "lead intents deferred");

    const closed = await insertBookAttributionEvent({
      eventName: "client_closed",
      sourceAuthority: "manual_import",
      privacyClass: "sensitive",
      amountCents: 250_000,
      currency: "USD",
      occurredAt,
      idempotencyKey: unique("book-client-closed"),
    });
    equal(
      closed.deliveries.map((row) => row.provider).sort().join(","),
      "ga4,google_ads",
      "sensitive close facts never create Meta intent",
    );
    check(closed.deliveries.every((row) => row.status === "deferred"), "close intents deferred");

    const facts = await loadAttributionEventFacts(purchase.event.id);
    check(facts, "event facts should load");
    equal(facts.event.id, purchase.event.id, "facts event identity");
    equal(facts.attributionSnapshot.gclid, "approved-click-id", "facts click ID");
    check(!("contactFacts" in facts), "generic fact loader must not assemble contact PII");
    equal(facts.orderFacts, null, "order facts absent without an order");

    const ga4 = purchase.deliveries.find((row) => row.provider === "ga4");
    check(ga4, "purchase GA4 intent exists");
    await db
      .update(bookAttributionEventDeliveries)
      .set({ status: "pending" })
      .where(eq(bookAttributionEventDeliveries.id, ga4.id));

    const leaseToken = unique("lease");
    const claimed = await claimAttributionDeliveryBatch({
      provider: "ga4",
      leaseOwnerToken: leaseToken,
      leaseDurationMs: 30_000,
      batchSize: 1,
    });
    equal(claimed.length, 1, "one due GA4 intent claimed");
    equal(claimed[0].id, ga4.id, "expected intent claimed");
    equal(claimed[0].leaseToken, leaseToken, "claim is lease-owned");

    await db
      .update(bookAttributionEventDeliveries)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(bookAttributionEventDeliveries.id, ga4.id));
    const staleFinalize = await finalizeAttributionDelivery({
      deliveryId: ga4.id,
      leaseToken,
    });
    equal(staleFinalize, null, "expired lease cannot finalize before recovery");
    const staleFailure = await failAttributionDelivery({
      deliveryId: ga4.id,
      leaseToken,
      errorClass: "network_timeout",
      retryAfterMs: 60_000,
    });
    equal(staleFailure.delivery, null, "expired lease cannot record a failure");
    equal(staleFailure.exhausted, false, "stale failure cannot exhaust delivery");
    const firstRecovery = await recoverExpiredAttributionLeases({
      provider: "ga4",
      limit: 10,
    });
    equal(firstRecovery.recovered, 1, "expired pending lease recovered");

    const failureLease = unique("failure-lease");
    const failureClaim = await claimAttributionDeliveryBatch({
      provider: "ga4",
      leaseOwnerToken: failureLease,
      leaseDurationMs: 30_000,
      batchSize: 1,
    });
    equal(failureClaim[0]?.id, ga4.id, "recovered pending intent can be reclaimed");
    const failed = await failAttributionDelivery({
      deliveryId: ga4.id,
      leaseToken: failureLease,
      errorClass: "network_timeout",
      retryAfterMs: 60_000,
    });
    check(failed.delivery, "leased failure should update");
    equal(failed.delivery.status, "retry", "transient failure becomes retry");
    equal(failed.delivery.attempts, 1, "failure increments attempts once");
    check(failed.delivery.nextAttemptAt, "retry receives a due time");

    await db
      .update(bookAttributionEventDeliveries)
      .set({
        status: "retry",
        nextAttemptAt: null,
        leaseToken: "expired-lease",
        leaseExpiresAt: new Date(Date.now() - 1_000),
      })
      .where(eq(bookAttributionEventDeliveries.id, ga4.id));
    const recovered = await recoverExpiredAttributionLeases({
      provider: "ga4",
      limit: 10,
    });
    equal(recovered.recovered, 1, "expired lease recovered");

    const finalLease = unique("final-lease");
    const reclaimed = await claimAttributionDeliveryBatch({
      provider: "ga4",
      leaseOwnerToken: finalLease,
      leaseDurationMs: 30_000,
      batchSize: 1,
    });
    equal(reclaimed[0]?.id, ga4.id, "recovered intent can be reclaimed");
    const finalized = await finalizeAttributionDelivery({
      deliveryId: ga4.id,
      leaseToken: finalLease,
      externalReceiptId: "sanitized-receipt",
    });
    check(finalized, "current lease can finalize");
    equal(finalized.status, "sent", "successful delivery becomes sent");
    equal(finalized.attempts, 2, "success attempt counted once");
    equal(finalized.externalReceiptId, "sanitized-receipt", "receipt persisted");

    const persistedEvents = await db
      .select({ id: bookAttributionEvents.id })
      .from(bookAttributionEvents)
      .where(eq(bookAttributionEvents.idempotencyKey, purchaseKey));
    equal(persistedEvents.length, 1, "unique key permits exactly one ledger row");

    let mutationState: string | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(bookAttributionEvents)
          .set({ amountCents: 500 })
          .where(eq(bookAttributionEvents.id, purchase.event.id));
      });
    } catch (error) {
      mutationState = sqlState(error);
    }
    equal(mutationState, "55000", "database rejects ledger mutation");

    let deletionState: string | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx
          .delete(bookAttributionEvents)
          .where(eq(bookAttributionEvents.id, purchase.event.id));
      });
    } catch (error) {
      deletionState = sqlState(error);
    }
    equal(deletionState, "55000", "database rejects ledger deletion");

    const fkResult = await db.execute(sql`
      SELECT count(*)::int AS count
      FROM pg_constraint
      WHERE conrelid = 'book_attribution_events'::regclass
        AND contype = 'f'
    `);
    equal(
      Number(fkResult.rows[0]?.count),
      0,
      "immutable source snapshots do not mutate through foreign-key cascades",
    );
  });

  console.log("book-attribution-event-storage: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});