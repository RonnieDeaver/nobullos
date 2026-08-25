# Geospatial APIs (Google Maps, MapTiler, FCC Census)

## Overview
Three geospatial providers feed NoBull OS's market analysis and map-rendering surfaces:
- **Google Maps API** — geocoding + Places/competitor density.
- **MapTiler** — vector basemap tiles for the heatmap and hex-grid UIs.
- **FCC Census Block API** — county/block FIPS lookup that links lat/lng to demographic data.

Grouping them here avoids three one-paragraph standalone runbooks for closely-related APIs that operators usually debug together.

## Architecture

### Google Maps
| File | Purpose |
| --- | --- |
| `server/mcu/geocoding.ts` | Address ↔ lat/lng with a cache layer. Falls back to Nominatim (OpenStreetMap) when `GOOGLE_MAPS_API_KEY` is missing. |
| `server/mcu/places.ts` | `getCompetitorDensity` — Places `nearbysearch` for `type=lawyer` at 0.5/1/2/5/10/30-mile radii to score market saturation. |

### MapTiler
| File | Purpose |
| --- | --- |
| `server/routes/mcu.ts` | `GET /api/config/maptiler-key` and `GET /api/public/config/maptiler-key` — serve the key to the frontend. |
| `client/src/components/HexGridMap.tsx`, `InteractiveHeatmap.tsx` | Load the `streets-v2` style using the key. |

### FCC Census
| File | Purpose |
| --- | --- |
| `server/mcu/fips.ts` | `https://geo.fcc.gov/api/census/block/find` — lat/lng → block FIPS. |
| `server/mcu/cache.ts` | Caches FIPS lookups in `mcu_cache` for 10 years. |

The FIPS code is joined with `census_tracts` to compute market demand scores for the MCU engine.

## Settings, env vars, and kill switches

| Name | Type | Default | Purpose | Notes |
|---|---|---|---|---|
| `GOOGLE_MAPS_API_KEY` | env (secret) | — | Geocoding + Places. | If unset, geocoding falls back to Nominatim; Places (competitor density) returns empty. |
| `MAPTILER_API_KEY` | env (secret) | — | Vector tile basemap. | Served to the frontend by the config routes above. |
| `CENSUS_API_KEY` | env (secret) | — | FCC Census Block API. | Required for MCU FIPS lookups. |

None of these have a `system_settings` kill switch. They're enabled-by-presence.

## Operational workflows

### Credential rotation
1. Rotate the key in the provider console.
2. Update the env var.
3. No restart strictly required for the backend, but a restart clears any in-process caches.
4. For MapTiler, frontends pick up the new key on next page load (the key is fetched live from `/api/config/maptiler-key`).

### Quota management
- **Google Maps** — Places `nearbysearch` is the heaviest consumer (six radii per MCU run). Per-day quotas live in Google Cloud Console. Cache hits in `mcu_cache` reduce repeat calls; do not aggressively flush the cache.
- **MapTiler** — tile loads scale with frontend usage; check the MapTiler dashboard for quota.
- **FCC Census** — public endpoint, generous quota; cached for 10 years per lat/lng.

### Pause / disable
- Unset the env var to disable a given provider. Geocoding has a graceful Nominatim fallback; Places and FCC do not — features that depend on them will return empty results.

### Recovery from common failures
- **Maps 403 / `REQUEST_DENIED`** → API key restricted to a different referrer/IP, or the Places/Geocoding API isn't enabled on the project. Re-check API restrictions in Google Cloud Console.
- **Maps `OVER_QUERY_LIMIT`** → daily quota hit. Wait or raise quota.
- **MapTiler 401/403 on tile request** → key invalid, expired, or domain-restricted. Update env var and re-check domain allowlist.
- **FCC Census 5xx / timeout** → upstream is intermittent. The cache layer absorbs most pain; failures are isolated to fresh lat/lng pairs.

## Alerts and observability
- No dedicated alerter today; failures surface as empty MCU outputs or blank tiles.
- The MCU worker (`server/mcu/worker.ts`) logs per-job failures.

## Verification
- **Maps geocoding** — `curl` an internal MCU geocode call and confirm a Google response (not the Nominatim fallback).
- **MapTiler** — fetch `/api/public/config/maptiler-key` and load `https://api.maptiler.com/maps/streets-v2/tiles.json?key=…`; expect 200.
- **FCC Census** — pick a known lat/lng, call `fips.lookup(...)`, expect a block FIPS row to appear in `mcu_cache`.

## Related runbooks
- [SEMRUSH_HEATMAP_PIPELINE.md](./SEMRUSH_HEATMAP_PIPELINE.md) — heatmap pipeline that renders on top of the MapTiler basemap.
- Back to [RUNBOOKS.md](./RUNBOOKS.md) Runbook Index.

## Related Task # history
- See `server/mcu/` headers for MCU evolution Task # citations.
