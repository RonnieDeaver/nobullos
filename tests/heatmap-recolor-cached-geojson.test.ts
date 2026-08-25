/* test-registration
{
  "name": "Heatmap recolor cached GeoJSON (Task #2567)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Smoke-gate member migrated from the pre-#3786 SMOKE_FILES set (no explanatory comment was recorded).",
  "tier": "small"
}
test-registration */
/**
 * Regression test for task #2567: the served heatmap GeoJSON must always carry
 * valid, position-derived colors on every cell, so the report renders rank-band
 * colors instead of flat/uncolored (or black) grid cells.
 *
 * The root-cause hardening re-derives each cell's colors/labels from its stored
 * `position` / `diff` on every serve (recolorCachedGeoJSON), instead of trusting
 * whatever colors an older buildGeoJSON happened to bake into the cache. This:
 *   - repairs legacy cache shapes that are missing `rankColor` (or carry
 *     "#"-prefixed labels) so they still serve fully-colored cells,
 *   - degrades a cell with a null position to the explicit unranked slate
 *     rather than an absent color (which would let the frontend paint it black),
 *   - and signals (returns false) when a cache predates `position` storage so
 *     the caller rebuilds from the points table.
 *
 * This is a pure-function test (no DB) — recolorCachedGeoJSON mutates the cache
 * object in place and returns whether it could be re-derived.
 */

import { recolorCachedGeoJSON } from "../server/services/heatmapService";
import { HEATMAP_UNRANKED_FILL_COLOR } from "@shared/heatmapColors";

const UNRANKED_SLATE = HEATMAP_UNRANKED_FILL_COLOR;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function cell(props: Record<string, unknown>) {
  return {
    type: "Feature" as const,
    properties: props,
    geometry: { type: "Polygon" as const, coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] },
  };
}

function businessPin() {
  return {
    type: "Feature" as const,
    properties: { type: "business", name: "Biz" },
    geometry: { type: "Point" as const, coordinates: [0, 0] },
  };
}

function main() {
  // 1) Legacy cache shape: cells carry `position` but are MISSING rankColor and
  //    have "#"-prefixed labels (the Ackah Calgary shape). After re-derivation
  //    every cell must carry a valid rankColor and a clean (no "#") label, and
  //    `color` must equal the rank color for rank mode.
  const legacy = {
    type: "FeatureCollection" as const,
    features: [
      cell({ position: 2, diff: 0, label: "#2", rankLabel: "#2" }),   // top3
      cell({ position: 9, diff: -1, label: "#9", rankLabel: "#9" }),  // top10
      cell({ position: 17, diff: 0, label: "#17", rankLabel: "#17" }),// top20
      cell({ position: 21, diff: 0, label: "#21", rankLabel: "#21" }),// beyond20
      businessPin(),
    ],
  };
  const ok1 = recolorCachedGeoJSON(legacy, "rank");
  assert(ok1 === true, "legacy cache with position present must be re-derivable (true)");
  const legacyCells = legacy.features.filter((f: any) => f.properties?.type !== "business");
  for (const f of legacyCells as any[]) {
    assert(
      typeof f.properties.rankColor === "string" && f.properties.rankColor.length > 0,
      "every cell must have a rankColor after re-derivation",
    );
    assert(f.properties.color === f.properties.rankColor, "color must equal rankColor in rank mode");
    assert(
      typeof f.properties.label === "string" && !f.properties.label.startsWith("#"),
      `label must be re-derived clean (no leading '#'), got ${f.properties.label}`,
    );
  }
  // The four positions span four distinct rank bands -> four distinct colors.
  const distinct = new Set(legacyCells.map((f: any) => f.properties.rankColor));
  assert(distinct.size === 4, `expected 4 distinct rank-band colors, got ${distinct.size}`);
  // None of them is the unranked slate (all are ranked).
  assert(![...distinct].includes(UNRANKED_SLATE), "ranked cells must not be the unranked slate");

  // 2) A cell genuinely lacking rank data (position null) must degrade to the
  //    explicit unranked slate — never an absent/black color.
  const unranked = {
    type: "FeatureCollection" as const,
    features: [cell({ position: null, diff: null }), businessPin()],
  };
  const ok2 = recolorCachedGeoJSON(unranked, "rank");
  assert(ok2 === true, "cache with a null-position cell is still re-derivable");
  const u = (unranked.features[0] as any).properties;
  assert(u.rankColor === UNRANKED_SLATE, `null position must yield the unranked slate, got ${u.rankColor}`);
  assert(u.color === UNRANKED_SLATE, "null position color must be the unranked slate in rank mode");
  assert(u.label === "Not ranked", `null position label must be 'Not ranked', got ${u.label}`);

  // 3) Movement mode derives color from movement (diff), and labels from
  //    movement labels.
  const mv = {
    type: "FeatureCollection" as const,
    features: [cell({ position: 5, diff: 3 }), cell({ position: 5, diff: -2 }), businessPin()],
  };
  const ok3 = recolorCachedGeoJSON(mv, "movement");
  assert(ok3 === true, "movement-mode re-derivation must succeed");
  const improved = (mv.features[0] as any).properties;
  const declined = (mv.features[1] as any).properties;
  assert(improved.color === improved.movementColor, "movement mode: color must equal movementColor");
  assert(improved.movementColor !== declined.movementColor, "improved vs declined must differ in movement color");
  assert(improved.label === improved.movementLabel, "movement mode: label must equal movementLabel");

  // 4) A cache shape that predates `position` storage (no position key) cannot
  //    be re-derived -> returns false so the caller rebuilds from the DB.
  const tooOld = {
    type: "FeatureCollection" as const,
    features: [cell({ color: "#abcabc", label: "x" }), businessPin()],
  };
  const ok4 = recolorCachedGeoJSON(tooOld, "rank");
  assert(ok4 === false, "cache with cells lacking `position` must return false (force rebuild)");

  // 5) Empty / malformed inputs return false rather than throwing.
  assert(recolorCachedGeoJSON(null, "rank") === false, "null cache returns false");
  assert(recolorCachedGeoJSON({}, "rank") === false, "cache without features returns false");
  assert(
    recolorCachedGeoJSON({ type: "FeatureCollection", features: [businessPin()] }, "rank") === false,
    "cache with only a business pin (no cells) returns false",
  );

  console.log("heatmap-recolor-cached-geojson: all cases passed");
}

main();
