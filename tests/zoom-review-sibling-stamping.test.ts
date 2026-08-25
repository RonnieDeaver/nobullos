/* test-registration
{
  "name": "Zoom review sibling stamping (Task #4050)",
  "smoke": true,
  "smokeReason": "Fixture-scoped DB test: review approve/reassign/dismiss/reopen and feed reassignment must stamp every sibling raw record, or a reviewed Zoom call keeps a half-attributed sibling invisible to churn comms.",
  "tier": "small"
}
test-registration */
/**
 * Task #4050 — manual review actions must stamp EVERY raw record of a
 * meeting, not just the decision's own row.
 *
 * A Zoom meeting materializes as up to three raw_communication_records
 * (recording + transcript + meeting) sharing one externalSourceId. Before
 * this task, approving a review decision stamped only the decision's row —
 * the sibling transcript stayed unmatched and invisible to churn comms.
 *
 * Covers, against the live DB inside a transactional sandbox:
 *   1. approveReviewDecision stamps BOTH siblings + links, resolves the
 *      decision, returns stampedRecordIds.
 *   2. reopenReviewDecision resets BOTH siblings to review_required.
 *   3. approve with approvedClientId (reassign) restamps both, deletes the
 *      PRIOR client's links only.
 *   4. dismissReviewDecision clears both siblings and their links.
 *   5. manualReassignZoomRecordFromFeed (feed PATCH path) stamps both,
 *      resolves open decisions keyed by record id OR externalSourceId, and
 *      clears everything on clientId=null.
 *   6. Records with NULL externalSourceId never cross-stamp each other.
 *   7. Non-zoom records are refused (null return).
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { runInTxSandbox } from "./db-sandbox";
import { storage } from "../server/storage";
import { getDb } from "../server/db";
import {
  recordZoomReviewDecision,
  approveReviewDecision,
  dismissReviewDecision,
  reopenReviewDecision,
  manualReassignZoomRecordFromFeed,
  findRelatedZoomRawRecords,
} from "../server/services/zoomReviewQueue";
import {
  rawCommunicationRecords,
  communicationClientLinks,
  agentMatchDecisions,
  type InsertClient,
  type InsertRawCommunication,
} from "@shared/schema";
import { users } from "@shared/models/auth";

const TAG = `t4050s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

function clientFixture(name: string): InsertClient {
  return {
    firmName: `${name} [${TAG}]`,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
  };
}

function rawZoomFixture(
  externalSourceId: string | null,
  subtype: string,
  title: string,
): InsertRawCommunication {
  return {
    sourceType: "zoom",
    sourceSubtype: subtype,
    title: `${title} [${TAG}]`,
    timestamp: new Date(),
    direction: "inbound",
    externalSourceId,
    // Deliberately < 100 chars so post-approve analysis never invokes AI.
    contentText: "(short)",
    contentPreview: "test",
    rawPayloadJson: { tag: TAG },
    participantsJson: [{ name: "External", email: `ext-${TAG}@client.example` }],
    matchStatus: "unmatched",
  };
}

async function fetchRaws(ids: string[]) {
  return getDb()
    .select()
    .from(rawCommunicationRecords)
    .where(inArray(rawCommunicationRecords.id, ids));
}

async function fetchLinks(recordIds: string[], clientId: string) {
  return getDb()
    .select()
    .from(communicationClientLinks)
    .where(
      and(
        inArray(communicationClientLinks.rawCommunicationRecordId, recordIds),
        eq(communicationClientLinks.clientId, clientId),
      ),
    );
}

async function run(): Promise<void> {
  await runInTxSandbox(async () => {
    // Migration 0149 restored a unique index on external_source_id, so NEW
    // duplicate-externalSourceId siblings can no longer form — but legacy
    // pre-0149 pairs are exactly what the sibling-stamping code defends
    // against. Drop the index INSIDE the sandbox tx (rolls back with it) to
    // seed that legacy shape, same pattern as the heatmap CHECK-constraint
    // suites.
    await getDb().execute(
      sql`DROP INDEX IF EXISTS raw_comm_external_source_id_unique_idx`,
    );

    const userId = `t4050-user-${TAG}`;
    await getDb().insert(users).values({ id: userId, email: `${TAG}@example.test` });

    const clientA = await storage.createClient(clientFixture("Sibling Stamp A"));
    const clientB = await storage.createClient(clientFixture("Sibling Stamp B"));
    // Task #4079: a third client whose stale link (from an old auto-match /
    // backfill) must be swept by every reassignment path.
    const clientC = await storage.createClient(clientFixture("Sibling Stamp C"));

    // Seeds a stale communication_client_links row for clientC on the given
    // record, simulating residue minted by an earlier flow before the record
    // was unmatched.
    async function seedStaleThirdClientLink(recordId: string): Promise<void> {
      await getDb().insert(communicationClientLinks).values({
        rawCommunicationRecordId: recordId,
        clientId: clientC.id,
        matchMethod: "auto",
        matchConfidence: 0.9,
        isPrimary: false,
        status: "detected",
      });
    }

    const EXT = `t4050-zoom-${TAG}`;
    const recording = await storage.createRawCommunication(
      rawZoomFixture(EXT, "recording", "Sibling meeting (recording)"),
    );
    const transcript = await storage.createRawCommunication(
      rawZoomFixture(EXT, "transcript", "Sibling meeting (transcript)"),
    );
    const bothIds = [recording.id, transcript.id];

    section("findRelatedZoomRawRecords");
    const related = await findRelatedZoomRawRecords(recording);
    assert(related.length === 2, `recording resolves both siblings (got ${related.length})`);
    assert(related[0].id === recording.id, "queried record comes first");

    const decision = await recordZoomReviewDecision({
      communicationId: recording.id,
      communicationType: "zoom_meeting",
      suggestedClientId: clientA.id,
      confidenceScore: 0.5,
      explanationSummary: `[${TAG}] seeded review`,
      reviewReason: "weak_signal_only",
      candidateShortlist: [{ clientId: clientA.id, confidenceScore: 0.5 }],
      evidenceType: "structured",
    });

    section("approveReviewDecision stamps siblings");
    const approveResult = await approveReviewDecision({ decisionId: decision.id, userId });
    assert(
      [...(approveResult.stampedRecordIds ?? [])].sort().join(",") === [...bothIds].sort().join(","),
      "approve returns BOTH stamped record ids",
    );
    let raws = await fetchRaws(bothIds);
    assert(
      raws.length === 2 && raws.every((r) => r.clientId === clientA.id),
      "both siblings stamped with the approved client",
    );
    assert(
      raws.every((r) => r.matchStatus === "matched" && r.matchMethod === "manual_review:approved"),
      "both siblings carry matched + manual_review:approved",
    );
    assert(
      (await fetchLinks(bothIds, clientA.id)).length === 2,
      "client links upserted for BOTH siblings",
    );

    section("reopenReviewDecision resets siblings");
    await reopenReviewDecision({ decisionId: decision.id, userId });
    raws = await fetchRaws(bothIds);
    assert(
      raws.every((r) => r.clientId === null && r.matchStatus === "unmatched" && r.matchMethod === "review_required"),
      "both siblings reset to review_required / unmatched",
    );

    section("approve with correction (reassign) swaps links on siblings");
    // Task #4079: plant a stale third-client link on a sibling — reassign
    // must sweep it, not just the prior decision's client.
    await seedStaleThirdClientLink(transcript.id);
    await approveReviewDecision({ decisionId: decision.id, userId, approvedClientId: clientB.id });
    raws = await fetchRaws(bothIds);
    assert(
      raws.every(
        (r) =>
          r.clientId === clientB.id &&
          r.matchMethod === `manual_review:reassigned:${clientA.id}`,
      ),
      "both siblings restamped to the corrected client with the prior client recorded",
    );
    assert(
      (await fetchLinks(bothIds, clientA.id)).length === 0,
      "prior client's links deleted on BOTH siblings",
    );
    assert(
      (await fetchLinks(bothIds, clientC.id)).length === 0,
      "stale third-client link swept by the reassign (Task #4079)",
    );
    assert(
      (await fetchLinks(bothIds, clientB.id)).length === 2,
      "corrected client's links present on BOTH siblings",
    );

    section("dismissReviewDecision clears siblings");
    await reopenReviewDecision({ decisionId: decision.id, userId });
    await dismissReviewDecision({ decisionId: decision.id, userId, reason: "not_relevant" });
    raws = await fetchRaws(bothIds);
    assert(
      raws.every((r) => r.clientId === null && (r.matchMethod ?? "").startsWith("dismissed")),
      "both siblings cleared and marked dismissed",
    );
    assert(
      (await fetchLinks(bothIds, clientB.id)).length === 0,
      "links removed from BOTH siblings on dismiss",
    );

    section("manualReassignZoomRecordFromFeed (feed PATCH path)");
    // Legacy-key coverage: this open decision is keyed by externalSourceId.
    const decision2 = await recordZoomReviewDecision({
      communicationId: EXT,
      communicationType: "zoom_meeting",
      suggestedClientId: clientB.id,
      confidenceScore: 0.4,
      explanationSummary: `[${TAG}] ext-keyed review`,
      reviewReason: "weak_signal_only",
      candidateShortlist: [{ clientId: clientB.id, confidenceScore: 0.4 }],
      evidenceType: "structured",
    });

    // Task #4079: stale third-client link on the other sibling — the feed
    // reassign must sweep it too.
    await seedStaleThirdClientLink(recording.id);
    const reassign = await manualReassignZoomRecordFromFeed({
      recordId: transcript.id,
      clientId: clientA.id,
      userId,
    });
    assert(reassign !== null, "feed reassign accepts a zoom record");
    assert(
      [...(reassign?.stampedRecordIds ?? [])].sort().join(",") === [...bothIds].sort().join(","),
      "feed reassign stamps BOTH siblings",
    );
    raws = await fetchRaws(bothIds);
    assert(
      raws.every((r) => r.clientId === clientA.id && r.matchStatus === "matched" && r.matchMethod === "manual"),
      "both siblings matched manually via the feed path",
    );
    assert(
      (reassign?.resolvedDecisionIds ?? []).includes(decision2.id),
      "open decision keyed by externalSourceId resolved by the feed reassign",
    );
    const [d2] = await getDb()
      .select()
      .from(agentMatchDecisions)
      .where(eq(agentMatchDecisions.id, decision2.id));
    assert(
      d2?.reviewResolution === "reassigned" &&
        d2?.correctedToClientId === clientA.id &&
        d2?.reviewedByUserId === userId,
      "resolved decision records reassigned + corrected client + reviewer",
    );
    assert(
      (await fetchLinks(bothIds, clientA.id)).length === 2,
      "feed reassign upserts links for BOTH siblings",
    );
    assert(
      (await fetchLinks(bothIds, clientC.id)).length === 0,
      "stale third-client link swept by the feed reassign (Task #4079)",
    );

    section("feed clear (clientId=null)");
    const cleared = await manualReassignZoomRecordFromFeed({
      recordId: recording.id,
      clientId: null,
      userId,
    });
    assert(cleared !== null, "feed clear accepts the record");
    raws = await fetchRaws(bothIds);
    assert(
      raws.every((r) => r.clientId === null && r.matchStatus === "unmatched"),
      "feed clear unstamps BOTH siblings",
    );
    assert(
      (await fetchLinks(bothIds, clientA.id)).length === 0,
      "feed clear deletes links on BOTH siblings",
    );

    section("NULL externalSourceId never cross-stamps");
    const solo1 = await storage.createRawCommunication(
      rawZoomFixture(null, "recording", "Solo record one"),
    );
    const solo2 = await storage.createRawCommunication(
      rawZoomFixture(null, "recording", "Solo record two"),
    );
    const soloReassign = await manualReassignZoomRecordFromFeed({
      recordId: solo1.id,
      clientId: clientA.id,
      userId,
    });
    assert(
      (soloReassign?.stampedRecordIds ?? []).join(",") === solo1.id,
      "NULL-externalSourceId reassign stamps ONLY the requested record",
    );
    const [solo2After] = await fetchRaws([solo2.id]);
    assert(
      solo2After?.clientId === null,
      "the other NULL-externalSourceId record is untouched",
    );

    section("non-zoom refusal");
    const frontRecord = await storage.createRawCommunication({
      ...rawZoomFixture(`front-${TAG}`, "email", "Front record"),
      sourceType: "front",
    });
    assert(
      (await manualReassignZoomRecordFromFeed({
        recordId: frontRecord.id,
        clientId: clientA.id,
        userId,
      })) === null,
      "non-zoom records are refused with null",
    );
    assert(
      (await manualReassignZoomRecordFromFeed({
        recordId: "00000000-0000-0000-0000-000000000000",
        clientId: clientA.id,
        userId,
      })) === null,
      "missing record id refused with null",
    );
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
}

run()
  .catch((err) => {
    console.error("FATAL:", err);
    failed++;
  })
  .finally(() => {
    process.exit(failed > 0 ? 1 : 0);
  });
