// Task #2680 — single source of truth for the Missed Call Rate (%).
//
// The Missed Call Rate is `missedCalls / totalLeads × 100`. The bug this module
// fixes is that the numerator (missed calls) and the denominator (total leads)
// used to be drawn from DIFFERENT lead sets, and the per-client "ignore Other
// leads" toggle (`hideOtherLeads`, Task #2667) was applied to one side but not
// the other. When the Other bucket carried missed calls but little/no lead
// count, the rate exploded past 100% (e.g. 53 missed ÷ 1 lead = 5,300%).
//
// Every producer (manual save, PDF import, webhook import) and the public
// renderer must build the numerator and denominator from the SAME lead set,
// apply `hideOtherLeads` symmetrically via `applyHideOtherLeads`, and clamp the
// result so an impossible value can never be persisted or rendered again.

/**
 * Clamp ANY percentage value into a sane 0–100 range. A non-finite, negative, or
 * zero-ish input degrades to 0; anything above 100 caps at 100. Rounded to one
 * decimal to match the historical persisted precision.
 *
 * This is the generic guard reused across the public report for every rate that
 * is rendered from a persisted value — the missed-call rate, the lead→consult
 * and consult→case rates, the no-show rate, and every %-unit historical trend
 * point — so a stale/absurd persisted figure (e.g. 5,300%) can never render.
 */
export function clampPercent(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, Math.round(n * 10) / 10);
}

/**
 * Clamp a missed-call-rate percentage into a sane 0–100 range. Delegates to the
 * generic {@link clampPercent}; kept as a named export for call sites that read
 * better with the metric-specific name.
 */
export function clampMissedCallRate(rate: number): number {
  return clampPercent(rate);
}

/**
 * Compute the Missed Call Rate (%) from one shared lead set. The numerator
 * (`missedCalls`) and denominator (`totalLeads`) MUST already be drawn from the
 * SAME set of sources — run them through `applyHideOtherLeads` first so the
 * Other bucket is excluded (or kept) on BOTH sides together. The result is
 * always clamped to 0–100%, so a numerator/denominator inconsistency degrades
 * to a sane value instead of an absurd one.
 */
export function computeMissedCallRate(missedCalls: number, totalLeads: number): number {
  const denom = Number(totalLeads) || 0;
  if (denom <= 0) return 0;
  const num = Math.max(0, Number(missedCalls) || 0);
  return clampMissedCallRate((num / denom) * 100);
}

/**
 * Task #4983 — the ONE display/persist resolution for the Missed Call Rate.
 * Missed-call data is PUSHED from client call reporting (webhook/PDF quality
 * tables) or typed by an operator; the per-source bucket `missedCalls` fields
 * are structural defaults (0) otherwise. Recomputing `missedCalls/totalLeads`
 * whenever lead volume exists therefore fabricated "0% · Healthy" for months
 * with no missed-call data at all, and buried a real pushed headline rate
 * (stored `intake.missedCallRate`) under that recomputed 0.
 *
 * Three tiers, applied by every surface (card, chip, presence, trend) and
 * every write path (form save, PDF import, webhook import):
 *
 *   1. Bucket evidence — some source in the SAME displayed/persisted lead set
 *      counted a missed call (`bucketMissedCalls > 0`) and the denominator is
 *      real (`totalLeads > 0`) → the Task #2680 recompute (hideOtherLeads
 *      already applied symmetrically by the caller, clamped here).
 *   2. Else a pushed/typed stored rate > 0 → the clamped stored value.
 *   3. Else → null ("No data"). A stored 0 is NEVER trusted: both the form
 *      and the imports historically stamped computed 0s over empty bucket
 *      data, so a stored 0 is indistinguishable from "not tracked" (same
 *      reasoning as the entry-tracking-era gating in shared/reportMetrics.ts).
 *
 * Pass `bucketMissedCalls`/`totalLeads` from ONE lead set (run
 * `applyHideOtherLeads` first). `storedRate` may be any persisted JSON value —
 * numeric strings coerce, junk degrades to "absent".
 */
export function resolveMissedCallRate(params: {
  bucketMissedCalls: number;
  totalLeads: number;
  storedRate: unknown;
}): number | null {
  return resolveMissedCallRateWithSource(params).rate;
}

/**
 * Source-aware variant of {@link resolveMissedCallRate} — the SAME three tiers
 * (this is the one implementation; the plain resolver delegates here), but the
 * result also names which tier produced the value so surfaces that label the
 * rate's provenance (the report-editor preview's "(from Leads Performance)" /
 * "(pushed from client report)" captions) branch on the resolver's own verdict
 * instead of re-deriving the tier predicate locally and drifting.
 *
 *   rate !== null, source "buckets" → tier 1 recompute from the shared lead set
 *   rate !== null, source "stored"  → tier 2 clamped pushed/typed stored rate
 *   rate === null, source null      → tier 3 "No data"
 */
export function resolveMissedCallRateWithSource(params: {
  bucketMissedCalls: number;
  totalLeads: number;
  storedRate: unknown;
}): { rate: number | null; source: "buckets" | "stored" | null } {
  const missed = Number(params.bucketMissedCalls) || 0;
  const denom = Number(params.totalLeads) || 0;
  if (missed > 0 && denom > 0) {
    return { rate: computeMissedCallRate(missed, denom), source: "buckets" };
  }
  const stored =
    typeof params.storedRate === "string"
      ? Number(params.storedRate)
      : (params.storedRate as number | null | undefined);
  if (typeof stored === "number" && Number.isFinite(stored) && stored > 0) {
    return { rate: clampMissedCallRate(stored), source: "stored" };
  }
  return { rate: null, source: null };
}

/**
 * Override the CURRENT month's missed-call rate in a historical-trend series with
 * the value the report's Missed Call Rate card actually displays (recomputed live
 * from the active-product lead set), so the trend's latest point can never
 * disagree with the card beside it.
 *
 * The trend stores each month's PERSISTED `intake.missedCallRate`, but the card
 * recomputes the rate over a different (active-product) denominator. A report
 * imported before that recompute shipped can carry a stale/absurd saved value
 * (e.g. 5,300%), so the two diverged. Only the current month has an adjacent
 * card to match; historical months are returned untouched. A `null` series
 * passes through unchanged. Pure + immutable — never mutates the input.
 *
 * `recomputedRate` is nullable: when the card shows "No Data" (zero displayed
 * lead volume this month), pass null so the trend's current point goes null
 * with it — the stored point may carry a fabricated 0% the card no longer
 * vouches for, and card and trend must never disagree in either direction.
 */
export function applyRecomputedMissedCallRate<
  // Task #3688 — trend points are nullable (null = month not provided), and the
  // card's recomputed rate overrides whatever the current month stored.
  T extends { month: string; intake: { missedCallRate: number | null } },
>(trend: T[] | null, currentMonth: string, recomputedRate: number | null): T[] | null {
  if (!trend) return trend;
  return trend.map((d) =>
    d.month === currentMonth
      ? ({ ...d, intake: { ...d.intake, missedCallRate: recomputedRate } } as T)
      : d,
  );
}

/**
 * Apply the per-client `hideOtherLeads` toggle (Task #2667) symmetrically to a
 * missed-call numerator and a total-leads denominator.
 *
 * `missedCalls` / `totalLeads` are the FULL figures that INCLUDE the Other
 * bucket. When the toggle is ON, the Other bucket's missed calls AND its lead
 * count are removed from BOTH sides together; when OFF, both keep Other. This
 * is the only place the symmetric subtraction lives so the two sides can never
 * drift apart.
 */
export function applyHideOtherLeads(params: {
  missedCalls: number;
  totalLeads: number;
  otherMissedCalls: number;
  otherLeadCount: number;
  hideOtherLeads: boolean;
}): { missedCalls: number; totalLeads: number } {
  const { missedCalls, totalLeads, otherMissedCalls, otherLeadCount, hideOtherLeads } = params;
  if (!hideOtherLeads) {
    return { missedCalls, totalLeads };
  }
  return {
    missedCalls: missedCalls - otherMissedCalls,
    totalLeads: totalLeads - otherLeadCount,
  };
}

/**
 * Compute the display-time lead count for admin surfaces (Report Comparison,
 * Trend Analytics) that read persisted `intake.totalLeads` and
 * `marketing.otherLeads.count` directly from stored report section data.
 *
 * `intake.totalLeads` is persisted including the raw Other bucket; when
 * `hideOtherLeads` is ON, subtract the stored Other count so the admin view
 * shows the same total the client sees on the public report. When OFF, return
 * `totalLeads` unchanged. Never returns negative — floors at 0.
 *
 * This is display-only: it never rewrites the persisted data. Symmetric with
 * how PublicReport.tsx zeros `otherLeadsCount` before computing its total.
 */
export function adjustDisplayLeads(
  totalLeads: number,
  otherLeadsCount: number,
  hideOtherLeads: boolean,
): number {
  if (!hideOtherLeads) return Math.max(0, Number(totalLeads) || 0);
  return Math.max(0, (Number(totalLeads) || 0) - (Number(otherLeadsCount) || 0));
}

/**
 * Recompute the lead→consult conversion rate using an already-adjusted lead
 * denominator so the displayed rate stays symmetric with the displayed total.
 *
 * When `hideOtherLeads` is OFF the persisted rate is returned unchanged.
 * When ON the rate is recomputed from `totalConsults / adjustedLeads` so it
 * matches the adjusted denominator shown in the Total Leads card.  If the
 * adjusted denominator is 0 the rate is 0 (avoids division by zero).
 *
 * Pass `adjustedLeads` from {@link adjustDisplayLeads} — do NOT pass the raw
 * `intake.totalLeads` here or the adjustment is applied twice.
 */
export function adjustLeadToConsultRate(
  totalConsults: number,
  adjustedLeads: number,
  persistedRate: number,
  hideOtherLeads: boolean,
): number {
  if (!hideOtherLeads) return Number(persistedRate) || 0;
  if (adjustedLeads <= 0) return 0;
  return clampPercent(((Number(totalConsults) || 0) / adjustedLeads) * 100);
}
