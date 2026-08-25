// Extracted verbatim from HealthDashboardSection.tsx (F11D decomposition, task #4160).

export const HISTORY_WINDOW_OPTIONS: { value: string; label: string; ms: number }[] = [
  { value: "3h", label: "Last 3 hours", ms: 3 * 60 * 60 * 1000 },
  { value: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60 * 1000 },
];
export const HISTORY_WINDOW_STORAGE_KEY = "health-dashboard-history-window";