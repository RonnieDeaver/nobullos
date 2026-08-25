import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

/** Muted context line under a row (Task #3897: the combined pill's per-account
 *  reconciliation details). `warn` = amber emphasis (stale "as of" flag). */
export interface PaceSubLine {
  text: string;
  warn?: boolean;
}

export interface PaceRow {
  label: ReactNode;
  value: string;
  /** Optional sub-lines rendered under the row. */
  sub?: PaceSubLine[];
}

// Clickable budget-pacing pill (all three dashboards): the pill is a button and
// clicking it drops down a small panel — same design as the client profile's
// alerts dropdown — with the pacing details that used to live in the hover
// tooltip. The panel is position:fixed so the tables' scroll containers can't
// clip it; it closes on outside click, Escape, scroll, or resize. Clicks are
// stopped from bubbling so opening the panel never triggers the row's own
// click action (navigate / expand).
export function PacePill({
  cls,
  text,
  note,
  rows,
  testId,
}: {
  cls: string; // bp-pill tone: g | w | b | hit | hit-paused
  text: string; // pill label, e.g. "+74%" or "MBH"
  note?: string | null; // lead-in line (the MBH explanation)
  rows: PaceRow[];
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // Audit P2-9 (§4.4) — the scroll/resize listeners below are deliberately JS,
  // noted as intentional: the panel is position:fixed (so `.os-table-wrap`
  // scroll containers can't clip it) and anchored to a click-time
  // getBoundingClientRect() snapshot. Scroll/resize invalidate that snapshot,
  // so the panel closes rather than drifting — stateful dismissal behavior no
  // CSS media/container query can express. They are also transient: attached
  // only while the panel is open, removed on close.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onMove() {
      setOpen(false); // fixed-position panel: close rather than drift on scroll/resize
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  function toggle(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    // Right-aligned under the pill (the pacing columns sit at the table's right edge).
    setPos({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
    setOpen((o) => !o);
  }

  return (
    <span className="pace-wrap" ref={wrapRef}>
      <button
        className={`bp-pill ${cls}`}
        onClick={toggle}
        onKeyDown={(e) => e.stopPropagation()}
        aria-expanded={open}
        aria-haspopup="true"
        title="Pacing details"
        data-testid={testId}
      >
        {text} <span className="pc">{open ? "▴" : "▾"}</span>
      </button>
      {open && pos && (
        <div
          className="pace-menu"
          style={{ top: pos.top, right: pos.right }}
          onClick={(e) => e.stopPropagation()}
        >
          {note && <div className="note">{note}</div>}
          {rows.map((r, i) => (
            <Fragment key={i}>
              <div className="row">
                <span className="k">{r.label}</span>
                <span className="v">{r.value}</span>
              </div>
              {r.sub?.map((s, j) => (
                <div className={`sub${s.warn ? " warn" : ""}`} key={j}>
                  {s.text}
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      )}
    </span>
  );
}
