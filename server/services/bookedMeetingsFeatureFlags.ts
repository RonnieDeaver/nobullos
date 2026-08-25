/**
 * Booked Meetings Console + GCal two-way sync feature flags (Task #1064).
 *
 * Mirrors the cache + parseBool pattern from `bookingFeatureFlags.ts`.
 * Two `system_settings` rows act as kill switches:
 *
 * | Key                              | Surface gated |
 * | -------------------------------- | ------------- |
 * | `booked_meetings_console_enabled`| The "My Meetings" tab on /profile and the supporting `GET /api/booking/me/meetings` list + detail endpoints. When off, the list endpoint returns 403 `console_disabled` and the panel hides itself. Existing per-meeting PATCH/DELETE on `/api/booking/:id` are NOT gated by this flag — admins can still operate on individual rows even with the console UI disabled. |
 * | `gcal_two_way_sync_enabled`      | Inbound Google Calendar sync (watch channels, webhook receiver, incremental sync worker). Phase 3+ of the epic; pre-declared here so the flag is queryable from the same loader once the sync infra lands. Currently unwired in this Phase 1 slice — defaults to true so subsequent rollouts behave like the feature is on. |
 *
 * Defaults: both flags ON when the row is missing or unparseable so a
 * fresh environment behaves as the feature is enabled. Off-tokens are
 * `false`, `0`, `off`, `no`. Cache TTL is shared with the recurring-
 * meetings flag loader (`BOOKING_FEATURE_FLAGS_CACHE_TTL_MS`) so the
 * verification harness can drive both modules with the same sub-second
 * TTL during HTTP-driven flag flips.
 */

import { getSystemSettings } from "../storage/settingsStorage";

export interface BookedMeetingsFeatureFlags {
  console: boolean;
  gcalTwoWaySync: boolean;
}

export const BOOKED_MEETINGS_FEATURE_FLAG_KEYS = [
  "booked_meetings_console_enabled",
  "gcal_two_way_sync_enabled",
] as const;

const CACHE_TTL_MS = (() => {
  const raw = process.env.BOOKING_FEATURE_FLAGS_CACHE_TTL_MS;
  if (!raw) return 30_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30_000;
})();

let cached: { flags: BookedMeetingsFeatureFlags; expiresAt: number } | null = null;
let inflight: Promise<BookedMeetingsFeatureFlags> | null = null;

function parseBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw == null) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  return defaultValue;
}

async function loadFlagsFromDb(): Promise<BookedMeetingsFeatureFlags> {
  const rows = await getSystemSettings([...BOOKED_MEETINGS_FEATURE_FLAG_KEYS]);
  return {
    console: parseBool(rows["booked_meetings_console_enabled"], true),
    gcalTwoWaySync: parseBool(rows["gcal_two_way_sync_enabled"], true),
  };
}

export async function getBookedMeetingsFeatureFlags(): Promise<BookedMeetingsFeatureFlags> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.flags;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const flags = await loadFlagsFromDb();
      cached = { flags, expiresAt: Date.now() + CACHE_TTL_MS };
      return flags;
    } catch (err) {
      // Fail-open: a transient settings-query hiccup shouldn't kill
      // the console for everyone. Logged for observability and short-
      // cached so we retry quickly.
      console.warn(
        "[BookedMeetingsFeatureFlags] settings load failed; defaulting all flags ON:",
        (err as Error)?.message || err,
      );
      const flags: BookedMeetingsFeatureFlags = {
        console: true,
        gcalTwoWaySync: true,
      };
      cached = { flags, expiresAt: Date.now() + 5_000 };
      return flags;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function invalidateBookedMeetingsFeatureFlagsCache(): void {
  cached = null;
}
