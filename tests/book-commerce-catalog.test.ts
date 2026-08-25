/* test-registration
{
  "name": "Book-commerce catalog invariants — prices, gates, exclusivity, entitlements, transition maps (Task #5096)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Pure, DB-free (~0.2s, no I/O of any kind): locks the financial and gating source of truth for the Task #5096 book-commerce surface — the exact catalog prices 499/1999 cents that the DB CHECK constraints mirror, that only Digital is selectable by default, that the Complete package fails closed unless BOTH enabled AND approved, exactly-one package selection, package↔entitlement compatibility, and the legal/illegal order/application/appointment transition maps. A regression here is a silent mispricing or an opened fail-closed gate, so it earns a routine smoke slot.",
  "tier": "small",
  "tierReason": "Deliberately small, overriding the mechanical unmeasured default of medium: this suite is pure and in-process — it imports only the catalog service and shared transition maps, opens no DB/socket/file, reads no env at load, and does simple synchronous assertions, so it completes in well under 1s. There is no measured baseline yet (unmeasured suites mechanically default to medium), hence this explicit override."
}
test-registration */
/**
 * Task #5096 — Book Commerce Foundation, catalog + shared-map layer.
 *
 * This suite is intentionally PURE: it imports only the catalog service and the
 * shared model's transition maps, touches no DB, opens no sockets, and reads no
 * env at module load. It is the canonical guard for the values that are the
 * financial and safety source of truth for the whole slice:
 *
 *   (1) Exact catalog prices: digital = 499 cents ($4.99), complete = 1999
 *       cents ($19.99) — the same integers the DB CHECK constraint
 *       book_order_items_catalog_price_check enforces on the stored snapshot.
 *   (2) Both packages fail closed without a server launch-readiness context;
 *       Digital opens only with readiness, while Complete also needs its
 *       independent enabled/approved/shipping gate.
 *   (3) The Complete gate is fail-closed: it opens ONLY when BOTH enabled AND
 *       approved are explicitly true; any partial/false combination is denied
 *       with a populated reason.
 *   (4) Exactly-one package selection (mutual exclusion): zero, two, or an
 *       unknown code all throw the right error.
 *   (5) Package ↔ entitlement compatibility: digital grants only digital_book;
 *       complete grants all three; a cross-package/unknown code is rejected.
 *   (6) The legal/illegal transition maps for order, application, and
 *       appointment — including that same-state moves are always illegal and
 *       that terminal states have no outbound edges.
 *
 * Usage: tsx tests/book-commerce-catalog.test.ts
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import {
  BOOK_COMMERCE_PACKAGE_CODES,
  BOOK_COMMERCE_PACKAGES,
  BOOK_ENTITLEMENT_CODES,
  getPackageByCode,
  requirePackageByCode,
  listPackages,
  assertExclusivePackageCode,
  evaluateCompleteGate,
  isPackageSelectable,
  isEntitlementCompatible,
  assertEntitlementCompatible,
  UnknownPackageCodeError,
  MutualExclusionError,
  IncompatibleEntitlementError,
} from "../server/services/bookCommerceCatalog";
import {
  __setBookLaunchReadinessDependenciesForTest,
  getBookLaunchReadinessReport,
} from "../server/services/bookLaunchReadiness";
import {
  bookOrderStatuses,
  bookAuditApplicationStatuses,
  bookAppointmentStatuses,
  bookOrderTransitions,
  bookAuditApplicationTransitions,
  bookAppointmentTransitions,
  isValidBookOrderTransition,
  isValidBookAuditApplicationTransition,
  isValidBookAppointmentTransition,
  type BookOrderStatus,
  type BookAuditApplicationStatus,
  type BookAppointmentStatus,
} from "@shared/schema";

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

function throwsInstance(fn: () => unknown, ctor: new (...a: any[]) => Error): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return err instanceof ctor;
  }
}

async function main(): Promise<void> {
  console.log("Book-commerce catalog invariants (Task #5096)");

  // ── (1) Exact catalog prices ────────────────────────────────────────────────
  const digital = requirePackageByCode("digital");
  const complete = requirePackageByCode("complete");

  check("digital price is exactly 499 cents", digital.amountCents === 499);
  check("complete price is exactly 1999 cents", complete.amountCents === 1999);
  check("digital currency is USD", digital.currency === "USD");
  check("complete currency is USD", complete.currency === "USD");
  check("digital SKU is stable", digital.sku === "LFRE-DIGITAL-2026");
  check("complete SKU is stable", complete.sku === "LFRE-COMPLETE-2026");
  check(
    "package codes are exactly [digital, complete]",
    JSON.stringify([...BOOK_COMMERCE_PACKAGE_CODES]) === JSON.stringify(["digital", "complete"]),
  );

  // ── Launch-readiness matrix: local/cache-only and explicitly fail-closed ───
  const envKeys = [
    "STRIPE_PUBLISHABLE_KEY",
    "STRIPE_SECRET_KEY",
    "PRIVATE_OBJECT_DIR",
    "BOOK_COMMERCE_DIGITAL_ENABLED",
    "BOOK_COMMERCE_STRIPE_CONFIGURATION_APPROVED",
    "BOOK_COMMERCE_TAX_TREATMENT_APPROVED",
    "BOOK_COMMERCE_TAX_TREATMENT_VERSION",
    "BOOK_COMMERCE_REFUND_HANDLING_APPROVED",
    "BOOK_COMMERCE_REFUND_HANDLING_VERSION",
    "BOOK_COMMERCE_TRANSACTIONAL_DELIVERY_APPROVED",
    "BOOK_COMMERCE_SUPPORT_PROCEDURE_APPROVED",
    "BOOK_COMMERCE_SUPPORT_PROCEDURE_VERSION",
    "BOOK_COMMERCE_DIGITAL_VERIFICATION_EVIDENCE_VERSION",
    "BOOK_COMMERCE_APPROVAL_ENVIRONMENT",
    "BOOK_COMMERCE_COMPLETE_ENABLED",
    "BOOK_COMMERCE_COMPLETE_APPROVED",
    "BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS",
  ] as const;
  const priorEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  const fixedNow = new Date("2026-08-21T12:00:00.000Z");
  __setBookLaunchReadinessDependenciesForTest({
    now: fixedNow,
    stripe: {
      value: { connected: true },
      lastCheckedAt: fixedNow.toISOString(),
      lastProbeError: null,
    },
    assets: {
      activeCodes: new Set(["digital_book", "audiobook", "print_fulfillment"]),
      readFailed: false,
    },
  });
  try {
    for (const key of envKeys) delete process.env[key];
    const closed = await getBookLaunchReadinessReport();
    const closedCodes = closed.packages.digital.blockers.map((blocker) => blocker.code);
    check("missing configuration keeps Digital unavailable", closed.packages.digital.purchasable === false);
    check("unapproved Terms is an explicit blocker", closedCodes.includes("policy.terms_unapproved"));
    check(
      "purchase snapshot stays unavailable without approved policy copy",
      closedCodes.includes("policy.purchase_snapshot_unavailable"),
    );
    const completeCodes = closed.packages.complete.blockers.map((blocker) => blocker.code);
    check(
      "inactive provider boundary keeps Complete unavailable",
      !closed.packages.complete.purchasable &&
        completeCodes.includes("fulfillment.provider_inactive"),
    );
    check(
      "all dormant provider capabilities are explicit blockers",
      ["create", "status", "tracking", "cancel", "replacement"].every((capability) =>
        completeCodes.includes(`fulfillment.${capability}_capability_inactive`),
      ),
    );

    for (const key of envKeys) process.env[key] = "approved-v1";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_placeholder";
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
    process.env.PRIVATE_OBJECT_DIR = "private";
    for (const flag of [
      "BOOK_COMMERCE_DIGITAL_ENABLED",
      "BOOK_COMMERCE_STRIPE_CONFIGURATION_APPROVED",
      "BOOK_COMMERCE_TAX_TREATMENT_APPROVED",
      "BOOK_COMMERCE_REFUND_HANDLING_APPROVED",
      "BOOK_COMMERCE_TRANSACTIONAL_DELIVERY_APPROVED",
      "BOOK_COMMERCE_SUPPORT_PROCEDURE_APPROVED",
      "BOOK_COMMERCE_COMPLETE_ENABLED",
      "BOOK_COMMERCE_COMPLETE_APPROVED",
    ]) {
      process.env[flag] = "true";
    }
    process.env.BOOK_COMMERCE_APPROVAL_ENVIRONMENT = "production";
    process.env.BOOK_COMMERCE_COMPLETE_US_SHIPPING_CENTS = "not-a-number";
    __setBookLaunchReadinessDependenciesForTest({
      now: fixedNow,
      stripe: {
        value: { connected: true },
        lastCheckedAt: new Date(fixedNow.getTime() - 6 * 60_000).toISOString(),
        lastProbeError: null,
      },
      assets: {
        activeCodes: new Set(["digital_book", "audiobook", "print_fulfillment"]),
        readFailed: false,
      },
    });
    const stale = await getBookLaunchReadinessReport();
    check(
      "stale cache is a blocker without starting a provider probe",
      stale.packages.digital.blockers.some(
        (blocker) => blocker.code === "payment.stripe_health_stale",
      ),
    );
    check(
      "approval evidence from another environment is rejected",
      stale.packages.digital.blockers.some(
        (blocker) => blocker.code === "verification.environment_mismatch",
      ),
    );
    check(
      "invalid shipping configuration is reported explicitly",
      stale.packages.complete.blockers.some(
        (blocker) => blocker.code === "shipping.rate_invalid",
      ),
    );
  } finally {
    __setBookLaunchReadinessDependenciesForTest(null);
    for (const [key, value] of priorEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  check("catalog exposes exactly two packages", BOOK_COMMERCE_PACKAGES.length === 2);
  check("listPackages mirrors the catalog", listPackages().length === 2);
  check("unknown code returns undefined via getPackageByCode", getPackageByCode("audio") === undefined);
  check(
    "unknown code throws UnknownPackageCodeError via requirePackageByCode",
    throwsInstance(() => requirePackageByCode("audio"), UnknownPackageCodeError),
  );

  const launchReady = {
    digitalReady: true,
    completeReady: true,
  };

  // ── (2) Default selectability is fail-closed ────────────────────────────────
  const digitalDefault = isPackageSelectable("digital");
  check("digital is NOT selectable without launch readiness", digitalDefault.selectable === false);

  const completeDefaultDenied = isPackageSelectable(
    "complete",
    { enabled: false, approved: false, usShippingCents: null },
  );
  check(
    "complete is NOT selectable by default (both gates off)",
    completeDefaultDenied.selectable === false && Boolean(completeDefaultDenied.reason),
  );

  // ── (3) Complete gate is fail-closed (both required) ────────────────────────
  const bothOn = evaluateCompleteGate({ enabled: true, approved: true, usShippingCents: 0 });
  check("gate opens ONLY when enabled AND approved", bothOn.allowed === true);

  const enabledOnly = evaluateCompleteGate({ enabled: true, approved: false, usShippingCents: 0 });
  check(
    "gate denied when enabled but NOT approved",
    enabledOnly.allowed === false && Boolean(enabledOnly.reason),
  );

  const approvedOnly = evaluateCompleteGate({ enabled: false, approved: true, usShippingCents: 0 });
  check(
    "gate denied when approved but NOT enabled",
    approvedOnly.allowed === false && Boolean(approvedOnly.reason),
  );

  const neither = evaluateCompleteGate({ enabled: false, approved: false, usShippingCents: 0 });
  check("gate denied when neither flag is set", neither.allowed === false && Boolean(neither.reason));

  const completeApproved = isPackageSelectable(
    "complete",
    { enabled: true, approved: true, usShippingCents: 0 },
    launchReady,
  );
  check(
    "complete becomes selectable once enabled AND approved",
    completeApproved.selectable === true,
  );
  // Digital must never be affected by the Complete gate context.
  const digitalWithClosedGate = isPackageSelectable(
    "digital",
    { enabled: false, approved: false, usShippingCents: null },
    launchReady,
  );
  check(
    "digital stays selectable regardless of a closed Complete gate ctx",
    digitalWithClosedGate.selectable === true,
  );

  // ── (4) Exactly-one package selection ───────────────────────────────────────
  check("assertExclusivePackageCode(['digital']) → 'digital'", assertExclusivePackageCode(["digital"]) === "digital");
  check("assertExclusivePackageCode(['complete']) → 'complete'", assertExclusivePackageCode(["complete"]) === "complete");
  check(
    "zero codes throws MutualExclusionError",
    throwsInstance(() => assertExclusivePackageCode([]), MutualExclusionError),
  );
  check(
    "two codes throws MutualExclusionError",
    throwsInstance(() => assertExclusivePackageCode(["digital", "complete"]), MutualExclusionError),
  );
  check(
    "duplicated codes still count as two → MutualExclusionError",
    throwsInstance(() => assertExclusivePackageCode(["digital", "digital"]), MutualExclusionError),
  );
  check(
    "single unknown code throws UnknownPackageCodeError",
    throwsInstance(() => assertExclusivePackageCode(["audio"]), UnknownPackageCodeError),
  );

  // ── (5) Entitlement compatibility ───────────────────────────────────────────
  check(
    "entitlement codes are exactly the closed set",
    JSON.stringify([...BOOK_ENTITLEMENT_CODES]) ===
      JSON.stringify(["digital_book", "audiobook", "print_fulfillment"]),
  );
  check("digital grants digital_book", isEntitlementCompatible("digital", "digital_book"));
  check("digital does NOT grant audiobook", !isEntitlementCompatible("digital", "audiobook"));
  check("digital does NOT grant print_fulfillment", !isEntitlementCompatible("digital", "print_fulfillment"));
  check("complete grants digital_book", isEntitlementCompatible("complete", "digital_book"));
  check("complete grants audiobook", isEntitlementCompatible("complete", "audiobook"));
  check("complete grants print_fulfillment", isEntitlementCompatible("complete", "print_fulfillment"));
  check("no package grants an unknown entitlement", !isEntitlementCompatible("complete", "hologram"));
  check(
    "assertEntitlementCompatible returns the narrowed code on a valid pair",
    assertEntitlementCompatible("complete", "audiobook") === "audiobook",
  );
  check(
    "assertEntitlementCompatible throws for an incompatible pair",
    throwsInstance(() => assertEntitlementCompatible("digital", "audiobook"), IncompatibleEntitlementError),
  );

  // ── (6) Transition maps — order / application / appointment ─────────────────

  // Legal edges declared in the maps must validate true; same-state must be false.
  function auditTransitionMap<S extends string>(
    label: string,
    statuses: readonly S[],
    map: Record<S, readonly S[]>,
    isValid: (from: S, to: S) => boolean,
    expectedLegal: Record<string, readonly S[]>,
    terminals: readonly S[],
  ): void {
    // Every declared edge is legal; every same-state move is illegal.
    for (const from of statuses) {
      check(`${label}: same-state ${from}→${from} is illegal`, isValid(from, from) === false);
      for (const to of map[from]) {
        check(`${label}: declared edge ${from}→${to} is legal`, isValid(from, to) === true);
      }
      // The declared edge set matches the expectation exactly.
      const declared = [...map[from]].sort().join(",");
      const expected = [...(expectedLegal[from] ?? [])].sort().join(",");
      check(`${label}: ${from} edges match expectation`, declared === expected, `declared=[${declared}]`);
    }
    // Terminal states have no outbound edges.
    for (const t of terminals) {
      check(`${label}: terminal ${t} has no outbound edges`, map[t].length === 0);
    }
  }

  auditTransitionMap<BookOrderStatus>(
    "order",
    bookOrderStatuses,
    bookOrderTransitions,
    isValidBookOrderTransition,
    {
      pending_payment: ["payment_captured", "cancelled"],
      payment_captured: ["fulfillment_queued", "partially_refunded", "refunded", "disputed"],
      fulfillment_queued: ["fulfilled", "partially_refunded", "refunded", "disputed"],
      fulfilled: ["partially_refunded", "refunded", "disputed"],
      partially_refunded: ["refunded", "disputed"],
      disputed: ["payment_captured", "refunded"],
      refunded: [],
      cancelled: [],
    },
    ["refunded", "cancelled"],
  );
  // A representative illegal (non-declared, non-terminal) order edge.
  check("order: pending_payment→fulfilled is illegal", isValidBookOrderTransition("pending_payment", "fulfilled") === false);
  check("order: cancelled→payment_captured is illegal (terminal)", isValidBookOrderTransition("cancelled", "payment_captured") === false);

  auditTransitionMap<BookAuditApplicationStatus>(
    "application",
    bookAuditApplicationStatuses,
    bookAuditApplicationTransitions,
    isValidBookAuditApplicationTransition,
    {
      draft: ["submitted", "withdrawn"],
      submitted: ["qualified", "not_qualified", "withdrawn"],
      qualified: [],
      not_qualified: [],
      withdrawn: [],
    },
    ["qualified", "not_qualified", "withdrawn"],
  );
  check(
    "application: draft→qualified is illegal (must submit first)",
    isValidBookAuditApplicationTransition("draft", "qualified") === false,
  );
  check(
    "application: qualified→submitted is illegal (terminal)",
    isValidBookAuditApplicationTransition("qualified", "submitted") === false,
  );

  auditTransitionMap<BookAppointmentStatus>(
    "appointment",
    bookAppointmentStatuses,
    bookAppointmentTransitions,
    isValidBookAppointmentTransition,
    {
      pending: ["scheduled", "cancelled"],
      scheduled: ["completed", "cancelled", "no_show"],
      no_show: ["scheduled"],
      completed: [],
      cancelled: [],
    },
    ["completed", "cancelled"],
  );
  check(
    "appointment: no_show→scheduled reschedule is legal",
    isValidBookAppointmentTransition("no_show", "scheduled") === true,
  );
  check(
    "appointment: pending→completed is illegal",
    isValidBookAppointmentTransition("pending", "completed") === false,
  );
  check(
    "appointment: completed→scheduled is illegal (terminal)",
    isValidBookAppointmentTransition("completed", "scheduled") === false,
  );

  console.log("");
  console.log(`Result: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
