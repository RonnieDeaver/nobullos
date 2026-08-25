/**
 * Dashboard Hygiene cell: the persisted audit score colored by band, linking
 * to the account's report page. "—" (with a hint) until the account has ever
 * been audited — the live overlay fills it the moment a run persists a score.
 */

import { Link } from "wouter";
import { scoreColorVar } from "../lib/theme";

export function HealthPill({
  score,
  band,
  at,
  href,
  testId,
  inactiveTitle,
}: {
  score: number | null;
  band: string | null;
  at: string | null;
  href: string;
  testId?: string;
  /** Tooltip for band "Inactive" — LSA has no labels, so it overrides the GAds default. */
  inactiveTitle?: string;
}) {
  if (score === null) {
    return (
      <span
        className="muted"
        title="No hygiene audit yet — open the account's Hygiene Audit or press Run stale audits."
      >
        —
      </span>
    );
  }
  // Fully-paused account: nothing scannable, so a 0 score would read as a real
  // problem. Show a dash (still linked to the report for the explanation).
  if (band === "Inactive") {
    return (
      <Link
        href={href}
        className="muted"
        title={inactiveTitle ?? "No active labeled campaigns in scope"}
        onClick={(e) => e.stopPropagation()}
        data-testid={testId}
      >
        —
      </Link>
    );
  }
  const when = at ? new Date(at) : null;
  const title = [band, when && !isNaN(when.getTime()) ? `audited ${when.toLocaleString()}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <Link
      href={href}
      className="health-pill"
      style={{ color: scoreColorVar(score) }}
      title={title}
      onClick={(e) => e.stopPropagation()}
      data-testid={testId}
    >
      {Math.round(score)}
    </Link>
  );
}
