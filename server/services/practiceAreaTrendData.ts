/**
 * Task #4210 — Canonical deterministic practice-area seasonal-trend
 * computation, extracted verbatim from the POST /api/trends/practice-areas
 * handler in server/routes/settings.ts so there is exactly ONE path for this
 * responsibility. Consumers:
 *   1. POST /api/trends/practice-areas (authenticated) — adds an OpenAI
 *      analysis layer on top of this deterministic result.
 *   2. buildReportResponse (server/routes/reports.ts) — embeds the
 *      deterministic result (aiAnalysis: null) into report payloads so the
 *      capability-token public share route serves REAL seasonal data to
 *      anonymous viewers instead of the client-side hardcoded fallback.
 *      The AI analysis is deliberately NOT computed on that path: an
 *      unauthenticated share view must never trigger an OpenAI call
 *      (cost/abuse surface). The client renders its deterministic derived
 *      analysis text when aiAnalysis is absent — that is the explicit
 *      product decision for anonymous viewers.
 */
import { storage } from "../storage";
import { classifyPhases } from "../routes/helpers";
import { DEFAULT_SEARCH_TERMS } from "@shared/practiceAreas";

export interface TrendDataPoint {
  month: string;
  value: number;
  isCurrent: boolean;
  phase: string;
}

export interface PracticeAreaTrendResult {
  practiceArea: string;
  searchTerm: string;
  data: TrendDataPoint[];
}

export interface PracticeAreaTrendData {
  practiceAreas: PracticeAreaTrendResult[];
  combined: PracticeAreaTrendResult | null;
  currentMonth: string;
  currentMonthIndex: number;
}

// Practice area to search keyword mapping with 5-year average seasonal patterns
// Values represent Google Trends index (0-100) based on typical legal search patterns
export const practiceAreaTrends: Record<string, { searchTerm: string; monthlyData: number[] }> = {
  "Personal Injury": {
    searchTerm: "personal injury lawyer near me",
    monthlyData: [85, 90, 95, 100, 92, 88, 82, 78, 80, 85, 75, 70] // Peak in Spring (Apr)
  },
  "Car Accident": {
    searchTerm: "car accident lawyer",
    monthlyData: [88, 92, 95, 98, 100, 90, 85, 80, 82, 88, 78, 75] // Peak in May (summer travel)
  },
  "Divorce": {
    searchTerm: "divorce lawyer near me",
    monthlyData: [100, 92, 88, 82, 75, 70, 68, 78, 72, 65, 55, 52] // Peak in Jan (post-holiday)
  },
  "Family Law": {
    searchTerm: "family law attorney",
    monthlyData: [100, 95, 90, 85, 78, 72, 70, 75, 80, 72, 60, 55] // Peak in Jan
  },
  "Criminal Defense": {
    searchTerm: "criminal defense lawyer",
    monthlyData: [78, 82, 85, 88, 92, 95, 100, 98, 90, 85, 80, 75] // Peak in Summer (Jul)
  },
  "General Criminal Law": {
    searchTerm: "criminal lawyer near me",
    monthlyData: [80, 84, 87, 90, 94, 97, 100, 96, 88, 83, 78, 74] // Peak in Summer (Jul)
  },
  "DUI": {
    searchTerm: "DUI lawyer near me",
    monthlyData: [100, 85, 80, 78, 82, 88, 95, 92, 85, 80, 90, 98] // Peaks around holidays
  },
  "DUI/DWI": {
    searchTerm: "DUI DWI lawyer near me",
    monthlyData: [100, 85, 80, 78, 82, 88, 95, 92, 85, 80, 90, 98] // Peaks around holidays
  },
  "DWI": {
    searchTerm: "DWI lawyer near me",
    monthlyData: [100, 85, 80, 78, 82, 88, 95, 92, 85, 80, 90, 98] // Peaks around holidays
  },
  "Estate Planning": {
    searchTerm: "estate planning attorney",
    monthlyData: [95, 100, 98, 92, 88, 82, 75, 72, 78, 85, 80, 70] // Peak Feb-Mar (tax season)
  },
  "Bankruptcy": {
    searchTerm: "bankruptcy lawyer",
    monthlyData: [100, 95, 92, 90, 88, 85, 80, 78, 82, 85, 88, 75] // Peak Jan (post-holiday debt)
  },
  "Immigration": {
    searchTerm: "immigration lawyer",
    monthlyData: [85, 88, 92, 95, 98, 100, 95, 90, 92, 88, 82, 78] // Peak May-Jun
  },
  "Employment Law": {
    searchTerm: "employment lawyer",
    monthlyData: [100, 95, 90, 88, 85, 82, 78, 80, 92, 95, 88, 75] // Peak Jan, secondary Sep
  },
  "Medical Malpractice": {
    searchTerm: "medical malpractice lawyer",
    monthlyData: [88, 90, 95, 98, 100, 95, 88, 85, 90, 92, 85, 80] // Peak Apr-May
  },
  "Workers Compensation": {
    searchTerm: "workers comp lawyer",
    monthlyData: [85, 88, 92, 95, 100, 98, 92, 88, 90, 88, 82, 78] // Peak May
  },
  "Real Estate": {
    searchTerm: "real estate lawyer",
    monthlyData: [75, 80, 88, 95, 100, 98, 92, 90, 85, 82, 78, 70] // Peak May-Jun (buying season)
  },
  "Business Law": {
    searchTerm: "business attorney",
    monthlyData: [100, 95, 92, 88, 85, 82, 78, 80, 88, 92, 90, 75] // Peak Jan (new year planning)
  },
  "Truck Accident": {
    searchTerm: "truck accident lawyer",
    monthlyData: [82, 85, 90, 95, 100, 98, 92, 88, 85, 88, 80, 78] // Peak May
  },
  "Social Security Disability": {
    searchTerm: "disability lawyer",
    monthlyData: [100, 98, 95, 90, 85, 80, 78, 82, 88, 92, 88, 82] // Peak Jan-Feb
  },
};

/**
 * Deterministic per-practice-area seasonal-trend computation.
 * DB custom settings take precedence, then the hardcoded 5-year-average
 * patterns above, then a generic default pattern. Behavior is a verbatim
 * move of the pre-#4210 route logic — do not "improve" matching here
 * without checking both consumers.
 */
export async function computePracticeAreaTrendData(
  practiceAreas: string[],
): Promise<PracticeAreaTrendData> {
  const currentDate = new Date();
  const currentMonthIndex = currentDate.getMonth();
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const results: PracticeAreaTrendResult[] = [];

  // Default fallback trend pattern for unknown practice areas
  const defaultTrend = {
    searchTerm: "legal services near me",
    monthlyData: [90, 88, 85, 82, 80, 75, 72, 78, 82, 85, 80, 75]
  };

  // Get custom settings from database
  const dbSettings = await storage.getPracticeAreaSettings();
  // Normalize keys for consistent matching (lowercase, trimmed)
  const dbSettingsMap = new Map(dbSettings.map(s => [s.practiceArea.toLowerCase().trim(), s]));

  // Helper to validate monthly data array
  const isValidMonthlyData = (data: unknown): data is number[] => {
    return Array.isArray(data) && data.length === 12 && data.every(v => typeof v === 'number');
  };

  for (const area of practiceAreas) {
    // First check database for custom settings
    const lowerArea = area.toLowerCase().trim();
    const dbSetting = dbSettingsMap.get(lowerArea);

    if (dbSetting) {
      // Use database setting (custom search term, optionally custom monthly data)
      // Validate monthlyData before using
      let monthlyData: number[];
      if (isValidMonthlyData(dbSetting.monthlyData)) {
        monthlyData = dbSetting.monthlyData;
      } else {
        // Try to find matching hardcoded trend using exact match first, then partial/includes match
        let matchingKey = Object.keys(practiceAreaTrends).find(
          key => key.toLowerCase() === lowerArea
        );
        if (!matchingKey) {
          // Try partial matching (key includes area or area includes key)
          matchingKey = Object.keys(practiceAreaTrends).find(
            key => key.toLowerCase().includes(lowerArea) || lowerArea.includes(key.toLowerCase())
          );
        }
        monthlyData = matchingKey ? practiceAreaTrends[matchingKey].monthlyData : defaultTrend.monthlyData;
      }
      const phases = classifyPhases(monthlyData);
      const data = monthNames.map((month, index) => ({
        month,
        value: monthlyData[index],
        isCurrent: index === currentMonthIndex,
        phase: phases[index],
      }));
      results.push({
        practiceArea: area,
        searchTerm: dbSetting.searchTerm,
        data,
      });
      continue;
    }

    // No custom DB setting - use DEFAULT_SEARCH_TERMS from shared module
    // Try to find matching hardcoded trend for monthly data (seasonal patterns)
    let trendInfo = practiceAreaTrends[area];
    if (!trendInfo) {
      const matchingKey = Object.keys(practiceAreaTrends).find(
        key => key.toLowerCase() === lowerArea ||
               key.toLowerCase().includes(lowerArea) ||
               lowerArea.includes(key.toLowerCase())
      );
      if (matchingKey) {
        trendInfo = practiceAreaTrends[matchingKey];
      }
    }

    // Use matched trend for monthly data, but search term comes from shared defaults
    const monthlyData = trendInfo?.monthlyData || defaultTrend.monthlyData;
    const searchTerm = DEFAULT_SEARCH_TERMS[area] || `${area} lawyer near me`;

    const phases = classifyPhases(monthlyData);
    const data = monthNames.map((month, index) => ({
      month,
      value: monthlyData[index],
      isCurrent: index === currentMonthIndex,
      phase: phases[index],
    }));
    results.push({
      practiceArea: area,
      searchTerm,
      data,
    });
  }

  // Calculate combined/averaged trend if multiple practice areas
  let combined: PracticeAreaTrendResult | null = null;
  if (results.length > 1) {
    const avgData = monthNames.map((_month, index) => {
      const sum = results.reduce((acc, r) => acc + r.data[index].value, 0);
      return Math.round(sum / results.length);
    });

    // Classify the combined average values directly for consistent visual presentation
    // This ensures phase colors match the displayed bar heights
    const combinedPhases = classifyPhases(avgData);

    combined = {
      practiceArea: "Combined Average",
      searchTerm: `${results.length} practice areas combined`,
      data: monthNames.map((month, index) => ({
        month,
        value: avgData[index],
        isCurrent: index === currentMonthIndex,
        phase: combinedPhases[index],
      })),
    };
  }

  return {
    practiceAreas: results,
    combined,
    currentMonth: monthNames[currentMonthIndex],
    currentMonthIndex,
  };
}
