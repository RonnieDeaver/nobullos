import React, { useRef, useEffect, useState, useMemo, useCallback } from "react";
import { flushSync } from "react-dom";
import { useQuery } from "@tanstack/react-query";
// maplibre-gl is loaded at runtime from the same-origin vendor route
// (~1 MB kept out of the publish bundle) — see client/src/lib/loadMaplibre.ts.
// Only TYPES may be imported from the package here; a value import would
// re-bundle it and fail scripts/lint-bundle-budget.ts.
import type * as maplibregl from "maplibre-gl";
import { loadMaplibre, getLoadedMaplibre, type MaplibreModule } from "@/lib/loadMaplibre";
import { Loader2, Maximize2, AlertTriangle, Layers, ArrowUpDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  HEATMAP_FILL_COLOR_EXPR,
  HEATMAP_FILL_OPACITY_EXPR,
  HEATMAP_OUTLINE_LINE_COLOR_EXPR,
  HEATMAP_LABELS_TEXT_OPACITY_EXPR,
  applyHeatmapPaint as applyHeatmapPaintHelper,
} from "./heatmapPaint";
import { runWhenMapStyleReady } from "@/lib/mapStyleReady";
import { encodeCanvasForPrint } from "@/lib/printImagePrep";
import {
  registerHeatmapPrintPreparer,
  registerHeatmapPrintSyncPreparer,
  subscribeHeatmapPrintMode,
  getHeatmapPrintMode,
  installHeatmapBrowserPrintHooks,
} from "@/lib/heatmapPrintRegistry";
import { HEATMAP_RANK_LEGEND, HEATMAP_MOVEMENT_COLORS } from "@shared/heatmapColors";

interface InteractiveHeatmapProps {
  snapshotId: string;
  locationName?: string;
  keywordName?: string;
  compact?: boolean;
  isPublic?: boolean;
  /** Task #4280 — fixed map height (px) for the compact variant; default 320. */
  height?: number;
  /** Task #4280 — suppress the per-map legend so a parent grid can render ONE shared legend. */
  hideLegend?: boolean;
  /**
   * Task #4290 — privacy-mode share: NEVER render identifying strings from
   * the snapshot meta fetch (location/business/keyword names), hide the
   * hover popup's keyword + coordinate/point rows, and label the business
   * pin generically. Required (not belt-and-suspenders): `?private=true`
   * shares are not DB-privacy-bound, so the public meta/geojson endpoints
   * can still return REAL names for them.
   */
  privacyMode?: boolean;
}

interface HeatmapMetrics {
  avgRank: number | null;
  medianRank: number | null;
  bestRank: number | null;
  worstRank: number | null;
  top3CoveragePct: number | null;
  top10CoveragePct: number | null;
  rankedPointsCount: number | null;
  unrankedPointsCount: number | null;
}

const RANK_LEGEND = HEATMAP_RANK_LEGEND;

function generateInsight(metrics: HeatmapMetrics | null, totalPoints: number): string {
  if (!metrics || !metrics.avgRank) return "";
  const top3Pct = metrics.top3CoveragePct ?? 0;
  const top10Pct = metrics.top10CoveragePct ?? 0;
  const avg = metrics.avgRank;

  if (top3Pct >= 50 && avg <= 5) {
    return "Dominant local visibility across the majority of the service area.";
  }
  if (top3Pct >= 30 && top10Pct >= 60) {
    return "Strong coverage across the core service area with room to expand at the edges.";
  }
  if (top10Pct >= 50) {
    return "Solid mid-range visibility with opportunities to push more positions into the top 3.";
  }
  if (top10Pct >= 30) {
    return "Moderate presence in the market. Rankings soften in the outer service area.";
  }
  if (avg > 15) {
    return "Limited visibility across the grid. Strategic improvements needed to gain local presence.";
  }
  return "Mixed local visibility with varying strength across the service area.";
}

function formatUpdatedDate(dateStr: string | undefined): string {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

export default function InteractiveHeatmap({
  snapshotId,
  locationName,
  keywordName,
  compact = false,
  height,
  hideLegend = false,
  isPublic = false,
  privacyMode = false,
}: InteractiveHeatmapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [transparentMode, setTransparentMode] = useState(false);
  const [showArrows, setShowArrows] = useState(false);
  const [printSnapshot, setPrintSnapshot] = useState<string | null>(null);
  const [printMode, setPrintMode] = useState<boolean>(() => getHeatmapPrintMode());
  const { toast } = useToast();

  // Runtime maplibre-gl load (same-origin vendor route). The init effect
  // below waits on this; nothing map-related can run before it resolves.
  const [gl, setGl] = useState<MaplibreModule | null>(() => getLoadedMaplibre());
  useEffect(() => {
    if (gl) return;
    let alive = true;
    loadMaplibre()
      .then((m) => {
        if (alive) setGl(m);
      })
      .catch((err) => {
        console.error("[InteractiveHeatmap] maplibre-gl runtime load failed:", err);
      });
    return () => {
      alive = false;
    };
  }, [gl]);

  const maptilerEndpoint = isPublic ? "/api/public/config/maptiler-key" : "/api/config/maptiler-key";
  const { data: mapTilerKey, isError: mapTilerError } = useQuery<string>({
    queryKey: [maptilerEndpoint],
    queryFn: async () => {
      const res = await fetch(maptilerEndpoint, isPublic ? undefined : { credentials: "include" });
      if (!res.ok) {
        throw new Error(`Failed to load map configuration (${res.status})`);
      }
      const data = await res.json();
      if (!data.key) {
        throw new Error("Map configuration key is missing");
      }
      return data.key;
    },
    retry: 2,
  });

  const apiBase = isPublic ? "/api/public/heatmaps" : "/api/heatmaps";

  const { data: geojson, isLoading: geojsonLoading } = useQuery({
    queryKey: [apiBase, snapshotId, "geojson"],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/${snapshotId}/geojson?mode=rank`, isPublic ? undefined : { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load heatmap");
      return res.json();
    },
    enabled: !!snapshotId,
    staleTime: 5 * 60 * 1000,
  });

  const { data: meta } = useQuery({
    queryKey: [apiBase, snapshotId, "meta"],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/${snapshotId}/meta`, isPublic ? undefined : { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load meta");
      return res.json();
    },
    enabled: !!snapshotId,
  });

  const metrics: HeatmapMetrics | null = meta?.metrics || null;
  const snapshot = meta?.snapshot;
  const totalPoints = (metrics?.rankedPointsCount ?? 0) + (metrics?.unrankedPointsCount ?? 0);
  const insight = useMemo(() => generateInsight(metrics, totalPoints), [metrics, totalPoints]);
  const updatedDate = formatUpdatedDate(snapshot?.reportDate);
  // Task #4290 — under privacyMode the meta-derived fallbacks are forbidden:
  // props carry the (already masked) payload labels; meta may hold real names.
  const displayName = locationName || (privacyMode ? "" : snapshot?.locationName) || "";
  const displayKeyword = keywordName || (privacyMode ? "" : snapshot?.keywordName) || "";

  const prevSnapshotIdRef = useRef<string | undefined>(undefined);
  const boundsRef = useRef<maplibregl.LngLatBounds | null>(null);

  const applyHeatmapPaint = useCallback((map: maplibregl.Map, isTransparent: boolean) => {
    applyHeatmapPaintHelper(map, isTransparent);
  }, []);

  useEffect(() => {
    if (!gl || !mapContainerRef.current || !mapTilerKey) return;
    if (mapRef.current) return;

    const key = typeof mapTilerKey === "object" ? (mapTilerKey as any).key : mapTilerKey;
    if (!key || typeof key !== "string") return;

    const styleUrl = `https://api.maptiler.com/maps/streets-v2-light/style.json?key=${key}`;

    const map = new gl.Map({
      container: mapContainerRef.current,
      style: styleUrl,
      center: [snapshot?.businessLng || -95, snapshot?.businessLat || 37],
      zoom: 12,
      attributionControl: false,
      // preserveDrawingBuffer keeps the WebGL canvas readable during print
      // rasterization and for map.getCanvas().toDataURL() snapshotting.
      ...({ preserveDrawingBuffer: true } as any),
    });

    map.addControl(new gl.NavigationControl({ showCompass: false }), "top-right");

    const popup = new gl.Popup({
      closeButton: false,
      closeOnClick: false,
      maxWidth: "300px",
      className: "heatmap-popup",
    });
    popupRef.current = popup;

    map.on("load", () => {
      setMapLoaded(true);
    });

    mapRef.current = map;

    return () => {
      popup.remove();
      map.remove();
      mapRef.current = null;
      setMapLoaded(false);
    };
    // The `if (mapRef.current) return` guard makes re-runs no-ops once the
    // map exists, so depending on the snapshot center is safe — it only
    // matters when the snapshot arrives before the map is first created.
  }, [gl, mapTilerKey, snapshot?.businessLng, snapshot?.businessLat]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || !geojson) return;

    // Task #2874: every mutation below (addSource/addLayer/setData/paint)
    // throws "Style is not done loading" if the style is transiently not
    // ready; runWhenMapStyleReady defers + retries instead of letting the
    // throw reach the global error boundary.
    return runWhenMapStyleReady(map, () => {
    const cellFeatures = geojson.features.filter((f: any) => f.geometry.type === "Polygon");
    const pinFeatures = geojson.features.filter((f: any) => f.geometry.type === "Point");

    const cellCollection = { type: "FeatureCollection", features: cellFeatures };
    const pinCollection = { type: "FeatureCollection", features: pinFeatures };

    if (map.getSource("heatmap-cells")) {
      (map.getSource("heatmap-cells") as maplibregl.GeoJSONSource).setData(cellCollection as any);
    } else {
      map.addSource("heatmap-cells", { type: "geojson", data: cellCollection as any });
      map.addLayer({
        id: "heatmap-fill",
        type: "fill",
        source: "heatmap-cells",
        paint: {
          "fill-color": HEATMAP_FILL_COLOR_EXPR as any,
          "fill-opacity": HEATMAP_FILL_OPACITY_EXPR as any,
        },
      });
      map.addLayer({
        id: "heatmap-outline",
        type: "line",
        source: "heatmap-cells",
        paint: {
          "line-color": HEATMAP_OUTLINE_LINE_COLOR_EXPR as any,
          "line-width": 1.5,
        },
      });
      map.addLayer({
        id: "heatmap-labels",
        type: "symbol",
        source: "heatmap-cells",
        layout: {
          "text-field": ["get", "label"],
          "text-size": 12,
          "text-font": ["Open Sans Bold"],
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": "rgba(0,0,0,0.55)",
          "text-halo-width": 1.8,
          "text-opacity": HEATMAP_LABELS_TEXT_OPACITY_EXPR as any,
        },
      });
    }

    if (map.getSource("heatmap-pins")) {
      (map.getSource("heatmap-pins") as maplibregl.GeoJSONSource).setData(pinCollection as any);
    } else {
      map.addSource("heatmap-pins", { type: "geojson", data: pinCollection as any });
      map.addLayer({
        id: "heatmap-pin-glow",
        type: "circle",
        source: "heatmap-pins",
        paint: {
          "circle-radius": 18,
          "circle-color": "rgba(139,46,49,0.12)",
          "circle-blur": 0.9,
        },
      });
      map.addLayer({
        id: "heatmap-pin",
        type: "circle",
        source: "heatmap-pins",
        paint: {
          "circle-radius": 9,
          "circle-color": "#8B2E31", // report-deck crimson (client-facing heatmap artifact, ≈ --report-crimson) — NOT the OS --primary, which re-primaried to Liberty Blue 2026-08; maplibre paint cannot resolve CSS vars
          "circle-stroke-width": 3,
          "circle-stroke-color": "#ffffff",
        },
      });
      map.addLayer({
        id: "heatmap-pin-inner",
        type: "circle",
        source: "heatmap-pins",
        paint: {
          "circle-radius": 3,
          "circle-color": "#ffffff",
        },
      });
      map.addLayer({
        id: "heatmap-pin-label",
        type: "symbol",
        source: "heatmap-pins",
        layout: {
          // Task #4290 — privacy shares must never paint the real business
          // name on the map, even when the geojson (e.g. a non-DB-bound
          // ?private=true share) still carries it.
          "text-field": privacyMode ? "Confidential Client" : ["get", "name"],
          "text-size": 11,
          "text-font": ["Open Sans Bold"],
          "text-offset": [0, 2.2],
          "text-anchor": "top",
        },
        paint: {
          "text-color": "#8B2E31", // report-deck crimson (see pin comment above)
          "text-halo-color": "#ffffff",
          "text-halo-width": 2,
        },
      });
    }

    const arrowFeatures = cellFeatures
      .filter((f: any) => f.properties.diff != null && f.properties.diff !== 0)
      .map((f: any) => ({
        type: "Feature" as const,
        properties: {
          arrow: f.properties.diff > 0 ? "▲" : "▼",
          arrowColor: f.properties.diff > 0 ? HEATMAP_MOVEMENT_COLORS.improved : HEATMAP_MOVEMENT_COLORS.declined,
        },
        geometry: {
          type: "Point" as const,
          coordinates: [f.properties.lng, f.properties.lat],
        },
      }));
    const arrowCollection = { type: "FeatureCollection", features: arrowFeatures };

    if (map.getSource("heatmap-arrows")) {
      (map.getSource("heatmap-arrows") as maplibregl.GeoJSONSource).setData(arrowCollection as any);
    } else {
      map.addSource("heatmap-arrows", { type: "geojson", data: arrowCollection as any });
      map.addLayer({
        id: "heatmap-arrows",
        type: "symbol",
        source: "heatmap-arrows",
        layout: {
          "text-field": ["get", "arrow"],
          "text-size": 10,
          "text-font": ["Open Sans Bold"],
          "text-allow-overlap": true,
          "text-offset": [0, 1.2],
          visibility: "none",
        },
        paint: {
          "text-color": ["get", "arrowColor"],
          "text-halo-color": "rgba(255,255,255,0.9)",
          "text-halo-width": 1.2,
        },
      });
    }

    const snapshotChanged = prevSnapshotIdRef.current !== undefined && prevSnapshotIdRef.current !== snapshotId;
    prevSnapshotIdRef.current = snapshotId;

    if (cellFeatures.length > 0) {
      // The map exists here, so the runtime maplibre module is loaded.
      const bounds = new (getLoadedMaplibre() as MaplibreModule).LngLatBounds();
      cellFeatures.forEach((f: any) => {
        f.geometry.coordinates[0].forEach((coord: number[]) => {
          bounds.extend(coord as [number, number]);
        });
      });
      boundsRef.current = bounds;

      const gridDist = snapshot?.gridDistance;
      let minZoom: number | undefined;
      if (typeof gridDist === "number" && gridDist > 0) {
        const viewMiles = gridDist * 1.4;
        minZoom = Math.round(Math.log2(24901 / viewMiles)) - 1;
      }

      const fitOpts = {
        padding: 25,
        maxZoom: 14,
        ...(typeof minZoom === "number" ? { minZoom } : {}),
        ...(snapshotChanged ? { duration: 600 } : {}),
      };
      map.fitBounds(bounds, fitOpts);
    }

    applyHeatmapPaint(map, transparentMode);
    }, "InteractiveHeatmap.geojson");
    // privacyMode is read for the pin-label text-field (Task #4290) — if it
    // ever flips mid-session the layers must rebuild so the real business
    // name never stays painted on a privacy share.
  }, [geojson, mapLoaded, snapshotId, snapshot?.gridDistance, applyHeatmapPaint, transparentMode, privacyMode]);

  const handleResetMap = () => {
    const map = mapRef.current;
    const bounds = boundsRef.current;
    if (map && bounds) {
      const gridDist = snapshot?.gridDistance;
      let minZoom: number | undefined;
      if (typeof gridDist === "number" && gridDist > 0) {
        const viewMiles = gridDist * 1.4;
        minZoom = Math.round(Math.log2(24901 / viewMiles)) - 1;
      }
      map.fitBounds(bounds, { padding: 25, maxZoom: 14, ...(typeof minZoom === "number" ? { minZoom } : {}) });
    }
  };

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const esc = (s: string) => {
      const el = document.createElement("span");
      el.textContent = s;
      return el.innerHTML;
    };

    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      // queryRenderedFeatures can throw while the style is transiently not
      // ready; a hover must never crash the page (Task #2874).
      let features: maplibregl.MapGeoJSONFeature[] = [];
      try {
        features = map.queryRenderedFeatures(e.point, { layers: ["heatmap-fill"] });
      } catch {
        features = [];
      }
      if (features.length > 0) {
        map.getCanvas().style.cursor = "pointer";
        const props = features[0].properties;
        const rank = esc(String(props?.rankLabel || "N/A").replace(/^#/, ""));
        const movement = esc(String(props?.movementLabel || "N/A"));
        const diff = props?.diff != null ? esc(String(props.diff)) : "N/A";
        const pointId = esc(String(props?.pointId || "—"));
        const lat = Number(props?.lat).toFixed(4);
        const lng = Number(props?.lng).toFixed(4);
        // Task #4290 — privacy shares: only the (masked) keyword prop may
        // render; the meta-derived name can be real.
        const kw = esc(String(privacyMode ? (keywordName || "") : (snapshot?.keywordName || keywordName || "")));
        const date = snapshot?.reportDate ? esc(new Date(snapshot.reportDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })) : "";

        const container = document.createElement("div");
        container.className = "heatmap-popup-inner";
        container.setAttribute("data-testid", "heatmap-hover-card");
        container.innerHTML = `
          <div style="font-family: system-ui, -apple-system, sans-serif; font-size: 12px; line-height: 1.5; padding: 2px 0;">
            <div data-testid="hover-rank" style="font-weight: 700; font-size: 15px; color: #1e293b; margin-bottom: 6px;">
              Rank ${rank}
            </div>
            <div style="display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; color: #475569;">
              <span style="color: #64748b;">Movement</span><span data-testid="hover-movement" style="font-weight: 500;">${movement}</span>
              <span style="color: #64748b;">Diff</span><span data-testid="hover-diff" style="font-weight: 500;">${diff}</span>
              ${kw ? `<span style="color: #64748b;">Keyword</span><span data-testid="hover-keyword" style="font-weight: 500;">${kw}</span>` : ""}
              ${date ? `<span style="color: #64748b;">Date</span><span data-testid="hover-date" style="font-weight: 500;">${date}</span>` : ""}
              ${privacyMode ? "" : `<span style="color: #64748b;">Coords</span><span data-testid="hover-coords" style="font-weight: 500;">${lat}, ${lng}</span>
              <span style="color: #64748b;">Point</span><span data-testid="hover-point" style="font-weight: 500;">${pointId}</span>`}
            </div>
          </div>
        `;
        popupRef.current?.setLngLat(e.lngLat).setDOMContent(container).addTo(map);
      } else {
        map.getCanvas().style.cursor = "";
        popupRef.current?.remove();
      }
    };

    const onMouseLeave = () => {
      map.getCanvas().style.cursor = "";
      popupRef.current?.remove();
    };

    map.on("mousemove", "heatmap-fill", onMouseMove);
    map.on("mouseleave", "heatmap-fill", onMouseLeave);

    return () => {
      map.off("mousemove", "heatmap-fill", onMouseMove);
      map.off("mouseleave", "heatmap-fill", onMouseLeave);
    };
  }, [mapLoaded, snapshot, keywordName, privacyMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    return runWhenMapStyleReady(
      map,
      () => applyHeatmapPaint(map, transparentMode),
      "InteractiveHeatmap.transparentMode",
    );
  }, [transparentMode, mapLoaded, applyHeatmapPaint]);

  // Subscribe to global print-mode changes so we can swap in the captured PNG.
  // When print mode exits, clear the snapshot so the live interactive map is
  // never obscured on screen.
  useEffect(() => {
    return subscribeHeatmapPrintMode((v) => {
      setPrintMode(v);
      if (!v) {
        setPrintSnapshot(null);
      }
    });
  }, []);

  // Register a print preparer: on print, resize, repaint, wait for idle,
  // then capture the visible canvas as a PNG data URL for print-safe rendering.
  useEffect(() => {
    const unregister = registerHeatmapPrintPreparer(async () => {
      const map = mapRef.current;
      const container = mapContainerRef.current;
      if (!map || !container) return;

      // Lock in the current pixel dimensions so the container doesn't collapse.
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        container.style.minHeight = `${Math.round(rect.height)}px`;
      }

      try {
        map.resize();
        map.triggerRepaint();
      } catch {
        // ignore
      }

      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        try {
          void map.once("idle", done); // fire-and-forget: event listener registration, callback resolves the promise
        } catch {
          done();
          return;
        }
        // Safety timeout in case 'idle' never fires.
        setTimeout(done, 2500);
      });

      try {
        const canvas = map.getCanvas();
        // White-composited JPEG (Task #4288): the old PNG snapshots of the
        // WebGL canvas weighed several MB each in the printed PDF.
        const dataUrl = encodeCanvasForPrint(canvas);
        if (dataUrl && dataUrl.length > 100) {
          setPrintSnapshot(dataUrl);
        }
      } catch {
        // Encoding can fail on tainted canvases; leave snapshot null so the
        // live canvas is used as the fallback.
      }
    });
    return unregister;
  }, [mapLoaded]);

  // Register a synchronous best-effort preparer for the browser-native print
  // path (Cmd+P / Ctrl+P) used on screens that don't have an explicit Save-as-
  // PDF button — e.g. the Local Dominance Dashboard and GBP heatmap admin
  // views. `beforeprint` is synchronous, so we capture the already-rendered
  // canvas and flush the snapshot state into the DOM before the browser
  // rasterizes the page.
  useEffect(() => {
    installHeatmapBrowserPrintHooks();
    const unregister = registerHeatmapPrintSyncPreparer(() => {
      const map = mapRef.current;
      const container = mapContainerRef.current;
      if (!map || !container) return;

      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        container.style.minHeight = `${Math.round(rect.height)}px`;
      }

      try {
        map.resize();
        map.triggerRepaint();
      } catch {
        // ignore
      }

      try {
        const canvas = map.getCanvas();
        // Same white-composited JPEG encoding as the async preparer above.
        const dataUrl = encodeCanvasForPrint(canvas);
        if (dataUrl && dataUrl.length > 100) {
          flushSync(() => {
            setPrintSnapshot(dataUrl);
          });
        }
      } catch {
        // Encoding can fail on tainted canvases; leave snapshot null so the
        // live canvas is used as the fallback.
      }
    });
    return unregister;
  }, [mapLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    return runWhenMapStyleReady(
      map,
      () => {
        if (!map.getLayer("heatmap-arrows")) return;
        map.setLayoutProperty("heatmap-arrows", "visibility", showArrows ? "visible" : "none");
      },
      "InteractiveHeatmap.arrows",
    );
  }, [showArrows, mapLoaded, geojson]);

  const isLoading = geojsonLoading || (!mapTilerKey && !mapTilerError);

  const hasMovementData = useMemo(() => {
    if (!geojson?.features) return false;
    return geojson.features.some(
      (f: any) => f.geometry.type === "Polygon" && f.properties.diff != null && f.properties.diff !== 0
    );
  }, [geojson]);

  const handleArrowsClick = useCallback(() => {
    if (!hasMovementData) {
      toast({
        title: "No movement data",
        description: "There are no ranking changes to display for this period.",
        duration: 3000,
      });
      return;
    }
    setShowArrows(prev => !prev);
  }, [hasMovementData, toast]);

  if (compact) {
    return (
      <div data-testid="interactive-heatmap">
        <div className="relative">
          <div
            ref={mapContainerRef}
            data-testid="heatmap-map-container"
            className={`w-full rounded-lg border border-border overflow-hidden heatmap-live-map ${printMode && printSnapshot ? "heatmap-live-map--hidden-print" : ""}`}
            style={{ height: `${height ?? 320}px` }}
          />
          {printMode && printSnapshot && (
            <img
              src={printSnapshot}
              alt="Heatmap print preview"
              aria-hidden="true"
              data-testid="heatmap-print-image"
              className="heatmap-print-image absolute inset-0 w-full h-full object-contain rounded-lg border border-border bg-card"
              style={{ height: `${height ?? 320}px` }}
            />
          )}
          <button
            data-testid="heatmap-reset-map"
            onClick={handleResetMap}
            className="absolute top-2 left-2 z-10 flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-foreground bg-card/90 hover:bg-card border border-border shadow-sm transition-all"
          >
            <Maximize2 className="h-3 w-3" />
            Reset Map
          </button>
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-card/70 rounded-lg">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {mapTilerError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-card/90 rounded-lg" data-testid="heatmap-map-error">
              <AlertTriangle className="h-5 w-5 text-amber-500 mb-1" />
              <span className="text-xs text-muted-foreground">Map unavailable</span>
            </div>
          )}
          <div className="absolute bottom-2 left-2 z-10 flex items-center gap-1" data-testid="heatmap-map-toggles">
            <button
              data-testid="heatmap-transparency-toggle"
              onClick={() => setTransparentMode(!transparentMode)}
              className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium border shadow-sm transition-all ${
                transparentMode
                  ? "bg-slate-700 text-white border-slate-600"
                  : "bg-card/90 text-foreground border-border hover:bg-card"
              }`}
              title={transparentMode ? "Show full heatmap" : "Make heatmap transparent"}
            >
              <Layers className="h-3 w-3" />
              X-Ray
            </button>
            <button
              data-testid="heatmap-arrows-toggle"
              onClick={handleArrowsClick}
              className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium border shadow-sm transition-all ${
                !hasMovementData
                  ? "bg-muted text-muted-foreground border-border cursor-not-allowed opacity-60"
                  : showArrows
                    ? "bg-slate-700 text-white border-slate-600"
                    : "bg-card/90 text-foreground border-border hover:bg-card"
              }`}
              title={!hasMovementData ? "No movement data — no ranking changes for this period" : showArrows ? "Hide movement arrows" : "Show movement arrows"}
            >
              <ArrowUpDown className="h-3 w-3" />
              Arrows
            </button>
          </div>
        </div>
        {!hideLegend && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 px-1" data-testid="heatmap-legend">
            {RANK_LEGEND.map((item) => (
              <div key={item.label} className="flex items-center gap-1 text-xs" data-testid={`legend-item-${item.label.toLowerCase().replace(/[\s+]/g, "-")}`}>
                <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: item.color, opacity: 0.85 }} />
                <span className="text-foreground/80">{item.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div data-testid="interactive-heatmap" className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
      <div className="px-5 pt-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-foreground" data-testid="heatmap-location-name">
              {displayName || "Google Map Rankings"}
            </h3>
            <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground" data-testid="heatmap-keyword-name">
              {displayKeyword && <span>Keyword: <strong>{displayKeyword}</strong></span>}
              {displayKeyword && updatedDate && <span className="text-slate-300">|</span>}
              {updatedDate && <span data-testid="heatmap-updated-date">Updated: {updatedDate}</span>}
            </div>
            {insight && (
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed" data-testid="heatmap-insight">
                {insight}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              data-testid="heatmap-reset-map"
              onClick={handleResetMap}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted border border-border transition-all"
            >
              <Maximize2 className="h-3 w-3" />
              Reset Map
            </button>
          </div>
        </div>
      </div>

      {metrics && (
        <div className="px-5 py-2.5 bg-muted/60 border-y border-border" data-testid="heatmap-metrics-bar">
          <div className="flex items-center gap-6 flex-wrap">
            <MetricPill label="Avg Rank" value={metrics.avgRank ? metrics.avgRank.toFixed(1) : "N/A"} />
            <MetricPill
              label="Top 3"
              value={metrics.top3CoveragePct !== null ? `${metrics.top3CoveragePct}%` : "N/A"}
              accent={metrics.top3CoveragePct !== null && metrics.top3CoveragePct >= 30}
            />
            <MetricPill
              label="Top 10"
              value={metrics.top10CoveragePct !== null ? `${metrics.top10CoveragePct}%` : "N/A"}
              accent={metrics.top10CoveragePct !== null && metrics.top10CoveragePct >= 60}
            />
            <MetricPill label="Grid Points" value={totalPoints > 0 ? `${totalPoints}` : "N/A"} />
            {metrics.bestRank && (
              <MetricPill label="Best" value={`${metrics.bestRank}`} />
            )}
          </div>
        </div>
      )}

      <div className="relative">
        <div
          ref={mapContainerRef}
          data-testid="heatmap-map-container"
          className={`w-full heatmap-live-map ${printMode && printSnapshot ? "heatmap-live-map--hidden-print" : ""}`}
          style={{ height: "480px" }}
        />
        {printMode && printSnapshot && (
          <img
            src={printSnapshot}
            alt="Heatmap print preview"
            aria-hidden="true"
            data-testid="heatmap-print-image"
            className="heatmap-print-image absolute inset-0 w-full h-full object-contain bg-card"
            style={{ height: "480px" }}
          />
        )}

        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-card/70">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}
        {mapTilerError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-card/90" data-testid="heatmap-map-error">
            <AlertTriangle className="h-6 w-6 text-amber-500 mb-2" />
            <span className="text-sm text-muted-foreground font-medium">Map unavailable</span>
            <span className="text-xs text-muted-foreground mt-1">Unable to load map configuration</span>
          </div>
        )}
        <div className="absolute bottom-3 left-3 z-10 flex items-center gap-1.5" data-testid="heatmap-map-toggles">
          <button
            data-testid="heatmap-transparency-toggle"
            onClick={() => setTransparentMode(!transparentMode)}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border shadow-sm transition-all backdrop-blur-sm ${
              transparentMode
                ? "bg-slate-700 text-white border-slate-600"
                : "bg-card/90 text-muted-foreground border-border hover:bg-card"
            }`}
            title={transparentMode ? "Show full heatmap" : "Make heatmap transparent"}
          >
            <Layers className="h-3.5 w-3.5" />
            X-Ray
          </button>
          <button
            data-testid="heatmap-arrows-toggle"
            onClick={handleArrowsClick}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border shadow-sm transition-all backdrop-blur-sm ${
              !hasMovementData
                ? "bg-muted text-muted-foreground border-border cursor-not-allowed opacity-60"
                : showArrows
                  ? "bg-slate-700 text-white border-slate-600"
                  : "bg-card/90 text-muted-foreground border-border hover:bg-card"
            }`}
            title={!hasMovementData ? "No movement data — no ranking changes for this period" : showArrows ? "Hide movement arrows" : "Show movement arrows"}
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
            Arrows
          </button>
        </div>
      </div>

      <div className="px-5 py-3 border-t border-border bg-card" data-testid="heatmap-legend">
        <div className="flex items-center gap-5">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold shrink-0">
            Rank Position
          </span>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {RANK_LEGEND.map((item) => (
              <div key={item.label} className="flex items-center gap-1.5" data-testid={`legend-item-${item.label.toLowerCase().replace(/[\s+]/g, "-")}`}>
                <div
                  className="w-3 h-3 rounded"
                  style={{ backgroundColor: item.color, opacity: 0.85 }}
                />
                <span className="text-xs text-muted-foreground font-medium">{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {metrics && (
        <div className="px-5 py-3 border-t border-border bg-muted/40">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="heatmap-metrics-panel">
            <MetricCard label="Avg Rank" value={metrics.avgRank ? metrics.avgRank.toFixed(1) : "N/A"} />
            <MetricCard label="Best Rank" value={metrics.bestRank ? `${metrics.bestRank}` : "N/A"} />
            <MetricCard
              label="Top 3 Coverage"
              value={metrics.top3CoveragePct !== null ? `${metrics.top3CoveragePct}%` : "N/A"}
              accent={metrics.top3CoveragePct !== null && metrics.top3CoveragePct >= 30}
            />
            <MetricCard
              label="Top 10 Coverage"
              value={metrics.top10CoveragePct !== null ? `${metrics.top10CoveragePct}%` : "N/A"}
              accent={metrics.top10CoveragePct !== null && metrics.top10CoveragePct >= 60}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function MetricPill({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center gap-1.5" data-testid={`metric-pill-${label.toLowerCase().replace(/\s/g, "-")}`}>
      <span className="text-[11px] text-muted-foreground font-medium">{label}</span>
      <span className={`text-sm font-bold ${accent ? "text-green-700" : "text-foreground"}`}>{value}</span>
    </div>
  );
}

function MetricCard({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  const tid = `metric-card-${label.toLowerCase().replace(/\s/g, "-")}`;
  return (
    <div data-testid={tid} className={`rounded-lg border px-3 py-2 ${accent ? "bg-green-50/80 border-green-200" : "bg-card border-border"}`}>
      <div className="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">{label}</div>
      <div data-testid={`${tid}-value`} className={`text-lg font-bold ${accent ? "text-green-700" : "text-foreground"}`}>{value}</div>
    </div>
  );
}
