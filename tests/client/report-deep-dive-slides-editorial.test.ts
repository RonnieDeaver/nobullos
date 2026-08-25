/* test-registration
{
  "name": "Intake & Sales deep dives — editorial redesign contract: paper surfaces, VerdictLine opener, max-3 Common Issues at 68ch, no BETA hedge (Task #4279) + empty-state collapse & badge suppression (Task #4285)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4279 (audit §8.7-6): pins the client-deliverable contract of both deep-dive slides for every anonymous share/demo viewer: paper surfaces (intake beige, sales cream — a charcoal regression re-ships the internal-dashboard look), VerdictLine adoption, Common Issues capped at 3 bullets on a 68ch measure with the bullet marker carrying the SHARED severity band color (UI color and AI tone single-source agreement, Task #2460), per-metric no-data gating intact (Task #3688), the Task #4285 empty convention (fully-empty sections collapse to ONE explanatory band with sentence-case 'No data'; header badges suppressed over un-entered core rates), and zero 'BETA — experimental' hedge text anywhere on the public surface. DB-free, network-free, ~5s.",
  "extraEnv": {
    "NODE_ENV": "test",
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4279 — Intake & Sales deep-dive editorial redesign contract.
 *
 * Three layers:
 *   1. parseCommonIssuesForPresentation unit contract (pure parser):
 *      canonical 🔴/↳/➡️ blocks → clean {issue, impact, fix} bullets with
 *      labels/bold stripped; healthy-band intro line preserved; inline
 *      one-line smears still split; non-marker text falls back to prose;
 *      PUBLIC_COMMON_ISSUES_MAX = 3.
 *   2. Populated mount of BOTH slides through the REAL derivePublicReportView:
 *      verdict sentences render via the shared primitive, ≤3 of 5 stored
 *      issues render at 68ch, severity color on the hero agrees with
 *      @shared/commonIssuesSeverity's band, paper surfaces (beige/cream),
 *      and no "BETA" text anywhere.
 *   3. Sparse mount (Task #4285): fully-empty sections collapse to ONE
 *      explanatory empty band each — no verdict nodes, no metric walls,
 *      sentence-case "No data" only. A single entered metric restores the
 *      full slide with per-metric gating (Task #3688) and NO header badge
 *      over an un-entered core rate (badge suppression).
 *
 * DB-free / network-free (slides are pure props via the deriver). jsdom
 * globals installed BEFORE any react/react-dom import (memory:
 * jsdom-globals-before-react-dom-eval). Test body is JSX-free and binds
 * globalThis.React so the .tsx slides work under BOTH the solo react-jsx
 * transform and a batch child's classic transform (memory:
 * batched-classic-jsx-primitives).
 */
import { strict as assert } from "node:assert";

import { JSDOM } from "jsdom";

// ── jsdom bootstrap (must precede the dynamic react/component imports) ──
const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/share/test-token" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).SVGElement = dom.window.SVGElement;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number;
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
// framer-motion (Slide reveal + useReducedMotion) probes matchMedia; jsdom
// has none. Legacy addListener/removeListener included — some consumers
// still call them.
const fakeMatchMedia = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});
(dom.window as any).matchMedia = fakeMatchMedia;
(globalThis as any).matchMedia = fakeMatchMedia;
// framer-motion useInView + recharts ResponsiveContainer observers.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
(dom.window as any).IntersectionObserver = NoopObserver;
(globalThis as any).IntersectionObserver = NoopObserver;
(dom.window as any).ResizeObserver = NoopObserver;
(globalThis as any).ResizeObserver = NoopObserver;
if (!(globalThis as any).IS_REACT_ACT_ENVIRONMENT) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
}

// ── fixtures ──────────────────────────────────────────────────────────────

/** Canonical stored markdown (commonIssuesFormatter shape) — 5 blocks. */
const FIVE_ISSUE_MD = [1, 2, 3, 4, 5]
  .map(
    (n) =>
      `🔴 **Issue:** Intake problem number ${n} keeps recurring.\n` +
      `↳ **Impact:** Effect ${n} on the pipeline.\n` +
      `> ➡️ **Strategic Fix:** Remedy ${n} for the team.`,
  )
  .join("\n\n---\n\n");

/** Healthy-band shape: positive opener (no 🔴) + two gentle issues. */
const HEALTHY_SALES_MD =
  `Strong month — conversion is comfortably above goal.\n\n` +
  `🔴 **Issue:** Follow-up cadence drops after the second touch.\n` +
  `↳ **Impact:** A handful of warm consults stall in week two.\n` +
  `> ➡️ **Strategic Fix:** Consider adding a 10-day check-in touch.\n\n---\n\n` +
  `🔴 **Issue:** No-show reminders go out only by email.\n` +
  `↳ **Impact:** Text-first clients miss confirmations.\n` +
  `> ➡️ **Strategic Fix:** You might add SMS reminders the day before.`;

const SLIDE_NUMBERS = {
  title: 1, roadmap: 2, ceoPulse: 3, marketContext: 4, engineHealth: 5,
  marketing: 6, intake: 7, sales: 8, lossAudit: 9, lifetimeValue: 10,
  next30: 11, bookPromo: 12,
};

const INTAKE_VERDICT = "Intake is leaking consults — answer speed is the fix.";
const SALES_VERDICT = "Sales is converting at a healthy clip.";

/** Populated: intake lands CRITICAL (12% vs paid target 45), sales HEALTHY (80% vs 35). */
function populatedData() {
  return {
    report: { id: "r-4279", reportMonth: "2026-06", status: "final" },
    client: {
      firmName: "Fixture Firm", contactName: null, products: ["gbp"],
      consultType: "paid", terminology: null,
    },
    sections: [
      {
        sectionKey: "intake",
        data: {
          totalConsults: 20, leadToConsultRate: 12, avgTimeToAnswer: 25,
          qualityScore: 60, commonIssues: FIVE_ISSUE_MD, noDataFlags: {},
        },
      },
      {
        sectionKey: "sales",
        data: {
          totalCases: 16, consultToCaseRate: 80, averageCaseValue: 9000,
          noShowRate: 10, qualityScore: 90, pipelineMomentumScore: 75,
          commonIssues: HEALTHY_SALES_MD, noDataFlags: {},
        },
      },
      {
        sectionKey: "marketing",
        data: {
          gbp: {
            locations: [
              {
                uniqueLeads: 26,
                leadQuality: { good: 10, notQuotable: 5, missedCalls: 11, noData: 0 },
              },
            ],
          },
        },
      },
    ],
    ceoPulse: null,
    dataAccess: [],
    trendData: [],
    slideVerdicts: { intake: INTAKE_VERDICT, sales: SALES_VERDICT },
  };
}

/** Sparse: legacy sections (no noDataFlags key), nothing entered, no verdicts. */
function sparseData() {
  return {
    report: { id: "r-4279-sparse", reportMonth: "2026-06", status: "final" },
    client: {
      firmName: "Sparse Firm", contactName: null, products: [],
      consultType: "paid", terminology: null,
    },
    sections: [
      { sectionKey: "intake", data: {} },
      { sectionKey: "sales", data: {} },
      { sectionKey: "marketing", data: {} },
    ],
    ceoPulse: null,
    dataAccess: [],
    trendData: [],
  };
}

function rootState(data: any) {
  return {
    isDemo: true, isPrintMode: false, isPreview: false, isEditing: false,
    prefersReducedMotion: true, printModeActive: false, hasCeoPulse: false,
    slideNumbers: SLIDE_NUMBERS, data,
  };
}

// ── run ───────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log("deep-dive slides — editorial redesign contract (Task #4279)");

  // ---- 1. parser unit contract (pure, no DOM) ----
  const {
    parseCommonIssuesForPresentation,
    PUBLIC_COMMON_ISSUES_MAX,
  } = await import("@/pages/publicReport/commonIssuesPresentation");

  assert.equal(PUBLIC_COMMON_ISSUES_MAX, 3, "public cap is 3 (§8.7-6)");

  const five = parseCommonIssuesForPresentation(FIVE_ISSUE_MD);
  assert.equal(five.kind, "structured");
  if (five.kind === "structured") {
    assert.equal(five.totalCount, 5, "all 5 stored blocks parsed");
    assert.equal(five.intro, null, "no intro when text starts at the first 🔴");
    assert.equal(five.issues[0].issue, "Intake problem number 1 keeps recurring.");
    assert.equal(five.issues[0].impact, "Effect 1 on the pipeline.");
    assert.equal(five.issues[0].fix, "Remedy 1 for the team.");
    for (const parsed of five.issues) {
      for (const field of [parsed.issue, parsed.impact ?? "", parsed.fix ?? ""]) {
        assert.ok(!field.includes("**"), "bold markers stripped");
        assert.ok(!/Issue:|Impact:|Strategic Fix:/.test(field), "labels stripped");
        assert.ok(!field.includes("🔴") && !field.includes("↳") && !field.includes("➡️"), "structure markers stripped");
      }
    }
  }
  console.log("  ✓ canonical blocks parse to clean issue/impact/fix bullets");

  const healthy = parseCommonIssuesForPresentation(HEALTHY_SALES_MD);
  assert.equal(healthy.kind, "structured");
  if (healthy.kind === "structured") {
    assert.equal(healthy.intro, "Strong month — conversion is comfortably above goal.");
    assert.equal(healthy.totalCount, 2);
  }
  console.log("  ✓ healthy-band opener becomes the intro line");

  // Pre-#3770 storage smear: all markers inline on ONE line still split.
  const smear = parseCommonIssuesForPresentation(
    "🔴 **Issue:** Smeared issue text ↳ **Impact:** Smeared impact > ➡️ **Strategic Fix:** Smeared fix --- 🔴 **Issue:** Second smeared",
  );
  assert.equal(smear.kind, "structured");
  if (smear.kind === "structured") {
    assert.equal(smear.totalCount, 2, "inline smear splits into 2 issues");
    assert.equal(smear.issues[0].issue, "Smeared issue text");
    assert.equal(smear.issues[0].impact, "Smeared impact");
    assert.ok(smear.issues[0].fix!.startsWith("Smeared fix"), "fix extracted from smear");
  }
  console.log("  ✓ inline one-line smears still split into bullets");

  const prose = parseCommonIssuesForPresentation("Legacy free-form paragraph with **bold** text.");
  assert.equal(prose.kind, "prose", "marker-less text falls back to prose");
  assert.equal(parseCommonIssuesForPresentation("").kind, "empty");
  assert.equal(parseCommonIssuesForPresentation(undefined).kind, "empty");
  console.log("  ✓ prose fallback + empty states");

  // ---- 2/3. slide mounts through the real deriver ----
  const React = (await import("react")).default as any;
  // Batch children compile .tsx CLASSIC (per-file TSX_TSCONFIG_PATH only
  // applies solo) — bind the global so React.createElement resolves either way.
  (globalThis as any).React = React;
  const { act } = (await import("react")) as any;
  const { createRoot } = (await import("react-dom/client")) as any;
  const { derivePublicReportView } = await import("@/pages/publicReport/derive");
  const { IntakeSlide } = await import("@/pages/publicReport/IntakeSlide");
  const { SalesSlide } = await import("@/pages/publicReport/SalesSlide");
  const { getIntakeSeverityBand, getSalesSeverityBand } = await import("@shared/commonIssuesSeverity");

  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const mountBoth = async (data: any) => {
    const view = derivePublicReportView(rootState(data) as any);
    await act(async () => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(IntakeSlide, { view }),
          React.createElement(SalesSlide, { view }),
        ),
      );
    });
    return view;
  };
  const q = (sel: string) => container.querySelector(sel);
  const qa = (sel: string) => Array.from(container.querySelectorAll(sel));

  try {
    // ---- populated ----
    await mountBoth(populatedData());

    // Paper surfaces — the §8.7-6 core: no charcoal deep dives.
    assert.ok(q("#intake")!.className.includes("slide-beige"), "intake sits on the beige paper surface");
    assert.ok(q("#sales")!.className.includes("slide-cream"), "sales sits on the cream paper surface");
    assert.equal(qa(".slide-charcoal").length, 0, "no charcoal surface on either deep dive");
    console.log("  ✓ both deep dives render on paper surfaces");

    // VerdictLine adoption.
    const iv = q('[data-testid="text-verdict-intake"]');
    const sv = q('[data-testid="text-verdict-sales"]');
    assert.ok(iv && sv, "both verdict lines render");
    assert.equal(iv!.textContent, INTAKE_VERDICT);
    assert.equal(sv!.textContent, SALES_VERDICT);
    assert.ok(iv!.classList.contains("report-verdict"), "intake verdict uses the shared primitive class");
    assert.ok(iv!.className.includes("max-w-[68ch]"), "verdict measure capped at 68ch");
    console.log("  ✓ VerdictLine opens both slides");

    // Common Issues — ≤3 bullets at 68ch, clean text.
    const intakeList = q('[data-testid="intake-issues-list"]');
    assert.ok(intakeList, "intake issues render as the structured list");
    assert.ok(intakeList!.className.includes("max-w-[68ch]"), "issues measure capped at 68ch");
    const intakeBullets = qa('[data-testid^="intake-issue-bullet-"]');
    assert.equal(intakeBullets.length, 3, "5 stored issues cap to 3 bullets");
    assert.ok(
      intakeBullets[0].textContent!.includes("Intake problem number 1"),
      "bullet order preserved (first stored issue first)",
    );
    assert.ok(!intakeList!.textContent!.includes("**"), "no raw markdown bold in bullets");
    assert.ok(!intakeList!.textContent!.includes("🔴"), "no raw structure markers in bullets");
    const salesBullets = qa('[data-testid^="sales-issue-bullet-"]');
    assert.equal(salesBullets.length, 2, "sales renders its 2 stored issues");
    const salesIntro = q('[data-testid="sales-issues-intro"]');
    assert.ok(salesIntro, "healthy-band opener renders as the intro line");
    assert.ok(salesIntro!.textContent!.includes("Strong month"), "intro copy preserved");
    console.log("  ✓ Common Issues cap at 3 bullets, 68ch, clean text");

    // Severity agreement — hero color derives from the SHARED band.
    const intakeBand = getIntakeSeverityBand(12, "paid");
    assert.equal(intakeBand, "critical", "fixture sanity: 12% paid is critical");
    const intakeHero = q('[data-testid="core-metric-lead-to-consult"]')!;
    assert.ok(intakeHero.className.includes("report-card-tint-critical"), "intake hero tint matches shared band");
    assert.ok(intakeHero.querySelector(".report-hero-metric")!.className.includes("text-report-critical"), "intake hero number color matches shared band");
    assert.ok(intakeHero.textContent!.includes("12%"), "intake hero shows the rate");
    const salesBand = getSalesSeverityBand(80, "paid");
    assert.equal(salesBand, "healthy", "fixture sanity: 80% paid is healthy");
    const salesHero = q('[data-testid="core-metric-consult-to-case"]')!;
    assert.ok(salesHero.className.includes("report-card-tint-healthy"), "sales hero tint matches shared band");
    assert.ok(salesHero.textContent!.includes("80%"), "sales hero shows the rate");
    // Bullet markers carry the same shared band color (tone/color agreement).
    assert.ok(
      (intakeBullets[0].querySelector("span") as any).className.includes("bg-report-critical"),
      "intake bullet marker carries the shared severity color",
    );
    console.log("  ✓ hero + bullet severity color agrees with @shared/commonIssuesSeverity");

    // Header status tags — present on populated slides (they disappear only
    // in no-data states, Task #4285 badge suppression; see partial mount).
    const headerOf = (title: string) =>
      qa("h2").find((h) => h.textContent === title)!.parentElement!;
    assert.ok(headerOf("Intake Deep Dive").textContent!.includes("Critical"), "populated intake header carries its status tag");
    assert.ok(headerOf("Sales Deep Dive").textContent!.includes("Healthy"), "populated sales header carries its status tag");
    console.log("  ✓ populated headers keep their status tags");

    // Supporting tiles — populated values with status colors (Task #3688
    // entered-metric path).
    const missedTile = q('[data-testid="stat-missed-call-rate"]')!;
    assert.ok(!missedTile.textContent!.includes("No data"), "missed-call tile populated (derived from lead data)");
    assert.ok(missedTile.querySelector(".metric-large")!.className.includes("text-report-critical"), "42% missed-call rate is critical (>20)");
    const timeTile = q('[data-testid="stat-avg-time-to-answer"]')!;
    assert.ok(timeTile.textContent!.includes("25s"), "answer-time tile shows entered 25s");
    const iesTile = q('[data-testid="stat-quality-score"]')!;
    assert.ok(iesTile.textContent!.includes("16"), "IES tile shows computeExecutionScore(60, 12, 45) = 16");
    const pmiTile = q('[data-testid="stat-pipeline-momentum-index"]')!;
    assert.ok(pmiTile.textContent!.includes("75"), "PMI tile shows the entered score");
    assert.ok(pmiTile.textContent!.includes("Target: ≥70"), "PMI target caption intact");
    console.log("  ✓ supporting tiles populated with entered values");

    // BETA hedge — gone from the deliverable, metric still present.
    const fullText = container.textContent || "";
    assert.ok(!fullText.includes("BETA"), "no BETA hedge text anywhere on either slide");
    assert.ok(!fullText.toLowerCase().includes("experimental"), "no 'experimental' hedge either");
    assert.ok(fullText.includes("Pipeline Momentum Index"), "Pipeline Momentum Index still presented (stood behind)");
    console.log("  ✓ BETA hedge removed; Pipeline Momentum Index stands");

    // ---- sparse (Task #4693 — fully-empty sections render full skeletons
    // with ONE CaseIntake™ callout each; the #4285 collapse is retired) ----
    const sparseView = await mountBoth(sparseData());

    assert.equal(q('[data-testid="text-verdict-intake"]'), null, "no verdict node without a stored verdict");
    assert.equal(q('[data-testid="text-verdict-sales"]'), null, "no sales verdict node either");
    assert.equal(q('[data-testid="empty-intake"]'), null, "the #4285 intake collapse band is retired");
    assert.equal(q('[data-testid="empty-sales"]'), null, "the #4285 sales collapse band is retired");
    assert.ok(q('[data-testid="core-metric-lead-to-consult"]'), "fully-empty intake keeps its hero card (muted 'No data' slot)");
    assert.ok(q('[data-testid="core-metric-consult-to-case"]'), "fully-empty sales keeps its hero card too");
    assert.ok(qa('[data-testid^="stat-"]').length > 0, "supporting tiles render as quiet no-data slots (full skeleton)");
    assert.ok(q('[data-testid="upsell-intake"]'), "intake renders its single gold callout");
    assert.ok(q('[data-testid="upsell-sales"]'), "sales renders its single gold callout");
    assert.ok(q('[data-testid="chart-placeholder-intake"]'), "intake trend area renders the quiet placeholder frame");
    assert.ok(q('[data-testid="chart-placeholder-sales"]'), "sales trend area renders the quiet placeholder frame");
    const sparseText = container.textContent || "";
    assert.ok((sparseView as any).monthLabel, "fixture sanity: deriver produced a month label");
    assert.ok(
      sparseText.includes("Still waiting on your") &&
        sparseText.includes(`count for ${(sparseView as any).monthLabel} — send it over`),
      "callouts carry the month-scoped manual-ask copy (consults/cases are hand-reportable)",
    );
    assert.equal(
      (sparseText.match(/CaseIntake™/g) || []).length, 2,
      "the pitch appears exactly once per slide — never repeated on cards",
    );
    assert.ok(!sparseText.includes("No Data"), "title-case wording never renders (ONE deck-wide convention)");
    assert.ok(!sparseText.includes("BETA"), "sparse view also BETA-free");
    console.log("  ✓ sparse view: full skeletons + one callout each, canonical wording only");

    // ---- partial (Task #3688 gating unchanged + Task #4285 badge suppression) ----
    // ONE entered metric keeps the FULL slide; the un-entered core rate
    // shows the neutral "No data" card but NO header status tag.
    const partial = sparseData();
    (partial.sections[0] as any).data = { avgTimeToAnswer: 25, noDataFlags: {} };
    (partial.sections[1] as any).data = { noShowRate: 10, noDataFlags: {} };
    await mountBoth(partial);

    assert.equal(q('[data-testid="empty-intake"]'), null, "one entered metric restores the full intake slide");
    assert.equal(q('[data-testid="empty-sales"]'), null, "one entered metric restores the full sales slide");
    const partialIntakeHero = q('[data-testid="core-metric-lead-to-consult"]')!;
    assert.ok(partialIntakeHero.textContent!.includes("No data"), "un-entered hero shows the canonical 'No data'");
    assert.ok(partialIntakeHero.className.includes("report-card-tint-neutral"), "no-data hero goes neutral, not critical");
    assert.ok(q('[data-testid="stat-avg-time-to-answer"]')!.textContent!.includes("25s"), "entered tile still shows its value");
    assert.equal(headerOf("Intake Deep Dive").textContent, "Intake Deep Dive", "no header badge over an un-entered intake core rate");
    assert.equal(headerOf("Sales Deep Dive").textContent, "Sales Deep Dive", "no header badge over an un-entered sales core rate");
    const partialText = container.textContent || "";
    assert.equal((partialText.match(/No issues identified/g) || []).length, 2, "both slides show the empty issues state");
    assert.ok(!partialText.includes("No Data"), "partial view sticks to the canonical wording too");
    console.log("  ✓ partial view: full slides, per-metric gating intact, header badges suppressed");
  } finally {
    await act(async () => {
      root.unmount();
    });
  }

  console.log("report-deep-dive-slides-editorial: PASSED");
}

let failed = false;
run()
  .catch((err) => {
    failed = true;
    console.error("report-deep-dive-slides-editorial: FAILED", err);
  })
  .finally(() => {
    // DOM suites exit explicitly — lingering jsdom/react handles otherwise
    // hang the runner's natural drain.
    process.exit(failed ? 1 : 0);
  });
