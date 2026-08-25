/* test-registration
{
  "name": "Heatmap per-keyword report-date fallback (Task #2893)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2893: per-keyword report-date fallback for SEMrush heatmap fetches — the \"wasn't collected\" 400 classifier, bounded fallback-date ordering, the plain-language all-dates-failed error, and sync-worker parity (keyword 400s at the target date, succeeds + persists at a fallback date, siblings unaffected). Fast; DB section seeds + cleans its own tagged rows.",
  "tier": "small"
}
test-registration */
/**
 * Task #2893 — per-keyword report-date fallback for SEMrush heatmap fetches.
 *
 * Prod bug (feedback #40): the bulk fetch route picked ONE campaign-level
 * reportDate and SEMrush returned a non-retryable 400 for a keyword that
 * had no collection at that date ("Keyword ... wasn't collected for project
 * ... at 2026-06-29T17:00"), failing the whole fetch with no fallback.
 *
 * Sections:
 *   1. Pure-module tests: the "wasn't collected" classifier, fallback-date
 *      candidate ordering/bounding, fallback success on a later date,
 *      immediate rethrow of unrelated errors, and the plain-language
 *      all-dates-failed error.
 *   2. Sync-worker parity (DB-backed): a keyword that 400s at the target
 *      date succeeds on a fallback date; the snapshot is stored under the
 *      fallback date; sibling keywords are unaffected.
 */

import assert from "node:assert/strict";
import {
  isKeywordNotCollectedError,
  buildFallbackReportDates,
  fetchHeatmapWithDateFallback,
  KeywordNoDataError,
  KEYWORD_NO_DATA_CODE,
} from "../server/services/heatmapReportDateFallback";
import { db } from "../server/db";
import { clients, clientLocations, heatmapSnapshots } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import {
  syncCampaignForClient,
  __setSemrushSyncTestOverrides,
} from "../server/services/localDominanceSyncWorker";
import type { SemrushHeatmapPoint } from "../server/services/semrushApi";

let failures = 0;
function step(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  ${name}`))
    .catch((err: any) => {
      failures += 1;
      console.error(`  FAIL ${name}:`, err?.message ?? err);
      if (err?.stack) console.error(err.stack);
    });
}

// The exact shape apiGet throws for a non-404/429/401 error status,
// with the real prod body observed in the deployment logs.
const PROD_400_MESSAGE =
  `SEMrush API returned 400: {"error":{"code":400,"message":"Keyword \\"criminal defense lawyer\\" wasn't collected for project \\"12345\\" at 2026-06-29T17:00"}}`;

async function pureModuleTests(): Promise<void> {
  console.log("Section 1: pure module");

  await step("classifier matches the real prod 400 body", () => {
    assert.equal(isKeywordNotCollectedError(new Error(PROD_400_MESSAGE)), true);
    assert.equal(isKeywordNotCollectedError(new Error("Keyword was not collected at date")), true);
  });

  await step("classifier rejects unrelated errors", () => {
    assert.equal(isKeywordNotCollectedError(new Error("SEMrush API returned 400: bad placeIds")), false);
    assert.equal(isKeywordNotCollectedError(new Error("Semrush not connected — token expired, please re-authorize via Integrations Hub")), false);
    assert.equal(isKeywordNotCollectedError(new Error("SEMrush API rate limited (429) after 4 retries for /x")), false);
    assert.equal(isKeywordNotCollectedError(null), false);
    assert.equal(isKeywordNotCollectedError("wasn't collected"), false);
  });

  await step("candidates exclude the selected date, sort nearest-to-month, and are bounded", () => {
    const dates = [
      "2026-07-06T17:00:00Z",
      "2026-06-29T17:00:00Z", // selected
      "2026-06-22T17:00:00Z",
      "2026-06-15T17:00:00Z",
      "2026-06-08T17:00:00Z",
      "2026-06-01T17:00:00Z",
    ];
    const out = buildFallbackReportDates(dates, "2026-06-29T17:00:00Z", "2026-06");
    assert.equal(out.length, 3, "bounded to 3 candidates by default");
    assert.ok(!out.includes("2026-06-29T17:00:00Z"), "selected date excluded");
    // Anchor is end of June (06-30T23:59): 07-06 is ~5.8d after the anchor,
    // 06-22 is ~8.3d before, 06-15 ~15.3d before → 07-06, 06-22, 06-15.
    assert.deepEqual(out, [
      "2026-07-06T17:00:00Z",
      "2026-06-22T17:00:00Z",
      "2026-06-15T17:00:00Z",
    ]);
  });

  await step("no reportMonth → anchor on the selected date itself", () => {
    const dates = ["2026-05-01T00:00:00Z", "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z"];
    const out = buildFallbackReportDates(dates, "2026-06-01T00:00:00Z", null, 2);
    // Nearest to 06-01: 07-01 and 05-01 are equidistant → newer first.
    assert.deepEqual(out, ["2026-07-01T00:00:00Z", "2026-05-01T00:00:00Z"]);
  });

  await step("fallback succeeds on the second date and reports the date used", async () => {
    const attempted: string[] = [];
    const { result, reportDateUsed, usedFallback } = await fetchHeatmapWithDateFallback({
      fetchAtDate: async (d) => {
        attempted.push(d);
        if (d === "2026-06-29") throw new Error(PROD_400_MESSAGE);
        return { date: d, ok: true };
      },
      selectedReportDate: "2026-06-29",
      reportDates: ["2026-06-29", "2026-06-22", "2026-06-15"],
      reportMonth: "2026-06",
      keywordName: "criminal defense lawyer",
    });
    assert.equal(usedFallback, true);
    assert.equal(reportDateUsed, "2026-06-22");
    assert.deepEqual(result, { date: "2026-06-22", ok: true });
    assert.deepEqual(attempted, ["2026-06-29", "2026-06-22"]);
  });

  await step("unrelated errors rethrow immediately without date fallback", async () => {
    let calls = 0;
    await assert.rejects(
      fetchHeatmapWithDateFallback({
        fetchAtDate: async () => {
          calls++;
          throw new Error("SEMrush API request timed out after 30s for /campaigns/x/heatmap");
        },
        selectedReportDate: "2026-06-29",
        reportDates: ["2026-06-29", "2026-06-22"],
        keywordName: "kw",
      }),
      /timed out/,
    );
    assert.equal(calls, 1, "no fallback attempts for non-'wasn't collected' errors");
  });

  await step("all dates failing yields the plain-language KeywordNoDataError", async () => {
    const attempted: string[] = [];
    try {
      await fetchHeatmapWithDateFallback({
        fetchAtDate: async (d) => {
          attempted.push(d);
          throw new Error(PROD_400_MESSAGE);
        },
        selectedReportDate: "2026-06-29",
        reportDates: ["2026-06-29", "2026-06-22", "2026-06-15", "2026-06-08", "2026-06-01"],
        reportMonth: "2026-06",
        keywordName: "criminal defense lawyer",
      });
      assert.fail("expected KeywordNoDataError");
    } catch (err: any) {
      assert.ok(err instanceof KeywordNoDataError);
      assert.equal(err.code, KEYWORD_NO_DATA_CODE);
      assert.equal(attempted.length, 4, "selected + 3 bounded fallback attempts");
      assert.match(err.message, /no collected heatmap data yet/i, "plain language");
      assert.match(err.message, /criminal defense lawyer/);
      assert.doesNotMatch(err.message, /SEMrush API returned 400/, "raw 400 body not surfaced");
    }
  });
}

// ---------------------------------------------------------------------------
// Section 2 — sync worker parity (DB-backed, mirrors semrush-multi-keyword-sync)
// ---------------------------------------------------------------------------

const TAG = `hrdf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const TARGET_DATE = "2026-06-29T17:00:00.000Z";
const FALLBACK_DATE = "2026-06-22T17:00:00.000Z";
const KEYWORDS = [
  { id: "kw1", name: `kw1 ${TAG} personal injury lawyer` },
  { id: "kw2", name: `kw2 ${TAG} criminal defense lawyer` }, // not collected at TARGET_DATE
  { id: "kw3", name: `kw3 ${TAG} dui attorney` },
];

const createdClientIds: string[] = [];
const createdLocationIds: string[] = [];

async function cleanup(): Promise<void> {
  if (createdClientIds.length) {
    await db.delete(heatmapSnapshots).where(inArray(heatmapSnapshots.clientId, createdClientIds));
    await db.delete(clientLocations).where(inArray(clientLocations.id, createdLocationIds));
    await db.delete(clients).where(inArray(clients.id, createdClientIds));
  }
}

async function workerParityTest(): Promise<void> {
  console.log("Section 2: sync worker parity");

  const [c] = await db.insert(clients).values({ firmName: `Date fallback ${TAG}` })
    .returning({ id: clients.id });
  createdClientIds.push(c.id);
  const [l] = await db.insert(clientLocations).values({ clientId: c.id, name: "L1" })
    .returning({ id: clientLocations.id });
  createdLocationIds.push(l.id);
  const campaignId = `camp-${TAG}`;

  const heatmapCalls: Array<{ keywordId: string; reportDate: string | undefined }> = [];
  __setSemrushSyncTestOverrides({
    semrushApi: {
      getCampaign: async (cid: string) => ({
        id: cid,
        reportDates: [TARGET_DATE, FALLBACK_DATE, "2026-06-15T17:00:00.000Z"],
        businessName: "Fallback Firm",
        gridSettings: { template: "9x9", unit: "MILES", distance: 5, basePoint: { lat: 34, lng: -118 } },
        lat: 34,
        lng: -118,
      }),
      getCampaignKeywordsWithMeta: async () => ({
        keywords: KEYWORDS.map(k => ({ id: k.id, name: k.name, status: "ACTIVE" })),
        complete: true,
      }),
      findBestReportDate: (dates: string[]) => dates[0] ?? null,
      getHeatmapData: async (_cid: string, kid: string, opts?: { reportDate?: string }) => {
        heatmapCalls.push({ keywordId: kid, reportDate: opts?.reportDate });
        if (kid === "kw2" && opts?.reportDate === TARGET_DATE) {
          throw new Error(PROD_400_MESSAGE);
        }
        const kw = KEYWORDS.find(k => k.id === kid)!;
        const positions: SemrushHeatmapPoint[] = [
          { point: { id: "p1", lat: 34, lng: -118 }, rank: 2, diff: 0 },
        ];
        return {
          keyword: { id: kw.id, name: kw.name },
          date: opts?.reportDate ?? TARGET_DATE,
          positions,
        };
      },
    },
  });

  try {
    const result = await syncCampaignForClient(c.id, campaignId, l.id, "Fallback Firm");

    await step("all three keywords import (kw2 via fallback date)", () => {
      assert.equal(result.imported, 3, `imported=${result.imported} keywordErrors=${JSON.stringify(result.keywordErrors)}`);
      assert.equal(result.keywordErrors.length, 0, `unexpected keyword errors: ${JSON.stringify(result.keywordErrors)}`);
    });

    await step("kw2 retried against the fallback date; siblings fetched once at the target date", () => {
      const kw2Calls = heatmapCalls.filter(h => h.keywordId === "kw2");
      assert.deepEqual(kw2Calls.map(h => h.reportDate), [TARGET_DATE, FALLBACK_DATE]);
      for (const kid of ["kw1", "kw3"]) {
        const calls = heatmapCalls.filter(h => h.keywordId === kid);
        assert.deepEqual(calls.map(h => h.reportDate), [TARGET_DATE], `${kid} calls`);
      }
    });

    await step("kw2 snapshot is stored under the fallback report date", async () => {
      const snaps = await db.select({
        keywordName: heatmapSnapshots.keywordName,
        reportDate: heatmapSnapshots.reportDate,
      })
        .from(heatmapSnapshots)
        .where(and(
          eq(heatmapSnapshots.clientId, c.id),
          eq(heatmapSnapshots.campaignId, campaignId),
        ));
      assert.equal(snaps.length, 3, `expected 3 snapshots, got ${snaps.length}`);
      const byName = new Map(snaps.map(s => [s.keywordName, s.reportDate.toISOString()]));
      assert.equal(byName.get(KEYWORDS[0].name), TARGET_DATE);
      assert.equal(byName.get(KEYWORDS[1].name), FALLBACK_DATE, "kw2 stored at the successful fallback date");
      assert.equal(byName.get(KEYWORDS[2].name), TARGET_DATE);
    });
  } finally {
    __setSemrushSyncTestOverrides(null);
    await cleanup();
  }
}

async function main(): Promise<void> {
  await pureModuleTests();
  await workerParityTest();
  if (failures > 0) {
    console.error(`\n${failures} test(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log("\nAll heatmap report-date fallback tests passed");
  }
}

main().catch(async (err) => {
  console.error("heatmap-report-date-fallback: FAILED", err);
  __setSemrushSyncTestOverrides(null);
  await cleanup().catch(() => undefined);
  process.exitCode = 1;
});
