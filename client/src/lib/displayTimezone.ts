import { useMemo } from "react";
import type { User } from "@shared/schema";
import { useAuth } from "@/hooks/use-auth";

/**
 * Detect the browser's IANA timezone. Returns "UTC" on environments
 * where `Intl.DateTimeFormat` does not expose a resolved zone.
 */
export function detectBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Resolve the active display timezone for the logged-in user across the
 * scheduling tool (Task #1033). Precedence:
 *   1. The user's saved `timezone` preference (set explicitly in Profile
 *      or seeded server-side from their Google Calendar account, or a
 *      legacy default carried on the row).
 *   2. The browser-detected IANA timezone.
 *
 * `displayTimezoneSource` is purely a label hint — the resolver always
 * honours `user.timezone` when present so a long-standing user with a
 * NULL source (column was added 2026-05) does not regress to browser TZ.
 */
export type DisplayTimezoneSource = "user" | "google_calendar" | "browser";

export interface ResolvedDisplayTimezone {
  timezone: string;
  source: DisplayTimezoneSource;
  /** Short human label like "EDT" / "PST" / "GMT+1" — undefined on SSR. */
  abbreviation?: string;
}

function timezoneAbbreviation(tz: string): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short",
    }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value;
  } catch {
    return undefined;
  }
}

/**
 * Pure resolver — exported so non-React consumers (and the Profile
 * picker, which has to mirror the same precedence) can reuse it.
 */
export function resolveDisplayTimezone(
  user: Pick<User, "timezone" | "displayTimezoneSource"> | null | undefined,
): ResolvedDisplayTimezone {
  const saved = user?.timezone ?? null;
  const savedSource = user?.displayTimezoneSource ?? null;
  let timezone: string;
  let source: DisplayTimezoneSource;
  // Provenance is the source of truth: only honour a saved value when
  // we know who set it. Migration 0050 backfilled `'user'` for any
  // pre-#1033 row whose timezone differed from the legacy
  // America/Chicago default; rows still carrying that legacy default
  // were intentionally left with NULL provenance so they fall through
  // to the browser zone here (and get replaced by the GCal seeder on
  // next /status load if the account is connected).
  if (saved && (savedSource === "user" || savedSource === "google_calendar")) {
    timezone = saved;
    source = savedSource;
  } else {
    timezone = detectBrowserTimezone();
    source = "browser";
  }
  return { timezone, source, abbreviation: timezoneAbbreviation(timezone) };
}

export function useDisplayTimezone(): ResolvedDisplayTimezone {
  const { user } = useAuth();
  return useMemo(() => resolveDisplayTimezone(user), [user]);
}
