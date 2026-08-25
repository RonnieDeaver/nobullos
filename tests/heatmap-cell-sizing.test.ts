/* test-registration
{
  "name": "Heatmap cell sizing (Task #2605)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Regression test for Task #2605: heatmap cells must be sized so they tile the
 * full service area, even when SEMrush returns jittered, non-axis-aligned
 * coordinates.
 *
 * The original bug: buildGeoJSON sized each cell from the MEDIAN of consecutive
 * inter-point gaps. For jittered coordinates (e.g. Ackah Calgary: 225 points but
 * 120 distinct latitudes / 211 distinct longitudes) the median longitude gap was
 * ~0.0001°, below the 0.001° floor, so every cell was floored to a 0.001°-wide
 * sliver while the true column spacing was ~0.033° — thin vertical slivers with
 * big horizontal gaps, so the map looked uncolored.
 *
 * The fix derives the cell size from the coordinate extent and grid dimension
 * (span / (gridDim - 1)), which tiles correctly for both jittered and clean
 * grids. This is a pure-function test of deriveCellSizeDeg (no DB).
 */

import { deriveCellSizeDeg } from "../server/services/heatmapService";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// Deterministic pseudo-random in [-1, 1) so the fixture is stable across runs.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

const GRID_DIM = 15;
const LAT_STEP = 0.0207; // ≈ span / (dim - 1) for a 10-mile, 15×15 Calgary grid
const LNG_STEP = 0.033;
const MIN_LAT = 51.0;
const MIN_LNG = -114.2;

const snapshot = {
  gridTemplate: "15x15",
  gridDistance: 10,
  gridUnit: "MILES",
  baseLat: MIN_LAT + (LAT_STEP * (GRID_DIM - 1)) / 2,
} as const;

function cleanGridPoints(): Array<{ lat: number; lng: number }> {
  const pts: Array<{ lat: number; lng: number }> = [];
  for (let i = 0; i < GRID_DIM; i++) {
    for (let j = 0; j < GRID_DIM; j++) {
      pts.push({ lat: MIN_LAT + i * LAT_STEP, lng: MIN_LNG + j * LNG_STEP });
    }
  }
  return pts;
}

// Jittered points: same overall extent, but each interior coordinate is nudged
// so that distinct-lat/lng counts explode and consecutive gaps collapse — the
// real Ackah Calgary shape. Corners are kept exact so the extent is preserved.
function jitteredGridPoints(): Array<{ lat: number; lng: number }> {
  const rng = makeRng(42);
  const pts: Array<{ lat: number; lng: number }> = [];
  for (let i = 0; i < GRID_DIM; i++) {
    for (let j = 0; j < GRID_DIM; j++) {
      const atLatEdge = i === 0 || i === GRID_DIM - 1;
      const atLngEdge = j === 0 || j === GRID_DIM - 1;
      const latJitter = atLatEdge ? 0 : rng() * LAT_STEP * 0.45;
      const lngJitter = atLngEdge ? 0 : rng() * LNG_STEP * 0.45;
      pts.push({
        lat: MIN_LAT + i * LAT_STEP + latJitter,
        lng: MIN_LNG + j * LNG_STEP + lngJitter,
      });
    }
  }
  return pts;
}

function main() {
  const expectedLat = LAT_STEP;
  const expectedLng = LNG_STEP;

  // 1) Clean, axis-aligned grid: extent / (dim - 1) equals the inter-point gap
  //    exactly — proves no regression for clients whose coordinates already form
  //    a clean grid.
  {
    const clean = cleanGridPoints();
    const { cellSizeLat, cellSizeLng } = deriveCellSizeDeg(snapshot, clean);
    assert(
      Math.abs(cellSizeLat - expectedLat) < 1e-9,
      `clean grid cellSizeLat should equal the lat step (${expectedLat}), got ${cellSizeLat}`,
    );
    assert(
      Math.abs(cellSizeLng - expectedLng) < 1e-9,
      `clean grid cellSizeLng should equal the lng step (${expectedLng}), got ${cellSizeLng}`,
    );
  }

  // 2) Jittered, non-axis-aligned grid (the bug case): distinct-lat/lng counts
  //    are far above the grid dimension, so the OLD median-of-gaps approach would
  //    floor the longitude cell to a 0.001° sliver. The fix must instead produce
  //    cells close to the true grid spacing — never degenerate.
  {
    const jittered = jitteredGridPoints();
    const distinctLats = new Set(jittered.map(p => p.lat)).size;
    const distinctLngs = new Set(jittered.map(p => p.lng)).size;
    assert(distinctLats > GRID_DIM, `fixture must be jittered: distinct lats ${distinctLats} > ${GRID_DIM}`);
    assert(distinctLngs > GRID_DIM, `fixture must be jittered: distinct lngs ${distinctLngs} > ${GRID_DIM}`);

    const { cellSizeLat, cellSizeLng } = deriveCellSizeDeg(snapshot, jittered);

    // Not floored to a degenerate sliver.
    assert(cellSizeLat > 0.01, `jittered cellSizeLat must not be a sliver, got ${cellSizeLat}`);
    assert(cellSizeLng > 0.01, `jittered cellSizeLng must not be a sliver, got ${cellSizeLng}`);

    // Close to the true grid spacing (within 20% — interior jitter can only
    // widen the extent slightly because corners are pinned).
    assert(
      Math.abs(cellSizeLat - expectedLat) / expectedLat < 0.2,
      `jittered cellSizeLat (${cellSizeLat}) should be within 20% of grid spacing ${expectedLat}`,
    );
    assert(
      Math.abs(cellSizeLng - expectedLng) / expectedLng < 0.2,
      `jittered cellSizeLng (${cellSizeLng}) should be within 20% of grid spacing ${expectedLng}`,
    );

    // The longitude cell is ~33× wider than the old 0.001° sliver floor.
    assert(cellSizeLng > 0.02, `jittered cellSizeLng (${cellSizeLng}) must dwarf the old 0.001° floor`);
  }

  // 3) Degenerate inputs fall back to the configured grid distance, never a
  //    sliver. A single point has zero extent on both axes.
  {
    const single = [{ lat: MIN_LAT, lng: MIN_LNG }];
    const { cellSizeLat, cellSizeLng } = deriveCellSizeDeg(snapshot, single);
    assert(cellSizeLat > 0.001, `single-point fallback cellSizeLat must be usable, got ${cellSizeLat}`);
    assert(cellSizeLng > 0.001, `single-point fallback cellSizeLng must be usable, got ${cellSizeLng}`);
  }

  // 4) No points at all: still returns a usable, floored size (no NaN/0).
  {
    const { cellSizeLat, cellSizeLng } = deriveCellSizeDeg(snapshot, []);
    assert(Number.isFinite(cellSizeLat) && cellSizeLat >= 0.001, `empty-points cellSizeLat must be finite/floored, got ${cellSizeLat}`);
    assert(Number.isFinite(cellSizeLng) && cellSizeLng >= 0.001, `empty-points cellSizeLng must be finite/floored, got ${cellSizeLng}`);
  }

  console.log("heatmap-cell-sizing: all cases passed");
}

main();
