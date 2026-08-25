# Integration Keep-Alive Runbook

Canonical reference for proactive OAuth/token keep-alive schedulers. An integration keep-alive rotates a short-lived token before it expires during quiet periods so background sync workers never stall for want of a valid credential.

---

## Background — the Jul 1–15 2026 outage

SEMrush OAuth tokens (Device Flow) expire after 7 days (access token) or 30 days (rotating refresh token). On a deployment with no incoming SEMrush API traffic for longer than 7 days the access token silently expired. The local-dominance sweep then failed with `SemrushAuthMissingError` on every location, marking every integration row `paused_auth` and halting fleet-wide heatmap / Local Dominance sync for 15 days. No keep-alive existed for SEMrush; the Zoom keep-alive (Task #2740) was the only proactive rotator, and its pattern was not extended to other integrations.

---

## Integration keep-alive audit

| Integration | Token type | Access-token life | Rotating refresh? | Keep-alive needed? | Keep-alive implemented? |
|---|---|---|---|---|---|
| **Zoom** (Draft OAuth app) | OAuth 2.0 PKCE | ~1 h (Draft app cutoff) | Yes (~1 h) | **Yes** | ✅ `zoomTokenKeepAliveScheduler` — 10 min tick |
| **SEMrush** (Device Flow) | OAuth 2.0 Device | 7 days (access) / 30 days (refresh, rotating) | Yes (on every refresh) | **Yes** | ✅ `semrushTokenKeepAliveScheduler` — 6 h tick |
| **Front** | OAuth 2.0 Authorization Code | 6 months (rotating) | Yes (last 24 h of window) | **No** — demand-refresh via ingestion pipeline keeps it fresh; 6-month window provides ample headroom | — |
| **Google** (Calendar / Drive / Ads) | OAuth 2.0 offline | Long-lived (offline_access) | **No** — Google does not rotate refresh tokens on standard offline flows | No | — |
| **Twilio** | Static credentials (SID + AuthToken / API Key) | Never expire | No | No | — |
| **Stripe** | Static API key | Never expire | No | No | — |
| **SendGrid** | Static API key | Never expire | No | No | — |
| **PandaDoc** | Static API key | Never expire | No | No | — |
| **Rev.ai / Rev.com** | Static API key | Never expire | No | No | — |
| **TwelveLabs** | Static API key | Never expire | No | No | — |
| **MapTiler** | Static API key | Never expire | No | No | — |

**Conclusion**: only Zoom and SEMrush need proactive keep-alives. Front's 6-month rotating window is always exercised by normal pipeline traffic; a keep-alive would be over-engineering.

---

## SEMrush keep-alive (`semrushTokenKeepAliveScheduler`)

### What it does
Every 6 h (configurable via `semrush_token_keepalive_interval_ms`) it calls `runSemrushTokenKeepAliveTick()` in `semrushApi.ts`. Each tick:
1. Checks the kill switch (`semrush_token_keepalive_enabled`, default ON).
2. Skips if the auth-dead breaker is already open (operator reconnect is the only path forward).
3. Reads the stored expiry timestamp (`semrush_token_expires_at`, epoch ms) **and** the last-refreshed timestamp (`semrush_token_last_refreshed_at`, epoch ms).
4. Rotates if **either** of the following is true:
   - The access token is within **48 h** of expiry (expiry-window criterion), OR
   - The token has been alive for ≥ **3.5 days** since last rotation (age-based criterion — see Task #3666).
5. Returns a typed result (`refreshed` / `transient_error` / `terminal_error` / `skipped:<reason>`).

### Age-based criterion (Task #3666)
`semrush_token_last_refreshed_at` is written on every successful token persist (both `refreshOnce` success and `pollDeviceToken` success). If the setting has never been written (pre-Task #3666 deployments), the tick derives the issue time as `expiresAt − 7 days` (the fixed access-token lifetime). Rotating at 3.5-day age means the token is always rotated at most halfway through its 7-day life, so a single missed tick is never catastrophic.

### Lease-recheck bypass for proactive rotation (Task #3666)
A second latent no-op hid behind the endpoint bug: `refreshAccessToken`'s cross-process-lease
recheck (`onLeaseAcquiredRecheck`) returned the stored access token whenever it was unexpired —
correct for **on-demand** callers (reuse what a sibling just rotated), but fatal for the
keep-alive: in production the lease is *always* held, so every proactive tick short-circuited
with `lease_skip_fresh` and **never POSTed a rotation** until the token was already ≤60 s from
death. This matches prod forensics: proactive POSTs only appeared on Jul 24, *after* the access
token had expired — the 48h-window ticks on Jul 22–23 silently no-opped.

The tick now passes `proactiveRotation: true`, which keeps the lease serialization but replaces
the "access token unexpired → skip" fast path with a sibling-just-rotated guard: the POST is
skipped only when `semrush_token_last_refreshed_at` is within the last 10 minutes
(`SEMRUSH_PROACTIVE_SIBLING_ROTATION_SKEW_MS`), i.e. a sibling instance completed a rotation
while we waited on the lease. On-demand/authoritative callers keep the original fast path.

The same fast path also broke **reactive-401 recovery**: a live API call that got a 401 would
ask for a refresh, the recheck would see the stored (rejected!) token as "unexpired" and hand
it straight back — a 401-loop with zero refresh POSTs. The 401 path now threads the rejected
bearer (`rejectedAccessToken`) into the refresh; the recheck reuses a stored token only when it
**differs** from the rejected one (a sibling rotated while we waited on the lease).
Contract locked in by `tests/semrush-keepalive-rotation-contract.test.ts`.

### Non-authoritative design
The keep-alive uses `purpose: "proactive"` — `isAuthoritativeRefreshPurpose("proactive")` is false. A terminal refresh failure here **does NOT wipe credentials or trip the auth-dead breaker**. Only the on-demand `getAccessToken` path (triggered by real API calls) may do that. This prevents a rotation-race false-trip from engaging the breaker during a quiet period.

### Alerting on terminal failure
A `terminal_error` result fires `integration.semrush.keepalive_terminal` via `notifyByType`. This fans out:
- In-app admin inbox (responsible CEO / team-lead users).
- Slack to the configured `integration.semrush.keepalive_terminal` channel (configurable in Admin → Notifications).

### Deployment gate
Only runs in `isRunningInDeployment() === true` (or when `SEMRUSH_TOKEN_KEEPALIVE_FORCE_ENABLE=1`). The dev workspace holds dev DB tokens that are meaningless to rotate proactively; only the prod deployment holds the live credentials.

### Cross-instance singleton
Each tick acquires the `semrush_token_keepalive` Postgres advisory lock via `withWorkerSingletonLock`. Only one autoscale instance rotates per tick; concurrent rotations would race the rotating refresh-token chain. The lock self-heals if the holder crashes.

### Kill switch
Set `semrush_token_keepalive_enabled = false` in system_settings to disable. Fails open: a read error leaves it **enabled** (a config blip must not silently stop rotation).

### Manual override / force-enable
Set `SEMRUSH_TOKEN_KEEPALIVE_FORCE_ENABLE=1` env var to run the scheduler in the workspace / CI.

### Default interval
`semrush_token_keepalive_interval_ms` system setting, default **21600000** (6 h). Minimum enforced: 60000 (1 min). Tune via Admin → System Settings without a redeploy.

### One-press rotation (CEO prod-action)
The `semrush_keepalive_rotate_now` prod-action in the Admin → "Apply pending prod writes" panel lets the CEO force a single keep-alive tick immediately (bypassing the freshness / age checks). It runs the same non-authoritative path as the scheduler, so a failure does NOT wipe tokens. Use it after a publish to confirm the refresh endpoint is functioning and to advance the token ahead of the expiry window.

---

## SEMrush refresh endpoint — verified contract and post-mortem

### What was wrong (Jul 2026 post-mortem)
`refreshOnce` in `server/services/semrushApi.ts` was POSTing `grant_type=refresh_token` to **`https://oauth.semrush.com/dag/device/token`** — the device-flow token endpoint. That endpoint only accepts `grant_type=urn:ietf:params:oauth:grant-type:device_code`. Every refresh attempt returned HTTP 400 `{"error":"invalid_request"}`.

Prod forensics (Jul 24 2026): 18/18 refresh attempts (probe + proactive keep-alive) returned HTTP 400 `invalid_request`. On Jul 25 00:10 the authoritative expiry path fired the same failing POST, classified it as terminal, and wiped the stored tokens. The operator reconnected Jul 29 16:01 UTC. The same bug had likely caused every previous weekly reconnect.

### What the correct endpoint is
Per SEMrush docs (`developer.semrush.com/api/v4/get-started/authorization/`, last updated Jul 27 2026), `grant_type=refresh_token` is documented for the **Semrush Auth** (Authorization Code) flow at:

```
POST https://oauth.semrush.com/oauth2/access_token
Content-Type: application/x-www-form-urlencoded

client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET&grant_type=refresh_token&refresh_token=<token>
```

The code now uses `OAUTH_REFRESH_URL = "https://oauth.semrush.com/oauth2/access_token"` for all `grant_type=refresh_token` calls.

### Device-flow refresh limitation (live investigation, Jul 30 2026)
We issued a fresh Device Flow token (user code `GSYE-MMHW`, approved by the operator) and tested the following refresh shapes against SEMrush's live OAuth server:

| Endpoint | Parameters | HTTP result |
|---|---|---|
| `/dag/device/token` | `grant_type=refresh_token&refresh_token=…` | 400 `{"error":"invalid_request"}` |
| `/oauth2/access_token` | `grant_type=refresh_token&refresh_token=…` (no creds) | 400 "Check the 'client_id' parameter" |
| `/oauth2/access_token` | + any credential guess (access_token as client_id, etc.) | 401 HTML |
| `/dag/device/token` | `grant_type=device_code&device_code=<refresh_token>` | 400 `{"error":"expired_token"}` |

**Conclusion**: SEMrush Device Flow tokens cannot be refreshed programmatically without a registered Semrush Auth app (`client_id` + `client_secret`). The Device Flow is explicitly designed for apps that have no client credentials; the `/oauth2/access_token` refresh endpoint requires them.

The keep-alive tick will now POST to the correct endpoint (`/oauth2/access_token`), which produces an informative `invalid_request` error with the exact missing parameter, rather than the opaque 400 from the device-flow endpoint. The endpoint change is still important for future compatibility: when/if SEMrush grants the app a `client_id` + `client_secret` (via the standard Semrush Auth flow), the code will work without further changes to the endpoint constant.

### How to obtain `client_id` / `client_secret` (confirmed from docs, Jul 30 2026)
SEMrush's authorization docs state it explicitly under **Semrush Auth → Step 1. Get code**:

> "Contact the Semrush Tech Support to obtain your `client_id` and `client_secret`."

There is **no self-service app-registration page** — credentials are issued only through a
[Semrush Tech Support](https://www.semrush.com/kb/support/) request. The docs' refresh example
matches our implementation exactly (`client_id` + `client_secret` + `grant_type=refresh_token` +
`refresh_token` → `POST /oauth2/access_token`, response = rotated pair with `expires_in=604800`).

Operator playbook once credentials arrive:
1. Set Replit Secrets `SEMRUSH_CLIENT_ID` and `SEMRUSH_CLIENT_SECRET` (both dev and deployment).
2. Republish (deployment env is snapshot-frozen; see "Deployment-frozen secret rotation" below).
3. Press **Rotate Now** (`semrush_keepalive_rotate_now`) on the CEO prod-actions surface — a
   200 with a rotated pair proves the treadmill is over. No code change needed.

In the support request, ask:
1. For a `client_id` / `client_secret` for the NoBull Map Rank Tracker integration (Semrush Auth flow).
2. Whether those credentials can refresh **Device Flow–issued** refresh tokens at `/oauth2/access_token`,
   or whether the app must reconnect once via the Semrush Auth (authorization-code) flow to mint a
   refreshable token pair.

Until credentials arrive, the weekly reconnect treadmill continues (tokens expire at 7 days with no
programmatic refresh). The keep-alive + prod-action now surface the exact error so the operator can
track the issue.

> **RESOLVED (Task #3670, Jul 31 2026):** the OAuth refresh saga is over. SEMrush support pointed at
> **v4 API-key authorization** (`Authorization: Apikey <KEY>`), and a live probe proved it works on
> the Map Rank Tracker API despite the docs claiming that API is Bearer-only. The app now runs in
> **API-key mode** whenever the `SEMRUSH_V4_API_KEY` Replit Secret is set; the entire OAuth device-flow
> machinery below is a dormant fallback. See the next section.

---

## SEMrush v4 API-key mode (Task #3670) — the resolution

### Verified auth contract (probe evidence, Jul 31 2026)
Read-only GETs from this workspace with header `Authorization: Apikey <SEMRUSH_V4_API_KEY>`:

- `GET /apis/v4/map-rank-tracker/v0/campaigns?size=1` → **HTTP 200**, real campaign data
  (request_ids `api-flb-54cdee6896f2c8d00405e888f986b60f`, re-probe `api-flb-f950ccbfed5a1d22486f60e4c617b28b`)
- `GET /apis/v4/map-rank-tracker/v0/campaigns/{id}/keywords` → **HTTP 200** (request_id `api-flb-5d5efbb2bc76ff9fd5b7041794a5da97`)
- `GET .../heatmap?keywordId=…` without `reportDate` → **HTTP 400 "Invalid value for 'reportDate' provided"**
  — a validation error, i.e. **auth was accepted**; heatmap calls must pass a valid `reportDate` (the app already does)
- Control: `GET /apis/v4/local/v1/locations?size=1&page=1` (Listing Management) → **HTTP 200**

**The docs lag reality**: `developer.semrush.com` says Map Rank Tracker is Bearer-only, but the API key
works. Do not re-derive this — if a future probe contradicts it (e.g. key permissions changed), that is
a support escalation, not a code bug.

### How key mode works
- `server/services/semrushAuthMode.ts` is the single source of truth: `isSemrushKeyMode()` is true when
  the `SEMRUSH_V4_API_KEY` secret is set (and not under `NODE_ENV=test` / `TEST_SMOKE`, so existing
  OAuth-path tests keep their semantics; tests can force either mode via `__setSemrushKeyModeOverrideForTest`).
- In key mode the shared request path (`apiGetInner` in `semrushApi.ts`) sends `Authorization: Apikey …`
  and performs **no OAuth token reads, refreshes, or expiry checks**.
- **Dormant in key mode**: the keep-alive scheduler (start + tick), the auth-dead breaker
  (`semrushAuthBreakerActive()` hard-false, `tripSemrushAuthBreaker()` no-op), the global disconnect
  alert, and `paused_auth` (the sweep sees `hasSemrushAccessToken()`/`isConfigured()` true). Stale OAuth
  state can never fire "Reconnect Required" while the key is set.
- A key-mode **401/403 is a key problem** (`SemrushApiKeyRejectedError`): rotate/fix the
  `SEMRUSH_V4_API_KEY` secret. It never triggers an OAuth wipe or device-flow prompt.
- Connection status = key presence + a cached live probe (`campaigns?size=1`); the Hub card and the
  SEMrush admin console show an explicit "API key" badge plus the last successful key-authenticated call
  (`semrush_api_key_last_success_at`, persisted at most every 5 min).
- **Fallback**: with the secret absent, everything reverts to the OAuth device flow exactly as documented
  in the sections above/below.
- **Rotation**: set the new key in Replit Secrets (workspace + deployment) and republish — deployment
  env is snapshot-frozen, so the republish is what makes the new key take effect.

---

## Zoom keep-alive (`zoomTokenKeepAliveScheduler`)

### What it does
Every 10 min (configurable via `zoom_token_keepalive_interval_ms`) it calls `runZoomTokenKeepAliveTick()` in `zoomIntegration.ts`. Each tick rotates the access token when it is within **20 min** of expiry. Zoom's Draft OAuth app invalidates refresh tokens ~1 h after issue, so a quiet-period gap of >1 h without a rotation causes `invalid_grant` on the next real Zoom call.

### Non-authoritative design
Same as SEMrush: `purpose` is not set (defaults to non-authoritative). A `terminal_error` result does NOT engage the `zoomAuthGate` sticky latch.

### Alerting on terminal failure
A `terminal_error` result fires `integration.zoom.auth_failed` via `notifyByType` (in-app + Slack). Dedupe key: `zoom.keepalive.terminal` — suppresses repeat alerts for the same outage streak.

### Kill switch / deployment gate / singleton
Same pattern as SEMrush. Kill switch: `zoom_token_keepalive_enabled`. Force enable: `ZOOM_TOKEN_KEEPALIVE_FORCE_ENABLE=1`.

---

## Slack channel_not_found self-alert

### Problem
When a Slack notification delivery fails with `channel_not_found`, the delivery is silently recorded as `failed` in `notification_deliveries`. No alert tells the admin that their Slack routing is misconfigured. Since all other alerts route through Slack, a misconfigured channel causes ALL alerts to fail silently.

### Fix
`dispatcher.ts` detects `channel_not_found` / `not_in_channel` errors in the Slack send catch block and fans an **in-app** admin notification directly (bypassing Slack) to all responsible CEO/team-lead users. Rate-limited: at most once per 6 h per channel ID to avoid inbox flooding on high-frequency notifications.

The in-app mirror for the original notification was already sent before the Slack attempt, so the original alert content still reaches admins; this is an additional meta-notification about the delivery system itself.

### Resolution
1. Go to Admin → Notifications.
2. Find the notification whose Slack channel is misconfigured.
3. Update the channel ID to a valid Slack channel where the bot is a member.
4. Send a test delivery to confirm.

---

## Incident playbook — SEMrush token expiry

> **Only applies in OAuth fallback mode** (no `SEMRUSH_V4_API_KEY` secret). In key mode nothing expires;
> a 401/403 means the key itself is invalid/revoked — rotate the secret and republish.

1. **Symptom**: heatmap / Local Dominance sync jobs set `paused_auth` on all rows; the Integrations Hub shows SEMrush as "Reconnect Required".
2. **Distinguish expiry from rotation-race**: if `semrush_access_token` and `semrush_refresh_token` are both empty in system_settings, the authoritative path wiped them on a confirmed terminal failure → genuine expiry. If tokens are present but `paused_auth`, the breaker tripped on a transient failure → check the auth-dead breaker state via `/api/integrations/all-status`.
3. **Reconnect**: Admin → Integrations Hub → SEMrush → Re-authorize (Device Flow).
4. **Clear paused_auth**: after reconnect, the next local-dominance sweep automatically calls `recoverPausedAuthRows()` and resumes sync.
5. **Verify keep-alive**: check the Integrations Hub SEMrush card → "Token keep-alive" heartbeat line. If the last run shows `terminal_error`, the refresh endpoint is rejecting the call (see the device-flow limitation above). Use the Admin → "Apply pending prod writes" → "Rotate SEMrush token now" action to trigger an on-demand tick and inspect the error detail.

---

## Env var / system setting index

| Setting | Type | Default | Effect |
|---|---|---|---|
| `SEMRUSH_V4_API_KEY` | Replit Secret | unset | **Key mode**: all SEMrush calls use `Authorization: Apikey`; OAuth machinery dormant |
| `semrush_api_key_last_success_at` | system_settings | unset | Epoch-ms of last successful key-authenticated call (persisted ≤ every 5 min) |
| `semrush_token_keepalive_enabled` | system_settings | `true` (absent = ON) | Disable SEMrush keep-alive (already dormant in key mode) |
| `semrush_token_keepalive_interval_ms` | system_settings | `21600000` (6 h) | Tick interval |
| `semrush_token_last_refreshed_at` | system_settings | unset (derives from expiresAt−7d) | Epoch-ms of last successful token rotation; drives age-based criterion |
| `SEMRUSH_TOKEN_KEEPALIVE_FORCE_ENABLE` | env var | unset | Run in workspace / CI |
| `zoom_token_keepalive_enabled` | system_settings | `true` (absent = ON) | Disable Zoom keep-alive |
| `zoom_token_keepalive_interval_ms` | system_settings | `600000` (10 min) | Tick interval |
| `ZOOM_TOKEN_KEEPALIVE_FORCE_ENABLE` | env var | unset | Run in workspace / CI |
