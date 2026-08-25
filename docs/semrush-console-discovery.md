# SEMrush Operations Console — Discovery & IA Report (Task #938 / 936A)

> Scope: discovery + IA only. Does **not** propose ingestion changes, new
> instrumentation, or page-shell work — those belong to 936B+.

This document is the input to building a dedicated **SEMrush Operations
Console** (`/admin/semrush`, planned in 936B). It inventories what already
exists, where SEMrush state lives, what the target page should look like, and
what thin endpoints are missing.

---

## 1. Current operator surfaces (where SEMrush is touched today)

SEMrush has no dedicated admin page yet. Operator-facing functionality is
spread across three client surfaces:

### 1.1 `client/src/pages/admin/IntegrationsHub.tsx`
The single entry point for SEMrush admin work. It contains:

| Section | Lines (approx) | What it shows | Endpoints |
| --- | --- | --- | --- |
| **SEMrush connection card** | 1375–1433 | Connected / Expired / Pending / Not connected; device-flow user code + verification URI; Connect / Re-connect / Disconnect buttons. | `GET /api/semrush/status`, `POST /api/semrush/authorize`, `POST /api/semrush/poll-token`, `POST /api/semrush/disconnect` |
| **Backfill historical heatmaps card** | 1598–1873 | Filters (client IDs, location IDs, campaign IDs, since/until report dates), dry-run shortlist preview, "Apply backfill" with enqueued-job count + per-row error details. Polls inventory status every 3 s while a job is in flight. | `POST /api/semrush/heatmaps/backfill` (dry-run + apply), `GET /api/semrush/inventory/status` |

### 1.2 `client/src/components/LocalDominanceSyncStatePanel.tsx`
Embedded inside the per-client **Local Dominance Dashboard**
(`LocalDominanceDashboard.tsx`). Per-location table:
- Status (idle / running / failed / awaiting-retry), retry count, error class,
  next-retry ETA.
- "View attempts" drawer with append-only attempt history.
- "Retry now" action (operator-initiated reset of attempt counters).

Endpoints: `GET /api/clients/:clientId/semrush-integration/sync-state`,
`GET .../locations/:locId/attempts`,
`POST .../locations/:locId/retry`.

### 1.3 `client/src/components/LocalDominanceDashboard.tsx` (mapping config)
Per-client mapping configuration UI (location → SEMrush campaign), with
"auto-match" trigger. Endpoints:
`GET/PUT /api/clients/:clientId/semrush-location-campaigns`,
`GET /api/clients/:clientId/semrush-mapped-campaigns`,
`POST /api/clients/:id/semrush-location-campaigns/auto-match`,
`POST /api/clients/:clientId/semrush-integration/sync`.

### 1.4 Deep-link from Front
The Front "Operations Console" page (`/admin/front`, registered in
`client/src/App.tsx:109`) is the existing structural template for what 936B
is building: deep-linked from `IntegrationsHub.tsx` (no top-level sidebar
entry), back-link to the Hub, and a vertical stack of overview / pipeline /
jobs / messages cards. Auth note: `FrontIntegration.tsx` itself does **not**
perform a client-side `role`-string check today — gating is enforced by the
Express middleware on each `/api/integrations/front/*` and `/api/admin/front/*`
endpoint (per-route `requireTeamLead` / `requireAccountManager` /
`isAuthenticated`). 936B should follow the same pattern: rely on
per-endpoint server middleware as the source of truth and only add client
guards (e.g. hiding action buttons) where the UX demands it.

### 1.5 Backend-only / script surfaces (no UI)
- `scripts/backfill-location-heatmaps.ts` — historical heatmap backfill via
  CLI (`--dry-run` / `--apply`). Functionally a superset of the Hub backfill
  card.
- `scripts/promote-semrush-configured-mapping-suggestions.ts` — drains the
  pre-#920A suggestion backlog. One-off cleanup, not recurring.
- `localDominanceSyncWorker.ts` — fair-queue scheduler, no UI.

---

## 2. Backend actions available today

All routes live in `server/routes/heatmap.ts` (routes are namespaced
`/api/semrush/*` and `/api/clients/:clientId/semrush-*`). Auth middleware
column abbreviations: **A** = `isAuthenticated`, **AM** = `requireAccountManager`,
**TL** = `requireTeamLead`.

### 2.1 Global (system-level) endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/semrush/status` | A | Connection status (connected / expired / pendingAuth). |
| POST | `/api/semrush/authorize` | TL | Begin OAuth device flow. |
| POST | `/api/semrush/poll-token` | TL | Poll for completed device-flow token exchange. |
| POST | `/api/semrush/disconnect` | TL | Clear stored OAuth tokens. |
| GET | `/api/semrush/campaigns` | A | List all campaigns visible to the connected SEMrush account. |
| GET | `/api/semrush/campaigns/:id` | A | Campaign detail (report dates, settings). |
| GET | `/api/semrush/campaigns/:id/keywords` | A | Keyword list for one campaign. |
| POST | `/api/semrush/campaigns/:id/fetch-heatmap` | A | Pull a single keyword's heatmap and import. |
| POST | `/api/semrush/campaigns/:id/fetch-all-heatmaps` | A | Bulk-pull all active keywords for one campaign. |
| POST | `/api/semrush/campaigns/:id/refresh` | AM | Enqueue a manual report-refresh job (`semrush_report_refresh`). |
| POST | `/api/semrush/campaigns/clear-cache` | AM | Force-clear in-memory campaign list cache. |
| GET | `/api/semrush/inventory/status` | AM | Last inventory snapshot timestamp + worker state. |
| GET | `/api/semrush/inventory/campaigns` | AM | Campaigns from the most recent inventory snapshot. |
| POST | `/api/semrush/inventory/sync` | TL | Manually trigger a global inventory sync. |
| POST | `/api/semrush/heatmaps/backfill` | AM | Historical heatmap backfill — requires `confirm: true` (or `dryRun: true`). Creates a `backfill_jobs` row with `jobType='semrush_heatmap_backfill'`. |
| GET | `/api/backfill-jobs` | AM | Canonical backfill job log across clients. Filterable by `jobType` (use `semrush_heatmap_backfill` for this console) and `status`. |
| GET | `/api/backfill-jobs/:jobId` | AM | Single backfill job detail (progress counters, status, timing). |
| GET | `/api/backfill-jobs/:jobId/coverage-gaps` | AM | Auto-computed coverage gaps for a finished backfill job (read-only, served from `coverageGapsJson`). |

### 2.2 Per-client endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/clients/:clientId/semrush-integration` | A | Client's SEMrush integration record. |
| PUT | `/api/clients/:clientId/semrush-integration` | AM | Create / update integration settings. |
| DELETE | `/api/clients/:clientId/semrush-integration` | AM | Remove integration. |
| POST | `/api/clients/:clientId/semrush-integration/sync` | AM | Trigger Local Dominance sync for this client. |
| GET | `/api/clients/:clientId/semrush-integration/sync-state` | A | Per-location sync state rows (status, attempts, errors, next-retry). |
| GET | `/api/clients/:clientId/semrush-integration/locations/:locId/attempts` | A | Append-only attempt history for one location. |
| POST | `/api/clients/:clientId/semrush-integration/locations/:locId/retry` | AM | Reset counters + retry a single location. |
| GET | `/api/clients/:clientId/semrush-mapped-campaigns` | A | Campaigns currently linked to the client's locations. |
| GET | `/api/clients/:clientId/semrush-location-campaigns` | A | Raw `(location, campaign)` mapping rows. |
| PUT | `/api/clients/:clientId/semrush-location-campaigns` | AM | Bulk-set mappings (routes through `applySemrushLocationMapping`). |
| POST | `/api/clients/:id/semrush-location-campaigns/auto-match` | AM | Proximity / name auto-match → mapping writer (routes through `applySemrushLocationMapping`). |

---

## 3. Data classification (durable vs ephemeral)

Critical for the console because some panels can rely on the DB for restart
safety, others can't.

| Concern | Storage | Durability | Owner / source |
| --- | --- | --- | --- |
| OAuth tokens (access / refresh / expiry) | `system_settings` (`semrush_access_token`, `semrush_refresh_token`, `semrush_token_expires_at`) | Durable | `semrushApi.ts` |
| Device-flow code / user code / verify URI | `system_settings` (`semrush_device_*`) | Durable (cleared on completion or expiry) | `semrushApi.ts` |
| Campaign list + keyword cache + enrichment readiness | In-process Map (`cachedCampaignList`, `campaignKeywordsCache`, `enrichedCacheReady`) | **Ephemeral** — lost on restart, 60-min TTL | `semrushApi.ts` |
| Inventory snapshot ("previousInventory") | In-memory `previousInventory` **restored on first sync from `source_event_log`** (latest `inventory_sync` event) | Effectively durable (reseeds from DB) | `semrushInventorySync.ts` |
| Inventory sync events (snapshots, status, applied/ignored) | `source_event_log` (`source_system='semrush'`, `source_event_type='inventory_sync'` and `'refresh_request'`) | Durable | `semrushInventorySync.ts` |
| Inventory diff results (new / removed campaigns, new report dates) | `work_result_log` (`result_type='inventory_diff'`) | Durable | `semrushInventorySync.ts` |
| Refresh / backfill jobs (queue rows) | `work_queue` (`queue_name='semrush_report_refresh'`) | Durable | `semrushInventorySync.ts`, `workScheduler.ts` |
| Backfill job lifecycle (per-request progress, status, coverage gaps) | `backfill_jobs` (`jobType='semrush_heatmap_backfill'`, with `coverageGapsJson`) | Durable | `backfillJobs.ts` (canonical lifecycle tracking) |
| Per-location sync state (status, retry count, last error class, next retry) | `semrush_location_sync_state` | Durable | `semrushLocationSyncState.ts` |
| Per-location attempt history (append-only) | `semrush_location_sync_attempts` | Durable | `semrushLocationSyncAttempts.ts` |
| Mapping rows (location ↔ campaign) | `semrush_location_campaigns` (unique on `(clientId, locationId, semrushCampaignId)`) | Durable, soft-stale via `is_stale` / `stale_since` | `semrushLocationMappingWriter.ts` |
| Pending mapping suggestions | `import_entity_suggestions` (`entity_kind='location_mapping'`, `surface='semrush_inventory' \| 'local_dominance_sync'`) | Durable | `semrushLocationMappingWriter.ts` |
| Heatmap snapshots / points / metrics / competitor snapshots | `heatmap_snapshots`, `heatmap_points`, `heatmap_metrics`, `heatmap_competitor_snapshots` | Durable | `localDominanceService.ts` |
| Pipeline-health rolling window (handler durations, dedupe counters, stale-lease exhaustion) | In-memory in `pipelineObservability.ts` | Ephemeral | `pipelineObservability.ts` |
| `triggeredNextReportDates` set (de-dup for "next report date passed" trigger) | In-memory Set | Ephemeral — non-fatal (worst case = duplicate enqueue, suppressed by `work_queue` dedupe key) | `semrushInventorySync.ts` |

**Implication for the console:** every panel below can be backed by a
durable source except _campaign list_ (best-effort, refresh-on-demand) and
_pipeline health rolling window_ (read-through observability service, fine
to render with a "since worker boot" footnote).

---

## 4. Target Information Architecture

Single page at `/admin/semrush` (route shell built in 936B). Gating
follows the Front console pattern (§1.4): per-endpoint Express middleware
is the source of truth (`requireAccountManager` for read-only console
endpoints, `requireTeamLead` for token / sync triggers); the page itself
adds optional client guards only to hide action buttons. Vertical sections
in fixed order; each is a self-contained card so the page degrades
gracefully when one section fails to load.

### 4.1 Overview / Pipeline Health
Top-of-page status block. Mirrors the Front console "Overview & Stats"
pattern.
- Connection state badge (Connected / Expired / Pending device flow / Not
  connected) with quick action buttons (Connect / Re-connect / Disconnect).
- Last inventory snapshot timestamp + campaign count.
- 24 h job throughput summary (refresh jobs enqueued / completed / failed).
- Queue depth for `semrush_report_refresh`.
- Stale-lease exhaustion counter from `pipelineObservability`.
- Token expiry countdown.

### 4.2 Sync State
Operational health table aggregated **across all clients** (today this is
only available per-client via the Local Dominance dashboard).
- Row per `(clientId, locationId)` from `semrush_location_sync_state`.
- Columns: client, location, status, last attempt, retry count, last error
  class, next-retry ETA.
- Filters: status, error class, client.
- Actions: "Retry now" (existing per-location endpoint), "Open client" deep
  link.

### 4.3 Mapping Inventory & Suggestions
Two stacked tables:
- **Mappings** — `semrush_location_campaigns` rows (filterable by client,
  by `is_stale`, by campaign). Columns: client, location, campaign id,
  campaign name, stale flag, stale-since.
- **Suggestions** — `import_entity_suggestions` rows where
  `entity_kind='location_mapping'` and `status='pending'`. Columns: client,
  location id, campaign id, surface, reason, age. Actions: "Promote",
  "Reject" (route through existing suggestion APIs).

### 4.4 Historical Backfill
Lift-and-shift of the existing IntegrationsHub "Backfill historical
heatmaps" card (Section 1.1 above). No backend changes — same dry-run /
apply flow against `POST /api/semrush/heatmaps/backfill`. Add a "Recent
backfills" sub-section backed by the canonical
`GET /api/backfill-jobs?jobType=semrush_heatmap_backfill` log so operators
see lifecycle status (running / succeeded / failed), per-request progress
counters, and a drill-down to `GET /api/backfill-jobs/:jobId/coverage-gaps`
for finished jobs.

### 4.5 Recent Jobs
Bottom-of-page activity feed.
- Last N entries from `work_queue` for `queue_name='semrush_report_refresh'`
  (status, payload trigger, claim age, attempt count, last error).
- Linked dedupe-key column so operators can spot retried jobs.
- Optional row-level "View source event" link to the underlying
  `source_event_log` row.

---

## 5. Panel → data-source dependency map

| Panel | Existing endpoint(s) | Underlying durable store(s) | Notes |
| --- | --- | --- | --- |
| **Overview / Pipeline Health** — connection | `GET /api/semrush/status` | `system_settings` | Reuses Hub card. |
| **Overview / Pipeline Health** — inventory freshness | `GET /api/semrush/inventory/status` | `source_event_log` (latest `inventory_sync`) | Already exposed. |
| **Overview / Pipeline Health** — queue depth + 24 h throughput | _none today_ | `work_queue`, `work_result_log` | **GAP** — see §6. |
| **Overview / Pipeline Health** — stale-lease counter | _none today_ (in-memory only) | `pipelineObservability` (in-process) | **GAP** — see §6. |
| **Sync State** — per-client | `GET /api/clients/:clientId/semrush-integration/sync-state` | `semrush_location_sync_state` | Per-client only, not aggregated. |
| **Sync State** — global / cross-client | _none today_ | `semrush_location_sync_state` | **GAP** — see §6. |
| **Sync State** — attempt history drawer | `GET /api/clients/:clientId/semrush-integration/locations/:locId/attempts` | `semrush_location_sync_attempts` | Already exposed. |
| **Sync State** — retry action | `POST /api/clients/:clientId/semrush-integration/locations/:locId/retry` | (writes to `semrush_location_sync_state`) | Already exposed. |
| **Mapping Inventory** — global mapping list | _none today_ (only per-client `GET /api/clients/:clientId/semrush-location-campaigns`) | `semrush_location_campaigns` | **GAP** — see §6. |
| **Mapping Inventory** — per-client mapping list | `GET /api/clients/:clientId/semrush-location-campaigns`, `GET /api/clients/:clientId/semrush-mapped-campaigns` | `semrush_location_campaigns` | Existing; usable as drill-down. |
| **Suggestions** | _none today_ | `import_entity_suggestions` (`entity_kind='location_mapping'`) | **GAP** — see §6. The promote / reject paths exist on the storage layer (`promoteImportEntitySuggestion` / `rejectImportEntitySuggestion`) but aren't exposed via HTTP for SEMrush mapping suggestions specifically. |
| **Historical Backfill** — dry-run + apply | `POST /api/semrush/heatmaps/backfill` | `work_queue`, `source_event_log` (`refresh_request`), `backfill_jobs` | Reuses Hub card verbatim. |
| **Historical Backfill** — recent backfill jobs + lifecycle | `GET /api/backfill-jobs?jobType=semrush_heatmap_backfill`, `GET /api/backfill-jobs/:jobId`, `GET /api/backfill-jobs/:jobId/coverage-gaps` | `backfill_jobs` (canonical) | Already exposed — no new endpoint needed. |
| **Recent Jobs** (queue activity feed) | _none today_ | `work_queue` (`queue_name='semrush_report_refresh'`), `work_result_log` | **GAP** — see §6. Distinct from `/api/backfill-jobs` (per-job lifecycle): this feed shows individual queue rows including non-backfill triggers (`new_campaign`, `new_report_date`, manual refresh). |
| Connect / Re-connect / Disconnect actions | `POST /api/semrush/authorize`, `POST /api/semrush/poll-token`, `POST /api/semrush/disconnect` | `system_settings` | Already exposed. |
| Manual inventory sync | `POST /api/semrush/inventory/sync` | (worker entry) | Already exposed. |

---

## 6. Gaps — missing thin endpoints

These are the only new HTTP endpoints required to back the IA above. All
are **read-shaped, thin wrappers** over existing durable stores; no new
ingestion logic, no new schema, no new instrumentation. Concrete shape
proposals are deferred to 936C+ (the implementation tasks); 936B only
needs to know the gap exists.

1. **`GET /api/semrush/console/overview`** — single composite read for the
   Overview / Pipeline Health section. Returns: connection status, latest
   inventory snapshot timestamp + count, queue depth for
   `semrush_report_refresh`, 24 h enqueued / completed / failed counts,
   in-memory stale-lease exhaustion counter, token expiry. Backs §4.1.
2. **`GET /api/semrush/console/sync-state`** — global aggregation of
   `semrush_location_sync_state` across all clients with status / error-class
   filters. Backs §4.2. (Per-client endpoint stays for the Local Dominance
   drill-down.)
3. **`GET /api/semrush/console/mappings`** — global list of
   `semrush_location_campaigns` rows joined to client / location names,
   filterable by `isStale` and client. Backs §4.3 mappings table.
4. **`GET /api/semrush/console/suggestions`** + **`POST
   /api/semrush/console/suggestions/:id/promote`** + **`POST
   /api/semrush/console/suggestions/:id/reject`** — list + act on pending
   `import_entity_suggestions` rows where `entity_kind='location_mapping'`.
   Backs §4.3 suggestions table. The storage layer methods already exist;
   only the HTTP wrappers are missing.
5. **`GET /api/semrush/console/recent-jobs`** — last N `work_queue` rows for
   `queue_name='semrush_report_refresh'` joined to `work_result_log` for
   outcome. Backs §4.5. Note: §4.4 "recent backfills" does **not** need a
   new endpoint — the canonical `GET /api/backfill-jobs?jobType=semrush_heatmap_backfill`
   (plus `:jobId` and `:jobId/coverage-gaps`) already covers per-backfill
   lifecycle. This separate endpoint exists because `work_queue` carries
   non-backfill refresh triggers too (`new_campaign`, `new_report_date`,
   `manual`) that `backfill_jobs` does not track.

Auth: all new endpoints should require `requireAccountManager` to match the
existing `/api/semrush/inventory/*` and `/api/semrush/heatmaps/backfill`
gates.

Out-of-scope items intentionally **not** listed as gaps:
- Per-keyword heatmap fetch UI (already exists at the campaign level via
  existing endpoints; not part of this console).
- Mapping mutation endpoints — the existing per-client PUT and auto-match
  routes already cover write paths through `applySemrushLocationMapping`.
- Push / streaming updates — react-query polling is sufficient for the
  initial console (matches Front console pattern).
- New observability metrics — pipeline observability already records
  everything we need; we only need to expose what's there.

---

## 7. MVP vs Follow-up matrix

Explicit split for downstream phasing. "MVP" = required for the first
shippable `/admin/semrush` page (936B–F). "Follow-up" = useful but
intentionally deferred to keep the MVP scope tight.

| Section | Capability / action | MVP? | Notes |
| --- | --- | --- | --- |
| 4.1 Overview | Connection badge + Connect/Re-connect/Disconnect | **MVP** | Reuses existing endpoints. |
| 4.1 Overview | Last inventory snapshot + manual "Sync now" button | **MVP** | Existing `/api/semrush/inventory/status` + `POST /api/semrush/inventory/sync`. |
| 4.1 Overview | Queue depth + 24 h enqueued/completed/failed counts | **MVP** | Requires gap #1 (`/api/semrush/console/overview`). |
| 4.1 Overview | Token expiry countdown | MVP | Computed client-side from `/api/semrush/status`. |
| 4.1 Overview | Stale-lease exhaustion counter | Follow-up | In-memory only; surface once gap #1 lands, OK to defer. |
| 4.2 Sync State | Global cross-client table | **MVP** | Requires gap #2 (`/api/semrush/console/sync-state`). |
| 4.2 Sync State | Per-location attempt history drawer | **MVP** | Existing endpoint; matches per-client drilldown. |
| 4.2 Sync State | "Retry now" action | **MVP** | Existing endpoint. |
| 4.3 Mappings | Global mapping list with stale flag + filters | **MVP** | Requires gap #3 (`/api/semrush/console/mappings`). |
| 4.3 Mappings | Per-client drilldown link | MVP | Reuses existing per-client endpoints. |
| 4.3 Suggestions | List of pending location-mapping suggestions | **MVP** | Requires gap #4 list endpoint. |
| 4.3 Suggestions | Promote / Reject actions | **MVP** | Requires gap #4 mutation endpoints (storage methods already exist). |
| 4.3 Suggestions | Bulk promote / reject | Follow-up | Single-row actions ship first; bulk can wait. |
| 4.4 Backfill | Dry-run + apply form | **MVP** | Lift-and-shift from IntegrationsHub; existing endpoint. |
| 4.4 Backfill | "Recent backfills" list with status + coverage gaps | **MVP** | Already covered by canonical `/api/backfill-jobs?jobType=semrush_heatmap_backfill` (no new endpoint needed). |
| 4.5 Recent Jobs | Queue activity feed for `semrush_report_refresh` | **MVP** | Requires gap #5 (`/api/semrush/console/recent-jobs`). |
| 4.5 Recent Jobs | Per-job source-event drilldown link | Follow-up | Useful but not load-bearing for MVP. |
| Cross-cutting | Real-time push / streaming updates | Follow-up | React-query polling is sufficient for v1. |
| Cross-cutting | Audit trail of who promoted/rejected which suggestion | Follow-up | Storage layer already records this; surface once MVP ships. |
