/**
 * Critical-gate banner (port of the bundle's frontend/src/components/
 * GateBanner.tsx). The critical issues share one dynamic cap (lower the more
 * there are). Loud red banner when the cap actually lowered the score; quiet
 * amber when it didn't bind.
 */

import type { GateTriggered } from "../lib/types";

interface Props {
  gates: GateTriggered[];
  finalScore: number;
  rawScore: number;
}

export function GateBanner({ gates, finalScore, rawScore }: Props) {
  if (gates.length === 0) return null;
  const cap = gates[0].cap; // all issues share the effective cap
  const binding = finalScore < rawScore;
  const n = gates.length;
  const plural = n === 1 ? "issue" : "issues";

  return (
    <div className={`banner ${binding ? "banner-red" : "banner-amber"}`} data-testid="banner-gates">
      <strong>
        {binding ? (
          <>
            Computed score {Math.round(rawScore)} — capped at {Math.round(finalScore)} ·{" "}
            {n} critical {plural}
          </>
        ) : (
          <>
            ⚠️ {n} critical {plural} (would cap at {Math.round(cap)})
          </>
        )}
      </strong>
      <ul>
        {gates.map((g) => (
          <li key={g.id}>
            {g.reason} <span className="muted">({g.source})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
