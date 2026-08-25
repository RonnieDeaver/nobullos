/* test-registration
{
  "name": "PacePill popup layout — CSS-source pins divider border rule, menu min/max-width, warn-class font-weight, and note separator; jsdom render confirms panel, .k/.v rows, sub-line warn class, and note element; covers CombinedPaceCell (main dashboard), LSA PaceCell, and GAds PaceCell variants; dismissal guard verifies Escape, outside/inside interaction, movement close, and scroll/resize listener cleanup",
  "regression": true,
  "smoke": true,
  "smokeReason": "Catches broken pacing popup layout (missing dividers, wrong width, note line absent, warn class dropped) before it ships. CSS-source assertions directly pin the adsOs.css selector/declaration pairs — deleting the border-top rule or changing min-width would fail immediately. jsdom render confirms component wiring for PacePill, CombinedPaceCell, LSA PaceCell, and GAds PaceCell. Dismissal tests guard Escape/outside-click/movement close, inside-click stopPropagation, and scroll/resize listener cleanup over repeated open/close cycles. DB-free, network-free.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/combined-pace-cell-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/pages/adsOs/adsOs.css"
  ],
  "tier": "small"
}
test-registration */
/**
 * PacePill popup layout regression guard (Task #4956).
 *
 * Two-layer guard:
 *
 * LAYER 1 — CSS source assertions (Section 0):
 *   Reads adsOs.css directly and pins the exact selector+declaration pairs that
 *   produce the popup layout. These catch breakage even if the jsdom render never
 *   sees the CSS (jsdom stubs CSS imports). Assertions:
 *     a. `.ads-os .pace-menu` has `min-width: 340px` and
 *        `max-width: min(460px, calc(100vw - 24px))` (width constraints).
 *     b. The adjacent-sibling divider rule exists:
 *        `.ads-os .pace-menu .row + .row` / `.ads-os .pace-menu .sub + .row`
 *        carries `border-top: 1px solid var(--border)`.
 *     c. `.ads-os .pace-menu .sub.warn` carries `font-weight: 600`
 *        (amber emphasis; absence means warn lines look identical to normal).
 *     d. `.ads-os .pace-menu .note` carries `border-bottom: 1px solid var(--border)`
 *        (separator line between the note and the data rows).
 *
 * LAYER 2 — jsdom render (Sections 1–8):
 *   Mounts PacePill / CombinedPaceCell / PaceCell in a real jsdom DOM and asserts:
 *     1. Clicking the pill opens `.pace-menu`.
 *     2. Each row has `.k` (label) and `.v` (value) spans.
 *     3. Sub-lines with `warn: true` carry `.warn` class; `warn: false` do not.
 *     4. `note` prop renders `.note`; absent prop renders nothing.
 *     5. CombinedPaceCell opens a panel with totals + member rows and MBH note.
 *     6. A paused CombinedPaceCell budget hit uses the hit-paused class and note.
 *     7. LSA PaceCell opens a panel with budget/MTD/schedule rows and MBH note.
 *
 * DB-free, network-free. jsdom globals + css stub loader installed by
 * tests/client/combined-pace-cell-setup.mjs via --import.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

// ═══════════════════════════════════════════════════════════════════════════════
// Section 0 — CSS source assertions: pin the exact declarations responsible for
// the popup layout. These run before any jsdom mount and do NOT depend on CSS
// being applied by a browser engine — they fail the moment a developer removes
// or renames the relevant selector/property in adsOs.css.
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n── 0. adsOs.css: popup layout declarations pinned ──────────────");
{
  // Resolve relative to the workspace root (this file lives at tests/client/).
  const cssPath = new URL("../../client/src/pages/adsOs/adsOs.css", import.meta.url);
  const css = readFileSync(fileURLToPath(cssPath), "utf8");

  // ── 0a. Menu container: width constraints ────────────────────────────────
  // The popup must be wide enough to show label + value pairs without wrapping
  // (min-width) and must not overflow narrow viewports (max-width).
  const menuBlockMatch = css.match(/\.ads-os\s+\.pace-menu\s*\{([^}]+)\}/);
  ok(!!menuBlockMatch, "adsOs.css: .ads-os .pace-menu block exists");
  const menuBlock = menuBlockMatch![1];
  ok(menuBlock.includes("min-width: 340px"),
    "adsOs.css: .pace-menu has min-width: 340px (popup too narrow = truncated labels)");
  ok(menuBlock.includes("max-width: min(460px, calc(100vw - 24px))"),
    "adsOs.css: .pace-menu has max-width: min(460px, calc(100vw - 24px)) — both the 460px cap and the 24px viewport margin are required");

  // ── 0b. Divider borders between rows ─────────────────────────────────────
  // The `.row + .row` and `.sub + .row` sibling selectors insert a 1px border
  // between rows. Removing either selector makes dividers disappear for adjacent
  // (or sub-preceded) rows without any DOM change.
  const rowPlusRow = /\.ads-os\s+\.pace-menu\s+\.row\s*\+\s*\.row/.test(css);
  ok(rowPlusRow,
    "adsOs.css: .pace-menu .row + .row selector exists (inter-row divider)");

  const subPlusRow = /\.ads-os\s+\.pace-menu\s+\.sub\s*\+\s*\.row/.test(css);
  ok(subPlusRow,
    "adsOs.css: .pace-menu .sub + .row selector exists (divider after sub-line)");

  // Both selectors must carry border-top — find the combined rule block.
  // The selectors appear on consecutive lines sharing one declaration block.
  const dividerMatch = css.match(
    /\.ads-os\s+\.pace-menu\s+\.row\s*\+\s*\.row\s*,\s*\n\s*\.ads-os\s+\.pace-menu\s+\.sub\s*\+\s*\.row\s*\{([^}]+)\}/,
  );
  ok(!!dividerMatch, "adsOs.css: row+row / sub+row share a combined rule block");
  const dividerBlock = dividerMatch![1];
  ok(dividerBlock.includes("border-top:"),
    "adsOs.css: divider block declares border-top (row separators)");
  ok(dividerBlock.includes("1px solid var(--border)"),
    "adsOs.css: divider border-top is '1px solid var(--border)'");

  // ── 0c. Warn sub-line: amber emphasis via font-weight ────────────────────
  // `.sub.warn` raises font-weight to 600 so stale-run lines stand out.
  // Removing it makes warn lines visually identical to normal sub-lines.
  const warnMatch = css.match(/\.ads-os\s+\.pace-menu\s+\.sub\.warn\s*\{([^}]+)\}/);
  ok(!!warnMatch, "adsOs.css: .pace-menu .sub.warn block exists");
  const warnBlock = warnMatch![1];
  ok(warnBlock.includes("font-weight: 600"),
    "adsOs.css: .sub.warn has font-weight: 600 (amber stale-run emphasis)");
  ok(warnBlock.includes("color: var(--warn-deep)"),
    "adsOs.css: .sub.warn has color: var(--warn-deep)");

  // ── 0d. Note separator: border-bottom between note and rows ──────────────
  // The `.note` div has a border-bottom that visually separates the lead-in
  // line (e.g. the MBH explanation) from the data rows below it.
  const noteMatch = css.match(/\.ads-os\s+\.pace-menu\s+\.note\s*\{([^}]+)\}/);
  ok(!!noteMatch, "adsOs.css: .pace-menu .note block exists");
  const noteBlock = noteMatch![1];
  ok(noteBlock.includes("border-bottom:"),
    "adsOs.css: .note has border-bottom (separator between note and rows)");
  ok(noteBlock.includes("1px solid var(--border)"),
    "adsOs.css: .note border-bottom is '1px solid var(--border)'");
}

const dom = (globalThis as any).window;

// PacePill / CombinedPaceCell / PaceCell make no network calls — a throwing
// fetch is a regression tripwire for any new import-graph side-effect.
(globalThis as any).fetch = () => {
  throw new Error("unexpected fetch in pace-pill-popup-layout test");
};

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { PacePill } = await import("../../client/src/pages/adsOs/components/PacePill");
const { CombinedPaceCell } = await import("../../client/src/pages/adsOs/MainDashboard");
const { PaceCell } = await import("../../client/src/pages/adsOs/LsaDashboard");
const { PaceCell: GadsPaceCell } = await import("../../client/src/pages/adsOs/GadsDashboard");

const doc = (globalThis as any).document;

let root: any = null;

async function mount(element: any): Promise<void> {
  const container = doc.getElementById("root")!;
  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
    root = null;
  });
  // Ensure cleanup: close any open menu remnants
  doc.getElementById("root")!.innerHTML = "";
}

async function clickPill(selector: string): Promise<void> {
  const pill = doc.querySelector(selector) as HTMLElement | null;
  assert.ok(pill, `pill element found: ${selector}`);
  await act(async () => {
    pill!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function menuRows(): { label: string; value: string }[] {
  return Array.from(doc.querySelectorAll(".pace-menu .row")).map((el: any) => ({
    label: el.querySelector(".k")?.textContent ?? "",
    value: el.querySelector(".v")?.textContent ?? "",
  }));
}

function menuSubs(): { text: string; warn: boolean }[] {
  return Array.from(doc.querySelectorAll(".pace-menu .sub")).map((el: any) => ({
    text: el.textContent ?? "",
    warn: (el.className as string).split(" ").includes("warn"),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Section 1 — PacePill direct render: structural layout invariants
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n── 1. PacePill: panel renders when pill is clicked ──────────────");
{
  await mount(
    React.createElement(PacePill, {
      cls: "g",
      text: "+10%",
      rows: [
        { label: "Monthly budget", value: "$1,000.00" },
        { label: "MTD spend", value: "$500.00" },
      ],
      testId: "pill-layout-test",
    }),
  );

  // Before click: no menu
  ok(!doc.querySelector(".pace-menu"), "pace-menu is absent before the pill is clicked");

  await clickPill('[data-testid="pill-layout-test"]');

  // After click: menu appears
  ok(!!doc.querySelector(".pace-menu"), "pace-menu renders after clicking the pill");

  // Rows have .k and .v spans
  const rows = menuRows();
  ok(rows.length === 2, "both rows are rendered");
  eq(rows[0]!.label, "Monthly budget", ".k of row 0 = 'Monthly budget'");
  eq(rows[0]!.value, "$1,000.00", ".v of row 0 = '$1,000.00'");
  eq(rows[1]!.label, "MTD spend", ".k of row 1 = 'MTD spend'");
  eq(rows[1]!.value, "$500.00", ".v of row 1 = '$500.00'");

  // Multiple rows exist (which causes the CSS `.row + .row { border-top }` rule
  // to insert dividers). We verify element count — the divider is structural CSS
  // that depends solely on adjacency.
  const rowEls = doc.querySelectorAll(".pace-menu .row");
  ok(rowEls.length >= 2, "at least 2 .row elements exist so CSS dividers are triggered between them");

  await unmount();
}

console.log("\n── 2. PacePill: sub-lines render with/without warn class ────────");
{
  await mount(
    React.createElement(PacePill, {
      cls: "w",
      text: "+3%",
      rows: [
        {
          label: "Account A",
          value: "+3% · $2,000.00 · MTD $1,500.00",
          sub: [
            { text: "Fresh sub-line", warn: false },
            { text: "Stale — re-run before comparing", warn: true },
          ],
        },
      ],
      testId: "pill-warn-test",
    }),
  );

  await clickPill('[data-testid="pill-warn-test"]');

  const subs = menuSubs();
  ok(subs.length === 2, "both sub-lines render");
  ok(!subs[0]!.warn, "first sub-line (warn: false) does NOT have .warn class");
  ok(subs[1]!.warn, "second sub-line (warn: true) DOES have .warn class");
  eq(subs[1]!.text, "Stale — re-run before comparing", "warn sub-line text is correct");

  await unmount();
}

console.log("\n── 3. PacePill: note prop renders .note element ─────────────────");
{
  await mount(
    React.createElement(PacePill, {
      cls: "hit",
      text: "MBH",
      note: "Monthly Budget Hit — MTD spend has reached the monthly budget",
      rows: [{ label: "MTD spend", value: "$2,000.00" }],
      testId: "pill-note-test",
    }),
  );

  await clickPill('[data-testid="pill-note-test"]');

  const noteEl = doc.querySelector(".pace-menu .note") as HTMLElement | null;
  ok(!!noteEl, ".note element renders when note prop is supplied");
  ok(
    noteEl!.textContent!.includes("Monthly Budget Hit"),
    ".note element contains the note text",
  );

  await unmount();
}

console.log("\n── 4. PacePill: no .note element when note is absent ────────────");
{
  await mount(
    React.createElement(PacePill, {
      cls: "g",
      text: "+5%",
      rows: [{ label: "Budget", value: "$500.00" }],
      testId: "pill-nonote-test",
    }),
  );

  await clickPill('[data-testid="pill-nonote-test"]');

  ok(!doc.querySelector(".pace-menu .note"), "no .note element when note prop is absent");

  await unmount();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Section 2 — CombinedPaceCell (Main Dashboard): popup layout
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n── 5. CombinedPaceCell: popup rows and note (budget-hit) ────────");
{
  const combinedRow: any = {
    client: "Popup Layout Test",
    doer: null,
    checker: null,
    currency_code: "USD",
    has_gads: true,
    has_lsa: false,
    has_active_monitoring: true,
    spend_30d: 2000,
    spend_prev: 0,
    leads_30d: 10,
    leads_prev: 0,
    cpl_30d: 200,
    cpl_prev: null,
    metrics_partial: false,
    pacing_pct: 2,
    pacing_budget: 2000,
    pacing_mtd: 2000,
    pacing_hit: true, // budget hit — triggers MBH note
    members: [
      {
        product: "gads",
        customer_id: "1111111111",
        descriptive_name: "Layout Test GAds",
        city: null,
        ads_status: "on",
        spend_30d: 2000,
        leads_30d: 10,
        metrics_failed: false,
        pacing_pct: 2,
        pacing_budget: 2000,
        pacing_mtd: 2000,
      },
    ],
  };

  await mount(React.createElement(CombinedPaceCell as any, { r: combinedRow, c: "USD" }));

  await clickPill('[data-testid="pill-pace-popup-layout-test"]');

  ok(!!doc.querySelector(".pace-menu"), "CombinedPaceCell: .pace-menu panel renders");

  const rows = menuRows();
  ok(rows.length >= 2, "CombinedPaceCell: at least totals + member rows present");
  ok(
    rows.some((r) => r.label === "Total budget"),
    "CombinedPaceCell: 'Total budget' row is present",
  );
  ok(
    rows.some((r) => r.label === "Total MTD spend"),
    "CombinedPaceCell: 'Total MTD spend' row is present",
  );
  ok(
    rows.every((r) => r.label !== "" && r.value !== ""),
    "CombinedPaceCell: every .row has non-empty .k and .v",
  );

  // Budget-hit: note line present
  const noteEl = doc.querySelector(".pace-menu .note") as HTMLElement | null;
  ok(!!noteEl, "CombinedPaceCell: .note element renders for a budget-hit row");
  ok(noteEl!.textContent!.includes("Monthly Budget Hit"), "CombinedPaceCell: .note contains MBH text");

  // Multiple rows → divider borders
  const rowEls = doc.querySelectorAll(".pace-menu .row");
  ok(rowEls.length >= 2, "CombinedPaceCell: 2+ .row elements trigger CSS divider borders");

  await unmount();
}

console.log("\n── 6. CombinedPaceCell: no note when not a budget hit ────────────");
{
  const combinedRow: any = {
    client: "Under Budget Client",
    doer: null,
    checker: null,
    currency_code: "USD",
    has_gads: true,
    has_lsa: false,
    has_active_monitoring: true,
    spend_30d: 500,
    spend_prev: 0,
    leads_30d: 5,
    leads_prev: 0,
    cpl_30d: 100,
    cpl_prev: null,
    metrics_partial: false,
    pacing_pct: -8,
    pacing_budget: 2000,
    pacing_mtd: 500,
    pacing_hit: false, // not a budget hit
    members: [
      {
        product: "gads",
        customer_id: "2222222222",
        descriptive_name: "Under Budget GAds",
        city: null,
        ads_status: "on",
        spend_30d: 500,
        leads_30d: 5,
        metrics_failed: false,
        pacing_pct: -8,
        pacing_budget: 2000,
        pacing_mtd: 500,
      },
    ],
  };

  await mount(React.createElement(CombinedPaceCell as any, { r: combinedRow, c: "USD" }));

  await clickPill('[data-testid="pill-pace-under-budget-client"]');

  ok(!doc.querySelector(".pace-menu .note"), "CombinedPaceCell: no .note when pacing_hit = false");

  await unmount();
}

console.log("\n── 6b. CombinedPaceCell: paused budget-hit class and note ───────");
{
  const combinedRow: any = {
    client: "Paused Budget Hit Client",
    doer: null,
    checker: null,
    currency_code: "USD",
    has_gads: true,
    has_lsa: false,
    has_active_monitoring: true,
    spend_30d: 2000,
    spend_prev: 0,
    leads_30d: 10,
    leads_prev: 0,
    cpl_30d: 200,
    cpl_prev: null,
    metrics_partial: false,
    pacing_pct: 2,
    pacing_budget: 2000,
    pacing_mtd: 2000,
    pacing_hit: true,
    members: [
      {
        product: "gads",
        customer_id: "7777777777",
        descriptive_name: "Paused Layout Test GAds",
        city: null,
        ads_status: "paused",
        spend_30d: 2000,
        leads_30d: 10,
        metrics_failed: false,
        pacing_pct: 2,
        pacing_budget: 2000,
        pacing_mtd: 2000,
        pacing_included: true,
      },
    ],
  };

  await mount(React.createElement(CombinedPaceCell as any, { r: combinedRow, c: "USD" }));

  const pill = doc.querySelector(
    '[data-testid="pill-pace-paused-budget-hit-client"]',
  ) as HTMLElement | null;
  ok(!!pill, "CombinedPaceCell paused budget hit: pacing pill renders");
  ok(
    pill!.classList.contains("hit-paused"),
    "CombinedPaceCell paused budget hit: pill carries the hit-paused class",
  );

  await clickPill('[data-testid="pill-pace-paused-budget-hit-client"]');

  ok(
    !!doc.querySelector(".pace-menu"),
    "CombinedPaceCell paused budget hit: .pace-menu panel renders",
  );
  const noteEl = doc.querySelector(".pace-menu .note") as HTMLElement | null;
  ok(!!noteEl, "CombinedPaceCell paused budget hit: .note element renders");
  ok(
    noteEl!.textContent!.includes(
      "Monthly Budget Hit — budget reached and all monitored campaigns are paused",
    ),
    "CombinedPaceCell paused budget hit: .note contains the paused-variant MBH text",
  );

  await unmount();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Section 3 — LSA PaceCell: popup layout
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n── 7. LSA PaceCell: popup rows (.k/.v), dividers, no note ───────");
{
  const lsaRow: any = {
    customer_id: "3333333333",
    descriptive_name: "LSA Layout Test",
    client_name: null,
    lsa_city: null,
    currency_code: "USD",
    doer: null,
    checker: null,
    cost_30d: 800,
    charged_leads_30d: 4,
    cpl_30d: 200,
    cost_prev: 0,
    charged_leads_prev: 0,
    cpl_prev: null,
    answer_rate_30d: 92,
    answer_calls_30d: 25,
    answer_connected_30d: 23,
    ads_running: true,
    pacing_pct: -5,
    monthly_budget: 2000,
    mtd_spend: 800,         // well under budget — no MBH
    recommended_weekly_budget: 460,
    lsa_schedule_days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
    health_score: null,
    health_band: null,
    health_at: null,
    alerts: [],
    alerts_at: null,
  };

  await mount(React.createElement(PaceCell as any, { r: lsaRow, c: "USD" }));

  await clickPill('[data-testid="pill-pace-3333333333"]');

  ok(!!doc.querySelector(".pace-menu"), "LSA PaceCell: .pace-menu panel renders");

  const rows = menuRows();
  ok(rows.length >= 3, "LSA PaceCell: at least 3 rows (budget, MTD, schedule)");
  ok(
    rows.some((r) => r.label === "Monthly budget"),
    "LSA PaceCell: 'Monthly budget' row present with .k/.v",
  );
  ok(
    rows.some((r) => r.label === "MTD spend"),
    "LSA PaceCell: 'MTD spend' row present with .k/.v",
  );
  ok(
    rows.some((r) => r.label === "Schedule"),
    "LSA PaceCell: 'Schedule' row present with .k/.v",
  );
  ok(
    rows.every((r) => r.label !== "" && r.value !== ""),
    "LSA PaceCell: every .row has non-empty .k and .v",
  );

  // Multiple rows → divider borders (CSS `.row + .row { border-top }`)
  const rowEls = doc.querySelectorAll(".pace-menu .row");
  ok(rowEls.length >= 2, "LSA PaceCell: 2+ .row elements so CSS divider borders are triggered");

  // Not a budget hit — no note
  ok(!doc.querySelector(".pace-menu .note"), "LSA PaceCell: no .note when budget is not hit");

  await unmount();
}

console.log("\n── 8. LSA PaceCell: note renders when monthly budget is hit ──────");
{
  const lsaHitRow: any = {
    customer_id: "4444444444",
    descriptive_name: "LSA Budget Hit",
    client_name: null,
    lsa_city: null,
    currency_code: "USD",
    doer: null,
    checker: null,
    cost_30d: 2000,
    charged_leads_30d: 10,
    cpl_30d: 200,
    cost_prev: 0,
    charged_leads_prev: 0,
    cpl_prev: null,
    answer_rate_30d: 90,
    answer_calls_30d: 20,
    answer_connected_30d: 18,
    ads_running: true,
    pacing_pct: 0,
    monthly_budget: 2000,
    mtd_spend: 2000,       // mtd_spend >= monthly_budget → MBH
    recommended_weekly_budget: 460,
    lsa_schedule_days: null,
    health_score: null,
    health_band: null,
    health_at: null,
    alerts: [],
    alerts_at: null,
  };

  await mount(React.createElement(PaceCell as any, { r: lsaHitRow, c: "USD" }));

  await clickPill('[data-testid="pill-pace-4444444444"]');

  const noteEl = doc.querySelector(".pace-menu .note") as HTMLElement | null;
  ok(!!noteEl, "LSA PaceCell: .note element renders when monthly budget is hit");
  ok(noteEl!.textContent!.includes("Monthly Budget Hit"), "LSA PaceCell: .note contains MBH text");

  await unmount();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Section 4 — GAds PaceCell: popup layout
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n── 9. GAds PaceCell: popup rows (.k/.v), dividers, no note ──────");
{
  const gadsRow: any = {
    customer_id: "5555555555",
    descriptive_name: "GAds Layout Test",
    client_name: null,
    currency_code: "USD",
    ads_status: "on",
    ads_running: true,
    doer: null,
    checker: null,
    spend_30d: 800,
    spend_prev: 0,
    conversions_30d: 4,
    conversions_prev: 0,
    cpa_30d: 200,
    cpa_prev: null,
    health_score: null,
    health_band: null,
    health_at: null,
    budget_pacing_pct: -5,
    monthly_budget: 2000,
    mtd_spend: 800,           // well under budget — no MBH
    recommended_daily_budget: 70,
    schedule_days: null,      // scheduleLabel returns "Every day" for null
    scheduled_days_elapsed: 5,
    traffic_quality: null,
    alerts: [],
    alerts_at: null,
  };

  await mount(React.createElement(GadsPaceCell as any, { r: gadsRow, c: "USD" }));

  await clickPill('[data-testid="pill-pace-5555555555"]');

  ok(!!doc.querySelector(".pace-menu"), "GAds PaceCell: .pace-menu panel renders");

  const rows = menuRows();
  ok(rows.length >= 3, "GAds PaceCell: at least 3 rows (budget, MTD, schedule)");
  ok(
    rows.some((r) => r.label === "Monthly budget"),
    "GAds PaceCell: 'Monthly budget' row present with .k/.v",
  );
  ok(
    rows.some((r) => r.label === "MTD spend"),
    "GAds PaceCell: 'MTD spend' row present with .k/.v",
  );
  ok(
    rows.some((r) => r.label === "Schedule"),
    "GAds PaceCell: 'Schedule' row present with .k/.v",
  );
  ok(
    rows.every((r) => r.label !== "" && r.value !== ""),
    "GAds PaceCell: every .row has non-empty .k and .v",
  );

  // Multiple rows → CSS `.row + .row { border-top }` dividers are triggered
  const rowEls = doc.querySelectorAll(".pace-menu .row");
  ok(rowEls.length >= 2, "GAds PaceCell: 2+ .row elements so CSS divider borders are triggered");

  // Not a budget hit — no note
  ok(!doc.querySelector(".pace-menu .note"), "GAds PaceCell: no .note when budget is not hit");

  await unmount();
}

console.log("\n── 10. GAds PaceCell: note renders when monthly budget is hit ────");
{
  const gadsHitRow: any = {
    customer_id: "6666666666",
    descriptive_name: "GAds Budget Hit",
    client_name: null,
    currency_code: "USD",
    ads_status: "on",
    ads_running: true,
    doer: null,
    checker: null,
    spend_30d: 2000,
    spend_prev: 0,
    conversions_30d: 10,
    conversions_prev: 0,
    cpa_30d: 200,
    cpa_prev: null,
    health_score: null,
    health_band: null,
    health_at: null,
    budget_pacing_pct: 0,
    monthly_budget: 2000,
    mtd_spend: 2000,          // mtd_spend >= monthly_budget → MBH
    recommended_daily_budget: null,
    schedule_days: null,
    scheduled_days_elapsed: 20,
    traffic_quality: null,
    alerts: [],
    alerts_at: null,
  };

  await mount(React.createElement(GadsPaceCell as any, { r: gadsHitRow, c: "USD" }));

  await clickPill('[data-testid="pill-pace-6666666666"]');

  const noteEl = doc.querySelector(".pace-menu .note") as HTMLElement | null;
  ok(!!noteEl, "GAds PaceCell: .note element renders when monthly budget is hit");
  ok(
    noteEl!.textContent!.includes("Monthly Budget Hit"),
    "GAds PaceCell: .note contains MBH text",
  );

  await unmount();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Section 5 — PacePill dismissal guards: Escape key, outside-mousedown, inside-mousedown
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n── 11. PacePill: Escape key closes the open menu ───────────────");
{
  await mount(
    React.createElement(PacePill, {
      cls: "g",
      text: "+20%",
      rows: [{ label: "Monthly budget", value: "$3,000.00" }],
      testId: "pill-escape-test",
    }),
  );

  await clickPill('[data-testid="pill-escape-test"]');
  ok(!!doc.querySelector(".pace-menu"), "Escape test: menu is open before Escape");

  await act(async () => {
    doc.dispatchEvent(
      new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });

  ok(!doc.querySelector(".pace-menu"), "Escape key closes the open .pace-menu");

  await unmount();
}

console.log("\n── 12. PacePill: mousedown outside the pill closes the menu ─────");
{
  await mount(
    React.createElement(PacePill, {
      cls: "w",
      text: "-5%",
      rows: [{ label: "MTD spend", value: "$800.00" }],
      testId: "pill-outside-click-test",
    }),
  );

  await clickPill('[data-testid="pill-outside-click-test"]');
  ok(!!doc.querySelector(".pace-menu"), "outside-mousedown test: menu is open before outside click");

  // Dispatch mousedown on document.body — outside the .pace-wrap span
  await act(async () => {
    doc.body.dispatchEvent(
      new dom.MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
  });

  ok(!doc.querySelector(".pace-menu"), "mousedown outside the pill wrapper closes the menu");

  await unmount();
}

console.log("\n── 13. PacePill: mousedown inside the menu does NOT close it ────");
{
  await mount(
    React.createElement(PacePill, {
      cls: "b",
      text: "+8%",
      rows: [
        { label: "Monthly budget", value: "$5,000.00" },
        { label: "MTD spend", value: "$4,000.00" },
      ],
      testId: "pill-inside-click-test",
    }),
  );

  await clickPill('[data-testid="pill-inside-click-test"]');
  ok(!!doc.querySelector(".pace-menu"), "inside-click test: menu is open before inside click");

  // Dispatch a mousedown inside .pace-menu — the document-level onDown handler
  // checks `wrapRef.current.contains(e.target)`. The menu div is a child of
  // the `.pace-wrap` span (wrapRef), so contains() returns true and the menu
  // must NOT close. This is the real guard the component relies on.
  const innerMenu = doc.querySelector(".pace-menu") as HTMLElement;
  assert.ok(innerMenu, "inside-click test: .pace-menu element found");
  await act(async () => {
    innerMenu.dispatchEvent(
      new dom.MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
  });

  ok(!!doc.querySelector(".pace-menu"), "mousedown inside the .pace-menu does NOT close it (wrapRef.contains guard)");

  await unmount();
}

console.log("\n── 14. PacePill: window scroll closes the open menu ──────────────");
{
  await mount(
    React.createElement(PacePill, {
      cls: "g",
      text: "+12%",
      rows: [{ label: "Monthly budget", value: "$3,000.00" }],
      testId: "pill-scroll-dismiss-test",
    }),
  );

  await clickPill('[data-testid="pill-scroll-dismiss-test"]');
  ok(!!doc.querySelector(".pace-menu"), "scroll test: menu is open before window scroll");

  await act(async () => {
    dom.dispatchEvent(new dom.Event("scroll"));
  });

  ok(!doc.querySelector(".pace-menu"), "window scroll closes the open .pace-menu");

  await unmount();
}

console.log("\n── 15. PacePill: window resize closes the open menu ──────────────");
{
  await mount(
    React.createElement(PacePill, {
      cls: "g",
      text: "+12%",
      rows: [{ label: "Monthly budget", value: "$3,000.00" }],
      testId: "pill-resize-dismiss-test",
    }),
  );

  await clickPill('[data-testid="pill-resize-dismiss-test"]');
  ok(!!doc.querySelector(".pace-menu"), "resize test: menu is open before window resize");

  await act(async () => {
    dom.dispatchEvent(new dom.Event("resize"));
  });

  ok(!doc.querySelector(".pace-menu"), "window resize closes the open .pace-menu");

  await unmount();
}

console.log("\n── 16. PacePill: movement listeners clean up on close and unmount ──");
{
  type MovementListener = {
    type: "scroll" | "resize";
    listener: EventListenerOrEventListenerObject;
    capture: boolean;
  };
  type MovementRemoval = MovementListener & { matchedActiveListener: boolean };

  const originalAddEventListener = dom.addEventListener;
  const originalRemoveEventListener = dom.removeEventListener;
  const additions: MovementListener[] = [];
  const removals: MovementRemoval[] = [];
  const activeMovementListeners: MovementListener[] = [];
  let isMounted = false;

  function usesCapture(
    options?: boolean | AddEventListenerOptions | EventListenerOptions,
  ): boolean {
    return options === true || (typeof options === "object" && options?.capture === true);
  }

  dom.addEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if ((type === "scroll" || type === "resize") && listener) {
      const record: MovementListener = { type, listener, capture: usesCapture(options) };
      additions.push(record);
      activeMovementListeners.push(record);
    }
    return originalAddEventListener.call(dom, type, listener, options);
  };
  dom.removeEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) => {
    if ((type === "scroll" || type === "resize") && listener) {
      const capture = usesCapture(options);
      const index = activeMovementListeners.findIndex(
        (record) => record.type === type && record.listener === listener,
      );
      const matchedActiveListener =
        index >= 0 && activeMovementListeners[index].capture === capture;
      removals.push({ type, listener, capture, matchedActiveListener });
      if (matchedActiveListener) activeMovementListeners.splice(index, 1);
    }
    return originalRemoveEventListener.call(dom, type, listener, options);
  };

  try {
    await mount(
      React.createElement(PacePill, {
        cls: "g",
        text: "+12%",
        rows: [{ label: "Monthly budget", value: "$3,000.00" }],
        testId: "pill-movement-cleanup-test",
      }),
    );
    isMounted = true;

    for (let cycle = 1; cycle <= 3; cycle++) {
      await clickPill('[data-testid="pill-movement-cleanup-test"]');
      eq(activeMovementListeners.length, 2,
        `movement cleanup cycle ${cycle}: exactly scroll + resize listeners are active when open`);
      const scrollListener = activeMovementListeners.find((record) => record.type === "scroll");
      const resizeListener = activeMovementListeners.find((record) => record.type === "resize");
      ok(!!scrollListener && scrollListener.capture,
        `movement cleanup cycle ${cycle}: scroll listener registers with capture=true`);
      ok(!!resizeListener && !resizeListener.capture,
        `movement cleanup cycle ${cycle}: resize listener registers without capture`);

      await clickPill('[data-testid="pill-movement-cleanup-test"]');
      eq(activeMovementListeners.length, 0,
        `movement cleanup cycle ${cycle}: closing removes every movement listener`);
    }

    await clickPill('[data-testid="pill-movement-cleanup-test"]');
    eq(activeMovementListeners.length, 2,
      "movement cleanup unmount: listeners are active before component unmount");
    await unmount();
    isMounted = false;
    eq(activeMovementListeners.length, 0,
      "movement cleanup unmount: unmount removes every movement listener");

    eq(additions.length, 8, "movement cleanup: four opens register four scroll/resize pairs");
    eq(removals.length, 8, "movement cleanup: four cleanup paths remove four scroll/resize pairs");
    const scrollRemovals = removals.filter((record) => record.type === "scroll");
    eq(scrollRemovals.length, 4, "movement cleanup: each scroll listener is removed");
    ok(scrollRemovals.every((record) => record.capture && record.matchedActiveListener),
      "movement cleanup: every scroll listener is removed with its original capture=true option");
    const resizeRemovals = removals.filter((record) => record.type === "resize");
    ok(resizeRemovals.every((record) => !record.capture && record.matchedActiveListener),
      "movement cleanup: every resize listener is removed with its original capture=false option");
  } finally {
    if (isMounted) await unmount();
    dom.addEventListener = originalAddEventListener;
    dom.removeEventListener = originalRemoveEventListener;
  }
}

console.log(`\n✓ All ${passed} assertions passed — PacePill popup layout + dismissal and listener-cleanup guards (Task #4956 + #4959 + #4969 + #5223).`);
