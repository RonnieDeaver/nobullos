# Semrush Map Rank Tracker API Reference

**Base URL:** `https://api.semrush.com/apis/v4/map-rank-tracker/v0`
**Auth:** Bearer Token (OAuth 2.0) in `Authorization: Bearer <TOKEN>` header
**API Units:** None consumed — all Map Rank Tracker endpoints are free
**Official Docs:** https://developer.semrush.com/api/v4/map-rank-tracker-2/v002/

---

## Endpoints

### 1. GET /campaigns — List All Campaigns

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `search` | string | No | Filter campaigns by search query |
| `page` | integer | No | Page number (0-indexed) |

**Pagination:** The API uses its own default page size (~10). Do NOT try to override it with `size` or `page_size` — just paginate through all pages using `page=0`, `page=1`, etc. Use `total_elements` from the response to know when you have everything.

**Response:** `data.content[]` (paginated array of campaign objects)

---

### 2. GET /campaigns/:campaignId — Get Single Campaign

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `campaignId` (path) | string (UUID) | Yes | Campaign ID |

**Key response fields:**
- `reportDates` — array of valid ISO-8601 timestamps (e.g., `"2024-07-05T12:39:22.611Z"`)
- `lastReportDate` — most recent report timestamp
- `business.cid` — business CID identifier
- `business.placeIds` — Google Place IDs array
- `gridSettings` — grid configuration (template, distance, unit, basePoint)
- `keywords` — keyword list (may also need `/keywords` endpoint)

---

### 3. GET /campaigns/:campaignId/keywords — Campaign Keywords

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `campaignId` (path) | string (UUID) | Yes | Campaign ID |

**Response:** `data.keywords[]` with `keyword.id`, `keyword.name`, `status` ("COLLECTED", etc.)

---

### 4. GET /campaigns/:campaignId/heatmap — Heatmap Report

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `campaignId` (path) | string (UUID) | Yes | Campaign ID |
| `keywordId` | string (UUID) | Yes | Keyword ID |
| `cid` | string | Conditional | Business ID. Either `cid` or `placeIds` MUST be specified |
| `placeIds` | string | Conditional | Comma-separated Google Place IDs. Either `cid` or `placeIds` MUST be specified |
| `reportDate` | string (ISO-8601) | No | Full timestamp from `reportDates[]`. Defaults to latest if omitted |

**CRITICAL RULES:**
- `reportDate` MUST be an exact timestamp from the campaign's `reportDates[]` array
- Format: `2024-07-05T12:39:22.611Z` (full ISO-8601 with milliseconds + Z)
- NEVER construct your own date string — use verbatim values from `reportDates[]`
- Wrong `reportDate` returns empty data (no error)
- Either `cid` or `placeIds` is required for correct business identification

**Response:**
```json
{
  "data": {
    "keyword": { "id": "...", "name": "..." },
    "date": "2024-07-05T12:39:22.611Z",
    "positions": [
      {
        "point": {
          "id": "uuid",
          "coordinates": { "lat": 34.90, "lng": 33.64 }
        },
        "position": 1,
        "diff": 1
      }
    ]
  }
}
```

**Position coordinates:** `point.coordinates.lat` / `point.coordinates.lng` (NOT `point.lat`/`point.lng`)

---

### 5. GET /campaigns/:campaignId/metrics — Campaign Metrics (Time Series)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `campaignId` (path) | string (UUID) | Yes | Campaign ID |
| `keywordId` | string (UUID) | Yes | Keyword ID |
| `cid` | string | Conditional | Business ID. Either `cid` or `placeIds` MUST be specified |
| `placeIds` | string | Conditional | Google Place IDs. Either `cid` or `placeIds` MUST be specified |

**NOTE:** This endpoint does NOT accept `reportDate` — it returns ALL historical data as time-series objects.

**Response:**
```json
{
  "data": {
    "averagePositions": {
      "2024-08-13T15:20:19.686Z": 10.39,
      "2024-07-05T12:39:22.611Z": 11.2
    },
    "shareOfVoice": {
      "2024-08-13T15:20:19.686Z": 6.47,
      "2024-07-05T12:39:22.611Z": 5.9
    }
  }
}
```

---

### 6. GET /campaigns/:campaignId/top-competitors — Top Competitors

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `campaignId` (path) | string (UUID) | Yes | Campaign ID |
| `keywordId` | string (UUID) | Yes | Keyword ID |
| `reportDate` | string (ISO-8601) | Yes | MUST be exact timestamp from `reportDates[]` |
| `cid` | string | Conditional | Business ID. Either `cid` or `placeIds` MUST be specified |
| `placeIds` | string[] | Conditional | Google Place IDs. Either `cid` or `placeIds` MUST be specified |
| `page` | integer | No | Page index (default: 0) |
| `pageSize` | integer | No | Results per page (default: 10). **NOTE: Does not work in practice — the API enforces its own default (~10) regardless of value passed. Do NOT pass this parameter.** |
| `sortField` | string | No | `averagePosition`, `name`, `rating`, `reviewNumber`, `shareOfVoice` |
| `sortDirection` | string | No | `ASC` or `DESC` |

**CRITICAL RULES:**
- `reportDate` is REQUIRED and must be an exact ISO-8601 timestamp from `reportDates[]`
- Wrong `reportDate` returns EMPTY competitor list (no error, just empty)
- Date-only strings like `2024-07-05` will be REJECTED with 400
- Either `cid` or `placeIds` is required for correct business identification
- Default page size is ~10. The `pageSize` parameter does NOT work in practice — the API ignores it and enforces its own default

**Response fields per competitor:**
| API Field | Type | Description |
|-----------|------|-------------|
| `name` | string | Business name |
| `address` | string | Physical address |
| `rating` | float | Customer rating (1-5) |
| `reviewNumber` | integer | Total review count |
| `averagePosition` | float | Average map rank (21 = unranked) |
| `shareOfVoice` | float | Weighted average rank metric |
| `lat` / `lng` | float | Business coordinates |
| `placeIds` | string[] | Google Place IDs |
| `id` | string | Business ID (CID) |

---

**IMPORTANT: Response `data.competitors` may be a paginated object** instead of a plain array.
Handle both `Array.isArray(data.competitors)` and `data.competitors.content` (nested array).
Always ensure the final result is validated as an array before calling `.map()`.

---

## Common Pitfalls

1. **reportDate format:** Always use the EXACT timestamp string from `reportDates[]`. Never reformat, truncate to date-only, or construct your own.
2. **cid/placeIds:** At least one must be provided for heatmap, metrics, and top-competitors endpoints. Without them, results may be incorrect or empty.
3. **Pagination:** `top-competitors` defaults to ~10 results per page. The `pageSize` parameter is documented but does NOT work in practice — the API silently ignores it. Use `sortField=shareOfVoice&sortDirection=DESC` to get the most relevant competitors on the first page.
4. **Field names:** Response uses `averagePosition` (not `averageRank`), `reviewNumber` (not `reviewCount`), `rating` (not `reviewRating`).
5. **Error behavior:** Invalid dates return empty data, not HTTP errors, except for fundamentally invalid formats which return 400.

---

## Our Implementation

**File:** `server/services/semrushApi.ts`

| Function | Endpoint | Notes |
|----------|----------|-------|
| `fetchAndMapCampaigns()` | GET /campaigns | Paginated, deduped |
| `getCampaign()` | GET /campaigns/:id | Sorts reportDates desc |
| `getCampaignKeywords()` | GET /campaigns/:id/keywords | Maps keyword.id/name/status |
| `getHeatmapData()` | GET /campaigns/:id/heatmap | Requires cid or placeIds |
| `getCampaignMetrics()` | GET /campaigns/:id/metrics | No reportDate param, returns time series |
| `getTopCompetitors()` | GET /campaigns/:id/top-competitors | Requires reportDate + cid/placeIds |
| `findBestReportDate()` | Helper | Picks closest valid date from reportDates[] for a given month |

**Key helper: `findBestReportDate(reportDates, reportMonth)`**
- Input: array of ISO-8601 timestamps, target month as "YYYY-MM"
- Returns: exact timestamp string from the array (preserves original format)
- Priority: latest date within target month > latest date before target month > null
