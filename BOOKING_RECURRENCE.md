# Recurring Meetings — Operator Runbook

This document covers day-2 operations for the recurring-meetings
feature shipped under epic Task #1032 and finalized by Task #1044.
It is the canonical reference for incident response, planned changes,
and verification.

---

## 1. Feature flags (Task #1044)

Five `system_settings` rows act as kill switches. All default to **on**
(missing row = enabled) so a fresh environment behaves exactly like the
feature was during the epic's earlier phases.

| Key | Default | Surface gated | Failure mode when off |
| --- | --- | --- | --- |
| `booking_recurring_enabled` | `true` | **Master.** Saga create boundary, recurrence-aware edit/cancel orchestrators, every recurrence-touching route (internal + public, preview + confirm). | Brand-new recurring bookings rejected with HTTP 403 `recurrence_disabled`. Existing one-off meetings unaffected. |
| `booking_recurring_internal_enabled` | `true` | Internal staff UI/API: `POST /api/booking/clients/:id/book`, `POST /api/booking/recurrence/preview-availability`, the `<RecurrenceBuilder>` toggle in `ClientSchedulingPanel`. | AM-side toggle hidden; preview + confirm endpoints return 403 `recurrence_disabled`. |
| `booking_recurring_public_enabled` | `true` | Public booking page UI/API: `GET /api/book/:slug`, `POST /api/book/:slug/confirm`, `POST /api/book/:slug/recurrence/preview-availability`. | Public page reports `allowRecurring: false` (UI hides picker); preview + confirm return 403 `recurrence_disabled`. |
| `booking_recurring_zoom_recurring_enabled` | `true` | Zoom translator (`createRecurringMeeting` in `zoomIntegration.ts`). | Forces `static_link_fallback` with reason `feature_flag_disabled`. The booking still succeeds; the meeting just gets a single static Zoom link instead of a Zoom-recurring series. |
| `booking_recurring_edit_scopes_enabled` | `true` | Recurrence-aware edit + cancel orchestrators (`editBooking` / `cancelBooking` in `bookingScheduler.ts`). | PATCH/DELETE on a meeting where `isRecurring=true` rejected with 403 `recurrence_disabled`. One-off cancel/edit is unaffected. |

### Accepted values

- **Off**: `false`, `0`, `off`, `no` (case-insensitive)
- **On**: `true`, `1`, `on`, `yes` (case-insensitive)
- Anything else (or a missing row) is treated as the **default (on)**.

### Cache + propagation

Values are cached in-process for **30 seconds** in
`server/services/bookingFeatureFlags.ts`. After flipping a flag:

1. Invalidate the in-process cache: `invalidateBookingFeatureFlagsCache()`
   from a script, **or** wait up to 30s.
2. For multi-instance / production deployments, **restart the
   application** so every replica drops its cache simultaneously.
3. Failing to restart is safe — it just means each replica picks up
   the new value within 30s of its last cache fill.

If the settings query itself fails, the helper **fails open** (all
flags treated as on) and logs `[BookingFeatureFlags] settings load
failed`. This matches the design intent: a transient DB hiccup must
not silently disable a customer-visible feature.

---

## 2. How to flip a flag

```sql
-- Disable globally:
INSERT INTO system_settings (key, value)
VALUES ('booking_recurring_enabled', 'false')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Re-enable (or simply DELETE the row to fall back to the default):
UPDATE system_settings
SET value = 'true'
WHERE key = 'booking_recurring_enabled';
```

After running, restart the server (or wait 30s) and confirm with the
verification script (Section 4).

---

## 3. Incident playbook

| Symptom | First action | Second action |
| --- | --- | --- |
| Public booking confirms throwing 5xx for a recurring payload | Flip `booking_recurring_public_enabled=false`. UI immediately reports `allowRecurring: false`; users can still book one-offs. | Inspect `bookings` + `work_queue` for the failing series; consult Task #1032D-G code paths in `bookingScheduler.ts`. |
| Zoom-recurring meetings landing on the wrong cadence | Flip `booking_recurring_zoom_recurring_enabled=false`. Bookings keep working; each meeting gets a static Zoom link via `static_link_fallback / feature_flag_disabled`. | Compare the offending RRULE → Zoom-recurrence mapping in `zoomIntegration.translateRecurrenceToZoom`. |
| Edit/cancel of a recurring series corrupts an exception | Flip `booking_recurring_edit_scopes_enabled=false`. PATCH/DELETE on recurring rows return 403; one-offs unaffected, customers can still cancel non-recurring meetings. | Reconcile via the existing `bookingExceptions` cleanup helpers; do not flip back on until the offending edit-scope code path is fixed. |
| Whole feature is misbehaving and the source is unclear | Flip the master `booking_recurring_enabled=false`. All four sub-surfaces stop accepting new recurrences immediately. | Investigate at leisure; existing recurring meetings continue to fire (the gate is on **create** + **edit**, not on already-scheduled occurrences). |

The master flag is the **biggest hammer**. Prefer the smallest
applicable sub-flag so customers retain the most functionality.

---

## 4. Verification

`scripts/verify-recurring-meetings.ts` is the canonical end-to-end
check. It snapshots every flag row, seeds a temporary booking page,
exercises a 7-section matrix, and restores every snapshotted row +
deletes the temporary page on exit (success or failure):

| Section | What it covers |
| --- | --- |
| 1. loader | parser (`true`/`false`/`1`/`0`/`on`/`off`/`yes`/`no`, case-insensitive, garbage → default), 30 s cache, `invalidateBookingFeatureFlagsCache()` hook |
| 2. isolation | flipping each flag affects exactly its `BookingFeatureFlags` field, nothing else |
| 3. public-ui | `GET /api/book/:slug` reports the AND'd `allowRecurring` (master + public); internal flag does NOT affect public response |
| 4. public-preview | `POST /api/book/:slug/recurrence/preview-availability` returns 200 / 403 `recurrence_disabled` per flag (with the offending `flag` echoed in `details`) |
| 5. public-confirm | `POST /api/book/:slug/confirm` with a `recurrence` payload returns 403 `recurrence_disabled` *before* any saga work (these requests short-circuit before any DB write, safe in dry-run). One-off regression checks (recurrence flags must not affect non-recurring bookings) actually exercise the saga and are gated behind `--apply`. |
| 6. zoom-translator | runtime proof — drives `createRecurringMeeting` directly with the flag OFF and asserts the structured `zoom_recurring_static_link_fallback_used` log line is emitted with `reason: "feature_flag_disabled"` *before* any Zoom API call; then drives the same input with the flag ON and asserts that log line is NOT emitted (downstream Zoom auth failure is expected and treated as evidence the fallback path was taken without contaminating the assertion) |
| 7. internal-create (`--apply`) | drives `scheduler.bookSlot` against the seeded page and asserts the saga itself rejects with `recurrence_disabled` when the master flag is off (no booking row created — the gate fires before any DB write) |

```bash
# Read-only — never touches the scheduled_meetings table.
tsx scripts/verify-recurring-meetings.ts

# Additionally exercise the saga create boundary; rows are cleaned up
# at the end. The seeded booking page is also dropped on exit.
tsx scripts/verify-recurring-meetings.ts --apply
```

**Required env for the HTTP-driven sections (3 / 4 / 5).** The flag
loader caches values in-process for 30 s. To drive the running server
across multiple flag flips inside a single script run, start it with
a sub-second cache TTL:

```bash
BOOKING_FEATURE_FLAGS_CACHE_TTL_MS=200 npm run dev
```

The repo's `Start application` workflow is configured this way for
the dev environment. Production deployments do **not** set this var,
so the cache stays at the default 30 s.

The script prints per-assertion `[PASS]` / `[FAIL]` lines and ends with
a single `RESULT { … }` JSON line (with per-section breakdown) that
downstream harnesses can parse:

```json
RESULT {"task":"1044","apply":true,"total":33,"passed":33,"failed":0,"sections":[…],"failures":[]}
```

Exit code is `0` on full pass, `1` on any assertion failure, `2` on
an unhandled exception.

Run after every flag flip in production to confirm the surfaces you
expected to gate are actually gated.

---

## 5. Code map

| File | Purpose |
| --- | --- |
| `server/services/bookingFeatureFlags.ts` | Flag loader, 30s cache, fail-open, `invalidateBookingFeatureFlagsCache()`, `BOOKING_FEATURE_FLAG_KEYS`. |
| `server/services/bookingScheduler.ts` | Master gate inside `bookRecurringSlot`; `editScopes` gates inside `editBooking` / `cancelBooking` (only when meeting is recurring). |
| `server/services/zoomIntegration.ts` | `zoomRecurring` gate inside `createRecurringMeeting`. |
| `server/routes/booking.ts` | Per-surface gates on internal+public preview & confirm; effective `recurrenceFeatureEnabled` returned from `GET /api/booking/me/page`; effective `allowRecurring` reported by `publicPageView`. |
| `client/src/components/booking/ClientSchedulingPanel.tsx` | Hides the recurrence toggle when `recurrenceFeatureEnabled === false`. |
| `client/src/pages/PublicBookingPage.tsx` | No code change needed — already drives the picker off `allowRecurring`, which the server now ANDs with the public flag. |
| `shared/models/booking.ts` | `feature_flag_disabled` added to `ZoomRecurrenceFallbackReason`; `recurrence_disabled` added to `BookingError` code union. |
| `scripts/verify-recurring-meetings.ts` | This runbook's 7-section verification harness (loader, isolation, public-ui, public-preview, public-confirm, zoom-translator, internal-create). |
