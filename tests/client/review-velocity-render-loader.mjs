// Node ESM module loader hook for the review-velocity goal-band RENDER test.
//
// PublicReport.tsx (where the Review Generation panel lives) statically imports
// a heavy browser-only graph that `tsx`/node can't evaluate under jsdom:
//   - `recharts` — the velocity sparkline + its `ReferenceLine` target line.
//     The real ResponsiveContainer measures a zero-size jsdom node and renders
//     NOTHING, so the target reference line would be undetectable. We redirect
//     `recharts` to a tiny passthrough shim where containers render their
//     children and `ReferenceLine` renders a queryable marker, so the test can
//     assert the target line is present (target set) / absent (no target).
//   - `framer-motion` — `motion.*` + `useInView` (IntersectionObserver). Shimmed
//     to plain passthrough elements + `useInView → true` so every slide mounts.
//   - `maplibre-gl` (+ its CSS) reached via `InteractiveHeatmap`, and the
//     recharts-heavy `CeoPulseChartRenderer` (+ `FunnelChart`). Both are stubbed
//     by basename so their deep graphs never load. CeoPulseChartRenderer stubs
//     to null; InteractiveHeatmap stubs to a queryable marker div carrying its
//     `snapshotId` prop (Task #4848 — the Map Rankings pill switcher is pinned
//     by asserting WHICH snapshot the map was asked to render).
//   - any `.css` side-effect import → empty module.

// The shim modules `import React from "react"`, so their module URL must be a
// real file URL inside the project for that bare import to resolve against
// node_modules (a custom URL scheme breaks tsx's path resolver). The files need
// not exist on disk — `load()` short-circuits with generated source.
const RECHARTS_URL = new URL("./__rv-shim-recharts.mjs", import.meta.url).href;
const FRAMER_URL = new URL("./__rv-shim-framer-motion.mjs", import.meta.url).href;
const MAPLIBRE_URL = new URL("./__rv-shim-maplibre.mjs", import.meta.url).href;
const CSS_URL = new URL("./__rv-shim-css.mjs", import.meta.url).href;
const COMPONENT_STUB_URL = new URL("./__rv-shim-component.mjs", import.meta.url).href;
const HEATMAP_STUB_URL = new URL("./__rv-shim-interactive-heatmap.mjs", import.meta.url).href;

// Heavy leaf components (matched by basename) stubbed to null.
const STUB_COMPONENT_BASENAMES = new Set([
  "CeoPulseChartRenderer",
]);

function basename(specifier) {
  const cleaned = specifier.replace(/\.(tsx?|jsx?)$/, "");
  const parts = cleaned.split("/");
  return parts[parts.length - 1];
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "recharts") {
    return { url: RECHARTS_URL, shortCircuit: true, format: "module" };
  }
  if (specifier === "framer-motion") {
    return { url: FRAMER_URL, shortCircuit: true, format: "module" };
  }
  if (specifier === "maplibre-gl") {
    return { url: MAPLIBRE_URL, shortCircuit: true, format: "module" };
  }
  if (specifier.endsWith(".css")) {
    return { url: CSS_URL, shortCircuit: true, format: "module" };
  }
  if (basename(specifier) === "InteractiveHeatmap") {
    return { url: HEATMAP_STUB_URL, shortCircuit: true, format: "module" };
  }
  if (STUB_COMPONENT_BASENAMES.has(basename(specifier))) {
    return { url: COMPONENT_STUB_URL, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === RECHARTS_URL) {
    // Container components render their children; pure-SVG leaves render null;
    // ReferenceLine renders a queryable marker carrying its `label.value`.
    const source = `
import React from "react";
// Task #2823 — installing the shared benign-SVG-warning filter here (the shim
// evaluates on the MAIN thread, at component-graph import time, before any
// render) silences the jsdom "<linearGradient> casing"/"<stop> unrecognized"
// flood for EVERY test registering this loader, with no per-test wiring. The
// shim's base URL sits inside tests/client/, so the relative import resolves
// to the real file.
import "./console-noise-filter.mjs";
// Chart containers expose their \`data\` prop as a JSON attribute so rendered
// tests can assert the exact series a chart would draw (e.g. the Historical
// Trends Total line under hideOtherLeads) — the real recharts SVG output is
// unqueryable in jsdom.
const Pass = (name) => function R(props) {
  const attrs = { "data-recharts": name };
  if (props && Array.isArray(props.data)) {
    attrs["data-chart-data"] = JSON.stringify(props.data);
  }
  return React.createElement("div", attrs, props && props.children);
};
const Nil = () => function R() { return null; };
export const ResponsiveContainer = Pass("ResponsiveContainer");
export const AreaChart = Pass("AreaChart");
export const LineChart = Pass("LineChart");
export const BarChart = Pass("BarChart");
export const PieChart = Pass("PieChart");
export const Area = Nil();
export const Line = Nil();
export const Bar = Nil();
export const Pie = Nil();
export const Cell = Nil();
export const XAxis = Nil();
export const YAxis = Nil();
export const CartesianGrid = Nil();
export const Tooltip = Nil();
export const Legend = Nil();
export const LabelList = Nil();
export function ReferenceLine(props) {
  const label = props && props.label;
  const text = label && typeof label === "object" ? label.value : label;
  return React.createElement(
    "div",
    { "data-testid": "recharts-reference-line", "data-recharts": "ReferenceLine" },
    text == null ? null : String(text),
  );
}
`;
    return { format: "module", source, shortCircuit: true };
  }
  if (url === FRAMER_URL) {
    const source = `
import React from "react";
const FRAMER_ONLY = new Set([
  "initial","animate","exit","variants","transition","whileInView","whileHover",
  "whileTap","whileFocus","whileDrag","viewport","custom","layout","layoutId",
  "drag","onAnimationComplete","onAnimationStart","style2",
]);
const make = (tag) => React.forwardRef(function M(props, ref) {
  const clean = { ref };
  let children = null;
  for (const k in props) {
    if (k === "children") { children = props[k]; continue; }
    if (FRAMER_ONLY.has(k)) continue;
    clean[k] = props[k];
  }
  return React.createElement(typeof tag === "string" ? tag : "div", clean, children);
});
const cache = new Map();
export const motion = new Proxy({}, {
  get(_t, prop) {
    const key = String(prop);
    if (!cache.has(key)) cache.set(key, make(key));
    return cache.get(key);
  },
});
export const AnimatePresence = ({ children }) => React.createElement(React.Fragment, null, children);
export const useInView = () => true;
export const useReducedMotion = () => false;
export const useAnimation = () => ({ start: () => Promise.resolve(), stop() {}, set() {} });
export const Variants = undefined;
`;
    return { format: "module", source, shortCircuit: true };
  }
  if (url === MAPLIBRE_URL) {
    const source = `
class StubMap { constructor() {} on() {} off() {} addControl() {} addSource() {} getSource() {} addLayer() {} getLayer() {} setPaintProperty() {} setLayoutProperty() {} getCanvas() { return { style: {} }; } fitBounds() {} queryRenderedFeatures() { return []; } remove() {} }
class NavigationControl {}
class Popup { setLngLat() { return this; } setDOMContent() { return this; } addTo() { return this; } remove() {} }
class LngLatBounds { extend() { return this; } }
const maplibre = { Map: StubMap, NavigationControl, Popup, LngLatBounds };
export default maplibre;
export { StubMap as Map, NavigationControl, Popup, LngLatBounds };
`;
    return { format: "module", source, shortCircuit: true };
  }
  if (url === CSS_URL) {
    return { format: "module", source: "export default {};", shortCircuit: true };
  }
  if (url === COMPONENT_STUB_URL) {
    const source = "const Stub = () => null;\nexport default Stub;\n";
    return { format: "module", source, shortCircuit: true };
  }
  if (url === HEATMAP_STUB_URL) {
    // Inert marker (no visual output) exposing the snapshot the real map
    // would render — lets rendered suites assert pill→map switching.
    const source = `
import React from "react";
export default function InteractiveHeatmapStub(props) {
  return React.createElement("div", {
    "data-testid": "stub-interactive-heatmap",
    "data-snapshot-id": props && props.snapshotId ? String(props.snapshotId) : "",
  });
}
`;
    return { format: "module", source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
