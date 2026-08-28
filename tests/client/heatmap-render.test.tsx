/* test-registration
{
  "name": "Heatmap render",
  "tier": "medium",
  "tierReason": "Renders the heatmap component across its data and layout states in jsdom."
}
test-registration */
/**
 * End-to-end render test for InteractiveHeatmap.
 *
 * The helper-level smoke test (heatmap-fill-paint.test.ts) verifies that the
 * paint expression constants and applyHeatmapPaint() helper are data-driven,
 * but it never actually mounts the React component. A regression in the
 * component's effect ordering — for example adding the heatmap-fill layer
 * after applyHeatmapPaint runs, or a fixture geojson missing rankColor —
 * would not be caught.
 *
 * This test mounts the real InteractiveHeatmap component into jsdom with a
 * mocked maplibre Map (registered via a Node ESM loader hook so the
 * component's own `import maplibregl from "maplibre-gl"` resolves to the
 * stub). It stubs the two HTTP endpoints the component fetches, lets the
 * map "load" event and the geojson useEffect run, then asserts that the
 * heatmap-fill layer was actually added to the map with a coalesce
 * fill-color expression that reads each cell's rankColor.
 */

import { register } from "node:module";

register("./maplibre-loader.mjs", import.meta.url);

const { installReactKeyWarningGuard } = await import(
  "../helpers/reactKeyWarningGuard.mjs"
);

// Task #2829 — fail loudly if ANY rendered list logs React's missing-key
// warning (redraw/flicker risk, see Task #2813). Scoped to the key warning
// only; jsdom/maplibre SVG casing noise is untouched.
const keyWarningGuard = installReactKeyWarningGuard();

const { JSDOM } = await import("jsdom");

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const { buildGeoJSON } = await import("../../server/services/heatmapService");

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

const fixtureSnapshot = makeFixtureSnapshot();
const fixtureGeojson = buildGeoJSON(fixtureSnapshot, makeFixturePoints(), "rank");

// Sanity-check the fixture itself: the component's coalesce fill-color
// expression resolves to grey unless every polygon carries a rankColor, so
// guarding the fixture here keeps the assertion below meaningful.
for (const f of (fixtureGeojson as any).features) {
  if (f.geometry.type === "Polygon") {
    assert(
      typeof f.properties.rankColor === "string" && f.properties.rankColor.length > 0,
      "fixture polygon must carry a rankColor",
    );
  }
}

const fetchCalls: string[] = [];
const { createFetchStub } = await import("../helpers/createFetchStub.mjs");
(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  onCall: ({ url }) => {
    fetchCalls.push(url);
  },
  routes: [
    { path: /\/maptiler-key/, json: { key: "test-key" } },
    { path: /\/geojson/, json: fixtureGeojson },
    { path: /\/meta$/, json: { snapshot: fixtureSnapshot, metrics: null } },
    {
      test: () => true,
      respond: (ctx) => {
        throw new Error(`unexpected fetch: ${ctx.url}`);
      },
    },
  ],
});

// Some libraries probe matchMedia.
(dom.window as any).matchMedia = (dom.window as any).matchMedia || ((q: string) => ({
  matches: false,
  media: q,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return false; },
}));

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const InteractiveHeatmap = (await import("../../client/src/components/InteractiveHeatmap")).default;
const maplibreStub: any = await import("maplibre-gl");
const { isCoalesceFillColorExpr } = (() => ({
  isCoalesceFillColorExpr(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    if (value[0] !== "coalesce") return false;
    return value.some(
      (arg) =>
        Array.isArray(arg) &&
        (arg as any[])[0] === "get" &&
        (arg as any[])[1] === "rankColor",
    );
  },
}))();

async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function main() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0, gcTime: 0 },
    },
  });

  const container = document.getElementById("root")!;
  let root: any = null;

  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(InteractiveHeatmap, { snapshotId: "snap-1" } as any),
      ),
    );
  });

  // Let the queries resolve, the map "load" event fire, and the geojson
  // useEffect run (which is what actually adds the heatmap-fill layer).
  await flush(8);

  const instances = maplibreStub.__MAP_INSTANCES as any[];
  assert(
    instances.length === 1,
    `expected exactly one Map instance to be created, got ${instances.length}; fetchCalls=${JSON.stringify(fetchCalls)}`,
  );
  const map = instances[0];

  const fillLayer = map.getLayer("heatmap-fill");
  assert(
    fillLayer != null,
    "heatmap-fill layer must have been added to the map by the geojson effect (regression: layer never added or added before applyHeatmapPaint trampled it)",
  );

  const installedFillColor = fillLayer.paint["fill-color"];
  assert(
    typeof installedFillColor !== "string",
    `heatmap-fill fill-color must NOT be a constant string after mount (got ${JSON.stringify(installedFillColor)}). This is the flat-gray heatmap regression.`,
  );
  assert(
    isCoalesceFillColorExpr(installedFillColor),
    `heatmap-fill fill-color must be a coalesce expression reading rankColor, got: ${JSON.stringify(installedFillColor)}`,
  );

  // The heatmap-cells source must have been populated with the fixture
  // polygons, otherwise the coalesce expression has nothing to colour.
  const cellsSource = map._sources.get("heatmap-cells");
  assert(cellsSource != null, "heatmap-cells source must have been added");
  const cellsData = cellsSource._data;
  const polygonCount = (cellsData?.features || []).filter(
    (f: any) => f.geometry?.type === "Polygon",
  ).length;
  assert(
    polygonCount === 9,
    `heatmap-cells source must contain the 9 fixture polygons, got ${polygonCount}`,
  );
  for (const f of cellsData.features) {
    assert(
      typeof f.properties?.rankColor === "string" && f.properties.rankColor.length > 0,
      "every polygon feature handed to the map must carry a rankColor (otherwise coalesce returns null and cells render grey)",
    );
  }

  // fill-opacity must remain > 0 for non-edge cells (otherwise cells would
  // be invisible — the other half of the flat-gray regression).
  const fillOpacity = fillLayer.paint["fill-opacity"];
  assert(
    Array.isArray(fillOpacity) && fillOpacity[0] === "case",
    `heatmap-fill fill-opacity must be a case expression, got ${JSON.stringify(fillOpacity)}`,
  );
  const nonEdgeOpacity = fillOpacity[3] as number;
  assert(
    typeof nonEdgeOpacity === "number" && nonEdgeOpacity > 0,
    `heatmap-fill non-edge opacity must be > 0 after mount (got ${nonEdgeOpacity})`,
  );

  // fitBounds was called, confirming the geojson effect actually ran end to
  // end (rather than bailing out before installing the paint).
  assert(
    map.fitBoundsCalls.length >= 1,
    "map.fitBounds must have been called at least once after the geojson effect ran",
  );

  await act(async () => {
    root.unmount();
  });

  keyWarningGuard.assertNoKeyWarnings("heatmap-render.test.tsx");

  console.log("heatmap-render: all DOM cases passed");
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
