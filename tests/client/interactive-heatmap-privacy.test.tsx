/* test-registration
{
  "name": "InteractiveHeatmap privacyMode suppresses meta-derived names (Task #4290)",
  "regression": true,
  "sweepOnlyReason": "The actual leak boundary is server-side and smoke-gated (share-endpoint-privacy-location-masking + heatmap-public-privacy-bound); this jsdom suite pins the client-side belt for non-DB-bound ?private views only, and jsdom mounts add gate flake surface for a secondary layer — full-suite + nightly regression sweep coverage suffices.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/components/InteractiveHeatmap.tsx"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4290 — the client-side half of privacy-mode location masking.
 *
 * A `?private=true` share is NOT DB-privacy-bound, so the public heatmap
 * meta endpoint can return the REAL location/keyword/business names for its
 * snapshots. The payload masker hands the component masked labels via
 * props — but InteractiveHeatmap historically FELL BACK to the meta fetch
 * (`snapshot?.locationName` / `snapshot?.keywordName`) whenever props were
 * empty, repainting real names onto a privacy share.
 *
 * Pins (full, non-compact mode, which renders the name header):
 *   1. privacyMode + empty name props → after the meta query resolves with
 *      REAL names, the DOM contains neither the real location name nor the
 *      real keyword; the header shows the generic "Google Map Rankings".
 *   2. Control (privacyMode off, same meta) → the meta fallbacks DO render,
 *      proving the stub exercised the exact code path privacy must cut off.
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).SVGElement = dom.window.SVGElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(dom.window as any).matchMedia =
  (dom.window as any).matchMedia ||
  ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }));
(globalThis as any).matchMedia = (dom.window as any).matchMedia;
(globalThis as any).ResizeObserver =
  (dom.window as any).ResizeObserver ||
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
(globalThis as any).IntersectionObserver =
  (dom.window as any).IntersectionObserver ||
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SNAP_ID = "11111111-2222-3333-4444-555555555555";
const REAL_LOC = "Rivergate North Office";
const REAL_KW = "rivergate car accident lawyer";
const REAL_BIZ = "Blackstone Injury Law";

// ---------------------------------------------------------------------------
// fetch stub — the meta endpoint returns REAL names (exactly what a
// non-DB-bound ?private=true share would get). loadMaplibre's vendor request
// (and anything unexpected) gets a 404 so the map itself never initializes —
// the header under test renders regardless.
// ---------------------------------------------------------------------------
const fetchLog: string[] = [];
const jsonResponse = (data: unknown) =>
  ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) }) as any;
const notFound = () =>
  ({ ok: false, status: 404, json: async () => ({}), text: async () => "" }) as any;

(globalThis as any).fetch = async (input: unknown): Promise<any> => {
  const url = String(input);
  fetchLog.push(url);
  if (url.includes("/config/maptiler-key")) return jsonResponse({ key: "test-key" });
  if (url.includes(`/api/public/heatmaps/${SNAP_ID}/meta`)) {
    return jsonResponse({
      snapshot: {
        id: SNAP_ID,
        locationName: REAL_LOC,
        businessName: REAL_BIZ,
        keywordName: REAL_KW,
        reportDate: "2026-07-15T00:00:00.000Z",
      },
      metrics: null,
    });
  }
  if (url.includes(`/api/public/heatmaps/${SNAP_ID}/geojson`)) {
    return jsonResponse({ type: "FeatureCollection", features: [] });
  }
  return notFound();
};

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Imports — after jsdom + fetch stub are in place.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const InteractiveHeatmap = (await import("../../client/src/components/InteractiveHeatmap")).default;

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

type Mounted = { root: Root; el: HTMLElement; qc: InstanceType<typeof QueryClient> };

async function mount(props: Record<string, unknown>): Promise<Mounted> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  // gcTime: 0 — the default 5-minute garbage-collection timers outlive the
  // test and hang the process at exit (the runner SIGTERMs at the file cap).
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(InteractiveHeatmap, { snapshotId: SNAP_ID, isPublic: true, compact: false, ...props }),
      ),
    );
  });
  // Let the maptiler-key / meta / geojson queries resolve and re-render.
  await flush(20);
  await flush(20);
  return { root, el, qc };
}

async function unmount({ root, el, qc }: Mounted): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  el.remove();
  qc.clear();
}

async function main(): Promise<void> {
  // 1. privacyMode — meta-derived names must never render.
  {
    const mounted = await mount({ privacyMode: true, locationName: "", keywordName: "" });
    const metaFetched = fetchLog.some((u) => u.includes("/meta"));
    assert(metaFetched, "meta endpoint was fetched (the fallback data really arrived)");
    const text = mounted.el.textContent ?? "";
    assert(!text.includes(REAL_LOC), `privacyMode: real location name must not render (got: ${text.slice(0, 200)})`);
    assert(!text.includes(REAL_KW), "privacyMode: real keyword must not render");
    assert(!text.includes(REAL_BIZ), "privacyMode: real business name must not render");
    assert(text.includes("Google Map Rankings"), "privacyMode: generic header fallback renders");
    await unmount(mounted);
    console.log("  ok  privacyMode suppresses meta-derived location/keyword/business names");
  }

  // 2. Control — same meta, privacyMode off: the fallbacks DO render (proves
  //    the stub drove the exact path privacy cuts off).
  {
    const mounted = await mount({ locationName: "", keywordName: "" });
    const text = mounted.el.textContent ?? "";
    assert(text.includes(REAL_LOC), `control: meta locationName fallback renders (got: ${text.slice(0, 200)})`);
    assert(text.includes(REAL_KW), "control: meta keywordName fallback renders");
    await unmount(mounted);
    console.log("  ok  control (no privacyMode) still renders meta fallbacks");
  }

  // Release jsdom's pretendToBeVisual internals so the process can exit.
  dom.window.close();

  console.log("\nResults: all assertions passed");
}

main().then(
  () => {},
  (err) => {
    console.error("Test threw:", err);
    process.exitCode = 1;
  },
);
