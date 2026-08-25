/**
 * Task 642 — Verify per-location heatmap snapshot coverage after the
 * task-636 backfill enqueued refresh jobs.
 *
 * The backfill itself only enqueues `refresh` work-queue jobs; it does not
 * confirm that `heatmap_snapshots` rows actually landed for every
 * (clientId, locationId, reportDate). This verification pass walks the same
 * (clientId, locationId, semrushCampaignId) mappings the backfill used,
 * fetches the campaign's report dates + keyword set from SEMrush, and counts
 * matching rows in `heatmap_snapshots`.
 *
 * For each (clientId, locationId, campaignId, reportDate) tuple the script
 * classifies coverage as:
 *   ok            — actualSnapshots >= expectedActiveKeywords
 *   partial       — 0 < actualSnapshots < expectedActiveKeywords
 *   missing       — actualSnapshots == 0 and expectedActiveKeywords > 0
 *   inconclusive  — expected count could not be determined (e.g. SEMrush
 *                   keyword fetch failed). These are NOT marked ok.
 *
 * Date matching is day-level: importHeatmap dedupes by day window, so we
 * compare reportDate ∈ [dayStart, dayEnd) for the campaign's reportDate
 * (UTC day) rather than requiring an exact timestamp match.
 *
 * Expected keyword count mirrors handleRefreshJob's filter:
 *   status ∈ {COLLECTED, UNKNOWN, ACTIVE}
 * so we don't inflate expectations with paused/archived keywords.
 *
 * Output:
 *   - console summary per client / location
 *   - verification/task-642-results.json (machine-readable)
 *   - verification/task-642-coverage-report.md (human-readable)
 *
 * Usage:
 *   tsx scripts/verify-task-642.ts                       # all clients with semrush_location_campaigns
 *   tsx scripts/verify-task-642.ts --clients <id1>,<id2>
 *   tsx scripts/verify-task-642.ts --locations <id1>,<id2>
 *   tsx scripts/verify-task-642.ts --since 2025-01-01 --until 2026-04-01
 *   tsx scripts/verify-task-642.ts --json-only           # skip markdown report
 *
 * Re-running the backfill scoped to gaps:
 *   The script prints, at the end, ready-to-paste backfill commands grouped
 *   by (clientId, locationId) covering only the missing/partial dates. They
 *   look like:
 *
 *     tsx scripts/backfill-location-heatmaps.ts --apply --confirm \
 *       --clients <clientId> --locations <locationId> \
 *       --campaigns <campaignId> --since <minMissingDate> --until <maxMissingDate>
 *
 *   Re-running is safe: triggerReportRefresh dedupes by
 *   (campaignId, trigger=manual, reportDate) so repeated invocations over
 *   the same window won't double-enqueue work.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  semrushLocationCampaigns,
  heatmapSnapshots,
} from "../shared/models/heatmap";
import { clients, clientLocations } from "../shared/models/clients";
import { getCampaign, getCampaignKeywords } from "../server/services/semrushApi";

const __filename_resolved = fileURLToPath(import.meta.url);
const __dirname_resolved = path.dirname(__filename_resolved);
const OUT_DIR = path.resolve(__dirname_resolved, "..", "verification");

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function splitList(v: string | boolean | undefined): string[] | undefined {
  if (typeof v !== "string") return undefined;
  const out = v.split(",").map((s) => s.trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

type Coverage = "ok" | "partial" | "missing" | "inconclusive";

interface TupleRow {
  clientId: string;
  clientName: string;
  locationId: string;
  locationName: string;
  campaignId: string;
  campaignName: string | null;
  reportDate: string;
  expectedKeywords: number | null;
  actualSnapshots: number;
  coverage: Coverage;
  note?: string;
}

const ACTIVE_KEYWORD_STATUSES = new Set(["COLLECTED", "UNKNOWN", "ACTIVE"]);

async function main() {
  const args = parseArgs(process.argv);
  const clientIds = splitList(args["clients"] as string | undefined);
  const locationIds = splitList(args["locations"] as string | undefined);
  const sinceMs = typeof args["since"] === "string" ? new Date(args["since"]).getTime() : null;
  const untilMs = typeof args["until"] === "string" ? new Date(args["until"]).getTime() : null;
  const jsonOnly = !!args["json-only"];

  if (sinceMs !== null && Number.isNaN(sinceMs)) {
    throw new Error(`Invalid --since: ${args["since"]}`);
  }
  if (untilMs !== null && Number.isNaN(untilMs)) {
    throw new Error(`Invalid --until: ${args["until"]}`);
  }

  // Pull mapping rows + display names in one go.
  const conditions = [eq(semrushLocationCampaigns.isStale, false)];
  if (clientIds?.length) {
    conditions.push(
      sql`${semrushLocationCampaigns.clientId} IN (${sql.join(
        clientIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  }
  if (locationIds?.length) {
    conditions.push(
      sql`${semrushLocationCampaigns.locationId} IN (${sql.join(
        locationIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  }

  const mappings = await db
    .select({
      clientId: semrushLocationCampaigns.clientId,
      clientName: clients.firmName,
      locationId: semrushLocationCampaigns.locationId,
      locationName: clientLocations.name,
      campaignId: semrushLocationCampaigns.semrushCampaignId,
      campaignName: semrushLocationCampaigns.semrushCampaignName,
    })
    .from(semrushLocationCampaigns)
    .leftJoin(clients, eq(clients.id, semrushLocationCampaigns.clientId))
    .leftJoin(clientLocations, eq(clientLocations.id, semrushLocationCampaigns.locationId))
    .where(and(...conditions));

  if (mappings.length === 0) {
    console.log("[verify-642] No semrush_location_campaigns mappings matched filters; nothing to verify.");
    process.exit(0);
  }

  console.log(`[verify-642] Verifying ${mappings.length} (client, location, campaign) mappings...`);

  // Cache campaign metadata + active keyword counts.
  // activeKeywordCount === null means "could not determine" (inconclusive).
  const campaignCache = new Map<
    string,
    {
      reportDates: string[];
      activeKeywordCount: number | null;
      campaignError?: string;
      keywordError?: string;
    }
  >();

  function countActive(kws: Array<{ status?: string }> | undefined): number | null {
    if (!Array.isArray(kws)) return null;
    return kws.filter((k) => ACTIVE_KEYWORD_STATUSES.has(String(k?.status || "").toUpperCase())).length;
  }

  async function loadCampaign(campaignId: string) {
    if (campaignCache.has(campaignId)) return campaignCache.get(campaignId)!;
    let reportDates: string[] = [];
    let campaignError: string | undefined;
    try {
      const camp = await getCampaign(campaignId);
      reportDates = Array.isArray(camp?.reportDates) ? camp.reportDates : [];
      // Even if campaign has an inline keyword list, statuses there are not
      // guaranteed to be present — always fetch the canonical list.
    } catch (err: any) {
      campaignError = err?.message || String(err);
    }

    let activeKeywordCount: number | null = null;
    let keywordError: string | undefined;
    try {
      const kws = await getCampaignKeywords(campaignId);
      activeKeywordCount = countActive(kws);
    } catch (err: any) {
      keywordError = err?.message || String(err);
    }

    const v = { reportDates, activeKeywordCount, campaignError, keywordError };
    campaignCache.set(campaignId, v);
    return v;
  }

  function dayBounds(rd: string): { start: Date; end: Date } | null {
    const t = new Date(rd);
    if (Number.isNaN(t.getTime())) return null;
    const start = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 0, 0, 0, 0));
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, end };
  }

  const rows: TupleRow[] = [];
  const campaignFetchFailures = new Map<string, string>(); // campaignId -> error (deduped)

  for (const m of mappings) {
    const camp = await loadCampaign(m.campaignId);
    if (camp.campaignError) {
      campaignFetchFailures.set(m.campaignId, camp.campaignError);
      // Emit a single inconclusive row so the (client, location) pair stays
      // visible in the per-location coverage table even when we can't
      // enumerate report dates from SEMrush.
      rows.push({
        clientId: m.clientId,
        clientName: m.clientName ?? "(unknown)",
        locationId: m.locationId,
        locationName: m.locationName ?? "(unknown)",
        campaignId: m.campaignId,
        campaignName: m.campaignName,
        reportDate: "(campaign fetch failed)",
        expectedKeywords: null,
        actualSnapshots: 0,
        coverage: "inconclusive",
        note: `campaign fetch failed: ${camp.campaignError}`,
      });
      continue;
    }
    for (const rd of camp.reportDates) {
      const bounds = dayBounds(rd);
      if (!bounds) continue;
      const ts = bounds.start.getTime();
      if (sinceMs !== null && ts < sinceMs) continue;
      if (untilMs !== null && ts > untilMs) continue;

      // Day-level match: importHeatmap dedupes by day, so any snapshot whose
      // reportDate falls inside the campaign reportDate's UTC day counts.
      // Distinct keywordId so we measure keyword coverage, not raw rows.
      const [{ count }] = await db
        .select({ count: sql<number>`count(distinct ${heatmapSnapshots.keywordId})::int` })
        .from(heatmapSnapshots)
        .where(
          and(
            eq(heatmapSnapshots.clientId, m.clientId),
            eq(heatmapSnapshots.locationId, m.locationId),
            eq(heatmapSnapshots.campaignId, m.campaignId),
            sql`${heatmapSnapshots.reportDate} >= ${bounds.start}`,
            sql`${heatmapSnapshots.reportDate} < ${bounds.end}`,
          ),
        );

      const actual = Number(count) || 0;
      const expected = camp.activeKeywordCount;

      let coverage: Coverage;
      let note: string | undefined;
      if (expected === null) {
        coverage = "inconclusive";
        note = camp.keywordError
          ? `keyword fetch failed: ${camp.keywordError}`
          : "active keyword count unknown";
      } else if (expected === 0) {
        // Backfill skips campaigns with no active keywords, so absence of
        // snapshots is expected and not a gap.
        coverage = "ok";
        note = "campaign has no active keywords";
      } else if (actual === 0) {
        coverage = "missing";
      } else if (actual < expected) {
        coverage = "partial";
      } else {
        coverage = "ok";
      }

      rows.push({
        clientId: m.clientId,
        clientName: m.clientName ?? "(unknown)",
        locationId: m.locationId,
        locationName: m.locationName ?? "(unknown)",
        campaignId: m.campaignId,
        campaignName: m.campaignName,
        reportDate: rd,
        expectedKeywords: expected,
        actualSnapshots: actual,
        coverage,
        note,
      });
    }
  }

  // ─── Aggregate ───
  const byCoverage = { ok: 0, partial: 0, missing: 0, inconclusive: 0 };
  rows.forEach((r) => byCoverage[r.coverage]++);

  type LocAgg = {
    clientId: string;
    clientName: string;
    locationId: string;
    locationName: string;
    total: number;
    ok: number;
    partial: number;
    missing: number;
    inconclusive: number;
  };
  const byLoc = new Map<string, LocAgg>();
  for (const r of rows) {
    const key = `${r.clientId}::${r.locationId}`;
    let a = byLoc.get(key);
    if (!a) {
      a = {
        clientId: r.clientId,
        clientName: r.clientName,
        locationId: r.locationId,
        locationName: r.locationName,
        total: 0,
        ok: 0,
        partial: 0,
        missing: 0,
        inconclusive: 0,
      };
      byLoc.set(key, a);
    }
    a.total++;
    a[r.coverage]++;
  }

  // ─── Console summary ───
  console.log("\n=== Per-location coverage ===");
  for (const a of Array.from(byLoc.values()).sort((x, y) =>
    `${x.clientName}/${x.locationName}`.localeCompare(`${y.clientName}/${y.locationName}`),
  )) {
    const status =
      a.missing > 0 ? "✗" : a.partial > 0 ? "!" : a.inconclusive > 0 ? "?" : "✓";
    console.log(
      `  ${status} ${a.clientName} / ${a.locationName}` +
        ` — ok=${a.ok} partial=${a.partial} missing=${a.missing}` +
        ` inconclusive=${a.inconclusive} (of ${a.total} dates)`,
    );
  }

  console.log("\n=== Summary ===");
  console.log(`  mappings:               ${mappings.length}`);
  console.log(`  campaigns fetched:      ${campaignCache.size - campaignFetchFailures.size}`);
  console.log(`  campaign fetch errors:  ${campaignFetchFailures.size}`);
  console.log(`  date tuples evaluated:  ${rows.length}`);
  console.log(`    ok:                   ${byCoverage.ok}`);
  console.log(`    partial:              ${byCoverage.partial}`);
  console.log(`    missing:              ${byCoverage.missing}`);
  console.log(`    inconclusive:         ${byCoverage.inconclusive}`);

  if (campaignFetchFailures.size > 0) {
    console.log("\n-- campaign fetch failures (treated as inconclusive) --");
    for (const [campaignId, error] of campaignFetchFailures) {
      console.log(`  ${campaignId}: ${error}`);
    }
  }

  const gaps = rows.filter((r) => r.coverage !== "ok");
  if (gaps.length > 0) {
    console.log(`\n-- gap tuples (${gaps.length}) --`);
    for (const r of gaps.slice(0, 50)) {
      const exp = r.expectedKeywords === null ? "?" : String(r.expectedKeywords);
      console.log(
        `  [${r.coverage}] client=${r.clientName} loc=${r.locationName} camp=${r.campaignId} date=${r.reportDate}` +
          ` actual=${r.actualSnapshots}/${exp}` +
          (r.note ? ` (${r.note})` : ""),
      );
    }
    if (gaps.length > 50) console.log(`  ...and ${gaps.length - 50} more (see JSON report)`);
  }

  // ─── Suggested re-run commands ───
  // Only include actionable gaps (missing/partial). Inconclusive tuples are
  // listed separately so an operator can decide whether to investigate the
  // SEMrush keyword fetch failure first before re-running backfill blindly.
  type GapKey = string;
  const gapsByLocCamp = new Map<
    GapKey,
    { clientId: string; locationId: string; campaignId: string; dates: string[] }
  >();
  for (const r of gaps) {
    if (r.coverage === "inconclusive") continue;
    const k = `${r.clientId}|${r.locationId}|${r.campaignId}`;
    let g = gapsByLocCamp.get(k);
    if (!g) {
      g = { clientId: r.clientId, locationId: r.locationId, campaignId: r.campaignId, dates: [] };
      gapsByLocCamp.set(k, g);
    }
    g.dates.push(r.reportDate);
  }

  const rerunCommands: string[] = [];
  for (const g of gapsByLocCamp.values()) {
    const sorted = g.dates
      .map((d) => d.slice(0, 10))
      .sort();
    const since = sorted[0];
    const until = sorted[sorted.length - 1];
    rerunCommands.push(
      `tsx scripts/backfill-location-heatmaps.ts --apply --confirm` +
        ` --clients ${g.clientId} --locations ${g.locationId}` +
        ` --campaigns ${g.campaignId} --since ${since} --until ${until}`,
    );
  }

  if (rerunCommands.length > 0) {
    console.log("\n-- suggested gap-scoped re-runs --");
    for (const c of rerunCommands) console.log(`  ${c}`);
  }

  // ─── Persisted reports ───
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const json = {
    generatedAt: new Date().toISOString(),
    filters: {
      clientIds: clientIds ?? null,
      locationIds: locationIds ?? null,
      since: typeof args["since"] === "string" ? args["since"] : null,
      until: typeof args["until"] === "string" ? args["until"] : null,
    },
    summary: {
      mappings: mappings.length,
      campaignsFetched: campaignCache.size - campaignFetchFailures.size,
      campaignFetchFailures: campaignFetchFailures.size,
      dateTuples: rows.length,
      ok: byCoverage.ok,
      partial: byCoverage.partial,
      missing: byCoverage.missing,
      inconclusive: byCoverage.inconclusive,
    },
    perLocation: Array.from(byLoc.values()),
    rows,
    gaps,
    campaignFetchFailures: Array.from(campaignFetchFailures, ([campaignId, error]) => ({
      campaignId,
      error,
    })),
    rerunCommands,
  };
  fs.writeFileSync(path.join(OUT_DIR, "task-642-results.json"), JSON.stringify(json, null, 2));

  if (!jsonOnly) {
    const md: string[] = [];
    md.push("# Task 642 — Per-location Heatmap Snapshot Coverage");
    md.push(`Generated: ${json.generatedAt}`);
    md.push("");
    md.push(
      `**Summary:** ${rows.length} (client, location, campaign, reportDate) tuples checked` +
        ` — ${byCoverage.ok} ok / ${byCoverage.partial} partial / ${byCoverage.missing} missing` +
        ` / ${byCoverage.inconclusive} inconclusive.`,
    );
    if (campaignFetchFailures.size > 0) {
      md.push(`**Inconclusive campaigns (fetch failed):** ${campaignFetchFailures.size}`);
    }
    md.push("");
    md.push("## Per-location coverage");
    md.push("| Client | Location | OK | Partial | Missing | Inconclusive | Total dates |");
    md.push("|---|---|---|---|---|---|---|");
    for (const a of Array.from(byLoc.values()).sort((x, y) =>
      `${x.clientName}/${x.locationName}`.localeCompare(`${y.clientName}/${y.locationName}`),
    )) {
      md.push(
        `| ${a.clientName} | ${a.locationName} | ${a.ok} | ${a.partial} | ${a.missing}` +
          ` | ${a.inconclusive} | ${a.total} |`,
      );
    }
    if (gaps.length > 0) {
      md.push("");
      md.push("## Gap tuples");
      md.push("| Client | Location | Campaign | Report date | Actual | Expected | Coverage | Note |");
      md.push("|---|---|---|---|---|---|---|---|");
      for (const r of gaps) {
        const exp = r.expectedKeywords === null ? "?" : String(r.expectedKeywords);
        md.push(
          `| ${r.clientName} | ${r.locationName} | ${r.campaignName ?? r.campaignId} | ${r.reportDate}` +
            ` | ${r.actualSnapshots} | ${exp} | ${r.coverage} | ${(r.note || "").replace(/\|/g, "\\|")} |`,
        );
      }
    }
    if (rerunCommands.length > 0) {
      md.push("");
      md.push("## Re-run backfill scoped to gaps");
      md.push("```bash");
      for (const c of rerunCommands) md.push(c);
      md.push("```");
      md.push("");
      md.push(
        "Re-runs are safe to repeat: `triggerReportRefresh` dedupes by " +
          "`(campaignId, trigger=manual, reportDate)` so the same window won't double-enqueue work.",
      );
    }
    fs.writeFileSync(path.join(OUT_DIR, "task-642-coverage-report.md"), md.join("\n"));
  }

  console.log(`\nResults: verification/task-642-results.json`);
  if (!jsonOnly) console.log(`Report:  verification/task-642-coverage-report.md`);

  // Exit code: non-zero only if any tuples are actually missing (partial/inconclusive
  // are warnings — operators may still want to inspect).
  process.exit(byCoverage.missing > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("[verify-task-642] FAILED:", e);
  process.exit(2);
});
