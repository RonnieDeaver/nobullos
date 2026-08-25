/* test-registration
{
  "name": "Book buyer journey public route contract",
  "smoke": true,
  "smokeReason": "Task #5103: capability-gated public application routing controls whether a buyer can see the sales calendar; a regression could expose a calendar to an unapproved visitor, invent a decision when policy is missing, duplicate an application, or leak private intake answers.",
  "scanPaths": [
    "server/routes/bookBuyerJourney.ts",
    "server/services/bookBuyerQualification.ts",
    "server/storage/bookCommerceEngagementStorage.ts",
    "server/routes/bookCheckout.ts"
  ],
  "tier": "small",
  "tierReason": "DB-free local Express contract test with injected storage/settings dependencies and no vendor egress."
}
test-registration */
// SPDX-License-Identifier: MIT

import "./helpers/forceTestEnv";
import express from "express";
import type { AddressInfo } from "node:net";
import { registerBookBuyerJourneyRoutes } from "../server/routes/bookBuyerJourney";
import { globalApiErrorHandler } from "../server/observability/httpErrors";
import {
  BOOK_BUYER_GHL_CALENDAR_SETTING,
  BOOK_BUYER_QUALIFICATION_POLICY_SETTING,
} from "../server/services/bookBuyerQualification";

let passed = 0;
let failed = 0;

function check(condition: unknown, message: string, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok  ${message}`);
  } else {
    failed++;
    console.error(`  FAIL ${message}${detail ? ` — ${detail}` : ""}`);
  }
}

type FakeApplication = {
  id: string;
  contactId: string;
  orderId: string;
  idempotencyKey: string;
  status: "draft" | "submitted" | "qualified" | "not_qualified";
  answers: Record<string, unknown> | null;
  submittedAt: Date | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  consentEvidenceRef: null;
  retentionUntil: null;
  retentionReason: null;
  createdAt: Date;
  updatedAt: Date;
};

async function main(): Promise<void> {
  process.env.SESSION_SECRET = "buyer-journey-route-test-secret-32";
  const applications = new Map<string, FakeApplication>();
  const byKey = new Map<string, string>();
  const appointments = new Map<string, Record<string, unknown>>();
  const settings = new Map<string, string>();
  const transitionCalls: Array<Record<string, unknown>> = [];
  let sequence = 0;
  let failNextAppointmentUpsert = false;

  const app = express();
  app.use(express.json());
  registerBookBuyerJourneyRoutes(app, {
    requireCheckout: async (resumeToken) =>
      ({
        id: `checkout-${resumeToken.slice(0, 1)}`,
        status: "completed",
        paymentState: "captured",
      }) as never,
    findBuyerContext: async (checkoutSessionId) => ({
      contactId: "contact-buyer-route-test",
      orderId: `order-${checkoutSessionId.slice(-1)}`,
      email: "buyer@example.com",
      name: "Buyer Example",
      attribution: {
        utmSource: "book",
        utmMedium: "buyer",
        utmCampaign: "revenue-engine",
        utmTerm: null,
        utmContent: "post-purchase",
      },
    }),
    createApplication: async (input) => {
      const existingId = byKey.get(input.idempotencyKey);
      if (existingId) {
        return { application: applications.get(existingId) as never, created: false };
      }
      const now = new Date();
      const created: FakeApplication = {
        id: `application-${++sequence}`,
        contactId: input.contactId,
        orderId: input.orderId ?? "order-buyer-route-test",
        idempotencyKey: input.idempotencyKey,
        status: "draft",
        answers: null,
        submittedAt: null,
        decidedAt: null,
        decisionReason: null,
        consentEvidenceRef: null,
        retentionUntil: null,
        retentionReason: null,
        createdAt: now,
        updatedAt: now,
      };
      applications.set(created.id, created);
      byKey.set(created.idempotencyKey, created.id);
      return { application: created as never, created: true };
    },
    transitionApplication: async (input) => {
      transitionCalls.push(input);
      const current = applications.get(input.applicationId);
      if (!current || current.status !== input.fromStatus) {
        return {
          transitioned: false,
          application: null,
          lifecycleEvent: null,
          outboxEntry: null,
        };
      }
      current.status = input.toStatus as FakeApplication["status"];
      current.answers =
        input.toStatus === "submitted" && input.answers
          ? input.answers
          : current.answers;
      current.submittedAt =
        input.toStatus === "submitted" ? new Date() : current.submittedAt;
      current.decidedAt =
        input.toStatus === "qualified" || input.toStatus === "not_qualified"
          ? new Date()
          : current.decidedAt;
      current.decisionReason = input.decisionReason ?? current.decisionReason;
      return {
        transitioned: true,
        application: current as never,
        lifecycleEvent: null,
        outboxEntry: null,
      };
    },
    upsertAppointment: async ({ auditApplicationId }) => {
      if (failNextAppointmentUpsert) {
        failNextAppointmentUpsert = false;
        throw new Error("injected appointment provisioning failure");
      }
      const existing = appointments.get(auditApplicationId);
      if (existing) {
        return { appointment: existing as never, created: false };
      }
      const appointment = {
        id: `appointment-${auditApplicationId}`,
        auditApplicationId,
        status: "pending",
        scheduledAt: null,
        timezone: null,
      };
      appointments.set(auditApplicationId, appointment);
      return { appointment: appointment as never, created: true };
    },
    getJourneyState: async (applicationId) => {
      const application = applications.get(applicationId);
      if (!application) return null;
      const appointment = appointments.get(applicationId);
      return {
        application: application as never,
        buyer: {
          email: "buyer@example.com",
          name: "Buyer Example",
          attribution: {
            utmSource: "book",
            utmMedium: "buyer",
            utmCampaign: "revenue-engine",
            utmTerm: null,
            utmContent: "post-purchase",
          },
        },
        appointment: appointment
          ? {
              status: appointment.status as never,
              scheduledAt: (appointment.scheduledAt as Date | null) ?? null,
              endAt: (appointment.endAt as Date | null) ?? null,
              timezone: (appointment.timezone as string | null) ?? null,
              meetingTypeName:
                (appointment.meetingTypeName as string | null) ?? null,
              hostName: (appointment.hostName as string | null) ?? null,
              meetingLink: (appointment.meetingLink as string | null) ?? null,
            }
          : null,
      };
    },
    getSetting: async (key) => settings.get(key) ?? null,
  });
  app.use(globalApiErrorHandler);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const post = async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, any>,
    };
  };

  const start = async (checkoutIdentity: string) =>
    post("/api/book/journey/start", {
      resumeToken: checkoutIdentity.repeat(64),
    });

  const answers = {
    role: "owner",
    practiceArea: "Family law",
    monthlyQualifiedInquiries: "25_49",
    annualFirmRevenue: "3m_10m",
    improvementTiming: "31_90_days",
  };

  try {
    const manualStart = await start("a");
    check(manualStart.status === 201, "verified checkout starts a durable application");
    check(
      manualStart.body.outcome === "in_progress",
      "new application starts in progress",
    );
    check(
      !JSON.stringify(manualStart.body).includes("order-a"),
      "start response does not expose order identity",
    );
    const sameOrderReplay = await start("a");
    check(
      sameOrderReplay.status === 200 && applications.size === 1,
      "one verified order cannot create multiple applications with repeated starts",
    );

    const manual = await post("/api/book/journey/submit", {
      applicationToken: manualStart.body.applicationToken,
      answers,
    });
    check(manual.status === 200, "bounded application submits");
    check(
      manual.body.outcome === "manual_review",
      "missing approved thresholds route to manual review",
    );
    check(manual.body.calendar.available === false, "manual review never exposes calendar");
    check(
      transitionCalls.some(
        (call) =>
          call.toStatus === "submitted" &&
          (call.answers as Record<string, unknown>)?.practiceArea === "Family law",
      ),
      "submit transition durably receives bounded answers",
    );

    settings.set(
      BOOK_BUYER_QUALIFICATION_POLICY_SETTING,
      JSON.stringify({
        version: 1,
        enabled: true,
        eligibleRoles: ["owner", "managing_partner", "decision_maker"],
        maximumImprovementTimelineDays: 90,
        thresholdMode: "all",
        minimumMonthlyQualifiedInquiries: 25,
        minimumAnnualFirmRevenueUsd: 3_000_000,
      }),
    );
    settings.set(
      BOOK_BUYER_GHL_CALENDAR_SETTING,
      JSON.stringify({
        version: 1,
        enabled: true,
        embedUrl: "https://api.leadconnectorhq.com/widget/bookings/approved-calendar",
        prefillFields: ["name", "email", "utmSource", "utmCampaign"],
      }),
    );

    const qualifiedStart = await start("b");
    const qualified = await post("/api/book/journey/submit", {
      applicationToken: qualifiedStart.body.applicationToken,
      answers,
    });
    check(qualified.body.outcome === "qualified", "approved policy match qualifies");
    check(qualified.body.calendar.available === true, "qualified route exposes approved calendar");
    check(
      String(qualified.body.calendar.url).startsWith(
        "https://api.leadconnectorhq.com/widget/bookings/approved-calendar",
      ),
      "calendar stays on the approved GHL embed host and path",
    );
    check(
      String(qualified.body.calendar.url).includes("utm_source=book"),
      "calendar preserves approved attribution",
    );
    check(
      appointments.size === 1,
      "qualified submission creates one pending appointment mirror",
    );

    const callsBeforeReplay = transitionCalls.length;
    const replay = await post("/api/book/journey/submit", {
      applicationToken: qualifiedStart.body.applicationToken,
      answers: { ...answers, practiceArea: "Different answer" },
    });
    check(replay.body.outcome === "qualified", "duplicate submit converges to stored outcome");
    check(
      transitionCalls.length === callsBeforeReplay,
      "duplicate submit does not transition or overwrite answers again",
    );
    check(appointments.size === 1, "duplicate submit does not duplicate appointment mirror");

    // future-date-literal-reviewed: appointment time is a pinned fixture
    // compared literally below; no assertion depends on it staying future.
    const qualifiedId = byKey.get("book-buyer-order:order-b")!;
    const scheduledAt = new Date(Date.now() + 21 * 86_400_000);
    const scheduledEndAt = new Date(scheduledAt.getTime() + 60 * 60_000);
    appointments.set(qualifiedId, {
      status: "scheduled",
      scheduledAt,
      endAt: scheduledEndAt,
      timezone: "America/Chicago",
      meetingTypeName: "High-Impact Revenue Session",
      hostName: "Verified Host",
      meetingLink: "https://zoom.us/j/example",
    });
    const scheduled = await post("/api/book/journey/status", {
      applicationToken: qualifiedStart.body.applicationToken,
    });
    check(
      scheduled.body.appointment.scheduledAt === scheduledAt.toISOString(),
      "status returns trusted mirrored appointment time",
    );
    check(
      !Object.hasOwn(scheduled.body, "answers") &&
        !JSON.stringify(scheduled.body).includes("Family law"),
      "status suppresses private application answers",
    );

    const alternateStart = await start("c");
    const alternate = await post("/api/book/journey/submit", {
      applicationToken: alternateStart.body.applicationToken,
      answers: { ...answers, role: "other" },
    });
    check(
      alternate.body.outcome === "alternate_next_step",
      "clearly ineligible role receives the approved alternate route",
    );
    check(alternate.body.calendar.available === false, "alternate route never exposes calendar");

    settings.set(
      BOOK_BUYER_QUALIFICATION_POLICY_SETTING,
      JSON.stringify({
        version: 1,
        enabled: true,
        eligibleRoles: ["owner"],
        maximumImprovementTimelineDays: 90,
        minimumMonthlyQualifiedInquiries: 25,
      }),
    );
    const malformedStart = await start("d");
    const malformed = await post("/api/book/journey/submit", {
      applicationToken: malformedStart.body.applicationToken,
      answers,
    });
    check(
      malformed.body.outcome === "manual_review",
      "policy missing explicit threshold mode cannot invent a decision",
    );

    settings.set(
      BOOK_BUYER_QUALIFICATION_POLICY_SETTING,
      JSON.stringify({
        version: 1,
        enabled: true,
        eligibleRoles: ["owner"],
        maximumImprovementTimelineDays: 90,
        thresholdMode: "all",
        minimumMonthlyQualifiedInquiries: 40,
      }),
    );
    const ambiguousStart = await start("e");
    const ambiguous = await post("/api/book/journey/submit", {
      applicationToken: ambiguousStart.body.applicationToken,
      answers,
    });
    check(
      ambiguous.body.outcome === "manual_review",
      "answer band crossing an approved threshold routes to manual review",
    );

    settings.set(
      BOOK_BUYER_QUALIFICATION_POLICY_SETTING,
      JSON.stringify({
        version: 1,
        enabled: true,
        eligibleRoles: ["owner", "managing_partner", "decision_maker"],
        maximumImprovementTimelineDays: 90,
        thresholdMode: "all",
        minimumMonthlyQualifiedInquiries: 25,
        minimumAnnualFirmRevenueUsd: 3_000_000,
      }),
    );
    const crashStart = await start("f");
    failNextAppointmentUpsert = true;
    const interrupted = await post("/api/book/journey/submit", {
      applicationToken: crashStart.body.applicationToken,
      answers,
    });
    check(
      interrupted.status >= 500,
      "appointment provisioning failure leaves an explicit retryable response",
    );
    const interruptedId = byKey.get("book-buyer-order:order-f")!;
    check(
      applications.get(interruptedId)?.status === "submitted" &&
        !appointments.has(interruptedId),
      "failed appointment provisioning cannot commit qualified state first",
    );
    const resumed = await post("/api/book/journey/submit", {
      applicationToken: crashStart.body.applicationToken,
    });
    check(
      resumed.body.outcome === "qualified" && appointments.has(interruptedId),
      "retry resumes the durable routing marker without resubmitting answers",
    );

    const concurrentStart = await start("9");
    const concurrentResults = await Promise.all([
      post("/api/book/journey/submit", {
        applicationToken: concurrentStart.body.applicationToken,
        answers,
      }),
      post("/api/book/journey/submit", {
        applicationToken: concurrentStart.body.applicationToken,
        answers: { ...answers, practiceArea: "A competing duplicate answer" },
      }),
    ]);
    const concurrentId = byKey.get("book-buyer-order:order-9")!;
    check(
      concurrentResults.every((result) => result.body.outcome === "qualified"),
      "concurrent duplicate submissions converge on one final outcome",
    );
    check(
      appointments.has(concurrentId) &&
        typeof applications.get(concurrentId)?.answers?.practiceArea === "string",
      "concurrent duplicate submissions persist one answer set and one appointment",
    );

    settings.delete(BOOK_BUYER_GHL_CALENDAR_SETTING);
    const unavailableStart = await start("8");
    const unavailable = await post("/api/book/journey/submit", {
      applicationToken: unavailableStart.body.applicationToken,
      answers,
    });
    check(unavailable.body.outcome === "qualified", "calendar outage does not erase qualification");
    check(
      unavailable.body.calendar.available === false,
      "missing GHL configuration fails closed with recoverable unavailable state",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`\nbook-buyer-journey-routes: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
