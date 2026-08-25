/* test-registration
{
  "name": "Heatmap style-not-ready throw never crashes the page + recovers on readiness (Task #2874)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2874: the map \"Style is not done loading\" crash class — a transiently-not-ready style during a map-update effect used to throw straight into the global error boundary and replace the whole page with \"Something went wrong\". This rendered test proves the throw is deferred + retried (page survives, map recovers once ready). Fast, deterministic jsdom render — no DB, stubbed maplibre + fetch. Gate it so a regression back to unguarded map mutations fails fast.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/maplibre-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2874 — regression test: a MapLibre "Style is not done loading" throw
 * during a map-update effect must NOT take down the page.
 *
 * Users constantly hit the full-page "Something went wrong" screen because
 * the heatmap components mutated map layers/sources/paint inside React
 * effects guarded only by a one-time "load" flag; when the style was
 * transiently not ready those calls threw, the effect error reached the
 * global error boundary, and the whole page was replaced by the error
 * screen.
 *
 * This test mounts the real InteractiveHeatmap inside an error boundary
 * that mirrors the app's GlobalErrorBoundary contract (any uncaught render/
 * effect error swaps the page for a fallback). The registration block installs
 * the MapLibre loader before this module evaluates, so the component can never
 * inherit a real runtime-loader module cached by an earlier suite. The stub is
 * put in "style not ready" mode (isStyleLoaded() === false AND every mutation
 * throws the real MapLibre message), so:
 *
 *   1. While not ready: the component must neither crash the boundary nor
 *      add any layers — the update must be deferred.
 *   2. Once the style becomes ready and the map emits "idle": the deferred
 *      update must run and the heatmap-fill layer must appear — i.e. the
 *      map recovers automatically instead of silently staying empty.
 *
 * A regression back to unguarded mutations fails case 1 (boundary fallback
 * rendered); a regression that swallows but never retries fails case 2.
 */

const { installReactKeyWarningGuard } = await import(
  "../helpers/reactKeyWarningGuard.mjs"
);
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
const fixtureGeojson = {
  type: "FeatureCollection",
  geometryVersion: 2,
  features: [
    ...makeFixturePoints().map((point, index) => {
      const halfCell = 0.005;
      return {
        type: "Feature",
        id: index,
        properties: {
          ...point,
          color: "#22c55e",
          label: String(point.position),
          rankColor: "#22c55e",
          movementColor: "#64748b",
          rankLabel: String(point.position),
          movementLabel: "No change",
          isEdge: 0,
        },
        geometry: {
          type: "Polygon",
          coordinates: [[
            [point.lng - halfCell, point.lat - halfCell],
            [point.lng + halfCell, point.lat - halfCell],
            [point.lng + halfCell, point.lat + halfCell],
            [point.lng - halfCell, point.lat + halfCell],
            [point.lng - halfCell, point.lat - halfCell],
          ]],
        },
      };
    }),
    {
      type: "Feature",
      id: 9,
      properties: {
        type: "business",
        name: fixtureSnapshot.businessName,
        lat: fixtureSnapshot.businessLat,
        lng: fixtureSnapshot.businessLng,
      },
      geometry: {
        type: "Point",
        coordinates: [fixtureSnapshot.businessLng, fixtureSnapshot.businessLat],
      },
    },
  ],
};

const { createFetchStub } = await import("../helpers/createFetchStub.mjs");
(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: /\/maptiler-key/, json: { key: "test-key" } },
    { path: /\/geojson/, json: fixtureGeojson },
    { path: /\/meta$/, json: { snapshot: fixtureSnapshot, metrics: null } },
    {
      test: () => true,
      respond: (ctx: any) => {
        throw new Error(`unexpected fetch: ${ctx.url}`);
      },
    },
  ],
});

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

// Mirrors the app's GlobalErrorBoundary contract: any error that escapes a
// child render/effect replaces the entire subtree with a fallback screen.
class TestErrorBoundary extends (React as any).Component {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch() {}
  render() {
    if ((this.state as any).hasError) {
      return React.createElement(
        "div",
        { "data-testid": "global-error-screen" },
        "Something went wrong",
      );
    }
    return (this.props as any).children;
  }
}

async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function main() {
  // React logs boundary-caught errors via console.error; keep the output
  // readable but do NOT let those logs fail the run — the assertion is the
  // rendered fallback, not the log.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0, gcTime: 0 },
    },
  });

  // ---- Phase 1: style NOT ready — mutations throw, page must survive ----
  (globalThis as any).__MAPLIBRE_STYLE_NOT_READY__ = true;

  const container = document.getElementById("root")!;
  let root: any = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        React.createElement(
          TestErrorBoundary,
          null,
          React.createElement(
            QueryClientProvider,
            { client: queryClient } as any,
            React.createElement(InteractiveHeatmap, { snapshotId: "snap-1" } as any),
          ),
        ),
      );
    });

    // Let queries resolve, the map "load" event fire, and the geojson effect
    // run while the style is NOT ready.
    await flush(8);

    const instances = maplibreStub.__MAP_INSTANCES as any[];
    assert(instances.length === 1, `expected 1 Map instance, got ${instances.length}`);
    const map = instances[0];

    assert(
      document.querySelector("[data-testid='global-error-screen']") == null,
      "REGRESSION: a style-not-ready map mutation crashed the page into the error boundary fallback",
    );
    assert(
      map.getLayer("heatmap-fill") == null,
      "sanity: while the style is not ready, no layer should have been added (the update must be deferred, not forced)",
    );
    assert(
      document.querySelector("[data-testid='heatmap-map-container']") != null,
      "the heatmap container must still be mounted while the style is not ready",
    );

    // ---- Phase 2: style becomes ready — deferred update must run ----
    (globalThis as any).__MAPLIBRE_STYLE_NOT_READY__ = false;
    await act(async () => {
      map._emit("idle");
      map._emit("styledata");
    });
    // The helper also has a 250ms timer backstop; give retries room to land.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    await flush(4);

    assert(
      document.querySelector("[data-testid='global-error-screen']") == null,
      "the page must still be alive after the style becomes ready",
    );
    const fillLayer = map.getLayer("heatmap-fill");
    assert(
      fillLayer != null,
      "REGRESSION: the deferred map update never ran once the style became ready — the map would stay blank forever",
    );
    const cellsSource = map._sources.get("heatmap-cells");
    assert(cellsSource != null, "heatmap-cells source must exist after recovery");
    const polygonCount = (cellsSource._data?.features || []).filter(
      (f: any) => f.geometry?.type === "Polygon",
    ).length;
    assert(
      polygonCount === 9,
      `heatmap-cells source must contain the 9 fixture polygons after recovery, got ${polygonCount}`,
    );

    await act(async () => {
      root.unmount();
    });
    root = null;

    keyWarningGuard.assertNoKeyWarnings("heatmap-style-not-ready.test.tsx");

    console.log("heatmap-style-not-ready: all cases passed");
  } finally {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    queryClient.clear();
    dom.window.close();
    delete (globalThis as any).__MAPLIBRE_STYLE_NOT_READY__;
  }
}

await main();
