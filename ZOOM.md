# Zoom

## Overview
Zoom is NoBull OS's primary video-meeting source. This runbook covers the non-recording Zoom surfaces: OAuth + granular scopes, meeting create/update (single + recurring), host overrides, the deterministic booking-to-recording match path, and the alert/backfill services that keep matching healthy.

Sibling runbooks own the rest of the Zoom surface:
- [ZOOM_REVIEW_QUEUE.md](./ZOOM_REVIEW_QUEUE.md) — manual review queue for non-deterministic recordings.
- [BOOKING_RECURRENCE.md](./BOOKING_RECURRENCE.md) — recurring-meetings booking + RRULE → Zoom translation, including the `static_link_fallback` path.
- [CALL_ANALYSIS.md](./CALL_ANALYSIS.md) — what happens to a recording after it's matched.

## Architecture

### Files
| File | Purpose |
| --- | --- |
| `server/services/zoomIntegration.ts` | OAuth, REST client, scope/auth fail-fast gates, meeting + recurring-meeting create, deterministic matching, webhook signature verification + CRC. |
| `server/services/zoomGuardrailConfig.ts` | Persistent list of common first names that demote weak name-only matches. |
| `server/services/zoomMessagesFeed.ts` | UI-facing decorated feed; resolves `agent_match_decisions`. |
| `server/services/zoomBackfillReeval.ts` | Re-evaluates historical auto-claims under updated policies. |
| `server/services/zoomReviewQueueBackfill.ts` | Retroactively enqueues missing review-queue rows. |

### Granular scopes
Zoom Granular Scopes (mandatory post-2024) required by NoBull OS. The canonical list lives in `getRequiredZoomScopes()` in `server/services/zoomIntegration.ts` — keep this section in sync with that function. Grouped by the surface that needs each scope:

**User reads (recording ingestion + admin user lookup)**
- `user:read:user:admin`
- `user:read:list_users:admin`

**Recording / transcript ingestion**
- `recording:read:recording:admin`
- `report:read:list_meeting_participants:admin`
- `cloud_recording:read:list_user_recordings:admin`
- `cloud_recording:read:list_recording_files:admin`

**Past-meeting participant lookup (call-analysis attribution)**
- `meeting:read:list_past_participants`
- `meeting:read:list_past_participants:admin`

**Booking-readiness list-meetings probe**
- `meeting:read:list_meetings:admin` — required by `GET /users/me/meetings`, the endpoint the booking readiness probe hits. Without it the scope gate engages immediately on a fresh OAuth reconnect with `Missing Zoom scopes for: users/me/meetings`.

**Booking CRUD (create/update/delete scheduled meetings)**
- `meeting:read:meeting:admin`
- `meeting:write:meeting:admin`
- `meeting:update:meeting:admin`
- `meeting:delete:meeting:admin`

Granted scopes are persisted in `zoom_granted_scopes` so readiness checks can verify what's available.

> Note: the legacy `recording:read:list_user_recordings:admin` and `recording:read:list_recording_files:admin` scopes are intentionally **not** in the list. Zoom replaced them with the `cloud_recording:*` variants above, and they are no longer selectable on Admin-managed apps created today.

### Fail-fast gates
Two circuit breakers keep Zoom outages from starving the worker pool:
- **Auth gate** — global block on 401/403; cleared on successful reconnect.
- **Scope gate** — per-endpoint-family block on "missing scope" 400/403 (e.g., only `/past_meetings/:id/participants` is blocked); other Zoom functions keep flowing.

### Host overrides
`resolveEffectiveZoomHostForUser` prefers `zoom_host_override_user_id` (validated at set time) over the OS user's email, so booking-side host resolution is deterministic.

### Deterministic matching (booking → recording)
The highest-priority match path: meetings created via the OS booking tool carry a `zoom_meeting_id` / `uuid` that the `recording.completed` handler matches against `scheduled_meetings`. A match stamps method `booked_in_app` with confidence 1.0 and bypasses every fuzzy or AI rule.

### Recurring meetings
- `createRecurringMeeting` translates iCal RRULEs into Zoom's subset (type-8).
- When the RRULE isn't representable (e.g., complex `BYSETPOS`), the integration emits `static_link_fallback` and the booking saga reuses a single Zoom URL across the series. See [BOOKING_RECURRENCE.md](./BOOKING_RECURRENCE.md).

### Webhooks
- `handleZoomWebhookEvent` performs HMAC-SHA256 signature verification against `ZOOM_WEBHOOK_SECRET_TOKEN`, handles CRC challenges, and ingests into a durable pipeline (`recording_completed`, `transcript_completed`).
- Task #3982 — the receiver accepts signatures from **either** configured Secret Token (`ZOOM_WEBHOOK_SECRET_TOKEN` primary, `ZOOM_S2S_WEBHOOK_SECRET_TOKEN` secondary) so both Marketplace apps can deliver during the S2S cutover overlap. CRC challenges are answered with the token that signed the challenge request itself (fallback: primary), so either app's endpoint validation passes.
- Downstream queues: `zoom_meeting_apply`, `zoom_transcript_apply`.

## Settings, env vars, and kill switches

| Name | Type | Default | Purpose |
|---|---|---|---|
| `ZOOM_CLIENT_ID` | env | — | OAuth client ID. |
| `ZOOM_CLIENT_SECRET` | env (secret) | — | OAuth client secret. |
| `ZOOM_REDIRECT_URI` | env | derived | OAuth callback. |
| `ZOOM_WEBHOOK_SECRET_TOKEN` | env (secret) | — | HMAC verification for inbound webhooks. Audit A-004: after the signature passes, the HMAC-bound `x-zm-request-timestamp` must be within ±5 minutes (`ZOOM_WEBHOOK_REPLAY_WINDOW_MS`, inclusive boundary) or the delivery is rejected 401 — replay protection on top of dedupe keys. CRC challenges are exempt (handled before the timestamp check). |
| `zoom_access_token`, `zoom_refresh_token`, `zoom_token_expires_at` | `system_settings` (secret) | — | Token storage. |
| `zoom_granted_scopes` | `system_settings` | — | Persisted granted scopes for readiness checks. |
| `zoom_oauth_state` | `system_settings` | — | OAuth CSRF protection. |
| `zoom_auth_mode` | `system_settings` | `oauth` | Auth mode: `oauth` (legacy user-level app) or `s2s` (Server-to-Server). Hot-toggleable; see § Server-to-Server OAuth. |
| `zoom_s2s_cutover_at` | `system_settings` | — | ISO timestamp of the last oauth→s2s flip (stamped by `setZoomAuthMode` on every transition into s2s). Starts the 72h retirement soak clock (§ Retirement). |
| `zoom_s2s_webhook_last_verified_at` | `system_settings` | — | ISO timestamp of the last non-CRC webhook delivery that verified via the **S2S app's** Secret Token (stamped by the receiver without a fabricated user actor, throttled to one write / 5 min). Only the S2S secret can produce it — the § Retirement "live webhook verified through the S2S app" evidence gate. |
| `ZOOM_S2S_ACCOUNT_ID` / `ZOOM_S2S_CLIENT_ID` / `ZOOM_S2S_CLIENT_SECRET` | env (secret) | — | Server-to-Server OAuth app credentials (separate Marketplace app; used only when `zoom_auth_mode=s2s`). |
| `ZOOM_S2S_WEBHOOK_SECRET_TOKEN` | env (secret) | — | The S2S app's webhook Secret Token, accepted as a SECONDARY signature/CRC secret during the cutover overlap (Task #3982). After legacy retirement, promote it into `ZOOM_WEBHOOK_SECRET_TOKEN` and unset this. |
| `zoom_common_first_names` / `ZOOM_COMMON_FIRST_NAMES` | `system_settings` / env | seed list | Guardrail dictionary for demoting weak name-only matches. |
| `zoom_comparative_reset_alert_slack_channel_id` | `system_settings` | — | RETIRED (Task #4177) — read by the deleted comparative-reset alert channel plumbing. Task #4202 verified no `system_settings` row exists (dev + prod) and the drop migration defensively deletes it; historical `admin_setting_audit` rows remain. |
| `booking_recurring_zoom_recurring_enabled` | `system_settings` (kill switch) | on | When off → forces `static_link_fallback` (see BOOKING_RECURRENCE.md). |

## Operational workflows

### Credential rotation / reconnect
1. From admin Integrations UI, click "Reconnect Zoom" — runs OAuth and overwrites the three token rows.
2. The auth gate clears automatically on the next successful call.
3. Verify by hitting `GET /users/me` via the admin "Test Zoom" surface (or look for fresh `zoom_meeting_apply` jobs succeeding).

### Webhook secret rotation
1. Set the new `ZOOM_WEBHOOK_SECRET_TOKEN` in env.
2. Reissue the Zoom app's webhook secret; both should overlap during the changeover window.
3. Confirm a `recording.completed` event verifies cleanly.

### Pause / disable
- Pause `zoom_meeting_apply` and `zoom_transcript_apply` via the queue-drain control.
- Flip `booking_recurring_zoom_recurring_enabled` off if you need to force every new recurring booking to the static-link fallback path.

### Backfills / re-evaluation
- `zoomBackfillReeval` re-scores historical auto-claims under updated policy (default 90-day window).
- `zoomReviewQueueBackfill` retroactively enqueues rows that should be in the review queue.
- The signals backfill is retired: Task #2637 deleted the `zoomReviewSignalsBackfill` service (it seeded telemetry for the removed AI matcher) and Task #5004 removed its leftover count route + admin card. Older review rows stay signal-less by design; the review UI presence-gates its signals section.

### Recovery from common failures
- **401/403 on Zoom calls** → auth gate trips globally; reconnect Zoom.
- **"missing scope" 400/403** → scope gate trips for the affected endpoint family. Add the scope on Zoom's app config and reconnect to refresh `zoom_granted_scopes`.
- **CRC challenge fails** → confirm `ZOOM_WEBHOOK_SECRET_TOKEN` matches the Zoom app's webhook secret.

## OAuth app rebuild

Recovery procedure for "the Zoom Marketplace OAuth app was deleted or needs to be rebuilt from scratch". This is the path the operator walked on 2026-05-19 after Marketplace lost the previous app; capture it here so the next rebuild does not require a planning session.

### 1. Create the Marketplace app

1. Go to [Zoom Marketplace](https://marketplace.zoom.us/) → **Develop → Build App**.
2. Pick **General App**.
3. On the app settings screen, switch the app type to **Admin-managed**. This is required — the `:admin` granular scopes only appear in the picker for Admin-managed apps. User-managed apps will silently hide the scopes we need and reconnect will fail with an unclear "missing scope" error later.

### 2. Configure OAuth

- **OAuth Redirect URL**: `https://reports.nobullmarketing.com/api/integrations/zoom/callback` — must match `ZOOM_REDIRECT_URI` byte-for-byte.
- **OAuth Allow List**: add the same URL.

### 3. Add the scope list

Add every scope returned by `getRequiredZoomScopes()` (also listed in § Granular scopes above). At time of writing this is the 13-scope set covering user reads, recording/transcript ingestion, past-meeting participant lookup, the booking-readiness list-meetings probe, and booking CRUD. Missing `meeting:read:list_meetings:admin` is the most common rebuild mistake — it engages the `users/me/meetings` scope gate immediately on first reconnect.

### 4. Configure Event Subscription (webhooks)

This lives under **Features → Access → Event Subscriptions**. **Do not** use **Connect → Incoming webhooks** — that surface is Resthooks and is the wrong primitive for this integration.

- **Endpoint URL**: `https://reports.nobullmarketing.com/api/integrations/zoom/webhook`
- **Authentication header option**: **Default Header Provided by Zoom**. The Secret Token is read from the **parent** Event Subscription header (not from any individual event subscription's overrides).
- **Subscribed events** (six total):
  - `meeting.started`
  - `meeting.ended`
  - `meeting.participant_joined`
  - `meeting.participant_left`
  - `recording.completed`
  - `recording.transcript_completed`

### 5. Set the four secrets in Deployments

All four must be set in **Deployments → Secrets** (workspace Secrets is for dev only — the production reconnect flow reads only Deployments secrets):

| Name | Value |
| --- | --- |
| `ZOOM_CLIENT_ID` | From the app's **App Credentials** page. |
| `ZOOM_CLIENT_SECRET` | From the app's **App Credentials** page. |
| `ZOOM_REDIRECT_URI` | `https://reports.nobullmarketing.com/api/integrations/zoom/callback` — must match the Marketplace OAuth Redirect URL byte-for-byte. |
| `ZOOM_WEBHOOK_SECRET_TOKEN` | The Secret Token from **Features → Access → Event Subscriptions** (parent header). |

### 6. Activate the app

Hit **Activation** in the Marketplace UI. Until the app is activated, the OAuth authorize endpoint returns `Invalid client_id (4,700)` and reconnect will fail with that exact error.

Privacy & Compliance fields and Marketplace listing assets are **not required** for a private Admin-managed app. Local Test in the Marketplace UI goes green without them.

### 7. Redeploy and reconnect

1. Trigger a production redeploy so the new Deployments secrets take effect.
2. As a Zoom account admin, open **Admin → Integrations Hub** in production and click **Reconnect Zoom**.
3. Approve the consent screen — every scope from step 3 should appear in the consent list.

### 8. Verification signals

- Integrations Hub Zoom card shows no amber "Missing Zoom scopes" banner and no Reconnect Required state.
- `SELECT value FROM system_settings WHERE key = 'zoom_granted_scopes';` returns every scope from `getRequiredZoomScopes()`.
- End a test cloud-recorded meeting. Within ~1 minute:
  - The webhook endpoint `/api/integrations/zoom/webhook` receives a `recording.completed` hit (visible in app logs).
  - A row lands in the Zoom review queue (`/admin/zoom/review`) — or, if the recording matches a booking, the deterministic `booked_in_app` auto-match path fires instead.

## Auth-gate auto-recovery from stale 401s (Task #1843)

The Zoom API client no longer engages the global auth gate on the first 401 it sees. Both `zoomApiRequest` and `zoomApiRequestWithBody` follow this flow:

1. Initial Zoom call returns 401.
2. The client forces a token refresh (`refreshAccessToken()`) and retries the call once.
3. If the retry succeeds → the operator sees nothing; clock-skew / 5-min lookahead races / brief Zoom-side revocations no longer surface as "Zoom disconnected" banners.
4. If the retry also returns 401 → the gate is engaged (operator visible).
5. If the refresh itself returns a **terminal** OAuth error → the gate is engaged AND the self-heal latch is set so the loop stops retrying refresh.

**Refresh-error classification** lives in `classifyZoomRefreshError(status, body)`:

| Body / status | Verdict | Why |
| --- | --- | --- |
| `{"error":"invalid_grant"}` | terminal | refresh token is dead — operator must reconnect |
| `{"error":"invalid_request"}` | terminal | malformed grant, won't fix on retry |
| `{"error":"unauthorized_client"}` | terminal | OAuth app credentials invalid |
| `{"error":"invalid_client"}` | terminal | OAuth app credentials invalid |
| `{"reason":"Invalid Token!"}` (400/401) | terminal | Zoom's non-OAuth-shaped variant of the same |
| Any other 4xx (non-429) | terminal | conservative: don't burn cycles on rejected refreshes |
| 429 | rate-limited | `refreshAccessToken()` honors `Retry-After` internally (capped 60s × 3) |
| 5xx / network | transient | next API call will try again on its own cadence |

**Self-heal loop.** While the gate is engaged AND the terminal latch is NOT set, `scheduleZoomAuthSelfHeal()` retries `refreshAccessToken()` on exponential backoff: **1m → 5m → 15m → 60m** (±10% jitter, capped at 60m). On success, `storeTokens()` → `clearZoomValidationBreaker()` → `clearZoomPermanentFailure()` nulls the gate and the loop stands down. The timer is `unref()`'d so it never holds the event loop open.

**Terminal latch.** When the refresh itself returns a terminal OAuth error, `zoomAuthRefreshTerminal` is set and the self-heal loop stops scheduling — re-issuing the same refresh would just keep failing. The latch is cleared by `clearZoomPermanentFailure(...)`, which fires from any successful `storeTokens()` (i.e. operator reconnect via `exchangeCodeForToken` or any successful refresh from another path).

**Refresh-token rotation.** `refreshAccessToken()` previously fell back to the stored refresh token when Zoom's response omitted `refresh_token`. That fallback was a footgun — Zoom rotates the refresh token on every successful refresh, so re-storing the old one guaranteed the next refresh failed with `invalid_grant`. The fallback now logs a loud `console.error` instead of silently re-storing. The rotated value is what gets persisted.

**Operator surface.** `getZoomAuthSelfHealState()` returns `{ scheduled, attempt, terminal }` so the Integrations Hub can show "self-healing — next attempt in N minutes" vs "operator reconnect required (invalid_grant)". The auth gate itself is still readable via `getZoomAuthGate()`.

**Regression test.** `tests/zoom-auth-recovery.test.ts` covers all five behaviors: classification table, 401→refresh-OK→retry-OK (gate untouched), 401→terminal refresh (gate + latch engaged), operator reconnect (gate + latch cleared), and 401→refresh-OK→retry-401 (gate engaged).

## Alerts and observability
- Review-queue alerts in [ZOOM_REVIEW_QUEUE.md](./ZOOM_REVIEW_QUEUE.md).

## Verification
- `SELECT count(*) FROM zoom_meetings WHERE created_at > now() - interval '1 day';` — non-zero on a normal day.
- Match success rate: `SELECT match_method, count(*) FROM zoom_meetings WHERE created_at > now() - interval '7 days' GROUP BY 1;` — `booked_in_app` should dominate for booking-driven traffic.
- Inspect `zoom_granted_scopes` after reconnect to confirm required scopes are present.

## Zoom token keep-alive

Deployment-gated, cluster-singleton scheduler (`server/services/zoomTokenKeepAliveScheduler.ts`) that proactively rotates the Zoom OAuth token before its ~1h draft-app refresh-token expiry so idle periods can't let it silently die.

- **Runs only in the deployment**: `startZoomTokenKeepAliveScheduler()` no-ops unless `isRunningInDeployment()` (dev override: `ZOOM_TOKEN_KEEPALIVE_FORCE_ENABLE`); uses `crossInstanceLock.ts` for cluster-wide singleton behavior.
- **Interval knob**: `system_settings.zoom_token_keepalive_interval_ms` (default `600000` / 10 min, clamped to a 1 min minimum).
- **Non-authoritative**: terminal failures are logged but never engage the sticky Zoom auth gate — a keep-alive failure is not an operator blocker.
- **Kill switch**: `system_settings.zoom_token_keepalive_enabled` (default `true`). Flip `false` to disable without a redeploy.
- **S2S mode**: when `zoom_auth_mode=s2s` the tick returns `skipped/s2s_mode` — there is no refresh-token chain to keep alive.

## Server-to-Server OAuth (Task #3973)

Alternative auth mode replacing the rotating user-level refresh-token chain with account-level tokens minted on demand (`grant_type=account_credentials`, TTL 1h, **no refresh token exists**). Zoom keeps multiple S2S mints concurrently valid, so each autoscale instance caches its own token with zero cross-process coordination. This removes the "one bad refresh strands the integration" failure class that the keep-alive + single-flight + cross-process-lease machinery defends the legacy mode against.

- **Mode flag**: `system_settings.zoom_auth_mode` — `oauth` (default) or `s2s`; hot-toggleable, read per call. An unreadable flag **throws** (probe → `probe_failed`, keep-alive → `transient_error`) rather than guessing: a silent fallback to `oauth` post-cutover would re-drive the parked legacy chain into terminal `invalid_grant` and engage the auth gate.
- **Credentials**: the three `ZOOM_S2S_*` env secrets (separate Marketplace app; the legacy `ZOOM_CLIENT_ID`/`ZOOM_CLIENT_SECRET` pair stays untouched).
- **Same rails as oauth mode**: mint failures classify through the shared terminal/transient classifier; a terminal mint on an authoritative call engages the sticky auth gate; probes stay non-authoritative (`zoom_probe`); 401 retry-once, 429 Retry-After, scope gates, and self-heal are unchanged.
- **`me` context**: S2S tokens cannot call `/users/me...` — `validateConnection` probes the users list instead, and `checkBookingScopeReadiness` resolves a concrete user id for its per-user probes.
- **Scopes**: the § Granular scopes list with every entry in its account-level `:admin` form (S2S apps have no per-user consent; `meeting:read:list_past_participants` collapses into its `:admin` variant). One rename: S2S-era apps grant `cloud_recording:read:recording:admin` in place of the legacy `recording:read:recording:admin` (`ZOOM_S2S_SCOPE_RENAMES`; verified empirically — both pipeline recording endpoints answer 200 under the new name). Granted scopes persist to `zoom_granted_scopes` on mint, written only when changed.

### Setup (S2S app creation)
1. Zoom Marketplace → Develop → Build App → **Server-to-Server OAuth** app (separate from the user-level OAuth app; both can coexist). Watch the app-type trap: Zoom's builder pushes "General App" (user-level OAuth — asks for an OAuth Redirect URL) front and center; the S2S type is under the smaller "Other app types" surface. The S2S credentials page shows **Account ID + Client ID + Client Secret** — no Account ID means wrong app type.
2. Add the `:admin` scope list (see § Granular scopes) and activate the app.
3. Set `ZOOM_S2S_ACCOUNT_ID` / `ZOOM_S2S_CLIENT_ID` / `ZOOM_S2S_CLIENT_SECRET` / `ZOOM_S2S_WEBHOOK_SECRET_TOKEN` (the app's Secret Token, Feature tab) in Deployments secrets and redeploy — deployments snapshot env at build (see § 5 note on stale secret snapshots).
4. **Event subscription on the S2S app** (webhooks must move here before the legacy app is deactivated — deactivation kills its event feed): Feature tab → enable Event Subscriptions → same six events as § 4 of the OAuth rebuild, endpoint URL `https://reports.nobullmarketing.com/api/integrations/zoom/webhook`, receiver "All users in your account". Click **Validate only after** step 3's redeploy is live — the receiver answers CRC with whichever configured token signed the challenge (Task #3982 dual-secret), so validation fails until the deployment knows the S2S token. Both apps double-deliver during the overlap; dedupe keys absorb it.

### Staged cutover
1. `GET /api/integrations/zoom/auth-mode` (team-lead) — confirm mode + `s2sCredentialsPresent: true`.
2. `GET /api/integrations/zoom/s2s/preflight` — mints a token, checks scope parity and API reachability **without touching live auth state** (safe while oauth mode serves traffic). Fix `missingScopes` in the Marketplace app until `ready: true`.
3. **Flip** — primary surface: the CEO panel's `zoom_s2s_auth_mode_cutover` prod action (Admin → Integrations Hub → Prod actions, Task #4019) runs the same preflight and flips only on `ready: true`. Route equivalent (team-lead): `POST /api/integrations/zoom/auth-mode` with `{"mode":"s2s"}` — refused 409 unless the preflight is ready (`"force":true` is the break-glass override). Both surfaces share `applyZoomAuthModeChange`: the flip clears gates/breakers, stamps `zoom_s2s_cutover_at` (retirement soak clock), invalidates the status cache, and (re)starts auto-sync. After an operator rollback the prod action parks itself — re-cutover is route-only.
4. Verify: integrations badge green, fresh `zoom_meeting_apply` jobs succeed, keep-alive tick logs `skipped/s2s_mode`, `[Zoom Webhook] Ingested` lines at non-reconciliation hours (real-time feed restored), `zoom_s2s_webhook_last_verified_at` advancing, and § Verification queries stay healthy across a sync cycle.

### Rollback
Primary surface: the CEO panel's `zoom_s2s_rollback_to_oauth` **manual lever** (Admin → Integrations Hub → Prod actions → Manual levers, Task #4019). Levers are excluded from the Apply-all pass — a pending rollback riding along with a routine Apply-all press would bounce the mode straight back — so the lever fires only via its own confirm-gated button (`POST /api/admin/prod-actions/zoom_s2s_rollback_to_oauth/apply`). Route equivalent (team-lead): `POST /api/integrations/zoom/auth-mode` with `{"mode":"oauth"}`. Both run the same shared helper with deliberately NO preflight (rollback must work exactly when S2S is broken). S2S mode never wipes the legacy token store, but the draft-app refresh chain lapses ~1h unattended — expect one operator reconnect (§ Credential rotation) right after rolling back; once § Retirement has cleared the token rows the reconnect is REQUIRED. After any rollback the flip action parks itself — re-cutover is route-only.

### Retirement (only after s2s is proven in production)
**Database step** — the CEO panel's `retire_legacy_zoom_oauth_tokens` prod action (Task #4019) clears the three legacy token rows (`zoom_access_token` / `zoom_refresh_token` / `zoom_token_expires_at`; `zoom_granted_scopes` survives — s2s mints still write it). It self-gates on all three of: `zoom_auth_mode=s2s`, ≥72h since `zoom_s2s_cutover_at`, and a `zoom_s2s_webhook_last_verified_at` stamp ≤7d old — the stamp is written by the receiver only when a non-CRC delivery verifies against the **S2S** Secret Token, so it is exactly the "live webhook verified through the S2S app" proof this step has always required (deactivation stops the legacy app's webhook feed). Keep-alive can stay enabled — it self-skips in s2s mode. Task #4762 enrolled this action in the prod-action self-heal scheduler (6h cadence / 6h backoff): once the triple gate passes, an upcoming scheduled pass presses it automatically — after the operator reconnect, the soak clock and the retirement complete with **no further press**. While any gate is unmet the action reads `blocked` (amber during the soak is by design); an early scheduled press settles harmlessly against the same gates.

**Manual remainder** (after the action applies): deactivate the user-level Marketplace app — never delete it, and never use the in-app disconnect route (it also stops reconciliation). Then move the S2S Secret Token into `ZOOM_WEBHOOK_SECRET_TOKEN`, unset `ZOOM_S2S_WEBHOOK_SECRET_TOKEN`, and redeploy (single-secret steady state). Clearing the token rows removes the instant rollback path — a later rollback to oauth needs one operator reconnect, which § Rollback already expects.

## Related runbooks
- [ZOOM_REVIEW_QUEUE.md](./ZOOM_REVIEW_QUEUE.md)
- [BOOKING_RECURRENCE.md](./BOOKING_RECURRENCE.md)
- [CALL_ANALYSIS.md](./CALL_ANALYSIS.md)
- [WORKERS_QUEUES_RUNBOOK.md](./WORKERS_QUEUES_RUNBOOK.md)
- Back to [RUNBOOKS.md](./RUNBOOKS.md) Runbook Index.

## Related Task # history
- Task #993 — route all non-deterministic recordings to manual review (see ZOOM_REVIEW_QUEUE.md).
- Task #996 — bulk-action endpoints + trend snapshot for the review queue.
- Task #1032 / #1044 — recurring-meeting RRULE translation and the five booking kill switches (see BOOKING_RECURRENCE.md).
- Task #3973 — Server-to-Server OAuth mode (`zoom_auth_mode`), staged cutover + rollback (§ Server-to-Server OAuth).
