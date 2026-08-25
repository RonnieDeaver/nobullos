/**
 * Recurring-meetings feature flags (Task #1044 / #1032I — final phase
 * of the recurring-meetings epic).
 *
 * Five `system_settings` rows act as per-surface kill switches. Default
 * is `true` (enabled) when the row is missing or unparseable so a fresh
 * environment behaves like the feature is on, matching what shipped
 * during the epic's earlier phases. To disable, an operator writes
 * the literal string `"false"` (or `"0"` / `"off"`) via the existing
 * `setSystemSetting` helper.
 *
 * | Key                                           | Surface gated |
 * | --------------------------------------------- | ------------- |
 * | `booking_recurring_enabled`                   | Master kill switch — applied at the saga create boundary, the recurrence-aware edit/cancel orchestrators, and every recurrence-touching route (internal + public, preview + confirm). When off, brand-new recurring bookings are rejected with `recurrence_disabled` (HTTP 403); existing one-off meetings are unaffected. |
 * | `booking_recurring_internal_enabled`          | Internal staff UI/API. When off the AM-facing recurrence builder is hidden and `POST /api/booking/clients/:id/book` rejects payloads with `recurrence`. |
 * | `booking_recurring_public_enabled`            | Public booking page UI/API. When off the public page reports `allowRecurring: false` and `POST /api/book/:slug/confirm` rejects payloads with `recurrence`. |
 * | `booking_recurring_zoom_recurring_enabled`    | Zoom translator output. When off, `createRecurringMeeting` skips the Zoom-recurring path and forces the static-link fallback with reason `feature_flag_disabled`. |
 * | `booking_recurring_edit_scopes_enabled`       | Recurrence-aware edit + cancel orchestrators. When off, PATCH and DELETE on a recurring meeting are rejected with `recurrence_disabled`; one-off cancel/edit is unaffected. |
 *
 * The values are cached in-process for `CACHE_TTL_MS` (30 s) so the
 * hot path doesn't fan out to a settings query on every request. The
 * cache is invalidated proactively by `invalidateBookingFeatureFlagsCache()`,
 * which the operator runbook tells admins to follow with a server
 * restart for guaranteed propagation across instances.
 */

import { getSystemSettings } from "../storage/settingsStorage";

export interface BookingFeatureFlags {
  master: boolean;
  internal: boolean;
  public: boolean;
  zoomRecurring: boolean;
  editScopes: boolean;
}

export const BOOKING_FEATURE_FLAG_KEYS = [
  "booking_recurring_enabled",
  "booking_recurring_internal_enabled",
  "booking_recurring_public_enabled",
  "booking_recurring_zoom_recurring_enabled",
  "booking_recurring_edit_scopes_enabled",
] as const;

// Cache TTL is overridable via env so the verification harness
// (`scripts/verify-recurring-meetings.ts`) can drive the server with
// a sub-second TTL and observe per-flag-flip behavior over HTTP
// without restarting between flips. Production default is 30s.
const CACHE_TTL_MS = (() => {
  const raw = process.env.BOOKING_FEATURE_FLAGS_CACHE_TTL_MS;
  if (!raw) return 30_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30_000;
})();

let cached: { flags: BookingFeatureFlags; expiresAt: number } | null = null;
let inflight: Promise<BookingFeatureFlags> | null = null;

function parseBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw == null) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  return defaultValue;
}

async function loadFlagsFromDb(): Promise<BookingFeatureFlags> {
  const rows = await getSystemSettings([...BOOKING_FEATURE_FLAG_KEYS]);
  return {
    master: parseBool(rows["booking_recurring_enabled"], true),
    internal: parseBool(rows["booking_recurring_internal_enabled"], true),
    public: parseBool(rows["booking_recurring_public_enabled"], true),
    zoomRecurring: parseBool(
      rows["booking_recurring_zoom_recurring_enabled"],
      true,
    ),
    editScopes: parseBool(
      rows["booking_recurring_edit_scopes_enabled"],
      true,
    ),
  };
}

export async function getBookingFeatureFlags(): Promise<BookingFeatureFlags> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.flags;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const flags = await loadFlagsFromDb();
      cached = { flags, expiresAt: Date.now() + CACHE_TTL_MS };
      return flags;
    } catch (err) {
      // Fail-open: if the settings query itself fails we keep the
      // feature on so a transient DB hiccup doesn't kill all
      // recurring bookings. The error is logged for observability.
      console.warn(
        "[BookingFeatureFlags] settings load failed; defaulting all flags ON:",
        (err as Error)?.message || err,
      );
      const flags: BookingFeatureFlags = {
        master: true,
        internal: true,
        public: true,
        zoomRecurring: true,
        editScopes: true,
      };
      cached = { flags, expiresAt: Date.now() + 5_000 };
      return flags;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Test / admin hook — invalidate the in-process cache. */
export function invalidateBookingFeatureFlagsCache(): void {
  cached = null;
}
