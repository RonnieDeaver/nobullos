// Task: shrink the ~1 MB mapStyleReady-*.js publish artifact.
//
// maplibre-gl's dist build is a single prebuilt ~1 MB file that rollup
// cannot tree-shake, so bundling it re-shipped the full megabyte inside
// dist/public on every publish. Instead, the server exposes the exact same
// files straight from node_modules (see registerMaplibreVendorRoutes in
// server/static.ts) and this loader injects them at runtime, only when a
// map component actually mounts. Same origin, same bytes, no CDN — but the
// library no longer counts against the publish bundle.
//
// scripts/lint-bundle-budget.ts fails the gate if maplibre-gl ever
// reappears in the vite bundle (RUNTIME_LOADED_LIBRARY_PATTERNS), so a
// future `import maplibregl from "maplibre-gl"` cannot silently undo this.

/** The full module namespace exposed by the UMD build as window.maplibregl. */
export type MaplibreModule = typeof import("maplibre-gl");

// Injected by vite `define` (vite.config.ts) from maplibre-gl's installed
// package.json — used purely as a cache-buster so the immutable-cached
// vendor URL rolls over when the dependency is upgraded.
declare const __MAPLIBRE_VERSION__: string;

const VERSION = typeof __MAPLIBRE_VERSION__ === "string" ? __MAPLIBRE_VERSION__ : "unknown";
export const MAPLIBRE_JS_URL = `/vendor/maplibre-gl/maplibre-gl.js?v=${VERSION}`;
export const MAPLIBRE_CSS_URL = `/vendor/maplibre-gl/maplibre-gl.css?v=${VERSION}`;

let pending: Promise<MaplibreModule> | null = null;
let loaded: MaplibreModule | null = null;

/**
 * Synchronous accessor for code paths that run strictly after a map was
 * created (callbacks/effects downstream of loadMaplibre resolving). Returns
 * null before the runtime load completes.
 */
export function getLoadedMaplibre(): MaplibreModule | null {
  return loaded;
}

function injectOnce(tag: "script" | "link", url: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const selector =
      tag === "script" ? `script[src="${url}"]` : `link[href="${url}"]`;
    const existing = document.querySelector(selector) as
      | (HTMLElement & { dataset: DOMStringMap })
      | null;
    if (existing) {
      if (existing.dataset.loaded === "true") return resolvePromise();
      existing.addEventListener("load", () => resolvePromise(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error(`failed to load ${url}`)),
        { once: true },
      );
      return;
    }
    let el: HTMLScriptElement | HTMLLinkElement;
    if (tag === "script") {
      const s = document.createElement("script");
      s.src = url;
      s.async = true;
      el = s;
    } else {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = url;
      el = l;
    }
    el.addEventListener(
      "load",
      () => {
        el.dataset.loaded = "true";
        resolvePromise();
      },
      { once: true },
    );
    el.addEventListener(
      "error",
      () => {
        // Remove the failed tag so a retry re-injects instead of waiting on
        // a dead element.
        el.remove();
        reject(new Error(`failed to load ${url}`));
      },
      { once: true },
    );
    document.head.appendChild(el);
  });
}

/**
 * Load maplibre-gl (JS + CSS) from the same-origin vendor route. Resolves
 * to the module namespace (window.maplibregl). Concurrent callers share one
 * in-flight load; a failed load clears the cache so the next mount retries.
 */
export function loadMaplibre(): Promise<MaplibreModule> {
  const already = (window as any).maplibregl as MaplibreModule | undefined;
  if (already?.Map) {
    // CSS may still be missing if something else defined maplibregl; keep it
    // best-effort — the JS module is what callers need.
    void injectOnce("link", MAPLIBRE_CSS_URL).catch(() => {});
    loaded = already;
    return Promise.resolve(already);
  }
  if (!pending) {
    pending = (async () => {
      // CSS in parallel with the script; both must land before first render
      // or controls/popups appear unstyled.
      await Promise.all([
        injectOnce("script", MAPLIBRE_JS_URL),
        injectOnce("link", MAPLIBRE_CSS_URL),
      ]);
      const mod = (window as any).maplibregl as MaplibreModule | undefined;
      if (!mod?.Map) {
        throw new Error(
          "maplibre-gl script loaded but window.maplibregl is missing",
        );
      }
      loaded = mod;
      return mod;
    })().catch((err) => {
      pending = null; // allow retry on next mount
      throw err;
    });
  }
  return pending;
}
