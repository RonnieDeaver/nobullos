/* test-registration
{
  "name": "Lifetime cases card RENDERS not-reported vs confirmed-positive (+incomplete-months annotation) vs estimate states — never a numeral 0 — plus CaseIntake™ callout variants (Tasks #3687/#4714/#4845/#4849)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4849 (owner directive: a numeral 0 for Total Cases Signed is NEVER acceptable; extends #3687/#4714): the lifetime cases card rendered from stubbed share payloads. States: \"Not reported to us yet\" (no hard data, incl. estimate-rounds-to-0; Task #4845 client-attribution wording) vs confirmed POSITIVE total (zero-total payloads — even defensive hasHardData=true shapes — fall to the not-reported treatment instead of rendering \"0\") vs \"~N\" estimate; plus the Task #4849 partial-coverage annotation (\"Incomplete data — missing Feb '26, …\" from casesCoverage.missingMonths, trend-style labels, first-3 + \"+ N more\" truncation, absent on complete series and on legacy payloads without coverage) and terminology preservation. Callout variants (Task #4714): estimate-only → \"industry estimates\" pitch, cases-never-reported (incl. zero-total) → \"you haven't reported any cases\" pitch (terminology-aware), fully-empty → generic upgrade pitch, positive hard data → NO callout (the annotation alone carries partial-coverage honesty). jsdom render, fetch fully stubbed, no DB.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Tasks #3687 + #4849 — Lifetime "Total Cases Signed" card NEVER renders a
 * numeral 0 (owner directive): never-provided case data shows the
 * not-reported treatment ("Not reported to us yet" since Task #4845's
 * client-attribution wording) or the labeled estimate, and partial coverage
 * shows the true total plus an "Incomplete data — missing <months>"
 * annotation.
 *
 * The server decides hasHardData + casesCoverage via the shared accumulator
 * (server/lib/lifetimeCases.ts, locked by tests/lifetime-cases-not-provided
 * .test.ts — hasHardData now implies totalCases > 0 by construction). THIS
 * test guards the card's branching in PublicReport.tsx, including the
 * defensive render-side rule that the confirmed branch ALSO requires a
 * positive total:
 *
 *   (A)  hasHardData=false, no estimate   → "Not reported to us yet"
 *        (text-lifetime-cases-missing) + neutral subtitle; NO confirmed
 *        number, NO "Confirmed client signings".
 *   (B)  hasHardData=false, estimate 0    → still "Not reported to us yet"
 *        (an estimate that rounds down to 0 is not a meaningful estimate).
 *   (C)  hasHardData=true, totalCases 0   → Task #4849 flip: a numeral 0 is
 *        never acceptable — the not-reported treatment renders even for this
 *        defensive/impossible-by-construction payload shape.
 *   (C2) same zero-total payload on an all-zero slide → the full Task #4693
 *        skeleton wins (no confirmed-0-beside-skeletons render anymore).
 *   (G)  positive total + missingMonths   → true total + "Incomplete data —
 *        missing Feb '26, Mar '26, Apr '26" (trend-style labels), no callout.
 *   (H)  long missing list               → first 3 named + "+ N more".
 *   (I)  positive total, no missing months → renders exactly as before:
 *        number + "Confirmed client signings", NO annotation, NO callout.
 *   (I2) positive total, legacy payload without casesCoverage → same as (I).
 *   (D)  hasHardData=false, estimate 42   → existing "~42" estimate branch
 *        ("Estimated Cases" / "Based on industry benchmarks") untouched.
 *   (E)  all-zero lifetimeValue           → Task #4693 full skeleton: muted
 *        no-data beats + arc placeholder + ONE CaseIntake™ callout; the old
 *        slide-level placeholder is retired and no number is fabricated.
 *   (F)  custom terminology (cases→Matters) → the not-provided card keeps the
 *        terminology helper: "Total Matters Signed" label + matters subtitle.
 *
 * Task #4714 (owner-approved wording) layers the section-callout contract
 * onto the same scenarios — the slide always shows at most ONE callout:
 *   (A/B) data present, cases never reported (incl. estimate that rounds
 *         to 0) → "You haven't reported any cases to us yet — CaseIntake™
 *         captures your signed cases automatically. Ask us about upgrading."
 *   (C)   zero-total payloads read as never-reported → same no-cases pitch;
 *         (C2) fully-empty zero-total → generic upgrade variant.
 *   (G-I2) POSITIVE hard case data → NO callout at all (the incomplete-data
 *         annotation alone carries partial-coverage honesty).
 *   (D)   estimate-only → "These are industry estimates — CaseIntake™
 *         replaces them with your real signed cases. Ask us about
 *         upgrading."
 *   (E)   fully-empty skeleton keeps the generic upgrade-only variant.
 *   (F)   the partial-state pitches use the client's terminology
 *         ("matters"), like every other lifetime string.
 *
 * Heavy browser-only deps are shimmed by the existing
 * review-velocity-render-loader.mjs loader; fetch fully stubbed; no DB.
 */

import { register } from "node:module";
import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

register("./review-velocity-render-loader.mjs", import.meta.url);

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/share/test-token" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).HTMLImageElement = dom.window.HTMLImageElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).PointerEvent =
  (dom.window as any).PointerEvent ?? (dom.window as any).MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(dom.window.HTMLElement.prototype as any).scrollIntoView =
  (dom.window.HTMLElement.prototype as any).scrollIntoView || function () {};
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(dom.window as any).matchMedia =
  (dom.window as any).matchMedia ||
  ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  }));
(globalThis as any).matchMedia = (dom.window as any).matchMedia;
class ResizeObserverStub {
  observe() {} unobserve() {} disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;
(dom.window as any).ResizeObserver = ResizeObserverStub;
class IntersectionObserverStub {
  observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
}
(globalThis as any).IntersectionObserver = IntersectionObserverStub;
(dom.window as any).IntersectionObserver = IntersectionObserverStub;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).confirm = () => true;
(dom.window as any).confirm = () => true;
(globalThis as any).scrollTo = () => {};
(dom.window as any).scrollTo = () => {};

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

type LifetimeValue = {
  totalLeads: number;
  totalReviews: number;
  totalCases: number;
  estimatedCases?: number;
  hasHardData: boolean;
  // Task #4849 — optional per-month provenance (absent on legacy payloads).
  casesCoverage?: { providedMonths: string[]; missingMonths: string[] };
};

/**
 * Minimal share-token payload (the `/api/share/:token` response). The
 * lifetime slide renders purely from `lifetimeValue`, which each scenario
 * overrides; the rest keeps the page mounting cleanly.
 */
function buildFixture(lifetimeValue: LifetimeValue, terminology: Record<string, string> | null = null) {
  return {
    report: {
      id: "r1",
      clientId: "c1",
      reportMonth: "2026-06",
      status: "final",
      title: "June 2026 Report",
      hideLeadQuality: false,
    },
    client: {
      id: "c1",
      firmName: "Jones Law Firm",
      contactName: "Test Contact",
      consultType: "standard",
      products: ["gbp"],
      terminology,
    },
    sections: [
      {
        sectionKey: "marketing",
        data: {
          posture: "stable",
          gbp: {
            locations: [
              { name: "Jones - Main Office", uniqueLeads: 10, reviewsGenerated: 2 },
            ],
          },
        },
      },
      { sectionKey: "intake", data: { totalLeads: 10, totalConsults: 4, leadToConsultRate: 40 } },
      { sectionKey: "sales", data: {} },
    ],
    trendData: [
      { month: "2026-04", marketing: { totalLeads: 8, leadsBySource: { gbp: 8 } } },
      { month: "2026-05", marketing: { totalLeads: 9, leadsBySource: { gbp: 9 } } },
      { month: "2026-06", marketing: { totalLeads: 10, leadsBySource: { gbp: 10 } } },
    ],
    dataAccess: [{ category: "consult_bookings", status: "available" }],
    lifetimeValue,
  };
}

const React = (await import("react")).default;
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

let activeRoot: any = null;

async function renderScenario(fixture: any): Promise<Document> {
  if (activeRoot) {
    await act(async () => { activeRoot.unmount(); });
    activeRoot = null;
  }
  dom.window.document.getElementById("root")!.innerHTML = "";

  globalThis.fetch = createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { path: "/api/share", json: fixture },
      { path: "/api/phase-settings", json: [] },
      { path: "/api/auth/user", json: null, status: 401 },
    ],
    defaultJson: {},
  }) as any;

  const PublicReport = (await import("@/pages/PublicReport")).default;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });

  const container = dom.window.document.getElementById("root")!;
  await act(async () => {
    activeRoot = ReactDOMClient.createRoot(container);
    activeRoot.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(PublicReport as any),
      ),
    );
  });
  await flush(0);
  await flush(0);
  await flush(0);

  return dom.window.document;
}

function missingEl(doc: Document): Element | null {
  return doc.querySelector('[data-testid="text-lifetime-cases-missing"]');
}
function casesEl(doc: Document): Element | null {
  return doc.querySelector('[data-testid="text-lifetime-cases"]');
}
function calloutEl(doc: Document): Element | null {
  return doc.querySelector('[data-testid="upsell-lifetime-value"]');
}
/** The cases card root (parent of the value element) for scoped text checks. */
function cardText(el: Element): string {
  return el.parentElement?.textContent ?? "";
}

// ---------------------------------------------------------------------------
// (A) No hard data, no estimate → "Not reported to us yet", never a confirmed 0.
//     (reviews-only client: the bug scenario that showed "0 / Confirmed
//     client signings" before Task #3687)
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(
    buildFixture({ totalLeads: 0, totalReviews: 12, totalCases: 0, hasHardData: false }),
  );

  const missing = missingEl(doc);
  assert(missing, "(A) text-lifetime-cases-missing must render when hasHardData=false and no estimate");
  assert(
    missing!.textContent!.trim() === "Not reported to us yet",
    `(A) missing state must read exactly "Not reported to us yet", got "${missing!.textContent!.trim()}"`,
  );
  assert(!casesEl(doc), "(A) confirmed-number element must NOT render without hard data");

  const card = cardText(missing!);
  assert(
    card.includes("Total Cases Signed"),
    `(A) card label must keep the terminology helper ("Total Cases Signed"), got "${card}"`,
  );
  assert(
    card.includes("No cases data reported yet"),
    `(A) card must show the neutral subtitle, got "${card}"`,
  );
  assert(
    !card.includes("Confirmed client signings"),
    "(A) card must NOT claim 'Confirmed client signings' when no data was provided",
  );
  assert(
    !doc.body.textContent!.includes("Confirmed client signings"),
    "(A) 'Confirmed client signings' must not appear anywhere without hard data",
  );

  // Task #4714 — data present but cases never reported → the tailored
  // "haven't reported any cases" pitch (Task #4845 wording), NOT the
  // generic "No data" line (the slide visibly has data).
  const callout = calloutEl(doc);
  assert(callout, "(A) the section callout must render when cases were never reported");
  assert(
    (callout!.textContent ?? "").includes(
      "You haven't reported any cases to us yet — CaseIntake™ captures your signed cases automatically. Ask us about upgrading.",
    ),
    `(A) callout must use the cases-never-reported variant, got "${callout!.textContent}"`,
  );
  assert(
    !(callout!.textContent ?? "").includes("CaseIntake™ tracks this automatically"),
    "(A) the generic upgrade-only line must NOT show next to a slide that has data",
  );
}

// ---------------------------------------------------------------------------
// (B) Estimate rounds down to 0 (server sends estimatedCases: 0) → still the
//     not-provided state, NOT "~0" and NOT a confirmed 0.
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(
    buildFixture({ totalLeads: 1, totalReviews: 0, totalCases: 0, estimatedCases: 0, hasHardData: false }),
  );

  const missing = missingEl(doc);
  assert(missing, "(B) estimate of 0 is not meaningful → missing state must render");
  assert(!casesEl(doc), "(B) neither confirmed nor estimate number may render");
  assert(
    !doc.body.textContent!.includes("Based on industry benchmarks"),
    "(B) the estimate subtitle must not render for a 0 estimate",
  );
  // Task #4714 — an estimate that rounds away is "never reported", not
  // "estimate-only": the callout stays on the no-cases variant.
  const callout = calloutEl(doc);
  assert(callout, "(B) the section callout must render for a rounds-to-0 estimate");
  assert(
    (callout!.textContent ?? "").includes("You haven't reported any cases to us yet"),
    `(B) rounds-to-0 estimate carries the cases-never-reported pitch, got "${callout!.textContent}"`,
  );
  assert(
    !(callout!.textContent ?? "").includes("These are industry estimates"),
    "(B) the estimate-only pitch must NOT render for a meaningless 0 estimate",
  );
}

// ---------------------------------------------------------------------------
// (C) Task #4849 — a numeral 0 is NEVER acceptable: even a defensive payload
//     claiming hasHardData=true with totalCases 0 (impossible from the shared
//     accumulator, which only counts unflagged POSITIVE values) must render
//     the not-reported treatment, never a confirmed "0".
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(
    buildFixture({ totalLeads: 10, totalReviews: 3, totalCases: 0, hasHardData: true }),
  );

  assert(
    !casesEl(doc),
    "(C) NO confirmed-number element may render for a zero total, hasHardData notwithstanding",
  );
  const missing = missingEl(doc);
  assert(missing, "(C) the not-reported state must render instead of a confirmed 0");
  assert(
    missing!.textContent!.trim() === "Not reported to us yet",
    `(C) missing state must read exactly "Not reported to us yet", got "${missing!.textContent!.trim()}"`,
  );
  assert(
    !doc.body.textContent!.includes("Confirmed client signings"),
    "(C) 'Confirmed client signings' must not appear anywhere for a zero total",
  );
  // A zero total means cases were never genuinely provided: the slide has
  // data (leads/reviews), so the tailored no-cases pitch renders (Task #4714
  // variant selection now keys off the POSITIVE-total gate).
  const callout = calloutEl(doc);
  assert(callout, "(C) the section callout must render — a zero total reads as never-reported");
  assert(
    (callout!.textContent ?? "").includes("You haven't reported any cases to us yet"),
    `(C) callout must use the cases-never-reported variant, got "${callout!.textContent}"`,
  );
  assert(
    !(callout!.textContent ?? "").includes("CaseIntake™ tracks this automatically"),
    "(C) the generic upgrade-only line must NOT show next to a slide that has data",
  );
}

// ---------------------------------------------------------------------------
// (C2) Task #4849 boundary — the same defensive zero-total payload on an
//      otherwise-empty slide (all totals 0): the old "confirmed 0 beside
//      skeleton slots" render is retired; the full Task #4693 skeleton wins,
//      generic upgrade callout included. No numeral 0 anywhere on the card.
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(
    buildFixture({ totalLeads: 0, totalReviews: 0, totalCases: 0, hasHardData: true }),
  );

  assert(
    !casesEl(doc),
    "(C2) no confirmed-number element on an all-zero payload, hasHardData notwithstanding",
  );
  assert(missingEl(doc), "(C2) the cases card renders its not-reported state");
  // The other beats stay honest skeleton slots (leads/reviews have no data).
  assert(doc.querySelector('[data-testid="text-lifetime-leads-missing"]'), "(C2) leads beat keeps its muted no-data slot");
  assert(doc.querySelector('[data-testid="text-lifetime-reviews-missing"]'), "(C2) reviews beat keeps its muted no-data slot");
  assert(
    !doc.body.textContent!.includes("Confirmed client signings"),
    "(C2) no confirmed-signings claim anywhere on an all-zero payload",
  );
  // hasLifetimeData() is false (zeros aren't data) and there is no longer
  // confirmed data to protect → the generic upgrade-only pitch renders
  // (Task #4714's fully-empty variant).
  const callout = calloutEl(doc);
  assert(callout, "(C2) the generic upsell callout renders on the fully-empty skeleton");
  assert(
    (callout!.textContent ?? "").includes("CaseIntake™ tracks this automatically"),
    `(C2) fully-empty state uses the generic upgrade-only variant, got "${callout!.textContent}"`,
  );
}

// ---------------------------------------------------------------------------
// (G) Task #4849 — partial coverage: the REAL positive total renders plus the
//     "Incomplete data" annotation naming the gap months (trend-style labels,
//     year always shown). No callout — the annotation carries the honesty.
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(
    buildFixture({
      totalLeads: 10,
      totalReviews: 3,
      totalCases: 7,
      hasHardData: true,
      casesCoverage: {
        providedMonths: ["2026-01", "2026-05", "2026-06"],
        missingMonths: ["2026-02", "2026-03", "2026-04"],
      },
    }),
  );

  const cases = casesEl(doc);
  assert(cases, "(G) confirmed-number element must render for a positive total");
  assert(
    cases!.textContent!.trim() === "7",
    `(G) the true total must render, got "${cases!.textContent!.trim()}"`,
  );
  assert(cardText(cases!).includes("Confirmed client signings"), "(G) confirmed subtitle stays");
  const note = doc.querySelector('[data-testid="text-lifetime-cases-incomplete"]');
  assert(note, "(G) the incomplete-data annotation must render when months are missing");
  assert(
    note!.textContent!.trim() === "Incomplete data — missing Feb '26, Mar '26, Apr '26",
    `(G) annotation must name the gap months with trend-style labels, got "${note!.textContent!.trim()}"`,
  );
  assert(!missingEl(doc), "(G) not-reported state must NOT render beside a confirmed total");
  assert(!calloutEl(doc), "(G) positive hard data still means NO callout");
  const slide = doc.querySelector("#lifetime-value");
  assert(slide, "(G) fixture sanity: the lifetime slide mounts");
  assert(
    !(slide!.textContent ?? "").includes("CaseIntake™"),
    "(G) the pitch must not appear anywhere on a confirmed-data lifetime slide",
  );
}

// ---------------------------------------------------------------------------
// (H) Task #4849 — long gap lists truncate gracefully: first 3 named months
//     + "+ N more".
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(
    buildFixture({
      totalLeads: 10,
      totalReviews: 3,
      totalCases: 5,
      hasHardData: true,
      casesCoverage: {
        providedMonths: ["2026-03"],
        missingMonths: ["2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02"],
      },
    }),
  );

  const note = doc.querySelector('[data-testid="text-lifetime-cases-incomplete"]');
  assert(note, "(H) annotation renders for long gap lists");
  assert(
    note!.textContent!.trim() === "Incomplete data — missing Aug '25, Sep '25, Oct '25 + 4 more",
    `(H) long lists truncate to the first 3 + count, got "${note!.textContent!.trim()}"`,
  );
  const cases = casesEl(doc);
  assert(cases && cases.textContent!.trim() === "5", "(H) the true total still renders beside the annotation");
}

// ---------------------------------------------------------------------------
// (I) Complete positive series → renders exactly as today: number +
//     "Confirmed client signings", NO annotation, NO callout.
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(
    buildFixture({
      totalLeads: 10,
      totalReviews: 3,
      totalCases: 12,
      hasHardData: true,
      casesCoverage: {
        providedMonths: ["2026-04", "2026-05", "2026-06"],
        missingMonths: [],
      },
    }),
  );

  const cases = casesEl(doc);
  assert(cases, "(I) confirmed-number element must render");
  assert(
    cases!.textContent!.trim() === "12",
    `(I) complete series renders the confirmed total, got "${cases!.textContent!.trim()}"`,
  );
  assert(cardText(cases!).includes("Confirmed client signings"), "(I) confirmed subtitle renders");
  assert(
    !doc.querySelector('[data-testid="text-lifetime-cases-incomplete"]'),
    "(I) NO annotation may render on a complete series",
  );
  assert(!calloutEl(doc), "(I) no callout beside complete confirmed data");
  assert(!missingEl(doc), "(I) no missing state beside confirmed data");
}

// ---------------------------------------------------------------------------
// (I2) Legacy payload without casesCoverage (pre-#4849 shape / hand-built
//      fixtures) → the confirmed branch renders with no annotation.
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(
    buildFixture({ totalLeads: 10, totalReviews: 3, totalCases: 12, hasHardData: true }),
  );

  const cases = casesEl(doc);
  assert(cases && cases.textContent!.trim() === "12", "(I2) legacy payload renders the confirmed total");
  assert(
    !doc.querySelector('[data-testid="text-lifetime-cases-incomplete"]'),
    "(I2) absent coverage → no annotation (legacy payloads must not crash or annotate)",
  );
  assert(!calloutEl(doc), "(I2) no callout beside confirmed data");
}

// ---------------------------------------------------------------------------
// (D) Meaningful estimate → existing "~N" branch untouched.
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(
    buildFixture({ totalLeads: 140, totalReviews: 2, totalCases: 0, estimatedCases: 42, hasHardData: false }),
  );

  const cases = casesEl(doc);
  assert(cases, "(D) estimate element must render");
  assert(
    cases!.textContent!.trim() === "~42",
    `(D) estimate must render as "~42", got "${cases!.textContent!.trim()}"`,
  );
  const card = cardText(cases!);
  assert(card.includes("Estimated Cases"), `(D) estimate label must render, got "${card}"`);
  assert(card.includes("Based on industry benchmarks"), "(D) estimate subtitle must render");
  assert(!missingEl(doc), "(D) missing state must NOT render when an estimate exists");

  // Task #4714 — estimate-only lifetime data still carries the pitch, with
  // the tailored "industry estimates" wording (owner-approved).
  const callout = calloutEl(doc);
  assert(callout, "(D) the section callout must render for estimate-only case data");
  assert(
    (callout!.textContent ?? "").includes(
      "These are industry estimates — CaseIntake™ replaces them with your real signed cases. Ask us about upgrading.",
    ),
    `(D) callout must use the estimate-only variant, got "${callout!.textContent}"`,
  );
  assert(
    !(callout!.textContent ?? "").includes("haven't reported any"),
    "(D) the no-cases pitch must NOT render when an estimate is shown",
  );
  assert(
    !(callout!.textContent ?? "").includes("CaseIntake™ tracks this automatically"),
    "(D) the generic upgrade-only line must NOT render when an estimate is shown",
  );
}

// ---------------------------------------------------------------------------
// (E) No lifetime data at all → Task #4693 full skeleton + upsell callout
//     (the #4285 slide-level placeholder is retired).
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(
    buildFixture({ totalLeads: 0, totalReviews: 0, totalCases: 0, hasHardData: false }),
  );

  assert(
    !doc.body.textContent!.includes("Lifetime value tracking starts now"),
    "(E) the #4285 slide-level placeholder is retired",
  );
  assert(!doc.querySelector('[data-testid="empty-lifetime-value"]'), "(E) no collapse band either");
  assert(missingEl(doc), "(E) the cases card renders its 'Not reported to us yet' state (full skeleton)");
  assert(!casesEl(doc), "(E) still no confirmed/estimate number fabricated");
  assert(doc.querySelector('[data-testid="text-lifetime-leads-missing"]'), "(E) leads beat shows the muted no-data slot, not 0");
  assert(doc.querySelector('[data-testid="text-lifetime-reviews-missing"]'), "(E) reviews beat shows the muted no-data slot, not 0");
  assert(doc.querySelector('[data-testid="chart-placeholder-lifetime-value"]'), "(E) arc area renders the quiet placeholder frame");
  const callout = calloutEl(doc);
  assert(callout, "(E) the single gold CaseIntake™ callout renders");
  assert(
    (callout!.textContent ?? "").includes("CaseIntake™ tracks this automatically"),
    "(E) callout uses the upgrade-only, month-free variant",
  );
  // Task #4714 — the fully-empty skeleton keeps the GENERIC pitch; the
  // partial-state variants only apply when the slide has lifetime data.
  assert(
    !(callout!.textContent ?? "").includes("haven't reported any"),
    "(E) fully-empty state must not use the partial-state no-cases pitch",
  );
  const slide = doc.querySelector("#lifetime-value");
  assert(slide, "(E) fixture sanity: the lifetime slide mounts");
  assert(
    (slide!.textContent ?? "").split("CaseIntake™").length - 1 === 1,
    "(E) the pitch appears exactly once on the lifetime slide",
  );
}

// ---------------------------------------------------------------------------
// (F) Custom terminology → the not-provided card keeps the t("cases") helper.
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(
    buildFixture(
      { totalLeads: 0, totalReviews: 12, totalCases: 0, hasHardData: false },
      { cases: "Matters" },
    ),
  );

  const missing = missingEl(doc);
  assert(missing, "(F) missing state must render under custom terminology");
  const card = cardText(missing!);
  assert(
    card.includes("Total Matters Signed"),
    `(F) label must use the client's terminology ("Total Matters Signed"), got "${card}"`,
  );
  assert(
    card.includes("No matters data reported yet"),
    `(F) neutral subtitle must use the client's terminology, got "${card}"`,
  );
  // Task #4714 — the partial-state pitch is terminology-aware too.
  const callout = calloutEl(doc);
  assert(callout, "(F) the section callout must render under custom terminology");
  assert(
    (callout!.textContent ?? "").includes(
      "You haven't reported any matters to us yet — CaseIntake™ captures your signed matters automatically. Ask us about upgrading.",
    ),
    `(F) callout must use the client's terminology, got "${callout!.textContent}"`,
  );
}

if (activeRoot) {
  await act(async () => {
    activeRoot.unmount();
  });
  activeRoot = null;
}

console.log(
  "lifetime-cases-not-provided-rendered.test.tsx: PASS — " +
    "a numeral 0 never renders (no-data AND zero-total payloads → 'Not reported to us yet', incl. estimate-rounds-to-0); " +
    "partial coverage → true total + 'Incomplete data — missing <months>' (trend labels, +N-more truncation); " +
    "complete series unchanged, legacy payloads annotation-free, estimate branch untouched, terminology preserved; " +
    "callout variants: no-cases pitch vs industry-estimates pitch vs generic (empty) vs none (positive hard data)",
);
process.exit(0);
