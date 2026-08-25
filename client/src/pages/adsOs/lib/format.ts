// Shared formatting helpers — verbatim port of the bundle's frontend/src/format.ts.
// Two money variants intentionally exist: `money` (2 decimals) for dashboards
// that retain cents and `moneyWhole` (0 decimals) for whole-dollar presentation.

import type { Product } from "./types";

export function money(n: number, _cur?: string): string {
  const v = (Math.round(n * 100) / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `$${v}`;
}

export function moneyWhole(n: number, _cur?: string): string {
  const v = Math.round(n).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return `$${v}`;
}

/** Client-profile CPL convention: nearest whole dollar, or a dash when there
 * is no denominator. Keeping the null handling here prevents individual CPL
 * surfaces from drifting to $0, Infinity, or NaN. */
export function formatCpl(n: number | null): string {
  return n === null ? "—" : moneyWhole(n);
}

// Compact LSA/GAds schedule label: [] or all 7 days -> "Every day"; a single
// contiguous Mon→Sun run -> "Mon–Fri"; anything else -> "Mon, Wed, Fri".
const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export function scheduleLabel(days: string[] | null | undefined): string {
  const idx = [...new Set((days ?? []).filter((d) => WEEK.includes(d)))]
    .map((d) => WEEK.indexOf(d))
    .sort((a, b) => a - b);
  if (idx.length === 0 || idx.length === 7) return "Every day";
  const contiguous = idx[idx.length - 1] - idx[0] === idx.length - 1;
  if (contiguous && idx.length >= 3) return `${WEEK[idx[0]]}–${WEEK[idx[idx.length - 1]]}`;
  return idx.map((i) => WEEK[i]).join(", ");
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function formatId(id: string): string {
  return id.length === 10 ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id;
}

// Short display label for an account — the ONE convention shared by the profile's
// Performance tables and its Budget pacing rows (Task #3906), mirroring the hero
// strip: a client's sole GAds account reads "GAds", an LSA account reads its city,
// and anything ambiguous (several GAds accounts, an LSA without a city) falls back
// to the account name, truncated to keep rows compact.
export function accountShortLabel(
  a: { product: Product; name: string; city?: string | null },
  gadsCount: number,
): string {
  const short = a.name.length > 22 ? `${a.name.slice(0, 21)}…` : a.name;
  if (a.product === "gads") return gadsCount > 1 ? short : "GAds";
  return a.city ?? short;
}

// The product tag beside that label is skipped when it would only repeat it —
// the sole-GAds row is already labeled "GAds" (never "GAds GAds").
export function accountTagIsEcho(a: { product: Product }, gadsCount: number): boolean {
  return a.product === "gads" && gadsCount === 1;
}

// First name only — the Doer/Checker columns show "Santiago", not "Santiago Sanchez".
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

// Practice Area labels arrive in canonical ClickUp order. Keep that order for
// the table's display, free-text search, and text sorting; only blank labels
// are discarded so an older or partial response has one honest empty fallback.
export function practiceAreaText(areas: readonly string[] | null | undefined): string {
  return (areas ?? [])
    .map((area) => area.trim())
    .filter(Boolean)
    .join(", ");
}

// Distinct non-empty doer/checker names across the loaded rows, sorted by the
// first name shown in the table so the filter dropdowns match the columns.
// Shared by all three dashboards (their row types all carry doer/checker).
export function distinctPeople(
  rows: ReadonlyArray<{ doer?: string | null; checker?: string | null }> | null,
  key: "doer" | "checker"
): string[] {
  if (!rows) return [];
  const set = new Set<string>();
  for (const r of rows) {
    const v = r[key];
    if (v) set.add(v);
  }
  return [...set].sort((a, b) =>
    firstName(a).toLowerCase().localeCompare(firstName(b).toLowerCase())
  );
}
