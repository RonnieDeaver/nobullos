/* test-registration
{
  "name": "Zoom resolved-panel e2e",
  "tier": "small"
}
test-registration */
/**
 * End-to-end test for the resolved-decision panel on Zoom rows (task #523).
 *
 * Drives all three review-decision resolution variants (approved, reassigned,
 * dismissed) through the production review-queue services against the live DB
 * inside a transactional sandbox (rolled back at the end), then:
 *
 *   1. Calls `getZoomMessagesPage(...)` — the same function the
 *      GET /api/integrations/zoom/messages route returns to clients — and
 *      asserts the seeded raw record's `resolved` payload exposes the
 *      reviewer, reviewedAt, suggested vs. final client, and dismissReason
 *      parsed from the raw record's matchMethod.
 *
 *   2. Renders the production `MeetingRow` component (the same component
 *      ZoomIntegration.tsx renders for each row) into jsdom with the API
 *      payload from step 1, and asserts the resolved panel emits the
 *      data-testids ZoomIntegration relies on:
 *        resolved-panel-${id}, resolved-headline-${id},
 *        resolved-suggested-${id}, resolved-final-${id}
 *      (plus resolved-dismiss-reason-${id} for dismissed).
 *
 * Registered in tests/run-all.ts.
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Stub fetch — MeetingRow's expanded body fetches /api/communications/.../client-links.
// The resolved panel does not depend on this; we just keep it from throwing.
(globalThis as any).fetch = async () =>
  new dom.window.Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { runInTxSandbox } from "./db-sandbox";
import { type InsertClient, type InsertRawCommunication } from "@shared/schema";
import { users } from "@shared/models/auth";
import { storage } from "../server/storage";
import { getDb } from "../server/db";
import {
  recordZoomReviewDecision,
  approveReviewDecision,
  dismissReviewDecision,
} from "../server/services/zoomReviewQueue";
import { getZoomMessagesPage } from "../server/services/zoomMessagesFeed";
import { MeetingRow, type ZoomMessageFeed } from "../client/src/pages/admin/ZoomIntegration";

const E2E_TAG = `e2e-zoomresolved-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function seedReviewer(label: string): Promise<{ id: string; fullName: string }> {
  const id = `${E2E_TAG}-reviewer-${label}`;
  const firstName = `${label}First`;
  const lastName = `${label}Last`;
  await getDb().insert(users).values({
    id,
    email: `${id}@example.test`,
    firstName,
    lastName,
    role: "team_lead",
  });
  return { id, fullName: `${firstName} ${lastName}` };
}

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function section(title: string): void {
  console.log(`\n— ${title} —`);
}

function buildClientFixture(firmName: string): InsertClient {
  return {
    firmName: `${firmName} [${E2E_TAG}]`,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
  };
}

function buildRawZoomFixture(externalSourceId: string, title: string): InsertRawCommunication {
  return {
    sourceType: "zoom",
    sourceSubtype: "meeting",
    title: `${title} [${E2E_TAG}]`,
    timestamp: new Date(),
    direction: "inbound",
    externalSourceId,
    contentText: "(transcript omitted)",
    contentPreview: "test",
    rawPayloadJson: { e2eTag: E2E_TAG },
    participantsJson: [{ name: "External", email: "external@client-firm.example" }],
  };
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

/**
 * Locate the seeded raw record in the API response, scoped to this test run
 * so other rows in the live DB can't pollute the assertion.
 */
function findSeededMessage(
  messages: any[],
  rawId: string,
): ZoomMessageFeed {
  const m = messages.find((x) => x.id === rawId);
  if (!m) throw new Error(`Seeded message ${rawId} not found in API response (got ${messages.length} rows)`);
  return m as ZoomMessageFeed;
}

async function renderMeetingRow(msg: ZoomMessageFeed): Promise<Root> {
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(MeetingRow, {
          msg,
          isExpanded: true,
          onToggle: () => {},
          clients: [],
          onReassign: () => {},
          isReassigning: false,
          userTimezone: "UTC",
          onReviewApprove: () => {},
          onReviewDismiss: () => {},
          isReviewing: false,
        }),
      ),
    );
  });
  return root;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

async function testApprovedVariant(): Promise<void> {
  section("Approved decision — API payload + MeetingRow panel");

  const suggested = await storage.createClient(buildClientFixture("Approved Suggested"));
  const externalId = `e2e-zoom-resolved-approved-${E2E_TAG}`;
  const raw = await storage.createRawCommunication(buildRawZoomFixture(externalId, "Approved variant"));

  const decision = await recordZoomReviewDecision({
    communicationId: externalId,
    communicationType: "zoom_meeting",
    suggestedClientId: suggested.id,
    confidenceScore: 0.55,
    explanationSummary: "[e2e] approved variant",
    reviewReason: "weak_signal_only",
    candidateShortlist: [{ clientId: suggested.id, confidenceScore: 0.55 }],
    evidenceType: "structured",
  });
  const reviewer = await seedReviewer("approved");
  await approveReviewDecision({ decisionId: decision.id, userId: reviewer.id });

  // Hit the same code path the route uses to build the JSON response. Ask
  // for matched rows so the seeded approved row is in the page even if the
  // live DB has unrelated zoom data.
  const response = await getZoomMessagesPage({ match: "matched", limit: 100 });
  const msg = findSeededMessage(response.messages, raw.id);
  const r = msg.resolved;

  assert(r != null, "API response includes resolved payload on the approved row");
  assert(r?.resolution === "approved", `resolved.resolution === 'approved' (got '${r?.resolution}')`);
  assert(r?.reviewedAt != null, "resolved.reviewedAt is populated");
  assert(r?.suggestedClientId === suggested.id, "resolved.suggestedClientId matches the original suggestion");
  assert(r?.suggestedClientName?.includes("Approved Suggested") === true,
    `resolved.suggestedClientName names the suggestion (got '${r?.suggestedClientName}')`);
  assert(r?.finalClientId === suggested.id, "resolved.finalClientId === suggestedClientId for approved");
  assert(r?.finalClientName === r?.suggestedClientName, "resolved.finalClientName === suggestedClientName for approved");
  assert(r?.dismissReason === null, "resolved.dismissReason is null for approved");
  assert(r?.reviewerName === reviewer.fullName,
    `resolved.reviewerName === '${reviewer.fullName}' (got '${r?.reviewerName}')`);

  const root = await renderMeetingRow(msg);
  assert($(`resolved-panel-${raw.id}`) != null, `resolved-panel-${raw.id} rendered`);
  const headline = $(`resolved-headline-${raw.id}`);
  assert(headline?.textContent?.includes("Approved") === true,
    `resolved-headline-${raw.id} contains 'Approved' (got '${headline?.textContent}')`);
  const meta = $(`resolved-meta-${raw.id}`);
  assert(meta?.textContent?.includes(reviewer.fullName) === true,
    `resolved-meta-${raw.id} renders the reviewer name (got '${meta?.textContent}')`);
  const suggestedEl = $(`resolved-suggested-${raw.id}`);
  assert(suggestedEl?.textContent?.includes("Approved Suggested") === true,
    `resolved-suggested-${raw.id} shows the original suggestion`);
  const finalEl = $(`resolved-final-${raw.id}`);
  assert(finalEl?.textContent?.includes("Approved Suggested") === true,
    `resolved-final-${raw.id} shows the final attribution`);
  await unmount(root);
}

async function testReassignedVariant(): Promise<void> {
  section("Reassigned decision — API payload + MeetingRow panel");

  const suggested = await storage.createClient(buildClientFixture("Reassign Suggested"));
  const target = await storage.createClient(buildClientFixture("Reassign Target"));
  const externalId = `e2e-zoom-resolved-reassign-${E2E_TAG}`;
  const raw = await storage.createRawCommunication(buildRawZoomFixture(externalId, "Reassigned variant"));

  const decision = await recordZoomReviewDecision({
    communicationId: externalId,
    communicationType: "zoom_meeting",
    suggestedClientId: suggested.id,
    confidenceScore: 0.5,
    explanationSummary: "[e2e] reassigned variant",
    reviewReason: "contact_name_only_weak",
    candidateShortlist: [
      { clientId: suggested.id, confidenceScore: 0.5 },
      { clientId: target.id, confidenceScore: 0.45 },
    ],
    evidenceType: "structured",
  });
  const reviewer = await seedReviewer("reassigned");
  await approveReviewDecision({
    decisionId: decision.id,
    userId: reviewer.id,
    approvedClientId: target.id,
  });

  const response = await getZoomMessagesPage({ match: "matched", clientId: target.id, limit: 100 });
  const msg = findSeededMessage(response.messages, raw.id);
  const r = msg.resolved;

  assert(r?.resolution === "reassigned", `resolved.resolution === 'reassigned' (got '${r?.resolution}')`);
  assert(r?.suggestedClientId === suggested.id,
    "resolved.suggestedClientId points at the original suggestion");
  assert(r?.suggestedClientName?.includes("Reassign Suggested") === true,
    `resolved.suggestedClientName names the original suggestion (got '${r?.suggestedClientName}')`);
  assert(r?.finalClientId === target.id, "resolved.finalClientId points at the corrected target");
  assert(r?.finalClientName?.includes("Reassign Target") === true,
    `resolved.finalClientName names the corrected target (got '${r?.finalClientName}')`);
  assert(r?.dismissReason === null, "resolved.dismissReason is null for reassigned");
  assert(r?.reviewerName === reviewer.fullName,
    `resolved.reviewerName === '${reviewer.fullName}' (got '${r?.reviewerName}')`);

  const root = await renderMeetingRow(msg);
  assert($(`resolved-panel-${raw.id}`) != null, `resolved-panel-${raw.id} rendered`);
  const headline = $(`resolved-headline-${raw.id}`);
  assert(headline?.textContent?.includes("Reassigned") === true,
    `resolved-headline-${raw.id} contains 'Reassigned' (got '${headline?.textContent}')`);
  const meta = $(`resolved-meta-${raw.id}`);
  assert(meta?.textContent?.includes(reviewer.fullName) === true,
    `resolved-meta-${raw.id} renders the reviewer name (got '${meta?.textContent}')`);
  const suggestedEl = $(`resolved-suggested-${raw.id}`);
  assert(suggestedEl?.textContent?.includes("Reassign Suggested") === true,
    `resolved-suggested-${raw.id} shows the original suggestion`);
  const finalEl = $(`resolved-final-${raw.id}`);
  assert(finalEl?.textContent?.includes("Reassign Target") === true,
    `resolved-final-${raw.id} shows the corrected target`);
  assert(finalEl?.textContent?.includes("corrected from Reassign Suggested") === true,
    `resolved-final-${raw.id} shows the (corrected from …) hint`);
  await unmount(root);
}

async function testDismissedVariant(): Promise<void> {
  section("Dismissed decision — API payload + MeetingRow panel");

  const suggested = await storage.createClient(buildClientFixture("Dismiss Suggested"));
  const externalId = `e2e-zoom-resolved-dismiss-${E2E_TAG}`;
  const raw = await storage.createRawCommunication(buildRawZoomFixture(externalId, "Dismissed variant"));

  const decision = await recordZoomReviewDecision({
    communicationId: externalId,
    communicationType: "zoom_meeting",
    suggestedClientId: suggested.id,
    confidenceScore: 0.4,
    explanationSummary: "[e2e] dismissed variant",
    reviewReason: "weak_signal_only",
    candidateShortlist: [{ clientId: suggested.id, confidenceScore: 0.4 }],
    evidenceType: "structured",
  });
  const reviewer = await seedReviewer("dismissed");
  await dismissReviewDecision({
    decisionId: decision.id,
    userId: reviewer.id,
    reason: "not_relevant",
  });

  const response = await getZoomMessagesPage({ match: "unmatched", limit: 100 });
  const msg = findSeededMessage(response.messages, raw.id);
  const r = msg.resolved;

  assert(msg.matchMethod === "dismissed:not_relevant",
    `precondition: API row matchMethod='dismissed:not_relevant' (got '${msg.matchMethod}')`);
  assert(r?.resolution === "dismissed", `resolved.resolution === 'dismissed' (got '${r?.resolution}')`);
  assert(r?.suggestedClientId === suggested.id, "resolved.suggestedClientId points at the original suggestion");
  assert(r?.finalClientId === null, "resolved.finalClientId === null for dismissed");
  assert(r?.finalClientName === null, "resolved.finalClientName === null for dismissed");
  assert(r?.dismissReason === "not_relevant",
    `resolved.dismissReason parsed from matchMethod (got '${r?.dismissReason}')`);
  assert(r?.reviewerName === reviewer.fullName,
    `resolved.reviewerName === '${reviewer.fullName}' (got '${r?.reviewerName}')`);

  const root = await renderMeetingRow(msg);
  assert($(`resolved-panel-${raw.id}`) != null, `resolved-panel-${raw.id} rendered`);
  const headline = $(`resolved-headline-${raw.id}`);
  assert(headline?.textContent?.includes("Dismissed") === true,
    `resolved-headline-${raw.id} contains 'Dismissed' (got '${headline?.textContent}')`);
  const meta = $(`resolved-meta-${raw.id}`);
  assert(meta?.textContent?.includes(reviewer.fullName) === true,
    `resolved-meta-${raw.id} renders the reviewer name (got '${meta?.textContent}')`);
  const dismissReasonEl = $(`resolved-dismiss-reason-${raw.id}`);
  assert(dismissReasonEl?.textContent?.includes("not_relevant") === true,
    `resolved-dismiss-reason-${raw.id} shows the parsed dismiss reason`);
  const suggestedEl = $(`resolved-suggested-${raw.id}`);
  assert(suggestedEl?.textContent?.includes("Dismiss Suggested") === true,
    `resolved-suggested-${raw.id} still shows the original suggestion`);
  const finalEl = $(`resolved-final-${raw.id}`);
  assert(finalEl?.textContent?.includes("Unattributed") === true,
    `resolved-final-${raw.id} shows 'Unattributed' for dismissed (got '${finalEl?.textContent}')`);
  await unmount(root);
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
(async () => {
  let exitCode = 0;
  try {
    await runInTxSandbox(testApprovedVariant);
    await runInTxSandbox(testReassignedVariant);
    await runInTxSandbox(testDismissedVariant);
  } catch (err) {
    failed++;
    console.error("\n[E2E] uncaught error:", err);
    exitCode = 1;
  }
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) exitCode = 1;
  process.exitCode = exitCode;
})();
