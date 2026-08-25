import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { STATE_PATHS } from "./UsStateMap";
import {
  CAPACITY_STATUS_COLORS,
  CAPACITY_STATUS_GLOW_COLORS,
  CAPACITY_STATUS_LEGEND,
} from "@/lib/capacityStatusColors";

interface MarketAreaDot {
  marketAreaId: string;
  marketAreaName: string;
  centerLat: number;
  centerLng: number;
  locationCount: number;
  clientCount: number;
  capacityUsedPercent: number;
  status: string;
  statusColor: "green" | "yellow" | "orange" | "red";
  totalPopulation: number;
  totalMcu: number;
  totalAllocated: number;
  r2Radius?: number;
}

interface StateZoomMapProps {
  marketAreas: MarketAreaDot[];
  stateName: string;
  stateAbbr: string;
  onMarketAreaClick: (marketAreaId: string) => void;
}

// Dot fills, gradients, glows and the inline legend all derive from the
// shared capacity palette module (lib/capacityStatusColors.ts, Task #4704)
// so this zoomed view can never drift from UsStateMap's token ramp again.
// Tokens are the only way these inline SVG paints can follow dark mode —
// the Tailwind `.dark` compat remap can't reach inline fills.

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

function parseSvgPathBBox(pathData: string): { x: number; y: number; w: number; h: number } | null {
  const nums: number[] = [];
  const re = /[-+]?(?:\d+\.?\d*|\.\d+)/g;
  let m;
  while ((m = re.exec(pathData)) !== null) {
    nums.push(parseFloat(m[0]));
  }
  if (nums.length < 2) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let cx = 0, cy = 0;
  const commands = pathData.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)/g);
  if (!commands) return null;

  let i = 0;
  let cmd = "";
  let startX = 0, startY = 0;

  const update = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  while (i < commands.length) {
    const token = commands[i];
    if (/[A-Za-z]/.test(token)) {
      cmd = token;
      i++;
    }

    const num = () => parseFloat(commands[i++]);

    switch (cmd) {
      case "M": cx = num(); cy = num(); startX = cx; startY = cy; update(cx, cy); cmd = "L"; break;
      case "m": cx += num(); cy += num(); startX = cx; startY = cy; update(cx, cy); cmd = "l"; break;
      case "L": cx = num(); cy = num(); update(cx, cy); break;
      case "l": cx += num(); cy += num(); update(cx, cy); break;
      case "H": cx = num(); update(cx, cy); break;
      case "h": cx += num(); update(cx, cy); break;
      case "V": cy = num(); update(cx, cy); break;
      case "v": cy += num(); update(cx, cy); break;
      case "C": { const x1 = num(), y1 = num(), x2 = num(), y2 = num(); cx = num(); cy = num(); update(x1, y1); update(x2, y2); update(cx, cy); break; }
      case "c": { const x1 = cx + num(), y1 = cy + num(), x2 = cx + num(), y2 = cy + num(); cx += num(); cy += num(); update(x1, y1); update(x2, y2); update(cx, cy); break; }
      case "S": { num(); num(); cx = num(); cy = num(); update(cx, cy); break; }
      case "s": { num(); num(); cx += num(); cy += num(); update(cx, cy); break; }
      case "Q": { num(); num(); cx = num(); cy = num(); update(cx, cy); break; }
      case "q": { num(); num(); cx += num(); cy += num(); update(cx, cy); break; }
      case "T": cx = num(); cy = num(); update(cx, cy); break;
      case "t": cx += num(); cy += num(); update(cx, cy); break;
      case "A": { num(); num(); num(); num(); num(); cx = num(); cy = num(); update(cx, cy); break; }
      case "a": { num(); num(); num(); num(); num(); cx += num(); cy += num(); update(cx, cy); break; }
      case "Z": case "z": cx = startX; cy = startY; break;
      default: i++; break;
    }
  }

  if (minX === Infinity) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function StateZoomMap({ marketAreas, stateName, stateAbbr, onMarketAreaClick }: StateZoomMapProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const SVG_WIDTH = 700;
  const SVG_HEIGHT = 460;
  const PADDING = 50;

  const statePath = STATE_PATHS[stateAbbr] || "";
  const geoBounds = STATE_GEO_BOUNDS[stateAbbr];
  const pathBBox = useMemo(() => parseSvgPathBBox(statePath), [statePath]);

  const { stateTransform, projectedDots } = useMemo(() => {
    const drawW = SVG_WIDTH - 2 * PADDING;
    const drawH = SVG_HEIGHT - 2 * PADDING;

    let transform = "";
    if (pathBBox) {
      const scaleX = drawW / pathBBox.w;
      const scaleY = drawH / pathBBox.h;
      const scale = Math.min(scaleX, scaleY) * 0.92;
      const scaledW = pathBBox.w * scale;
      const scaledH = pathBBox.h * scale;
      const tx = PADDING + (drawW - scaledW) / 2 - pathBBox.x * scale;
      const ty = PADDING + (drawH - scaledH) / 2 - pathBBox.y * scale;
      transform = `translate(${tx}, ${ty}) scale(${scale})`;
    }

    if (marketAreas.length === 0 || !geoBounds || !pathBBox) {
      return { stateTransform: transform, projectedDots: [] };
    }

    const scaleX = drawW / pathBBox.w;
    const scaleY = drawH / pathBBox.h;
    const scale = Math.min(scaleX, scaleY) * 0.92;
    const scaledW = pathBBox.w * scale;
    const scaledH = pathBBox.h * scale;
    const offsetX = PADDING + (drawW - scaledW) / 2;
    const offsetY = PADDING + (drawH - scaledH) / 2;

    const geoLatRange = geoBounds.maxLat - geoBounds.minLat;
    const geoLngRange = geoBounds.maxLng - geoBounds.minLng;

    const maxPop = Math.max(...marketAreas.map(m => m.totalPopulation), 1);

    const dots = marketAreas.map(m => {
      const normX = (m.centerLng - geoBounds.minLng) / geoLngRange;
      const normY = 1 - (m.centerLat - geoBounds.minLat) / geoLatRange;

      const x = offsetX + normX * scaledW;
      const y = offsetY + normY * scaledH;

      const popScale = Math.sqrt(m.totalPopulation / maxPop);
      const baseR = marketAreas.length <= 3 ? 14 : marketAreas.length <= 8 ? 12 : 10;
      const r = baseR + popScale * 6;

      return { ...m, x, y, r, labelOffsetX: 0, labelOffsetY: 0 };
    });

    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        const dx = dots[j].x - dots[i].x;
        const dy = dots[j].y - dots[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDotSep = dots[i].r + dots[j].r + 8;
        if (dist < minDotSep && dist > 0) {
          const overlap = (minDotSep - dist) / 2 + 2;
          const angle = Math.atan2(dy, dx);
          dots[i].x -= Math.cos(angle) * overlap;
          dots[i].y -= Math.sin(angle) * overlap;
          dots[j].x += Math.cos(angle) * overlap;
          dots[j].y += Math.sin(angle) * overlap;
        }
        const newDx = dots[j].x - dots[i].x;
        const newDist = Math.abs(newDx);
        if (newDist < 80) {
          const leftDot = dots[i].x <= dots[j].x ? dots[i] : dots[j];
          const rightDot = dots[i].x <= dots[j].x ? dots[j] : dots[i];
          leftDot.labelOffsetX = -(leftDot.r + 30);
          rightDot.labelOffsetX = rightDot.r + 30;
        }
      }
    }

    return { stateTransform: transform, projectedDots: dots };
  }, [marketAreas, geoBounds, pathBBox]);

  const hoveredDot = useMemo(() => {
    if (!hoveredId) return null;
    return projectedDots.find(d => d.marketAreaId === hoveredId) || null;
  }, [hoveredId, projectedDots]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, []);

  if (marketAreas.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm" data-testid="state-zoom-empty">
        No market zones found in {stateName}
      </div>
    );
  }

  const usedColors = new Set<string>(projectedDots.map(d => d.statusColor));

  return (
    <div className="relative" ref={containerRef} data-testid={`state-zoom-map-${stateAbbr}`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">
          {stateName} — Market Zones
        </h3>
        <div className="flex items-center gap-3 text-xs flex-wrap">
          {CAPACITY_STATUS_LEGEND.filter(item => usedColors.has(item.colorKey)).map(item => (
            <div key={item.colorKey} className="flex items-center gap-1">
              <span
                className="w-3 h-3 rounded-full inline-block border border-border"
                style={{ backgroundColor: CAPACITY_STATUS_COLORS[item.colorKey] }}
              />
              <span className="text-muted-foreground">{item.key}</span>
            </div>
          ))}
          <div className="flex items-center gap-1 text-muted-foreground/70">
            <span className="w-2 h-2 rounded-full bg-muted-foreground/60 inline-block" />
            <span>Size = Population</span>
          </div>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        className="w-full h-auto rounded-[var(--radius-xl)] overflow-hidden"
        onMouseMove={handleMouseMove}
        style={{ minHeight: 280, background: "linear-gradient(135deg, hsl(var(--muted) / 0.5) 0%, hsl(var(--muted)) 100%)" }}
      >
        <defs>
          {/* Same-token vignette: the rim stop drops opacity instead of using
              a hardcoded darker hex, so the depth cue blends toward the
              backdrop correctly in BOTH themes. */}
          {CAPACITY_STATUS_LEGEND.map(({ colorKey }) => (
            <radialGradient key={`grad-${colorKey}`} id={`dot-grad-${colorKey}`}>
              <stop offset="0%" stopColor={CAPACITY_STATUS_COLORS[colorKey]} stopOpacity="1" />
              <stop offset="100%" stopColor={CAPACITY_STATUS_COLORS[colorKey]} stopOpacity="0.82" />
            </radialGradient>
          ))}
          <filter id="dot-shadow" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="rgba(0,0,0,0.15)" />
          </filter>
          <filter id="state-shadow" x="-5%" y="-5%" width="110%" height="110%">
            <feDropShadow dx="0" dy="1" stdDeviation="2" floodColor="hsl(var(--primary) / 0.08)" />
          </filter>
        </defs>

        {statePath && stateTransform && (
          <g transform={stateTransform}>
            <path
              d={statePath}
              fill="hsl(var(--muted))"
              stroke="hsl(var(--border))"
              strokeWidth="1.2"
              opacity="0.7"
              filter="url(#state-shadow)"
            />
            <path
              d={statePath}
              fill="none"
              stroke="hsl(var(--border))"
              strokeWidth="0.5"
              strokeDasharray="4 3"
              opacity="0.4"
            />
          </g>
        )}

        {projectedDots.map(dot => {
          const isHovered = hoveredId === dot.marketAreaId;

          return (
            <g
              key={dot.marketAreaId}
              className="cursor-pointer"
              onMouseEnter={() => setHoveredId(dot.marketAreaId)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={() => onMarketAreaClick(dot.marketAreaId)}
              data-testid={`dot-${dot.marketAreaId}`}
            >
              <circle
                cx={dot.x}
                cy={dot.y}
                r={(isHovered ? dot.r + 3 : dot.r) + 6}
                fill={CAPACITY_STATUS_GLOW_COLORS[dot.statusColor]}
                opacity={isHovered ? 0.45 : 0.25}
                className="transition-all duration-200"
              />

              <circle
                cx={dot.x}
                cy={dot.y}
                r={isHovered ? dot.r + 2 : dot.r}
                fill={`url(#dot-grad-${dot.statusColor})`}
                stroke="hsl(var(--card))"
                strokeWidth={2}
                filter="url(#dot-shadow)"
                opacity={isHovered ? 1 : 0.92}
                className="transition-all duration-200"
              />

              {/* Inverse ink: --background is light paper on the dark
                  light-mode status inks and near-black on the bright
                  dark-mode fills, so the % stays readable in both themes. */}
              <text
                x={dot.x}
                y={dot.y}
                textAnchor="middle"
                dominantBaseline="central"
                fill="hsl(var(--background))"
                fontSize={10}
                fontWeight="bold"
                pointerEvents="none"
                className="select-none"
                style={{ textShadow: "0 1px 2px rgba(0,0,0,0.3)" }}
              >
                {dot.capacityUsedPercent}%
              </text>

              {dot.labelOffsetX !== 0 && (
                <line
                  x1={dot.x}
                  y1={dot.y + dot.r + 2}
                  x2={dot.x + dot.labelOffsetX * 0.6}
                  y2={dot.y + dot.r + 10}
                  stroke="hsl(var(--muted-foreground))"
                  strokeWidth="0.8"
                  opacity="0.6"
                />
              )}
              <text
                x={dot.x + dot.labelOffsetX}
                y={dot.y + dot.r + 14}
                textAnchor={dot.labelOffsetX < 0 ? "end" : dot.labelOffsetX > 0 ? "start" : "middle"}
                fill="hsl(var(--foreground))"
                fontSize="10"
                fontWeight="700"
                pointerEvents="none"
                className="select-none"
              >
                {dot.marketAreaName.length > 22 ? dot.marketAreaName.slice(0, 20) + "…" : dot.marketAreaName}
              </text>
              <text
                x={dot.x + dot.labelOffsetX}
                y={dot.y + dot.r + 25}
                textAnchor={dot.labelOffsetX < 0 ? "end" : dot.labelOffsetX > 0 ? "start" : "middle"}
                fill="hsl(var(--muted-foreground))"
                fontSize="10"
                pointerEvents="none"
                className="select-none"
              >
                {dot.locationCount} loc · {dot.clientCount} client{dot.clientCount !== 1 ? "s" : ""} · Pop {(dot.totalPopulation / 1000).toFixed(0)}k
              </text>
            </g>
          );
        })}
      </svg>

      {hoveredDot && tooltipPos && (
        <div
          className="absolute z-50 pointer-events-none bg-popover/95 backdrop-blur-sm border border-border rounded-[var(--radius-xl)] shadow-xl px-4 py-3 text-sm"
          style={{
            left: Math.min(Math.max(tooltipPos.x + 16, 10), (containerRef.current?.offsetWidth || 600) - 250),
            top: Math.max(tooltipPos.y - 10, 10),
            maxWidth: 260,
          }}
        >
          <div className="font-bold text-popover-foreground mb-1.5">{hoveredDot.marketAreaName}</div>
          <div className="space-y-1 text-xs text-muted-foreground">
            <div className="flex justify-between gap-4">
              <span>Capacity Used</span>
              <span className="font-bold text-sm" style={{ color: CAPACITY_STATUS_COLORS[hoveredDot.statusColor] }}>
                {hoveredDot.capacityUsedPercent}%
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span>Status</span>
              <span className="font-semibold text-popover-foreground">{hoveredDot.status}</span>
            </div>
            <div className="h-px bg-border my-1" />
            <div className="flex justify-between gap-4">
              <span>Population</span>
              <span className="font-medium text-popover-foreground">{hoveredDot.totalPopulation.toLocaleString()}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span>Locations</span>
              <span className="font-medium text-popover-foreground">{hoveredDot.locationCount}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span>Clients</span>
              <span className="font-medium text-popover-foreground">{hoveredDot.clientCount}</span>
            </div>
            {hoveredDot.r2Radius && (
              <div className="flex justify-between gap-4">
                <span>R2 Radius</span>
                <span className="font-medium text-popover-foreground">{hoveredDot.r2Radius} mi</span>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <span>Safe Slots</span>
              <span className="font-medium text-popover-foreground">{Math.round(hoveredDot.totalMcu)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span>Allocated</span>
              <span className="font-medium text-popover-foreground">{Math.round(hoveredDot.totalAllocated)}</span>
            </div>
          </div>
          <div className="mt-2 text-caption text-muted-foreground/70 text-center border-t border-border pt-1.5">Click to view details</div>
        </div>
      )}
    </div>
  );
}

export type { MarketAreaDot };
