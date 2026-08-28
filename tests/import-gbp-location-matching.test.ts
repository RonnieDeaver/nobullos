/* test-registration
{
  "name": "Import GBP location matching",
  "tier": "small"
}
test-registration */
/**
 * Verifies the two halves of the GBP-location ghost fix:
 *
 *   1. mergeImportedGbpLocations (client/src/lib/gbpLocationMerge.ts) — the
 *      pure helper that the PDF import handler uses to merge parsed rows into
 *      the report's existing marketing.gbp.locations array. Task #2568: it now
 *      returns { merged, unresolved }. A parsed row is merged only when it
 *      resolves (exact OR parenthetical "(City)") to an existing report row or
 *      a Command Panel location; otherwise it is collected in `unresolved` and
 *      surfaced to the operator — NEVER silently appended as a fresh-UUID
 *      "confident" row. That fresh-UUID branch is exactly how a foreign source
 *      PDF (e.g. Lansing / Waverly) became published GBP rows on a Lehi / Las
 *      Vegas client.
 *
 *   2. planReportCleanup (scripts/cleanup-ghost-gbp-locations.ts) — the
 *      planner used by the one-shot cleanup script that walks every
 *      report and decides which rows to keep vs. drop. Per the operator
 *      decision, ghosts are simply DROPPED (no merging) because reps
 *      have already manually moved the right numbers onto the real
 *      command-panel rows.
 *
 * Failure modes guarded against:
 *   - PDF import minting random-UUID ghost rows for names that resolve to
 *     neither the report nor the command panel (foreign-location regression).
 *   - Parenthetical "Firm (City)" command-panel names failing to resolve a
 *     short PDF city name.
 *   - Cleanup script accidentally merging or keeping ghost rows.
 *   - Normalization regressions (case / punctuation / parens / whitespace).
 */

import {
  mergeImportedGbpLocations,
  normalizeGbpLocationName,
  type GbpLocationLite,
  type CommandPanelLocationLite,
} from "../client/src/lib/gbpLocationMerge";
import { planReportCleanup } from "../scripts/cleanup-ghost-gbp-locations";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

let counter = 0;
const fakeId = () => `fake-${++counter}`;

function reset() {
  counter = 0;
}

function run(name: string, fn: () => void) {
  reset();
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}`);
    throw e;
  }
}

console.log("normalizeGbpLocationName");
run("collapses case, punctuation, parens, and whitespace", () => {
  assert(normalizeGbpLocationName("Speedwell Law, PLLC (Alexandria)") ===
         normalizeGbpLocationName("speedwell law pllc alexandria"),
         "punct + parens + case differences should normalize equal");
  assert(normalizeGbpLocationName("Adolphe Law Group  ") === normalizeGbpLocationName("adolphe law group"),
         "trailing whitespace should normalize away");
  assert(normalizeGbpLocationName("Lake-Worth") !== normalizeGbpLocationName("Lake Worth"),
         "hyphen is preserved (intentionally narrow normalization)");
});

console.log("\nmergeImportedGbpLocations");

run("matches by name to existing report row, preserves id and heatmap", () => {
  const existing: GbpLocationLite[] = [
    {
      id: "real-1",
      name: "Adolphe Law Group",
      uniqueLeads: 0,
      heatmapSnapshotId: "snap-xyz",
      heatmapSnapshotIds: ["snap-xyz"],
      heatmapImageUrl: "https://heatmap/xyz",
    },
  ];
  const imported: GbpLocationLite[] = [
    { id: "ghost-1", name: "adolphe law group", uniqueLeads: 7, reviewsGenerated: 2 },
  ];
  const out = mergeImportedGbpLocations(existing, imported, [], fakeId);
  assert(out.merged.length === 1, `expected 1 merged row, got ${out.merged.length}`);
  assert(out.unresolved.length === 0, `expected nothing unresolved, got ${out.unresolved.length}`);
  assert(out.merged[0].id === "real-1", `id should be preserved, got ${out.merged[0].id}`);
  assert(out.merged[0].name === "Adolphe Law Group", `name should be preserved canonical casing, got ${out.merged[0].name}`);
  assert(out.merged[0].uniqueLeads === 7, `uniqueLeads from import, got ${out.merged[0].uniqueLeads}`);
  assert(out.merged[0].reviewsGenerated === 2, `reviewsGenerated from import`);
  assert(out.merged[0].heatmapSnapshotId === "snap-xyz", `heatmap snapshot id preserved`);
  assert(out.merged[0].heatmapImageUrl === "https://heatmap/xyz", `heatmap image url preserved`);
});

run("resolves a short PDF city name to a parenthetical command-panel name", () => {
  const cp: CommandPanelLocationLite[] = [
    { id: "cp-alex", name: "Speedwell Law, PLLC (Alexandria)" },
  ];
  const imported: GbpLocationLite[] = [
    { id: "would-be-ghost", name: "Alexandria", uniqueLeads: 5 },
  ];
  // Task #2568: the command panel calls it long-form "Firm (Alexandria)" and
  // the PDF calls it short-form "Alexandria". The parenthetical-aware matcher
  // now resolves these to the same place and uses the command-panel id —
  // legit short city names must NOT become ghosts.
  const out = mergeImportedGbpLocations([], imported, cp, fakeId);
  assert(out.merged.length === 1, `expected 1 merged row, got ${out.merged.length}`);
  assert(out.unresolved.length === 0, `expected nothing unresolved, got ${out.unresolved.length}`);
  assert(out.merged[0].id === "cp-alex", `should use command-panel id, got ${out.merged[0].id}`);
  assert(out.merged[0].uniqueLeads === 5, `metrics from import`);
});

run("uses canonical command-panel id when normalized names actually match", () => {
  const cp: CommandPanelLocationLite[] = [
    { id: "cp-fp", name: "Adolphe Law Group Fort Pierce" },
  ];
  const imported: GbpLocationLite[] = [
    { id: "would-be-ghost", name: "adolphe law group fort pierce", uniqueLeads: 3 },
  ];
  const out = mergeImportedGbpLocations([], imported, cp, fakeId);
  assert(out.merged.length === 1);
  assert(out.unresolved.length === 0, `expected nothing unresolved`);
  assert(out.merged[0].id === "cp-fp", `should use command-panel id, got ${out.merged[0].id}`);
  assert(out.merged[0].name === "Adolphe Law Group Fort Pierce", `should use command-panel name`);
  assert(out.merged[0].uniqueLeads === 3);
});

run("collects an unmatched row as unresolved instead of minting a ghost UUID", () => {
  const out = mergeImportedGbpLocations(
    [{ id: "other", name: "Some Other Place" }],
    [{ id: "x", name: "Brand New Office", uniqueLeads: 1 }],
    [{ id: "cp1", name: "Yet Another Place" }],
    fakeId,
  );
  // Only the pre-existing report row survives; the novel name is NOT appended.
  assert(out.merged.length === 1, `expected 1 merged row, got ${out.merged.length}`);
  assert(out.merged[0].id === "other", `pre-existing row preserved, got ${out.merged[0].id}`);
  assert(!out.merged.some(r => r.name === "Brand New Office"), "novel row must NOT be appended as a confident row");
  assert(out.unresolved.length === 1, `expected 1 unresolved, got ${out.unresolved.length}`);
  assert(out.unresolved[0].name === "Brand New Office", `unresolved should carry the parsed name`);
});

run("foreign-city import (Lansing/Waverly on a Lehi/Las Vegas client) is unresolved, never a ghost row", () => {
  // This is the exact failure that produced the bad Trusted Estate report:
  // a PDF from the wrong source carried cities that belong to no command-panel
  // location. They must surface as unresolved, not silently become GBP rows.
  const cp: CommandPanelLocationLite[] = [
    { id: "cp-lehi", name: "Trusted Estate Planning Attorneys (Lehi)" },
    { id: "cp-lv", name: "Trusted Estate Planning Attorneys (Las Vegas)" },
  ];
  const imported: GbpLocationLite[] = [
    { id: "ghost-lansing", name: "Lansing", uniqueLeads: 12 },
    { id: "ghost-waverly", name: "Waverly", uniqueLeads: 8 },
  ];
  const out = mergeImportedGbpLocations([], imported, cp, fakeId);
  assert(out.merged.length === 0, `expected NO merged rows, got ${out.merged.length}`);
  assert(out.unresolved.length === 2, `expected 2 unresolved, got ${out.unresolved.length}`);
  const names = out.unresolved.map(u => u.name).sort();
  assert(names[0] === "Lansing" && names[1] === "Waverly", `unresolved should be Lansing + Waverly, got ${names.join(",")}`);
});

run("intra-batch dedupe collapses two imported rows with same name (still resolved via command panel)", () => {
  const cp: CommandPanelLocationLite[] = [
    { id: "cp-lw", name: "Lake Worth" },
  ];
  const imported: GbpLocationLite[] = [
    { id: "a", name: "Lake Worth", uniqueLeads: 4 },
    { id: "b", name: "lake worth", uniqueLeads: 6 },
  ];
  const out = mergeImportedGbpLocations([], imported, cp, fakeId);
  assert(out.merged.length === 1, `expected dedupe to collapse to 1, got ${out.merged.length}`);
  assert(out.unresolved.length === 0, `expected nothing unresolved, got ${out.unresolved.length}`);
  // After deduplicateGbpLocations runs, the two imported rows have already been
  // summed into one, so the resulting metric is 4+6=10.
  assert(out.merged[0].uniqueLeads === 10, `expected summed metrics 10, got ${out.merged[0].uniqueLeads}`);
});

run("dedupe of two unmatched rows yields a single unresolved entry, no ghost", () => {
  const imported: GbpLocationLite[] = [
    { id: "a", name: "Nowhere City", uniqueLeads: 4 },
    { id: "b", name: "nowhere city", uniqueLeads: 6 },
  ];
  const out = mergeImportedGbpLocations([], imported, [], fakeId);
  assert(out.merged.length === 0, `expected no merged rows, got ${out.merged.length}`);
  assert(out.unresolved.length === 1, `expected dedupe to collapse unresolved to 1, got ${out.unresolved.length}`);
});

run("does not duplicate when imported row matches both existing report row and command panel", () => {
  const existing: GbpLocationLite[] = [
    { id: "real-1", name: "Lake Worth", uniqueLeads: 0 },
  ];
  const cp: CommandPanelLocationLite[] = [
    { id: "cp-lw", name: "Lake Worth" },
  ];
  const imported: GbpLocationLite[] = [
    { id: "x", name: "Lake Worth", uniqueLeads: 9 },
  ];
  const out = mergeImportedGbpLocations(existing, imported, cp, fakeId);
  assert(out.merged.length === 1, `expected no duplicates, got ${out.merged.length}`);
  assert(out.unresolved.length === 0, `expected nothing unresolved`);
  assert(out.merged[0].id === "real-1", `should keep existing report row id, got ${out.merged[0].id}`);
  assert(out.merged[0].uniqueLeads === 9, `metrics from import`);
});

console.log("\nplanReportCleanup");

run("KEEPs rows whose id is in command panel; DROPs rows whose id is not", () => {
  const cpIds = new Set(["cp-1", "cp-2"]);
  const locations = [
    { id: "cp-1", name: "Adolphe Law Group" },
    { id: "ghost-a", name: "Lake Worth" },
    { id: "cp-2", name: "Adolphe Law Group Fort Pierce" },
    { id: "ghost-b", name: "Fort Pierce", uniqueLeads: 99 },
  ];
  const plan = planReportCleanup("r1", "client-1", "2026-03", locations, cpIds);
  assert(plan.changed, "plan should report changes");
  assert(plan.rows.length === 4);
  assert(plan.rows[0].action === "KEEP" && plan.rows[2].action === "KEEP");
  assert(plan.rows[1].action === "DROP-GHOST" && plan.rows[3].action === "DROP-GHOST");
  assert(plan.cleaned.length === 2, `cleaned should have 2 rows, got ${plan.cleaned.length}`);
  assert(plan.cleaned[0].id === "cp-1" && plan.cleaned[1].id === "cp-2");
});

run("does NOT keep ghost rows even if they have non-zero metrics", () => {
  const cpIds = new Set(["cp-1"]);
  const locations = [
    { id: "cp-1", name: "Real Place", uniqueLeads: 10 },
    { id: "ghost-rich", name: "Ghost With Data", uniqueLeads: 99, reviewsGenerated: 5 },
  ];
  const plan = planReportCleanup("r2", "client-1", "2026-03", locations, cpIds);
  assert(plan.cleaned.length === 1, "ghost with data is still dropped — reps already moved its data manually");
  assert(plan.cleaned[0].id === "cp-1");
});

run("is idempotent — re-running on cleaned output reports no changes", () => {
  const cpIds = new Set(["cp-1", "cp-2"]);
  const locations = [
    { id: "cp-1", name: "A" },
    { id: "ghost", name: "B" },
    { id: "cp-2", name: "C" },
  ];
  const first = planReportCleanup("r3", "c1", "2026-03", locations, cpIds);
  const second = planReportCleanup("r3", "c1", "2026-03", first.cleaned, cpIds);
  assert(first.changed, "first pass should change");
  assert(!second.changed, "second pass on cleaned data should report no changes");
});

run("handles empty / malformed locations safely", () => {
  const cpIds = new Set(["cp-1"]);
  const planEmpty = planReportCleanup("r", "c", "2026-03", [], cpIds);
  assert(!planEmpty.changed && planEmpty.cleaned.length === 0);
  const planMissingId = planReportCleanup("r", "c", "2026-03", [{ name: "no-id" } as any], cpIds);
  assert(planMissingId.changed, "row with no id is a ghost");
  assert(planMissingId.cleaned.length === 0);
});

console.log("\nAll import-gbp-location-matching assertions passed.");
