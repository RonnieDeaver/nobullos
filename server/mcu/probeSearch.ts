import { GeoLocation } from "./types";
import { getCached, setCache } from "./cache";
import { fetchWithRetry } from "./fetchWithRetry";
import { haversineDistance } from "./geocoding";
import { getPopulationWithinRadiusDetailed } from "./h3pop";

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

const CANONICAL_QUERIES: Record<string, string> = {
  "Family Law": "family law attorney",
  "DUI/DWI": "dui lawyer",
  "Criminal Defense": "criminal defense attorney",
  "Immigration": "immigration lawyer",
  "Personal Injury": "personal injury attorney",
  "Estate Planning": "estate planning attorney",
  "Bankruptcy": "bankruptcy attorney",
  "Business Law": "business attorney",
  "Employment Law": "employment lawyer",
  "Real Estate": "real estate attorney",
  "Medical Malpractice": "medical malpractice attorney",
};
const DEFAULT_QUERY = "lawyer";

export const ALGO_VERSION = "gbp-lite-v5";

const FALLBACK_QUERIES: Record<string, string> = {
  "Family Law": "divorce lawyer",
  "Personal Injury": "car accident lawyer",
  "Criminal Defense": "criminal defense lawyer",
  "DUI/DWI": "dui lawyer",
};

const COMMON_PRACTICES = new Set(Object.keys(FALLBACK_QUERIES));

export type DensitySource = "dens1" | "dens2" | "dens3" | "tail" | "floor" | "merged_fallback";

export interface CompetitorLocation {
  placeId: string;
  lat: number;
  lng: number;
  name: string;
  distanceMiles: number;
}

export interface ProbeSearchResult {
  competitors: CompetitorLocation[];
  totalFound: number;
  probeCentersUsed: number;
  practiceArea: string;
}

export interface GbpRangeLiteResult {
  r2: number;
  r1: number;
  rMarket: number;
  competitorsInR2: number;
  nearestCompetitors: CompetitorLocation[];
  n: number;
  k: number;
  rK: number;
  gapDetected: boolean;
  densityCore: number;
  popDensity3mi: number;
  popFactor: number;
  r2Base: number;
  r2Candidate: number;
  totalApiCalls: number;
  algoVersion: string;
  c1: number;
  c2: number;
  c3: number;
  densitySource: DensitySource;
  fallbackUsed: boolean;
  popCellsFound: number;
}

export type ProbeProgressCallback = (info: { apiCallsDone: number; totalExpected: number; uniqueFound: number }) => void;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function nearbySearchByDistance(
  origin: GeoLocation,
  keyword: string,
  label: string
): Promise<{ results: CompetitorLocation[]; apiCalls: number }> {
  if (!GOOGLE_MAPS_API_KEY) return { results: [], apiCalls: 0 };

  try {
    const url = new URL("https://maps.googleapis.com/maps/api/place/nearbysearch/json");
    url.searchParams.set("location", `${origin.lat},${origin.lng}`);
    url.searchParams.set("rankby", "distance");
    url.searchParams.set("keyword", keyword);
    url.searchParams.set("type", "lawyer");
    url.searchParams.set("key", GOOGLE_MAPS_API_KEY);

    const response = await fetchWithRetry(url.toString(), {}, label, {
      service: "google_maps",
      operation: "places_nearby_rankby_distance",
      dedupeParams: {
        latlng: `${origin.lat.toFixed(4)},${origin.lng.toFixed(4)}`,
        keyword,
        type: "lawyer",
      },
    });
    const data = await response.json();

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      if (data.status === "REQUEST_DENIED" || data.status === "INVALID_REQUEST") {
        console.warn(`[GBP-Lite] ${label}: ${data.status} - ${data.error_message || ""}`);
      }
      return { results: [], apiCalls: 1 };
    }

    const results: CompetitorLocation[] = [];
    for (const place of data.results || []) {
      const dist = haversineDistance(origin.lat, origin.lng, place.geometry.location.lat, place.geometry.location.lng);
      results.push({
        placeId: place.place_id,
        lat: place.geometry.location.lat,
        lng: place.geometry.location.lng,
        name: place.name || "",
        distanceMiles: dist,
      });
    }

    results.sort((a, b) => a.distanceMiles - b.distanceMiles);

    return { results, apiCalls: 1 };
  } catch (error) {
    console.error(`[GBP-Lite] ${label} error:`, error);
    return { results: [], apiCalls: 1 };
  }
}

export async function fetchNextPage(
  origin: GeoLocation,
  pageToken: string,
  label: string
): Promise<{ results: CompetitorLocation[]; count: number; apiCalls: number; hasNextPage: boolean }> {
  if (!GOOGLE_MAPS_API_KEY) return { results: [], count: 0, apiCalls: 0, hasNextPage: false };

  const RETRY_DELAYS = [2000, 2500, 3000, 4000, 5000];
  let totalApiCalls = 0;

  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt]));

    try {
      const pageUrl = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
      pageUrl.searchParams.set("pagetoken", pageToken);
      pageUrl.searchParams.set("key", GOOGLE_MAPS_API_KEY);

      const pageResponse = await fetchWithRetry(
        pageUrl.toString(),
        {},
        `${label} attempt${attempt + 1}`,
        {
          service: "google_maps",
          operation: "places_textsearch_page",
          dedupeParams: {
            latlng: `${origin.lat.toFixed(4)},${origin.lng.toFixed(4)}`,
            attempt: attempt + 1,
          },
        },
      );
      const pageData = await pageResponse.json();
      totalApiCalls++;

      if (pageData.status === "INVALID_REQUEST") {
        console.warn(`[GBP-Lite] ${label}: Token not ready yet (attempt ${attempt + 1}/${RETRY_DELAYS.length}), retrying...`);
        continue;
      }

      if (pageData.status !== "OK") {
        console.warn(`[GBP-Lite] ${label}: ${pageData.status} - ${pageData.error_message || ""}`);
        return { results: [], count: 0, apiCalls: totalApiCalls, hasNextPage: false };
      }

      const results: CompetitorLocation[] = [];
      for (const place of pageData.results || []) {
        const dist = haversineDistance(origin.lat, origin.lng, place.geometry.location.lat, place.geometry.location.lng);
        results.push({
          placeId: place.place_id,
          lat: place.geometry.location.lat,
          lng: place.geometry.location.lng,
          name: place.name || "",
          distanceMiles: dist,
        });
      }
      return { results, count: results.length, apiCalls: totalApiCalls, hasNextPage: !!pageData.next_page_token };
    } catch (error) {
      console.error(`[GBP-Lite] ${label} attempt ${attempt + 1} error:`, error);
      totalApiCalls++;
    }
  }

  console.error(`[GBP-Lite] ${label}: All ${RETRY_DELAYS.length} token retry attempts exhausted`);
  return { results: [], count: 0, apiCalls: totalApiCalls, hasNextPage: false };
}

function computeLocalCounts(distances: number[]): { c1: number; c2: number; c3: number } {
  let c1 = 0, c2 = 0, c3 = 0;
  for (const dist of distances) {
    if (dist <= 1) c1++;
    if (dist <= 2) c2++;
    if (dist <= 3) c3++;
  }
  return { c1, c2, c3 };
}

function computeDensityFromDistances(
  distances: number[],
  k: number,
  rK: number,
): { densityCore: number; densitySource: DensitySource } {
  if (k === 0) {
    return { densityCore: 0.03, densitySource: "floor" };
  }

  const { c1, c2, c3 } = computeLocalCounts(distances);
  const dens1 = c1 / (Math.PI * 1 * 1);
  const dens2 = c2 / (Math.PI * 2 * 2);
  const dens3 = c3 / (Math.PI * 3 * 3);
  const tailDensity = k / (Math.PI * rK * rK);

  let densityCore = 0.03;
  let densitySource: DensitySource = "floor";

  if (dens1 >= densityCore && dens1 >= dens2 && dens1 >= dens3 && dens1 >= tailDensity) {
    densityCore = dens1; densitySource = "dens1";
  } else if (dens2 >= densityCore && dens2 >= dens3 && dens2 >= tailDensity) {
    densityCore = dens2; densitySource = "dens2";
  } else if (dens3 >= densityCore && dens3 >= tailDensity) {
    densityCore = dens3; densitySource = "dens3";
  } else if (tailDensity >= densityCore) {
    densityCore = tailDensity; densitySource = "tail";
  }

  return { densityCore, densitySource };
}

export async function runGbpRangeLite(
  origin: GeoLocation,
  practiceArea: string,
  onProgress?: ProbeProgressCallback
): Promise<GbpRangeLiteResult> {
  const cacheKey = `${ALGO_VERSION}:${origin.lat.toFixed(4)},${origin.lng.toFixed(4)}:${practiceArea}`;
  const cached = await getCached<GbpRangeLiteResult>("gbp_range_lite", cacheKey);
  if (cached) {
    console.log(`[GBP-Lite] Cache hit for ${practiceArea} at ${origin.lat.toFixed(4)},${origin.lng.toFixed(4)}`);
    return cached;
  }

  const query = CANONICAL_QUERIES[practiceArea] || DEFAULT_QUERY;
  console.log(`[GBP-Lite] Starting NearbySearch(rankby=distance) for ${practiceArea} at ${origin.lat.toFixed(4)},${origin.lng.toFixed(4)} keyword="${query}"`);

  const label = `GBP-Lite nearby "${query}"`;
  const { results: primaryResults, apiCalls } = await nearbySearchByDistance(origin, query, label);
  let totalApiCalls = apiCalls;
  let competitors = primaryResults;
  let fallbackUsed = false;

  onProgress?.({ apiCallsDone: totalApiCalls, totalExpected: 1, uniqueFound: competitors.length });

  const { totalPop: pop3, cellsWithPop: popCellsFound } = await getPopulationWithinRadiusDetailed(origin.lat, origin.lng, 3);
  const popDensity3mi = pop3 / (Math.PI * 3 * 3);

  const primaryC3 = competitors.filter(c => c.distanceMiles <= 3).length;
  if (COMMON_PRACTICES.has(practiceArea) && popDensity3mi >= 1200 && primaryC3 <= 2) {
    const fallbackKeyword = FALLBACK_QUERIES[practiceArea];
    if (fallbackKeyword) {
      console.log(`[GBP-Lite] Anomaly detected: ${practiceArea} in dense area (popDensity3mi=${Math.round(popDensity3mi)}) but only ${primaryC3} competitors within 3mi. Running fallback query keyword="${fallbackKeyword}"`);
      const fallbackLabel = `GBP-Lite fallback "${fallbackKeyword}"`;
      const { results: fallbackResults, apiCalls: fbCalls } = await nearbySearchByDistance(origin, fallbackKeyword, fallbackLabel);
      totalApiCalls += fbCalls;
      fallbackUsed = true;

      const seenPlaceIds = new Set(competitors.map(c => c.placeId));
      for (const fb of fallbackResults) {
        if (!seenPlaceIds.has(fb.placeId)) {
          competitors.push(fb);
          seenPlaceIds.add(fb.placeId);
        }
      }
      competitors.sort((a, b) => a.distanceMiles - b.distanceMiles);
      console.log(`[GBP-Lite] After merge: ${competitors.length} unique competitors (primary=${primaryResults.length}, fallback added=${competitors.length - primaryResults.length})`);
    }
  }

  const n = competitors.length;
  const d = competitors.map(c => c.distanceMiles);

  let k: number;
  let rK: number;
  let gapDetected = false;

  if (n === 0) {
    k = 0;
    rK = 0;
  } else if (n < 12) {
    k = n;
    rK = d[n - 1];
  } else if (n >= 20) {
    const d15 = d[14];
    const d20 = d[19];
    if (d20 >= 20 && d15 > 0 && (d20 / d15) >= 1.8) {
      k = 15;
      rK = d15;
      gapDetected = true;
      console.log(`[GBP-Lite] Metro gap detected: d15=${d15.toFixed(1)}mi, d20=${d20.toFixed(1)}mi (ratio=${(d20/d15).toFixed(2)}). Using k=15.`);
    } else {
      k = 20;
      rK = d[19];
    }
  } else {
    k = n;
    rK = d[n - 1];
  }

  let { densityCore, densitySource } = computeDensityFromDistances(d, k, rK);
  if (fallbackUsed) {
    densitySource = "merged_fallback";
  }
  const { c1, c2, c3 } = computeLocalCounts(d);

  console.log(`[GBP-Lite] Core-radius density: c1=${c1}, c2=${c2}, c3=${c3}, densityCore=${densityCore.toFixed(4)}, source=${densitySource}, fallback=${fallbackUsed}`);

  let r2Base = 12 / Math.pow(densityCore, 0.35);
  r2Base = clamp(r2Base, 3, 25);

  const popFactor = popCellsFound === 0
    ? 1.0
    : clamp(Math.pow(2500 / Math.max(popDensity3mi, 1), 0.22), 0.5, 2.0);

  let r2Candidate = r2Base * popFactor;
  r2Candidate = clamp(r2Candidate, 3, 50);

  const r2 = r2Candidate;
  const r1 = clamp(0.35 * r2, 1.5, 4.0);

  const competitorsInR2 = competitors.filter(c => c.distanceMiles <= r2).length;

  const { calculateRMarket } = await import("./radius");
  const rMarket = await calculateRMarket({ lat: origin.lat, lng: origin.lng }, r2);

  console.log(`[GBP-Lite] n=${n}, k=${k}, r_k=${rK.toFixed(2)}mi, gap=${gapDetected}, densityCore=${densityCore.toFixed(4)}, src=${densitySource}, r2Base=${r2Base.toFixed(1)}, popFactor=${popFactor.toFixed(3)}, popCells=${popCellsFound}, R2=${r2.toFixed(1)}mi, R1=${r1.toFixed(1)}mi, R_market=${rMarket.toFixed(0)}mi, compInR2=${competitorsInR2}, apiCalls=${totalApiCalls}, fallback=${fallbackUsed}`);

  const result: GbpRangeLiteResult = {
    r2,
    r1,
    rMarket,
    competitorsInR2,
    nearestCompetitors: competitors,
    n,
    k,
    rK,
    gapDetected,
    densityCore,
    popDensity3mi,
    popFactor,
    r2Base,
    r2Candidate,
    totalApiCalls,
    algoVersion: ALGO_VERSION,
    c1,
    c2,
    c3,
    densitySource,
    fallbackUsed,
    popCellsFound,
  };

  await setCache("gbp_range_lite", cacheKey, result);

  return result;
}

export async function runProbeSearch(
  origin: GeoLocation,
  practiceArea: string,
  onProgress?: ProbeProgressCallback
): Promise<ProbeSearchResult> {
  const gbpResult = await runGbpRangeLite(origin, practiceArea, onProgress);

  return {
    competitors: gbpResult.nearestCompetitors,
    totalFound: gbpResult.competitorsInR2,
    probeCentersUsed: 1,
    practiceArea,
  };
}

export function computePercentile(distances: number[], percentile: number): number {
  if (distances.length === 0) return 6;
  const sorted = [...distances].sort((a, b) => a - b);
  const idx = Math.floor((percentile / 100) * (sorted.length - 1));
  return sorted[idx];
}

export function computePercentileR2(result: ProbeSearchResult): {
  r2Base: number;
  percentileUsed: number;
  percentileDistance: number;
} {
  const N = result.totalFound;
  const distances = result.competitors.map((c) => c.distanceMiles);

  let percentile: number;
  if (N >= 200) {
    percentile = 80;
  } else if (N >= 100) {
    percentile = 85;
  } else {
    percentile = 90;
  }

  const percentileDistance = computePercentile(distances, percentile);

  return {
    r2Base: percentileDistance,
    percentileUsed: percentile,
    percentileDistance,
  };
}
