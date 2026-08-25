// Rate Limits admin — shared types, palette + formatting helpers used across the rate-limit admin sections.
// Extracted VERBATIM from the former 5.9k-line RateLimitUsers.tsx monolith
// (house aggregator pattern, cf. ClickUpModule / Task #3787; this split:
// F11C / Task #4159). The page composition root is
// client/src/pages/admin/RateLimitUsers.tsx — new rate-limit admin UI
// belongs here (or in a new sibling module), never in the aggregator.

import { format } from "date-fns";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";

export type RateLimitEvent = {
  ip: string;
  userId: string | null;
  path: string;
  method: string;
  category: string;
  timestamp: number;
};

export type UserMetrics = {
  userId: string;
  totalBlocked: number;
  categories: Record<string, number>;
  recentEvents: RateLimitEvent[];
  firstSeen: number;
  lastSeen: number;
};

export type AnonymousMetrics = {
  ip: string;
  totalBlocked: number;
  categories: Record<string, number>;
  lastSeen: number;
};

export type ByUserResponse = {
  users: UserMetrics[];
  anonymous: AnonymousMetrics[];
};

type CategoryMetrics = {
  totalBlocked: number;
  windowMs: number;
  maxRequests: number;
  recentEvents: RateLimitEvent[];
  uniqueIPs: number;
  topIPs: { ip: string; count: number }[];
  uniqueUsers: number;
  topUsers: { userId: string; count: number }[];
};

export type RateLimitSummary = {
  totalBlocked: number;
  categories: Record<string, CategoryMetrics>;
  collectedSince: number | null;
};

export type UsageAlert = {
  userId: string;
  category: string;
  count: number;
  max: number;
  warningPercent: number;
  windowStart: number;
  windowMs: number;
  triggeredAt: number;
};

export type DbUser = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role: string | null;
};

export function formatDigestCountdown(ms: number): string {
  if (ms <= 0) return "any moment now";
  const totalSeconds = Math.ceil(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const s = totalSeconds % 60;
    return s ? `${totalMinutes}m ${s}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

export function scrollToNotifyConfigCard() {
  if (typeof document === "undefined") return;
  const el = document.getElementById("notify-config-card");
  if (!el) return;
  el.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "start" });
  const flushBtn = el.querySelector<HTMLElement>('[data-testid="button-flush-digest-now"]');
  if (flushBtn) {
    flushBtn.focus({ preventScroll: true });
  }
}

export const CATEGORY_COLORS: Record<string, string> = {
  api: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  auth: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300",
  write: "bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300",
  ai: "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300",
  upload: "bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300",
  admin: "bg-yellow-100 text-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-300",
  webhook: "bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300",
  sensitiveWrite: "bg-pink-100 text-pink-700 dark:bg-pink-950/40 dark:text-pink-300",
};

const CATEGORY_HEX: Record<string, string> = {
  api: "#3b82f6",
  auth: "#ef4444",
  write: "#f97316",
  ai: "#a855f7",
  upload: "#14b8a6",
  admin: "#eab308",
  webhook: "#64748b",
  sensitiveWrite: "#ec4899",
};

const FALLBACK_HEX = ["hsl(var(--primary))", "#0ea5e9", "#22c55e", "#f59e0b", "#8b5cf6", "#06b6d4"];

export function getCategoryHex(cat: string, idx: number): string {
  return CATEGORY_HEX[cat] || FALLBACK_HEX[idx % FALLBACK_HEX.length];
}

export const INTERVAL_OPTIONS: { label: string; ms: number }[] = [
  { label: "5 min", ms: 5 * 60 * 1000 },
  { label: "15 min", ms: 15 * 60 * 1000 },
  { label: "1 hr", ms: 60 * 60 * 1000 },
  { label: "6 hr", ms: 6 * 60 * 60 * 1000 },
  { label: "1 day", ms: 24 * 60 * 60 * 1000 },
];

type TimeSeriesBucket = {
  bucketStart: number;
  total: number;
  categories: Record<string, number>;
};

export type TimeSeriesResponse = {
  userId?: string;
  ip?: string;
  intervalMs: number;
  rangeStart: number | null;
  rangeEnd: number | null;
  categories: string[];
  buckets: TimeSeriesBucket[];
};

export function getCategoryColor(cat: string): string {
  return CATEGORY_COLORS[cat] || "bg-gray-100 text-gray-700 dark:bg-gray-800/60 dark:text-gray-300";
}

export function formatTime(ts: number): string {
  return format(new Date(ts), "MMM d, h:mm:ss a");
}

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]): void {
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function intervalSlug(intervalMs: number): string {
  const opt = INTERVAL_OPTIONS.find((o) => o.ms === intervalMs);
  return opt ? opt.label.replace(/\s+/g, "") : `${intervalMs}ms`;
}

export function safeFilenamePart(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 60) || "user";
}

export function getUserDisplayName(userId: string, users: DbUser[]): string {
  const u = users.find((u) => u.id === userId);
  if (u) {
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
    return name || u.email || userId;
  }
  return userId;
}

export type TabType = "users" | "anonymous" | "overview" | "history";


export function statusBadgeClass(status: string): string {
  if (status === "sent") return "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300";
  if (status === "failed") return "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300";
  if (status === "skipped") return "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300";
  return "bg-gray-100 text-gray-700 dark:bg-gray-800/60 dark:text-gray-300";
}
