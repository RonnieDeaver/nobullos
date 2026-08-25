// Performance overview composition — how the range splits across the client's accounts:
// a Spend donut and a Leads donut (true part-to-whole shares) plus a CPL bar comparison
// (CPL is a ratio, not a share of anything — slices of it would be meaningless, so it
// gets bars). Colors are categorical PER ACCOUNT, assigned in fixed account order and
// shared across all three panels + the legend + the breakdown cards, so one account is
// one color everywhere. Slices carry a 2px surface gap; identity is never color-alone
// (legend + hover titles).

import { moneyShort } from "../lib/chart";
import { formatCpl } from "../lib/format";

export interface CompositionItem {
  id: string;        // product:cid
  label: string;     // short display label ("GAds", city, or truncated name)
  color: string;
  spend: number;
  leads: number;
  cpl: number | null;
}

// Validated 7-step categorical palette (dataviz six checks, fixed order), as
// theme variables so the donuts/bars/legend follow the Ads OS light/dark theme.
// Light values (adsOs.css) are the original validated hexes
// #8b292f/#2563eb/#16a34a/#7c3aed/#b45309/#0891b2/#be185d; dark lifts each hue.
export const ACCOUNT_PALETTE = [
  "var(--acct-1)", "var(--acct-2)", "var(--acct-3)", "var(--acct-4)",
  "var(--acct-5)", "var(--acct-6)", "var(--acct-7)",
] as const;

function pct(v: number, total: number): string {
  return total > 0 ? `${Math.round((v / total) * 100)}%` : "0%";
}

// One donut: slices ordered largest-first (each keeps its account's color), 2px panel
// gaps, the range total in the hole, hover <title> per slice with value + share.
function Donut({
  title,
  items,
  value,
  fmtVal,
  centerText,
}: {
  title: string;
  items: CompositionItem[];
  value: (i: CompositionItem) => number;
  fmtVal: (v: number) => string;
  centerText: string;
}) {
  const size = 168, cx = size / 2, cy = size / 2, r = 62, hole = 40;
  const nonzero = items.filter((i) => value(i) > 0).sort((a, b) => value(b) - value(a));
  const total = nonzero.reduce((a, i) => a + value(i), 0);

  const arcs: { d: string; item: CompositionItem }[] = [];
  if (nonzero.length === 1) {
    // A full 360° arc degenerates in SVG path math — draw a ring instead.
  } else {
    let a0 = -Math.PI / 2;
    for (const item of nonzero) {
      const frac = value(item) / total;
      const a1 = a0 + frac * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (a: number, rad: number) =>
        `${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`;
      arcs.push({
        d: `M ${p(a0, r)} A ${r},${r} 0 ${large} 1 ${p(a1, r)} L ${p(a1, hole)} A ${hole},${hole} 0 ${large} 0 ${p(a0, hole)} Z`,
        item,
      });
      a0 = a1;
    }
  }

  return (
    <div className="perf-panel">
      <div className="perf-panel-title">{title}</div>
      {total <= 0 ? (
        <div className="muted perf-panel-empty">Nothing in this range.</div>
      ) : (
        <svg viewBox={`0 0 ${size} ${size}`} className="perf-donut" role="img" aria-label={title}>
          {nonzero.length === 1 ? (
            <circle
              cx={cx} cy={cy} r={(r + hole) / 2}
              fill="none" stroke={nonzero[0].color} strokeWidth={r - hole}
            >
              <title>{`${nonzero[0].label}: ${fmtVal(value(nonzero[0]))} (100%)`}</title>
            </circle>
          ) : (
            arcs.map((a) => (
              <path key={a.item.id} d={a.d} fill={a.item.color} className="perf-slice">
                <title>{`${a.item.label}: ${fmtVal(value(a.item))} (${pct(value(a.item), total)})`}</title>
              </path>
            ))
          )}
          <text className="perf-donut-total" x={cx} y={cy - 1} textAnchor="middle">
            {centerText}
          </text>
          <text className="perf-donut-sub" x={cx} y={cy + 13} textAnchor="middle">
            total
          </text>
        </svg>
      )}
    </div>
  );
}

// CPL comparison: one thin rounded bar per account (ascending — cheapest leads first).
// Accounts with no leads in the range have no CPL and are left out here (they still
// show in the legend + donuts + breakdown).
function CplBars({ items }: { items: CompositionItem[] }) {
  const rows = items
    .filter((i): i is CompositionItem & { cpl: number } => i.cpl !== null)
    .sort((a, b) => a.cpl - b.cpl);
  const max = Math.max(1e-9, ...rows.map((r) => r.cpl));
  return (
    <div className="perf-panel">
      <div className="perf-panel-title">CPL by account</div>
      {rows.length === 0 ? (
        <div className="muted perf-panel-empty" role="status">No leads in this range, so there's no CPL to compare. Widen the date range.</div>
      ) : (
        <div className="perf-bars">
          {rows.map((r) => (
            <div className="perf-bar-row" key={r.id} title={`${r.label}: ${formatCpl(r.cpl)} per lead`}>
              <span className="perf-bar-label">{r.label}</span>
              <span className="perf-bar-track">
                <span
                  className="perf-bar-fill"
                  style={{ width: `${Math.max(3, (r.cpl / max) * 100)}%`, background: r.color }}
                />
              </span>
              <span className="perf-bar-val tnum">{formatCpl(r.cpl)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// `legend` — the Overview card renders its per-account totals strip (dot + label +
// numbers) directly above this row, which already covers the legend's job; passing
// false skips the redundant plain legend while keeping it for any other caller.
export function CompositionRow({ items, legend = true }: { items: CompositionItem[]; legend?: boolean }) {
  const totalSpend = items.reduce((a, i) => a + i.spend, 0);
  const totalLeads = items.reduce((a, i) => a + i.leads, 0);
  return (
    <>
      <div className="perf-comp">
        <Donut
          title="Spend by account"
          items={items}
          value={(i) => i.spend}
          fmtVal={(v) => `$${Math.round(v).toLocaleString()}`}
          centerText={moneyShort(totalSpend)}
        />
        <Donut
          title="Leads by account"
          items={items}
          value={(i) => i.leads}
          fmtVal={(v) => String(Math.round(v))}
          centerText={String(Math.round(totalLeads))}
        />
        <CplBars items={items} />
      </div>
      {legend && (
        <div className="perf-legend">
          {items.map((i) => (
            <span className="perf-legend-item" key={i.id}>
              <span className="perf-dot" style={{ background: i.color }} />
              {i.label}
            </span>
          ))}
        </div>
      )}
    </>
  );
}
