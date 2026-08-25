// Node ESM module loader hook used by the InteractiveHeatmap render test.
// Intercepts the `maplibre-gl` package and its CSS side-effect import so the
// component can be mounted in jsdom without bundling the real WebGL library.
//
// The stubbed maplibre default export records every addLayer / addSource /
// setPaintProperty call on each Map instance and exposes them via
// `__MAP_INSTANCES` so the test can assert on the actually-rendered layer
// configuration after React effects flush.

const STUB_URL = "maplibre-stub:default";
const CSS_URL = "maplibre-stub:css";
const RUNTIME_LOADER_URL = "maplibre-stub:runtime-loader";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "maplibre-gl") {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  if (specifier === "maplibre-gl/dist/maplibre-gl.css") {
    return { url: CSS_URL, shortCircuit: true, format: "module" };
  }
  // The components no longer value-import maplibre-gl; they go through the
  // runtime loader module (script-tag injection, which never resolves in
  // jsdom). Redirect that module to a stub that hands back the maplibre stub
  // synchronously so map init effects run in tests.
  if (/(^|\/)loadMaplibre(\.ts)?$/.test(specifier) || specifier === "@/lib/loadMaplibre") {
    return { url: RUNTIME_LOADER_URL, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === STUB_URL) {
    const source = `
const __MAP_INSTANCES__ = [];

// Task #2874: when globalThis.__MAPLIBRE_STYLE_NOT_READY__ is truthy the stub
// behaves like MapLibre with a style that is not done loading: isStyleLoaded()
// returns false and every style mutation throws the real error message.
function __assertStyleReady__() {
  if (globalThis.__MAPLIBRE_STYLE_NOT_READY__) {
    throw new Error("Style is not done loading");
  }
}

class StubMap {
  constructor(opts) {
    this._opts = opts;
    this._listeners = Object.create(null);
    this._layeredListeners = Object.create(null);
    this._layers = new Map();
    this._sources = new Map();
    this._canvas = { style: {} };
    this.fitBoundsCalls = [];
    __MAP_INSTANCES__.push(this);
    // Defer the 'load' event so callers can register their listener first
    // (the component does map.on('load', ...) right after construction).
    queueMicrotask(() => this._emit("load"));
  }

  _emit(ev, data) {
    const ls = this._listeners[ev];
    if (ls) for (const cb of ls.slice()) cb(data);
  }

  on(ev, layerOrCb, maybeCb) {
    if (typeof layerOrCb === "function") {
      (this._listeners[ev] = this._listeners[ev] || []).push(layerOrCb);
    } else {
      const key = ev + ":" + layerOrCb;
      (this._layeredListeners[key] = this._layeredListeners[key] || []).push(maybeCb);
    }
  }

  off(ev, layerOrCb, maybeCb) {
    if (typeof layerOrCb === "function") {
      const arr = this._listeners[ev];
      if (arr) {
        const i = arr.indexOf(layerOrCb);
        if (i >= 0) arr.splice(i, 1);
      }
    } else {
      const arr = this._layeredListeners[ev + ":" + layerOrCb];
      if (arr) {
        const i = arr.indexOf(maybeCb);
        if (i >= 0) arr.splice(i, 1);
      }
    }
  }

  once(ev, cb) {
    const wrapper = (data) => {
      this.off(ev, wrapper);
      cb(data);
    };
    this.on(ev, wrapper);
  }

  isStyleLoaded() { return !globalThis.__MAPLIBRE_STYLE_NOT_READY__; }

  addControl() {}

  addSource(id, src) {
    __assertStyleReady__();
    this._sources.set(id, {
      _data: src && src.data,
      setData(d) { __assertStyleReady__(); this._data = d; },
    });
  }

  getSource(id) { return this._sources.get(id); }

  addLayer(spec) {
    __assertStyleReady__();
    this._layers.set(spec.id, {
      spec,
      paint: Object.assign({}, spec.paint || {}),
      layout: Object.assign({}, spec.layout || {}),
    });
  }

  getLayer(id) { return this._layers.get(id); }

  setPaintProperty(id, prop, val) {
    __assertStyleReady__();
    const l = this._layers.get(id);
    if (l) l.paint[prop] = val;
  }

  getPaintProperty(id, prop) {
    const l = this._layers.get(id);
    return l ? l.paint[prop] : undefined;
  }

  setLayoutProperty(id, prop, val) {
    __assertStyleReady__();
    const l = this._layers.get(id);
    if (l) l.layout[prop] = val;
  }

  getCanvas() { return this._canvas; }

  fitBounds(bounds, opts) { this.fitBoundsCalls.push({ bounds, opts }); }

  queryRenderedFeatures() { return []; }

  remove() {}
}

class NavigationControl { constructor(opts) { this.opts = opts; } }

class Popup {
  constructor(opts) { this.opts = opts; }
  setLngLat() { return this; }
  setDOMContent() { return this; }
  addTo() { return this; }
  remove() {}
}

class LngLatBounds {
  constructor() { this._coords = []; }
  extend(c) { this._coords.push(c); return this; }
}

const maplibre = { Map: StubMap, NavigationControl, Popup, LngLatBounds };
export default maplibre;
export { StubMap as Map, NavigationControl, Popup, LngLatBounds };
export const __MAP_INSTANCES = __MAP_INSTANCES__;
`;
    return { format: "module", source, shortCircuit: true };
  }
  if (url === CSS_URL) {
    return { format: "module", source: "export default {};", shortCircuit: true };
  }
  if (url === RUNTIME_LOADER_URL) {
    return {
      format: "module",
      shortCircuit: true,
      source: `
import maplibre from "maplibre-gl";
export function loadMaplibre() { return Promise.resolve(maplibre); }
export function getLoadedMaplibre() { return maplibre; }
export const MAPLIBRE_JS_URL = "maplibre-stub:js";
export const MAPLIBRE_CSS_URL = "maplibre-stub:css";
`,
    };
  }
  return nextLoad(url, context);
}
