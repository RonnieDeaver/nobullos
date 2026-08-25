/* test-registration
{
  "name": "CEO Pulse chart series validation — getUsableSeries keeps only series whose dataKey exists in chart.data (mismatched AI dataKeys → empty ⇒ explicit 'chart unavailable' state, never bar charts with empty axes) and de-duplicates repeated dataKeys (source of the React duplicate-key warning) (Task #4226)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4226: fast (~2s), pure, DB-free guard on the render-time gate that keeps CEO Pulse bar charts from shipping empty axes to clients when AI-emitted series dataKeys don't match chart.data; a silent drift here re-opens the exact client-visible failure this task fixed.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": ["client/src/components/CeoPulseChartRenderer.tsx"],
  "tier": "small"
}
test-registration */
/**
 * Task #4226 — CEO Pulse "By the Numbers" bar charts rendered axes with no
 * bars on a real finalized report because the AI emitted series[].dataKey
 * values that don't exist as keys in chart.data rows (every point coerced to
 * 0). getUsableSeries is the render-time gate: renderGroupedBar and
 * renderStackedBar draw only usable series, and an empty result renders the
 * explicit "chart unavailable" card instead of empty axes. Duplicate dataKeys
 * (same mismatch family) previously produced React duplicate-key warnings;
 * the helper de-duplicates them so element keys stay unique.
 *
 * Hermetic: pure function import only — no DOM, no fetch, no server.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getUsableSeries, type CeoPulseChart } from "../../client/src/components/CeoPulseChartRenderer";

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const base: CeoPulseChart = { type: "grouped_bar", title: "By the Numbers" };

// 1. Matching dataKeys pass through.
{
  const chart: CeoPulseChart = {
    ...base,
    data: [{ label: "Jan", value: 5, current: 5, previous: 3 } as any],
    series: [
      { name: "Current", dataKey: "current" },
      { name: "Previous", dataKey: "previous" },
    ],
  };
  const usable = getUsableSeries(chart);
  assert.deepEqual(usable.map(s => s.dataKey), ["current", "previous"]);
  ok("series whose dataKeys exist in the data rows are kept, in order");
}

// 2. Fully mismatched dataKeys → empty (renderer shows 'chart unavailable').
{
  const chart: CeoPulseChart = {
    ...base,
    data: [{ label: "Jan", value: 5 }, { label: "Feb", value: 7 }],
    series: [
      { name: "Leads", dataKey: "leads_2026" },
      { name: "Cases", dataKey: "cases_2026" },
    ],
  };
  assert.deepEqual(getUsableSeries(chart), []);
  ok("series dataKeys absent from every data row yield [] (→ explicit unavailable state, not empty axes)");
}

// 3. Partial mismatch keeps only the matching series.
{
  const chart: CeoPulseChart = {
    ...base,
    data: [{ label: "Jan", value: 5, leads: 12 } as any],
    series: [
      { name: "Leads", dataKey: "leads" },
      { name: "Ghost", dataKey: "doesNotExist" },
    ],
  };
  assert.deepEqual(getUsableSeries(chart).map(s => s.dataKey), ["leads"]);
  ok("partially mismatched series lists keep only the series that can draw bars");
}

// 4. Duplicate dataKeys are de-duplicated (React duplicate-key warning source).
{
  const chart: CeoPulseChart = {
    ...base,
    data: [{ label: "Jan", value: 5, n: 1 } as any],
    series: [
      { name: "A", dataKey: "n" },
      { name: "A again", dataKey: "n" },
    ],
  };
  const usable = getUsableSeries(chart);
  assert.equal(usable.length, 1);
  assert.equal(usable[0].name, "A");
  ok("repeated dataKeys collapse to the first occurrence — element keys stay unique");
}

// 5. A key present in SOME rows (null/undefined in others) still counts as usable.
{
  const chart: CeoPulseChart = {
    ...base,
    data: [
      { label: "Jan", value: 5 },
      { label: "Feb", value: 7, cases: 3 } as any,
    ],
    series: [{ name: "Cases", dataKey: "cases" }],
  };
  assert.deepEqual(getUsableSeries(chart).map(s => s.dataKey), ["cases"]);
  ok("a dataKey carried by at least one row is usable (sparse rows don't blank the chart)");
}

// 6. Degenerate inputs: no series / no data / null rows / blank dataKey.
{
  assert.deepEqual(getUsableSeries({ ...base }), []);
  assert.deepEqual(getUsableSeries({ ...base, series: [], data: [{ label: "x", value: 1 }] }), []);
  assert.deepEqual(getUsableSeries({ ...base, series: [{ name: "A", dataKey: "value" }], data: [] }), []);
  assert.deepEqual(
    getUsableSeries({ ...base, series: [{ name: "A", dataKey: "" }], data: [{ label: "x", value: 1 }] }),
    [],
  );
  assert.deepEqual(
    getUsableSeries({ ...base, series: [{ name: "A", dataKey: "value" }], data: [null as any, { label: "x", value: 1 }] }).map(s => s.dataKey),
    ["value"],
  );
  ok("degenerate inputs (missing/empty series or data, blank dataKey, null rows) are handled safely");
}

// 7. Source scan (Task #4286 completion review): every recharts series element
// in CeoPulseChartRenderer.tsx must carry the threaded isAnimationActive={animate}
// prop. The public report renders with animate={false} (deck charts must mount
// settled — no entry animation, no print double-paint); a series tag that omits
// the prop silently falls back to recharts' animated default. The target-overlay
// <Line> in the single-series branch shipped exactly this miss.
{
  const src = readFileSync("client/src/components/CeoPulseChartRenderer.tsx", "utf8");
  // Extract each opening tag with a brace-depth walk: a JSX prop like
  // dataKey={() => chart.target} contains ">", so a naive [^>]* regex would
  // truncate the tag early. The tag ends at the first ">" at brace depth 0.
  const openings: { tag: string; text: string; line: number }[] = [];
  const re = /<(Line|Bar|Area|Pie|Radar|Scatter)[\s\n/>]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 0;
    let end = m.index;
    for (let i = m.index; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) {
        end = i;
        break;
      }
    }
    openings.push({
      tag: m[1],
      text: src.slice(m.index, end + 1),
      line: src.slice(0, m.index).split("\n").length,
    });
  }
  // The scan must actually execute against the real series inventory —
  // 0-of-0 would mean the regex rotted, not that the contract holds.
  assert.ok(
    openings.length >= 16,
    `expected >=16 recharts series elements in CeoPulseChartRenderer.tsx, found ${openings.length} — scan regex rotted?`,
  );
  const missing = openings.filter((o) => !o.text.includes("isAnimationActive={animate}"));
  assert.deepEqual(
    missing.map((o) => `${o.tag}@line${o.line}`),
    [],
    `recharts series elements missing isAnimationActive={animate}: ${missing.map((o) => `${o.tag}@line${o.line}`).join(", ")}`,
  );
  const targetLines = openings.filter((o) => o.text.includes("chart.target"));
  assert.ok(
    targetLines.length >= 2 && targetLines.every((o) => o.text.includes("isAnimationActive={animate}")),
    "both target-overlay <Line>s (series + single-series branches) thread animate",
  );
  ok(`all ${openings.length} recharts series elements thread isAnimationActive={animate} (incl. ${targetLines.length} target overlays)`);
}

console.log(`\nCEO Pulse series validation: ${passed} checks passed`);
