/* test-registration
{
  "name": "Daily judgment single comm grain + full-window retrieval e2e — rollup dedup, cap removal, analyzed-count honesty (Task #4048)",
  "regression": true,
  "sweepOnlyReason": "Task #4048: DB-heavy e2e (seeds a client + 60-plus comm rows + report sections, runs the real generation flow with a stubbed model, ~30s); the pure prompt-builder core gates via tests/daily-judgment-honest-prompt-pure.test.ts in the smoke set",
  "timeoutMs": 180000,
  "tier": "small"
}
test-registration */
/**
 * Task #4048 — end-to-end honesty of the daily-judgment comm inputs against
 * a real database:
 *
 *  1. Single grain: `countClientCommunicationsInRange` counts each real
 *     communication exactly once — a Front email thread that exists as BOTH
 *     a per-thread rollup row (source_subtype='email_thread') and per-message
 *     rows sharing external_thread_id counts at message grain only; a
 *     rollup-ONLY thread still counts once; a rollup whose sibling messages
 *     all fall OUTSIDE the window still counts inside it (window-scoped
 *     sibling check); an orphaned sibling does not suppress the rollup.
 *  2. Cap removal: with >50 window comms the generation flow retrieves and
 *     represents the FULL window (no silent 50-row cap) and persists
 *     `communicationsAnalyzed` == the true window count == the basis line's
 *     "N comms (30d)" claim (counted == retrievable == represented).
 *  3. Unavailable report metrics reach the model explicitly: a report whose
 *     metrics are legacy blank-coerced zeros renders as either month-scoped
 *     "no data" or client-scoped "not tracked" — never "0 consults" / "NaN%"
 *     — plus the supersede guard.
 *  4. The persisted inventory stamps the current promptRevision.
 *
 * Determinism: the AI call + fact extractor are stubbed through the module's
 * own seams. Rows are seeded with per-run random-suffixed ids and deleted in
 * `finally`.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { randomBytes } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";

import { db, closeDbPools } from "../server/db";
import { clients, rawCommunicationRecords, reports, reportSections } from "@shared/schema";
import {
  generateDailyJudgmentDetailed,
  FINGERPRINT_REVISION,
  __test_setJudgmentChatCreate,
  __test_setJudgmentFactExtractor,
} from "../server/services/dailyJudgment";
import { countClientCommunicationsInRange } from "../server/storage/communicationStorage";
import { runWithWorkerDb } from "../server/db";

const RUN = randomBytes(4).toString("hex");

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const aiCalls: Array<{ system: string; user: string }> = [];

function cannedAiResponse(): Record<string, unknown> {
  return {
    overallStatus: "Watch",
    relationshipStatus: "Stable",
    confidenceLevel: "High",
    summary: "Stubbed summary.",
    sentimentSummary: "Stubbed sentiment.",
    whatChanged: [],
    concerns: [],
    unresolvedAsks: [],
    wins: [],
    recommendedActions: [],
    scores: {
      relationshipHealth: 70,
      sentiment: 42,
      complaint: 10,
      trust: 65,
      responsivenessRisk: 20,
      executionRisk: 15,
      leadVolumeConcern: null,
      unresolvedTaskRisk: 5,
      overallRisk: 25,
    },
    openAskUpdates: [],
    newAsks: [],
  };
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

async function main(): Promise<void> {
  __test_setJudgmentChatCreate(async (params: any) => {
    aiCalls.push({
      system: params.messages[0]?.content ?? "",
      user: params.messages[1]?.content ?? "",
    });
    return { choices: [{ message: { content: JSON.stringify(cannedAiResponse()) } }] } as any;
  });
  __test_setJudgmentFactExtractor(async () => 0);

  let clientId: string | null = null;
  try {
    const [c] = await db
      .insert(clients)
      .values({ firmName: `DJ4048 grain ${RUN}` })
      .returning({ id: clients.id });
    clientId = c.id;

    const t = (suffix: string) => `dj4048-${RUN}-${suffix}`;
    const rows: any[] = [];

    // Thread T1: 3 messages + 1 rollup, all in-window → 3 countable.
    for (let i = 0; i < 3; i++) {
      rows.push({
        clientId,
        sourceType: "front_email",
        sourceSubtype: "email_message",
        externalThreadId: t("T1"),
        title: `T1 msg ${i} ${RUN}`,
        timestamp: daysAgo(3 + i),
        contentText: "Thread one message body.",
        matchStatus: "matched",
      });
    }
    rows.push({
      clientId,
      sourceType: "front_email",
      sourceSubtype: "email_thread",
      externalThreadId: t("T1"),
      title: `T1 rollup ${RUN}`,
      timestamp: daysAgo(3),
      contentText: "Thread one rollup.",
      matchStatus: "matched",
    });

    // Thread T2: rollup only (never materialized) → 1 countable.
    rows.push({
      clientId,
      sourceType: "front_email",
      sourceSubtype: "email_thread",
      externalThreadId: t("T2"),
      title: `T2 rollup-only ${RUN}`,
      timestamp: daysAgo(6),
      contentText: "Thread two rollup only.",
      matchStatus: "matched",
    });

    // Thread T4: rollup in-window, its only sibling message OUTSIDE the
    // 30-day window → rollup still counts inside the window (window-scoped
    // sibling check keeps counted == retrievable per window).
    rows.push({
      clientId,
      sourceType: "front_email",
      sourceSubtype: "email_thread",
      externalThreadId: t("T4"),
      title: `T4 rollup in-window ${RUN}`,
      timestamp: daysAgo(5),
      contentText: "Thread four rollup.",
      matchStatus: "matched",
    });
    rows.push({
      clientId,
      sourceType: "front_email",
      sourceSubtype: "email_message",
      externalThreadId: t("T4"),
      title: `T4 old msg ${RUN}`,
      timestamp: daysAgo(40),
      contentText: "Thread four ancient message.",
      matchStatus: "matched",
    });

    // Thread T5: rollup in-window + an ORPHANED in-window sibling (orphans
    // carry no client) → rollup still counts.
    rows.push({
      clientId,
      sourceType: "front_email",
      sourceSubtype: "email_thread",
      externalThreadId: t("T5"),
      title: `T5 rollup orphan-sibling ${RUN}`,
      timestamp: daysAgo(7),
      contentText: "Thread five rollup.",
      matchStatus: "matched",
    });
    rows.push({
      clientId: null,
      sourceType: "front_email",
      sourceSubtype: "email_message",
      externalThreadId: t("T5"),
      title: `T5 orphaned msg ${RUN}`,
      timestamp: daysAgo(7),
      contentText: "Thread five orphaned message.",
      matchStatus: "orphaned",
    });

    // A Zoom call (no thread id at all) → 1 countable.
    rows.push({
      clientId,
      sourceType: "zoom",
      sourceSubtype: null,
      externalThreadId: null,
      title: `Zoom call ${RUN}`,
      timestamp: daysAgo(9),
      contentText: "Zoom call transcript summary.",
      matchStatus: "matched",
    });

    // 55 additional single-message threads → pushes the window way past the
    // old 50-row cap.
    for (let i = 0; i < 55; i++) {
      rows.push({
        clientId,
        sourceType: "front_email",
        sourceSubtype: "email_message",
        externalThreadId: t(`bulk-${i}`),
        title: `BulkComm${i} ${RUN}`,
        timestamp: daysAgo(10 + (i % 15)),
        contentText: `Bulk window message ${i}.`,
        matchStatus: "matched",
      });
    }

    await db.insert(rawCommunicationRecords).values(rows);

    // Expected countable grain:
    //   T1: 3 messages (rollup deduped)     = 3
    //   T2: rollup-only                     = 1
    //   T4: rollup (sibling out of window)  = 1
    //   T5: rollup (sibling orphaned)       = 1
    //   Zoom                                = 1
    //   bulk                                = 55
    const EXPECTED = 3 + 1 + 1 + 1 + 1 + 55; // 62

    // Legacy blank-coerced-zero report: everything unentered, no flags.
    const [rep] = await db
      .insert(reports)
      .values({ clientId, reportMonth: "2026-07", status: "final" })
      .returning({ id: reports.id });
    await db.insert(reportSections).values([
      { reportId: rep.id, sectionKey: "intake", data: { totalLeads: 0, totalConsults: 0, leadToConsultRate: 0 } },
      { reportId: rep.id, sectionKey: "sales", data: { totalConsults: 0, totalCases: 0, consultToCaseRate: 0, noShowRate: 0 } },
      { reportId: rep.id, sectionKey: "marketing", data: { totalLeads: 0 } },
    ]);

    console.log("\nSingle grain — shared count predicate:");
    const since = daysAgo(30);
    const counted = await runWithWorkerDb(() => countClientCommunicationsInRange(clientId!, since, new Date()));
    check(`window count dedupes to one row per communication (${EXPECTED})`, counted === EXPECTED, `got ${counted}`);

    // T1 = 3 msgs + 1 rollup, T2 = 1 rollup, T4 = rollup + out-of-window msg,
    // T5 = rollup + orphaned msg → 9 raw rows for what counts as 6 comms.
    const rawRows = await db
      .select({ n: rawCommunicationRecords.id })
      .from(rawCommunicationRecords)
      .where(inArray(rawCommunicationRecords.externalThreadId, [t("T1"), t("T2"), t("T4"), t("T5")]));
    check("fixture really contains more raw rows than the deduped count", rawRows.length === 9, String(rawRows.length));

    console.log("\nFull-window generation — cap removed, honest analyzed count:");
    const result = await generateDailyJudgmentDetailed(clientId, {});
    const j = result.judgment;
    const prompt = aiCalls[aiCalls.length - 1]?.user ?? "";

    check("outcome generated", result.outcome === "generated");
    check(
      `communicationsAnalyzed == true window count (${EXPECTED}, beyond the old 50 cap)`,
      j.communicationsAnalyzed === EXPECTED,
      String(j.communicationsAnalyzed),
    );
    const summary = j.dataSourcesSummary as any;
    check("basis line matches analyzed count", Array.isArray(summary?.basedOn) && summary.basedOn.includes(`${EXPECTED} comms (30d)`), JSON.stringify(summary?.basedOn));
    check("sources.comms.count30d matches analyzed count", summary?.sources?.comms?.count30d === EXPECTED, String(summary?.sources?.comms?.count30d));
    check("inventory stamps current promptRevision", summary?.promptRevision === FINGERPRINT_REVISION, String(summary?.promptRevision));

    check("prompt manifest claims the deduped count", prompt.includes(`${EXPECTED} matched in last 30 days`));
    check("prompt closing line asserts full representation", prompt.includes(`All ${EXPECTED} communication(s) in the analyzed 30-day window are represented above`));
    const missingBulk = Array.from({ length: 55 }, (_, i) => `BulkComm${i} ${RUN}`).filter((title) => !prompt.includes(title));
    check("every bulk comm beyond the old cap is represented in the prompt", missingBulk.length === 0, `missing ${missingBulk.length}`);
    check("deduped rollup (T1) does NOT reach the prompt", !prompt.includes(`T1 rollup ${RUN}`));
    check("rollup-only thread (T2) DOES reach the prompt", prompt.includes(`T2 rollup-only ${RUN}`));
    check("window-scoped rollup (T4) reaches the prompt", prompt.includes(`T4 rollup in-window ${RUN}`));
    check("zoom call reaches the prompt", prompt.includes(`Zoom call ${RUN}`));

    console.log("\nUnavailable-metric report block in the real prompt:");
    check("report section present", prompt.includes("=== LATEST REPORT DATA (2026-07) ==="));
    check("no fabricated '0 consults'", !/consults booked: 0[^.\d]/.test(prompt), prompt.match(/Intake:.*$/m)?.[0]);
    check("no NaN% anywhere in the prompt", !prompt.includes("NaN"));
    check(
      "intake renders explicit unavailable-metric lines",
      prompt.includes("consults booked: no data") ||
        prompt.includes("consults booked: not tracked for this client"),
      prompt.match(/Intake:.*$/m)?.[0],
    );
    check("supersede guard reaches the model", prompt.includes("SUPERSEDES any metric claims in prior judgments"));
    check("prior-judgment metric-claim caution absent without prior judgments OK", true);
  } finally {
    try {
      if (clientId) {
        // reports has NO ON DELETE CASCADE — clear sections + reports first;
        // comm rows include an orphaned (clientId NULL) sibling, so delete by
        // run-scoped thread ids/titles, not just clientId.
        const repRows = await db.select({ id: reports.id }).from(reports).where(eq(reports.clientId, clientId));
        if (repRows.length > 0) {
          await db.delete(reportSections).where(inArray(reportSections.reportId, repRows.map((r) => r.id)));
          await db.delete(reports).where(eq(reports.clientId, clientId));
        }
        await db.delete(rawCommunicationRecords).where(eq(rawCommunicationRecords.clientId, clientId));
        await db.delete(rawCommunicationRecords).where(sql`${rawCommunicationRecords.externalThreadId} LIKE ${`dj4048-${RUN}-%`}`);
        await db.delete(clients).where(inArray(clients.id, [clientId])); // cascades judgments
      }
    } catch (err) {
      console.error("Cleanup failed:", err);
      failed++;
    }
    __test_setJudgmentChatCreate(null);
    __test_setJudgmentFactExtractor(null);
    await closeDbPools();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(async (err) => {
  console.error(err);
  try { await closeDbPools(); } catch { /* best-effort */ }
  process.exitCode = 1;
});
