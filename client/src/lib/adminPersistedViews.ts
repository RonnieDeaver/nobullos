// Central registry of localStorage keys/prefixes used by admin pages to
// persist filter, tab, and view choices. Used by the global
// "Reset all saved admin views" entry point so every saved choice can be
// cleared in one click instead of visiting each page individually.
//
// When you add a new admin-page persisted setting (via usePersistentState
// or direct localStorage), add its key or prefix here so the global reset
// keeps covering everything.

// Single, well-known keys (not user-scoped).
export const ADMIN_PERSISTED_VIEW_KEYS: readonly string[] = [
  // ActivityDashboard — compare-selection ids (legacy single-key, not
  // namespaced under `admin.*`).
  "activityCompareSelectionIds",
  // HealthDashboard / SystemHealthConsole — single-process settings.
  "health-dashboard-history-window",
  "health-dashboard-polling-interval",
  "health-dashboard-per-worker-selection",
  // OperationalHealthCards (System Health → stale-lease/throughput
  // window selector).
  "queueTimingThroughputWindowMs",
];

// Prefixes covering all per-user / per-page saved views. Anything in
// localStorage whose key starts with one of these is considered an
// "admin saved view" for the purposes of the global reset.
export const ADMIN_PERSISTED_VIEW_PREFIXES: readonly string[] = [
  // The standard `admin.*` namespace used by usePersistentState
  // across admin pages (Activity, Zoom Review Queue, Match Settings,
  // Rate Limit Users / Dashboard / Multipliers, Rate Limit time-series
  // and notification-history sub-views, …).
  "admin.",
  // MatchSettings legacy keys that predate the `admin.*` convention.
  "nobull:matchSettings:",
  // Front Historical Recovery panel (rendered inside FrontIntegration).
  "recoveryHistoryShowOnlyInterrupted:",
  "recoveryTrendWindowDays:",
];
