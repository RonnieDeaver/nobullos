// @db-pool-intent: ambient
//
// loadCensusTracts / getTractCount are invoked by the MCU worker
// (startMcuWorker → runComputation) and by admin maintenance routes.
// Route through `getDb()` so the pool tenant matches the caller's
// AsyncLocalStorage context (worker pool under `runWithWorkerDb`,
// api pool from request handlers).
import { getDb, withDbAttribution } from "../db";
import { censusTracts } from "@shared/schema";
import { fetchWithRetry } from "./fetchWithRetry";
import { sql, count } from "drizzle-orm";

const CENSUS_API_KEY = process.env.CENSUS_API_KEY;

const US_STATE_FIPS = [
  "01","02","04","05","06","08","09","10","11","12","13","15","16","17","18","19",
  "20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35",
  "36","37","38","39","40","41","42","44","45","46","47","48","49","50","51","53",
  "54","55","56"
];

interface TractEntry {
  geoid: string;
  stateFips: string;
  countyFips: string;
  tractCode: string;
  landAreaSqM: number;
  centroidLat: number;
  centroidLng: number;
  population: number;
}

const TIGERWEB_PAGE_SIZE = 2000;

async function fetchTractCentroidsForState(stateFips: string): Promise<TractEntry[]> {
  const entries: TractEntry[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const url = `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/6/query?where=STATE=%27${stateFips}%27&outFields=GEOID,CENTLAT,CENTLON,AREALAND&f=json&returnGeometry=false&resultRecordCount=${TIGERWEB_PAGE_SIZE}&resultOffset=${offset}`;

    try {
      const response = await fetchWithRetry(
        url,
        {},
        `TIGERweb tracts ${stateFips} offset=${offset}`,
        {
          service: "us_census",
          operation: "tigerweb_tracts",
          dedupeParams: { stateFips, offset },
        },
      );
      const data = await response.json();

      if (!data.features || data.features.length === 0) {
        hasMore = false;
        break;
      }

      for (const feature of data.features) {
        const attrs = feature.attributes;
        if (!attrs?.GEOID || !attrs?.CENTLAT || !attrs?.CENTLON) continue;

        const geoid = String(attrs.GEOID);
        if (geoid.length !== 11) continue;

        const lat = parseFloat(attrs.CENTLAT);
        const lng = parseFloat(attrs.CENTLON);
        if (isNaN(lat) || isNaN(lng)) continue;

        entries.push({
          geoid,
          stateFips: geoid.substring(0, 2),
          countyFips: geoid.substring(0, 5),
          tractCode: geoid.substring(5, 11),
          landAreaSqM: parseInt(attrs.AREALAND) || 0,
          centroidLat: lat,
          centroidLng: lng,
          population: 0,
        });
      }

      if (data.features.length < TIGERWEB_PAGE_SIZE) {
        hasMore = false;
      } else {
        offset += TIGERWEB_PAGE_SIZE;
      }
    } catch (e: any) {
      console.warn(`[TractLoader] TIGERweb failed for state ${stateFips} offset=${offset}: ${e?.message}`);
      hasMore = false;
    }
  }

  return entries;
}

async function fetchTractPopulations(stateFips: string): Promise<Map<string, number>> {
  const popMap = new Map<string, number>();
  let url = `https://api.census.gov/data/2022/acs/acs5?get=B01003_001E&for=tract:*&in=state:${stateFips}`;
  if (CENSUS_API_KEY) url += `&key=${CENSUS_API_KEY}`;

  try {
    const response = await fetchWithRetry(
      url,
      {},
      `Census pop state ${stateFips}`,
      {
        service: "us_census",
        operation: "acs5_tract_population",
        dedupeParams: { stateFips },
      },
    );
    const data = await response.json();
    if (!Array.isArray(data) || data.length < 2) return popMap;

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const pop = parseInt(row[0]) || 0;
      const state = row[1];
      const county = row[2];
      const tract = row[3];
      const geoid = `${state}${county}${tract}`;
      popMap.set(geoid, pop);
    }
  } catch (e: any) {
    console.warn(`[TractLoader] Census API failed for state ${stateFips}: ${e?.message}`);
  }

  return popMap;
}

export async function loadCensusTracts(forceReload = false): Promise<void> {
  const existing = await withDbAttribution("mcu_tract_loader:count_existing", async () => {
    const [result] = await getDb().select({ c: count() }).from(censusTracts);
    return result?.c || 0;
  });

  if (existing > 0 && !forceReload) {
    console.log(`[TractLoader] ${existing} census tracts already loaded, skipping.`);
    return;
  }

  console.log(`[TractLoader] Loading census tract data (existing: ${existing}, force: ${forceReload})...`);

  if (forceReload && existing > 0) {
    await withDbAttribution("mcu_tract_loader:clear", async () => {
      await getDb().delete(censusTracts);
    });
    console.log("[TractLoader] Cleared existing tract data for reload.");
  }

  const STATE_BATCH = 5;
  let totalInserted = 0;

  for (let si = 0; si < US_STATE_FIPS.length; si += STATE_BATCH) {
    const stateBatch = US_STATE_FIPS.slice(si, si + STATE_BATCH);
    console.log(`[TractLoader] Processing states ${si + 1}-${Math.min(si + STATE_BATCH, US_STATE_FIPS.length)} of ${US_STATE_FIPS.length}...`);

    const [centroidResults, popResults] = await Promise.all([
      Promise.all(stateBatch.map(s => fetchTractCentroidsForState(s))),
      Promise.all(stateBatch.map(s => fetchTractPopulations(s))),
    ]);

    for (let bi = 0; bi < stateBatch.length; bi++) {
      const entries = centroidResults[bi];
      const popMap = popResults[bi];

      if (entries.length === 0) continue;

      const rows = entries.map(e => ({
        geoid: e.geoid,
        stateFips: e.stateFips,
        countyFips: e.countyFips,
        tractCode: e.tractCode,
        population: popMap.get(e.geoid) || 0,
        landAreaSqM: e.landAreaSqM,
        centroidLat: e.centroidLat,
        centroidLng: e.centroidLng,
      }));

      const INSERT_BATCH = 500;
      await withDbAttribution("mcu_tract_loader:insert_batch", async () => {
        for (let i = 0; i < rows.length; i += INSERT_BATCH) {
          const batch = rows.slice(i, i + INSERT_BATCH);
          await getDb().insert(censusTracts).values(batch).onConflictDoUpdate({
            target: censusTracts.geoid,
            set: {
              population: sql`excluded.population`,
              landAreaSqM: sql`excluded.land_area_sq_m`,
              centroidLat: sql`excluded.centroid_lat`,
              centroidLng: sql`excluded.centroid_lng`,
            },
          });
        }
      });

      totalInserted += rows.length;
    }
  }

  console.log(`[TractLoader] Successfully loaded ${totalInserted} census tracts with population data.`);
}

export async function getTractCount(): Promise<number> {
  return withDbAttribution("mcu_tract_loader:get_count", async () => {
    const [result] = await getDb().select({ c: count() }).from(censusTracts);
    return result?.c || 0;
  });
}
