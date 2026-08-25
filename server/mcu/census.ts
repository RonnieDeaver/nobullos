import { CensusData, DemandScore, FipsResult } from "./types";
import { getCached, setCache } from "./cache";
import { fetchWithRetry } from "./fetchWithRetry";

const CENSUS_API_KEY = process.env.CENSUS_API_KEY;

const MCU_SIZE = 100000.0;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const PRACTICE_DEMAND_FORMULAS: Record<string, (data: CensusData) => number> = {
  "Immigration": (data) => {
    const intensity = (data.foreignBorn + data.nonCitizen) / Math.max(data.population, 1);
    return data.population * (1 + 2.5 * intensity);
  },
  "Family Law": (data) => {
    const divorceRate = data.divorced / Math.max(data.population, 1);
    return data.population * (1 + 3.0 * divorceRate) + data.households * 0.2;
  },
  "Personal Injury": (data) => {
    const incomeFactor = clamp(data.medianIncome / 65000, 0.8, 1.3);
    return data.population * incomeFactor;
  },
  "Criminal Defense": (data) => {
    return data.population * 1.0;
  },
  "DUI/DWI": (data) => {
    return data.population * 1.0;
  },
  "Estate Planning": (data) => {
    const incomeFactor = clamp(data.medianIncome / 75000, 0.8, 1.5);
    return data.population * incomeFactor;
  },
  "Business Law": (data) => {
    const incomeFactor = clamp(data.medianIncome / 60000, 0.8, 1.4);
    return data.population * incomeFactor;
  },
  "Employment Law": (data) => {
    return data.population * 0.9;
  },
  "Bankruptcy": (data) => {
    const incomeInverse = clamp(2.0 - data.medianIncome / 50000, 0.5, 1.5);
    return data.population * incomeInverse;
  },
  "Real Estate": (data) => {
    const incomeFactor = clamp(data.medianIncome / 60000, 0.8, 1.4);
    return data.households * incomeFactor;
  },
  "Medical Malpractice": (data) => {
    const incomeFactor = clamp(data.medianIncome / 50000, 0.8, 1.3);
    return data.population * incomeFactor;
  },
};

export async function getCensusData(fips: FipsResult): Promise<CensusData | null> {
  const tractGeoid = fips.tractGeoid;
  const cacheKey = tractGeoid 
    ? `tract-${tractGeoid}` 
    : `county-${fips.stateFips}-${fips.countyFips}`;
  
  const cached = await getCached<CensusData>("census", cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const variables = [
      "B01003_001E",
      "B11001_001E",
      "B19013_001E",
      "B05002_013E",
      "B05001_006E",
      "B12001_004E",
      "B12001_013E",
      "B12001_009E",
      "B12001_018E",
    ].join(",");

    let url: string;
    
    if (tractGeoid && tractGeoid.length === 11) {
      const tract = tractGeoid.substring(5, 11);
      const county = tractGeoid.substring(2, 5);
      const state = tractGeoid.substring(0, 2);
      url = `https://api.census.gov/data/2022/acs/acs5?get=${variables}&for=tract:${tract}&in=state:${state}%20county:${county}`;
    } else {
      const countyCode = (fips.countyFips || "").slice(2);
      url = `https://api.census.gov/data/2022/acs/acs5?get=${variables}&for=county:${countyCode}&in=state:${fips.stateFips}`;
    }
    
    if (CENSUS_API_KEY) {
      url += `&key=${CENSUS_API_KEY}`;
    }

    const response = await fetchWithRetry(
      url,
      {},
      `Census ${cacheKey}`,
      {
        service: "us_census",
        operation: "acs5_demographics",
        dedupeParams: { cacheKey },
      },
    );
    const data = await response.json();

    if (Array.isArray(data) && data.length >= 2) {
      const values = data[1];
      const marriedMale = parseInt(values[5]) || 0;
      const marriedFemale = parseInt(values[6]) || 0;
      const divorcedMale = parseInt(values[7]) || 0;
      const divorcedFemale = parseInt(values[8]) || 0;
      
      const result: CensusData = {
        population: parseInt(values[0]) || 0,
        households: parseInt(values[1]) || 0,
        medianIncome: parseInt(values[2]) || 0,
        foreignBorn: parseInt(values[3]) || 0,
        nonCitizen: parseInt(values[4]) || 0,
        marriedMale,
        marriedFemale,
        divorcedMale,
        divorcedFemale,
        married: marriedMale + marriedFemale,
        divorced: divorcedMale + divorcedFemale,
      };
      await setCache("census", cacheKey, result);
      return result;
    }

    console.warn("Census API returned unexpected format:", data);
    return null;
  } catch (error) {
    console.error("Census API error:", error);
    return null;
  }
}

export function calculateDemandValue(censusData: CensusData, practiceArea: string): number {
  const calculator = PRACTICE_DEMAND_FORMULAS[practiceArea] || PRACTICE_DEMAND_FORMULAS["Personal Injury"];
  return calculator(censusData);
}

export function calculateDemandScore(
  censusData: CensusData,
  practiceArea: string,
  trendsMultiplier: number = 1.0
): DemandScore {
  const baseScore = calculateDemandValue(censusData, practiceArea);
  const clampedTrends = Math.max(0.5, Math.min(1.5, trendsMultiplier));

  return {
    baseScore,
    trendsMultiplier: clampedTrends,
    adjustedScore: baseScore * clampedTrends,
    practiceArea,
  };
}

export function demandToMcu(demandValue: number): number {
  return demandValue / MCU_SIZE;
}
