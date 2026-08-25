// Extracted verbatim from MatchSettings.tsx (F11B decomposition).
const NAMES_TREND_WINDOW_OPTIONS = [
  { id: "24h", label: "24h", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", label: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
] as const;
const NAMES_TREND_WINDOW_DEFAULT_ID = "7d";
const NAMES_TREND_WINDOW_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000;
const NAMES_TREND_WINDOW_VALID_IDS = new Set(NAMES_TREND_WINDOW_OPTIONS.map((o) => o.id));
function namesTrendWindowStorageKey(userId: string | undefined): string {
  return `nobull:matchSettings:impactWindow:commonFirstNames:${userId ?? "anon"}`;
}

export { NAMES_TREND_WINDOW_OPTIONS, NAMES_TREND_WINDOW_DEFAULT_ID, NAMES_TREND_WINDOW_DEFAULT_MS, NAMES_TREND_WINDOW_VALID_IDS, namesTrendWindowStorageKey };
