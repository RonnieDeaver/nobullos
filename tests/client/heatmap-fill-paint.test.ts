/* test-registration
{
  "name": "Heatmap fill paint",
  "smoke": true,
  "smokeReason": "Task #2601: the two heatmap regression tests guard the \"flat-gray / black heatmap\" rendering bug (fill-color collapsing to a constant, or a null coalesce fallback that MapLibre paints black) and now also exercise the shared palette. They were flagged `regression: true` but never selected by the gate, so a recolor/paint regression could slip through the routine run unnoticed — the exact \"regression-flagged-but-unselected\" rot this codebase has hit before. Both are fast, deterministic, DB-free pure-function tests.",
  "tier": "small"
}
test-registration */
/**
 * Smoke test: catches the "flat-gray heatmap" regression where the heatmap-fill
 * layer's fill-color paint property silently collapses to a constant string
 * (e.g. "#94a3b8") instead of the data-driven coalesce expression that picks
 * up each cell's rankColor.
 *
 * The shape we guard against (originally fixed in task #529):
 *   - fill-color is set to a string literal -> every cell paints the same color.
 *   - fill-opacity for non-edge cells collapses to 0 -> all fills invisible.
 *
 * This test stubs a maplibre-gl Map, runs buildGeoJSON to produce a real
 * fixture from the heatmap service, applies the same paint helpers the
 * InteractiveHeatmap component uses, and asserts on the resulting paint
 * properties.
 */

import {
  applyHeatmapPaint,
  buildHeatmapFillColorExpr,
  buildHeatmapFillOpacityExpr,
  HEATMAP_FILL_COLOR_EXPR,
  HEATMAP_FILL_OPACITY_EXPR,
  HEATMAP_UNRANKED_FILL_COLOR,
} from "../../client/src/components/heatmapPaint";
import { buildGeoJSON } from "../../server/services/heatmapService";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// The fill-color coalesce MUST end with a terminal string literal fallback so a
// cell carrying neither rankColor nor color resolves to the explicit unranked
// slate rather than null (which MapLibre paints BLACK — the silent "broken
// heatmap" look fixed in task #2567). Without this, an old/partial cached shape
// or a snapshot lacking position data renders invisible/black cells.
function hasTerminalLiteralFallback(value: unknown): boolean {
  if (!Array.isArray(value) || value[0] !== "coalesce") return false;
  const last = value[value.length - 1];
  return typeof last === "string" && last.length > 0;
}

class StubLayer {
  paint: Record<string, unknown> = {};
}

class StubMap {
  private layers = new Map<string, StubLayer>();

  addLayer(spec: { id: string; paint?: Record<string, unknown> }): void {
    const layer = new StubLayer();
    if (spec.paint) layer.paint = { ...spec.paint };
    this.layers.set(spec.id, layer);
  }

  getLayer(id: string): StubLayer | undefined {
    return this.layers.get(id);
  }

  setPaintProperty(layerId: string, prop: string, value: unknown): void {
    const layer = this.layers.get(layerId);
    if (!layer) throw new Error(`StubMap: unknown layer ${layerId}`);
    layer.paint[prop] = value;
  }

  getPaintProperty(layerId: string, prop: string): unknown {
    const layer = this.layers.get(layerId);
    if (!layer) throw new Error(`StubMap: unknown layer ${layerId}`);
    return layer.paint[prop];
  }
}

function makeFixtureSnapshot() {
  return {
    id: "snap-1",
    locationName: "Test Location",
    keywordName: "test keyword",
    businessName: "Test Biz",
    businessLat: 30.0,
    businessLng: -97.0,
    baseLat: 30.0,
    baseLng: -97.0,
    gridDistance: 5,
    gridUnit: "MI",
    gridTemplate: "3x3",
    reportDate: new Date().toISOString(),
  } as any;
}

function makeFixturePoints() {
  // 3x3 grid centered near (30, -97). Each point has a real rankColor so the
  // coalesce expression has data to resolve to per cell.
  const points: any[] = [];
  let pid = 1;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      points.push({
        pointId: `p${pid++}`,
        lat: 29.98 + i * 0.01,
        lng: -97.02 + j * 0.01,
        position: ((i * 3 + j) % 21) + 1,
        diff: 0,
      });
    }
  }
  return points;
}

function evalCaseEdgeExpression(expr: unknown[], isEdge: 0 | 1): number {
  // expr shape: ["case", ["==", ["get", "isEdge"], 1], edgeVal, defaultVal]
  assert(Array.isArray(expr) && expr[0] === "case", "fill-opacity must be a case expression");
  const cond = expr[1] as unknown[];
  assert(
    Array.isArray(cond) && cond[0] === "==" &&
      Array.isArray(cond[1]) && (cond[1] as any[])[0] === "get" && (cond[1] as any[])[1] === "isEdge" &&
      cond[2] === 1,
    "fill-opacity case condition must compare get('isEdge') to 1",
  );
  const edgeVal = expr[2] as number;
  const defaultVal = expr[3] as number;
  return isEdge === 1 ? edgeVal : defaultVal;
}

function isCoalesceFillColorExpr(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (value[0] !== "coalesce") return false;
  // Must reference at least one feature property (rankColor) via ["get", "rankColor"]
  return value.some(
    (arg) =>
      Array.isArray(arg) &&
      (arg as any[])[0] === "get" &&
      (arg as any[])[1] === "rankColor",
  );
}

async function main() {
  // 1) The exported initial paint constants must already be data-driven
  //    expressions (not constant strings). This catches accidental
  //    "fill-color: '#xxxxxx'" regressions at the source-of-truth level.
  assert(
    isCoalesceFillColorExpr(HEATMAP_FILL_COLOR_EXPR),
    `HEATMAP_FILL_COLOR_EXPR must be a coalesce expression that reads rankColor, got: ${JSON.stringify(HEATMAP_FILL_COLOR_EXPR)}`,
  );
  assert(
    typeof HEATMAP_FILL_COLOR_EXPR !== ("string" as any),
    "HEATMAP_FILL_COLOR_EXPR must not be a constant string",
  );
  assert(
    hasTerminalLiteralFallback(HEATMAP_FILL_COLOR_EXPR),
    `HEATMAP_FILL_COLOR_EXPR must end with a terminal string literal fallback so cells never paint black, got: ${JSON.stringify(HEATMAP_FILL_COLOR_EXPR)}`,
  );
  assert(
    (HEATMAP_FILL_COLOR_EXPR as unknown[])[(HEATMAP_FILL_COLOR_EXPR as unknown[]).length - 1] === HEATMAP_UNRANKED_FILL_COLOR,
    "HEATMAP_FILL_COLOR_EXPR terminal fallback must be the documented unranked slate (HEATMAP_UNRANKED_FILL_COLOR)",
  );
  assert(
    hasTerminalLiteralFallback(buildHeatmapFillColorExpr()),
    "buildHeatmapFillColorExpr() must also end with a terminal string literal fallback",
  );
  const initialNonEdgeOpacity = evalCaseEdgeExpression(HEATMAP_FILL_OPACITY_EXPR as unknown[], 0);
  assert(
    initialNonEdgeOpacity > 0,
    `HEATMAP_FILL_OPACITY_EXPR non-edge opacity must be > 0, got ${initialNonEdgeOpacity}`,
  );

  // 2) Build a real fixture geojson via the service to make sure the shape
  //    the component consumes actually contains rankColor on every polygon
  //    feature — that's what the coalesce expression depends on.
  const geojson = buildGeoJSON(makeFixtureSnapshot(), makeFixturePoints(), "rank");
  const cellFeatures = geojson.features.filter((f: any) => f.geometry.type === "Polygon");
  assert(cellFeatures.length === 9, `expected 9 polygon cells in fixture, got ${cellFeatures.length}`);
  for (const f of cellFeatures) {
    assert(
      typeof (f as any).properties.rankColor === "string" && (f as any).properties.rankColor.length > 0,
      "every polygon feature must carry a rankColor string for the coalesce expression to resolve",
    );
  }
  // At least one non-edge cell exists so opacity assertions are meaningful.
  const nonEdgeCells = cellFeatures.filter((f: any) => f.properties.isEdge === 0);
  assert(nonEdgeCells.length >= 1, "fixture must contain at least one non-edge cell");

  // 3) Mount-equivalent: simulate the component's first paint by registering
  //    the heatmap-fill layer with the same initial paint config the
  //    component uses, then calling applyHeatmapPaint (which is what the
  //    component's data-loading effect calls after first paint).
  const map = new StubMap();
  map.addLayer({
    id: "heatmap-fill",
    paint: {
      "fill-color": HEATMAP_FILL_COLOR_EXPR,
      "fill-opacity": HEATMAP_FILL_OPACITY_EXPR,
    },
  });
  map.addLayer({ id: "heatmap-outline", paint: {} });
  map.addLayer({ id: "heatmap-labels", paint: {} });

  applyHeatmapPaint(map as any, /* isTransparent */ false);

  // 4) Core regression assertions on the resolved paint properties:
  const fillColor = map.getPaintProperty("heatmap-fill", "fill-color");
  assert(
    typeof fillColor !== "string",
    `heatmap-fill fill-color must NOT be a constant string after first paint (got ${JSON.stringify(fillColor)}). This is the flat-gray heatmap regression.`,
  );
  assert(
    isCoalesceFillColorExpr(fillColor),
    `heatmap-fill fill-color must be a coalesce expression reading rankColor, got: ${JSON.stringify(fillColor)}`,
  );
  // Sanity: the helper-built expr equals what we asserted on.
  const builtFillColor = buildHeatmapFillColorExpr();
  assert(
    JSON.stringify(builtFillColor) === JSON.stringify(fillColor),
    "buildHeatmapFillColorExpr() output must match what applyHeatmapPaint installs",
  );

  const fillOpacity = map.getPaintProperty("heatmap-fill", "fill-opacity") as unknown[];
  const nonEdgeOpacity = evalCaseEdgeExpression(fillOpacity, 0);
  const edgeOpacity = evalCaseEdgeExpression(fillOpacity, 1);
  assert(
    nonEdgeOpacity > 0,
    `heatmap-fill non-edge opacity must be > 0 after first paint (got ${nonEdgeOpacity}). Cells would be invisible.`,
  );
  assert(
    edgeOpacity > 0,
    `heatmap-fill edge opacity must be > 0 after first paint (got ${edgeOpacity}).`,
  );

  // 5) Transparent (X-Ray) mode still scales > 0 for non-edge cells.
  applyHeatmapPaint(map as any, /* isTransparent */ true);
  const xrayFillColor = map.getPaintProperty("heatmap-fill", "fill-color");
  assert(
    isCoalesceFillColorExpr(xrayFillColor),
    "X-Ray mode must still keep fill-color as a data-driven coalesce expression",
  );
  const xrayOpacity = map.getPaintProperty("heatmap-fill", "fill-opacity") as unknown[];
  assert(
    evalCaseEdgeExpression(xrayOpacity, 0) > 0,
    "X-Ray mode non-edge opacity must remain > 0 (just dimmed).",
  );

  // 6) Cross-check: buildHeatmapFillOpacityExpr at opacity=1 matches the
  //    initial constant. This locks the helper and the constant together so
  //    they can't drift.
  assert(
    JSON.stringify(buildHeatmapFillOpacityExpr(1.0)) === JSON.stringify(HEATMAP_FILL_OPACITY_EXPR),
    "buildHeatmapFillOpacityExpr(1.0) must equal HEATMAP_FILL_OPACITY_EXPR",
  );

  console.log("heatmap-fill-paint: all cases passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
