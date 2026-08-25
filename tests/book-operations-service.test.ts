/* test-registration
{
  "name": "Book Operations read-model privacy, correlations, and replay idempotency",
  "regression": true,
  "smoke": true,
  "smokeReason": "Database-backed coverage for the new commerce oversight boundary: support search may match raw contact data but only returns masks; detail and exception projections omit raw payloads, intake data, addresses, and provider errors while preserving exact correlation IDs; GHL replay is eligible-type-only, actor-audited, and duplicate-safe.",
  "tier": "medium",
  "tierReason": "Seeds one small, random-suffixed aggregate in the per-run test database and deletes it in reverse dependency order; no provider calls, servers, workers, timers, or child processes."
}
test-registration */

import "./helpers/forceTestEnv";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { eq, inArray } from "drizzle-orm";

import {
  bookAppointments,
  bookAttributionEventDeliveries,
  bookAttributionEvents,
  bookAuditApplications,
  bookCheckoutSessions,
  bookContacts,
  bookDeliveryAudit,
  bookEntitlements,
  bookLifecycleEvents,
  bookOrders,
  bookOutbox,
  bookPaymentEvents,
  bookProviderCorrelations,
  users,
} from "@shared/schema";
import { closeDbPools, getDb } from "../server/db";
import {
  getBookOperationRecord,
  getBookOperationsSummary,
  listBookOperationExceptions,
  listBookOperationRecords,
  maskEmail,
  maskName,
  maskPhone,
  OutboxReplayNotEligibleError,
  replayBookOutboxEntry,
} from "../server/services/bookOperations";

const run = crypto.randomUUID().slice(0, 12);
const ids = {
  actor: `bops-actor-${run}`,
  contact: `bops-contact-${run}`,
  checkout: `bops-checkout-${run}`,
  order: `bops-order-${run}`,
  entitlement: `bops-entitlement-${run}`,
  deliveryAudit: `bops-delivery-${run}`,
  paymentEvent: `bops-payment-${run}`,
  lifecycle: `bops-lifecycle-${run}`,
  correlation: `bops-correlation-${run}`,
  application: `bops-application-${run}`,
  appointment: `bops-appointment-${run}`,
  outbox: `bops-outbox-${run}`,
  nonGhlOutbox: `bops-non-ghl-outbox-${run}`,
  attribution: `bops-attribution-${run}`,
  attributionDelivery: `bops-attr-delivery-${run}`,
};

const rawEmail = `private-buyer-${run}@example.test`;
const rawName = `Private Buyer ${run}`;
const rawPhone = `+1555${run.replace(/\D/g, "").padEnd(7, "2").slice(0, 7)}`;
const extraCheckouts = Array.from(
  { length: 25 },
  (_, index) => `bops-checkout-slice-${run}-${index}`,
);
const extraOrders = Array.from(
  { length: 25 },
  (_, index) => `bops-order-slice-${run}-${index}`,
);
const secrets = [
  rawEmail,
  rawName,
  rawPhone,
  `private-address-${run}`,
  `private-payment-payload-${run}`,
  `private-intake-answer-${run}`,
  `private-appointment-note-${run}`,
  `private-outbox-payload-${run}`,
  `private-lifecycle-metadata-${run}`,
  `private-correlation-metadata-${run}`,
  `raw-provider-error-${run}`,
];

function assertPrivateProjection(value: unknown, label: string): void {
  const json = JSON.stringify(value);
  for (const secret of secrets) {
    assert(!json.includes(secret), `${label} omits private value ${secret}`);
  }
}

async function seed(): Promise<void> {
  const db = getDb();
  await db.insert(users).values({
    id: ids.actor,
    email: `bops-operator-${run}@example.test`,
    firstName: "Book",
    lastName: "Operator",
    role: "team_lead",
    authorityLevel: "leadership",
  });
  await db.insert(bookContacts).values({
    id: ids.contact,
    email: rawEmail,
    name: rawName,
    phone: rawPhone,
    latestTouchUtmMedium: "paid_social",
    latestTouchUtmCampaign: `campaign-${run}`,
  });
  await db.insert(bookCheckoutSessions).values({
    id: ids.checkout,
    contactId: ids.contact,
    packageCode: "complete",
    status: "completed",
    providerSessionId: `cs_${run}`,
    subtotalAmountCents: 1999,
    amountTotalCents: 1999,
    paymentState: "unknown",
    paymentUnknownReason: `raw-provider-error-${run}`,
    addressSnapshot: { line1: `private-address-${run}`, postalCode: "00000" },
  });
  await db.insert(bookOrders).values({
    id: ids.order,
    contactId: ids.contact,
    checkoutSessionId: ids.checkout,
    orderNumber: `BOPS-${run}`,
    status: "payment_captured",
    packageCode: "complete",
    subtotalAmountCents: 1999,
    totalAmountCents: 1999,
    latestTouchUtmMedium: "paid_social",
    latestTouchUtmCampaign: `campaign-${run}`,
  });
  await db.insert(bookEntitlements).values({
    id: ids.entitlement,
    contactId: ids.contact,
    orderId: ids.order,
    packageCode: "complete",
    entitlementCode: "digital_book",
    status: "active",
  });
  await db.insert(bookDeliveryAudit).values({
    id: ids.deliveryAudit,
    entitlementId: ids.entitlement,
    eventType: "delivery_attempt",
    outcome: "failed",
    detail: `unsafe operator note ${rawEmail} raw-provider-error-${run}`,
  });
  await db.insert(bookCheckoutSessions).values(
    extraCheckouts.map((id, index) => ({
      id,
      packageCode: "complete" as const,
      status: "completed" as const,
      providerSessionId: `cs_slice_${run}_${index}`,
      subtotalAmountCents: 1999,
      amountTotalCents: 1999,
      paymentState: "unknown" as const,
    })),
  );
  await db.insert(bookOrders).values(
    extraOrders.map((id, index) => ({
      id,
      checkoutSessionId: extraCheckouts[index],
      orderNumber: `BOPS-SLICE-${run}-${index}`,
      status: "payment_captured" as const,
      packageCode: "complete" as const,
      subtotalAmountCents: 1999,
      totalAmountCents: 1999,
      latestTouchUtmMedium: `channel-${run}-${index}`,
      latestTouchUtmCampaign: `campaign-${run}-${index}`,
    })),
  );
  await db.insert(bookPaymentEvents).values({
    id: ids.paymentEvent,
    orderId: ids.order,
    checkoutSessionId: ids.checkout,
    provider: "stripe",
    providerEventId: `evt_${run}`,
    eventType: "checkout.session.completed",
    amountCents: 1999,
    currency: "USD",
    rawPayload: { secret: `private-payment-payload-${run}` },
  });
  await db.insert(bookLifecycleEvents).values({
    id: ids.lifecycle,
    contactId: ids.contact,
    orderId: ids.order,
    checkoutSessionId: ids.checkout,
    eventType: "payment_captured",
    reason: "provider_webhook",
    metadata: { secret: `private-lifecycle-metadata-${run}` },
    idempotencyKey: `bops-seed-lifecycle-${run}`,
  });
  await db.insert(bookProviderCorrelations).values({
    id: ids.correlation,
    provider: "stripe",
    providerEntityType: "payment_intent",
    providerEntityId: `pi_${run}`,
    localEntityType: "order",
    localEntityId: ids.order,
    metadata: { secret: `private-correlation-metadata-${run}` },
  });
  await db.insert(bookAuditApplications).values({
    id: ids.application,
    contactId: ids.contact,
    orderId: ids.order,
    idempotencyKey: `bops-application-${run}`,
    status: "qualified",
    answers: { secret: `private-intake-answer-${run}` },
    submittedAt: new Date(),
    decidedAt: new Date(),
  });
  await db.insert(bookAppointments).values({
    id: ids.appointment,
    contactId: ids.contact,
    orderId: ids.order,
    entitlementId: ids.entitlement,
    auditApplicationId: ids.application,
    status: "scheduled",
    scheduledAt: new Date(Date.now() + 86_400_000),
    timezone: "America/Chicago",
    notes: `private-appointment-note-${run}`,
  });
  await db.insert(bookOutbox).values({
    id: ids.outbox,
    eventType: "order.payment_captured",
    sourceType: "order",
    sourceId: ids.order,
    status: "dead_letter",
    attemptCount: 5,
    payload: { secret: `private-outbox-payload-${run}` },
    errorMessage: `raw-provider-error-${run}`,
    idempotencyKey: `bops-outbox-seed-${run}`,
  });
  await db.insert(bookOutbox).values({
    id: ids.nonGhlOutbox,
    eventType: "analytics.delivery_requested",
    sourceType: "order",
    sourceId: ids.order,
    status: "failed",
    payload: { secret: `private-outbox-payload-${run}` },
    errorMessage: `raw-provider-error-${run}`,
    idempotencyKey: `bops-non-ghl-outbox-seed-${run}`,
  });
  await db.insert(bookAttributionEvents).values({
    id: ids.attribution,
    eventName: "purchase",
    sourceAuthority: "book_commerce",
    contactId: ids.contact,
    checkoutSessionId: ids.checkout,
    orderId: ids.order,
    packageCode: "complete",
    amountCents: 1999,
    currency: "USD",
    occurredAt: new Date(),
    idempotencyKey: `bops-purchase-${run}`,
  });
  await db.insert(bookAttributionEventDeliveries).values({
    id: ids.attributionDelivery,
    eventId: ids.attribution,
    provider: "meta_capi",
    status: "dead",
    attempts: 5,
    externalReceiptId: `meta_receipt_${run}`,
    externalIdempotencyKey: `meta_delivery_${run}`,
    errorClass: "rate_limited",
  });
}

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.delete(bookAttributionEvents).where(eq(bookAttributionEvents.id, ids.attribution));
  await db.delete(bookOutbox).where(eq(bookOutbox.id, ids.outbox));
  await db.delete(bookOutbox).where(eq(bookOutbox.id, ids.nonGhlOutbox));
  await db.delete(bookAppointments).where(eq(bookAppointments.id, ids.appointment));
  await db.delete(bookAuditApplications).where(eq(bookAuditApplications.id, ids.application));
  await db.delete(bookProviderCorrelations).where(eq(bookProviderCorrelations.id, ids.correlation));
  await db.delete(bookPaymentEvents).where(eq(bookPaymentEvents.id, ids.paymentEvent));
  await db
    .delete(bookLifecycleEvents)
    .where(eq(bookLifecycleEvents.checkoutSessionId, ids.checkout));
  await db.delete(bookEntitlements).where(eq(bookEntitlements.id, ids.entitlement));
  await db.delete(bookOrders).where(inArray(bookOrders.id, extraOrders));
  await db.delete(bookOrders).where(eq(bookOrders.id, ids.order));
  await db
    .delete(bookCheckoutSessions)
    .where(inArray(bookCheckoutSessions.id, extraCheckouts));
  await db.delete(bookCheckoutSessions).where(eq(bookCheckoutSessions.id, ids.checkout));
  await db.delete(bookContacts).where(eq(bookContacts.id, ids.contact));
  await db.delete(users).where(eq(users.id, ids.actor));
}

async function main(): Promise<void> {
  assert.equal(maskEmail("buyer@example.com"), "b***@example.com");
  assert.equal(maskName("Buyer Person"), "B***");
  assert.equal(maskPhone("+1 (555) 867-5309"), "***5309");

  await seed();
  try {
    const list = await listBookOperationRecords({
      search: rawEmail,
      status: "all",
      limit: 25,
      offset: 0,
    });
    assert.equal(list.total, 1);
    assert.equal(list.items[0]?.contactEmailMasked, `p***@example.test`);
    assertPrivateProjection(list, "record list");

    const detail = await getBookOperationRecord(ids.checkout);
    assert(detail);
    assert.equal(detail.applicationStatus, "qualified");
    assert.equal(detail.appointmentStatus, "scheduled");
    assert.equal(detail.paymentEvents[0]?.providerEventId, `evt_${run}`);
    assert.equal(detail.providerCorrelations[0]?.providerEntityId, `pi_${run}`);
    assert.equal(detail.attributionDeliveries[0]?.eventId, ids.attribution);
    assert.equal(
      detail.attributionDeliveries[0]?.externalIdempotencyKey,
      `meta_delivery_${run}`,
    );
    assert.equal(detail.outboxEntries[0]?.id, ids.outbox);
    assert.equal(detail.outboxEntries.length, 1, "detail excludes non-GHL outbox rows");
    assertPrivateProjection(detail, "record detail");

    const exceptions = await listBookOperationExceptions({
      kind: "all",
      limit: 100,
      offset: 0,
    });
    const ownExceptions = exceptions.items.filter((item) =>
      [
        ids.checkout,
        ids.outbox,
        ids.attributionDelivery,
        ids.deliveryAudit,
      ].includes(item.entityId),
    );
    assert.equal(ownExceptions.length, 4);
    assertPrivateProjection(ownExceptions, "exception list");

    const summary = await getBookOperationsSummary({
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 86_400_000),
    });
    assert(summary.funnel.find((stage) => stage.stage === "purchase")!.count >= 1);
    assert(summary.financials.orderCount >= 26);
    assert.equal(summary.channelSlices.length, 21);
    assert.equal(summary.campaignSlices.length, 21);
    assert(
      summary.channelSlices.some(
        (slice) => slice.key === "__other__" && slice.orderCount >= 5,
      ),
      "high-cardinality channels are bounded with an accurate Other bucket",
    );
    assert(
      summary.campaignSlices.some(
        (slice) => slice.key === "__other__" && slice.orderCount >= 5,
      ),
      "high-cardinality campaigns are bounded with an accurate Other bucket",
    );
    assert.deepEqual(summary.marginInputs, { status: "unavailable", value: null });

    await assert.rejects(
      replayBookOutboxEntry({
        outboxId: ids.nonGhlOutbox,
        actorUserId: ids.actor,
        idempotencyKey: `non-ghl-replay-key-${run}`,
      }),
      OutboxReplayNotEligibleError,
    );

    const first = await replayBookOutboxEntry({
      outboxId: ids.outbox,
      actorUserId: ids.actor,
      idempotencyKey: `browser-replay-key-${run}`,
    });
    assert.deepEqual(first, {
      replayed: true,
      idempotent: false,
      outboxId: ids.outbox,
    });
    const duplicate = await replayBookOutboxEntry({
      outboxId: ids.outbox,
      actorUserId: ids.actor,
      idempotencyKey: `browser-replay-key-${run}`,
    });
    assert.deepEqual(duplicate, {
      replayed: false,
      idempotent: true,
      outboxId: ids.outbox,
    });
    await assert.rejects(
      replayBookOutboxEntry({
        outboxId: ids.outbox,
        actorUserId: ids.actor,
        idempotencyKey: `different-replay-key-${run}`,
      }),
      OutboxReplayNotEligibleError,
    );

    const [outboxRow] = await getDb()
      .select({ status: bookOutbox.status })
      .from(bookOutbox)
      .where(eq(bookOutbox.id, ids.outbox));
    assert.equal(outboxRow?.status, "pending");
    const audits = await getDb()
      .select({
        actorUserId: bookLifecycleEvents.actorUserId,
        reason: bookLifecycleEvents.reason,
      })
      .from(bookLifecycleEvents)
      .where(eq(bookLifecycleEvents.reason, "operator_requested_ghl_outbox_replay"));
    const ownAudits = audits.filter((audit) => audit.actorUserId === ids.actor);
    assert.equal(ownAudits.length, 1);
  } finally {
    await cleanup();
    await closeDbPools();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});