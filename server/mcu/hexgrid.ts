import * as h3 from "h3-js";
import { haversineDistance } from "./geocoding";
import { CapacityStatus, MarketAreaSummary } from "./types";
import { getCachedSummary } from "./worker";
import { db } from "../db";
import { clientLocations, clients } from "@shared/schema";
import { eq, and, isNull, or } from "drizzle-orm";

const H3_RESOLUTION = 7;
const MILES_TO_KM = 1.60934;
const H3_EDGE_LENGTH_KM = 1.221;

interface HexContributor {
  locationId: string;
  clientId: string;
  clientName: string;
  overlapFraction: number;
}

export interface HexCellResult {
  hexId: string;
  centerLat: number;
  centerLng: number;
  vertices: [number, number][];
  capacityUsedPercent: number;
  status: CapacityStatus;
  statusColor: "green" | "yellow" | "orange" | "red";
  effectiveClients: number;
  contributors: HexContributor[];
}

export interface HexLocationResult {
  locationId: string;
  clientId: string;
  clientName: string;
  lat: number;
  lng: number;
  r2Radius: number;
  practiceAreas: string[];
  city: string;
  radiusDiagnostics?: {
    competitorsAnalyzed: number;
    r2Base?: number;
    densityCore?: number;
    densityFactor?: number;
    isDense?: boolean;
    popDensity3mi?: number;
    rMarket?: number;
  };
}

export interface HexGridResponse {
  hexes: HexCellResult[];
  locations: HexLocationResult[];
  practiceArea: string;
  marketCapacityPercent: number;
}

function clampVal(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function computeOccupancyWeight(
  hexId: string,
  locationLat: number,
  locationLng: number,
  r2RadiusMiles: number
): number {
  const [centerLat, centerLng] = h3.cellToLatLng(hexId);
  const dMiles = haversineDistance(centerLat, centerLng, locationLat, locationLng);

  const W_EXT_BASE = 0.60;
  const DECAY_EXP = 2.0;
  const r1 = clampVal(0.35 * r2RadiusMiles, 1.5, 4.0);

  if (dMiles <= r1) return 1.0;
  if (dMiles >= r2RadiusMiles) return 0.0;

  const t = (dMiles - r1) / (r2RadiusMiles - r1);
  return W_EXT_BASE * Math.pow(1 - t, DECAY_EXP);
}

function getCapacityStatus(usedPercent: number): { status: CapacityStatus; color: "green" | "yellow" | "orange" | "red" } {
  if (usedPercent < 35) return { status: "Open", color: "green" };
  if (usedPercent < 60) return { status: "Filling", color: "yellow" };
  if (usedPercent < 80) return { status: "Tight", color: "orange" };
  return { status: "Saturated", color: "red" };
}

const STATE_BOUNDS: Record<string, { minLat: number; maxLat: number; minLng: number; maxLng: number }> = {
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

function isHexInStateBounds(hexId: string, state: string): boolean {
  const bounds = STATE_BOUNDS[state];
  if (!bounds) return true;
  const [lat, lng] = h3.cellToLatLng(hexId);
  const margin = 0.05;
  return (
    lat >= bounds.minLat - margin &&
    lat <= bounds.maxLat + margin &&
    lng >= bounds.minLng - margin &&
    lng <= bounds.maxLng + margin
  );
}

export async function computeHexGridForState(
  state: string,
  practiceArea?: string
): Promise<HexGridResponse | null> {
  const cached = getCachedSummary();
  if (!cached.data || cached.data.length === 0) return null;

  const stateAreas = cached.data.filter(a => a.state === state);
  if (stateAreas.length === 0) return null;

  const showAll = !practiceArea;
  const selectedPractice = practiceArea || null;

  const locations = await db
    .select({
      id: clientLocations.id,
      clientId: clientLocations.clientId,
      lat: clientLocations.lat,
      lng: clientLocations.lng,
      city: clientLocations.city,
      state: clientLocations.state,
      address: clientLocations.address,
      radiusExtended: clientLocations.radiusExtended,
      practiceAreas: clients.practiceAreas,
      firmName: clients.firmName,
    })
    .from(clientLocations)
    .innerJoin(clients, eq(clientLocations.clientId, clients.id))
    .where(
      and(
        eq(clientLocations.isActive, true),
        eq(clientLocations.state, state),
        or(eq(clients.isArchived, false), isNull(clients.isArchived))
      )
    );

  const relevantLocations = showAll
    ? locations.filter(loc => loc.lat && loc.lng)
    : locations.filter(loc => loc.lat && loc.lng && (loc.practiceAreas || []).includes(selectedPractice!));

  const displayLabel = showAll ? "All Practice Areas" : selectedPractice!;

  console.log(`[HexGrid] state=${state} practice=${displayLabel} totalLocs=${locations.length} relevantLocs=${relevantLocations.length}`);

  if (relevantLocations.length === 0) {
    return { hexes: [], locations: [], practiceArea: displayLabel, marketCapacityPercent: 0 };
  }

  let marketCapacityPercent = 0;
  let totalWeight = 0;
  if (showAll) {
    for (const area of stateAreas) {
      for (const ps of area.practices) {
        marketCapacityPercent += ps.capacityUsedPercent * area.locationCount;
        totalWeight += area.locationCount;
      }
    }
  } else {
    for (const area of stateAreas) {
      const ps = area.practices.find(p => p.practiceArea === selectedPractice);
      if (ps) {
        marketCapacityPercent += ps.capacityUsedPercent * area.locationCount;
        totalWeight += area.locationCount;
      }
    }
  }
  if (totalWeight > 0) {
    marketCapacityPercent = marketCapacityPercent / totalWeight;
  }

  const hexMap = new Map<string, {
    contributors: HexContributor[];
    totalInfluence: number;
  }>();

  const locationResults: HexLocationResult[] = [];

  for (const loc of relevantLocations) {
    const r2 = loc.radiusExtended || 8;
    const r2Km = r2 * MILES_TO_KM;
    const ringSize = Math.min(Math.ceil(r2Km / H3_EDGE_LENGTH_KM) + 1, 70);
    const centerCell = h3.latLngToCell(loc.lat!, loc.lng!, H3_RESOLUTION);
    const cells = h3.gridDisk(centerCell, ringSize);

    for (const cell of cells) {
      if (!isHexInStateBounds(cell, state)) continue;

      const overlapFraction = computeOccupancyWeight(
        cell,
        loc.lat!,
        loc.lng!,
        r2
      );

      if (overlapFraction <= 0) continue;

      if (!hexMap.has(cell)) {
        hexMap.set(cell, { contributors: [], totalInfluence: 0 });
      }

      const hex = hexMap.get(cell)!;
      hex.contributors.push({
        locationId: loc.id,
        clientId: loc.clientId,
        clientName: loc.firmName,
        overlapFraction,
      });
      hex.totalInfluence += overlapFraction;
    }

    const areaMatch = stateAreas.find(a => a.locations.some(l => l.locationId === loc.id));
    const areaDiag = areaMatch?.radiusDiagnostics;

    locationResults.push({
      locationId: loc.id,
      clientId: loc.clientId,
      clientName: loc.firmName,
      lat: loc.lat!,
      lng: loc.lng!,
      r2Radius: r2,
      practiceAreas: loc.practiceAreas || [],
      city: loc.city || "",
      radiusDiagnostics: areaDiag ? {
        competitorsAnalyzed: areaDiag.competitorsAnalyzed,
        r2Base: areaDiag.r2Base ? Math.round(areaDiag.r2Base * 10) / 10 : undefined,
        densityCore: areaDiag.densityCore,
        densityFactor: areaDiag.popFactor ? Math.round(areaDiag.popFactor * 100) / 100 : undefined,
        isDense: areaDiag.isDense,
        popDensity3mi: areaDiag.popDensity3mi,
        rMarket: areaDiag.rMarket,
      } : undefined,
    });
  }

  let totalInfluence = 0;
  let hexCount = 0;
  hexMap.forEach(data => {
    totalInfluence += data.totalInfluence;
    hexCount++;
  });
  const avgInfluence = hexCount > 0 ? totalInfluence / hexCount : 1;

  console.log(`[HexGrid] hexMap size=${hexMap.size} marketCapacity=${marketCapacityPercent.toFixed(1)}%`);

  const hexes: HexCellResult[] = [];
  hexMap.forEach((data, hexId) => {
    const [centerLat, centerLng] = h3.cellToLatLng(hexId);
    const vertices = h3.cellToBoundary(hexId) as [number, number][];

    const clientInfluence = new Map<string, number>();
    for (const c of data.contributors) {
      const existing = clientInfluence.get(c.clientId) || 0;
      clientInfluence.set(c.clientId, Math.max(existing, c.overlapFraction));
    }
    const effectiveClients = Array.from(clientInfluence.values()).reduce((a, b) => a + b, 0);

    const relativeInfluence = avgInfluence > 0 ? data.totalInfluence / avgInfluence : 1;
    const hexCapacity = Math.min(95, marketCapacityPercent * Math.min(relativeInfluence, 2.0));
    const cappedCapacity = Math.max(0, Math.round(hexCapacity));

    const { status, color } = getCapacityStatus(cappedCapacity);

    hexes.push({
      hexId,
      centerLat,
      centerLng,
      vertices,
      capacityUsedPercent: cappedCapacity,
      status,
      statusColor: color,
      effectiveClients: Math.round(effectiveClients * 100) / 100,
      contributors: data.contributors,
    });
  });

  return {
    hexes,
    locations: locationResults,
    practiceArea: displayLabel,
    marketCapacityPercent: Math.round(marketCapacityPercent),
  };
}

function findDominantPractice(areas: MarketAreaSummary[]): string | null {
  const practiceCount = new Map<string, number>();
  for (const area of areas) {
    for (const p of area.practices) {
      practiceCount.set(p.practiceArea, (practiceCount.get(p.practiceArea) || 0) + 1);
    }
  }
  let maxPractice: string | null = null;
  let maxCount = 0;
  practiceCount.forEach((count, practice) => {
    if (count > maxCount) {
      maxCount = count;
      maxPractice = practice;
    }
  });
  return maxPractice;
}
