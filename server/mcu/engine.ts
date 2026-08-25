import { db, dbRetry } from "../db";
import { clients, clientLocations, censusTracts } from "@shared/schema";
import { eq, and, isNull, isNotNull, or, inArray } from "drizzle-orm";
import { geocodeAddress, haversineDistance } from "./geocoding";
import { getFipsForLocation } from "./fips";
import { getCensusData, calculateDemandScore } from "./census";
import { getCompetitorDensity } from "./places";
import { DensityRadiusResult, calculateRMarket } from "./radius";
import { getPopulationInCells, getPopulationWithinRadius } from "./h3pop";
import { runGbpRangeLite, ALGO_VERSION } from "./probeSearch";
import {
  generateLocationFootprint,
  calculateOverlap,
  calculateTotalOverlap,
  LocationFootprint,
} from "./overlap";
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

import {
  EvaluationRequest,
  McuResult,
  SalesEvaluationResponse,
  InternalEvaluationResponse,
  InternalEvaluationResult,
  MarketSummary,
  MarketAreaSummary,
  CapacityBand,
  OverlapRisk,
  OverlapResult,
  GeoLocation,
  RadiusResult,
  CapacityStatus,
  FipsResult,
} from "./types";
import { clusterLocationsIntoMarketAreas, MarketAreaCluster } from "./clustering";
import { getCached, setCache } from "./cache";
import { getCachedSummary } from "./worker";
import * as h3 from "h3-js";
import { createHash } from "crypto";

// MCU_SIZE: scaling factor to convert effective demand to MCU units (per spec)
const MCU_SIZE = 100000.0;

// Headroom multiplier constants per spec
const P_REF = 500000;
const ALPHA = 0.4;
const HEADROOM_MIN = 1.0;
const HEADROOM_MAX = 6.0;

function calculateHeadroomMultiplier(marketPopulation: number): number {
  if (marketPopulation <= 0) return 1.0;
  const raw = Math.pow(marketPopulation / P_REF, ALPHA);
  return Math.max(HEADROOM_MIN, Math.min(HEADROOM_MAX, raw));
}

const POP_PER_SLOT: Record<string, number> = {
  "Personal Injury": 250000,
  "Immigration": 175000,
  "Family Law": 200000,
  "Criminal Defense": 200000,
  "DUI/DWI": 225000,
  "Estate Planning": 275000,
  "Business Law": 300000,
  "Employment Law": 300000,
  "Bankruptcy": 250000,
  "Real Estate": 300000,
  "Medical Malpractice": 350000,
};

function getPopPerSlot(practiceArea: string): number {
  return POP_PER_SLOT[practiceArea] || 225000;
}

function getCapacityBand(mcuRemaining: number): CapacityBand {
  if (mcuRemaining >= 25) return "High";
  if (mcuRemaining >= 10) return "Moderate";
  if (mcuRemaining >= 3) return "Tight";
  return "Limited";
}

function mapOverlapRisk(risk: "low" | "medium" | "high"): OverlapRisk {
  if (risk === "low") return "Low";
  if (risk === "medium") return "Moderate";
  return "High";
}

function generateNarrative(capacityBand: CapacityBand, overlapRisk: OverlapRisk, practiceArea: string): string {
  const capacityDescriptions: Record<CapacityBand, string> = {
    High: "This market has significant room for growth",
    Moderate: "This market has good capacity available",
    Tight: "This market is becoming competitive",
    Limited: "This market has very limited remaining capacity",
  };

  const overlapContext: Record<OverlapRisk, string> = {
    Low: "with minimal overlap from existing clients",
    Moderate: "though there is some overlap with existing client territories",
    High: "and there is significant overlap with existing client territories",
  };

  return `${capacityDescriptions[capacityBand]} for ${practiceArea}, ${overlapContext[overlapRisk]}.`;
}

function generateSalesNarrative(status: CapacityStatus, practiceArea: string): string {
  const statusNarratives: Record<CapacityStatus, string> = {
    Open: `Plenty of room in this area for ${practiceArea}.`,
    Filling: `Good opportunity available for ${practiceArea}.`,
    Tight: `Limited space remaining for ${practiceArea}.`,
    Saturated: `Market is at capacity for ${practiceArea}.`,
  };
  return statusNarratives[status];
}

export async function evaluateForSales(request: EvaluationRequest): Promise<SalesEvaluationResponse> {
  const { addresses, practiceArea } = request;
  const cached = getCachedSummary();
  const marketAreas = cached.data || [];

  const results = await Promise.all(addresses.map(async (address) => {
    const geocode = await geocodeAddress(address);
    if (!geocode.success) {
      return {
        address,
        capacityUsedPercent: 0,
        status: "Open" as CapacityStatus,
        statusColor: "green" as const,
        narrative: `Could not locate address. Assuming open market for ${practiceArea}.`,
        verdict: "approved" as const,
      };
    }

    let bestArea: MarketAreaSummary | null = null;
    let bestDistance = Infinity;
    for (const area of marketAreas) {
      const dist = haversineDistance(geocode.lat, geocode.lng, area.centerLat, area.centerLng);
      const marketRadius = area.rMarketRadius || 20;
      if (dist <= marketRadius && dist < bestDistance) {
        bestDistance = dist;
        bestArea = area;
      }
    }

    if (!bestArea) {
      return {
        address,
        capacityUsedPercent: 0,
        status: "Open" as CapacityStatus,
        statusColor: "green" as const,
        narrative: `No existing clients in this market for ${practiceArea}. Wide open.`,
        verdict: "approved" as const,
      };
    }

    const practiceSummary = bestArea.practices.find(p => p.practiceArea === practiceArea);
    if (!practiceSummary) {
      return {
        address,
        capacityUsedPercent: 0,
        status: "Open" as CapacityStatus,
        statusColor: "green" as const,
        narrative: `No existing ${practiceArea} clients in the ${bestArea.marketAreaName} market.`,
        verdict: "approved" as const,
      };
    }

    const { capacityUsedPercent, status, statusColor, overlapRisk } = practiceSummary;
    const narrative = generateSalesNarrative(status, practiceArea);

    let verdict: "approved" | "conditional" | "decline" = "approved";
    if (status === "Saturated" || overlapRisk === "High") {
      verdict = "decline";
    } else if (status === "Tight" || overlapRisk === "Moderate") {
      verdict = "conditional";
    }

    return {
      address,
      capacityUsedPercent,
      status,
      statusColor,
      narrative,
      verdict,
    };
  }));

  return { results };
}

function buildSimulationNarrative(
  practiceArea: string,
  marketAreaName: string | null,
  existingClientCount: number,
  currentPct: number,
  projectedPct: number,
  projectedStatus: CapacityStatus,
  deltaPct: number,
  prospectR2: number,
): string {
  const market = marketAreaName || "this area";
  const clientWord = existingClientCount === 1 ? "client" : "clients";

  const currentLine = existingClientCount === 0
    ? `No existing ${practiceArea} clients in ${market}.`
    : `${market} currently has ${existingClientCount} ${practiceArea} ${clientWord} using ${Math.round(currentPct)}% of market capacity.`;

  const impactLine = `Adding a new client here (R2 ≈ ${prospectR2.toFixed(1)} mi) would push capacity to ${Math.round(projectedPct)}% (+${Math.round(deltaPct)} pts).`;

  let verdictLine: string;
  if (projectedStatus === "Open") {
    verdictLine = "Market stays wide open — safe to onboard.";
  } else if (projectedStatus === "Filling") {
    verdictLine = "Market would still have good room after adding this client.";
  } else if (projectedStatus === "Tight") {
    verdictLine = "Market would become tight — proceed with caution, future capacity is limited.";
  } else {
    verdictLine = "Market would be at or beyond capacity — not recommended to add another client.";
  }

  return `${currentLine} ${impactLine} ${verdictLine}`;
}

export async function evaluateForInternal(
  request: EvaluationRequest
): Promise<InternalEvaluationResponse> {
  const { addresses, practiceArea } = request;
  const cached = getCachedSummary();
  const marketAreas = cached.data || [];

  const PACK_SLOTS = 3.0;
  const W_EXT_BASE = 0.60;
  const DECAY_EXP = 2.0;
  const H3_RES = 8;
  const H3_EDGE_KM = 0.461;

  function occupancyWeight(dMiles: number, r2Miles: number): number {
    const r1 = clamp(0.35 * r2Miles, 1.5, 4.0);
    if (dMiles <= r1) return 1.0;
    if (dMiles >= r2Miles) return 0.0;
    const t = (dMiles - r1) / (r2Miles - r1);
    return W_EXT_BASE * Math.pow(1 - t, DECAY_EXP);
  }

  const makeEmptyResult = (address: string, narrative: string, marketAreaName: string | null = null, rMarket: number | null = null): InternalEvaluationResult => ({
    address,
    verdict: "approved" as const,
    currentCapacityUsedPercent: 0,
    projectedCapacityUsedPercent: 0,
    currentStatus: "Open" as CapacityStatus,
    projectedStatus: "Open" as CapacityStatus,
    currentStatusColor: "green" as const,
    projectedStatusColor: "green" as const,
    deltaCapacityPercent: 0,
    narrative,
    marketAreaName,
    existingClientCount: 0,
    competitorsInZone: 0,
    prospectR2: null,
    prospectR1: null,
    rMarket,
    mcuTotal: 0,
    mcuAllocated: 0,
    mcuRemaining: 0,
    overlapRisk: "Low" as OverlapRisk,
    scarcityLabel: "normal" as const,
  });

  const results: InternalEvaluationResult[] = [];

  for (const address of addresses) {
    const geocode = await geocodeAddress(address);
    if (!geocode.success) {
      results.push(makeEmptyResult(address, `Could not locate address. Assuming open market for ${practiceArea}.`));
      continue;
    }

    const prospectLocation: GeoLocation = { lat: geocode.lat, lng: geocode.lng };

    let bestArea: MarketAreaSummary | null = null;
    let bestDistance = Infinity;
    for (const area of marketAreas) {
      const dist = haversineDistance(geocode.lat, geocode.lng, area.centerLat, area.centerLng);
      const marketRadius = area.rMarketRadius || 20;
      if (dist <= marketRadius && dist < bestDistance) {
        bestDistance = dist;
        bestArea = area;
      }
    }

    if (!bestArea) {
      results.push(makeEmptyResult(address, `No existing clients in this market for ${practiceArea}. Wide open for a new client.`));
      continue;
    }

    const practiceSummary = bestArea.practices.find(p => p.practiceArea === practiceArea);
    if (!practiceSummary) {
      results.push(makeEmptyResult(
        address,
        `No existing ${practiceArea} clients in the ${bestArea.marketAreaName} market. Open for a new client.`,
        bestArea.marketAreaName,
        bestArea.rMarketRadius || null,
      ));
      continue;
    }

    const currentPct = practiceSummary.capacityUsedPercent;
    const { status: currentStatus, color: currentColor } = getCapacityStatus(currentPct);
    const existingClientCount = practiceSummary.uniqueClients || 0;
    const competitorsInZone = practiceSummary.competitorsInZone || 0;
    const totalOpportunity = practiceSummary.totalOpportunity || practiceSummary.mcuTotal;
    const usedOpportunity = practiceSummary.usedOpportunity || practiceSummary.mcuAllocated;
    const cachedRMarket = practiceSummary.rMarket || bestArea.rMarketRadius || null;

    console.log(`[Evaluate] Running GBP probe for prospect at ${geocode.lat.toFixed(4)},${geocode.lng.toFixed(4)} (${practiceArea})`);
    const gbpResult = await runGbpRangeLite(prospectLocation, practiceArea);
    const prospectR2 = gbpResult.r2;
    const prospectR1 = gbpResult.r1;
    const prospectRMarket = gbpResult.rMarket;

    console.log(`[Evaluate] Prospect R2=${prospectR2.toFixed(1)}mi, R1=${prospectR1.toFixed(1)}mi, rMarket=${prospectRMarket.toFixed(0)}mi`);

    const relevantLocations = bestArea.locations.filter(loc =>
      loc.practiceAreas.includes(practiceArea)
    );

    const locationIds = relevantLocations.map(loc => loc.locationId);
    let existingLocData: Array<{ id: string; clientId: string; lat: number; lng: number; r2: number; rMarket: number }> = [];

    if (locationIds.length > 0) {
      const dbLocs = await dbRetry(() =>
        db.select({
          id: clientLocations.id,
          clientId: clientLocations.clientId,
          lat: clientLocations.lat,
          lng: clientLocations.lng,
          radiusExtended: clientLocations.radiusExtended,
          radiusMarket: clientLocations.radiusMarket,
        })
        .from(clientLocations)
        .where(inArray(clientLocations.id, locationIds))
      );

      existingLocData = dbLocs
        .filter(loc => loc.lat != null && loc.lng != null)
        .map(loc => ({
          id: loc.id,
          clientId: loc.clientId,
          lat: loc.lat!,
          lng: loc.lng!,
          r2: loc.radiusExtended || bestArea!.r2Radius || 5,
          rMarket: loc.radiusMarket || cachedRMarket || 30,
        }));
    }

    const prospectCenterCell = h3.latLngToCell(prospectLocation.lat, prospectLocation.lng, H3_RES);
    const prospectR2k = Math.ceil((prospectR2 * 1.60934) / H3_EDGE_KM);
    const prospectCells = h3.gridDisk(prospectCenterCell, prospectR2k);

    const marketCells = new Set<string>();

    if (totalOpportunity > 0) {
      for (const loc of existingLocData) {
        const k = Math.ceil((loc.rMarket * 1.60934) / H3_EDGE_KM);
        const center = h3.latLngToCell(loc.lat, loc.lng, H3_RES);
        for (const c of h3.gridDisk(center, k)) marketCells.add(c);
      }
    }

    const prospectRMkt = prospectRMarket || cachedRMarket || 30;
    const prospectMktK = Math.ceil((prospectRMkt * 1.60934) / H3_EDGE_KM);
    for (const c of h3.gridDisk(prospectCenterCell, prospectMktK)) marketCells.add(c);

    const marketCellArray = Array.from(marketCells);
    const cellPopMap = await getPopulationInCells(marketCellArray);

    let simTotalOpportunity = 0;
    for (const cell of marketCellArray) {
      const pop = cellPopMap.get(cell) || 0;
      simTotalOpportunity += pop * PACK_SLOTS;
    }

    const cellClientOcc = new Map<string, Map<string, number>>();

    for (const loc of existingLocData) {
      const center = h3.latLngToCell(loc.lat, loc.lng, H3_RES);
      const k = Math.ceil((loc.r2 * 1.60934) / H3_EDGE_KM);
      const cells = h3.gridDisk(center, k);
      for (const cell of cells) {
        if (!marketCells.has(cell)) continue;
        const [cLat, cLng] = h3.cellToLatLng(cell);
        const dMiles = haversineDistance(loc.lat, loc.lng, cLat, cLng);
        const w = occupancyWeight(dMiles, loc.r2);
        if (w <= 0) continue;
        if (!cellClientOcc.has(cell)) cellClientOcc.set(cell, new Map());
        const co = cellClientOcc.get(cell)!;
        const cur = co.get(loc.clientId) || 0;
        co.set(loc.clientId, Math.max(cur, w));
      }
    }

    let usedBefore = 0;
    cellClientOcc.forEach((clients, cell) => {
      const pop = cellPopMap.get(cell) || 0;
      if (pop === 0) return;
      let slots = 0;
      clients.forEach((occ: number) => { slots += occ; });
      slots = Math.min(PACK_SLOTS, slots);
      usedBefore += pop * slots;
    });

    const prospectId = "__prospect__";
    for (const cell of prospectCells) {
      if (!marketCells.has(cell)) continue;
      const [cLat, cLng] = h3.cellToLatLng(cell);
      const dMiles = haversineDistance(prospectLocation.lat, prospectLocation.lng, cLat, cLng);
      const w = occupancyWeight(dMiles, prospectR2);
      if (w <= 0) continue;
      if (!cellClientOcc.has(cell)) cellClientOcc.set(cell, new Map());
      const co = cellClientOcc.get(cell)!;
      const cur = co.get(prospectId) || 0;
      co.set(prospectId, Math.max(cur, w));
    }

    let usedAfter = 0;
    cellClientOcc.forEach((clients, cell) => {
      const pop = cellPopMap.get(cell) || 0;
      if (pop === 0) return;
      let slots = 0;
      clients.forEach((occ: number) => { slots += occ; });
      slots = Math.min(PACK_SLOTS, slots);
      usedAfter += pop * slots;
    });

    const effTotal = simTotalOpportunity > 0 ? simTotalOpportunity : 1;
    const simCurrentPct = (usedBefore / effTotal) * 100;
    const simProjectedPct = (usedAfter / effTotal) * 100;
    const deltaPct = simProjectedPct - simCurrentPct;

    const { status: projectedStatus, color: projectedColor } = getCapacityStatus(simProjectedPct);
    const { color: simCurrentColor } = getCapacityStatus(simCurrentPct);

    let overlapCells = 0;
    let totalR2Cells = 0;
    const prospectCellSet = new Set(prospectCells);
    cellClientOcc.forEach((clients, cell) => {
      if (!prospectCellSet.has(cell)) return;
      totalR2Cells++;
      if (clients.size > 1) overlapCells++;
    });
    const overlapPressure = totalR2Cells > 0 ? overlapCells / totalR2Cells : 0;
    const overlapRisk: OverlapRisk = overlapPressure > 0.3 ? "High"
      : overlapPressure > 0.1 ? "Moderate"
      : "Low";

    let verdict: "approved" | "conditional" | "decline" = "approved";
    if (projectedStatus === "Saturated" || overlapRisk === "High") {
      verdict = "decline";
    } else if (projectedStatus === "Tight" || overlapRisk === "Moderate") {
      verdict = "conditional";
    }

    const narrative = buildSimulationNarrative(
      practiceArea, bestArea.marketAreaName, existingClientCount,
      simCurrentPct, simProjectedPct, projectedStatus, deltaPct, prospectR2,
    );

    console.log(`[Evaluate] ${address}: current=${simCurrentPct.toFixed(1)}% → projected=${simProjectedPct.toFixed(1)}% (Δ${deltaPct.toFixed(1)}), verdict=${verdict}, R2=${prospectR2.toFixed(1)}mi`);

    results.push({
      address,
      verdict,
      currentCapacityUsedPercent: Math.round(simCurrentPct * 10) / 10,
      projectedCapacityUsedPercent: Math.round(simProjectedPct * 10) / 10,
      currentStatus: getCapacityStatus(simCurrentPct).status,
      projectedStatus,
      currentStatusColor: simCurrentColor,
      projectedStatusColor: projectedColor,
      deltaCapacityPercent: Math.round(deltaPct * 10) / 10,
      narrative,
      marketAreaName: bestArea.marketAreaName,
      existingClientCount,
      competitorsInZone,
      prospectR2: Math.round(prospectR2 * 10) / 10,
      prospectR1: Math.round(prospectR1 * 10) / 10,
      rMarket: cachedRMarket,
      mcuTotal: Math.round(simTotalOpportunity),
      mcuAllocated: Math.round(usedAfter),
      mcuRemaining: Math.round(simTotalOpportunity - usedAfter),
      overlapRisk,
      scarcityLabel: getScarcityLabel(simProjectedPct) as "normal" | "tight" | "limited",
    });
  }

  return { results };
}

async function evaluateAddresses(
  request: EvaluationRequest,
  includeClientDetails: boolean
): Promise<McuResult[]> {
  const { addresses, practiceArea } = request;
  const results: McuResult[] = [];

  const existingLocations = await getExistingClientLocations(practiceArea);
  const existingFootprints = await buildExistingFootprints(existingLocations, includeClientDetails, practiceArea);

  for (const address of addresses) {
    const result = await evaluateSingleAddress(
      address,
      practiceArea,
      existingFootprints,
      includeClientDetails
    );
    results.push(result);
  }

  return results;
}

async function evaluateSingleAddress(
  address: string,
  practiceArea: string,
  existingFootprints: LocationFootprint[],
  includeClientDetails: boolean
): Promise<McuResult> {
  const geocodeResult = await geocodeAddress(address);

  if (!geocodeResult.success) {
    return createFailedResult(address, "Geocoding failed");
  }

  const location: GeoLocation = { lat: geocodeResult.lat, lng: geocodeResult.lng };
  const fips = await getFipsForLocation(location);

  if (!fips) {
    return createFailedResult(address, "FIPS lookup failed");
  }

  const censusData = await getCensusData(fips);
  const demandScore = censusData
    ? calculateDemandScore(censusData, practiceArea)
    : { baseScore: 1, trendsMultiplier: 1, adjustedScore: 1, practiceArea };

  const gbpResult = await runGbpRangeLite(location, practiceArea);
  const radius: DensityRadiusResult = {
    core: gbpResult.r1,
    extended: gbpResult.r2,
    fringe: gbpResult.r2,
    competitorCounts: [],
    competitorsInR2: gbpResult.competitorsInR2,
    rMarket: gbpResult.rMarket,
    diagnostics: {
      competitorsAnalyzed: gbpResult.n,
      r2Base: gbpResult.r2Base,
      densityCurve: [{ radius: gbpResult.rK, count: gbpResult.k, density: gbpResult.densityCore }],
      densityCore: gbpResult.densityCore,
      popDensity3mi: gbpResult.popDensity3mi,
      popFactor: gbpResult.popFactor,
      isDense: gbpResult.n >= 20,
      competitorsWithin20mi: gbpResult.nearestCompetitors.filter(c => c.distanceMiles <= 20).length,
      rMarket: gbpResult.rMarket,
    },
  };

  const rMarket = gbpResult.rMarket || 20;
  const marketPopulation = await getPopulationWithinRadius(location.lat, location.lng, rMarket);
  const effectivePopulation = marketPopulation > 0 ? marketPopulation : (censusData?.population || 100000);
  const popPerSlot = getPopPerSlot(practiceArea);
  const mcuTotal = effectivePopulation / popPerSlot;

  const prospectFootprint = generateLocationFootprint(
    "prospect",
    location,
    radius,
    effectivePopulation
  );

  const relevantFootprints = existingFootprints.filter((fp) => {
    const distance = haversineDistance(location.lat, location.lng, fp.location.lat, fp.location.lng);
    return distance <= radius.fringe * 2;
  });

  const overlaps = calculateOverlap(prospectFootprint, relevantFootprints);
  const { overlapRisk } = calculateTotalOverlap(overlaps);
  
  const maxPairOverlapPct = overlaps.length > 0 
    ? Math.max(...overlaps.map(o => o.overlapPercent / 100))
    : 0;

  const totalOverlapPct = overlaps.reduce((sum, o) => sum + (o.overlapPercent / 100), 0);
  const clampedOverlapPct = Math.min(totalOverlapPct, 1.0);
  const mcuAllocated = mcuTotal * clampedOverlapPct;
  const mcuRemaining = Math.max(mcuTotal - mcuAllocated, 0);

  const saturationPercent = mcuTotal > 0 ? (mcuAllocated / mcuTotal) * 100 : 0;
  const scarcityLabel = getScarcityLabel(saturationPercent);
  const verdict = getVerdict(mcuRemaining, maxPairOverlapPct);

  const result: McuResult = {
    address,
    location,
    fips,
    demandScore,
    radius,
    mcuTotal,
    mcuAllocated,
    mcuRemaining,
    overlapRisk,
    scarcityLabel,
    verdict,
  };

  if (includeClientDetails) {
    result.overlaps = overlaps;
  } else {
    result.overlaps = overlaps.map((o) => ({
      overlapPercent: o.overlapPercent,
      overlapDemand: o.overlapDemand,
    }));
  }

  return result;
}

async function getExistingClientLocations(practiceArea: string) {
  const locations = await db
    .select({
      id: clientLocations.id,
      clientId: clientLocations.clientId,
      address: clientLocations.address,
      city: clientLocations.city,
      state: clientLocations.state,
      lat: clientLocations.lat,
      lng: clientLocations.lng,
      radiusCore: clientLocations.radiusCore,
      radiusExtended: clientLocations.radiusExtended,
      radiusFringe: clientLocations.radiusFringe,
      competitorsInR2: clientLocations.competitorsInR2,
      radiusMarket: clientLocations.radiusMarket,
      isActive: clientLocations.isActive,
      firmName: clients.firmName,
      practiceAreas: clients.practiceAreas,
      isArchived: clients.isArchived,
    })
    .from(clientLocations)
    .innerJoin(clients, eq(clientLocations.clientId, clients.id))
    .where(
      and(
        eq(clientLocations.isActive, true),
        isNotNull(clientLocations.lat),
        isNotNull(clientLocations.lng),
        or(eq(clients.isArchived, false), isNull(clients.isArchived))
      )
    );

  return locations.filter((loc) => {
    const areas = loc.practiceAreas || [];
    return areas.includes(practiceArea);
  });
}

async function buildExistingFootprints(
  locations: Awaited<ReturnType<typeof getExistingClientLocations>>,
  includeClientDetails: boolean,
  practiceArea: string
): Promise<LocationFootprint[]> {
  const footprints: LocationFootprint[] = [];

  for (const loc of locations) {
    let lat = loc.lat;
    let lng = loc.lng;
    let radius: RadiusResult;

    if (!lat || !lng) {
      const fullAddress = [loc.address, loc.city, loc.state].filter(Boolean).join(", ");
      const geocode = await geocodeAddress(fullAddress);
      if (!geocode.success) continue;
      lat = geocode.lat;
      lng = geocode.lng;
    }

    if (loc.radiusCore && loc.radiusExtended && loc.radiusFringe) {
      radius = {
        core: loc.radiusCore,
        extended: loc.radiusExtended,
        fringe: loc.radiusFringe,
        competitorCounts: [],
      };
    } else {
      const gbpResult = await runGbpRangeLite({ lat, lng }, practiceArea);
      radius = {
        core: gbpResult.r1,
        extended: gbpResult.r2,
        fringe: gbpResult.r2,
        competitorCounts: [],
      };
    }

    const footprint = generateLocationFootprint(
      loc.id,
      { lat, lng },
      radius,
      1.0,
      includeClientDetails ? loc.clientId : undefined,
      includeClientDetails ? loc.firmName : undefined,
      includeClientDetails ? [loc.address, loc.city, loc.state].filter(Boolean).join(", ") : undefined
    );

    footprints.push(footprint);
  }

  return footprints;
}

function getScarcityLabel(saturationPercent: number): "normal" | "tight" | "limited" {
  if (saturationPercent < 50) return "normal";
  if (saturationPercent < 75) return "tight";
  return "limited";
}

function getVerdict(
  mcuRemaining: number,
  maxPairOverlapPct: number
): "approved" | "conditional" | "decline" {
  if (mcuRemaining <= 0.5 || maxPairOverlapPct > 0.35) {
    return "decline";
  }
  if (mcuRemaining <= 3.0 || maxPairOverlapPct > 0.20) {
    return "conditional";
  }
  return "approved";
}

function createFailedResult(address: string, reason: string): McuResult {
  return {
    address,
    location: null,
    fips: null,
    demandScore: null,
    radius: null,
    mcuTotal: 0,
    mcuAllocated: 0,
    mcuRemaining: 0,
    overlapRisk: "high",
    scarcityLabel: "limited",
    verdict: "decline",
  };
}

export async function getLocationSummaries(
  stateFilter?: string,
  practiceFilter?: string
): Promise<import("./types").LocationMcuSummary[]> {
  const locations = await db
    .select({
      id: clientLocations.id,
      address: clientLocations.address,
      state: clientLocations.state,
      city: clientLocations.city,
      stateFips: clientLocations.stateFips,
      countyFips: clientLocations.countyFips,
      lat: clientLocations.lat,
      lng: clientLocations.lng,
      radiusCore: clientLocations.radiusCore,
      radiusExtended: clientLocations.radiusExtended,
      radiusFringe: clientLocations.radiusFringe,
      competitorsInR2: clientLocations.competitorsInR2,
      radiusMarket: clientLocations.radiusMarket,
      r2AlgoVersion: clientLocations.r2AlgoVersion,
      practiceAreas: clients.practiceAreas,
      clientId: clients.id,
      firmName: clients.firmName,
    })
    .from(clientLocations)
    .innerJoin(clients, eq(clientLocations.clientId, clients.id))
    .where(
      and(
        eq(clientLocations.isActive, true),
        isNotNull(clientLocations.lat),
        isNotNull(clientLocations.lng),
        or(eq(clients.isArchived, false), isNull(clients.isArchived))
      )
    );

  // Build footprints for all locations, grouped by practice area
  const footprintsByPractice = new Map<string, LocationFootprint[]>();
  const locationDataMap = new Map<string, typeof locations[0]>();

  for (const loc of locations) {
    if (!loc.lat || !loc.lng) continue;
    locationDataMap.set(loc.id, loc);

    const practiceAreas = loc.practiceAreas || [];
    for (const practice of practiceAreas) {
      const state = loc.state || "Unknown";
      if (stateFilter && state !== stateFilter) continue;
      if (practiceFilter && practice !== practiceFilter) continue;

      if (!footprintsByPractice.has(practice)) {
        footprintsByPractice.set(practice, []);
      }

      const radius: RadiusResult = {
        core: loc.radiusCore || 3,
        extended: loc.radiusExtended || 8,
        fringe: loc.radiusFringe || 15,
        competitorCounts: [],
      };

      // Get demand value for this location's region (county-level for v1)
      let demandPerCell = 1.0;
      if (loc.stateFips && loc.countyFips) {
        const censusData = await getCensusData({ stateFips: loc.stateFips, countyFips: loc.countyFips });
        if (censusData) {
          const demandScore = calculateDemandScore(censusData, practice);
          demandPerCell = demandScore.adjustedScore;
        }
      }

      const footprint = generateLocationFootprint(
        loc.id,
        { lat: loc.lat, lng: loc.lng },
        radius,
        demandPerCell,
        loc.clientId,
        loc.firmName,
        loc.address || undefined
      );

      footprintsByPractice.get(practice)!.push(footprint);
    }
  }

  const results: import("./types").LocationMcuSummary[] = [];

  // For each practice area, compute MCU for each location
  for (const [practice, footprints] of Array.from(footprintsByPractice)) {
    for (const fp of footprints) {
      const locData = locationDataMap.get(fp.locationId);
      if (!locData) continue;

      // MCU_Total = EffectiveDemand / MCU_SIZE
      const mcuTotal = fp.totalWeightedDemand / MCU_SIZE;

      // Calculate overlap with OTHER CLIENTS' locations in the same practice area (skip same-client)
      const otherFootprints = footprints.filter((other: LocationFootprint) =>
        other.locationId !== fp.locationId && other.clientId !== fp.clientId
      );
      const overlaps = calculateOverlap(fp, otherFootprints);

      // MCU_Allocated = sum of overlap demands / MCU_SIZE
      let totalOverlapDemand = 0;
      let maxOverlapPercent = 0;
      const overlappingLocations: import("./types").LocationMcuSummary["overlappingLocations"] = [];

      for (const overlap of overlaps) {
        if (overlap.overlapPercent > 0) {
          totalOverlapDemand += overlap.overlapDemand;
          maxOverlapPercent = Math.max(maxOverlapPercent, overlap.overlapPercent);
          overlappingLocations.push({
            locationId: overlap.clientLocationId || "",
            clientId: overlap.clientId || "",
            clientName: overlap.clientName || "",
            overlapPercent: Math.round(overlap.overlapPercent * 10) / 10,
          });
        }
      }

      const mcuAllocated = totalOverlapDemand / MCU_SIZE;
      const mcuRemaining = Math.max(0, mcuTotal - mcuAllocated);
      const saturationPercent = mcuTotal > 0 ? (mcuAllocated / mcuTotal) * 100 : 0;

      // Status based on saturation
      let status: "green" | "yellow" | "red" = "green";
      if (saturationPercent >= 75 || maxOverlapPercent > 35) {
        status = "red";
      } else if (saturationPercent >= 50 || maxOverlapPercent > 20) {
        status = "yellow";
      }

      // Scarcity label per spec
      let scarcityLabel: "normal" | "tight" | "limited" = "normal";
      if (mcuRemaining <= 3) {
        scarcityLabel = "limited";
      } else if (mcuRemaining <= 6) {
        scarcityLabel = "tight";
      }

      results.push({
        locationId: fp.locationId,
        clientId: locData.clientId,
        clientName: locData.firmName,
        address: locData.address || "",
        city: locData.city || "Unknown",
        state: locData.state || "Unknown",
        practiceArea: practice,
        lat: locData.lat!,
        lng: locData.lng!,
        radius: {
          core: fp.radius.core,
          extended: fp.radius.extended,
          fringe: fp.radius.fringe,
        },
        mcuTotal: Math.round(mcuTotal * 10) / 10,
        mcuAllocated: Math.round(mcuAllocated * 10) / 10,
        mcuRemaining: Math.round(mcuRemaining * 10) / 10,
        saturationPercent: Math.round(saturationPercent * 10) / 10,
        status,
        scarcityLabel,
        maxOverlapPercent: Math.round(maxOverlapPercent * 10) / 10,
        overlappingLocations,
      });
    }
  }

  return results.sort((a, b) => b.saturationPercent - a.saturationPercent);
}

// Keep legacy function for backwards compatibility, returns aggregated market data
export async function getMarketSummary(
  stateFilter?: string,
  practiceFilter?: string
): Promise<MarketSummary[]> {
  const locationSummaries = await getLocationSummaries(stateFilter, practiceFilter);
  
  // Aggregate by city + practice area for summary view
  const marketMap = new Map<string, {
    city: string;
    state: string;
    practiceArea: string;
    totalMcu: number;
    allocatedMcu: number;
    clientIds: Set<string>;
    locationCount: number;
  }>();

  for (const loc of locationSummaries) {
    const key = `${loc.city}-${loc.state}-${loc.practiceArea}`;
    if (!marketMap.has(key)) {
      marketMap.set(key, {
        city: loc.city,
        state: loc.state,
        practiceArea: loc.practiceArea,
        totalMcu: 0,
        allocatedMcu: 0,
        clientIds: new Set(),
        locationCount: 0,
      });
    }
    const market = marketMap.get(key)!;
    market.totalMcu += loc.mcuTotal;
    market.allocatedMcu += loc.mcuAllocated;
    market.clientIds.add(loc.clientId);
    market.locationCount++;
  }

  const results: MarketSummary[] = [];
  for (const market of Array.from(marketMap.values())) {
    const remainingMcu = market.totalMcu - market.allocatedMcu;
    const saturationPercent = market.totalMcu > 0 ? (market.allocatedMcu / market.totalMcu) * 100 : 0;

    let status: "green" | "yellow" | "red" = "green";
    if (saturationPercent >= 75) {
      status = "red";
    } else if (saturationPercent >= 50) {
      status = "yellow";
    }

    results.push({
      state: market.state,
      city: market.city,
      practiceArea: market.practiceArea,
      totalMcu: Math.round(market.totalMcu * 10) / 10,
      allocatedMcu: Math.round(market.allocatedMcu * 10) / 10,
      remainingMcu: Math.round(remainingMcu * 10) / 10,
      saturationPercent: Math.round(saturationPercent * 10) / 10,
      status,
      clientCount: market.clientIds.size,
      locationCount: market.locationCount,
    });
  }

  return results.sort((a, b) => b.saturationPercent - a.saturationPercent);
}

function getOverlapRisk(overlapPct: number): OverlapRisk {
  if (overlapPct > 35) return "High";
  if (overlapPct >= 15) return "Moderate";
  return "Low";
}

function getCapacityStatus(usedPercent: number): { status: CapacityStatus; color: "green" | "yellow" | "orange" | "red" } {
  if (usedPercent < 35) return { status: "Open", color: "green" };
  if (usedPercent < 60) return { status: "Filling", color: "yellow" };
  if (usedPercent < 80) return { status: "Tight", color: "orange" };
  return { status: "Saturated", color: "red" };
}

const radiusComputeLocks = new Map<string, Promise<DensityRadiusResult>>();

async function computeDynamicRadiusForLocation(
  loc: { id: string; lat: number; lng: number; radiusCore: number | null; radiusExtended: number | null; radiusFringe: number | null; competitorsInR2: number | null; radiusMarket: number | null; r2AlgoVersion?: string | null; practiceAreas?: string[] },
  onProbeProgress?: (info: { apiCallsDone: number; totalExpected: number; uniqueFound: number }) => void,
  forceProbeSearch: boolean = false
): Promise<DensityRadiusResult> {
  const versionMatch = loc.r2AlgoVersion === ALGO_VERSION;
  if (!forceProbeSearch && versionMatch && loc.radiusCore && loc.radiusExtended && loc.radiusFringe && loc.competitorsInR2 !== null && loc.competitorsInR2 !== undefined && loc.radiusMarket) {
    return {
      core: loc.radiusCore,
      extended: loc.radiusExtended,
      fringe: loc.radiusFringe,
      competitorCounts: [],
      competitorsInR2: loc.competitorsInR2,
      rMarket: loc.radiusMarket,
      diagnostics: {
        competitorsAnalyzed: loc.competitorsInR2 ?? 0,
        r2Base: loc.radiusExtended,
        densityCurve: [],
        densityCore: 0,
        popDensity3mi: 0,
        popFactor: 1.0,
        isDense: false,
        competitorsWithin20mi: 0,
        rMarket: loc.radiusMarket,
      },
    };
  }

  if (!forceProbeSearch && versionMatch && loc.radiusExtended && loc.radiusExtended > 0) {
    const r2 = loc.radiusExtended;
    const r1 = loc.radiusCore || clamp(0.35 * r2, 1.5, 4.0);
    const fringe = loc.radiusFringe || r2;
    const compInR2 = loc.competitorsInR2 ?? 0;

    let rMarket = loc.radiusMarket;
    if (!rMarket || rMarket <= 0) {
      const location: GeoLocation = { lat: loc.lat, lng: loc.lng };
      rMarket = await calculateRMarket(location, r2);
      try {
        await dbRetry(() => db.update(clientLocations).set({ radiusMarket: rMarket! }).where(eq(clientLocations.id, loc.id)), `persist-rmarket:${loc.id.slice(0, 8)}`);
      } catch (e) {
        console.warn(`[Radius] Failed to persist R_market for ${loc.id}`);
      }
    }

    console.log(`[Radius] Partial cache for ${loc.id}: R1=${r1.toFixed(1)}, R2=${r2.toFixed(1)}, R_market=${rMarket.toFixed(1)}`);
    return {
      core: r1,
      extended: r2,
      fringe: fringe,
      competitorCounts: [],
      competitorsInR2: compInR2,
      rMarket: rMarket,
      diagnostics: {
        competitorsAnalyzed: compInR2,
        r2Base: r2,
        densityCurve: [],
        densityCore: 0,
        popDensity3mi: 0,
        popFactor: 1.0,
        isDense: false,
        competitorsWithin20mi: 0,
        rMarket: rMarket,
      },
    };
  }

  if (!versionMatch && loc.radiusExtended && loc.radiusExtended > 0) {
    console.log(`[Radius] Stale algo version for ${loc.id}: cached=${loc.r2AlgoVersion || 'none'}, current=${ALGO_VERSION}. Falling through to GBP Range Lite.`);
  }

  const lockKey = loc.id;
  const existing = radiusComputeLocks.get(lockKey);
  if (existing) return existing;

  const promise = (async (): Promise<DensityRadiusResult> => {
    const location: GeoLocation = { lat: loc.lat, lng: loc.lng };
    const practiceArea = (loc.practiceAreas && loc.practiceAreas[0]) || "Personal Injury";

    console.log(`[Radius] Running GBP Range Lite for ${loc.id} (force=${forceProbeSearch}, practiceArea=${practiceArea})`);
    const gbpResult = await runGbpRangeLite(location, practiceArea, onProbeProgress);

    const result: DensityRadiusResult = {
      core: gbpResult.r1,
      extended: gbpResult.r2,
      fringe: gbpResult.r2,
      competitorCounts: [],
      competitorsInR2: gbpResult.competitorsInR2,
      rMarket: gbpResult.rMarket,
      diagnostics: {
        competitorsAnalyzed: gbpResult.n,
        r2Base: gbpResult.r2Base,
        densityCurve: [{ radius: gbpResult.rK, count: gbpResult.k, density: gbpResult.densityCore }],
        densityCore: gbpResult.densityCore,
        popDensity3mi: gbpResult.popDensity3mi,
        popFactor: gbpResult.popFactor,
        isDense: gbpResult.n >= 20,
        competitorsWithin20mi: gbpResult.nearestCompetitors.filter(c => c.distanceMiles <= 20).length,
        rMarket: gbpResult.rMarket,
      },
    };

    try {
      await dbRetry(() => db
        .update(clientLocations)
        .set({
          radiusCore: result.core,
          radiusExtended: result.extended,
          radiusFringe: result.fringe,
          competitorsInR2: result.competitorsInR2,
          radiusMarket: result.rMarket,
          r2AlgoVersion: ALGO_VERSION,
        })
        .where(eq(clientLocations.id, loc.id)), `persist-radii:${loc.id.slice(0, 8)}`);
    } catch (e) {
      console.warn("Failed to persist computed radii for location", loc.id);
    }

    return result;
  })();

  radiusComputeLocks.set(lockKey, promise);
  try {
    return await promise;
  } finally {
    radiusComputeLocks.delete(lockKey);
  }
}


async function estimateMarketPopulationFromTracts(
  unionCells: Map<string, number>,
  relevantStateFips: string[],
  cacheKey: string
): Promise<number> {
  const cached = await getCached<number>("marketpop", cacheKey);
  if (cached !== null) {
    return cached;
  }

  const uniqueStates = Array.from(new Set(relevantStateFips));
  if (uniqueStates.length === 0) {
    const H3_CELL_AREA_SQ_KM = 5.161;
    const DEFAULT_DENSITY_PER_SQ_KM = 100;
    const marketPop = Math.round(unionCells.size * H3_CELL_AREA_SQ_KM * DEFAULT_DENSITY_PER_SQ_KM);
    await setCache("marketpop", cacheKey, marketPop);
    return marketPop;
  }

  const tracts = await dbRetry(() => db
    .select({
      population: censusTracts.population,
      centroidLat: censusTracts.centroidLat,
      centroidLng: censusTracts.centroidLng,
    })
    .from(censusTracts)
    .where(inArray(censusTracts.stateFips, uniqueStates)), "load-tracts");

  if (tracts.length === 0) {
    const H3_CELL_AREA_SQ_KM = 5.161;
    const DEFAULT_DENSITY_PER_SQ_KM = 100;
    const marketPop = Math.round(unionCells.size * H3_CELL_AREA_SQ_KM * DEFAULT_DENSITY_PER_SQ_KM);
    await setCache("marketpop", cacheKey, marketPop);
    return marketPop;
  }

  const H3_RESOLUTION = 7;
  let totalPop = 0;
  for (const tract of tracts) {
    if (tract.population <= 0) continue;
    try {
      const tractH3 = h3.latLngToCell(tract.centroidLat, tract.centroidLng, H3_RESOLUTION);
      if (unionCells.has(tractH3)) {
        totalPop += tract.population;
      }
    } catch {
    }
  }

  const marketPop = Math.max(totalPop, 1000);
  await setCache("marketpop", cacheKey, marketPop);
  return marketPop;
}

export interface ComputeProgressCallback {
  (info: { phase: string; current: number; total: number; detail?: string; partialResults?: MarketAreaSummary[] }): void;
}

export async function getMarketAreaSummaries(
  stateFilter?: string,
  practiceFilter?: string,
  onProgress?: ComputeProgressCallback,
  forceProbeSearch: boolean = false
): Promise<MarketAreaSummary[]> {
  console.log('[MCU Engine] Starting getMarketAreaSummaries...');
  const locations = await dbRetry(() => db
    .select({
      id: clientLocations.id,
      address: clientLocations.address,
      state: clientLocations.state,
      city: clientLocations.city,
      stateFips: clientLocations.stateFips,
      countyFips: clientLocations.countyFips,
      lat: clientLocations.lat,
      lng: clientLocations.lng,
      radiusCore: clientLocations.radiusCore,
      radiusExtended: clientLocations.radiusExtended,
      radiusFringe: clientLocations.radiusFringe,
      competitorsInR2: clientLocations.competitorsInR2,
      radiusMarket: clientLocations.radiusMarket,
      r2AlgoVersion: clientLocations.r2AlgoVersion,
      practiceAreas: clients.practiceAreas,
      clientId: clients.id,
      firmName: clients.firmName,
    })
    .from(clientLocations)
    .innerJoin(clients, eq(clientLocations.clientId, clients.id))
    .where(
      and(
        eq(clientLocations.isActive, true),
        isNotNull(clientLocations.lat),
        isNotNull(clientLocations.lng),
        or(eq(clients.isArchived, false), isNull(clients.isArchived))
      )
    ), "load-locations");

  console.log(`[MCU Engine] Found ${locations.length} total locations (with coordinates, non-archived)`);

  const filteredLocations = locations.filter(loc => {
    if (!loc.lat || !loc.lng) return false;
    if (stateFilter && loc.state !== stateFilter) return false;
    return true;
  });

  console.log(`[MCU Engine] ${filteredLocations.length} locations after filtering (with lat/lng)`);
  onProgress?.({ phase: 'Loading locations', current: 1, total: 1, detail: `${filteredLocations.length} locations found` });

  const locsMissingFips = filteredLocations.filter(loc => !loc.stateFips || !loc.countyFips);
  if (locsMissingFips.length > 0) {
    console.log(`[MCU Engine] Backfilling FIPS for ${locsMissingFips.length} locations...`);
    await Promise.all(locsMissingFips.map(async (loc) => {
      try {
        const fips = await getFipsForLocation({ lat: loc.lat!, lng: loc.lng! });
        if (fips) {
          loc.stateFips = fips.stateFips;
          loc.countyFips = fips.countyFips;
          await dbRetry(() => db
            .update(clientLocations)
            .set({ stateFips: fips.stateFips, countyFips: fips.countyFips })
            .where(eq(clientLocations.id, loc.id)), `fips-backfill:${loc.id.slice(0, 8)}`);
        }
      } catch (e) {
        console.warn(`[MCU Engine] FIPS backfill failed for location ${loc.id}`);
      }
    }));
  }

  const locationCountyNames = new Map<string, string>();
  const fipsLookupKeys = new Map<string, string[]>();
  for (const loc of filteredLocations) {
    if (!loc.lat || !loc.lng) continue;
    const key = `${loc.lat.toFixed(6)},${loc.lng.toFixed(6)}`;
    if (!fipsLookupKeys.has(key)) fipsLookupKeys.set(key, []);
    fipsLookupKeys.get(key)!.push(loc.id);
  }
  const uniqueCoords = Array.from(fipsLookupKeys.entries());
  const FIPS_BATCH = 10;
  for (let i = 0; i < uniqueCoords.length; i += FIPS_BATCH) {
    const batch = uniqueCoords.slice(i, i + FIPS_BATCH);
    await Promise.all(batch.map(async ([coordKey, locIds]) => {
      const [latStr, lngStr] = coordKey.split(",");
      try {
        const fips = await getFipsForLocation({ lat: parseFloat(latStr), lng: parseFloat(lngStr) });
        if (fips?.countyName) {
          for (const id of locIds) locationCountyNames.set(id, fips.countyName);
        }
      } catch {}
    }));
  }

  const marketAreas = clusterLocationsIntoMarketAreas(
    filteredLocations.map(loc => ({
      id: loc.id,
      clientId: loc.clientId,
      clientName: loc.firmName,
      address: loc.address || "",
      city: loc.city || "Unknown",
      state: loc.state || "Unknown",
      lat: loc.lat!,
      lng: loc.lng!,
      countyFips: loc.countyFips,
      countyName: locationCountyNames.get(loc.id) || null,
    }))
  );

  const allPracticeAreas = new Set<string>();
  for (const loc of filteredLocations) {
    for (const pa of loc.practiceAreas || []) {
      if (!practiceFilter || pa === practiceFilter) {
        allPracticeAreas.add(pa);
      }
    }
  }

  const locationRadii = new Map<string, DensityRadiusResult>();
  const locationDataMap = new Map<string, typeof filteredLocations[0]>();

  for (const loc of filteredLocations) {
    locationDataMap.set(loc.id, loc);
  }

  const totalLocs = filteredLocations.length;
  const TOTAL_STEPS = totalLocs * 100;
  onProgress?.({ phase: 'Computing radii', current: 0, total: TOTAL_STEPS, detail: 'Searching for competitors...' });
  let radiiDone = 0;
  let radiiFailed = 0;
  const RADII_BATCH_SIZE = 3;
  for (let i = 0; i < filteredLocations.length; i += RADII_BATCH_SIZE) {
    const batch = filteredLocations.slice(i, i + RADII_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(async (loc) => {
      const locCity = loc.city || loc.address || `Location ${loc.id.slice(0, 6)}`;
      const probeProgressCb = (info: { apiCallsDone: number; totalExpected: number; uniqueFound: number }) => {
        const locFraction = info.totalExpected > 0 ? info.apiCallsDone / info.totalExpected : 0;
        const currentSteps = Math.round((radiiDone + locFraction) * 100);
        onProgress?.({
          phase: 'Computing radii',
          current: Math.min(currentSteps, TOTAL_STEPS),
          total: TOTAL_STEPS,
          detail: `${locCity}: Searching competitors (${info.apiCallsDone}/${info.totalExpected} queries, ${info.uniqueFound} found)`
        });
      };
      const radius = await computeDynamicRadiusForLocation({
        id: loc.id,
        lat: loc.lat!,
        lng: loc.lng!,
        radiusCore: loc.radiusCore,
        radiusExtended: loc.radiusExtended,
        radiusFringe: loc.radiusFringe,
        competitorsInR2: loc.competitorsInR2,
        radiusMarket: loc.radiusMarket,
        r2AlgoVersion: loc.r2AlgoVersion,
        practiceAreas: loc.practiceAreas || [],
      }, probeProgressCb, forceProbeSearch);
      locationRadii.set(loc.id, radius);
      radiiDone++;
      onProgress?.({ phase: 'Computing radii', current: radiiDone * 100, total: TOTAL_STEPS, detail: `Completed ${locCity}` });
    }));
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'rejected') {
        const loc = batch[j];
        const reason = (results[j] as PromiseRejectedResult).reason;
        console.error(`[MCU Engine] Failed to compute radius for ${loc.city || loc.id}: ${reason?.message || reason}`);
        radiiFailed++;
        radiiDone++;
      }
    }
  }
  console.log(`[MCU Engine] Dynamic radii computed for ${locationRadii.size} locations (${radiiFailed} failed)`);

  const locationFootprints = new Map<string, Map<string, LocationFootprint>>();

  for (const loc of filteredLocations) {
    const radius = locationRadii.get(loc.id);
    if (!radius) continue;

    const practiceAreas = loc.practiceAreas || [];

    for (const practice of practiceAreas) {
      if (practiceFilter && practice !== practiceFilter) continue;

      if (!locationFootprints.has(practice)) {
        locationFootprints.set(practice, new Map());
      }

      const footprint = generateLocationFootprint(
        loc.id,
        { lat: loc.lat!, lng: loc.lng! },
        radius,
        1.0,
        loc.clientId,
        loc.firmName,
        loc.address || undefined
      );

      locationFootprints.get(practice)!.set(loc.id, footprint);
    }
  }

  const results: MarketAreaSummary[] = [];

  let totalMarketPracticePairs = 0;
  for (const _ma of marketAreas) {
    totalMarketPracticePairs += allPracticeAreas.size;
  }
  let completedPairs = 0;

  const MARKET_AREA_CONCURRENCY = 15;
  for (let maIdx = 0; maIdx < marketAreas.length; maIdx += MARKET_AREA_CONCURRENCY) {
    const maBatch = marketAreas.slice(maIdx, maIdx + MARKET_AREA_CONCURRENCY);
    const batchSettled = await Promise.allSettled(maBatch.map(async (marketArea) => {

    const practices: MarketAreaSummary["practices"] = [];
    let allTopOverlaps: MarketAreaSummary["topExternalOverlaps"] = [];

    const practicePromises = Array.from(allPracticeAreas).map(async (practice) => {
      const practiceFootprints = locationFootprints.get(practice);
      if (!practiceFootprints) return null;

      const areaFootprints: LocationFootprint[] = [];
      const areaClientIds = new Set<string>();
      for (const loc of marketArea.locations) {
        const fp = practiceFootprints.get(loc.locationId);
        if (fp) {
          areaFootprints.push(fp);
          if (fp.clientId) areaClientIds.add(fp.clientId);
        }
      }

      if (areaFootprints.length === 0) return null;

      const unionCells = new Map<string, number>();
      const r2UnionCells = new Set<string>();
      for (const fp of areaFootprints) {
        fp.cells.forEach((weight, cell) => {
          const current = unionCells.get(cell) || 0;
          unionCells.set(cell, Math.max(current, weight));
        });
        fp.r2Cells.forEach(cell => r2UnionCells.add(cell));
      }

      const sortedLocIds = marketArea.locations.map(l => l.locationId).sort();
      const radiiFingerprint = sortedLocIds.map(lid => {
        const r = locationRadii.get(lid);
        return r ? `${r.core.toFixed(1)}-${r.extended.toFixed(1)}` : "?";
      }).join("|");
      const footprintHash = createHash("md5").update(sortedLocIds.join(",") + ":" + radiiFingerprint).digest("hex").slice(0, 12);

      const relevantStateFips = marketArea.locations
        .map(l => locationDataMap.get(l.locationId)?.stateFips)
        .filter((s): s is string => !!s);

      const r2PopCells = new Map<string, number>();
      r2UnionCells.forEach(cell => {
        r2PopCells.set(cell, unionCells.get(cell) || 1.0);
      });

      const marketPopCacheKeyV4 = `${marketArea.id}:${practice}:v4:r2pop:${footprintHash}`;
      const marketPopulation = await estimateMarketPopulationFromTracts(
        r2PopCells,
        relevantStateFips,
        marketPopCacheKeyV4
      );
      console.log(`[MCU Engine] ${marketArea.name} / ${practice}: R2 cells=${r2UnionCells.size}, Full cells=${unionCells.size}, Population=${marketPopulation.toLocaleString()}`);
      completedPairs++;
      onProgress?.({ phase: 'Analyzing markets', current: completedPairs, total: totalMarketPracticePairs, detail: `Completed ${completedPairs} of ${totalMarketPracticePairs} markets` });

      const uniqueClients = areaClientIds.size;

      let totalCompetitorsInR2 = 0;
      for (const loc of marketArea.locations) {
        const radius = locationRadii.get(loc.locationId);
        if (radius && radius.competitorsInR2 != null) {
          totalCompetitorsInR2 += radius.competitorsInR2;
        }
      }

      const PACK_SLOTS = 3.0;
      const W_EXT_BASE = 0.60;
      const DECAY_EXP = 2.0;
      const H3_RES = 8;
      const H3_EDGE_KM = 0.461;

      function occupancyWeight(dMiles: number, r2Miles: number): number {
        const r1 = clamp(0.35 * r2Miles, 1.5, 4.0);
        if (dMiles <= r1) return 1.0;
        if (dMiles >= r2Miles) return 0.0;
        const t = (dMiles - r1) / (r2Miles - r1);
        return W_EXT_BASE * Math.pow(1 - t, DECAY_EXP);
      }

      const marketCells = new Set<string>();
      for (const fp of areaFootprints) {
        const radius = locationRadii.get(fp.locationId);
        if (!radius) continue;
        const rMarket = radius.rMarket || 30;
        const k = Math.ceil((rMarket * 1.60934) / H3_EDGE_KM);
        const centerCell = h3.latLngToCell(fp.location.lat, fp.location.lng, H3_RES);
        const cells = h3.gridDisk(centerCell, k);
        for (const c of cells) marketCells.add(c);
      }

      const marketCellArray = Array.from(marketCells);
      const cellPopMap = await getPopulationInCells(marketCellArray);

      let totalOpportunity = 0;
      let totalMarketPop = 0;
      for (const cell of marketCellArray) {
        const pop = cellPopMap.get(cell) || 0;
        totalMarketPop += pop;
        totalOpportunity += pop * PACK_SLOTS;
      }

      const cellClientOcc = new Map<string, Map<string, number>>();
      for (const fp of areaFootprints) {
        if (!fp.clientId) continue;
        const radius = locationRadii.get(fp.locationId);
        if (!radius) continue;
        const r2 = radius.extended;
        const centerCell = h3.latLngToCell(fp.location.lat, fp.location.lng, H3_RES);
        const r2k = Math.ceil((r2 * 1.60934) / H3_EDGE_KM);
        const r2Cells = h3.gridDisk(centerCell, r2k);

        for (const cell of r2Cells) {
          if (!marketCells.has(cell)) continue;
          const [cellLat, cellLng] = h3.cellToLatLng(cell);
          const dMiles = haversineDistance(fp.location.lat, fp.location.lng, cellLat, cellLng);
          const w = occupancyWeight(dMiles, r2);
          if (w <= 0) continue;
          if (!cellClientOcc.has(cell)) cellClientOcc.set(cell, new Map());
          const co = cellClientOcc.get(cell)!;
          const current = co.get(fp.clientId) || 0;
          co.set(fp.clientId, Math.max(current, w));
        }
      }

      let usedOpportunity = 0;
      cellClientOcc.forEach((clients, cell) => {
        const pop = cellPopMap.get(cell) || 0;
        if (pop === 0) return;
        let usedSlots = 0;
        clients.forEach((occ: number) => { usedSlots += occ; });
        usedSlots = Math.min(PACK_SLOTS, usedSlots);
        usedOpportunity += pop * usedSlots;
      });

      const capacityUsedPercent = totalOpportunity > 0
        ? (usedOpportunity / totalOpportunity) * 100
        : 0;

      const { status, color } = getCapacityStatus(capacityUsedPercent);

      const cellClientCount = new Map<string, Set<string>>();
      for (const fp of areaFootprints) {
        if (!fp.clientId) continue;
        const radius = locationRadii.get(fp.locationId);
        if (!radius) continue;
        fp.cells.forEach((_, cell) => {
          if (!cellClientCount.has(cell)) {
            cellClientCount.set(cell, new Set());
          }
          cellClientCount.get(cell)!.add(fp.clientId!);
        });
      }

      let overlapCells = 0;
      let totalR2Cells = 0;
      cellClientCount.forEach((clients) => {
        totalR2Cells++;
        if (clients.size > 1) overlapCells++;
      });
      const overlapPressure = totalR2Cells > 0 ? overlapCells / totalR2Cells : 0;
      const geoRisk: OverlapRisk = overlapPressure > 0.3 ? "High"
        : overlapPressure > 0.1 ? "Moderate"
        : "Low";
      const overlapRisk: OverlapRisk = capacityUsedPercent < 35 ? "Low"
        : capacityUsedPercent < 60 ? (geoRisk === "High" ? "Moderate" : geoRisk)
        : geoRisk;

      const medianRMarket = (() => {
        const vals = areaFootprints.map(fp => locationRadii.get(fp.locationId)?.rMarket).filter((v): v is number => v != null && v > 0).sort((a, b) => a - b);
        return vals.length > 0 ? vals[Math.floor(vals.length / 2)] : undefined;
      })();

      const medianStrongInfluence = (() => {
        const vals = areaFootprints.map(fp => {
          const r = locationRadii.get(fp.locationId);
          if (!r) return null;
          const r2 = r.extended;
          const r1 = clamp(0.35 * r2, 1.5, 4.0);
          const tThreshold = 1 - Math.pow(0.20 / W_EXT_BASE, 1 / DECAY_EXP);
          return Math.round((r1 + tThreshold * (r2 - r1)) * 10) / 10;
        }).filter((v): v is number => v != null).sort((a, b) => a - b);
        return vals.length > 0 ? vals[Math.floor(vals.length / 2)] : undefined;
      })();

      console.log(`[MCU Engine] ${marketArea.name} / ${practice}: MarketCells=${marketCellArray.length}, MarketPop=${totalMarketPop.toLocaleString()}, TotalOpp=${totalOpportunity.toLocaleString()}, UsedOpp=${usedOpportunity.toLocaleString()}, MCU%=${capacityUsedPercent.toFixed(1)}%`);

      const practiceResult = {
        practiceArea: practice,
        capacityUsedPercent: Math.round(capacityUsedPercent * 10) / 10,
        status,
        statusColor: color,
        mcuTotal: Math.round(totalOpportunity),
        mcuAllocated: Math.round(usedOpportunity),
        mcuRemaining: Math.round(totalOpportunity - usedOpportunity),
        overlapRisk,
        marketPopulation: Math.round(totalMarketPop),
        uniqueClients,
        competitorsInZone: totalCompetitorsInR2,
        rMarket: medianRMarket ? Math.round(medianRMarket) : undefined,
        strongInfluenceRadius: medianStrongInfluence,
        totalOpportunity: Math.round(totalOpportunity),
        usedOpportunity: Math.round(usedOpportunity),
      };

      const overlapEntries: MarketAreaSummary["topExternalOverlaps"] = [];
      if (areaFootprints.length >= 2) {
        const clientOverlaps = new Map<string, { clientId: string; clientName: string; address: string; overlap: number }>();
        for (let i = 0; i < areaFootprints.length; i++) {
          for (let j = i + 1; j < areaFootprints.length; j++) {
            const fpA = areaFootprints[i];
            const fpB = areaFootprints[j];
            if (fpA.clientId === fpB.clientId) continue;

            let sharedCells = 0;
            fpA.cells.forEach((_, cell) => {
              if (fpB.cells.has(cell)) sharedCells++;
            });
            const minCells = Math.min(fpA.cells.size, fpB.cells.size);
            const pairOverlapPct = minCells > 0 ? (sharedCells / minCells) * 100 : 0;

            if (pairOverlapPct > 5) {
              const keyB = fpB.clientId || fpB.locationId;
              const existing = clientOverlaps.get(keyB);
              if (!existing || pairOverlapPct > existing.overlap) {
                clientOverlaps.set(keyB, {
                  clientId: fpB.clientId || "",
                  clientName: fpB.clientName || "",
                  address: fpB.address || "",
                  overlap: pairOverlapPct,
                });
              }
              const keyA = fpA.clientId || fpA.locationId;
              const existingA = clientOverlaps.get(keyA);
              if (!existingA || pairOverlapPct > existingA.overlap) {
                clientOverlaps.set(keyA, {
                  clientId: fpA.clientId || "",
                  clientName: fpA.clientName || "",
                  address: fpA.address || "",
                  overlap: pairOverlapPct,
                });
              }
            }
          }
        }

        const sorted = Array.from(clientOverlaps.values())
          .sort((a, b) => b.overlap - a.overlap)
          .slice(0, 3);

        for (const entry of sorted) {
          overlapEntries.push({
            clientId: entry.clientId,
            clientName: entry.clientName,
            address: entry.address,
            overlapPercent: Math.round(entry.overlap),
          });
        }
      }

      return { practiceResult, overlapEntries };
    });

    const practiceResults = await Promise.all(practicePromises);
    for (const pr of practiceResults) {
      if (!pr) continue;
      practices.push(pr.practiceResult);
      allTopOverlaps.push(...pr.overlapEntries);
    }

    if (practices.length === 0) return null;

    practices.sort((a, b) => b.capacityUsedPercent - a.capacityUsedPercent);

    const seenClients = new Set<string>();
    allTopOverlaps = allTopOverlaps
      .filter(o => {
        if (seenClients.has(o.clientId)) return false;
        seenClients.add(o.clientId);
        return true;
      })
      .slice(0, 5);

    const locationDetails: MarketAreaSummary["locations"] = [];
    for (const loc of marketArea.locations) {
      const locData = locationDataMap.get(loc.locationId);
      locationDetails.push({
        locationId: loc.locationId,
        clientId: loc.clientId,
        clientName: loc.clientName,
        address: loc.address,
        city: loc.city,
        practiceAreas: locData?.practiceAreas || [],
        mcuRemaining: 0,
        overlapPercent: 0,
      });
    }

    const clientIds = new Set(marketArea.locations.map(l => l.clientId));

    const radiusResults = marketArea.locations
      .map(l => locationRadii.get(l.locationId))
      .filter((v): v is DensityRadiusResult => v != null);
    const r2Values = radiusResults.map(r => r.extended).sort((a, b) => a - b);
    const medianR2 = r2Values.length > 0
      ? r2Values[Math.floor(r2Values.length / 2)]
      : undefined;
    const rMarketValues = radiusResults.map(r => r.rMarket).filter(v => v > 0).sort((a, b) => a - b);

    const primaryDiag = radiusResults.find(r => r.diagnostics.competitorsAnalyzed > 0)?.diagnostics
      || radiusResults[0]?.diagnostics;

    return {
      marketAreaId: marketArea.id,
      marketAreaName: marketArea.name,
      state: marketArea.state,
      centerLat: marketArea.centerLat,
      centerLng: marketArea.centerLng,
      locationCount: marketArea.locations.length,
      clientCount: clientIds.size,
      r2Radius: medianR2 ? Math.round(medianR2 * 10) / 10 : undefined,
      rMarketRadius: rMarketValues.length > 0 ? Math.round(rMarketValues[Math.floor(rMarketValues.length / 2)] * 10) / 10 : undefined,
      radiusDiagnostics: primaryDiag ? {
        competitorsAnalyzed: primaryDiag.competitorsAnalyzed,
        r2Base: Math.round(primaryDiag.r2Base * 10) / 10,
        densityCore: primaryDiag.densityCore,
        popDensity3mi: primaryDiag.popDensity3mi != null ? Math.round(primaryDiag.popDensity3mi) : undefined,
        popFactor: primaryDiag.popFactor != null ? Math.round(primaryDiag.popFactor * 1000) / 1000 : undefined,
        isDense: primaryDiag.isDense,
        competitorsWithin20mi: primaryDiag.competitorsWithin20mi,
        rMarket: primaryDiag.rMarket,
      } : undefined,
      practices,
      locations: locationDetails,
      topExternalOverlaps: allTopOverlaps,
    } as MarketAreaSummary;
    }));

    for (const settled of batchSettled) {
      if (settled.status === "fulfilled" && settled.value) {
        results.push(settled.value);
      } else if (settled.status === "rejected") {
        console.error("[MCU Engine] Market area analysis failed:", settled.reason);
      }
    }

    if (results.length > 0) {
      onProgress?.({
        phase: 'Analyzing markets',
        current: completedPairs,
        total: totalMarketPracticePairs,
        detail: `${results.length} market areas ready`,
        partialResults: [...results],
      });
    }
  }

  return results.sort((a, b) => {
    const maxUsedA = Math.max(...a.practices.map(p => p.capacityUsedPercent), 0);
    const maxUsedB = Math.max(...b.practices.map(p => p.capacityUsedPercent), 0);
    return maxUsedB - maxUsedA;
  });
}
