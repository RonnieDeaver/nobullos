import { CompetitorDensity, RadiusResult, GeoLocation } from "./types";
import { ProbeSearchResult } from "./probeSearch";
import { getPopulationWithinRadius } from "./h3pop";

const D_CANDIDATES = [0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50];

const R_MARKET_LADDER = [5, 8, 10, 12, 15, 18, 20, 25, 30, 35, 40, 50, 60, 70, 80];
const MARKET_POP_TARGET = 2_000_000;
const R_MARKET_MIN = 15;
const R_MARKET_MAX = 80;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface DensityDropoffDiagnostics {
  competitorsAnalyzed: number;
  r2Base: number;
  densityCurve: Array<{ radius: number; count: number; density: number }>;
  densityCore: number;
  popDensity3mi: number;
  popFactor: number;
  isDense: boolean;
  competitorsWithin20mi: number;
  rMarket: number;
}

export interface DensityRadiusResult extends RadiusResult {
  diagnostics: DensityDropoffDiagnostics;
  competitorsInR2: number;
  rMarket: number;
}

export async function calculateDensityDropoffRadius(
  probeResult: ProbeSearchResult,
  location: GeoLocation
): Promise<DensityRadiusResult> {
  const distances = probeResult.competitors.map((c) => c.distanceMiles);

  const densityCurve: Array<{ radius: number; count: number; density: number }> = [];
  for (const r of D_CANDIDATES) {
    const count = distances.filter((d) => d <= r).length;
    const area = Math.PI * r * r;
    const density = area > 0 ? count / area : 0;
    densityCurve.push({ radius: r, count, density });
  }

  const n1 = distances.filter((d) => d <= 1).length;
  const densityCore = n1 / (Math.PI * 1 * 1);
  const isDense = densityCore >= 8.0;

  let r2Base: number;

  if (isDense) {
    r2Base = 12.0 / Math.pow(densityCore, 0.35);
  } else {
    let d25 = 20;
    for (const d of D_CANDIDATES) {
      const count = distances.filter((dist) => dist <= d).length;
      if (count >= 25) {
        d25 = d;
        break;
      }
    }
    r2Base = 2.5 * d25;
  }

  const pop3 = await getPopulationWithinRadius(location.lat, location.lng, 3);
  const popDensity3mi = pop3 / (Math.PI * 3 * 3);
  const popFactor = clamp(Math.pow(2500.0 / Math.max(popDensity3mi, 1), 0.22), 0.5, 2.0);
  const r2Raw = r2Base * popFactor;
  const R2 = clamp(r2Raw, 3.0, 50.0);

  const R1 = clamp(0.35 * R2, 1.5, 4.0);

  const competitorsInR2 = distances.filter((d) => d <= R2).length;
  const competitorsWithin20 = distances.filter((d) => d <= 20).length;

  const rMarket = await calculateRMarket(location, R2);

  console.log(`[Radius] ${isDense ? 'DENSE' : 'SPARSE'}: densityCore=${densityCore.toFixed(1)}, R2_base=${r2Base.toFixed(1)}mi, popFactor=${popFactor.toFixed(3)}, R2=${R2.toFixed(1)}mi, R1=${R1.toFixed(1)}mi, compInR2=${competitorsInR2}, R_market=${rMarket.toFixed(0)}mi`);

  return {
    core: R1,
    extended: R2,
    fringe: R2,
    competitorCounts: [],
    competitorsInR2,
    rMarket,
    diagnostics: {
      competitorsAnalyzed: probeResult.totalFound,
      r2Base,
      densityCurve,
      densityCore,
      popDensity3mi,
      popFactor,
      isDense,
      competitorsWithin20mi: competitorsWithin20,
      rMarket,
    },
  };
}

async function calculateRMarket(location: GeoLocation, R2: number): Promise<number> {
  let rPop = R_MARKET_MAX;
  for (const r of R_MARKET_LADDER) {
    const pop = await getPopulationWithinRadius(location.lat, location.lng, r);
    if (pop >= MARKET_POP_TARGET) {
      rPop = r;
      break;
    }
  }

  const rMarket = clamp(Math.max(rPop, 3.0 * R2), R_MARKET_MIN, R_MARKET_MAX);
  return rMarket;
}

export { clamp, calculateRMarket };
