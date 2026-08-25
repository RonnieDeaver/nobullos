/**
 * One check row (port of the bundle's frontend/src/components/CheckCard.tsx):
 * status dot, id, name, value, impact chip and score; expands to the fix
 * recommendation + affected-entity evidence list.
 */

import { useEffect, useRef, useState } from "react";
import type { CheckResult, Status } from "../lib/types";
import { statusMeta, statusColorVar } from "../lib/theme";

function StatusDot({ status }: { status: Status }) {
  return (
    <span
      className="status-dot"
      style={{ background: statusColorVar[status] }}
      aria-label={statusMeta[status].label}
    />
  );
}

export function CheckCard({
  check,
  nav,
}: {
  check: CheckResult;
  nav?: { id: string; n: number };
}) {
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const meta = statusMeta[check.status];
  const hasDetail = check.evidence.length > 0 || !!check.recommendation;
  const isNa = check.score === null;

  // Navigated to from a Next-steps chip (nav.n bumps on each click): open it,
  // scroll it into view, flash it. Guarded so only the targeted card reacts.
  useEffect(() => {
    if (!nav || nav.id !== check.id) return;
    if (hasDetail) setOpen(true);
    setFlash(true);
    // Defer the scroll a tick so the category expansion + card body have laid out
    // (scrolling in the same tick targets the pre-expansion position).
    const scrollT = setTimeout(
      () => ref.current?.scrollIntoView({ block: "center" }),
      60
    );
    const flashT = setTimeout(() => setFlash(false), 1400);
    return () => {
      clearTimeout(scrollT);
      clearTimeout(flashT);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav?.n]);

  return (
    <div
      ref={ref}
      className={`check-card status-${check.status}${flash ? " check-flash" : ""}`}
      data-testid={`check-${check.id}`}
    >
      <button
        className="check-head"
        onClick={() => hasDetail && setOpen((o) => !o)}
        style={{ cursor: hasDetail ? "pointer" : "default" }}
        aria-expanded={open}
      >
        <span className="check-dot">
          <StatusDot status={check.status} />
        </span>
        <span className="check-id">{check.id}</span>
        <span className="check-name">{check.name}</span>
        <span className="check-value">{check.value}</span>
        <span className={`check-impact impact-${check.impact}`} title="Performance impact">
          {check.impact}
        </span>
        <span className="check-score" style={{ color: statusColorVar[check.status] }}>
          {isNa ? "N/A" : Math.round(check.score as number)}
        </span>
        <span className="chevron-sm">{hasDetail ? (open ? "▾" : "▸") : ""}</span>
      </button>

      {open && (
        <div className="check-body">
          {check.recommendation && (
            <div className="check-rec">
              <strong>Fix:</strong> {check.recommendation}
            </div>
          )}
          {check.evidence.length > 0 && (
            <>
              <div className="evidence-label">
                Affected ({check.evidence.length})
              </div>
              <ul className="evidence">
                {check.evidence.map((e, i) => (
                  <li key={i}>
                    <span className="ev-name">{e.name}</span>
                    {e.detail && <span className="ev-detail">{e.detail}</span>}
                    {e.id && <span className="ev-id">#{e.id}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
