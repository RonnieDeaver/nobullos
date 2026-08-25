/**
 * Prioritized next-steps panel (port of the bundle's frontend/src/components/
 * NextSteps.tsx): Critical / Important / Less-important tiers with per-step
 * source chips that jump to the matching check in the breakdown below.
 */

import { AlertOctagon, AlertTriangle, Info, type LucideIcon } from "lucide-react";
import type { NextStep, NextSteps as NextStepsData } from "../lib/types";

interface TierMeta {
  key: keyof NextStepsData;
  label: string;
  blurb: string;
  cls: string;
  icon: LucideIcon;
}

const TIERS: TierMeta[] = [
  { key: "critical", label: "Critical", blurb: "Fix now", cls: "tier-critical", icon: AlertOctagon },
  { key: "easy_wins", label: "Important", blurb: "Fix when all critical errors have been addressed", cls: "tier-easy", icon: AlertTriangle },
  { key: "long_term", label: "Less important", blurb: "Fix when all critical and important errors have been addressed", cls: "tier-long", icon: Info },
];

function StepRow({ step, onNavigate }: { step: NextStep; onNavigate?: (id: string) => void }) {
  const ids = step.source ? step.source.split(" · ") : [];
  return (
    <li className="step">
      <div className="step-title">
        {step.title}
        {ids.map((id) => (
          <button
            key={id}
            type="button"
            className="step-source"
            onClick={() => onNavigate?.(id)}
            title="Jump to this check in the breakdown below"
          >
            {id}
          </button>
        ))}
      </div>
      {step.detail && <div className="step-detail">{step.detail}</div>}
      {step.points.length > 0 && (
        <ul className="step-points">
          {step.points.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function NextSteps({
  data,
  onNavigate,
}: {
  data: NextStepsData;
  onNavigate?: (id: string) => void;
}) {
  const total = data.critical.length + data.easy_wins.length + data.long_term.length;

  return (
    <div className="next-steps" data-testid="panel-next-steps">
      <h3>Next steps</h3>
      {total === 0 ? (
        <div className="steps-clear">✓ Nothing flagged — this account is in good shape.</div>
      ) : (
        TIERS.map((tier) => {
          const items = data[tier.key];
          if (items.length === 0) return null;
          const TierIcon = tier.icon;
          return (
            <div key={tier.key} className={`tier ${tier.cls}`}>
              <div className="tier-head">
                <span className="tier-badge"><TierIcon size={17} /></span>
                <span className="tier-label">{tier.label}</span>
                <span className="tier-blurb">{tier.blurb}</span>
                <span className="tier-count">{items.length}</span>
              </div>
              <ul className="step-list">
                {items.map((s, i) => (
                  <StepRow key={i} step={s} onNavigate={onNavigate} />
                ))}
              </ul>
            </div>
          );
        })
      )}
    </div>
  );
}
