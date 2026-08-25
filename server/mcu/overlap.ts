import * as h3 from "h3-js";
import { GeoLocation, OverlapResult, RadiusResult } from "./types";
import { haversineDistance } from "./geocoding";

const H3_RESOLUTION = 7;
const MILES_TO_KM = 1.60934;

const ZONE_WEIGHTS = {
  core: 1.0,
  extended: 0.35,
  fringe: 0.10,
};

export interface LocationFootprint {
  locationId: string;
  clientId?: string;
  clientName?: string;
  address?: string;
  location: GeoLocation;
  radius: RadiusResult;
  cells: Map<string, number>;
  r2Cells: Set<string>;
  totalWeightedDemand: number;
}

export function generateLocationFootprint(
  locationId: string,
  location: GeoLocation,
  radius: RadiusResult,
  demandPerCell: number = 1.0,
  clientId?: string,
  clientName?: string,
  address?: string
): LocationFootprint {
  const cells = new Map<string, number>();

  const coreKm = radius.core * MILES_TO_KM;
  const extendedKm = radius.extended * MILES_TO_KM;
  const fringeKm = radius.fringe * MILES_TO_KM;

  const coreCells = h3.gridDisk(
    h3.latLngToCell(location.lat, location.lng, H3_RESOLUTION),
    Math.ceil(coreKm / getH3EdgeLengthKm())
  );

  const extendedCells = h3.gridDisk(
    h3.latLngToCell(location.lat, location.lng, H3_RESOLUTION),
    Math.ceil(extendedKm / getH3EdgeLengthKm())
  );

  const fringeCells = h3.gridDisk(
    h3.latLngToCell(location.lat, location.lng, H3_RESOLUTION),
    Math.ceil(fringeKm / getH3EdgeLengthKm())
  );

  const coreSet = new Set(coreCells);
  const extendedSet = new Set(extendedCells);
  const r2Cells = new Set(extendedCells);

  for (const cell of fringeCells) {
    let weight: number;
    if (coreSet.has(cell)) {
      weight = ZONE_WEIGHTS.core;
    } else if (extendedSet.has(cell)) {
      weight = ZONE_WEIGHTS.extended;
    } else {
      weight = ZONE_WEIGHTS.fringe;
    }
    cells.set(cell, weight * demandPerCell);
  }

  let totalWeightedDemand = 0;
  cells.forEach((value) => {
    totalWeightedDemand += value;
  });

  return {
    locationId,
    clientId,
    clientName,
    address,
    location,
    radius,
    cells,
    r2Cells,
    totalWeightedDemand,
  };
}

export function calculateOverlap(
  prospectFootprint: LocationFootprint,
  existingFootprints: LocationFootprint[]
): OverlapResult[] {
  const overlaps: OverlapResult[] = [];

  for (const existing of existingFootprints) {
    let overlapDemand = 0;

    prospectFootprint.cells.forEach((prospectWeight, cell) => {
      if (existing.cells.has(cell)) {
        const existingWeight = existing.cells.get(cell)!;
        overlapDemand += Math.min(prospectWeight, existingWeight);
      }
    });

    if (overlapDemand > 0) {
      const overlapPercent = (overlapDemand / prospectFootprint.totalWeightedDemand) * 100;

      overlaps.push({
        overlapPercent,
        overlapDemand,
        clientLocationId: existing.locationId,
        clientId: existing.clientId,
        clientName: existing.clientName,
        address: existing.address,
      });
    }
  }

  return overlaps.sort((a, b) => b.overlapDemand - a.overlapDemand);
}

export function calculateTotalOverlap(overlaps: OverlapResult[]): {
  totalOverlapDemand: number;
  overlapRisk: "low" | "medium" | "high";
} {
  const totalOverlapDemand = overlaps.reduce((sum, o) => sum + o.overlapDemand, 0);
  const maxOverlapPercent = overlaps.length > 0 ? Math.max(...overlaps.map((o) => o.overlapPercent)) : 0;

  let overlapRisk: "low" | "medium" | "high";
  if (maxOverlapPercent < 20) {
    overlapRisk = "low";
  } else if (maxOverlapPercent < 50) {
    overlapRisk = "medium";
  } else {
    overlapRisk = "high";
  }

  return { totalOverlapDemand, overlapRisk };
}

function getH3EdgeLengthKm(): number {
  return 1.221;
}
