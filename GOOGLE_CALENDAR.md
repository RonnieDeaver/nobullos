# Google Calendar

## Overview
Google Calendar is the AM-facing scheduling source for the native booking tool. Each Account Manager connects their own Google account; NoBull OS reads free/busy windows to compute availability and writes events when clients book, edit, or cancel. Recurring-meeting management piggy-backs on Google's recurrence semantics.

## Architecture

### File
`server/services/googleCalendarIntegration.ts` — OAuth, token encryption, free/busy reads, event create/update/delete, recurrence handling.

### OAuth + token storage
- Per-AM OAuth2 flow using `google-auth-library`.
- HMAC-signed `state` (with a per-user nonce in `google_calendar_oauth_nonce:<userId>`) to prevent CSRF.
- Tokens (access + refresh) are encrypted at rest with AES-256-GCM, keyed by `TOKEN_ENCRYPTION_KEY`.

### Scopes
- `https://www.googleapis.com/auth/calendar.readonly` — free/busy.
- `https://www.googleapis.com/auth/calendar.events` — manage NoBull-created events.
- `openid`, `email`, `profile` — identity.

### Event lifecycle
- **Booking** → insert event with attendees + conference data.
- **Cancellation** → delete (or `status: "cancelled"` for a single recurring instance).
- **Availability** → `freebusy` query against the AM's primary calendar; result feeds the booking-page availability surface.
- **`sendUpdates`** — `"all"` / `"externalOnly"` / `"none"` are surfaced to control whether Google emails attendees.

### Recurrence (interacts with [BOOKING_RECURRENCE.md](./BOOKING_RECURRENCE.md))
- `this_event` → cancel a single instance (`status: "cancelled"`).
- `this_and_following` → truncate the series by updating the master `RRULE` with an `UNTIL` date.
- `entire_series` → delete the master event.
- `google_series_split` → truncate the master and create a new sibling series for the chosen instance and forward.

## Settings, env vars, and kill switches

| Name | Type | Default | Purpose |
|---|---|---|---|
| `GOOGLE_CALENDAR_CLIENT_ID` | env | — | OAuth client ID. |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | env (secret) | — | OAuth client secret. |
| `GOOGLE_CALENDAR_REDIRECT_URI` | env | derived from Replit domain | OAuth callback. |
| `TOKEN_ENCRYPTION_KEY` | env (secret) | — | AES-256-GCM key for token-at-rest encryption. **Rotating this invalidates all stored Calendar tokens — every AM must reconnect.** |
| `google_calendar_oauth_nonce:<userId>` | `system_settings` | — | Per-user CSRF nonce. |

Storage rows: per-user encrypted token rows accessed via `storage.getGoogleCalendarCredential(...)`.

Recurrence behavior is additionally gated by the five booking kill switches documented in [BOOKING_RECURRENCE.md](./BOOKING_RECURRENCE.md).

## Operational workflows

### Per-AM reconnect
1. AM opens their Booking settings page → "Reconnect Google Calendar".
2. OAuth handshake completes; new tokens are encrypted and stored.
3. The booking-page availability surface starts returning fresh free/busy data within one refresh cycle.

### Credential rotation
- **Client secret rotation** → update `GOOGLE_CALENDAR_CLIENT_SECRET`. Existing refresh tokens continue to work (the secret is only required when exchanging codes/refreshing).
- **`TOKEN_ENCRYPTION_KEY` rotation** → DESTRUCTIVE. Every AM must re-OAuth. Coordinate with the team before rotating.

### Pause / disable
- There is no app-wide "disable Google Calendar" kill switch. To pause a single AM's calendar effects, disconnect them in the admin UI (clears their stored credential row).
- To force every new recurring booking off Google's recurrence path, flip the relevant booking recurrence kill switch (see [BOOKING_RECURRENCE.md](./BOOKING_RECURRENCE.md)).

### Recovery from common failures
- **`invalid_grant` on refresh** → the AM revoked access or changed Google password. Have them reconnect; their stored credential will be replaced.
- **403 on availability** → scope drift. Reconnect to re-consent.
- **Event duplicated on Google side** → confirm the booking saga didn't retry past success; idempotency keys are on the booking row, not the Google event ID, so manual cleanup on Google's side may be required.
- **`sendUpdates` not behaving** → confirm the caller is passing the value through correctly; default behavior is `"externalOnly"`.

## Alerts and observability
- No dedicated alerter today; failures surface as booking-page errors (free/busy fetch failed) or via the booking-saga error log.
- The recurring-meetings verification harness (`scripts/verify-recurring-meetings.ts`) exercises Calendar paths — see [BOOKING_RECURRENCE.md](./BOOKING_RECURRENCE.md).

## Verification
- As an AM, navigate to the booking settings page; confirm "Connected to Google Calendar" badge.
- Hit the booking-page availability endpoint for that AM and confirm windows align with the AM's actual Google calendar.
- Create a test booking, then a `this_and_following` cancel; confirm Google master event's `RRULE` now has an `UNTIL`.

## Related runbooks
- [BOOKING_RECURRENCE.md](./BOOKING_RECURRENCE.md)
- [GOOGLE_DRIVE.md](./GOOGLE_DRIVE.md)
- Back to [RUNBOOKS.md](./RUNBOOKS.md) Runbook Index.

## Related Task # history
- Task #1032 family — recurring meetings across booking tool, Google Calendar, and Zoom. See BOOKING_RECURRENCE.md.
