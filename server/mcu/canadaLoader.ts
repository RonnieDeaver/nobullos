// @db-pool-intent: ambient
//
// seedCanadaH3Population / isCanadaH3Seeded are invoked by the MCU
// worker (startMcuWorker) and by admin maintenance routes. Route
// through `getDb()` so the pool tenant matches the caller's
// AsyncLocalStorage context (worker pool under `runWithWorkerDb`,
// api pool from request handlers).
import { getDb, withDbAttribution } from "../db";
import { h3Population } from "@shared/schema";
import * as h3 from "h3-js";
import { sql } from "drizzle-orm";
import { fetchWithRetry } from "./fetchWithRetry";
import { invalidateH3Cache } from "./h3pop";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { execSync } from "child_process";

const GAF_URL = "https://www12.statcan.gc.ca/census-recensement/2021/geo/aip-pia/attribute-attribs/files-fichiers/2021_92-151_X.zip";
const GAF_CSV_NAME = "2021_92-151_X.csv";
const TMP_ZIP = "/tmp/canada_gaf.zip";
const TMP_CSV = `/tmp/${GAF_CSV_NAME}`;

interface DARecord {
  dauid: string;
  lat: number;
  lng: number;
  pop: number;
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let inQuote = false;
  let current = "";
  for (const ch of line) {
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === "," && !inQuote) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

async function downloadAndParseGAF(): Promise<DARecord[]> {
  console.log("[CanadaLoader] Downloading Statistics Canada GAF...");
  const response = await fetchWithRetry(GAF_URL, {}, "StatCan GAF ZIP", {
    service: "statcan",
    operation: "gaf_zip_download",
    dedupeParams: { url: GAF_URL },
  });
  if (!response.ok) {
    throw new Error(`Failed to download GAF: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  console.log(`[CanadaLoader] Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)}MB ZIP`);

  writeFileSync(TMP_ZIP, buffer);
  try {
    execSync(`unzip -o "${TMP_ZIP}" "${GAF_CSV_NAME}" -d /tmp`, { stdio: "pipe" });
  } catch (e: any) {
    throw new Error(`Failed to extract GAF CSV: ${e?.message}`);
  }

  if (!existsSync(TMP_CSV)) {
    throw new Error(`Extracted CSV not found at ${TMP_CSV}`);
  }

  const csvText = readFileSync(TMP_CSV, "utf-8");
  const lines = csvText.split("\n");
  console.log(`[CanadaLoader] Parsing ${lines.length} rows...`);

  const daMap = new Map<string, DARecord>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCSVLine(line);
    const dauid = fields[47];
    const lat = parseFloat(fields[51]);
    const lng = parseFloat(fields[52]);
    const pop = parseInt(fields[55]) || 0;

    if (!dauid || isNaN(lat) || lat === 0) continue;

    const existing = daMap.get(dauid);
    if (existing) {
      existing.pop += pop;
    } else {
      daMap.set(dauid, { dauid, lat, lng, pop });
    }

    if (i % 100000 === 0) {
      console.log(`[CanadaLoader] Parsed ${i}/${lines.length} rows...`);
    }
  }

  try { unlinkSync(TMP_ZIP); } catch {}
  try { unlinkSync(TMP_CSV); } catch {}

  console.log(`[CanadaLoader] Aggregated ${daMap.size} dissemination areas`);
  return Array.from(daMap.values());
}

const TORONTO_SENTINEL_CELL = h3.latLngToCell(43.65, -79.38, 8);

export async function isCanadaH3Seeded(): Promise<boolean> {
  return withDbAttribution("mcu_canada_loader:is_seeded", async () => {
    const rows = await getDb()
      .select({ population: h3Population.population })
      .from(h3Population)
      .where(sql`${h3Population.h3Index} = ${TORONTO_SENTINEL_CELL}`)
      .limit(1);
    return rows.length > 0 && (rows[0].population ?? 0) > 0;
  });
}

export async function seedCanadaH3Population(): Promise<number> {
  const alreadySeeded = await isCanadaH3Seeded();
  if (alreadySeeded) {
    console.log("[CanadaLoader] Canadian H3 population already seeded, skipping.");
    return 0;
  }

  const daRecords = await downloadAndParseGAF();

  let totalPop = 0;
  const cellPop = new Map<string, number>();

  for (const da of daRecords) {
    if (da.pop <= 0) continue;
    const cell = h3.latLngToCell(da.lat, da.lng, 8);
    cellPop.set(cell, (cellPop.get(cell) || 0) + da.pop);
    totalPop += da.pop;
  }

  console.log(`[CanadaLoader] Mapped to ${cellPop.size} H3 cells (total pop: ${totalPop.toLocaleString()})`);

  const entries = Array.from(cellPop.entries());
  const BATCH_SIZE = 1000;

  await withDbAttribution("mcu_canada_loader:seed_insert", async () => {
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE).map(([idx, pop]) => ({
        h3Index: idx,
        population: pop,
      }));

      await getDb().insert(h3Population).values(batch).onConflictDoUpdate({
        target: h3Population.h3Index,
        set: { population: sql`excluded.population` },
      });
    }
  });

  console.log(`[CanadaLoader] Seeded ${cellPop.size} Canadian H3 cells into h3_population`);
  invalidateH3Cache();
  return cellPop.size;
}
