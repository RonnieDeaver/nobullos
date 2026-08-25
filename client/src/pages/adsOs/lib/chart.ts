// Shared SVG chart math for the hand-rolled charts (PacingChart; PerfChart in a
// later phase). No chart lib — keeps the bundle tiny and the rendering crisp.
// Verbatim port of the bundle's frontend/src/chart.ts.

// Monotone cubic (Fritsch–Carlson) — a smooth curve that never overshoots, so
// frequent drops to $0 (paused days) stay pinned to the baseline instead of dipping
// below it the way a naive Catmull-Rom spline would.
export function monotonePath(pts: [number, number][]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M ${pts[0][0]},${pts[0][1]}`;
  if (n === 2) return `M ${pts[0][0]},${pts[0][1]} L ${pts[1][0]},${pts[1][1]}`;

  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = xs[i + 1] - xs[i];
    dx.push(h);
    slope.push(h === 0 ? 0 : (ys[i + 1] - ys[i]) / h);
  }

  const m = new Array<number>(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }

  const d = [`M ${xs[0].toFixed(2)},${ys[0].toFixed(2)}`];
  for (let i = 0; i < n - 1; i++) {
    const c1x = xs[i] + dx[i] / 3;
    const c1y = ys[i] + (m[i] * dx[i]) / 3;
    const c2x = xs[i + 1] - dx[i] / 3;
    const c2y = ys[i + 1] - (m[i + 1] * dx[i]) / 3;
    d.push(
      `C ${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${xs[i + 1].toFixed(2)},${ys[i + 1].toFixed(2)}`
    );
  }
  return d.join(" ");
}

// Compact $ axis label: $12.3k / $980. Shared by the chart y-axes.
export function moneyShort(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
}
