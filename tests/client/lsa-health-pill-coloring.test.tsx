/* test-registration
{
  "name": "LSA HealthPill coloring thresholds — jsdom unit confirms green (>=75), yellow (>=60), orange (>=40), red (<40), Inactive band, and null render at each boundary value",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4836: HealthPill uses four hard-coded coloring thresholds (75/60/40) via scoreColorVar. Without a test a mis-edit ships silently. This pins every boundary value (null, Inactive, 39, 40, 59, 60, 74, 75, 100) and the null/Inactive paths. DB-free, network-free, fast jsdom render.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/combined-pace-cell-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4836 — HealthPill health-score coloring threshold guard.
 *
 * HealthPill colors the hygiene score via scoreColorVar() with four bands:
 *   score >= 75  → "var(--green)"
 *   score >= 60  → "var(--yellow)"
 *   score >= 40  → "var(--orange)"
 *   score <  40  → "var(--red)"
 *   score === null → renders a dash span with class "muted", no pill
 *   band === "Inactive" → renders a dash link with class "muted", no score
 *
 * Boundary values tested: null, Inactive, 39, 40, 59, 60, 74, 75, 100.
 *
 * DB-free, network-free, fast jsdom render. Globals + css stub installed by
 * combined-pace-cell-setup.mjs (--import).
 */

import { strict as assert } from "node:assert";

// Throw on any unexpected network access.
(globalThis as any).fetch = () => {
  throw new Error("unexpected fetch from lsa-health-pill-coloring test");
};

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { HealthPill } = await import("../../client/src/pages/adsOs/components/HealthPill");

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}
function eq(a: unknown, b: unknown, label: string): void {
  assert.equal(a, b, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

const doc = (globalThis as any).document;

interface MountProps {
  score: number | null;
  band: string | null;
  at?: string | null;
}

let root: any = null;

async function mount(props: MountProps): Promise<void> {
  const container = doc.getElementById("root")!;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(HealthPill as any, {
        score: props.score,
        band: props.band,
        at: props.at ?? null,
        href: "/ads-os/lsa/a/1234567890/hygiene",
        testId: "health-pill-test",
      }),
    );
  });
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
    root = null;
  });
}

/** Return the top-level element rendered inside #root. */
function getEl(): HTMLElement | null {
  return doc.querySelector("#root > *") as HTMLElement | null;
}

// ── 1. score === null → dash span with class "muted" ─────────────────────────
{
  await mount({ score: null, band: null });
  const el = getEl();
  ok(!!el, "null score: element renders");
  eq(el!.tagName.toLowerCase(), "span", "null score: renders a span (not a link)");
  ok(el!.classList.contains("muted"), "null score: has class 'muted'");
  eq(el!.textContent, "—", "null score: text content is em-dash");
  ok(!el!.classList.contains("health-pill"), "null score: no health-pill class");
  await unmount();
}

// ── 2. band === "Inactive" (non-null score) → dash link with class "muted" ───
{
  await mount({ score: 72, band: "Inactive" });
  const el = getEl();
  ok(!!el, "Inactive: element renders");
  eq(el!.tagName.toLowerCase(), "a", "Inactive: renders a link");
  ok(el!.classList.contains("muted"), "Inactive: has class 'muted'");
  eq(el!.textContent, "—", "Inactive: text content is em-dash");
  ok(!el!.classList.contains("health-pill"), "Inactive: no health-pill class");
  await unmount();
}

// ── 3. score = 39 → red ("var(--red)"), below orange threshold ───────────────
{
  await mount({ score: 39, band: "Poor" });
  const el = getEl();
  ok(!!el, "39: element renders");
  eq(el!.tagName.toLowerCase(), "a", "39: renders a link");
  ok(el!.classList.contains("health-pill"), "39: has health-pill class");
  const style = el!.getAttribute("style") ?? "";
  ok(style.includes("var(--red)"), `39: color is var(--red) [got: ${style}]`);
  ok(!style.includes("var(--orange)"), "39: not var(--orange)");
  ok(!style.includes("var(--yellow)"), "39: not var(--yellow)");
  ok(!style.includes("var(--green)"), "39: not var(--green)");
  eq(el!.textContent, "39", "39: displays rounded score");
  await unmount();
}

// ── 4. score = 40 → orange ("var(--orange)"), boundary inclusive ─────────────
{
  await mount({ score: 40, band: "Poor" });
  const el = getEl();
  ok(!!el, "40: element renders");
  ok(el!.classList.contains("health-pill"), "40: has health-pill class");
  const style = el!.getAttribute("style") ?? "";
  ok(style.includes("var(--orange)"), `40: color is var(--orange) [got: ${style}]`);
  ok(!style.includes("var(--red)"), "40: not var(--red)");
  ok(!style.includes("var(--yellow)"), "40: not var(--yellow)");
  ok(!style.includes("var(--green)"), "40: not var(--green)");
  eq(el!.textContent, "40", "40: displays rounded score");
  await unmount();
}

// ── 5. score = 59 → orange, below yellow threshold ──────────────────────────
{
  await mount({ score: 59, band: "Fair" });
  const el = getEl();
  ok(!!el, "59: element renders");
  ok(el!.classList.contains("health-pill"), "59: has health-pill class");
  const style = el!.getAttribute("style") ?? "";
  ok(style.includes("var(--orange)"), `59: color is var(--orange) [got: ${style}]`);
  ok(!style.includes("var(--yellow)"), "59: not var(--yellow)");
  ok(!style.includes("var(--green)"), "59: not var(--green)");
  await unmount();
}

// ── 6. score = 60 → yellow ("var(--yellow)"), boundary inclusive ─────────────
{
  await mount({ score: 60, band: "Fair" });
  const el = getEl();
  ok(!!el, "60: element renders");
  ok(el!.classList.contains("health-pill"), "60: has health-pill class");
  const style = el!.getAttribute("style") ?? "";
  ok(style.includes("var(--yellow)"), `60: color is var(--yellow) [got: ${style}]`);
  ok(!style.includes("var(--orange)"), "60: not var(--orange)");
  ok(!style.includes("var(--red)"), "60: not var(--red)");
  ok(!style.includes("var(--green)"), "60: not var(--green)");
  eq(el!.textContent, "60", "60: displays rounded score");
  await unmount();
}

// ── 7. score = 74 → yellow, below green threshold ───────────────────────────
{
  await mount({ score: 74, band: "Fair" });
  const el = getEl();
  ok(!!el, "74: element renders");
  ok(el!.classList.contains("health-pill"), "74: has health-pill class");
  const style = el!.getAttribute("style") ?? "";
  ok(style.includes("var(--yellow)"), `74: color is var(--yellow) [got: ${style}]`);
  ok(!style.includes("var(--green)"), "74: not var(--green)");
  eq(el!.textContent, "74", "74: displays rounded score");
  await unmount();
}

// ── 8. score = 75 → green ("var(--green)"), boundary inclusive ───────────────
{
  await mount({ score: 75, band: "Good" });
  const el = getEl();
  ok(!!el, "75: element renders");
  ok(el!.classList.contains("health-pill"), "75: has health-pill class");
  const style = el!.getAttribute("style") ?? "";
  ok(style.includes("var(--green)"), `75: color is var(--green) [got: ${style}]`);
  ok(!style.includes("var(--yellow)"), "75: not var(--yellow)");
  ok(!style.includes("var(--orange)"), "75: not var(--orange)");
  ok(!style.includes("var(--red)"), "75: not var(--red)");
  eq(el!.textContent, "75", "75: displays rounded score");
  await unmount();
}

// ── 9. score = 100 → green ───────────────────────────────────────────────────
{
  await mount({ score: 100, band: "Good" });
  const el = getEl();
  ok(!!el, "100: element renders");
  ok(el!.classList.contains("health-pill"), "100: has health-pill class");
  const style = el!.getAttribute("style") ?? "";
  ok(style.includes("var(--green)"), `100: color is var(--green) [got: ${style}]`);
  ok(!style.includes("var(--yellow)"), "100: not var(--yellow)");
  ok(!style.includes("var(--orange)"), "100: not var(--orange)");
  ok(!style.includes("var(--red)"), "100: not var(--red)");
  eq(el!.textContent, "100", "100: displays rounded score");
  await unmount();
}

// ── 10. score = 72.6 → rounds to 73, green ───────────────────────────────────
{
  await mount({ score: 72.6, band: "Fair" });
  const el = getEl();
  ok(!!el, "72.6: element renders");
  ok(el!.classList.contains("health-pill"), "72.6: has health-pill class");
  eq(el!.textContent, "73", "72.6: displays Math.round(72.6) = 73");
  await unmount();
}

console.log(`\n✓ All ${passed} assertions passed.`);
