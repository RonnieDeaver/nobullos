/* test-registration
{
  "name": "Fabricated-zero knowledge extraction guard — never-tracked suppression, tracked passthrough, no resurrection of deactivated rows (Task #4846)",
  "regression": true,
  "sweepOnlyReason": "Task #4846: DB integration of the extraction guard (seeds clients/reports/sections/knowledge rows, exercises the real persist path incl. the resurrection-on-upsert hazard); the pure predicate/classifier core gates via tests/judgment-metric-tracking-pure.test.ts",
  "timeoutMs": 120000,
  "tier": "small"
}
test-registration */
/**
 * Task #4846 — the extraction guard in extractAndPersistFromAgentOutput,
 * against the real database and the real bulkUpsertAgentKnowledge path:
 *
 *  1. Never-tracked client (every intake/sales month No-Data-flagged):
 *     judgment output asserting zero intake/sales outcomes is NOT persisted;
 *     healthy facts from the same output ARE.
 *  2. Resurrection hazard: the KB upsert flips is_active=true on exact-text
 *     match — a deactivated poisoned row must STAY inactive when the same
 *     text re-appears in judgment output (this is what makes the hygiene
 *     drain durable).
 *  3. Tracked client: the same zero-claim vocabulary persists untouched —
 *     for a client that tracks the family, a zero may be a real measurement.
 *  4. The gate is daily_judgment-only: communication_analysis output with
 *     matching vocabulary persists (its facts describe comm content, and
 *     the drain/guard scope is the judgment loop).
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

import { db, closeDbPools } from "../server/db";
import { clients, reports, reportSections, agentKnowledgeBase } from "@shared/schema";
import { extractAndPersistFromAgentOutput } from "../server/services/agentKnowledgeService";
import { getClientMetricTracking } from "../server/services/judgmentMetricTracking";

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

const FLAGGED_INTAKE = { totalConsults: 0, leadToConsultRate: 0, noDataFlags: { totalConsults: true } };
const FLAGGED_SALES = {
  totalConsults: 0,
  totalCases: 0,
  consultToCaseRate: 0,
  noDataFlags: { totalConsults: true, totalCases: true },
};
const ENTERED_INTAKE = { totalConsults: 6, leadToConsultRate: 25, noDataFlags: {} };
const ENTERED_SALES = { totalConsults: 5, totalCases: 2, consultToCaseRate: 40, noDataFlags: {} };

// Exact poisoned shape from the prod corpus (U+2011 non-breaking hyphen in
// "non‑defensive" — read from the prod replica 2026-08-17).
const POISONED_CONCERN = `Clear, non\u2011defensive explanation of how 98 May leads produced 0 intakes is still owed (${RUN})`;
const POISONED_ASK = `explain the zero-consult/poor-conversion outcome for July (${RUN})`;
const HEALTHY_CONCERN = `Owner asked for a revised GBP review-campaign plan and has not received it (${RUN})`;

async function seedClient(label: string): Promise<string> {
  const [c] = await db
    .insert(clients)
    .values({ firmName: `FZG4846 ${label} ${RUN}` } as any)
    .returning({ id: clients.id });
  return c.id;
}

async function seedReportMonth(
  clientId: string,
  month: string,
  intake: Record<string, unknown>,
  sales: Record<string, unknown>,
): Promise<void> {
  const [r] = await db
    .insert(reports)
    .values({ clientId, reportMonth: month, status: "final" } as any)
    .returning({ id: reports.id });
  await db.insert(reportSections).values([
    { reportId: r.id, sectionKey: "intake", data: intake },
    { reportId: r.id, sectionKey: "sales", data: sales },
  ] as any);
}

async function activeFactTexts(clientId: string): Promise<string[]> {
  const rows = await db
    .select({ text: agentKnowledgeBase.factText })
    .from(agentKnowledgeBase)
    .where(and(eq(agentKnowledgeBase.clientId, clientId), eq(agentKnowledgeBase.isActive, true)));
  return rows.map((r) => r.text);
}

async function main(): Promise<void> {
  const createdClients: string[] = [];

  try {
    // ── never-tracked client ────────────────────────────────────────────────
    const neverClient = await seedClient("never-tracked");
    createdClients.push(neverClient);
    await seedReportMonth(neverClient, "2026-06", FLAGGED_INTAKE, FLAGGED_SALES);
    await seedReportMonth(neverClient, "2026-07", FLAGGED_INTAKE, FLAGGED_SALES);

    console.log("\nTracking classification (DB wrapper):");
    const neverTracking = await getClientMetricTracking(neverClient);
    check(
      "never-tracked client classified never_entered both",
      neverTracking.consults === "never_entered" && neverTracking.cases === "never_entered",
      JSON.stringify(neverTracking),
    );
    check("months inspected = 2", neverTracking.monthsInspected === 2, String(neverTracking.monthsInspected));

    // Pre-seed a DEACTIVATED poisoned row with the exact concern text — the
    // resurrection hazard: the upsert flips is_active back on text match.
    const [deactivated] = await db
      .insert(agentKnowledgeBase)
      .values({
        clientId: neverClient,
        factCategory: "recurring_concern",
        factText: POISONED_CONCERN,
        confidence: 0.75,
        sourceAgent: "daily_judgment",
        isActive: false,
      } as any)
      .returning({ id: agentKnowledgeBase.id });

    console.log("\nGuard — never-tracked client:");
    const stored = await extractAndPersistFromAgentOutput(neverClient, "daily_judgment", `j-${RUN}`, {
      concerns: [POISONED_CONCERN, HEALTHY_CONCERN],
      unresolvedAsks: [POISONED_ASK],
      wins: [],
      sentimentSummary: "",
    });
    check("persist count = 1 (healthy only)", stored === 1, String(stored));

    const texts = await activeFactTexts(neverClient);
    check("healthy concern persisted", texts.includes(HEALTHY_CONCERN), JSON.stringify(texts));
    check("poisoned concern NOT persisted", !texts.includes(POISONED_CONCERN));
    check(
      "poisoned unresolved ask NOT persisted",
      !texts.some((t) => t.includes("zero-consult/poor-conversion")),
    );

    const [deadRow] = await db
      .select({ isActive: agentKnowledgeBase.isActive, usageCount: agentKnowledgeBase.usageCount })
      .from(agentKnowledgeBase)
      .where(eq(agentKnowledgeBase.id, deactivated.id));
    check("deactivated poisoned row NOT resurrected", deadRow.isActive === false, JSON.stringify(deadRow));
    check("deactivated row not even re-touched (usageCount still 1)", deadRow.usageCount === 1, String(deadRow.usageCount));

    // ── tracked client: same vocabulary persists ────────────────────────────
    const trackedClient = await seedClient("tracked");
    createdClients.push(trackedClient);
    await seedReportMonth(trackedClient, "2026-05", ENTERED_INTAKE, ENTERED_SALES);
    await seedReportMonth(trackedClient, "2026-07", FLAGGED_INTAKE, FLAGGED_SALES); // lapsed month

    console.log("\nGuard — tracked client (entered before, lapsed now):");
    const trackedTracking = await getClientMetricTracking(trackedClient);
    check(
      "tracked client classified entered_before both",
      trackedTracking.consults === "entered_before" && trackedTracking.cases === "entered_before",
      JSON.stringify(trackedTracking),
    );
    const storedTracked = await extractAndPersistFromAgentOutput(trackedClient, "daily_judgment", `j2-${RUN}`, {
      concerns: [POISONED_CONCERN],
      wins: [],
      sentimentSummary: "",
      unresolvedAsks: [],
    });
    check("tracked client: zero claim persists (may be a real measurement)", storedTracked === 1, String(storedTracked));
    const trackedTexts = await activeFactTexts(trackedClient);
    check("tracked client: poisoned text active in KB", trackedTexts.includes(POISONED_CONCERN));

    // ── gate scope: daily_judgment only ─────────────────────────────────────
    console.log("\nGuard scope — communication_analysis unaffected:");
    const commClient = await seedClient("comm-analysis");
    createdClients.push(commClient);
    await seedReportMonth(commClient, "2026-07", FLAGGED_INTAKE, FLAGGED_SALES); // never-tracked shape
    const storedComm = await extractAndPersistFromAgentOutput(commClient, "communication_analysis", `c-${RUN}`, {
      concerns: [POISONED_CONCERN],
      wins: [],
      sentimentSummary: "",
      unresolvedAsks: [],
    });
    check("communication_analysis output persists unfiltered", storedComm === 1, String(storedComm));

    // ── no-report client: guard still suppresses (no basis to claim zeros) ──
    console.log("\nGuard — client with NO report history:");
    const bareClient = await seedClient("no-reports");
    createdClients.push(bareClient);
    const storedBare = await extractAndPersistFromAgentOutput(bareClient, "daily_judgment", `j3-${RUN}`, {
      concerns: [POISONED_CONCERN],
      wins: [],
      sentimentSummary: "",
      unresolvedAsks: [],
    });
    check("no report history → zero claim suppressed", storedBare === 0, String(storedBare));
  } finally {
    try {
      if (createdClients.length > 0) {
        await db.delete(agentKnowledgeBase).where(inArray(agentKnowledgeBase.clientId, createdClients));
        const rs = await db
          .select({ id: reports.id })
          .from(reports)
          .where(inArray(reports.clientId, createdClients));
        if (rs.length > 0) {
          await db.delete(reportSections).where(inArray(reportSections.reportId, rs.map((r) => r.id)));
          await db.delete(reports).where(inArray(reports.id, rs.map((r) => r.id)));
        }
        await db.delete(clients).where(inArray(clients.id, createdClients));
      }
    } catch (err) {
      console.error("Cleanup failed:", err);
      failed++;
    }
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
