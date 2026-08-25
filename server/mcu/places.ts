import { CompetitorDensity, GeoLocation } from "./types";
import { getCached, setCache } from "./cache";
import { fetchWithRetry } from "./fetchWithRetry";

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

const SEARCH_RADII_MILES = [0.5, 1, 1.5, 2, 3, 4, 5, 7, 10, 15, 20, 30];
const MILES_TO_METERS = 1609.34;

export async function getCompetitorDensity(location: GeoLocation): Promise<CompetitorDensity[]> {
  const cacheKey = `v2:${location.lat.toFixed(4)},${location.lng.toFixed(4)}`;
  const cached = await getCached<CompetitorDensity[]>("places", cacheKey);
  if (cached) {
    return cached;
  }

  if (!GOOGLE_MAPS_API_KEY) {
    return getDefaultDensity();
  }

  try {
    const results: CompetitorDensity[] = [];

    for (const radiusMiles of SEARCH_RADII_MILES) {
      const radiusMeters = Math.round(radiusMiles * MILES_TO_METERS);
      const count = await searchNearbyLawyers(location, radiusMeters);
      results.push({ radiusMiles, competitorCount: count });
    }

    await setCache("places", cacheKey, results);
    return results;
  } catch (error) {
    console.error("Places API error:", error);
    return getDefaultDensity();
  }
}

async function searchNearbyLawyers(location: GeoLocation, radiusMeters: number): Promise<number> {
  try {
    const url = new URL("https://maps.googleapis.com/maps/api/place/nearbysearch/json");
    url.searchParams.set("location", `${location.lat},${location.lng}`);
    url.searchParams.set("radius", radiusMeters.toString());
    url.searchParams.set("type", "lawyer");
    url.searchParams.set("key", GOOGLE_MAPS_API_KEY!);

    const label = `Places ${location.lat.toFixed(4)},${location.lng.toFixed(4)} r=${radiusMeters}`;
    const response = await fetchWithRetry(url.toString(), {}, label, {
      service: "google_maps",
      operation: "places_nearby",
      dedupeParams: {
        latlng: `${location.lat.toFixed(4)},${location.lng.toFixed(4)}`,
        radiusMeters,
        type: "lawyer",
      },
    });
    const data = await response.json();

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      console.warn("Places API status:", data.status);
      return 0;
    }

    let totalCount = data.results?.length || 0;
    let nextPageToken = data.next_page_token;
    let page = 1;

    while (nextPageToken && page < 3) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      page++;

      const pageUrl = new URL("https://maps.googleapis.com/maps/api/place/nearbysearch/json");
      pageUrl.searchParams.set("pagetoken", nextPageToken);
      pageUrl.searchParams.set("key", GOOGLE_MAPS_API_KEY!);

      const pageResponse = await fetchWithRetry(
        pageUrl.toString(),
        {},
        `${label} page${page}`,
        {
          service: "google_maps",
          operation: "places_nearby_page",
          dedupeParams: {
            latlng: `${location.lat.toFixed(4)},${location.lng.toFixed(4)}`,
            radiusMeters,
            page,
          },
        },
      );
      const pageData = await pageResponse.json();

      if (pageData.status === "OK") {
        totalCount += pageData.results?.length || 0;
        nextPageToken = pageData.next_page_token;
      } else {
        break;
      }
    }

    return totalCount;
  } catch (error) {
    console.error("Places search error:", error);
    return 0;
  }
}

function getDefaultDensity(): CompetitorDensity[] {
  return SEARCH_RADII_MILES.map((radiusMiles) => {
    const estimatedCount = Math.floor(radiusMiles * radiusMiles * 0.5);
    return { radiusMiles, competitorCount: estimatedCount };
  });
}
