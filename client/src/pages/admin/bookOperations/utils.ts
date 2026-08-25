/**
 * Shared formatting and idempotency-key helpers for the Book Operations console.
 */

/** Generate a browser idempotency key at confirmation time. */
export function genIdempotencyKey(): string {
  // Must satisfy server idempotencyKeySchema: min 16, max 96, trimmed
  const rand = Array.from({ length: 3 }, () =>
    Math.random().toString(36).slice(2),
  ).join("");
  return `bops-${Date.now()}-${rand}`.slice(0, 96);
}

/** Format cents as USD. */
export function fmtCurrency(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

/** Format an ISO string or null as a short locale date+time. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Format an ISO date (date-only portion). */
export function fmtDateOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

/** Today as a YYYY-MM-DD string in local time. */
export function todayStr(): string {
  const d = new Date();
  return localDateStr(d);
}

/** N days ago as a YYYY-MM-DD string. */
export function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDateStr(d);
}

/** Date → YYYY-MM-DD string using local timezone. */
export function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Convert a YYYY-MM-DD local string to an ISO start-of-day UTC string. */
export function dateStrToIsoFrom(s: string): string {
  // Treat as local noon to avoid timezone-boundary issues, then floor to start
  return new Date(`${s}T00:00:00`).toISOString();
}

/** Convert a YYYY-MM-DD local string to an ISO end-of-day UTC string. */
export function dateStrToIsoTo(s: string): string {
  return new Date(`${s}T23:59:59`).toISOString();
}

/** Format a conversion rate (0–1) as a percentage string. */
export function fmtRate(rate: number | null): string {
  if (rate == null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

/** Capitalize a stage/status label. */
export function capitalize(s: string): string {
  if (!s) return "—";
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
