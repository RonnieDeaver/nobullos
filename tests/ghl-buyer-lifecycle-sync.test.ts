/* test-registration
{
  "name": "GHL buyer lifecycle sync — real dispatch seams: config lockstep/fail-closed, canonical consent gating, purchase tag-removal ordering, replay idempotency, reconciliation retryable errors, opportunity timeout reconciliation, relay claim/retry/dead-letter constants (Task #5105)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Fast hermetic suite that drives the real dispatchGhlBuyerSyncEvent state machine through injected seams (fake GHL API + fake DB loaders + fake consent) and uses the private per-run DB for a two-claim lease ownership check, asserting the ordering, replay, consent, and reconciliation invariants the outbound buyer lifecycle depends on.",
  "tier": "small",
  "tierReason": "No external network; dispatch behavior is in-memory and one small private-Postgres check proves concurrent claims lease one distinct row each. Runs in <5s.",
  "scanPaths": [
    "server/services/ghlBuyerSync.ts",
    "server/services/ghlOutboundSync.ts"
  ]
}
test-registration */

import "./helpers/forceTestEnv";

import {
  ghlBuyerSyncConfigSchema,
  dispatchGhlBuyerSyncEvent,
  GhlReconciliationNeededError,
  GHL_TAGS,
  GHL_FIELD_NAMES,
  type GhlBuyerSyncDeps,
  type GhlBuyerSyncConfig,
  type ContactRecord,
  type OrderRecord,
  type AppointmentRecord,
  type ApplicationRecord,
  type CheckoutSessionRecord,
  type CanonicalConsent,
} from "../server/services/ghlBuyerSync";
import type { BookOutboxEventType } from "@shared/schema";

// ─── Test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  const sym = ok ? "✓" : "✗";
  if (ok) {
    passed++;
    console.log(`  ${sym} ${name}`);
  } else {
    failed++;
    console.error(`  ${sym} FAIL: ${name}${detail ? ` (${detail})` : ""}`);
  }
}

// ─── Fixture: a fully valid config keyed by exact approved names ──────────────

function validConfigObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const stageId = (n: string) => `stage-${n.replace(/[^a-z]+/gi, "-").toLowerCase()}`;
  const fieldId = (n: string) => `field-${n}`;
  return {
    version: 1,
    enabled: true,
    approved: true,
    approvalEvidence: "Owner J. Doe approved 2026-01-15 (ref TASK-5105)",
    environment: "development",
    productionActivationConfirmed: false,
    locationId: "loc-123",
    pipelineId: "pipe-456",
    stages: {
      "Checkout Started": stageId("Checkout Started"),
      "Book Purchased": stageId("Book Purchased"),
      Applied: stageId("Applied"),
      Qualified: stageId("Qualified"),
      "Unqualified / Manual Review": stageId("Unqualified"),
      "Meeting Booked": stageId("Meeting Booked"),
      "Meeting Attended": stageId("Meeting Attended"),
      "No-Show": stageId("No-Show"),
      "Proposal / Active Sales": stageId("Proposal"),
      "Closed Client": stageId("Closed Client"),
      "Lost / Unqualified": stageId("Lost"),
    },
    // Built from the exported GHL_FIELD_NAMES so the fixture stays in lockstep
    // with the config schema — no self-rederived field list.
    customFields: Object.fromEntries(GHL_FIELD_NAMES.map((n) => [n, fieldId(n)])),
    ownerMap: { salesTaskOwner: "sales@firm.com", manualReviewOwner: "ops@firm.com" },
    calendarId: "cal-789",
    workflowIds: {
      workflowA: "wf-a",
      workflowB: "wf-b",
      workflowC: "wf-c",
      workflowD: "wf-d",
      workflowE: "wf-e",
      workflowF: "wf-f",
      postAttended: "wf-pa",
    },
    workflowVersionIds: {
      workflowA: "wf-a-v1",
      workflowB: "wf-b-v1",
      workflowC: "wf-c-v1",
      workflowD: "wf-d-v1",
      workflowE: "wf-e-v1",
      workflowF: "wf-f-v1",
      postAttended: "wf-pa-v1",
    },
    workflowStopConditions: {
      workflowA: "Workflow A exits on purchase — §19 verified 2026-01-15",
      workflowB: "Workflow B exits on application submit — §19 verified 2026-01-15",
      workflowC: "Workflow C exits on booking — §19 verified 2026-01-15",
      workflowD: "Workflow D exits on attended — §19 verified 2026-01-15",
      workflowE: "Workflow E exits on reschedule — §19 verified 2026-01-15",
      workflowF: "Workflow F exits on close/refund — §19 verified 2026-01-15",
      postAttended: "Post-attended exits on close — §19 verified 2026-01-15",
    },
    senderApprovals: {
      marketingEmailSenderRef: "sender-email-approved-ref",
      smsSenderRef: "sender-sms-a2p-approved-ref",
      ownershipRegistryRef: "owner-registry-ref",
    },
    smsConsentCopyVersion: "sms-copy-v3",
    physicalFulfillmentMessagingEnabled: false,
    ...overrides,
  };
}

function parsedConfig(overrides: Record<string, unknown> = {}): GhlBuyerSyncConfig {
  const res = ghlBuyerSyncConfigSchema.safeParse(validConfigObject(overrides));
  if (!res.success) throw new Error("fixture config invalid: " + JSON.stringify(res.error.issues));
  return res.data;
}

// ─── Fake GHL API that records ordered calls ─────────────────────────────────

interface RecordedCall {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
}

interface FakeGhlState {
  calls: RecordedCall[];
  contactByEmail: Map<string, string>; // email → ghl contact id
  createdContactId: string;
  createdOpportunityId: string;
  searchOpportunityResult: string | null; // durable-field search hit
  failNextPost: { path: string; error: Error } | null;
}

function makeFakeGhl(state: FakeGhlState): (path: string, init?: RequestInit) => Promise<Response> {
  return async (path: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    state.calls.push({ path, method, body });

    if (state.failNextPost && path.startsWith(state.failNextPost.path) && method === "POST") {
      const err = state.failNextPost.error;
      state.failNextPost = null;
      throw err;
    }

    // Contact duplicate search
    if (path.startsWith("/contacts/search/duplicate")) {
      const email = decodeURIComponent(path.split("email=")[1] ?? "");
      const id = state.contactByEmail.get(email);
      return jsonResponse({ contact: id ? { id, email } : undefined });
    }
    // Opportunity durable-field search
    if (path.startsWith("/opportunities/search")) {
      if (state.searchOpportunityResult) {
        return jsonResponse({
          opportunities: [
            {
              id: state.searchOpportunityResult,
              customFields: [{ id: "field-order_id", fieldValue: decodeURIComponent(path.split("query=")[1] ?? "") }],
            },
          ],
        });
      }
      return jsonResponse({ opportunities: [] });
    }
    // Create contact
    if (path === "/contacts/" && method === "POST") {
      return jsonResponse({ contact: { id: state.createdContactId } });
    }
    // Create opportunity
    if (path === "/opportunities/" && method === "POST") {
      return jsonResponse({ opportunity: { id: state.createdOpportunityId } });
    }
    // Tag / field / stage mutations
    return jsonResponse({ ok: true });
  };
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ─── Deps builder ─────────────────────────────────────────────────────────────

interface FakeWorld {
  ghl: FakeGhlState;
  contacts: Map<string, ContactRecord>;
  orders: Map<string, OrderRecord>;
  appointments: Map<string, AppointmentRecord>;
  applications: Map<string, ApplicationRecord>;
  sessions: Map<string, CheckoutSessionRecord>;
  consentByPhone: Map<string, CanonicalConsent>;
  entitlementsByOrder: Map<string, string[]>; // localOrderId → active entitlement codes
  contactCorrelation: Map<string, string>; // localContactId → ghlContactId
  opportunityCorrelation: Map<string, string>; // localOrderId → ghlOpportunityId
}

function makeWorld(): FakeWorld {
  return {
    ghl: {
      calls: [],
      contactByEmail: new Map(),
      createdContactId: "ghl-contact-new",
      createdOpportunityId: "ghl-opp-new",
      searchOpportunityResult: null,
      failNextPost: null,
    },
    contacts: new Map(),
    orders: new Map(),
    appointments: new Map(),
    applications: new Map(),
    sessions: new Map(),
    consentByPhone: new Map(),
    entitlementsByOrder: new Map(),
    contactCorrelation: new Map(),
    opportunityCorrelation: new Map(),
  };
}

function makeDeps(world: FakeWorld, config: GhlBuyerSyncConfig): GhlBuyerSyncDeps {
  return {
    ghlApiRequest: makeFakeGhl(world.ghl),
    loadConfig: async () => ({ ok: true, config }),
    loadContact: async (id) => world.contacts.get(id) ?? null,
    loadOrder: async (id) => world.orders.get(id) ?? null,
    loadOrderByCheckoutSession: async (sid) =>
      [...world.orders.values()].find((o) => o.id.includes(sid)) ?? null,
    loadAppointment: async (id) => world.appointments.get(id) ?? null,
    loadApplication: async (id) => world.applications.get(id) ?? null,
    loadCheckoutSession: async (id) => world.sessions.get(id) ?? null,
    loadActiveEntitlementCodes: async (orderId) => world.entitlementsByOrder.get(orderId) ?? [],
    getConsentForPhone: async (phone) =>
      world.consentByPhone.get(phone) ?? {
        state: "unknown",
        source: null,
        evidence: null,
        copyVersion: null,
        sourceUrl: null,
        confirmedAt: null,
      },
    findGhlContactId: async (id) => world.contactCorrelation.get(id) ?? null,
    findGhlOpportunityId: async (id) => world.opportunityCorrelation.get(id) ?? null,
    storeContactCorrelation: async (ghlId, localId) => {
      world.contactCorrelation.set(localId, ghlId);
    },
    storeOpportunityCorrelation: async (ghlId, localId) => {
      world.opportunityCorrelation.set(localId, ghlId);
    },
    currentEnvironment: () => "development",
  };
}

async function run(): Promise<void> {
  // ─── (1) Config lockstep + fail-closed ─────────────────────────────────────
  console.log("\n(1) Config lockstep + fail-closed");

  check("valid lockstep config parses", ghlBuyerSyncConfigSchema.safeParse(validConfigObject()).success);
  check(
    "physicalFulfillmentMessagingEnabled:true rejected",
    !ghlBuyerSyncConfigSchema.safeParse(validConfigObject({ physicalFulfillmentMessagingEnabled: true })).success,
  );
  check("version:2 rejected", !ghlBuyerSyncConfigSchema.safeParse(validConfigObject({ version: 2 })).success);
  check(
    "missing approvalEvidence rejected",
    !ghlBuyerSyncConfigSchema.safeParse(validConfigObject({ approvalEvidence: "" })).success,
  );
  {
    const cfg = validConfigObject();
    delete (cfg as any).stages["Meeting Booked"];
    check("missing approved stage rejected", !ghlBuyerSyncConfigSchema.safeParse(cfg).success);
  }
  {
    const cfg = validConfigObject();
    delete (cfg as any).customFields.order_id;
    check("missing approved custom field rejected", !ghlBuyerSyncConfigSchema.safeParse(cfg).success);
  }
  {
    const cfg = validConfigObject();
    (cfg as any).extra = "nope";
    check("extra field rejected (strict)", !ghlBuyerSyncConfigSchema.safeParse(cfg).success);
  }
  check(
    "GHL_TAGS use exact approved literals",
    GHL_TAGS.buyer === "book_buyer" &&
      GHL_TAGS.checkoutStarted === "book_checkout_started" &&
      GHL_TAGS.hirsNoShow === "HIRS_no_show" &&
      GHL_TAGS.bonusViewed === "book_bonus_viewed",
  );

  // Disabled / not-approved dispatch → DEFERRED (never delivered, never an
  // attempt consumed). deferred is distinct from a genuine irrelevant skip.
  {
    const world = makeWorld();
    const deps = makeDeps(world, parsedConfig());
    deps.loadConfig = async () => ({ ok: false, reason: "disabled" });
    const r = await dispatchGhlBuyerSyncEvent("order.payment_captured", { orderId: "o1" }, deps);
    check(
      "disabled config → deferred (not delivered, not skipped-as-success)",
      r.deferred === true && r.ok === false && r.skipped === false,
    );
  }
  // Kill switch dispatch → DEFERRED too (never delivered).
  {
    const world = makeWorld();
    const deps = makeDeps(world, parsedConfig());
    deps.loadConfig = async () => ({ ok: false, reason: "not_approved" });
    const r = await dispatchGhlBuyerSyncEvent("order.payment_captured", { orderId: "o1" }, deps);
    check(
      "not-approved config → deferred",
      r.deferred === true && r.ok === false && r.skipped === false,
    );
  }

  // ─── (2) Purchase: tag REMOVAL before ADD, self-sufficient load ────────────
  console.log("\n(2) Purchase ordering + self-sufficient DB load");
  {
    const world = makeWorld();
    const config = parsedConfig();
    world.contacts.set("c1", { id: "c1", email: "buyer@x.com", name: "Pat Buyer", phone: "+15551234567" });
    world.orders.set("o1", {
      id: "o1",
      orderNumber: "ORD-1",
      contactId: "c1",
      packageCode: "complete",
      totalAmountCents: 199900,
      currency: "USD",
      status: "payment_captured",
    });
    world.contactCorrelation.set("c1", "ghl-c1");
    const deps = makeDeps(world, config);

    // payload carries ONLY orderId (as real order outbox does) — handler must
    // resolve contact/package/amount from the DB.
    const r = await dispatchGhlBuyerSyncEvent("order.payment_captured", { orderId: "o1", fromStatus: "pending_payment", toStatus: "payment_captured" }, deps);
    check("purchase dispatch ok from orderId-only payload", r.ok === true);

    const tagCalls = world.ghl.calls.filter((c) => c.path.endsWith("/tags"));
    const removeIdx = tagCalls.findIndex((c) => c.method === "DELETE");
    const addBuyerIdx = tagCalls.findIndex(
      (c) => c.method === "POST" && Array.isArray(c.body?.tags) && (c.body!.tags as string[]).includes("book_buyer"),
    );
    check("abandonment tags removed before buyer added", removeIdx >= 0 && addBuyerIdx >= 0 && removeIdx < addBuyerIdx);

    const removedTags = tagCalls[removeIdx]?.body?.tags as string[];
    check(
      "removal targets book_checkout_started + workflow_a_active",
      removedTags.includes("book_checkout_started") && removedTags.includes("workflow_a_active"),
    );
    const addedTags = tagCalls[addBuyerIdx]?.body?.tags as string[];
    check(
      "complete package adds lfre_complete + component SKU tags",
      addedTags.includes("lfre_complete") && addedTags.includes("lfre_digital") && addedTags.includes("lfre_audio") && addedTags.includes("lfre_print"),
    );
    check("opportunity created for order", world.opportunityCorrelation.get("o1") === "ghl-opp-new");
  }

  // ─── (3) Canonical consent gating from ledger (not snapshot) ───────────────
  console.log("\n(3) Canonical consent gating from ledger seam");
  {
    const world = makeWorld();
    const config = parsedConfig();
    world.contacts.set("c1", { id: "c1", email: "b@x.com", name: "B", phone: "+15550001111" });
    world.orders.set("o1", { id: "o1", orderNumber: "ORD-2", contactId: "c1", packageCode: "digital", totalAmountCents: 49900, currency: "USD", status: "payment_captured" });
    world.contactCorrelation.set("c1", "ghl-c1");
    // Ledger says opted_in with evidence + confirmedAt.
    const confirmedAt = new Date("2026-02-01T00:00:00.000Z");
    world.consentByPhone.set("+15550001111", {
      state: "opted_in",
      source: "checkout_choice",
      evidence: "checkbox affirmative sid SMxxx",
      copyVersion: "sms-copy-v3",
      sourceUrl: "https://book/checkout",
      confirmedAt,
    });
    const deps = makeDeps(world, config);
    await dispatchGhlBuyerSyncEvent("order.payment_captured", { orderId: "o1" }, deps);

    const fieldPuts = world.ghl.calls.filter((c) => c.method === "PUT" && Array.isArray(c.body?.customFields));
    const allFields = fieldPuts.flatMap((c) => c.body!.customFields as Array<{ id: string; value: string }>);
    const smsStatus = allFields.find((f) => f.id === config.customFields.sms_marketing_status);
    const smsTs = allFields.find((f) => f.id === config.customFields.sms_consent_timestamp);
    check("sms_marketing_status mirrored as opted_in from ledger", smsStatus?.value === "opted_in");
    check("sms_consent_timestamp mirrored from ledger confirmedAt", smsTs?.value === confirmedAt.toISOString());
  }
  {
    // unknown consent (no ledger row) → mirrored as unknown, never opted_in.
    const world = makeWorld();
    const config = parsedConfig();
    world.contacts.set("c1", { id: "c1", email: "b@x.com", name: "B", phone: "+15559998888" });
    world.orders.set("o1", { id: "o1", orderNumber: "ORD-3", contactId: "c1", packageCode: "digital", totalAmountCents: 49900, currency: "USD", status: "payment_captured" });
    world.contactCorrelation.set("c1", "ghl-c1");
    const deps = makeDeps(world, config);
    await dispatchGhlBuyerSyncEvent("order.payment_captured", { orderId: "o1" }, deps);
    const allFields = world.ghl.calls
      .filter((c) => c.method === "PUT" && Array.isArray(c.body?.customFields))
      .flatMap((c) => c.body!.customFields as Array<{ id: string; value: string }>);
    const smsStatus = allFields.find((f) => f.id === config.customFields.sms_marketing_status);
    check("absent ledger row mirrors unknown (never opted_in)", smsStatus?.value === "unknown");
  }

  // ─── (4) Missing correlation → RETRYABLE reconciliation, not success ───────
  console.log("\n(4) Missing contact/correlation → retryable reconciliation");
  {
    const world = makeWorld();
    const config = parsedConfig();
    // bonus.viewed for a contact with no GHL correlation yet.
    const deps = makeDeps(world, config);
    const r = await dispatchGhlBuyerSyncEvent("bonus.viewed", { contactId: "cX" }, deps);
    check("bonus.viewed w/o correlation → not ok, not skipped", r.ok === false && r.skipped !== true);
    check("bonus.viewed w/o correlation → retryable", r.retryable === true);
  }
  {
    const world = makeWorld();
    const config = parsedConfig();
    // appointment.scheduled where appointment row not mirrored yet.
    const deps = makeDeps(world, config);
    const r = await dispatchGhlBuyerSyncEvent("appointment.scheduled", { appointmentId: "aMissing" }, deps);
    check("appointment.scheduled w/ missing row → retryable reconciliation", r.ok === false && r.retryable === true);
  }

  // ─── (5) Replay idempotency (no duplicate contact/opportunity) ─────────────
  console.log("\n(5) Replay idempotency");
  {
    const world = makeWorld();
    const config = parsedConfig();
    world.contacts.set("c1", { id: "c1", email: "r@x.com", name: "R", phone: null });
    world.orders.set("o1", { id: "o1", orderNumber: "ORD-R", contactId: "c1", packageCode: "digital", totalAmountCents: 49900, currency: "USD", status: "payment_captured" });
    const deps = makeDeps(world, config);
    await dispatchGhlBuyerSyncEvent("order.payment_captured", { orderId: "o1" }, deps);
    const contactCreates1 = world.ghl.calls.filter((c) => c.path === "/contacts/" && c.method === "POST").length;
    const oppCreates1 = world.ghl.calls.filter((c) => c.path === "/opportunities/" && c.method === "POST").length;
    // Replay the SAME event.
    await dispatchGhlBuyerSyncEvent("order.payment_captured", { orderId: "o1" }, deps);
    const contactCreates2 = world.ghl.calls.filter((c) => c.path === "/contacts/" && c.method === "POST").length;
    const oppCreates2 = world.ghl.calls.filter((c) => c.path === "/opportunities/" && c.method === "POST").length;
    check("replay creates NO second contact", contactCreates1 === 1 && contactCreates2 === 1);
    check("replay creates NO second opportunity", oppCreates1 === 1 && oppCreates2 === 1);
  }

  // ─── (6) Opportunity POST-timeout reconciliation via durable field search ──
  console.log("\n(6) Opportunity timeout reconciliation");
  {
    const world = makeWorld();
    const config = parsedConfig();
    world.contacts.set("c1", { id: "c1", email: "t@x.com", name: "T", phone: null });
    world.orders.set("o1", { id: "o1", orderNumber: "ORD-T", contactId: "c1", packageCode: "digital", totalAmountCents: 49900, currency: "USD", status: "payment_captured" });
    world.contactCorrelation.set("c1", "ghl-c1");
    // Simulate a prior timed-out create: no correlation stored, but GHL search
    // by durable order_id finds the already-created opportunity.
    world.ghl.searchOpportunityResult = "ghl-opp-preexisting";
    const deps = makeDeps(world, config);
    await dispatchGhlBuyerSyncEvent("order.payment_captured", { orderId: "o1" }, deps);
    const oppCreates = world.ghl.calls.filter((c) => c.path === "/opportunities/" && c.method === "POST").length;
    check("durable-field search prevents duplicate opportunity create", oppCreates === 0);
    check("found opportunity correlation persisted", world.opportunityCorrelation.get("o1") === "ghl-opp-preexisting");
  }

  // ─── (7) Refund removes buyer/SKU/workflows, sets refunded, moves to Lost ──
  console.log("\n(7) Refund cleanup (GHL.md §18)");
  {
    const world = makeWorld();
    const config = parsedConfig();
    world.contacts.set("c1", { id: "c1", email: "ref@x.com", name: "Ref", phone: null });
    world.orders.set("o1", { id: "o1", orderNumber: "ORD-REF", contactId: "c1", packageCode: "complete", totalAmountCents: 199900, currency: "USD", status: "refunded" });
    world.contactCorrelation.set("c1", "ghl-c1");
    world.opportunityCorrelation.set("o1", "ghl-opp-1");
    const deps = makeDeps(world, config);
    const r = await dispatchGhlBuyerSyncEvent("order.refunded", { orderId: "o1" }, deps);
    check("refund dispatch ok", r.ok === true);
    const removed = world.ghl.calls
      .filter((c) => c.path.endsWith("/tags") && c.method === "DELETE")
      .flatMap((c) => c.body!.tags as string[]);
    check("refund removes book_buyer", removed.includes("book_buyer"));
    check("refund removes SKU tags", removed.includes("lfre_complete") && removed.includes("lfre_digital"));
    check(
      "refund exits active workflows A/C/E/F",
      removed.includes("workflow_c_active") &&
        removed.includes("workflow_a_active") &&
        removed.includes("workflow_e_active") &&
        removed.includes("workflow_f_active"),
    );
    const oppMoves = world.ghl.calls.filter((c) => c.path.startsWith("/opportunities/ghl-opp-1") && c.method === "PUT");
    check("refund moves opportunity to Lost with lost status", oppMoves.some((c) => c.body?.status === "lost"));
    // Issue 5: refund is NOT a consent withdrawal — must NOT force sms opted_out.
    const refundFieldPuts = world.ghl.calls
      .filter((c) => c.method === "PUT" && Array.isArray(c.body?.customFields))
      .flatMap((c) => c.body!.customFields as Array<{ id: string; value: string }>);
    const smsField = refundFieldPuts.find((f) => f.id === config.customFields.sms_marketing_status);
    check("refund does NOT set sms_marketing_status opted_out", smsField === undefined);
    check(
      "refund sets qualification_status refunded",
      refundFieldPuts.some(
        (f) => f.id === config.customFields.qualification_status && f.value === "refunded",
      ),
    );
  }

  // ─── (7b) Partial refund: SKU-only, retains buyer + entitled tags ──────────
  console.log("\n(7b) Partial refund (GHL.md §18 partial rule)");
  {
    const world = makeWorld();
    const config = parsedConfig();
    world.contacts.set("c1", { id: "c1", email: "pref@x.com", name: "PR", phone: null });
    world.orders.set("o1", { id: "o1", orderNumber: "ORD-PREF", contactId: "c1", packageCode: "complete", totalAmountCents: 199900, currency: "USD", status: "payment_captured" });
    world.contactCorrelation.set("c1", "ghl-c1");
    world.opportunityCorrelation.set("o1", "ghl-opp-1");
    // Print portion refunded; digital + audiobook remain active.
    world.entitlementsByOrder.set("o1", ["digital_book", "audiobook"]);
    const deps = makeDeps(world, config);
    const r = await dispatchGhlBuyerSyncEvent("order.partially_refunded", { orderId: "o1" }, deps);
    check("partial refund dispatch ok", r.ok === true);
    const removed = world.ghl.calls
      .filter((c) => c.path.endsWith("/tags") && c.method === "DELETE")
      .flatMap((c) => c.body!.tags as string[]);
    check("partial refund removes ONLY the un-entitled SKU tag (lfre_print + lfre_complete)", removed.includes("lfre_print") && removed.includes("lfre_complete"));
    check("partial refund RETAINS still-entitled digital/audio SKU tags", !removed.includes("lfre_digital") && !removed.includes("lfre_audio"));
    check("partial refund does NOT remove book_buyer", !removed.includes("book_buyer"));
    check("partial refund does NOT exit workflows", !removed.includes("workflow_a_active") && !removed.includes("workflow_c_active"));
    const oppMoves = world.ghl.calls.filter((c) => c.path.startsWith("/opportunities/") && c.method === "PUT" && (c.body as any)?.status === "lost");
    check("partial refund does NOT move opportunity to Lost", oppMoves.length === 0);
  }
  {
    // Partial refund where all package SKU tags remain entitled → explicit no-op.
    const world = makeWorld();
    const config = parsedConfig();
    world.contacts.set("c1", { id: "c1", email: "pref2@x.com", name: "PR2", phone: null });
    world.orders.set("o1", { id: "o1", orderNumber: "ORD-PREF2", contactId: "c1", packageCode: "complete", totalAmountCents: 199900, currency: "USD", status: "payment_captured" });
    world.contactCorrelation.set("c1", "ghl-c1");
    world.entitlementsByOrder.set("o1", ["digital_book", "audiobook", "print_fulfillment"]);
    const deps = makeDeps(world, config);
    const r = await dispatchGhlBuyerSyncEvent("order.partially_refunded", { orderId: "o1" }, deps);
    const removed = world.ghl.calls.filter((c) => c.path.endsWith("/tags") && c.method === "DELETE");
    check("partial refund with all SKUs still entitled → no tag removal (no-op)", r.ok === true && removed.length === 0);
  }

  // ─── (8) Appointment lifecycle transitions ─────────────────────────────────
  console.log("\n(8) Appointment lifecycle");
  {
    const world = makeWorld();
    const config = parsedConfig();
    world.contactCorrelation.set("c1", "ghl-c1");
    const apptCompletedAt = new Date("2026-03-10T15:00:00.000Z");
    world.appointments.set("a1", {
      id: "a1",
      contactId: "c1",
      orderId: "o1",
      status: "completed",
      scheduledAt: new Date("2026-03-10T14:00:00.000Z"),
      updatedAt: apptCompletedAt,
    });
    world.opportunityCorrelation.set("o1", "ghl-opp-1");
    const deps = makeDeps(world, config);
    await dispatchGhlBuyerSyncEvent("appointment.scheduled", { appointmentId: "a1" }, deps);
    const addedScheduled = world.ghl.calls
      .filter((c) => c.path.endsWith("/tags") && c.method === "POST")
      .flatMap((c) => c.body!.tags as string[]);
    check("scheduled adds HIRS_booked + workflow_d_active", addedScheduled.includes("HIRS_booked") && addedScheduled.includes("workflow_d_active"));

    world.ghl.calls.length = 0;
    await dispatchGhlBuyerSyncEvent("appointment.no_show", { appointmentId: "a1" }, deps);
    const noShowAdded = world.ghl.calls.filter((c) => c.path.endsWith("/tags") && c.method === "POST").flatMap((c) => c.body!.tags as string[]);
    check("no_show adds HIRS_no_show + workflow_e_active", noShowAdded.includes("HIRS_no_show") && noShowAdded.includes("workflow_e_active"));

    world.ghl.calls.length = 0;
    await dispatchGhlBuyerSyncEvent("appointment.completed", { appointmentId: "a1" }, deps);
    const completedAdded = world.ghl.calls.filter((c) => c.path.endsWith("/tags") && c.method === "POST").flatMap((c) => c.body!.tags as string[]);
    check("completed adds HIRS_attended", completedAdded.includes("HIRS_attended"));
    // Issue 9: appointment_attended_at comes from the DURABLE row transition
    // timestamp (updatedAt), NOT a fresh new Date() — stable across retries.
    const completedFields = world.ghl.calls
      .filter((c) => c.method === "PUT" && Array.isArray(c.body?.customFields))
      .flatMap((c) => c.body!.customFields as Array<{ id: string; value: string }>);
    const attendedAt = completedFields.find((f) => f.id === config.customFields.appointment_attended_at);
    check(
      "appointment_attended_at uses durable row updatedAt (retry-stable)",
      attendedAt?.value === apptCompletedAt.toISOString(),
    );
  }

  // ─── (9) Application manual-review vs unqualified from decision reason ──────
  console.log("\n(9) Application decision routing");
  {
    const world = makeWorld();
    const config = parsedConfig();
    world.contactCorrelation.set("c1", "ghl-c1");
    // Real STRUCTURED routing marker (encodeRoutingDecision output), NOT free text.
    world.applications.set("app1", { id: "app1", contactId: "c1", orderId: null, qualificationStatus: "not_qualified", decisionReason: "book-buyer-routing:v1:manual_review:answer_band_ambiguous" });
    const deps = makeDeps(world, config);
    await dispatchGhlBuyerSyncEvent("application.not_qualified", { applicationId: "app1" }, deps);
    const added = world.ghl.calls.filter((c) => c.path.endsWith("/tags") && c.method === "POST").flatMap((c) => c.body!.tags as string[]);
    check("manual_review marker → audit_manual_review tag", added.includes("audit_manual_review"));
    check("manual_review marker → NOT audit_unqualified", !added.includes("audit_unqualified"));
  }
  {
    const world = makeWorld();
    const config = parsedConfig();
    world.contactCorrelation.set("c1", "ghl-c1");
    // alternate_next_step decoded outcome → genuine unqualified.
    world.applications.set("app2", { id: "app2", contactId: "c1", orderId: null, qualificationStatus: "not_qualified", decisionReason: "book-buyer-routing:v1:alternate_next_step:approved_policy_no_match" });
    const deps = makeDeps(world, config);
    await dispatchGhlBuyerSyncEvent("application.not_qualified", { applicationId: "app2" }, deps);
    const added = world.ghl.calls.filter((c) => c.path.endsWith("/tags") && c.method === "POST").flatMap((c) => c.body!.tags as string[]);
    check("alternate_next_step marker → audit_unqualified tag", added.includes("audit_unqualified"));
    check("alternate_next_step marker → NOT audit_manual_review", !added.includes("audit_manual_review"));
  }
  {
    // An UNDECODABLE / free-text reason must be treated conservatively as manual
    // review (never dropped into an unqualified marketing exit).
    const world = makeWorld();
    const config = parsedConfig();
    world.contactCorrelation.set("c1", "ghl-c1");
    world.applications.set("app3", { id: "app3", contactId: "c1", orderId: null, qualificationStatus: "not_qualified", decisionReason: "Below revenue threshold (legacy free text)" });
    const deps = makeDeps(world, config);
    await dispatchGhlBuyerSyncEvent("application.not_qualified", { applicationId: "app3" }, deps);
    const added = world.ghl.calls.filter((c) => c.path.endsWith("/tags") && c.method === "POST").flatMap((c) => c.body!.tags as string[]);
    check("undecodable reason → conservative audit_manual_review", added.includes("audit_manual_review"));
  }

  // ─── (10) Unhandled event type → truly-irrelevant skip ─────────────────────
  console.log("\n(10) Event routing");
  {
    const world = makeWorld();
    const deps = makeDeps(world, parsedConfig());
    const r = await dispatchGhlBuyerSyncEvent("entitlement.granted" as BookOutboxEventType, { orderId: "o1" }, deps);
    check("unhandled event type → skipped (irrelevant, not error)", r.skipped === true && r.error === undefined);
  }

  // ─── (11) GhlReconciliationNeededError shape ───────────────────────────────
  console.log("\n(11) Reconciliation error type");
  {
    const e = new GhlReconciliationNeededError("x");
    check("GhlReconciliationNeededError is an Error", e instanceof Error && e.name === "GhlReconciliationNeededError");
  }

  // ─── (13) Consent → GHL suppression mirror (consent.sms_updated) ───────────
  console.log("\n(13) SMS consent suppression mirror");
  {
    const world = makeWorld();
    const config = parsedConfig();
    world.contactCorrelation.set("c1", "ghl-c1");
    // Canonical ledger says opted_out (authoritative, not from payload).
    world.consentByPhone.set("+15551112222", {
      state: "opted_out",
      source: "keyword_inbound",
      evidence: "Inbound STOP",
      copyVersion: "sms-copy-v3",
      sourceUrl: null,
      confirmedAt: null,
    });
    const deps = makeDeps(world, config);
    const r = await dispatchGhlBuyerSyncEvent(
      "consent.sms_updated",
      { contactId: "c1", phone: "+15551112222", source: "keyword_inbound" },
      deps,
    );
    check("consent.sms_updated dispatch ok", r.ok === true);
    const mirrored = world.ghl.calls
      .filter((c) => c.method === "PUT" && Array.isArray(c.body?.customFields))
      .flatMap((c) => c.body!.customFields as Array<{ id: string; value: string }>)
      .find((f) => f.id === config.customFields.sms_marketing_status);
    check("opted_out mirrored to sms_marketing_status", mirrored?.value === "opted_out");
    const removed = world.ghl.calls
      .filter((c) => c.path.endsWith("/tags") && c.method === "DELETE")
      .flatMap((c) => c.body!.tags as string[]);
    check(
      "opted_out removes marketing workflow tags A/C/E/F",
      removed.includes("workflow_a_active") &&
        removed.includes("workflow_c_active") &&
        removed.includes("workflow_e_active") &&
        removed.includes("workflow_f_active"),
    );
    check("opted_out does NOT remove appointment logistics workflow_d_active", !removed.includes("workflow_d_active"));
  }
  {
    // Loop avoidance: source=ghl_dnd must NOT write back to GHL.
    const world = makeWorld();
    const config = parsedConfig();
    world.contactCorrelation.set("c1", "ghl-c1");
    world.consentByPhone.set("+15553334444", {
      state: "opted_out", source: "ghl_dnd", evidence: null, copyVersion: null, sourceUrl: null, confirmedAt: null,
    });
    const deps = makeDeps(world, config);
    const r = await dispatchGhlBuyerSyncEvent(
      "consent.sms_updated",
      { contactId: "c1", phone: "+15553334444", source: "ghl_dnd" },
      deps,
    );
    check("consent.sms_updated source=ghl_dnd → no GHL writes (loop avoidance)", r.ok === true && world.ghl.calls.length === 0);
  }
}

// ─── Relay constants (retry/dead-letter) via real module import ──────────────

async function runRelayChecks(): Promise<void> {
  console.log("\n(12) Relay module wiring");
  const relay = await import("../server/services/ghlOutboundSync");
  check("GHL_OUTBOUND_SYNC_QUEUE = ghl_outbound_sync", relay.GHL_OUTBOUND_SYNC_QUEUE === "ghl_outbound_sync");
  check("handleGhlOutboundSyncJob exported", typeof relay.handleGhlOutboundSyncJob === "function");
  check("scheduleGhlOutboundSyncBootCatchup exported", typeof relay.scheduleGhlOutboundSyncBootCatchup === "function");
  const kick = await import("../server/services/ghlOutboundKick");
  kick.__test_setGhlOutboundEnqueueOverride(async () => {
    throw new Error("injected enqueue failure");
  });
  // Kick never throws even when scheduler enqueue rejects in test env.
  let threw = false;
  try {
    await relay.kickGhlOutboundSyncJobSafe();
  } catch {
    threw = true;
  }
  check("kickGhlOutboundSyncJobSafe never throws", !threw);

  check("kick module re-exports queue name", kick.GHL_OUTBOUND_SYNC_QUEUE === "ghl_outbound_sync");
  check("kickGhlOutboundSyncFireAndForget is a function", typeof kick.kickGhlOutboundSyncFireAndForget === "function");
  // Fire-and-forget must not throw synchronously.
  let syncThrew = false;
  try {
    kick.kickGhlOutboundSyncFireAndForget();
  } catch {
    syncThrew = true;
  }
  check("kickGhlOutboundSyncFireAndForget does not throw synchronously", !syncThrew);
  kick.__test_setGhlOutboundEnqueueOverride(null);

  // ─── (14) Pure relay finalize transition table (no DB) ─────────────────────
  console.log("\n(14) Relay finalize transitions");
  const { decideRelayFinalize, DEFER_DELAY_MS } = relay;
  {
    const a = decideRelayFinalize({ ok: true, skipped: false }, 0, 5, 1000);
    check("ok result → delivered", a.kind === "delivered");
  }
  {
    const a = decideRelayFinalize({ ok: false, skipped: true, skipReason: "unhandled_event_type:x" }, 0, 5, 1000);
    check("irrelevant skip → delivered (drained)", a.kind === "delivered");
  }
  {
    const a = decideRelayFinalize({ ok: false, skipped: false, deferred: true, skipReason: "config_not_ready:disabled" }, 3, 5, 1000);
    check("deferred → kind deferred (never delivered)", a.kind === "deferred");
    // Deferral does NOT consume an attempt and pushes next_retry_at by DEFER_DELAY_MS.
    check("deferred → attempt NOT consumed (no attemptCount field)", (a as any).attemptCount === undefined);
    check("deferred → next_retry_at bounded by DEFER_DELAY_MS", a.kind === "deferred" && a.nextRetryAt.getTime() === 1000 + DEFER_DELAY_MS);
  }
  {
    const a = decideRelayFinalize({ ok: false, skipped: false, error: "boom", retryable: true }, 0, 5, 1000);
    check("genuine failure w/ attempts left → failed (retry)", a.kind === "failed" && (a as any).attemptCount === 1);
  }
  {
    const a = decideRelayFinalize({ ok: false, skipped: false, error: "boom" }, 4, 5, 1000);
    check("genuine failure at last attempt → dead_letter", a.kind === "dead_letter" && (a as any).attemptCount === 5);
  }

  // ─── (15) Source-scan invariants (self-guard the relay contract) ───────────
  console.log("\n(15) Source-scan invariants");
  const fs = await import("node:fs");
  const relaySrc = fs.readFileSync("server/services/ghlOutboundSync.ts", "utf8");
  const syncSrc = fs.readFileSync("server/services/ghlBuyerSync.ts", "utf8");

  // Handled-event-type filter: the claim query MUST filter by event_type IN(...)
  // so the relay never touches unrelated outbox rows.
  check(
    "claim query filters event_type IN handled list",
    /event_type IN \(\$\{handledEventTypesSql\(\)\}\)/.test(relaySrc),
  );
  check("relay handles order.partially_refunded", relaySrc.includes('"order.partially_refunded"'));
  check("relay handles consent.sms_updated", relaySrc.includes('"consent.sms_updated"'));

  // Conditional lease finalization: EVERY finalize UPDATE must gate on the lease
  // token (ownsLease), never a bare `WHERE id =`.
  const finalizeUpdates = relaySrc.match(/UPDATE book_outbox[\s\S]*?WHERE [^\n]+/g) ?? [];
  const mutatingFinalizes = finalizeUpdates.filter((u) => /SET status =/.test(u));
  check("relay has multiple status-mutating finalize UPDATEs", mutatingFinalizes.length >= 4);
  check(
    "every status-mutating finalize gates on lease token (ownsLease), never bare id",
    mutatingFinalizes.every((u) => u.includes("${ownsLease(entry)}")),
  );

  // Refund handler must NOT force sms opted_out (issue 5).
  const refundBlock = syncSrc.slice(
    syncSrc.indexOf("async function handleOrderRefunded"),
    syncSrc.indexOf("async function handleOrderPartiallyRefunded"),
  );
  // Strip line comments so explanatory prose mentioning "opted_out" cannot
  // create a false positive; assert no ACTUAL field-set forces opted_out.
  const refundCode = refundBlock.replace(/\/\/[^\n]*/g, "");
  check(
    "handleOrderRefunded does NOT set sms_marketing_status opted_out",
    !/sms_marketing_status[\s\S]*?value:\s*["']opted_out["']/.test(refundCode),
  );

  // Appointment attended must NOT stamp new Date() directly.
  const completedBlock = syncSrc.slice(
    syncSrc.indexOf("async function handleAppointmentCompleted"),
    syncSrc.indexOf("async function handleAppointmentNoShow"),
  );
  check(
    "appointment_attended_at not stamped with a fresh new Date().toISOString()",
    !/appointment_attended_at, value: new Date\(\)\.toISOString\(\)/.test(completedBlock),
  );

  // ─── (16) Cross-instance per-row lease claim ───────────────────────────────
  console.log("\n(16) Cross-instance per-row lease claim");
  check(
    "relay claim size is exactly one row",
    relay.GHL_OUTBOUND_CLAIM_SIZE === 1,
  );
  const { getDb } = await import("../server/db");
  const { bookOutbox } = await import("@shared/schema");
  const { eq, inArray } = await import("drizzle-orm");
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const ambientId = `ghl-lease-${runId}-ambient`;
  const ids = [`ghl-lease-${runId}-a`, `ghl-lease-${runId}-b`];
  const db = getDb();
  try {
    await db.insert(bookOutbox).values({
      id: ambientId,
      eventType: "bonus.viewed",
      sourceType: "ghl-lease-ambient-test",
      sourceId: `${runId}-ambient`,
      payload: { contactId: "ambient-contact" },
      status: "pending",
      idempotencyKey: `ghl-lease-test:${runId}:ambient`,
      createdAt: new Date(Date.now() - 60_000),
    });
    await db.insert(bookOutbox).values(
      ids.map((id, index) => ({
        id,
        eventType: "bonus.viewed" as const,
        sourceType: "ghl-lease-test",
        sourceId: `${runId}-${index}`,
        payload: { contactId: `contact-${index}` },
        status: "pending" as const,
        idempotencyKey: `ghl-lease-test:${runId}:${index}`,
      })),
    );
    const [workerA, workerB] = await Promise.all([
      relay.__test_claimGhlOutboxPage(db, ids),
      relay.__test_claimGhlOutboxPage(db, ids),
    ]);
    const claimedIds = [...workerA, ...workerB].map((entry) => entry.id);
    check(
      "two concurrent workers claim one row each",
      workerA.length === 1 && workerB.length === 1,
    );
    check(
      "concurrent workers never claim the same outbox row",
      new Set(claimedIds).size === 2 && ids.every((id) => claimedIds.includes(id)),
    );
    const [ambientRow] = await db
      .select({
        lastAttemptAt: bookOutbox.lastAttemptAt,
        nextRetryAt: bookOutbox.nextRetryAt,
      })
      .from(bookOutbox)
      .where(eq(bookOutbox.id, ambientId));
    check(
      "scoped lease check leaves an older ambient handled row untouched",
      ambientRow?.lastAttemptAt === null && ambientRow.nextRetryAt === null,
    );
    const thirdWorker = await relay.__test_claimGhlOutboxPage(db, ids);
    check(
      "neither leased row is immediately reclaimable",
      thirdWorker.length === 0,
    );
  } finally {
    await db.delete(bookOutbox).where(inArray(bookOutbox.id, [...ids, ambientId]));
  }
}

(async () => {
  try {
    await run();
    await runRelayChecks();
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    const { closeDbPools } = await import("../server/db");
    await closeDbPools();
  }
})().catch((err) => {
  console.error("Test harness error:", err);
  process.exitCode = 1;
});
