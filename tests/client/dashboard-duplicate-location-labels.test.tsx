/* test-registration
{
  "name": "Dashboard duplicate location labels (Task #2013)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2013 — Frontend regression test for the per-row GBP location
 * label on the IN-APP dashboard's Market Share Leaderboard.
 *
 * The public/printable report's leaderboard (Task #1991,
 * `PublicLocationLocalDominance` in `client/src/pages/PublicReport.tsx`)
 * already has a regression test
 * (`tests/client/competitor-duplicate-location-labels.test.tsx`). The
 * in-app dashboard (`client/src/components/LocalDominanceDashboard.tsx`)
 * runs byte-for-byte identical duplicate-detection logic but was NOT
 * directly covered because the rendering was inline in a large
 * fetch-driven component. Task #2013 extracted that rendering into an
 * exported `MarketShareLeaderboard` sub-component so the dashboard branch
 * is now testable in isolation, mirroring the public-report test.
 *
 * Scenarios:
 *
 *   1. Two competitors share the name "Shields & Boris" but have
 *      different `locationLabel` values — both location labels render
 *      under the `competitor-location-*` test ids, and the two labels
 *      are distinct.
 *   2. A single-location (non-duplicate) competitor — "Acme Law" appears
 *      once with a `locationLabel`, so NO location label row renders for
 *      it even though the label is present on the data.
 */

import { register } from "node:module";

// LocalDominanceDashboard imports InteractiveHeatmap → maplibre-gl (a WebGL
// library with a CSS side-effect import) through its dependency graph. Reuse
// the heatmap render test's loader hook so `maplibre-gl` and its `.css` import
// resolve to lightweight stubs instead of failing under tsx/jsdom.
register("./maplibre-loader.mjs", import.meta.url);

const { installReactKeyWarningGuard } = await import(
  "../helpers/reactKeyWarningGuard.mjs"
);

// Task #2829 — fail loudly if ANY rendered list logs React's missing-key
// warning (redraw/flicker risk, see Task #2813). Scoped to the key warning
// only; jsdom/recharts SVG casing noise is untouched.
const keyWarningGuard = installReactKeyWarningGuard();

const { JSDOM } = await import("jsdom");

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLSpanElement = dom.window.HTMLSpanElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
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
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { MarketShareLeaderboard } = await import(
  "../../client/src/components/LocalDominanceDashboard"
);

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

function $(testid: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
}

const LOCATION_ID = "loc-austin";

// Two firms named "Shields & Boris" (duplicate) plus one unique firm.
// Every row carries a locationLabel so the test proves the duplicate
// gate — not merely "is a label present" — controls rendering. A subject
// business row is included so the position callout renders normally.
function makeCompetitors() {
  return [
    {
      rank: 1,
      name: "Shields & Boris",
      shareOfVoice: 42,
      averageRank: 1,
      reviewCount: null,
      reviewRating: null,
      isSubjectBusiness: false,
      locationLabel: "Downtown",
    },
    {
      rank: 2,
      name: "Acme Law",
      shareOfVoice: 30,
      averageRank: 2,
      reviewCount: null,
      reviewRating: null,
      isSubjectBusiness: true,
      locationLabel: "South Congress",
    },
    {
      rank: 3,
      name: "Shields & Boris",
      shareOfVoice: 18,
      averageRank: 3,
      reviewCount: null,
      reviewRating: null,
      isSubjectBusiness: false,
      locationLabel: "North Loop",
    },
  ] as any;
}

async function mount(): Promise<Root> {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(MarketShareLeaderboard as any, {
        locationId: LOCATION_ID,
        competitors: makeCompetitors(),
      }),
    );
  });
  await flush();
  return root!;
}

async function run(): Promise<void> {
  const root = await mount();

  // The leaderboard rows themselves must have rendered.
  assert(
    $(`competitor-${LOCATION_ID}-1`) !== null,
    "rank-1 competitor row must render",
  );
  assert(
    $(`competitor-${LOCATION_ID}-3`) !== null,
    "rank-3 competitor row must render",
  );

  // Scenario 1 — both duplicate "Shields & Boris" rows show a distinct
  // location label.
  const dupLabel1 = $(`competitor-location-${LOCATION_ID}-1`);
  const dupLabel3 = $(`competitor-location-${LOCATION_ID}-3`);
  assert(
    dupLabel1 !== null,
    "duplicate rank-1 row must render its location label",
  );
  assert(
    dupLabel3 !== null,
    "duplicate rank-3 row must render its location label",
  );
  assert(
    (dupLabel1!.textContent || "").trim() === "Downtown",
    `rank-1 location label should be "Downtown", got "${dupLabel1!.textContent}"`,
  );
  assert(
    (dupLabel3!.textContent || "").trim() === "North Loop",
    `rank-3 location label should be "North Loop", got "${dupLabel3!.textContent}"`,
  );
  assert(
    (dupLabel1!.textContent || "").trim() !==
      (dupLabel3!.textContent || "").trim(),
    "the two duplicate rows must render DISTINCT location labels",
  );
  console.log(
    "  ✓ duplicate-name rows each render a distinct location label",
  );

  // Scenario 2 — the single-location (non-duplicate) competitor renders
  // WITHOUT a location label, even though one is present on the data.
  assert(
    $(`competitor-${LOCATION_ID}-2`) !== null,
    "rank-2 (unique) competitor row must render",
  );
  assert(
    $(`competitor-location-${LOCATION_ID}-2`) === null,
    "non-duplicate competitor must NOT render a location label",
  );
  console.log(
    "  ✓ non-duplicate competitor renders without a location label",
  );

  await act(async () => {
    root.unmount();
  });
}

run()
  .then(() => {
    keyWarningGuard.assertNoKeyWarnings(
      "dashboard-duplicate-location-labels.test.tsx",
    );
    console.log("dashboard-duplicate-location-labels: all scenarios passed");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
