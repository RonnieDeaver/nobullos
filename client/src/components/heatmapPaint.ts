import type maplibregl from "maplibre-gl";
import { HEATMAP_UNRANKED_FILL_COLOR } from "@shared/heatmapColors";

export type HeatmapPaintExpression = unknown[];

// Re-exported from the shared single source of truth (Task #2587). It doubles
// as the TERMINAL literal fallback in the fill-color coalesce: if a cell carries
// neither a rankColor nor a color (an old/partial cached shape, or a snapshot
// genuinely lacking position data), the coalesce would otherwise resolve to null
// and MapLibre would paint the cell its default BLACK — the silent "broken
// heatmap" look. Falling back to this explicit slate guarantees a cell is never
// invisible/black; worst case it renders the intentional unranked color.
export { HEATMAP_UNRANKED_FILL_COLOR };

export const HEATMAP_FILL_COLOR_EXPR: HeatmapPaintExpression = [
  "coalesce",
  ["get", "rankColor"],
  ["get", "color"],
  HEATMAP_UNRANKED_FILL_COLOR,
];

export const HEATMAP_FILL_OPACITY_EXPR: HeatmapPaintExpression = [
  "case",
  ["==", ["get", "isEdge"], 1], 0.55,
  0.8,
];

export const HEATMAP_OUTLINE_LINE_COLOR_EXPR: HeatmapPaintExpression = [
  "case",
  ["==", ["get", "isEdge"], 1], "rgba(255,255,255,0.25)",
  "rgba(255,255,255,0.45)",
];

export const HEATMAP_LABELS_TEXT_OPACITY_EXPR: HeatmapPaintExpression = [
  "case",
  ["==", ["get", "isEdge"], 1], 0.6,
  0.85,
];

export function buildHeatmapFillColorExpr(): HeatmapPaintExpression {
  return ["coalesce", ["get", "rankColor"], ["get", "color"], HEATMAP_UNRANKED_FILL_COLOR];
}

export function buildHeatmapFillOpacityExpr(opacity: number): HeatmapPaintExpression {
  return [
    "case",
    ["==", ["get", "isEdge"], 1], 0.55 * opacity,
    0.8 * opacity,
  ];
}

export function buildHeatmapOutlineLineColorExpr(opacity: number): HeatmapPaintExpression {
  return [
    "case",
    ["==", ["get", "isEdge"], 1], `rgba(255,255,255,${(0.3 * opacity).toFixed(2)})`,
    `rgba(255,255,255,${(0.5 * opacity).toFixed(2)})`,
  ];
}

export function buildHeatmapLabelsTextOpacityExpr(opacity: number): HeatmapPaintExpression {
  return [
    "case",
    ["==", ["get", "isEdge"], 1], 0.7 * opacity,
    0.9 * opacity,
  ];
}

export function applyHeatmapPaint(map: maplibregl.Map, isTransparent: boolean): void {
  const opacity = isTransparent ? 0.3 : 1.0;

  if (map.getLayer("heatmap-fill")) {
    const fillColorExpr = buildHeatmapFillColorExpr();
    const fillOpacityExpr = buildHeatmapFillOpacityExpr(opacity);
    map.setPaintProperty("heatmap-fill", "fill-color", fillColorExpr as any);
    map.setPaintProperty("heatmap-fill", "fill-opacity", fillOpacityExpr as any);

    const appliedFillColor = map.getPaintProperty("heatmap-fill", "fill-color");
    if (typeof appliedFillColor === "string") {
      console.warn(
        `[InteractiveHeatmap] heatmap-fill fill-color resolved to constant "${appliedFillColor}" — expected data-driven expression. Cells will not be color-coded.`
      );
    }
    const nonEdgeOpacity = 0.8 * opacity;
    if (!isTransparent && nonEdgeOpacity <= 0) {
      console.warn(
        `[InteractiveHeatmap] heatmap-fill non-edge opacity dropped to ${nonEdgeOpacity} while X-Ray is off — fills will be invisible.`
      );
    }
  }

  if (map.getLayer("heatmap-outline")) {
    map.setPaintProperty(
      "heatmap-outline",
      "line-color",
      buildHeatmapOutlineLineColorExpr(opacity) as any,
    );
  }

  if (map.getLayer("heatmap-labels")) {
    map.setPaintProperty(
      "heatmap-labels",
      "text-opacity",
      buildHeatmapLabelsTextOpacityExpr(opacity) as any,
    );
  }
}
