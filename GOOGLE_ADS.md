# Google Ads Integration Runbook (Task #1759, unified credential — Task #4008)

## Scope
System-wide Google Ads REST GAQL client (API version pinned via
`GOOGLE_ADS_API_VERSION`, default `v24`; bump in one place when Google
sunsets a version — see the sunset schedule at
https://developers.google.com/google-ads/api/docs/sunset-dates). Daily
campaign + keyword metrics sync for every customer the MCC has access
to, plus customer discovery and the Ads Hygiene audit surfaces.

> **Task #2508 (Jun 2026):** Default bumped `v20` → `v23` after v20 sunset
> (Jun 10 2026). Same change also replaced the invalid
> `segments.date DURING LAST_${lookback}_DAYS` GAQL filter (no such
> `LAST_N_DAYS` literal → `INVALID_VALUE_WITH_DURING_OPERATOR` on every
> customer) with an explicit, today-inclusive
> `segments.date BETWEEN '<start>' AND '<end>'` range, and corrected the
> non-existent `metrics.conversions_value_micros` field to the real
> `metrics.conversions_value` (a currency DOUBLE, converted to micros for
> storage).

> **Task #2905 (Jul 2026):** Default bumped `v23` → `v24` ahead of the v23
> sunset (~Jan 2027). v24 (released Apr 22 2026, sunset May 2027) was
> verified against the v24 field reference: every field the sync selects —
> including the v23 renames `campaign.start_date_time`/`end_date_time` —
> still exists unchanged, so no GAQL edits were needed. The sunset-floor
> test in `tests/google-ads-query-build.test.ts` now fails CI at ≤ v23.

**Out of scope (intentionally):** report wiring, conversion uploads,
ad-group/ad-level data, per-user OAuth, auto-mapping to NoBull clients.

> **Related module:** the Ads OS (`/ads-os`, see [ADS_OS.md](./ADS_OS.md))
> runs on the same env credential (see below). The earlier legacy Ads OS
> port at `/admin/ads-os` (Task #2958) was retired in Task #3603.

## Credential model (Task #4008 — single env credential)

**One credential powers every Google Ads surface**: Ads Hygiene, Discover
Customers, campaign/keyword sync, and all Ads OS pulls (pacing, dashboards,
account alerts). Access tokens are minted from the
`GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET` /
`GOOGLE_ADS_REFRESH_TOKEN` env trio by the shared mint in
`server/services/adsOs/googleAdsClient.ts` (`getEnvAccessToken()`), which
keeps ONE in-process access-token cache (~55 min TTL) and ONE terminal
negative cache for all surfaces.

There is **no in-app OAuth flow, no stored connection row, no auth breaker,
no reconnect button**. The former platform-managed `google_ads_connection`
singleton (in-app Connect/Reconnect OAuth, single-flight refresh, disconnect
forensics, synthetic `google_ads_oauth` credential history) was retired after
it died on 2026-07-27: the shared client-id/secret pair was repointed to the
Ads OS OAuth client, and a refresh token only redeems under the OAuth client
that minted it, so the stored token 401'd permanently. The table was dropped
in migration `20260807152551_drop_google_ads_connection.sql`.

**Accepted tradeoffs (deliberate):**
- **Single point of failure:** a rejected env credential stalls *every*
  Google Ads surface at once. The Integrations Hub card says exactly this.
- **Rotation is a secrets edit + restart** (no in-app reconnect) — see the
  runbook below.

### Rotation runbook (matching trio + restart)
A refresh token is bound to the OAuth client that minted it — rotating any
one value alone breaks the trio (Google answers `401 invalid_client` /
`unauthorized_client` for a client mismatch, `400 invalid_grant` for a dead
token).

1. In Google Cloud Console, use the **same OAuth client** for the client id
   and secret you intend to ship.
2. Mint a fresh refresh token **under that exact client** (OAuth consent →
   authorization code → token exchange with `access_type=offline`, scope
   `https://www.googleapis.com/auth/adwords`), authorizing the Google account
   that manages the MCC in `GOOGLE_ADS_LOGIN_CUSTOMER_ID`.
3. Update **all three secrets together**: `GOOGLE_ADS_CLIENT_ID`,
   `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`.
4. Restart the app (dev: restart the workflow; production: Publish /
   redeploy). Secrets are snapshotted per process — a running instance keeps
   the old values until restarted.
5. Verify: Integrations Hub → Google Ads card shows **Connected** and the
   env-credential lane shows **Healthy**; `GET
   /api/integrations/google-ads/status` returns `configured: true,
   connected: true`.

## Architecture
- **Token supply:** shared env-trio mint (`getEnvAccessToken()` in
  `server/services/adsOs/googleAdsClient.ts`). `getValidAccessToken()` in
  `server/services/googleAdsIntegration.ts` wraps it with the two terminal
  contracts below; nothing else talks to Google's token endpoint.
- **REST client:** `customers/{cid}/googleAds:searchStream`. Uses
  `developer-token` + `login-customer-id` headers from secrets.
- **Discovery:** `customers:listAccessibleCustomers`, then
  `customer_client` GAQL fan-out from the MCC.
- **Sync worker:** `google_ads_sync` queue, maintenance class, dedupe
  key `google_ads_sync:daily:<bucket>`. Scheduler ticks every
  `googleAdsSync.SCHEDULER_INTERVAL_MS` (default ~6h) from
  `server/index.ts`. Handler walks every customer where
  `sync_enabled = true` and writes campaign + keyword stats for the
  past `google_ads_lookback_days` (default 30).

### Terminal error contract
`getValidAccessToken()` throws exactly two auth-dead shapes (both mapped to
the structured `503 google_ads_disconnected` response by
`server/routes/googleAdsDisconnected.ts`):
- `"Google Ads not connected — the GOOGLE_ADS_* env secrets are incomplete
  (see GOOGLE_ADS.md)"` — one or more of the five secrets is missing.
- `"Google Ads credential rejected by Google: <detail> — rotate the
  GOOGLE_ADS_* secret trio and restart (see GOOGLE_ADS.md)"` — Google's
  token endpoint terminally rejected the trio (negative cache armed).

Transient mint failures (network blips, 5xx) are rethrown verbatim and must
NEVER masquerade as either terminal shape. Status/badge paths never POST to
Google's token endpoint (Task #4000 invariant) — they read env presence +
the mint's in-process snapshot only.

## Tables
- `google_ads_customers` — discovered customer accounts +
  `nobull_client_id` mapping + per-customer `sync_enabled`.
- `google_ads_campaigns` — daily campaign snapshots.
- `google_ads_keyword_daily_stats` — daily keyword snapshots.
- `google_ads_sync_runs` — per-run audit.

All are also created on demand by `ensureGoogleAdsTables()` so a fresh dev
workspace is not blocked behind migration application. (The former
`google_ads_connection` singleton was dropped —
`20260807152551_drop_google_ads_connection.sql`.)

## Secrets (required — all five)
- `GOOGLE_ADS_CLIENT_ID`
- `GOOGLE_ADS_CLIENT_SECRET`
- `GOOGLE_ADS_REFRESH_TOKEN` (minted under the same OAuth client as the
  id/secret pair — see the rotation runbook)
- `GOOGLE_ADS_DEVELOPER_TOKEN`
- `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (MCC id, digits only, e.g. `1234567890`)

If any are missing the Integrations Hub card renders a
**"Secrets Missing"** badge, `isGoogleAdsConfigured()` returns false, and
the worker short-circuits without calling the API. No Slack noise; no
API-pool waste. (`GOOGLE_ADS_REDIRECT_URI` is obsolete — there is no OAuth
callback anymore.)

## System settings / kill switches
- `google_ads_sync_enabled` (default `true`) — global kill switch for
  the daily worker. Flip to `"false"` to halt the sync.
- `google_ads_lookback_days` (default `30`) — how far back each daily
  run pulls campaign + keyword stats.

The worker also respects the global `KILL_SWITCH_NON_CRITICAL_SWEEPS`
and the queue-drain pause via the standard worker scheduler.

## Admin surface
- **Integrations Hub** (`/admin/integrations`) → "Google Ads" card:
  - One env-credential lane: configured / token-rejected / freshness
    (last Ads OS store write — `MAX(updated_at)` across the live `ads_os_*`
    stores; the retired legacy `google_ads_pacing_store` is NOT consulted
    and its orphaned prod copy stays frozen at 2026-07-17 until migration
    0138 drops it — see ADS_OS.md, Task #4036), naming every powered
    surface.
  - Badge: **Connected** / **Secrets Missing** / **Credentials Rejected**.
  - Buttons: **Discover Customers**, **Sync Now** (no Connect/Disconnect —
    rotation is a secrets edit, see runbook).
  - Recent customers list (with `nobull_client_id` mapping + per-row
    sync toggle, edited via `PATCH /api/integrations/google-ads/customers/:customerId`).
  - Recent sync runs (last 5).

## Stale-account prune (Task #2904)
- Discovery (`discoverAndUpsertCustomers`) flags every `google_ads_customers`
  row absent from the latest complete discovery set as `status = 'REMOVED'`
  (+ `sync_enabled = false`) via `markGoogleAdsCustomersRemoved`. Rows are
  kept, never deleted; `listGoogleAdsCustomers()` hides `REMOVED` rows by
  default (`{ includeRemoved: true }` shows them), so the account dropdown,
  Hygiene Audit accounts endpoint, and `listEnabledCustomerIds` all stop
  showing accounts that no longer exist under the MCC.
- Safety: the prune only runs when the discovery set is non-empty (a failed
  or empty discovery can never mass-flag live rows), and a re-appearing
  account is un-flagged automatically because the discovery upsert
  overwrites `status` with the live value.
- `REMOVED` is a NoBull-internal sentinel — Google's `CustomerClientStatus`
  enum is UNSPECIFIED / UNKNOWN / ENABLED / CANCELED / SUSPENDED / CLOSED
  (verified against the v21 `customer_client` field reference), so it can
  never collide with a live status written by discovery.
- Regression guard: `tests/google-ads-customer-prune.test.ts` (gated in
  `SMOKE_FILES`).

## Routes
| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/integrations/google-ads/status` | authenticated |
| GET | `/api/integrations/google-ads/customers` | account manager |
| POST | `/api/integrations/google-ads/customers/discover` | team lead |
| PATCH | `/api/integrations/google-ads/customers/:customerId` | team lead |
| POST | `/api/integrations/google-ads/sync-now` | team lead |
| GET | `/api/integrations/google-ads/sync-runs` | account manager |

(The OAuth-era `authorize` / `callback` / `disconnect` routes and the
`google-ads/credential-history` endpoint were removed in Task #4008.)

## Database pool tenancy
- `server/services/googleAdsIntegration.ts` is `// @db-pool-intent: mixed`
  — operator routes run on the API pool, the sync worker wraps writes
  with `runWithWorkerDb()` so persistence lands on the `worker` pool.
- DB holds never wrap external HTTP calls: every GAQL page is fetched
  outside the hold, then persisted in a short transaction.

## Observability
- Every outbound Google Ads HTTP call goes through `auditOutboundCall()`
  with `integration: "google_ads"` so it appears in the external-call
  audit + the admin `/admin/db-attribution/trends` Front-recovery /
  external-call panel (when `external_call_audit_enabled = true`).
- Per-run summary persisted in `google_ads_sync_runs` and surfaced in
  the Integrations Hub card.
- Historical note: the OAuth era's credential-clear breadcrumbs live in
  `admin_setting_audit` under the synthetic settingKey `"google_ads_oauth"`.
  Nothing writes or serves that key anymore; the rows remain for history.

## Failure modes
- **Secrets incomplete** → `isGoogleAdsConfigured()` false; hygiene/discover/
  sync routes answer the structured `503 google_ads_disconnected`; the card
  shows **Secrets Missing** listing all five secrets.
- **Google terminally rejects the trio** (`invalid_client` /
  `unauthorized_client` / `invalid_grant`) → the shared mint arms its
  negative cache (visible as the card's **Credentials Rejected** badge +
  `token_rejected` lane health with the verbatim detail); every surface
  fails fast with the rotation message until the secrets are fixed and the
  app restarts. Fix = rotation runbook above.
- **Transient token-endpoint blips** → rethrown as-is; callers retry next
  tick; never flips the card.
- **Per-customer GAQL fails** → captured in `google_ads_sync_runs` for
  that customer; sibling customers still sync.
- **`authorizationError:USER_PERMISSION_DENIED`** (Task #2902) → this is a
  **per-customer** "no link between the login MCC and this customer" error,
  classified `permission_denied`: that customer's `sync_enabled` is set
  false; it must NEVER be treated as a credential-level failure.
- **API version field renames** (Task #2902) → v23 removed
  `campaign.start_date`/`end_date` (now `start_date_time`/`end_date_time`);
  selecting a removed field fails every customer with
  `queryError:UNRECOGNIZED_FIELD` (zero data pulled) without touching auth.
  Guarded by `tests/google-ads-query-build.test.ts`. Also note
  `metrics.average_cpc` is a DOUBLE in micros — round before bigint insert
  (`tests/google-ads-conversion-mapping.test.ts`).

## Monitor-label mutate lane (Task #4964)

The env-trio credential lane is read-only everywhere **except** one narrow adapter:
`server/services/googleAdsLabelMutate.ts`. It can (a) create the
`NBM_GADS_MONITOR_CAMPAIGN` label in a client account (`customers/{cid}/labels:mutate`)
and (b) attach it to campaigns (`customers/{cid}/campaignLabels:mutate`), both via the
same REST version + env-trio headers as every read. It is invoked only by the
operator-gated prod action `apply_ads_os_monitor_labels` (manual lever — Apply-all skips
it, nothing schedules it), which targets only enrolled accounts whose active non-LSA
campaigns carry **zero** monitor labels; partially-labeled accounts are intentional
scoping and are never modified. The adapter is registered in the `google-ads` vendor
confinement baseline; the Ads OS directory itself stays mutate-guarded (see ADS_OS.md
"Read-only guard").

## Manual ops
- Flip kill switch: `UPDATE system_settings SET value='false' WHERE key='google_ads_sync_enabled';`
- Force a sync: `POST /api/integrations/google-ads/sync-now` (team lead).
- Re-discover: `POST /api/integrations/google-ads/customers/discover`.
- Rotate the credential: see the rotation runbook above (secrets edit +
  restart — there is no in-app disconnect/reconnect).
