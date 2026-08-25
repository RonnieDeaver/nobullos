export interface GeoLocation {
  lat: number;
  lng: number;
}

export interface GeocodeResult extends GeoLocation {
  formattedAddress: string;
  success: boolean;
  // When success is false, distinguishes an address the geocoder couldn't find
  // (operator should correct the address) from a provider/system fault such as
  // quota, denied key, or a network error (not the operator's input).
  failureReason?: "not_found" | "system";
}

export interface FipsResult {
  stateFips: string;
  countyFips: string;
  tractGeoid?: string;
  countyName?: string;
}

export interface CensusData {
  population: number;
  households: number;
  medianIncome: number;
  foreignBorn: number;
  nonCitizen: number;
  marriedMale: number;
  marriedFemale: number;
  divorcedMale: number;
  divorcedFemale: number;
  married: number;
  divorced: number;
}

export interface DemandScore {
  baseScore: number;
  trendsMultiplier: number;
  adjustedScore: number;
  practiceArea: string;
}

export interface CompetitorDensity {
  radiusMiles: number;
  competitorCount: number;
}

export interface RadiusResult {
  core: number;
  extended: number;
  fringe: number;
  competitorCounts: CompetitorDensity[];
}

export interface OverlapResult {
  overlapPercent: number;
  overlapDemand: number;
  clientLocationId?: string;
  clientId?: string;
  clientName?: string;
  address?: string;
}

export interface McuResult {
  address: string;
  location: GeoLocation | null;
  fips: FipsResult | null;
  demandScore: DemandScore | null;
  radius: RadiusResult | null;
  mcuTotal: number;
  mcuAllocated: number;
  mcuRemaining: number;
  overlapRisk: "low" | "medium" | "high";
  scarcityLabel: "normal" | "tight" | "limited";
  verdict: "approved" | "conditional" | "decline";
  overlaps?: OverlapResult[];
}

export interface EvaluationRequest {
  addresses: string[];
  practiceArea: string;
}

export interface SalesEvaluationResponse {
  results: Array<{
    address: string;
    capacityUsedPercent: number;
    status: CapacityStatus;
    statusColor: "green" | "yellow" | "orange" | "red";
    narrative: string;
    verdict: "approved" | "conditional" | "decline";
  }>;
}

export interface InternalEvaluationResult {
  address: string;
  verdict: "approved" | "conditional" | "decline";
  currentCapacityUsedPercent: number;
  projectedCapacityUsedPercent: number;
  currentStatus: CapacityStatus;
  projectedStatus: CapacityStatus;
  currentStatusColor: "green" | "yellow" | "orange" | "red";
  projectedStatusColor: "green" | "yellow" | "orange" | "red";
  deltaCapacityPercent: number;
  narrative: string;
  marketAreaName: string | null;
  existingClientCount: number;
  competitorsInZone: number;
  prospectR2: number | null;
  prospectR1: number | null;
  rMarket: number | null;
  mcuTotal: number;
  mcuAllocated: number;
  mcuRemaining: number;
  overlapRisk: OverlapRisk;
  scarcityLabel: "normal" | "tight" | "limited";
}

export interface InternalEvaluationResponse {
  results: InternalEvaluationResult[];
}

export type CapacityStatus = "Open" | "Filling" | "Tight" | "Saturated";
export type OverlapRisk = "Low" | "Moderate" | "High";

export interface PracticeSummary {
  practiceArea: string;
  capacityUsedPercent: number;
  status: CapacityStatus;
  statusColor: "green" | "yellow" | "orange" | "red";
  mcuTotal: number;
  mcuAllocated: number;
  mcuRemaining: number;
  overlapRisk: OverlapRisk;
  marketPopulation?: number;
  uniqueClients?: number;
  competitorsInZone?: number;
  rMarket?: number;
  totalOpportunity?: number;
  usedOpportunity?: number;
}

export interface RadiusDiagnostics {
  competitorsAnalyzed: number;
  r2Base: number;
  densityCore?: number;
  popDensity3mi?: number;
  popFactor?: number;
  isDense?: boolean;
  competitorsWithin20mi?: number;
  rMarket?: number;
}

export interface MarketAreaSummary {
  marketAreaId: string;
  marketAreaName: string;
  state: string;
  centerLat: number;
  centerLng: number;
  locationCount: number;
  clientCount: number;
  r2Radius?: number;
  rMarketRadius?: number;
  radiusDiagnostics?: RadiusDiagnostics;
  practices: PracticeSummary[];
  locations: Array<{
    locationId: string;
    clientId: string;
    clientName: string;
    address: string;
    city: string;
    practiceAreas: string[];
    mcuRemaining: number;
    overlapPercent: number;
  }>;
  topExternalOverlaps: Array<{
    clientId: string;
    clientName: string;
    address: string;
    overlapPercent: number;
  }>;
}

export type CapacityBand = "High" | "Moderate" | "Tight" | "Limited";

export interface LocationMcuSummary {
  locationId: string;
  clientId: string;
  clientName: string;
  address: string;
  city: string;
  state: string;
  practiceArea: string;
  lat: number;
  lng: number;
  radius: { core: number; extended: number; fringe: number };
  mcuTotal: number;
  mcuAllocated: number;
  mcuRemaining: number;
  saturationPercent: number;
  status: "green" | "yellow" | "red";
  scarcityLabel: "normal" | "tight" | "limited";
  maxOverlapPercent: number;
  overlappingLocations: Array<{
    locationId: string;
    clientId: string;
    clientName: string;
    overlapPercent: number;
  }>;
}

export interface MarketSummary {
  state: string;
  city: string;
  practiceArea: string;
  totalMcu: number;
  allocatedMcu: number;
  remainingMcu: number;
  saturationPercent: number;
  status: "green" | "yellow" | "red";
  clientCount: number;
  locationCount: number;
}

export interface ClusterSummary {
  clusterId: string;
  centerLat: number;
  centerLng: number;
  state: string;
  practiceArea: string;
  totalMcu: number;
  allocatedMcu: number;
  remainingMcu: number;
  saturationPercent: number;
  status: "green" | "yellow" | "red";
  clientLocations: Array<{
    id: string;
    clientId: string;
    clientName: string;
    address: string;
    mcuContribution: number;
  }>;
}
