/* test-registration
{
  "name": "Activity Feed review-decision lookup",
  "tier": "medium",
  "tierReason": "Uses a transactional database sandbox to exercise the multi-key route lookup end to end."
}
test-registration */
/**
 * Regression test for task #612: the Activity Feed Zoom review-decision
 * lookup in server/routes/integrations.ts used `ANY(${keys}::text[])`,
 * which Postgres rejects ("cannot cast type record to text[]") whenever
 * drizzle binds the JS array as a parameter list. The route swallowed the
 * error in a try/catch, so every Activity Feed item silently lost its
 * `review` block (reviewer name, candidate names, suggested client name,
 * etc.) for any row that needed a review lookup.
 *
 * The fix moves the lookup into server/services/activityFeedReview.ts and
 * uses the safe `ANY(ARRAY[...]::text[])` pattern (same as
 * server/services/zoomMessagesFeed.ts). This test exercises the multi-key
 * path end to end against the live DB inside a transactional sandbox so the
 * regression can't slip back in silently:
 *
 *   1. Seeds two open review_required Zoom decisions — one keyed by raw
 *      record id, one keyed by external_source_id — to prove both lookup
 *      keys round-trip through the ARRAY[...] cast.
 *   2. Calls decorateActivityFeedZoomReviews(items) directly.
 *   3. Asserts each item ends up with a populated `review` block:
 *      decisionId, suggested client name, candidate clientName resolved
 *      via the second ARRAY[...] cast, etc.
 *   4. Asserts a third (no-decision) item gets review = null.
 *
 * Registered in tests/run-all.ts.
 */

import { eq } from "drizzle-orm";
import { runInTxSandbox } from "./db-sandbox";
import { storage } from "../server/storage";
import { getDb } from "../server/db";
import {
  recordZoomReviewDecision,
  approveReviewDecision,
  reopenReviewDecision,
} from "../server/services/zoomReviewQueue";
import {
  decorateActivityFeedZoomReviews,
  type ActivityFeedZoomItem,
} from "../server/services/activityFeedReview";
import { type InsertClient, type InsertRawCommunication } from "@shared/schema";
import { users } from "@shared/models/auth";

const TAG = `t612-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

function clientFixture(name: string): InsertClient {
  return {
    firmName: `${name} [${TAG}]`,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
  };
}

function rawZoomFixture(externalSourceId: string, title: string): InsertRawCommunication {
  return {
    sourceType: "zoom",
    sourceSubtype: "meeting",
    title: `${title} [${TAG}]`,
    timestamp: new Date(),
    direction: "inbound",
    externalSourceId,
    contentText: "(transcript omitted)",
    contentPreview: "test",
    rawPayloadJson: { tag: TAG },
    participantsJson: [{ name: "External", email: "external@client.example" }],
  };
}

async function run(): Promise<void> {
  console.log("\n— Activity Feed review-decision lookup (multi-key path) —");

  // Item A: keyed by raw record id (decision.communication_id == raw.id).
  const suggestedA = await storage.createClient(clientFixture("Item A Suggested"));
  const candidateA = await storage.createClient(clientFixture("Item A Candidate"));
  const externalA = `t612-zoom-A-${TAG}`;
  const rawA = await storage.createRawCommunication(rawZoomFixture(externalA, "Activity feed item A"));
  await recordZoomReviewDecision({
    communicationId: rawA.id,
    communicationType: "zoom_meeting",
    suggestedClientId: suggestedA.id,
    confidenceScore: 0.55,
    explanationSummary: "[t612] item A",
    reviewReason: "weak_signal_only",
    candidateShortlist: [
      { clientId: suggestedA.id, confidenceScore: 0.55 },
      { clientId: candidateA.id, confidenceScore: 0.42 },
    ],
    evidenceType: "structured",
  });

  // Item B: keyed by external_source_id (decision.communication_id == raw.external_source_id).
  const suggestedB = await storage.createClient(clientFixture("Item B Suggested"));
  const externalB = `t612-zoom-B-${TAG}`;
  const rawB = await storage.createRawCommunication(rawZoomFixture(externalB, "Activity feed item B"));
  await recordZoomReviewDecision({
    communicationId: externalB,
    communicationType: "zoom_meeting",
    suggestedClientId: suggestedB.id,
    confidenceScore: 0.48,
    explanationSummary: "[t612] item B",
    reviewReason: "contact_name_only_weak",
    candidateShortlist: [{ clientId: suggestedB.id, confidenceScore: 0.48 }],
    evidenceType: "structured",
  });

  // Item C: no decision at all — should end up with review = null.
  const externalC = `t612-zoom-C-${TAG}`;
  const rawC = await storage.createRawCommunication(rawZoomFixture(externalC, "Activity feed item C"));

  const items: ActivityFeedZoomItem[] = [
    { source: "zoom", metadata: { recordId: rawA.id, externalSourceId: externalA } },
    { source: "zoom", metadata: { recordId: rawB.id, externalSourceId: externalB } },
    { source: "zoom", metadata: { recordId: rawC.id, externalSourceId: externalC } },
    { source: "front", metadata: { recordId: "front-noise" } },
  ];

  await decorateActivityFeedZoomReviews(items);

  const a = items[0];
  assert(a.review != null, "Item A keyed by record id received a review block");
  assert(a.review?.suggestedClientId === suggestedA.id,
    `Item A review.suggestedClientId === seeded suggested (got '${a.review?.suggestedClientId}')`);
  assert(a.review?.suggestedClientName?.includes("Item A Suggested") === true,
    `Item A review.suggestedClientName resolved via JOIN (got '${a.review?.suggestedClientName}')`);
  assert(Math.abs((a.review?.suggestedConfidence ?? 0) - 0.55) < 1e-6,
    `Item A review.suggestedConfidence === 0.55 (got ${a.review?.suggestedConfidence})`);
  const candidateNames = (a.review?.candidates || []).map((c) => c.clientName || "");
  assert(candidateNames.some((n) => n.includes("Item A Candidate")),
    `Item A candidates resolved the second ARRAY[...] cast (got ${JSON.stringify(candidateNames)})`);
  assert(a.suggestedClientId === suggestedA.id,
    "Item A top-level suggestedClientId promoted from review block");

  const b = items[1];
  assert(b.review != null, "Item B keyed by external_source_id received a review block");
  assert(b.review?.suggestedClientId === suggestedB.id,
    `Item B review.suggestedClientId === seeded suggested (got '${b.review?.suggestedClientId}')`);
  assert(b.review?.suggestedClientName?.includes("Item B Suggested") === true,
    `Item B review.suggestedClientName resolved via JOIN (got '${b.review?.suggestedClientName}')`);

  const c = items[2];
  assert(c.review === null, "Item C with no open decision received review === null");

  const noise = items[3];
  assert(noise.review === undefined, "Non-zoom items are left untouched (review remains undefined)");

  // ---------------------------------------------------------------
  // Task #1210: reopener name + email round-trip through the JOIN
  // and the deleted-user fallback.
  // ---------------------------------------------------------------
  console.log("\n— Activity Feed reopener name/email decoration (task #1210) —");

  // Case D: reopen by a real user; expect reopenedByName/Email populated
  // from the LEFT JOIN on users in activityFeedReview.ts.
  const suggestedD = await storage.createClient(clientFixture("Item D Suggested"));
  const externalD = `t1210-zoom-D-${TAG}`;
  const rawD = await storage.createRawCommunication(rawZoomFixture(externalD, "Activity feed item D"));
  const decisionD = await recordZoomReviewDecision({
    communicationId: rawD.id,
    communicationType: "zoom_meeting",
    suggestedClientId: suggestedD.id,
    confidenceScore: 0.61,
    explanationSummary: "[t1210] item D",
    reviewReason: "weak_signal_only",
    candidateShortlist: [{ clientId: suggestedD.id, confidenceScore: 0.61 }],
    evidenceType: "structured",
  });

  const reopenerEmail = `reopener-${TAG}@example.test`;
  const [reopener] = await getDb()
    .insert(users)
    .values({
      email: reopenerEmail,
      firstName: "Rebecca",
      lastName: "Opener",
    })
    .returning();

  // Approve so we have something to reopen, then reopen as the seeded user.
  await approveReviewDecision({ decisionId: decisionD.id, userId: reopener.id });
  await reopenReviewDecision({ decisionId: decisionD.id, userId: reopener.id });

  const itemsD: ActivityFeedZoomItem[] = [
    { source: "zoom", metadata: { recordId: rawD.id, externalSourceId: externalD } },
  ];
  await decorateActivityFeedZoomReviews(itemsD);
  const d = itemsD[0];
  assert(d.review != null, "Item D received a review block after reopen");
  assert(d.review?.reopenedByUserId === reopener.id,
    `Item D review.reopenedByUserId === seeded reopener id (got '${d.review?.reopenedByUserId}')`);
  assert(d.review?.reopenedByName === "Rebecca Opener",
    `Item D review.reopenedByName === full name from JOIN (got '${d.review?.reopenedByName}')`);
  assert(d.review?.reopenedByEmail === reopenerEmail,
    `Item D review.reopenedByEmail === seeded reopener email (got '${d.review?.reopenedByEmail}')`);
  assert((d.review?.reopenCount ?? 0) >= 1,
    `Item D review.reopenCount incremented (got ${d.review?.reopenCount})`);
  assert(d.review?.reopenedAt != null, "Item D review.reopenedAt populated");

  // Case E: reopener user is deleted — JOIN returns null name/email,
  // decoration falls back to the raw user id and reopenedByEmail is null.
  const suggestedE = await storage.createClient(clientFixture("Item E Suggested"));
  const externalE = `t1210-zoom-E-${TAG}`;
  const rawE = await storage.createRawCommunication(rawZoomFixture(externalE, "Activity feed item E"));
  const decisionE = await recordZoomReviewDecision({
    communicationId: rawE.id,
    communicationType: "zoom_meeting",
    suggestedClientId: suggestedE.id,
    confidenceScore: 0.59,
    explanationSummary: "[t1210] item E",
    reviewReason: "weak_signal_only",
    candidateShortlist: [{ clientId: suggestedE.id, confidenceScore: 0.59 }],
    evidenceType: "structured",
  });

  const ghostEmail = `ghost-${TAG}@example.test`;
  const [ghost] = await getDb()
    .insert(users)
    .values({
      email: ghostEmail,
      firstName: "Ghost",
      lastName: "User",
    })
    .returning();
  const ghostId = ghost.id;

  await approveReviewDecision({ decisionId: decisionE.id, userId: ghost.id });
  await reopenReviewDecision({ decisionId: decisionE.id, userId: ghost.id });

  // Now delete the user so the LEFT JOIN returns nulls for first/last/email
  // but the decision still carries the raw reopened_by_user_id.
  await getDb().delete(users).where(eq(users.id, ghostId));

  const itemsE: ActivityFeedZoomItem[] = [
    { source: "zoom", metadata: { recordId: rawE.id, externalSourceId: externalE } },
  ];
  await decorateActivityFeedZoomReviews(itemsE);
  const e = itemsE[0];
  assert(e.review != null, "Item E received a review block after reopener deletion");
  assert(e.review?.reopenedByUserId === ghostId,
    `Item E review.reopenedByUserId still carries raw user id (got '${e.review?.reopenedByUserId}')`);
  assert(e.review?.reopenedByEmail === null,
    `Item E review.reopenedByEmail is null when JOIN misses (got '${e.review?.reopenedByEmail}')`);
  assert(e.review?.reopenedByName === ghostId,
    `Item E review.reopenedByName falls back to raw user id (got '${e.review?.reopenedByName}')`);
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
(async () => {
  let exitCode = 0;
  try {
    await runInTxSandbox(run);
  } catch (err) {
    failed++;
    console.error("\n[t612] uncaught error:", err);
    exitCode = 1;
  }
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) exitCode = 1;
  process.exitCode = exitCode;
})();
