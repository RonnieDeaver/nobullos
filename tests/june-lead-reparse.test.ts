/* test-registration
{
  "name": "June lead reparse (baseline triage, Task #3424)",
  "tier": "medium"
}
test-registration */
// Task #2753 — convergence + surgical-merge regression for the June 2026
// lead re-parse core (`server/services/juneLeadReparse.ts`), driven by the
// `reparse_june_2026_report_leads` CEO prod-action. Locks in the contract:
//
//   1. `findJuneReparseCandidates` selects ONLY reportMonth='2026-06' reports
//      whose marketing section is unstamped (or missing, or stamped at an
//      older version). Other months and already-stamped reports are excluded.
//   2. `processJuneReparseReport` re-parses from the saved PDF (fallback: the
//      original webhook source URL), surgically merges ONLY lead fields onto
//      the existing marketing data (operator-owned keys preserved, GBP rows
//      never minted), and stamps EVERY outcome — corrected / unchanged /
//      skipped_no_source / error — so a full drain pass converges to zero.
//   3. The crushed-clamp shape (totalLeads=1 from the pre-fix parser) is
//      corrected to the source-supported numbers via the fixed parse.
//
// Runs in an isolated Postgres schema (LIKE clone drops the reports→clients/
// users FKs, so reports seed without parent rows; see memory
// "isolated-schema-fk-attribution-tests"). All deps are stubbed — no object
// storage, no network fetch, no real PDF parse, no OpenAI.
//
// Usage: tsx tests/june-lead-reparse.test.ts
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { runInIsolatedSchema } from "./db-sandbox";
import { reports, reportSections } from "@shared/schema";
import {
  findJuneReparseCandidates,
  processJuneReparseReport,
  mergeReparsedLeadFields,
  JUNE_LEAD_REPARSE_MONTH,
  JUNE_LEAD_REPARSE_VERSION,
  JUNE_LEAD_REPARSE_STAMP_KEY,
  JUNE_LEAD_REPARSE_OUTCOME_KEY,
  type JuneReparseDeps,
  type JuneReparseCandidate,
} from "../server/services/juneLeadReparse";

const LQ = (good: number, nq = 0, mc = 0, nd = 0) => ({
  good,
  notQuotable: nq,
  missedCalls: mc,
  noData: nd,
});

// The June bug shape: stored data crushed to totalLeads=1 by the old clamp.
const CRUSHED_MARKETING = {
  totalLeads: 1,
  gbp: {
    locations: [
      { name: "Phoenix", uniqueLeads: 1, leadQuality: LQ(1) },
      { name: "Jones Law Firm (Mesa)", uniqueLeads: 0, leadQuality: LQ(0) },
    ],
    reviews: { current: 120, previous: 100 }, // operator-owned-ish, must survive
  },
  lsa: { uniqueLeads: 0, adSpend: 5000, costPerLead: 0, leadQuality: LQ(0) },
  webinar: { hotTransfers: 0, leadQuality: LQ(0) },
  otherLeads: { count: 0, leadQuality: LQ(0) },
  gbpLeadQuality: LQ(1),
  leadQuality: LQ(1),
  reviewGeneration: { sent: 42 }, // operator-owned block, must survive merge
};

// What the FIXED parser returns from the same PDF.
const REPARSED_MARKETING = {
  totalLeads: 595,
  gbpLocations: [
    { name: "Phoenix", uniqueLeads: 59, leadQuality: LQ(50, 5, 4) },
    { name: "Mesa", uniqueLeads: 179, leadQuality: LQ(150, 20, 9) },
    // Ghost location NOT present in the stored panel — must be ignored.
    { name: "Tucson", uniqueLeads: 999, leadQuality: LQ(999) },
  ],
  lsa: { uniqueLeads: 340, adSpend: 5100, leadQuality: LQ(300, 30, 10) },
  webinar: { leads: 17, hotTransfers: 17, leadQuality: LQ(17) },
  otherLeads: { total: 0, leadQuality: LQ(0) },
};

function makeDeps(db: any, overrides: Partial<JuneReparseDeps> = {}): JuneReparseDeps {
  return {
    db,
    loadSavedPdf: async () => Buffer.from("%PDF-fake"),
    fetchUrlPdf: async () => null,
    getImportLogSourceUrl: async () => null,
    parsePdf: async () => ({ marketing: JSON.parse(JSON.stringify(REPARSED_MARKETING)) }),
    getActiveProducts: async () => ["gbp", "lsa", "webinar"] as any,
    writeSection: async (data, _attribution) => {
      // Sandbox stand-in for storage.upsertReportSection (which uses the
      // ambient getDb()): upsert directly into the isolated schema.
      const [existing] = await db
        .select({ id: reportSections.id })
        .from(reportSections)
        .where(
          and(
            eq(reportSections.reportId, data.reportId),
            eq(reportSections.sectionKey, data.sectionKey),
          ),
        );
      if (existing) {
        await db
          .update(reportSections)
          .set({ data: data.data })
          .where(eq(reportSections.id, existing.id));
      } else {
        await db.insert(reportSections).values(data);
      }
    },
    ...overrides,
  };
}

async function seedReport(
  db: any,
  opts: {
    month?: string;
    marketing?: Record<string, any> | null;
    sourcePdfStorageKey?: string | null;
    webhookImportLogId?: string | null;
  },
): Promise<string> {
  const [r] = await db
    .insert(reports)
    .values({
      clientId: `client-${Math.random().toString(36).slice(2)}`,
      reportMonth: opts.month ?? JUNE_LEAD_REPARSE_MONTH,
      sourcePdfStorageKey:
        opts.sourcePdfStorageKey === undefined
          ? "reports/source/x.pdf"
          : opts.sourcePdfStorageKey,
      webhookImportLogId: opts.webhookImportLogId ?? null,
    })
    .returning({ id: reports.id });
  if (opts.marketing !== null) {
    await db.insert(reportSections).values({
      reportId: r.id,
      sectionKey: "marketing",
      data: opts.marketing ?? JSON.parse(JSON.stringify(CRUSHED_MARKETING)),
    });
  }
  return r.id;
}

async function readMarketing(db: any, reportId: string): Promise<Record<string, any>> {
  const [row] = await db
    .select({ data: reportSections.data })
    .from(reportSections)
    .where(
      and(
        eq(reportSections.reportId, reportId),
        eq(reportSections.sectionKey, "marketing"),
      ),
    );
  return (row?.data ?? {}) as Record<string, any>;
}

async function main(): Promise<void> {
  // ── (0) pure merge unit checks ─────────────────────────────────────────
  {
    const merged = mergeReparsedLeadFields(
      JSON.parse(JSON.stringify(CRUSHED_MARKETING)),
      JSON.parse(JSON.stringify(REPARSED_MARKETING)),
      ["gbp", "lsa", "webinar"] as any,
    );
    assert.equal(merged.totalLeads, 595, "total corrected");
    assert.equal(merged.gbp.locations.length, 2, "no ghost GBP row minted");
    assert.equal(merged.gbp.locations[0].uniqueLeads, 59, "exact-name match updated");
    assert.equal(
      merged.gbp.locations[1].uniqueLeads,
      179,
      "parsed 'Mesa' resolves to stored 'Jones Law Firm (Mesa)' via parenthetical city",
    );
    assert.equal(merged.gbp.reviews.current, 120, "non-lead GBP fields preserved");
    assert.equal(merged.reviewGeneration.sent, 42, "operator-owned block preserved");
    assert.equal(merged.lsa.uniqueLeads, 340);
    assert.equal(merged.lsa.costPerLead, Math.round(5100 / 340), "CPL recomputed");
    assert.equal(merged.webinar.hotTransfers, 17);
    assert.equal(merged.gbpLeadQuality.good, 200, "GBP rollup from updated locations");
    assert.ok(merged.leadQuality.good >= 200, "all-platform rollup recomputed");
  }

  await runInIsolatedSchema(
    async ({ db }) => {
      // ── (1) candidate selection ──────────────────────────────────────
      const idCrushed = await seedReport(db, {});
      const idNoSection = await seedReport(db, { marketing: null });
      const idNoSource = await seedReport(db, {
        sourcePdfStorageKey: null,
        webhookImportLogId: null,
      });
      const idStamped = await seedReport(db, {
        marketing: {
          ...CRUSHED_MARKETING,
          [JUNE_LEAD_REPARSE_STAMP_KEY]: JUNE_LEAD_REPARSE_VERSION,
          [JUNE_LEAD_REPARSE_OUTCOME_KEY]: "unchanged",
        },
      });
      const idOtherMonth = await seedReport(db, { month: "2026-05" });

      const candidates = await findJuneReparseCandidates(db);
      const ids = candidates.map((c) => c.reportId).sort();
      assert.deepEqual(
        ids,
        [idCrushed, idNoSection, idNoSource].sort(),
        "candidates = unstamped June reports only (missing section included; stamped + other months excluded)",
      );
      const noSectionCand = candidates.find((c) => c.reportId === idNoSection)!;
      assert.equal(noSectionCand.sectionId, null, "missing-section candidate carries null sectionId");

      // ── (2) crushed report → corrected + stamped ─────────────────────
      const deps = makeDeps(db);
      const crushedCand = candidates.find((c) => c.reportId === idCrushed)!;
      const res1 = await processJuneReparseReport(deps, crushedCand);
      assert.equal(res1.outcome, "corrected");
      const after = await readMarketing(db, idCrushed);
      assert.equal(after.totalLeads, 595, "persisted total corrected");
      assert.equal(after.gbp.locations[1].uniqueLeads, 179);
      assert.equal(after.reviewGeneration.sent, 42, "operator block survives persist");
      assert.equal(after[JUNE_LEAD_REPARSE_STAMP_KEY], JUNE_LEAD_REPARSE_VERSION);
      assert.equal(after[JUNE_LEAD_REPARSE_OUTCOME_KEY], "corrected");

      // Re-running the SAME report now (already stamped in data but passed
      // directly) is "unchanged" — the merge is idempotent.
      const rerun = await processJuneReparseReport(deps, {
        ...crushedCand,
        marketingData: after,
      });
      assert.equal(rerun.outcome, "unchanged", "second pass over corrected data is a no-op");

      // ── (3) no source anywhere → skipped_no_source, still stamped ────
      const noSourceCand = candidates.find((c) => c.reportId === idNoSource)!;
      const res3 = await processJuneReparseReport(deps, noSourceCand);
      assert.equal(res3.outcome, "skipped_no_source");
      const skipped = await readMarketing(db, idNoSource);
      assert.equal(skipped[JUNE_LEAD_REPARSE_OUTCOME_KEY], "skipped_no_source");
      assert.equal(skipped.totalLeads, 1, "skipped report's data untouched beyond the stamp");

      // ── (3b) saved copy missing but original URL works → corrected ───
      const idUrlFallback = await seedReport(db, {
        sourcePdfStorageKey: null,
        webhookImportLogId: "log-1",
      });
      const [urlCand] = (await findJuneReparseCandidates(db)).filter(
        (c) => c.reportId === idUrlFallback,
      );
      let urlFetched = 0;
      const resUrl = await processJuneReparseReport(
        makeDeps(db, {
          getImportLogSourceUrl: async (logId) => {
            assert.equal(logId, "log-1");
            return "https://example.com/source.pdf";
          },
          fetchUrlPdf: async () => {
            urlFetched++;
            return Buffer.from("%PDF-fake");
          },
        }),
        urlCand,
      );
      assert.equal(urlFetched, 1, "fallback URL fetch used");
      assert.equal(resUrl.outcome, "corrected");

      // ── (4) parse throws → outcome=error, STILL stamped (convergent) ─
      const idError = await seedReport(db, {});
      const [errCand] = (await findJuneReparseCandidates(db)).filter(
        (c) => c.reportId === idError,
      );
      const resErr = await processJuneReparseReport(
        makeDeps(db, {
          parsePdf: async () => {
            throw new Error("boom: unreadable PDF");
          },
        }),
        errCand,
      );
      assert.equal(resErr.outcome, "error");
      const errData = await readMarketing(db, idError);
      assert.equal(errData[JUNE_LEAD_REPARSE_OUTCOME_KEY], "error");
      assert.equal(errData.totalLeads, 1, "failed report's lead data untouched");

      // ── (5) full drain converges: process remaining, then zero left ──
      let remaining: JuneReparseCandidate[] = await findJuneReparseCandidates(db);
      for (const cand of remaining) {
        await processJuneReparseReport(deps, cand);
      }
      remaining = await findJuneReparseCandidates(db);
      assert.equal(remaining.length, 0, "second sweep finds ZERO candidates — converged");

      // Stamped + other-month rows never touched.
      const stamped = await readMarketing(db, idStamped);
      assert.equal(stamped.totalLeads, 1, "already-stamped report untouched");
      const otherMonth = await readMarketing(db, idOtherMonth);
      assert.equal(otherMonth[JUNE_LEAD_REPARSE_STAMP_KEY], undefined, "other month untouched");
    },
    { tables: ["reports", "report_sections"] },
  );

  console.log("Task #2753 June 2026 lead re-parse: all assertions passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
