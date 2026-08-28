/* test-registration
{
  "name": "Report JSONB typed accessors (Task #4151 / F5)",
  "tier": "small"
}
test-registration */
/**
 * Task #4151 (F5, audit R-03) — typed JSONB accessors for the reports
 * persistence boundaries (`server/lib/reportJsonbAccessors.ts`).
 *
 * Pinned behaviors, per boundary:
 *   1. Current valid shape: decoders return the SAME reference (no clone) —
 *      call sites that mutate through the typed view (sanitizer, reimport
 *      merge, webinars→webinar rename) must keep mutating the stored object.
 *   2. Legacy shapes stay readable: top-level `gbpLocations`, plural
 *      `webinars`, webhook-era `reviewGeneration.list.count` (vs `reviews`).
 *   3. Null/missing semantics: read* → {} (mirrors the old `as any || {}`),
 *      readOptional* → undefined (mirrors `as X | undefined`), CEO pulse
 *      aiAnalysis → null (column is nullable).
 *   4. Malformed values (string/number/array in a jsonb object slot) follow
 *      the explicit F5 policy: console.warn + safe fallback, never a throw.
 *   5. Writer→reader round trip through the REAL persistence path
 *      (upsertReportSection → getReportSections): stored bytes unchanged
 *      (deep-equal), accessors read both current and legacy rows.
 *   6. report_section_history previousData/newData stay an opaque
 *      pass-through of exactly what the section held (no decode/rewrite).
 *   7. Behavior equivalence for the converted consumers: trend-entry
 *      builders and the broken-source still-missing recheck produce the
 *      same output through the accessors as the old bare-cast reads did.
 */

import { deepStrictEqual } from "node:assert";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  upsertReportSection,
  getReportSections,
  getReportSectionHistory,
} from "../server/storage/reportStorage";
import {
  readIntakeSection,
  readOptionalIntakeSection,
  readSalesSection,
  readOptionalSalesSection,
  readMarketingSection,
  readOptionalMarketingSection,
  readNextActionsSection,
  readSectionDataObject,
  readOptionalSectionDataObject,
  readCeoPulseAiAnalysis,
  type MarketingSectionRead,
  type StoredGbpLocation,
} from "../server/lib/reportJsonbAccessors";
import {
  buildIntakeTrendEntry,
  buildSalesTrendEntry,
} from "../server/lib/reportTrendEntries";
import {
  BROKEN_SOURCE_WARNING_KEY,
  computeStillMissingBrokenSourceMetrics,
} from "../server/services/reportImportWarnings";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `rja-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CLIENT_ID = `client-${TAG}`;
const REPORT_ID = `report-${TAG}`;
const REPORT_ID_LEGACY = `report-legacy-${TAG}`;
const ACTOR_ID = `actor-${TAG}`;
const ATTRIBUTION = { editor: `user:${ACTOR_ID}`, source: "ui_edit" } as const;

/** Runs fn with console.warn captured; returns the number of warn calls. */
function withWarnSpy<T>(fn: () => T): { result: T; warnCount: number } {
  const original = console.warn;
  let warnCount = 0;
  console.warn = () => {
    warnCount++;
  };
  try {
    return { result: fn(), warnCount };
  } finally {
    console.warn = original;
  }
}

// ---------------------------------------------------------------------------
// (1) + (3): current valid shape = same reference; null/missing semantics.
// ---------------------------------------------------------------------------
function testValidAndMissing(): void {
  const intake = { totalConsults: 7, noDataFlags: { qualityScore: true } };
  const sales = { totalCases: 3, signedByRep: { Alice: 2, Bob: 1 } };
  const marketing = { totalLeads: 12, gbp: { locations: [] } };
  const nextActions = { internalNotes: "x", ours: [] };
  const aiAnalysis = { summary: "s", charts: [{ type: "bar", title: "T" }] };

  assert(readIntakeSection(intake) === intake, "readIntakeSection same ref");
  assert(readSalesSection(sales) === sales, "readSalesSection same ref");
  assert(readMarketingSection(marketing) === marketing, "readMarketingSection same ref");
  assert(readNextActionsSection(nextActions) === nextActions, "readNextActionsSection same ref");
  assert(readSectionDataObject(sales) === sales, "readSectionDataObject same ref");
  assert(readOptionalMarketingSection(marketing) === marketing, "readOptionalMarketingSection same ref");
  assert(readCeoPulseAiAnalysis(aiAnalysis) === aiAnalysis, "readCeoPulseAiAnalysis same ref");
  assert(readCeoPulseAiAnalysis(aiAnalysis)?.charts?.length === 1, "pulse charts readable");

  // Null / missing: read* → {}, readOptional* → undefined, pulse → null.
  for (const nullish of [null, undefined]) {
    deepStrictEqual(readIntakeSection(nullish), {}, "readIntakeSection nullish → {}");
    deepStrictEqual(readSalesSection(nullish), {}, "readSalesSection nullish → {}");
    deepStrictEqual(readMarketingSection(nullish), {}, "readMarketingSection nullish → {}");
    deepStrictEqual(readSectionDataObject(nullish), {}, "readSectionDataObject nullish → {}");
    assert(readOptionalIntakeSection(nullish) === undefined, "readOptionalIntakeSection nullish → undefined");
    assert(readOptionalSalesSection(nullish) === undefined, "readOptionalSalesSection nullish → undefined");
    assert(readOptionalMarketingSection(nullish) === undefined, "readOptionalMarketingSection nullish → undefined");
    assert(readOptionalSectionDataObject(nullish) === undefined, "readOptionalSectionDataObject nullish → undefined");
    assert(readCeoPulseAiAnalysis(nullish) === null, "readCeoPulseAiAnalysis nullish → null");
  }
  console.log("[report-jsonb-accessors] valid + missing semantics OK");
}

// ---------------------------------------------------------------------------
// (2): legacy shapes remain readable through the typed view.
// ---------------------------------------------------------------------------
function testLegacyShapes(): void {
  // Legacy top-level gbpLocations + plural webinars + webhook-era list.count.
  const legacyMarketing = {
    gbpLocations: [
      {
        name: "Downtown",
        uniqueLeads: 4,
        reviewsGenerated: 2,
        reviewsRespondedTo: 1,
        postsQaCount: 3,
        leadQuality: { good: 2, notQuotable: 1, missedCalls: 1, noData: 0 },
      },
    ],
    webinars: { registrants: 30, attendees: 12, hotTransfers: 2 },
    reviewGeneration: { list: { count: 5 }, totalReviews: 7 },
    otherLeads: { count: 2 },
  };
  const m = readMarketingSection(legacyMarketing);
  assert(m === (legacyMarketing as MarketingSectionRead), "legacy marketing same ref");
  assert(m.gbpLocations?.[0]?.uniqueLeads === 4, "legacy gbpLocations readable");
  assert(m.gbpLocations?.[0]?.leadQuality?.good === 2, "legacy loc leadQuality readable");
  assert(m.webinars?.registrants === 30, "legacy plural webinars readable");
  assert(m.webinar === undefined, "legacy row has no singular webinar");
  assert(m.reviewGeneration?.list?.count === 5, "webhook-era list.count readable");
  assert(m.reviewGeneration?.list?.reviews === undefined, "list.reviews absent on legacy row");
  assert(m.reviewGeneration?.totalReviews === 7, "totalReviews readable");
  assert(m.otherLeads?.count === 2, "otherLeads.count readable");

  // The exact legacy fallback expressions the response builders use.
  const locs: StoredGbpLocation[] = m.gbp?.locations || m.gbpLocations || [];
  assert(locs.reduce((s, loc) => s + (loc.uniqueLeads || 0), 0) === 4, "gbp||gbpLocations fallback works");
  const listReviews = m.reviewGeneration?.list?.reviews || m.reviewGeneration?.list?.count || 0;
  assert(listReviews === 5, "reviews||count fallback works");

  // Broken-source warning key read (intake boundary).
  const intakeWithWarning = {
    totalConsults: 0,
    [BROKEN_SOURCE_WARNING_KEY]: {
      missingMetrics: ["totalConsults"],
      priorReportMonth: "2026-05",
      rawPlaceholder: false,
    },
  };
  const i = readIntakeSection(intakeWithWarning);
  const warning = i[BROKEN_SOURCE_WARNING_KEY];
  assert(!!warning && Array.isArray(warning.missingMetrics), "warning missingMetrics readable");
  console.log("[report-jsonb-accessors] legacy shapes OK");
}

// ---------------------------------------------------------------------------
// (4): malformed values — warn + safe fallback, never a throw.
// ---------------------------------------------------------------------------
function testMalformed(): void {
  const malformedValues: unknown[] = ["junk", 42, true, [{ nested: 1 }]];
  for (const bad of malformedValues) {
    {
      const { result, warnCount } = withWarnSpy(() => readMarketingSection(bad));
      deepStrictEqual(result, {}, `readMarketingSection(${JSON.stringify(bad)}) → {}`);
      assert(warnCount === 1, `readMarketingSection(${JSON.stringify(bad)}) warned once`);
    }
    {
      const { result, warnCount } = withWarnSpy(() => readOptionalIntakeSection(bad));
      deepStrictEqual(result, {}, "readOptionalIntakeSection malformed → {} (not undefined)");
      assert(warnCount === 1, "readOptionalIntakeSection malformed warned once");
    }
    {
      const { result, warnCount } = withWarnSpy(() => readCeoPulseAiAnalysis(bad));
      assert(result === null, "readCeoPulseAiAnalysis malformed → null");
      assert(warnCount === 1, "readCeoPulseAiAnalysis malformed warned once");
    }
  }
  // Valid values never warn.
  const { warnCount } = withWarnSpy(() => {
    readMarketingSection({ totalLeads: 1 });
    readIntakeSection(null);
    readOptionalSalesSection(undefined);
    readCeoPulseAiAnalysis(null);
  });
  assert(warnCount === 0, "no warns for valid/nullish values");
  console.log("[report-jsonb-accessors] malformed policy OK");
}

// ---------------------------------------------------------------------------
// (7): converted consumers behave exactly like the old bare-cast reads.
// ---------------------------------------------------------------------------
function testConsumerEquivalence(): void {
  // Trend entries: typed accessor input vs the old `as any || {}` input.
  const intakeRow = {
    totalConsults: 9,
    leadToConsultRate: 25,
    qualityScore: 80,
    avgTimeToAnswer: 4,
    noDataFlags: { avgTimeToAnswer: false },
  };
  const salesRow = {
    totalCases: 2,
    consultToCaseRate: 40,
    averageCaseValue: 9000,
    noShowRate: 0,
    noDataFlags: {},
  };
  deepStrictEqual(
    buildIntakeTrendEntry(readIntakeSection(intakeRow), "free"),
    buildIntakeTrendEntry(intakeRow as any, "free"),
    "intake trend entry unchanged through accessor",
  );
  deepStrictEqual(
    buildSalesTrendEntry(readSalesSection(salesRow), "free"),
    buildSalesTrendEntry(salesRow as any, "free"),
    "sales trend entry unchanged through accessor",
  );
  // Missing sections: the old code passed `{}` (from `as any || {}`); the
  // accessor read of a missing row produces the same entry.
  deepStrictEqual(
    buildIntakeTrendEntry(readIntakeSection(undefined), "free"),
    buildIntakeTrendEntry({} as any, "free"),
    "missing intake row → same null-metric entry",
  );

  // Broken-source still-missing recheck: warned + still not entered.
  const sections = [
    {
      sectionKey: "intake",
      data: {
        totalConsults: 0,
        [BROKEN_SOURCE_WARNING_KEY]: { missingMetrics: ["totalConsults"] },
      },
    },
    { sectionKey: "sales", data: { totalCases: 4 } },
  ];
  deepStrictEqual(
    computeStillMissingBrokenSourceMetrics(sections),
    ["totalConsults"],
    "still-missing recheck unchanged",
  );
  // Malformed section data degrades to "no warning present" (old cast read
  // property-accessed a string and got undefined) — plus the policy warn.
  const { result: stillMissing } = withWarnSpy(() =>
    computeStillMissingBrokenSourceMetrics([
      { sectionKey: "intake", data: "corrupted" },
      { sectionKey: "sales", data: null },
    ]),
  );
  deepStrictEqual(stillMissing, [], "malformed section data → no metrics, no throw");
  console.log("[report-jsonb-accessors] consumer equivalence OK");
}

// ---------------------------------------------------------------------------
// (5) + (6): real writer→reader round trip + opaque history pass-through.
// ---------------------------------------------------------------------------
async function setup(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name)
    VALUES (${ACTOR_ID}, ${`${ACTOR_ID}@example.com`}, 'F5', 'Tester')
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO clients (id, firm_name)
    VALUES (${CLIENT_ID}, ${`F5 Accessor Test ${TAG}`})
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status, created_by)
    VALUES (${REPORT_ID}, ${CLIENT_ID}, ${"2026-03"}, ${"draft"}, ${ACTOR_ID})
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status, created_by)
    VALUES (${REPORT_ID_LEGACY}, ${CLIENT_ID}, ${"2026-04"}, ${"draft"}, ${ACTOR_ID})
    ON CONFLICT (id) DO NOTHING
  `);
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM report_section_history WHERE report_id IN (${REPORT_ID}, ${REPORT_ID_LEGACY})`);
  await db.execute(sql`DELETE FROM report_sections WHERE report_id IN (${REPORT_ID}, ${REPORT_ID_LEGACY})`);
  await db.execute(sql`DELETE FROM reports WHERE id IN (${REPORT_ID}, ${REPORT_ID_LEGACY})`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${CLIENT_ID}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${ACTOR_ID}`);
}

async function testDbRoundTrip(): Promise<void> {
  // Current-shape marketing payload (what the webhook/PUT writers persist).
  const currentMarketing = {
    totalLeads: 15,
    gbp: {
      locations: [
        {
          name: "Uptown",
          uniqueLeads: 6,
          reviewsGenerated: 3,
          reviewsRespondedTo: 2,
          postsQaCount: 4,
          leadQuality: { good: 3, notQuotable: 2, missedCalls: 1, noData: 0 },
          heatmapSnapshotIds: [`snap-${TAG}`],
        },
      ],
    },
    reviewGeneration: { list: { reviews: 4, contacted: 40 }, totalReviews: 9 },
    webinar: { registrants: 20, attendees: 8, hotTransfers: 1 },
    googleAds: { adSpend: 1200, uniqueLeads: 5 },
  };
  await upsertReportSection(
    { reportId: REPORT_ID, sectionKey: "marketing", data: currentMarketing },
    ATTRIBUTION,
  );

  // Legacy-shape row persisted through the same real writer (verbatim jsonb).
  const legacyMarketing = {
    gbpLocations: [
      {
        name: "Old Town",
        uniqueLeads: 2,
        reviewsGenerated: 1,
        reviewsRespondedTo: 0,
        postsQaCount: 1,
        leadQuality: { good: 1, notQuotable: 1, missedCalls: 0, noData: 0 },
      },
    ],
    webinars: { registrants: 10, attendees: 4 },
    reviewGeneration: { list: { count: 2 } },
  };
  await upsertReportSection(
    { reportId: REPORT_ID_LEGACY, sectionKey: "marketing", data: legacyMarketing },
    ATTRIBUTION,
  );

  // Reader side: bytes unchanged, accessors expose both shapes.
  const currentRows = await getReportSections(REPORT_ID);
  const currentRow = currentRows.find((s) => s.sectionKey === "marketing");
  assert(!!currentRow, "current marketing row persisted");
  deepStrictEqual(currentRow!.data, currentMarketing, "stored jsonb round-trips byte-identical");
  const cm = readMarketingSection(currentRow!.data);
  assert(cm.gbp?.locations?.[0]?.uniqueLeads === 6, "current row: nested gbp locations readable");
  assert(cm.gbp?.locations?.[0]?.heatmapSnapshotIds?.[0] === `snap-${TAG}`, "heatmap ids readable");
  assert(cm.reviewGeneration?.list?.reviews === 4, "current row: list.reviews readable");

  const legacyRows = await getReportSections(REPORT_ID_LEGACY);
  const legacyRow = legacyRows.find((s) => s.sectionKey === "marketing");
  assert(!!legacyRow, "legacy marketing row persisted");
  deepStrictEqual(legacyRow!.data, legacyMarketing, "legacy jsonb round-trips byte-identical");
  const lm = readMarketingSection(legacyRow!.data);
  assert(lm.gbpLocations?.[0]?.uniqueLeads === 2, "legacy row: top-level gbpLocations readable");
  assert(lm.webinars?.registrants === 10, "legacy row: plural webinars readable");
  assert(lm.reviewGeneration?.list?.count === 2, "legacy row: list.count readable");

  // History boundary: previousData/newData are an opaque pass-through.
  const updatedMarketing = { ...currentMarketing, totalLeads: 16 };
  await upsertReportSection(
    { reportId: REPORT_ID, sectionKey: "marketing", data: updatedMarketing },
    ATTRIBUTION,
  );
  const history = await getReportSectionHistory(REPORT_ID, "marketing");
  assert(history.length === 2, `expected 2 history rows, got ${history.length}`);
  deepStrictEqual(history[0].previousData, currentMarketing, "history previousData = prior section bytes");
  deepStrictEqual(history[0].newData, updatedMarketing, "history newData = new section bytes");
  assert(history[1].previousData === null, "first save previousData stays null");
  console.log("[report-jsonb-accessors] DB round trip + history pass-through OK");
}

async function main(): Promise<void> {
  testValidAndMissing();
  testLegacyShapes();
  testMalformed();
  testConsumerEquivalence();
  await setup();
  try {
    await testDbRoundTrip();
  } finally {
    await cleanup();
  }
  console.log("[report-jsonb-accessors] PASS");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084),
// so the process exits on its own once work settles — no manual process.exit().
await main();
