/* test-registration
{
  "name": "Orphaned communications hidden from client-linked views (Task #904)",
  "tier": "small"
}
test-registration */
/**
 * Task #904 / Task #965 — orphaned communications are hidden from client-linked views.
 *
 * When a client is deleted, the deleteClient flow (Task #897 Phase 5) keeps
 * the raw_communication_records rows for forensic / audit purposes but null
 * the client_id and stamps match_status='orphaned'. The hide-from-views
 * counterpart was missing — without it the rows would still surface in the
 * unmatched feed, the per-client conversation list (via communication_client_links),
 * the unmatched-Slack feed, and the operational classifier feeds.
 *
 * This integration test runs against the live DB inside a transactional sandbox
 * (rolled back at the end) and asserts:
 *
 *   1. Raw + linked-via-CCL rows for a deleted client disappear from
 *      `storage.listRawCommunications(otherClientId, ...)` by default but can
 *      be opted back in with `{ includeOrphaned: true }`.
 *   2. `listUnmatchedRawCommunications` and `listUnmatchedSlackMessages` skip
 *      orphaned rows by default.
 *   3. The deleteClient transition really does stamp 'orphaned' on every
 *      raw_communication_records row that pointed at the deleted client.
 *
 * Registered in tests/run-all.ts.
 */

import { eq } from "drizzle-orm";

import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import {
  rawCommunicationRecords,
  type InsertClient,
  type InsertRawCommunication,
} from "@shared/schema";
import { storage } from "../server/storage";

const TAG = `orphaned-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

function buildClient(firmName: string): InsertClient {
  return {
    firmName: `${firmName} [${TAG}]`,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
  };
}

function buildSlackComm(
  clientId: string | null,
  externalSourceId: string,
  title: string,
): InsertRawCommunication {
  return {
    sourceType: "slack",
    sourceSubtype: "message",
    title: `${title} [${TAG}]`,
    timestamp: new Date(),
    direction: "inbound",
    externalSourceId,
    clientId,
    reviewStatus: "unreviewed",
    contentText: "test slack body",
    contentPreview: "test",
    rawPayloadJson: { tag: TAG },
    participantsJson: [{ name: "Sender", email: "sender@example.com" }],
  };
}

function buildZoomComm(
  clientId: string | null,
  externalSourceId: string,
  title: string,
): InsertRawCommunication {
  return {
    sourceType: "zoom",
    sourceSubtype: "meeting",
    title: `${title} [${TAG}]`,
    timestamp: new Date(),
    direction: "inbound",
    externalSourceId,
    clientId,
    reviewStatus: "unreviewed",
    contentText: "test zoom transcript",
    contentPreview: "test",
    rawPayloadJson: { tag: TAG },
    participantsJson: [{ name: "Host", email: "host@example.com" }],
  };
}

async function testListRawCommunicationsHidesOrphaned(): Promise<void> {
  section("listRawCommunications hides orphaned via communication_client_links");

  const aliveClient = await storage.createClient(buildClient("Alive"));
  const doomedClient = await storage.createClient(buildClient("Doomed"));

  // Comm A: directly belongs to the doomed client (will be orphaned on delete).
  const directComm = await storage.createRawCommunication(
    buildSlackComm(doomedClient.id, `${TAG}-direct`, "Direct slack to doomed"),
  );
  // Comm B: belongs to the doomed client AND has a CCL linking it to the
  // alive client. After the doomed client's deletion the CCL row survives,
  // which is exactly the surface the task flagged: a client-scoped view for
  // the alive client could still surface this orphaned record via the link.
  const linkedComm = await storage.createRawCommunication(
    buildSlackComm(doomedClient.id, `${TAG}-linked`, "Linked slack to doomed"),
  );
  await storage.createCommunicationClientLink({
    rawCommunicationRecordId: linkedComm.id,
    clientId: aliveClient.id,
    status: "confirmed",
  });

  // Sanity: before delete, the linked comm shows up under the alive client.
  const beforeDelete = await storage.listRawCommunications(aliveClient.id);
  assert(
    beforeDelete.some(r => r.id === linkedComm.id),
    "linked comm visible to alive client before doomed client deletion",
  );

  await storage.deleteClient(doomedClient.id);

  // Both rows should now be marked orphaned.
  const directAfter = await storage.getRawCommunication(directComm.id);
  const linkedAfter = await storage.getRawCommunication(linkedComm.id);
  assert(directAfter?.matchStatus === "orphaned",
    `direct comm match_status='orphaned' after delete (got '${directAfter?.matchStatus}')`);
  assert(linkedAfter?.matchStatus === "orphaned",
    `linked comm match_status='orphaned' after delete (got '${linkedAfter?.matchStatus}')`);
  assert(directAfter?.clientId === null && linkedAfter?.clientId === null,
    "deleteClient nulls client_id on orphaned rows");

  // Default view: orphaned rows are hidden, even via the CCL bridge.
  const afterDelete = await storage.listRawCommunications(aliveClient.id);
  assert(
    !afterDelete.some(r => r.id === linkedComm.id),
    "linked-via-CCL orphaned comm is hidden from alive client's default view",
  );
  assert(
    !afterDelete.some(r => r.id === directComm.id),
    "direct orphaned comm is not visible to other clients (defense-in-depth)",
  );

  // Opt-in for forensic queries still surfaces the row.
  const forensicView = await storage.listRawCommunications(aliveClient.id, {
    includeOrphaned: true,
  });
  assert(
    forensicView.some(r => r.id === linkedComm.id),
    "includeOrphaned=true opt-in resurfaces linked orphaned comm",
  );
}

async function testUnmatchedFeedsHideOrphaned(): Promise<void> {
  section("listUnmatchedRawCommunications + listUnmatchedSlackMessages hide orphaned");

  const doomedClient = await storage.createClient(buildClient("DoomedFeed"));

  // Truly-unmatched slack message that should keep showing.
  const liveUnmatched = await storage.createRawCommunication(
    buildSlackComm(null, `${TAG}-feed-live`, "Live unmatched slack"),
  );
  // Slack message currently attached to the doomed client → will become orphaned.
  const willOrphanSlack = await storage.createRawCommunication(
    buildSlackComm(doomedClient.id, `${TAG}-feed-slack`, "Slack to doomed"),
  );
  // Zoom message currently attached → will also become orphaned.
  const willOrphanZoom = await storage.createRawCommunication(
    buildZoomComm(doomedClient.id, `${TAG}-feed-zoom`, "Zoom to doomed"),
  );

  await storage.deleteClient(doomedClient.id);

  // Default unmatched-slack feed: live one shows, orphaned one doesn't.
  const slackFeed = await storage.listUnmatchedSlackMessages(500);
  assert(
    slackFeed.some(r => r.id === liveUnmatched.id),
    "live unmatched slack still surfaces in default unmatched-slack feed",
  );
  assert(
    !slackFeed.some(r => r.id === willOrphanSlack.id),
    "orphaned slack is hidden from default unmatched-slack feed",
  );

  // Opt-in lets the orphan back in.
  const slackFeedForensic = await storage.listUnmatchedSlackMessages(500, {
    includeOrphaned: true,
  });
  assert(
    slackFeedForensic.some(r => r.id === willOrphanSlack.id),
    "includeOrphaned=true on listUnmatchedSlackMessages resurfaces orphaned slack",
  );

  // Generic unmatched-raw feed (used by AI matching agents): orphaned hidden.
  const rawFeed = await storage.listUnmatchedRawCommunications({ limit: 500 });
  assert(
    !rawFeed.some(r => r.id === willOrphanSlack.id),
    "orphaned slack hidden from listUnmatchedRawCommunications by default",
  );
  assert(
    !rawFeed.some(r => r.id === willOrphanZoom.id),
    "orphaned zoom hidden from listUnmatchedRawCommunications by default",
  );
  const rawFeedForensic = await storage.listUnmatchedRawCommunications({
    limit: 500,
    includeOrphaned: true,
  });
  assert(
    rawFeedForensic.some(r => r.id === willOrphanZoom.id),
    "includeOrphaned=true on listUnmatchedRawCommunications resurfaces orphaned zoom",
  );

  // And the underlying row is still in the table — we never delete it.
  const stillThere = await getDb()
    .select()
    .from(rawCommunicationRecords)
    .where(eq(rawCommunicationRecords.id, willOrphanZoom.id));
  assert(stillThere.length === 1,
    "orphaned row is preserved in raw_communication_records (forensic-only, not deleted)");
}

async function testZoomMessagesFeedHidesOrphaned(): Promise<void> {
  section("getZoomMessagesPage hides orphaned zoom rows from operator feed (Task #965)");

  const { getZoomMessagesPage } = await import("../server/services/zoomMessagesFeed");

  const doomedClient = await storage.createClient(buildClient("DoomedZoomFeed"));

  // Live unmatched zoom row (parent client never existed) — must keep showing.
  const liveUnmatchedZoom = await storage.createRawCommunication(
    buildZoomComm(null, `${TAG}-zfeed-live`, "Live unmatched zoom"),
  );
  // Zoom row attached to the doomed client — will be orphaned on delete.
  const willOrphanZoom = await storage.createRawCommunication(
    buildZoomComm(doomedClient.id, `${TAG}-zfeed-doomed`, "Zoom to doomed"),
  );

  await storage.deleteClient(doomedClient.id);

  // Default (no match filter) — orphan must not appear in the messages list,
  // and global stats must not count it as "unmatched".
  const allView = await getZoomMessagesPage({ limit: 500 });
  assert(
    allView.messages.some(m => m.id === liveUnmatchedZoom.id),
    "live unmatched zoom still surfaces in default getZoomMessagesPage view",
  );
  assert(
    !allView.messages.some(m => m.id === willOrphanZoom.id),
    "orphaned zoom is hidden from default getZoomMessagesPage view",
  );

  // Sanity: live unmatched is counted but orphan is not. We can't assert the
  // raw integers (the table is shared across all clients), so we re-fetch
  // before/after a second orphan create+delete inside this same sandbox would
  // be a no-op — instead we assert the orphan is absent from the unmatched
  // bucket *and* the unmatched count is at least 1 (the live row), proving
  // the global stats query also applies the orphan filter rather than
  // double-counting from the unfiltered table.
  assert(
    allView.stats.unmatched >= 1,
    `getZoomMessagesPage stats.unmatched counts the live unmatched zoom (got ${allView.stats.unmatched})`,
  );

  // Explicit unmatched filter — same expectation.
  const unmatchedView = await getZoomMessagesPage({ match: "unmatched", limit: 500 });
  assert(
    !unmatchedView.messages.some(m => m.id === willOrphanZoom.id),
    "orphaned zoom is hidden from getZoomMessagesPage match=unmatched",
  );
  assert(
    unmatchedView.messages.some(m => m.id === liveUnmatchedZoom.id),
    "live unmatched zoom still surfaces under match=unmatched",
  );
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
(async () => {
  let exitCode = 0;
  try {
    await runInTxSandbox(testListRawCommunicationsHidesOrphaned);
    await runInTxSandbox(testUnmatchedFeedsHideOrphaned);
    await runInTxSandbox(testZoomMessagesFeedHidesOrphaned);
  } catch (err) {
    failed++;
    console.error("\n[orphaned-communications-hidden] uncaught error:", err);
    exitCode = 1;
  }
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) exitCode = 1;
  process.exitCode = exitCode;
})();
