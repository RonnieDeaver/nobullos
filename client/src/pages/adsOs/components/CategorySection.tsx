/**
 * A category row (port of the bundle's frontend/src/components/
 * CategorySection.tsx) that expands inline to reveal its checks, scores and
 * the weighted-average math behind the category score (so the team can
 * verify it).
 */

import type { CategoryResult } from "../lib/types";
import { scoreColorVar } from "../lib/theme";
import { CheckCard } from "./CheckCard";

interface Props {
  category: CategoryResult;
  expanded: boolean;
  onToggle: () => void;
  nav?: { id: string; n: number };
}

export function CategorySection({ category, expanded, onToggle, nav }: Props) {
  const color = scoreColorVar(category.score);
  const scored = category.checks.filter((c) => c.score !== null);
  const na = category.checks.length - scored.length;

  // Reconstruct Cₖ = Σ(wᵢ·sᵢ)/Σ(wᵢ) so it's auditable on screen.
  const sumW = scored.reduce((a, c) => a + c.weight, 0);
  const sumWS = scored.reduce((a, c) => a + c.weight * (c.score as number), 0);
  const recomputed = sumW > 0 ? sumWS / sumW : 0;

  return (
    <div className={`cat-section ${expanded ? "open" : ""}`} data-testid={`category-${category.code}`}>
      <button className="cat-bar" onClick={onToggle} aria-expanded={expanded}>
        <div className="cat-bar-head">
          <span className="chevron">{expanded ? "▾" : "▸"}</span>
          <span className="cat-code">{category.code}</span>
          <span className="cat-name">{category.name}</span>
          <span className="cat-weight">{Math.round(category.weight * 100)}% of total</span>
          <span className="cat-score" style={{ color }}>
            {Math.round(category.score)}
          </span>
        </div>
        <div className="cat-track">
          {/* Full-width bar scaled via transform — compositor-only animation
              (the CSS used to transition `width`, a layout property). */}
          <div className="cat-fill" style={{ transform: `scaleX(${Math.min(100, Math.max(0, category.score)) / 100})`, background: color }} />
        </div>
      </button>

      {expanded && (
        <div className="cat-detail">
          <div className="cat-detail-meta">
            {scored.length} scored{na > 0 && <> · {na} N/A (excluded)</>} · weighted avg ={" "}
            <strong>{recomputed.toFixed(1)}</strong>
          </div>
          {category.checks.map((chk) => (
            <CheckCard key={chk.id} check={chk} nav={nav} />
          ))}
        </div>
      )}
    </div>
  );
}
