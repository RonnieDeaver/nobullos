import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
// maplibre-gl is loaded at runtime from the same-origin vendor route
// (~1 MB kept out of the publish bundle) — see client/src/lib/loadMaplibre.ts.
// Only TYPES may be imported from the package here; a value import would
// re-bundle it and fail scripts/lint-bundle-budget.ts.
import type * as maplibregl from "maplibre-gl";
import { loadMaplibre, getLoadedMaplibre, type MaplibreModule } from "@/lib/loadMaplibre";
import { runWhenMapStyleReady } from "@/lib/mapStyleReady";

// Per-client series palette. Slot 1 is the --primary token value (Liberty
// Blue #485696 since the 2026-08 re-primary); literals are required here —
// this palette feeds maplibre data-driven paint expressions (pinColor),
// which cannot resolve CSS variables.
const CLIENT_COLORS = [
  "#485696", "#2563eb", "#059669", "#d97706", "#7c3aed",
  "#0891b2", "#be185d", "#4338ca", "#15803d", "#b45309",
];

function getClientColor(clientId: string, clientIds: string[]): string {
  const idx = clientIds.indexOf(clientId);
  return CLIENT_COLORS[idx % CLIENT_COLORS.length];
}

interface HexGridMapProps {
  stateAbbr: string;
  stateName: string;
  practiceArea?: string;
  onMarketAreaClick?: (marketAreaId: string) => void;
  onBack?: () => void;
}

interface GeoJSONResponse {
  hexes: GeoJSON.FeatureCollection;
  heatPoints: GeoJSON.FeatureCollection;
  pins: GeoJSON.FeatureCollection;
  practiceArea: string;
  marketCapacityPercent: number;
}

const STATE_GEO_BOUNDS: Record<string, { minLat: number; maxLat: number; minLng: number; maxLng: number }> = {
  AL: { minLat: 30.22, maxLat: 35.01, minLng: -88.47, maxLng: -84.89 },
  AK: { minLat: 51.21, maxLat: 71.39, minLng: -179.15, maxLng: -129.98 },
  AZ: { minLat: 31.33, maxLat: 37.00, minLng: -114.81, maxLng: -109.04 },
  AR: { minLat: 33.00, maxLat: 36.50, minLng: -94.62, maxLng: -89.64 },
  CA: { minLat: 32.53, maxLat: 42.01, minLng: -124.41, maxLng: -114.13 },
  CO: { minLat: 36.99, maxLat: 41.00, minLng: -109.06, maxLng: -102.04 },
  CT: { minLat: 40.98, maxLat: 42.05, minLng: -73.73, maxLng: -71.79 },
  DE: { minLat: 38.45, maxLat: 39.84, minLng: -75.79, maxLng: -75.05 },
  FL: { minLat: 24.40, maxLat: 31.00, minLng: -87.63, maxLng: -80.03 },
  GA: { minLat: 30.36, maxLat: 35.00, minLng: -85.61, maxLng: -80.84 },
  HI: { minLat: 18.91, maxLat: 22.24, minLng: -160.24, maxLng: -154.81 },
  ID: { minLat: 41.99, maxLat: 49.00, minLng: -117.24, maxLng: -111.04 },
  IL: { minLat: 36.97, maxLat: 42.51, minLng: -91.51, maxLng: -87.02 },
  IN: { minLat: 37.77, maxLat: 41.76, minLng: -88.10, maxLng: -84.78 },
  IA: { minLat: 40.38, maxLat: 43.50, minLng: -96.64, maxLng: -90.14 },
  KS: { minLat: 36.99, maxLat: 40.00, minLng: -102.05, maxLng: -94.59 },
  KY: { minLat: 36.50, maxLat: 39.15, minLng: -89.57, maxLng: -81.96 },
  LA: { minLat: 28.93, maxLat: 33.02, minLng: -94.04, maxLng: -88.82 },
  ME: { minLat: 43.06, maxLat: 47.46, minLng: -71.08, maxLng: -66.95 },
  MD: { minLat: 37.91, maxLat: 39.72, minLng: -79.49, maxLng: -75.05 },
  MA: { minLat: 41.24, maxLat: 42.89, minLng: -73.51, maxLng: -69.93 },
  MI: { minLat: 41.70, maxLat: 48.26, minLng: -90.42, maxLng: -82.12 },
  MN: { minLat: 43.50, maxLat: 49.38, minLng: -97.24, maxLng: -89.49 },
  MS: { minLat: 30.17, maxLat: 35.00, minLng: -91.66, maxLng: -88.10 },
  MO: { minLat: 35.99, maxLat: 40.61, minLng: -95.77, maxLng: -89.10 },
  MT: { minLat: 44.36, maxLat: 49.00, minLng: -116.05, maxLng: -104.04 },
  NE: { minLat: 40.00, maxLat: 43.00, minLng: -104.05, maxLng: -95.31 },
  NV: { minLat: 35.00, maxLat: 42.00, minLng: -120.01, maxLng: -114.04 },
  NH: { minLat: 42.70, maxLat: 45.31, minLng: -72.56, maxLng: -70.70 },
  NJ: { minLat: 38.93, maxLat: 41.36, minLng: -75.56, maxLng: -73.89 },
  NM: { minLat: 31.33, maxLat: 37.00, minLng: -109.05, maxLng: -103.00 },
  NY: { minLat: 40.50, maxLat: 45.01, minLng: -79.76, maxLng: -71.86 },
  NC: { minLat: 33.84, maxLat: 36.59, minLng: -84.32, maxLng: -75.46 },
  ND: { minLat: 45.94, maxLat: 49.00, minLng: -104.05, maxLng: -96.55 },
  OH: { minLat: 38.40, maxLat: 41.98, minLng: -84.82, maxLng: -80.52 },
  OK: { minLat: 33.62, maxLat: 37.00, minLng: -103.00, maxLng: -94.43 },
  OR: { minLat: 41.99, maxLat: 46.29, minLng: -124.57, maxLng: -116.46 },
  PA: { minLat: 39.72, maxLat: 42.27, minLng: -80.52, maxLng: -74.69 },
  RI: { minLat: 41.15, maxLat: 42.02, minLng: -71.86, maxLng: -71.12 },
  SC: { minLat: 32.05, maxLat: 35.22, minLng: -83.35, maxLng: -78.54 },
  SD: { minLat: 42.48, maxLat: 45.94, minLng: -104.06, maxLng: -96.44 },
  TN: { minLat: 34.98, maxLat: 36.68, minLng: -90.31, maxLng: -81.65 },
  TX: { minLat: 25.84, maxLat: 36.50, minLng: -106.65, maxLng: -93.51 },
  UT: { minLat: 36.99, maxLat: 42.00, minLng: -114.05, maxLng: -109.04 },
  VT: { minLat: 42.73, maxLat: 45.02, minLng: -73.44, maxLng: -71.46 },
  VA: { minLat: 36.54, maxLat: 39.47, minLng: -83.68, maxLng: -75.24 },
  WA: { minLat: 45.54, maxLat: 49.00, minLng: -124.85, maxLng: -116.92 },
  WV: { minLat: 37.20, maxLat: 40.64, minLng: -82.64, maxLng: -77.72 },
  WI: { minLat: 42.49, maxLat: 47.08, minLng: -92.89, maxLng: -86.25 },
  WY: { minLat: 40.99, maxLat: 45.01, minLng: -111.06, maxLng: -104.05 },
  DC: { minLat: 38.79, maxLat: 38.99, minLng: -77.12, maxLng: -76.91 },
};

const HEX_ZOOM_THRESHOLD = 8;

export function HexGridMap({ stateAbbr, stateName, practiceArea }: HexGridMapProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [hoveredHex, setHoveredHex] = useState<any>(null);
  const [hoveredPin, setHoveredPin] = useState<any>(null);
  const [hoveredHeat, setHoveredHeat] = useState<any>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const [sourcesReady, setSourcesReady] = useState(false);
  const geoDataRef = useRef<GeoJSONResponse | null>(null);

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
        console.error("[HexGridMap] maplibre-gl runtime load failed:", err);
      });
    return () => {
      alive = false;
    };
  }, [gl]);

  const getMapOffset = useCallback(() => {
    if (!wrapperRef.current || !mapContainerRef.current) return { top: 0, left: 0 };
    const wrapperRect = wrapperRef.current.getBoundingClientRect();
    const mapRect = mapContainerRef.current.getBoundingClientRect();
    return { top: mapRect.top - wrapperRect.top, left: mapRect.left - wrapperRect.left };
  }, []);

  const queryPractice = practiceArea && practiceArea !== "_all" ? practiceArea : undefined;

  const { data: mapTilerKey } = useQuery<string>({
    queryKey: ["/api/config/maptiler-key"],
    queryFn: async () => {
      const res = await fetch("/api/config/maptiler-key", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch MapTiler key");
      const json = await res.json();
      return json.key;
    },
    staleTime: Infinity,
  });

  const { data: geoData, isLoading, error } = useQuery<GeoJSONResponse>({
    queryKey: ["/api/mcu/internal/hex-grid-geojson", stateAbbr, queryPractice],
    queryFn: async () => {
      const params = new URLSearchParams({ state: stateAbbr });
      if (queryPractice) params.set("practice", queryPractice);
      const res = await fetch(`/api/mcu/internal/hex-grid-geojson?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load hex grid GeoJSON");
      return res.json();
    },
    staleTime: 60_000,
  });

  geoDataRef.current = geoData ?? null;

  const uniqueClientIds = useMemo(() => {
    if (!geoData?.pins?.features) return [];
    const ids = new Set<string>();
    geoData.pins.features.forEach((f: any) => ids.add(f.properties.clientId));
    return Array.from(ids);
  }, [geoData]);

  const fitMapToBounds = useCallback((map: maplibregl.Map) => {
    if (!geoData) return;

    // Callers only pass a live map, so the runtime maplibre module is loaded.
    const bounds = new (getLoadedMaplibre() as MaplibreModule).LngLatBounds();
    let hasPoints = false;

    if (geoData.pins.features.length > 0) {
      for (const f of geoData.pins.features) {
        const coords = (f.geometry as any).coordinates;
        bounds.extend(coords as [number, number]);
        hasPoints = true;
      }
    }

    if (geoData.heatPoints.features.length > 0) {
      for (const f of geoData.heatPoints.features) {
        const coords = (f.geometry as any).coordinates;
        bounds.extend(coords as [number, number]);
        hasPoints = true;
      }
    }

    if (!hasPoints) {
      const stateBounds = STATE_GEO_BOUNDS[stateAbbr];
      if (stateBounds) {
        bounds.extend([stateBounds.minLng, stateBounds.minLat]);
        bounds.extend([stateBounds.maxLng, stateBounds.maxLat]);
      }
    }

    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 60, maxZoom: 12, duration: 800 });
    }
  }, [geoData, stateAbbr]);

  useEffect(() => {
    if (!gl || !mapContainerRef.current || !mapTilerKey) return;
    if (mapRef.current) return;

    const map = new gl.Map({
      container: mapContainerRef.current,
      style: `https://api.maptiler.com/maps/streets-v2/style.json?key=${mapTilerKey}`,
      center: [-98.5, 39.8],
      zoom: 4,
      attributionControl: false,
    });

    map.addControl(new gl.NavigationControl(), "top-right");
    map.addControl(new gl.AttributionControl({ compact: true }), "bottom-right");

    mapRef.current = map;

    void map.once("styledata", () => { // fire-and-forget: one-shot map resize on style load
      map.resize();
    });

    map.on("load", () => {
      // Task #2874: even inside the "load" handler the style can be
      // transiently not ready (style swap/reload); defer + retry instead of
      // letting "Style is not done loading" reach the global error boundary.
      runWhenMapStyleReady(map, () => {
      map.addSource("heat-points", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addSource("hex-polygons", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addSource("client-pins", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addLayer({
        id: "heatmap-layer",
        type: "heatmap",
        source: "heat-points",
        maxzoom: HEX_ZOOM_THRESHOLD + 1,
        paint: {
          "heatmap-weight": ["get", "weight"],
          "heatmap-intensity": 1.0,
          "heatmap-radius": [
            "interpolate", ["linear"], ["zoom"],
            5, 10,
            7, 18,
            9, 28,
          ],
          "heatmap-color": [
            "interpolate", ["linear"], ["heatmap-density"],
            0, "rgba(0,0,0,0)",
            0.1, "rgba(74,222,128,0.3)",
            0.3, "rgba(74,222,128,0.5)",
            0.5, "rgba(200,210,80,0.55)",
            0.7, "rgba(251,191,36,0.6)",
            0.85, "rgba(251,146,60,0.65)",
            1, "rgba(239,90,50,0.7)",
          ],
          "heatmap-opacity": [
            "interpolate", ["linear"], ["zoom"],
            5, 0.7,
            HEX_ZOOM_THRESHOLD, 0.4,
            HEX_ZOOM_THRESHOLD + 1, 0.0,
          ],
        },
      });

      map.addLayer({
        id: "hex-fill-layer",
        type: "fill",
        source: "hex-polygons",
        minzoom: HEX_ZOOM_THRESHOLD,
        paint: {
          "fill-color": [
            "interpolate", ["linear"], ["get", "capacityUsedPercent"],
            0, "rgb(187,247,208)",
            10, "rgb(134,239,172)",
            20, "rgb(74,222,128)",
            35, "rgb(163,230,53)",
            50, "rgb(250,204,21)",
            65, "rgb(251,146,60)",
            80, "rgb(239,68,68)",
            95, "rgb(185,28,28)",
            100, "rgb(127,29,29)",
          ],
          "fill-opacity": [
            "interpolate", ["linear"], ["zoom"],
            HEX_ZOOM_THRESHOLD, 0.0,
            HEX_ZOOM_THRESHOLD + 0.5, 0.65,
          ],
        },
      });

      map.addLayer({
        id: "hex-outline-layer",
        type: "line",
        source: "hex-polygons",
        minzoom: HEX_ZOOM_THRESHOLD,
        paint: {
          "line-color": "rgba(255,255,255,0.6)",
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            HEX_ZOOM_THRESHOLD, 0,
            HEX_ZOOM_THRESHOLD + 0.5, 0.5,
            14, 1,
          ],
        },
      });

      map.addLayer({
        id: "pin-circle-layer",
        type: "circle",
        source: "client-pins",
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            5, 4,
            8, 6,
            12, 8,
          ],
          "circle-color": "#485696", // = --primary token value, Liberty Blue (maplibre paint cannot resolve CSS vars)
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });

      map.addLayer({
        id: "pin-label-layer",
        type: "symbol",
        source: "client-pins",
        minzoom: 9,
        layout: {
          "text-field": ["get", "clientName"],
          "text-size": [
            "interpolate", ["linear"], ["zoom"],
            9, 10,
            12, 13,
          ],
          "text-offset": [1.2, 0],
          "text-anchor": "left",
          "text-max-width": 12,
          "text-allow-overlap": false,
          "text-ignore-placement": false,
          "text-font": ["Noto Sans Regular"],
        },
        paint: {
          "text-color": "rgba(139,46,49,0.85)",
          "text-halo-color": "rgba(255,255,255,0.85)",
          "text-halo-width": 1.5,
        },
      });

      setSourcesReady(true);

      const currentData = geoDataRef.current;
      if (currentData) {
        const heatSrc = map.getSource("heat-points") as maplibregl.GeoJSONSource;
        const hexSrc = map.getSource("hex-polygons") as maplibregl.GeoJSONSource;
        const pinSrc = map.getSource("client-pins") as maplibregl.GeoJSONSource;
        if (heatSrc) heatSrc.setData(currentData.heatPoints as any);
        if (hexSrc) hexSrc.setData(currentData.hexes as any);
        if (pinSrc) pinSrc.setData(currentData.pins as any);

        map.resize();
        const bounds = new gl.LngLatBounds();
        let hasPoints = false;
        for (const f of currentData.pins.features) {
          bounds.extend((f.geometry as any).coordinates as [number, number]);
          hasPoints = true;
        }
        for (const f of currentData.heatPoints.features) {
          bounds.extend((f.geometry as any).coordinates as [number, number]);
          hasPoints = true;
        }
        if (hasPoints && !bounds.isEmpty()) {
          map.fitBounds(bounds, { padding: 60, maxZoom: 12, duration: 800 });
        }
      }
      }, "HexGridMap.load");
    });

    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      const mapOffset = getMapOffset();
      const pos = { x: e.point.x + mapOffset.left, y: e.point.y + mapOffset.top };

      const hasPin = map.getLayer("pin-circle-layer");
      const hasHex = map.getLayer("hex-fill-layer");

      // query* can throw while the style is transiently not ready; a hover
      // must never crash the page (Task #2874).
      const safeQuery = (layers: string[]) => {
        try {
          return map.queryRenderedFeatures(e.point, { layers });
        } catch {
          return [];
        }
      };

      const pinFeatures = hasPin ? safeQuery(["pin-circle-layer"]) : [];
      if (pinFeatures.length > 0) {
        map.getCanvas().style.cursor = "pointer";
        const props = pinFeatures[0].properties;
        let practiceAreas = props?.practiceAreas;
        if (typeof practiceAreas === "string") {
          try { practiceAreas = JSON.parse(practiceAreas); } catch { practiceAreas = []; }
        }
        let diagnostics = props?.radiusDiagnostics;
        if (typeof diagnostics === "string") {
          try { diagnostics = JSON.parse(diagnostics); } catch { diagnostics = null; }
        }
        setHoveredPin({
          clientName: props?.clientName,
          city: props?.city,
          r2Radius: props?.r2Radius,
          practiceAreas: practiceAreas || [],
          diagnostics: diagnostics || null,
        });
        setHoveredHex(null);
        setHoveredHeat(null);
        setTooltipPos(pos);
        return;
      }

      const hexFeatures = hasHex ? safeQuery(["hex-fill-layer"]) : [];
      if (hexFeatures.length > 0) {
        map.getCanvas().style.cursor = "pointer";
        const props = hexFeatures[0].properties;
        let contributors = props?.contributors;
        if (typeof contributors === "string") {
          try { contributors = JSON.parse(contributors); } catch { contributors = []; }
        }
        setHoveredHex({
          hexId: props?.hexId,
          capacityUsedPercent: props?.capacityUsedPercent,
          status: props?.status,
          statusColor: props?.statusColor,
          effectiveClients: props?.effectiveClients,
          contributors: contributors || [],
        });
        setHoveredPin(null);
        setHoveredHeat(null);
        setTooltipPos(pos);
        return;
      }

      const zoom = map.getZoom();
      if (zoom < HEX_ZOOM_THRESHOLD) {
        const heatSrc = map.getSource("heat-points");
        if (heatSrc) {
          let nearbyPoints: ReturnType<typeof map.querySourceFeatures> = [];
          try {
            nearbyPoints = map.querySourceFeatures("heat-points");
          } catch {
            nearbyPoints = [];
          }
          if (nearbyPoints.length > 0) {
            const lngLat = map.unproject(e.point);
            let closest: any = null;
            let closestDist = Infinity;
            for (const f of nearbyPoints) {
              const coords = (f.geometry as any).coordinates;
              if (!coords) continue;
              const dx = coords[0] - lngLat.lng;
              const dy = coords[1] - lngLat.lat;
              const dist = dx * dx + dy * dy;
              if (dist < closestDist) {
                closestDist = dist;
                closest = f;
              }
            }
            if (closest && closestDist < 0.01) {
              map.getCanvas().style.cursor = "crosshair";
              const props = closest.properties;
              setHoveredHeat({
                capacityUsedPercent: props?.capacityUsedPercent ?? Math.round((props?.weight ?? 0) * 100),
                status: props?.status ?? "Open",
              });
              setHoveredHex(null);
              setHoveredPin(null);
              setTooltipPos(pos);
              return;
            }
          }
        }
      }

      map.getCanvas().style.cursor = "";
      setHoveredHex(null);
      setHoveredPin(null);
      setHoveredHeat(null);
    };

    const onMouseLeave = () => {
      map.getCanvas().style.cursor = "";
      setHoveredHex(null);
      setHoveredPin(null);
      setHoveredHeat(null);
    };

    map.on("mousemove", onMouseMove);
    map.on("mouseout", onMouseLeave);

    map.on("error", (e: any) => {
      console.error("[HexGridMap] Map error:", e.error?.message || e);
    });

    return () => {
      mapRef.current = null;
      setSourcesReady(false);
      map.remove();
    };
    // `getMapOffset` is a stable useCallback (empty deps), so including it
    // never re-creates the map.
  }, [gl, mapTilerKey, getMapOffset]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !sourcesReady || !geoData) return;

    const updateSources = () => {
      const heatSrc = map.getSource("heat-points") as maplibregl.GeoJSONSource;
      const hexSrc = map.getSource("hex-polygons") as maplibregl.GeoJSONSource;
      const pinSrc = map.getSource("client-pins") as maplibregl.GeoJSONSource;

      if (heatSrc) heatSrc.setData(geoData.heatPoints as any);
      if (hexSrc) hexSrc.setData(geoData.hexes as any);

      if (pinSrc && uniqueClientIds.length > 0) {
        const coloredPins = {
          ...geoData.pins,
          features: geoData.pins.features.map((f: any) => ({
            ...f,
            properties: {
              ...f.properties,
              pinColor: getClientColor(f.properties.clientId, uniqueClientIds),
            },
          })),
        };
        pinSrc.setData(coloredPins as any);

        map.setPaintProperty("pin-circle-layer", "circle-color", ["get", "pinColor"]);
      }

      map.resize();
      fitMapToBounds(map);
    };

    // Task #2874: runWhenMapStyleReady replaces the old isStyleLoaded/once
    // pair — it also catches a "Style is not done loading" throw from the
    // mutations themselves and retries, instead of crashing the page.
    return runWhenMapStyleReady(map, updateSources, "HexGridMap.updateSources");
  }, [geoData, uniqueClientIds, fitMapToBounds, sourcesReady]);

  const getGradientColor = (capacityPct: number): string => {
    const stops = [
      { pct: 0, r: 187, g: 247, b: 208 },
      { pct: 10, r: 134, g: 239, b: 172 },
      { pct: 20, r: 74, g: 222, b: 128 },
      { pct: 35, r: 163, g: 230, b: 53 },
      { pct: 50, r: 250, g: 204, b: 21 },
      { pct: 65, r: 251, g: 146, b: 60 },
      { pct: 80, r: 239, g: 68, b: 68 },
      { pct: 95, r: 185, g: 28, b: 28 },
      { pct: 100, r: 127, g: 29, b: 29 },
    ];
    const clamped = Math.max(0, Math.min(100, capacityPct));
    let lower = stops[0], upper = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (clamped >= stops[i].pct && clamped <= stops[i + 1].pct) {
        lower = stops[i]; upper = stops[i + 1]; break;
      }
    }
    const range = upper.pct - lower.pct || 1;
    const t = (clamped - lower.pct) / range;
    const r = Math.round(lower.r + (upper.r - lower.r) * t);
    const g = Math.round(lower.g + (upper.g - lower.g) * t);
    const b = Math.round(lower.b + (upper.b - lower.b) * t);
    return `rgb(${r},${g},${b})`;
  };

  const showLoading = isLoading || !mapTilerKey;
  const showError = !showLoading && (error || !geoData);
  const showMap = !showLoading && !showError && !!geoData;

  return (
    <div className="relative" ref={wrapperRef} data-testid={`hex-grid-map-${stateAbbr}`}>
      {showLoading && (
        <div className="flex items-center justify-center h-64 text-muted-foreground text-sm" data-testid="hex-grid-loading">
          <div className="flex flex-col items-center gap-2">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <span>Loading map for {stateName}...</span>
          </div>
        </div>
      )}

      {showError && (
        <div className="flex items-center justify-center h-64 text-muted-foreground text-sm" data-testid="hex-grid-empty">
          No hex grid data available for {stateName}
        </div>
      )}

      {showMap && (
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h3 className="text-sm font-semibold text-foreground">
            {stateName} — Territory Coverage ({geoData.practiceArea})
          </h3>
          <div className="flex items-center gap-3">
            <div className="flex flex-col items-center gap-0.5">
              <div
                className="h-2 rounded-full"
                style={{
                  width: 140,
                  background: `linear-gradient(to right, rgb(187,247,208) 0%, rgb(74,222,128) 20%, rgb(163,230,53) 35%, rgb(250,204,21) 50%, rgb(251,146,60) 65%, rgb(239,68,68) 80%, rgb(185,28,28) 95%, rgb(127,29,29) 100%)`,
                }}
              />
              <div className="flex justify-between" style={{ width: 140 }}>
                <span className="text-[8px] text-muted-foreground/70">0%</span>
                <span className="text-[8px] text-muted-foreground/70">Open</span>
                <span className="text-[8px] text-muted-foreground/70">Filling</span>
                <span className="text-[8px] text-muted-foreground/70">Tight</span>
                <span className="text-[8px] text-muted-foreground/70">100%</span>
              </div>
            </div>
            <button
              onClick={() => {
                const map = mapRef.current;
                if (map) fitMapToBounds(map);
              }}
              className="text-[10px] px-2 py-0.5 rounded bg-primary text-primary-foreground hover:bg-[#8a3d55] transition-colors"
              data-testid="btn-zoom-locations"
            >
              Fit to Locations
            </button>
          </div>
        </div>
      )}

      <div
        ref={mapContainerRef}
        className="w-full rounded-xl overflow-hidden"
        style={{ height: showMap ? 480 : 0, visibility: showMap ? "visible" : "hidden" }}
        data-testid="maplibre-container"
      />

      {showMap && geoData && (
        <div className="mt-1 flex items-center justify-between flex-wrap gap-2 px-1">
          <div className="flex items-center gap-3 flex-wrap text-xs">
            {geoData.pins.features.map((f: any) => {
              const color = getClientColor(f.properties.clientId, uniqueClientIds);
              return (
                <div key={f.properties.locationId} className="flex items-center gap-1">
                  <span
                    className="w-2.5 h-2.5 rounded-full inline-block border border-white"
                    style={{ backgroundColor: color }}
                  />
                  <span className="text-muted-foreground">{f.properties.clientName} ({f.properties.city})</span>
                </div>
              );
            })}
          </div>
          <span className="text-[10px] text-muted-foreground/60">
            Scroll to zoom, drag to pan — zoom in for hex detail
          </span>
        </div>
      )}

      {hoveredHex && tooltipPos && (
        <div
          className="absolute z-50 pointer-events-none bg-card/95 backdrop-blur-sm border border-border rounded-xl shadow-xl px-4 py-3 text-sm"
          style={{
            left: Math.min(Math.max(tooltipPos.x + 16, 10), (wrapperRef.current?.offsetWidth || 600) - 290),
            top: Math.max(tooltipPos.y - 10, 10),
            maxWidth: 280,
          }}
        >
          <div className="font-bold text-foreground mb-1.5 flex items-center gap-2">
            <span
              className="w-3 h-3 inline-block"
              style={{
                backgroundColor: getGradientColor(hoveredHex.capacityUsedPercent),
                clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)",
              }}
            />
            {hoveredHex.status}
          </div>
          <div className="space-y-1 text-xs text-muted-foreground">
            <div className="flex justify-between gap-4">
              <span>Capacity Used</span>
              <span className="font-bold text-sm" style={{ color: getGradientColor(hoveredHex.capacityUsedPercent) }}>
                {hoveredHex.capacityUsedPercent}%
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span>Effective Clients</span>
              <span className="font-medium text-foreground">{hoveredHex.effectiveClients}</span>
            </div>
            {hoveredHex.contributors && hoveredHex.contributors.length > 0 && (
              <>
                <div className="h-px bg-[#e5ddd5] my-1" />
                <div className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider">Contributing Offices</div>
                {Array.from(
                  new Map(hoveredHex.contributors.map((c: any) => [c.clientId, c])).values()
                ).slice(0, 5).map((c: any) => (
                  <div key={c.locationId || c.clientId} className="flex justify-between gap-3">
                    <span className="flex items-center gap-1 truncate">
                      <span
                        className="w-2 h-2 rounded-full inline-block flex-shrink-0"
                        style={{ backgroundColor: getClientColor(c.clientId, uniqueClientIds) }}
                      />
                      {c.clientName}
                    </span>
                    <span className="font-medium text-foreground flex-shrink-0">
                      {Math.round(c.overlapFraction * 100)}%
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {hoveredHeat && tooltipPos && !hoveredHex && !hoveredPin && (
        <div
          className="absolute z-50 pointer-events-none bg-card/95 backdrop-blur-sm border border-border rounded-xl shadow-lg px-4 py-3 text-sm"
          style={{
            left: Math.min(Math.max(tooltipPos.x + 16, 10), (wrapperRef.current?.offsetWidth || 600) - 240),
            top: Math.max(tooltipPos.y - 10, 10),
            maxWidth: 220,
          }}
        >
          <div className="font-bold text-foreground mb-1 flex items-center gap-2">
            <span
              className="w-3 h-3 rounded-full inline-block"
              style={{ backgroundColor: getGradientColor(hoveredHeat.capacityUsedPercent) }}
            />
            Capacity Used
          </div>
          <div className="flex justify-between gap-4 text-xs text-muted-foreground">
            <span>{hoveredHeat.status}</span>
            <span className="font-bold text-sm" style={{ color: getGradientColor(hoveredHeat.capacityUsedPercent) }}>
              {hoveredHeat.capacityUsedPercent}%
            </span>
          </div>
          <div className="text-[10px] text-muted-foreground/60 mt-1">Zoom in for hex detail</div>
        </div>
      )}

      {hoveredPin && tooltipPos && !hoveredHex && (
        <div
          className="absolute z-50 pointer-events-none bg-card/95 backdrop-blur-sm border border-border rounded-xl shadow-lg px-4 py-3 text-sm"
          style={{
            left: Math.min(Math.max(tooltipPos.x + 16, 10), (wrapperRef.current?.offsetWidth || 600) - 270),
            top: Math.max(tooltipPos.y - 10, 10),
            maxWidth: 260,
          }}
        >
          <div className="font-bold text-foreground mb-1">{hoveredPin.clientName}</div>
          <div className="text-xs text-muted-foreground/80 mb-1">{hoveredPin.city}</div>
          <div className="text-xs text-muted-foreground">
            <div className="flex justify-between gap-4">
              <span>Coverage Radius (R2)</span>
              <span className="font-medium text-foreground">{hoveredPin.r2Radius} mi</span>
            </div>
            {hoveredPin.diagnostics && (
              <div className="mt-1.5 pt-1.5 border-t border-[#e8e0d8] space-y-0.5">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground/70">Competitors Analyzed</span>
                  <span className="font-medium text-foreground">{hoveredPin.diagnostics.competitorsAnalyzed}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground/70">R2 Base (Drop-off)</span>
                  <span className="font-medium text-foreground">{hoveredPin.diagnostics.r2Base} mi</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground/70">Density Factor</span>
                  <span className="font-medium text-foreground">{hoveredPin.diagnostics.densityFactor}x</span>
                </div>
                {hoveredPin.diagnostics.ruralExpansion && (
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground/70">Rural Expansion</span>
                    <span className="font-medium text-green-700">Active</span>
                  </div>
                )}
              </div>
            )}
            {hoveredPin.practiceAreas && hoveredPin.practiceAreas.length > 0 && (
              <div className="mt-1">
                <span className="text-[10px] text-muted-foreground/70">Practice Areas:</span>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {hoveredPin.practiceAreas.slice(0, 4).map((pa: string) => (
                    <span key={pa} className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-foreground">
                      {pa.replace(/_/g, " ")}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
