import { createHash } from "node:crypto";
import { GeocodeResult } from "./types";
import { getCached, setCache } from "./cache";
import { fetchWithRetry } from "./fetchWithRetry";

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Logs/labels must never carry raw user-supplied addresses. Hash to a short
// stable ID so retry/timeout logs are still correlatable but contain no PII.
function addressLabelHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 10);
}

export async function geocodeAddress(address: string): Promise<GeocodeResult> {
  const cacheKey = address.toLowerCase().trim();
  const cached = await getCached<GeocodeResult>("geocode", cacheKey);
  if (cached) {
    return cached;
  }

  let result: GeocodeResult;

  if (GOOGLE_MAPS_API_KEY) {
    result = await geocodeWithGoogle(address);
  } else {
    result = await geocodeWithNominatim(address);
  }

  if (result.success) {
    await setCache("geocode", cacheKey, result);
  }

  return result;
}

// Maps a non-OK Google Geocoding API `status` to whether the operator should
// fix their address or treat it as a provider/system fault. ZERO_RESULTS means
// the address was syntactically valid but unfindable (operator fixes it); every
// other non-OK status (OVER_QUERY_LIMIT, OVER_DAILY_LIMIT, REQUEST_DENIED,
// INVALID_REQUEST, UNKNOWN_ERROR) is a quota/key/provider fault.
export function classifyGoogleGeocodeStatus(status: string): "not_found" | "system" {
  return status === "ZERO_RESULTS" ? "not_found" : "system";
}

async function geocodeWithGoogle(address: string): Promise<GeocodeResult> {
  try {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", address);
    url.searchParams.set("key", GOOGLE_MAPS_API_KEY!);

    const response = await fetchWithRetry(
      url.toString(),
      {},
      `Geocode Google addr:${addressLabelHash(address)}`,
      {
        service: "google_maps",
        operation: "geocode",
        dedupeParams: { address },
      },
    );
    const data = await response.json();

    if (data.status === "OK" && data.results.length > 0) {
      const result = data.results[0];
      return {
        lat: result.geometry.location.lat,
        lng: result.geometry.location.lng,
        formattedAddress: result.formatted_address,
        success: true,
      };
    }

    // ZERO_RESULTS = a syntactically valid address the geocoder couldn't find
    // (operator should correct it). Everything else (OVER_QUERY_LIMIT,
    // OVER_DAILY_LIMIT, REQUEST_DENIED, INVALID_REQUEST, UNKNOWN_ERROR) is a
    // quota/key/provider fault, not the operator's input.
    const failureReason = classifyGoogleGeocodeStatus(data.status);
    console.warn("Google geocode failed:", data.status);
    return { lat: 0, lng: 0, formattedAddress: "", success: false, failureReason };
  } catch (error) {
    console.error("Google geocode error:", error);
    return { lat: 0, lng: 0, formattedAddress: "", success: false, failureReason: "system" };
  }
}

async function geocodeWithNominatim(address: string): Promise<GeocodeResult> {
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", address);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    url.searchParams.set("countrycodes", "us");

    const response = await fetchWithRetry(
      url.toString(),
      { headers: { "User-Agent": "MCUCapacityTool/1.0" } },
      `Geocode Nominatim addr:${addressLabelHash(address)}`,
      {
        service: "nominatim",
        operation: "geocode",
        dedupeParams: { address },
      },
    );
    const data = await response.json();

    if (data.length > 0) {
      return {
        lat: parseFloat(data[0].lat),
        lng: parseFloat(data[0].lon),
        formattedAddress: data[0].display_name,
        success: true,
      };
    }

    console.warn("Nominatim geocode returned no results for:", address);
    return { lat: 0, lng: 0, formattedAddress: "", success: false, failureReason: "not_found" };
  } catch (error) {
    console.error("Nominatim geocode error:", error);
    return { lat: 0, lng: 0, formattedAddress: "", success: false, failureReason: "system" };
  }
}

export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const cacheKey = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  const cached = await getCached<string>("reverse-geocode", cacheKey);
  if (cached) return cached;

  if (GOOGLE_MAPS_API_KEY) {
    try {
      const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
      url.searchParams.set("latlng", `${lat},${lng}`);
      url.searchParams.set("key", GOOGLE_MAPS_API_KEY);
      const response = await fetchWithRetry(
        url.toString(),
        {},
        `ReverseGeocode Google ${cacheKey}`,
        {
          service: "google_maps",
          operation: "reverse_geocode",
          dedupeParams: { latlng: cacheKey },
        },
      );
      const data = await response.json();
      if (data.status === "OK" && data.results?.length > 0) {
        const addr = data.results[0].formatted_address;
        await setCache("reverse-geocode", cacheKey, addr);
        return addr;
      }
    } catch (err) {
      console.warn(`[ReverseGeocode] Google failed for ${cacheKey}:`, err);
    }
  } else {
    try {
      const url = new URL("https://nominatim.openstreetmap.org/reverse");
      url.searchParams.set("lat", String(lat));
      url.searchParams.set("lon", String(lng));
      url.searchParams.set("format", "json");
      const response = await fetchWithRetry(
        url.toString(),
        { headers: { "User-Agent": "MCUCapacityTool/1.0" } },
        `ReverseGeocode Nominatim ${cacheKey}`,
        {
          service: "nominatim",
          operation: "reverse_geocode",
          dedupeParams: { latlng: cacheKey },
        },
      );
      const data = await response.json();
      if (data.display_name) {
        await setCache("reverse-geocode", cacheKey, data.display_name);
        return data.display_name;
      }
    } catch (err) {
      console.warn(`[ReverseGeocode] Nominatim failed for ${cacheKey}:`, err);
    }
  }
  return null;
}

export interface ParsedLocationText {
  firmName: string;
  addressText: string | null;
}

export function parseLocationText(raw: string): ParsedLocationText {
  const addressPattern = /\d{2,5}\s+[\w\s.]+(?:Ave|Avenue|St|Street|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Cir|Circle|Hwy|Highway|Pike)\b[^,]*,\s*(?:Suite|Ste|Unit|Apt|#|Bldg)?\s*[^,]*,?\s*\w[\w\s]*,?\s*[A-Z]{2}\s*\d{5}/i;
  const match = raw.match(addressPattern);
  if (match) {
    const address = match[0].trim();
    const firmName = raw.replace(address, "").replace(/[-–—,\s]+$/, "").replace(/^[-–—,\s]+/, "").trim();
    return { firmName: firmName || raw.trim(), addressText: address };
  }

  const simpleAddressPattern = /\d{2,5}\s+[\w\s.]+,\s*[\w\s]+,\s*[A-Z]{2}\s*\d{5}/i;
  const simpleMatch = raw.match(simpleAddressPattern);
  if (simpleMatch) {
    const address = simpleMatch[0].trim();
    const firmName = raw.replace(address, "").replace(/[-–—,\s]+$/, "").replace(/^[-–—,\s]+/, "").trim();
    return { firmName: firmName || raw.trim(), addressText: address };
  }

  return { firmName: raw.trim(), addressText: null };
}

export interface GeocodedLocationData {
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  stateFips: string | null;
  countyFips: string | null;
  geocodedAt: Date | null;
  geocodeWarning?: string;
  // When geocoding failed, mirrors GeocodeResult.failureReason so callers can
  // tell an unfindable address ("not_found") apart from a provider/system fault
  // ("system"). Undefined on success or when no address was parseable at all.
  geocodeFailureReason?: "not_found" | "system";
}

export async function geocodeLocationText(rawText: string, explicitAddress?: string): Promise<GeocodedLocationData> {
  const parsed = explicitAddress
    ? { firmName: rawText.trim(), addressText: explicitAddress.trim() }
    : parseLocationText(rawText);

  let geocodeResult = null;
  let geocodeWarning: string | undefined;
  let geocodeFailureReason: "not_found" | "system" | undefined;

  const textToGeocode = parsed.addressText;
  if (textToGeocode) {
    try {
      geocodeResult = await geocodeAddress(textToGeocode);
      if (!geocodeResult.success) {
        // Operator-facing warning keeps the raw address (already in DB / report
        // context). Log line is hashed so logs/aggregators don't carry PII.
        geocodeWarning = `Geocoding failed for: "${textToGeocode}"`;
        geocodeFailureReason = geocodeResult.failureReason ?? "not_found";
        console.warn(`[geocodeLocationText] geocoding failed addr:${addressLabelHash(textToGeocode)}`);
      }
    } catch (err) {
      geocodeWarning = `Geocoding error for: "${textToGeocode}"`;
      geocodeFailureReason = "system";
      console.warn(`[geocodeLocationText] geocoding error addr:${addressLabelHash(textToGeocode)}`, err);
    }
  } else {
    geocodeWarning = `No parseable address found in: "${rawText}"`;
    geocodeFailureReason = "not_found";
    console.warn(`[geocodeLocationText] no parseable address raw:${addressLabelHash(rawText)}`);
  }

  let city: string | null = null;
  let state: string | null = null;
  if (geocodeResult?.success && geocodeResult.formattedAddress) {
    const parts = geocodeResult.formattedAddress.split(",").map((p: string) => p.trim());
    if (parts.length >= 3) {
      city = parts[parts.length - 3];
      const stateZip = parts[parts.length - 2];
      state = stateZip?.split(" ")[0] || null;
    }
  }

  let fipsResult = null;
  if (geocodeResult?.success && geocodeResult.lat != null && geocodeResult.lng != null) {
    try {
      const { getFipsForLocation } = await import("./fips");
      fipsResult = await getFipsForLocation({ lat: geocodeResult.lat, lng: geocodeResult.lng });
    } catch (fipsError) {
      console.warn("[geocodeLocationText] FIPS lookup error:", fipsError);
    }
  }

  return {
    name: parsed.firmName,
    address: geocodeResult?.success ? (geocodeResult.formattedAddress || textToGeocode) : null,
    city,
    state,
    lat: geocodeResult?.success ? geocodeResult.lat : null,
    lng: geocodeResult?.success ? geocodeResult.lng : null,
    stateFips: fipsResult?.stateFips || null,
    countyFips: fipsResult?.countyFips || null,
    geocodedAt: geocodeResult?.success ? new Date() : null,
    geocodeWarning,
    geocodeFailureReason,
  };
}

export function normalizeBusinessName(name: string): string {
  return name
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/\b(llc|pllc|inc|corp|ltd|lp|llp|pa|p\.a\.|p\.c\.|pc|co|company|group|firm|law|legal|attorneys?|at\s+law|esq)\b/gi, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function fuzzyBusinessNameMatch(name1: string, name2: string): number {
  const n1 = normalizeBusinessName(name1);
  const n2 = normalizeBusinessName(name2);

  if (!n1 || !n2) return 0;
  if (n1 === n2) return 1.0;

  if (n1.includes(n2) || n2.includes(n1)) {
    const shorter = Math.min(n1.length, n2.length);
    const longer = Math.max(n1.length, n2.length);
    return shorter / longer;
  }

  const words1 = new Set(n1.split(" ").filter(w => w.length > 1));
  const words2 = new Set(n2.split(" ").filter(w => w.length > 1));
  if (words1.size === 0 || words2.size === 0) return 0;

  let overlap = 0;
  for (const w of words1) {
    if (words2.has(w)) overlap++;
  }
  const union = new Set([...words1, ...words2]).size;
  return overlap / union;
}

export function normalizeLocationString(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function fuzzyLocationMatch(
  location: { name?: string; city?: string | null; state?: string | null; address?: string | null },
  campaign: { location?: string; address?: string; gridLocationName?: string }
): number {
  const locParts: string[] = [];
  if (location.city) locParts.push(location.city);
  if (location.state) locParts.push(location.state);
  if (location.address) locParts.push(location.address);
  if (location.name) locParts.push(location.name);

  const campParts: string[] = [];
  if (campaign.location) campParts.push(campaign.location);
  if (campaign.address) campParts.push(campaign.address);
  if (campaign.gridLocationName) campParts.push(campaign.gridLocationName);

  if (locParts.length === 0 || campParts.length === 0) return 0;

  let bestScore = 0;

  for (const lp of locParts) {
    const nl = normalizeLocationString(lp);
    if (!nl) continue;
    const locWords = new Set(nl.split(" ").filter(w => w.length > 1));

    for (const cp of campParts) {
      const nc = normalizeLocationString(cp);
      if (!nc) continue;

      if (nl === nc) return 1.0;

      if (nl.includes(nc) || nc.includes(nl)) {
        const score = Math.min(nl.length, nc.length) / Math.max(nl.length, nc.length);
        if (score > bestScore) bestScore = score;
        continue;
      }

      const campWords = new Set(nc.split(" ").filter(w => w.length > 1));
      if (locWords.size === 0 || campWords.size === 0) continue;

      let overlap = 0;
      for (const w of locWords) {
        if (campWords.has(w)) overlap++;
      }
      if (overlap > 0) {
        const union = new Set([...locWords, ...campWords]).size;
        const score = overlap / union;
        if (score > bestScore) bestScore = score;
      }
    }
  }

  return bestScore;
}

export function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3959;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}
