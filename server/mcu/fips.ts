import { FipsResult, GeoLocation } from "./types";
import { getCached, setCache } from "./cache";
import { fetchWithRetry } from "./fetchWithRetry";

export async function getFipsForLocation(location: GeoLocation): Promise<FipsResult | null> {
  const cacheKey = `${location.lat.toFixed(6)},${location.lng.toFixed(6)}`;
  const cached = await getCached<FipsResult>("fips", cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const url = new URL("https://geo.fcc.gov/api/census/block/find");
    url.searchParams.set("latitude", location.lat.toString());
    url.searchParams.set("longitude", location.lng.toString());
    url.searchParams.set("format", "json");
    url.searchParams.set("showall", "false");

    const response = await fetchWithRetry(
      url.toString(),
      {},
      `FIPS ${cacheKey}`,
      {
        service: "fcc_census",
        operation: "block_find",
        dedupeParams: { latlng: cacheKey },
      },
    );
    const data = await response.json();

    if (data.status === "OK" && data.County) {
      const blockFips = data.Block?.FIPS || "";
      const tractGeoid = blockFips.substring(0, 11);

      const result: FipsResult = {
        stateFips: data.State?.FIPS || "",
        countyFips: data.County?.FIPS || "",
        tractGeoid: tractGeoid || undefined,
        countyName: data.County?.name || "",
      };
      await setCache("fips", cacheKey, result);
      return result;
    }

    console.warn("FCC FIPS lookup failed:", data);
    return null;
  } catch (error) {
    console.error("FIPS lookup error:", error);
    return null;
  }
}
