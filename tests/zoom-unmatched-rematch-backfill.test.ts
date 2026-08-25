/* test-registration
{
  "name": "Zoom unmatched re-match backfill (Task #4050)",
  "smoke": true,
  "smokeReason": "Fixture-scoped DB test: the unmatched re-match prod action's dry-run-by-default contract, per-disposition writes, dismissed/matched/old exclusions, count-estimate lockstep, and convergence.",
  "tier": "small"
}
test-registration */
/**
 * Task #4050 — convergent re-match backfill over the unmatched Zoom backlog.
 *
 * Against the live DB inside a transactional sandbox:
 *   1. Cohort per disposition: trusted-domain auto, topic auto (host-only
 *      participants — the dominant production shape), ambiguous-domain
 *      review demotion, no-candidate review row.
 *   2. Exclusions never scanned: operator-dismissed, already matched,
 *      out-of-window, NULL matchStatus.
 *   3. dryRun (the DEFAULT) counts dispositions but writes nothing.
 *   4. Real run stamps records + links, supersedes open decisions
 *      (superseded_auto_match), enqueues analyze_communication, writes
 *      review sentinels + suggestion rows.
 *   5. Second real run converges: autoMatched=0, no new review rows, the
 *      ambiguous sentinel counts as unchanged.
 *
 * Assertions are scoped to fixture rows (re-read by id); global report
 * counters only use >= or convergence-safe equalities, so ambient rows
 * committed by earlier suites in the same run can never flip a verdict.
 */

import { and, eq, inArray } from "drizzle-orm";
import { runInTxSandbox } from "./db-sandbox";
import { storage } from "../server/storage";
import { getDb } from "../server/db";
import {
  runZoomUnmatchedRematchBackfill,
  countZoomUnmatchedRematchCandidates,
  formatZoomUnmatchedRematchReport,
  BACKFILL_EXPLANATION_PREFIX,
} from "../server/services/zoomReviewQueueBackfill";
import { recordZoomReviewDecision } from "../server/services/zoomReviewQueue";
import {
  rawCommunicationRecords,
  communicationClientLinks,
  agentMatchDecisions,
  type InsertClient,
  type InsertRawCommunication,
} from "@shared/schema";
import { workQueue } from "@shared/models/workQueue";

// Alphanumeric-only so firm-name tokens survive topic normalization intact.
const RUN_ID = `t4050b${Math.random().toString(36).replace(/[^a-z0-9]/g, "").slice(0, 8)}`;

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

function clientFixture(name: string, emailDomains: string[] = []): InsertClient {
  return {
    firmName: name,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    emailDomains,
  } as InsertClient;
}

function zoomFixture(opts: {
  title: string;
  participants: Array<{ email?: string; name?: string }>;
  daysAgo?: number;
  matchStatus?: string | null;
  matchMethod?: string | null;
  clientId?: string | null;
  subtype?: string;
}): InsertRawCommunication {
  const fixture: Record<string, unknown> = {
    sourceType: "zoom",
    sourceSubtype: opts.subtype ?? "transcript",
    title: opts.title,
    timestamp: new Date(Date.now() - (opts.daysAgo ?? 5) * 24 * 60 * 60 * 1000),
    direction: "inbound",
    externalSourceId: `${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`,
    contentText: "(short)",
    contentPreview: "backfill fixture",
    rawPayloadJson: { tag: RUN_ID },
    participantsJson: opts.participants,
  };
  if (opts.matchStatus !== undefined) fixture.matchStatus = opts.matchStatus;
  if (opts.matchMethod !== undefined) fixture.matchMethod = opts.matchMethod;
  if (opts.clientId !== undefined) fixture.clientId = opts.clientId;
  return fixture as InsertRawCommunication;
}

async function reload(id: string) {
  const [row] = await getDb()
    .select()
    .from(rawCommunicationRecords)
    .where(eq(rawCommunicationRecords.id, id));
  return row;
}

async function decisionsFor(keys: string[]) {
  return getDb()
    .select()
    .from(agentMatchDecisions)
    .where(inArray(agentMatchDecisions.communicationId, keys));
}

async function run(): Promise<void> {
  await runInTxSandbox(async () => {
    section("seed cohort");
    const domainHost = `${RUN_ID}dom.example`;
    const sharedHost = `${RUN_ID}shared.example`;
    const clientDomain = await storage.createClient(
      clientFixture(`Domainward Fixture Firm ${RUN_ID}`, [domainHost]),
    );
    const clientTopic = await storage.createClient(
      clientFixture(`Vexlartopic${RUN_ID} Law Group`),
    );
    const clientShared1 = await storage.createClient(
      clientFixture(`Shared One ${RUN_ID} LLC`, [sharedHost]),
    );
    const clientShared2 = await storage.createClient(
      clientFixture(`Shared Two ${RUN_ID} LLC`, [sharedHost]),
    );

    // Disposition fixtures (candidates).
    const rDomain = await storage.createRawCommunication(
      zoomFixture({
        title: `External sync ${RUN_ID}`,
        participants: [{ email: `sarah@${domainHost}`, name: "Sarah Client" }],
        matchStatus: "unmatched",
      }),
    );
    const rTopic = await storage.createRawCommunication(
      zoomFixture({
        title: `NoBull Marketing <> Vexlartopic${RUN_ID} Law Group`,
        // Host-only participant list — the dominant unmatched shape in prod.
        participants: [{ email: "host@nobullmarketing.com", name: "NoBull Host" }],
        matchStatus: "unmatched",
      }),
    );
    const rAmbig = await storage.createRawCommunication(
      zoomFixture({
        title: `Quarterly review ${RUN_ID}`,
        participants: [{ email: `bob@${sharedHost}`, name: "Bob Shared" }],
        matchStatus: "unmatched",
      }),
    );
    const rNone = await storage.createRawCommunication(
      zoomFixture({
        title: `zzz nothing burger ${RUN_ID}`,
        participants: [{ email: `stranger@nowhere${RUN_ID}.example` }],
        matchStatus: "unmatched",
      }),
    );

    // Exclusion fixtures — all would auto-match on the domain tier if the
    // predicate ever leaked them into the scan.
    const matchableParticipants = [{ email: `sarah@${domainHost}`, name: "Sarah Client" }];
    const rDismissed = await storage.createRawCommunication(
      zoomFixture({
        title: `Dismissed ${RUN_ID}`,
        participants: matchableParticipants,
        matchStatus: "unmatched",
        matchMethod: "dismissed:not_client_call",
      }),
    );
    const rMatched = await storage.createRawCommunication(
      zoomFixture({
        title: `Already matched ${RUN_ID}`,
        participants: matchableParticipants,
        matchStatus: "matched",
        clientId: clientDomain.id,
        matchMethod: "participant_email:existing",
      }),
    );
    const rOld = await storage.createRawCommunication(
      zoomFixture({
        title: `Ancient ${RUN_ID}`,
        participants: matchableParticipants,
        matchStatus: "unmatched",
        daysAgo: 100,
      }),
    );
    const rNullStatus = await storage.createRawCommunication(
      zoomFixture({
        title: `Null status ${RUN_ID}`,
        participants: matchableParticipants,
        // matchStatus omitted → NULL (excluded by the exact-'unmatched' predicate)
      }),
    );
    const [nullStatusRow] = await getDb()
      .select({ matchStatus: rawCommunicationRecords.matchStatus })
      .from(rawCommunicationRecords)
      .where(eq(rawCommunicationRecords.id, rNullStatus.id));
    assert(nullStatusRow?.matchStatus == null, "NULL-matchStatus fixture really is NULL");

    // Pre-existing OPEN review decision on the domain-auto record — the
    // backfill must supersede it instead of leaving a stale queue item.
    const preDecision = await recordZoomReviewDecision({
      communicationId: rDomain.id,
      communicationType: "zoom",
      suggestedClientId: clientDomain.id,
      confidenceScore: 0.4,
      explanationSummary: `[${RUN_ID}] pre-existing review`,
      reviewReason: "weak_signal_only",
      candidateShortlist: [{ clientId: clientDomain.id, confidenceScore: 0.4 }],
      evidenceType: "structured",
    });

    const countBefore = await countZoomUnmatchedRematchCandidates(90);
    assert(countBefore >= 4, `candidate count sees the 4 cohort rows (got ${countBefore})`);

    section("dryRun is the default and writes nothing");
    const dry = await runZoomUnmatchedRematchBackfill({ windowDays: 90 });
    assert(dry.dryRun === true, "omitting dryRun defaults to a dry run");
    assert(dry.scanned >= 4, `dry run scanned the cohort (got ${dry.scanned})`);
    assert(dry.autoMatched >= 2, `dry run counted prospective autos (got ${dry.autoMatched})`);
    let row = await reload(rDomain.id);
    assert(row?.clientId === null, "dry run did NOT stamp the domain-auto record");
    row = await reload(rAmbig.id);
    assert(row?.matchMethod == null, "dry run did NOT write the review sentinel");
    let ds = await decisionsFor([preDecision.communicationId]);
    assert(
      ds.length === 1 && ds[0].status === "review_required",
      "dry run did NOT supersede the open decision",
    );
    ds = await decisionsFor([rNone.id]);
    assert(ds.length === 0, "dry run did NOT create a no-candidate review row");

    // Task #4083: plant a STALE other-client link on the domain-auto record
    // (residue from a hypothetical earlier different-client match). The
    // auto-match stamp must sweep it — Zoom never deliberately multi-client-
    // tags a record, and a surviving stale link double-counts the call.
    await getDb().insert(communicationClientLinks).values({
      rawCommunicationRecordId: rDomain.id,
      clientId: clientTopic.id,
      matchMethod: "participant_email:stale-residue",
      matchConfidence: 0.9,
      isPrimary: true,
      status: "detected",
    });

    section("real run: dispositions");
    const report = await runZoomUnmatchedRematchBackfill({ windowDays: 90, dryRun: false });
    assert(report.dryRun === false, "real run reports dryRun=false");
    assert(report.errors.length === 0, `real run had no per-record errors (got ${JSON.stringify(report.errors)})`);
    assert(report.autoMatched >= 2, `real run auto-matched the two autos (got ${report.autoMatched})`);
    assert(
      (report.byTier["trusted_domain"] ?? 0) >= 1 && (report.byTier["topic_firm_name"] ?? 0) >= 1,
      `byTier credits both new tiers (got ${JSON.stringify(report.byTier)})`,
    );

    // Domain auto.
    row = await reload(rDomain.id);
    assert(row?.clientId === clientDomain.id, "domain record stamped with the trusted-domain client");
    assert(
      row?.matchStatus === "matched" && row?.matchMethod === `trusted_domain:${domainHost}`,
      `domain record carries matched + trusted_domain matchMethod (got ${row?.matchMethod})`,
    );
    assert(row?.processingStatus === "pending", "domain record queued for analysis (processingStatus=pending)");
    const domainLinks = await getDb()
      .select()
      .from(communicationClientLinks)
      .where(
        and(
          eq(communicationClientLinks.rawCommunicationRecordId, rDomain.id),
          eq(communicationClientLinks.clientId, clientDomain.id),
        ),
      );
    assert(domainLinks.length === 1, "client link upserted for the domain auto-match");
    // Task #4083: the stale other-client link was swept by the auto-match.
    const allDomainLinks = await getDb()
      .select()
      .from(communicationClientLinks)
      .where(eq(communicationClientLinks.rawCommunicationRecordId, rDomain.id));
    assert(
      allDomainLinks.length === 1 && allDomainLinks[0].clientId === clientDomain.id,
      `stale other-client link swept by the auto-match (Task #4083) — got ${allDomainLinks.map((l) => l.clientId).join(",")}`,
    );
    ds = await decisionsFor([rDomain.id]);
    assert(
      ds.length === 1 && ds[0].status === "superseded_auto_match",
      `open decision superseded by the auto-match (got ${ds[0]?.status})`,
    );
    assert(report.supersededDecisions >= 1, "report counts the superseded decision");
    const wq = await getDb()
      .select({ id: workQueue.id })
      .from(workQueue)
      .where(eq(workQueue.dedupeKey, `analyze_${rDomain.id}`));
    assert(wq.length === 1, "analyze_communication job enqueued for the auto-match");

    // Topic auto (host-only participants — the all-internal exemption).
    row = await reload(rTopic.id);
    assert(
      row?.clientId === clientTopic.id && row?.matchStatus === "matched",
      "host-only record auto-matched via the topic tier",
    );
    assert(
      (row?.matchMethod ?? "").startsWith("topic_firm_name:"),
      `topic record matchMethod names the tier (got ${row?.matchMethod})`,
    );

    // Ambiguous domain → review with sentinel + suggestion row.
    row = await reload(rAmbig.id);
    assert(row?.clientId === null, "ambiguous record NOT auto-matched");
    assert(
      (row?.matchMethod ?? "").startsWith("review_required:ambiguous_trusted_domain"),
      `ambiguous record carries the review sentinel (got ${row?.matchMethod})`,
    );
    ds = await decisionsFor([rAmbig.id]);
    assert(ds.length === 1, "ambiguous record got exactly one review decision");
    assert(
      ds[0]?.reviewReason === "ambiguous_trusted_domain" &&
        Array.isArray(ds[0]?.candidateShortlistJson) &&
        (ds[0]?.candidateShortlistJson as unknown[]).length === 2,
      "review decision stores the two-candidate shortlist",
    );
    assert(
      (ds[0]?.explanationSummary ?? "").startsWith(BACKFILL_EXPLANATION_PREFIX),
      "review decision explanation carries the backfill prefix",
    );

    // No candidate → review row so the record surfaces at all.
    ds = await decisionsFor([rNone.id]);
    assert(
      ds.length === 1 && ds[0].clientId === null && ds[0].status === "review_required",
      "no-candidate record got a null-client review row",
    );
    assert(report.noCandidateRowsCreated >= 1, "report counts the created no-candidate row");

    section("exclusions untouched");
    row = await reload(rDismissed.id);
    assert(
      row?.clientId === null && row?.matchMethod === "dismissed:not_client_call",
      "operator-dismissed record never rescanned",
    );
    row = await reload(rMatched.id);
    assert(
      row?.clientId === clientDomain.id && row?.matchMethod === "participant_email:existing",
      "already-matched record untouched",
    );
    row = await reload(rOld.id);
    assert(row?.clientId === null && row?.matchMethod == null, "out-of-window record untouched");
    row = await reload(rNullStatus.id);
    assert(row?.clientId === null && row?.matchMethod == null, "NULL-matchStatus record untouched");
    assert(
      (await decisionsFor([rDismissed.id, rMatched.id, rOld.id, rNullStatus.id])).length === 0,
      "no review rows created for excluded records",
    );

    section("candidate count reflects the claims");
    const countAfter = await countZoomUnmatchedRematchCandidates(90);
    assert(
      countBefore - countAfter === report.autoMatched,
      `count shrank by exactly autoMatched (${countBefore} - ${countAfter} vs ${report.autoMatched})`,
    );

    section("second real run converges");
    const report2 = await runZoomUnmatchedRematchBackfill({ windowDays: 90, dryRun: false });
    assert(report2.autoMatched === 0, `nothing left to auto-match (got ${report2.autoMatched})`);
    assert(report2.supersededDecisions === 0, "no decisions superseded on re-run");
    assert(report2.noCandidateRowsCreated === 0, "no duplicate no-candidate rows on re-run");
    assert(report2.unchangedSentinels >= 1, "ambiguous sentinel recognized as unchanged on re-run");
    assert(report2.errors.length === 0, "re-run had no errors");
    ds = await decisionsFor([rAmbig.id]);
    assert(ds.length === 1, "re-run did not stack a second decision on the ambiguous record");
    ds = await decisionsFor([rNone.id]);
    assert(ds.length === 1, "re-run did not stack a second no-candidate row");

    section("report formatting");
    const formatted = formatZoomUnmatchedRematchReport(report);
    assert(
      typeof formatted === "string" && formatted.includes("auto-matched") && formatted.includes(String(report.autoMatched)),
      "formatted report includes the auto-match tally",
    );
    assert(
      formatZoomUnmatchedRematchReport(dry).includes("dry-run"),
      "formatted dry report is labeled dry-run",
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
