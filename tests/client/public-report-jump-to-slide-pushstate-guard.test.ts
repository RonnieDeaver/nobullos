/* test-registration
{
  "name": "PublicReport jumpToSlide guards repeated/rate-limited pushState (bug report)",
  "regression": true,
  "smoke": false,
  "sweepOnlyReason": "This browser-oriented PublicReport source guard intentionally stays out of the routine smoke universe; it protects a narrow navigation edge case and remains covered by the full regression sweep without adding another client harness to the blocking lane.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Bug report (forwarded end-user feedback, 2026-08-27): reports.nobullmarketing.com
 * showed the GlobalErrorBoundary's "Something went wrong" page with the
 * browser message "Attempt to use history.pushState() more than 100 times
 * per 10 seconds". Safari/Chromium throw a SecurityError once that rate
 * limit is hit; the only unconditional history.pushState call reachable from
 * the public report page is jumpToSlide() (client/src/pages/publicReport/
 * sections.ts), wired to every agenda-row and mobile progress-strip anchor
 * click (AgendaSlide.tsx, ReportTopBar.tsx). Two gaps let a burst of clicks
 * (rapid taps, or an automated browser) take down the whole report:
 *
 *   1. jumpToSlide pushed a new history entry even when re-clicking the
 *      slide already at that hash — wasted calls that eat into the budget.
 *   2. Nothing caught the SecurityError once thrown, so it propagated
 *      uncaught into GlobalErrorBoundary and crashed the entire deck over a
 *      purely cosmetic address-bar update.
 *
 * This test pins both fixes directly against the real module.
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='cover'></div><div id='agenda'></div><div id='marketing'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/share/test-token" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).history = dom.window.history;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(dom.window as any).matchMedia =
  (dom.window as any).matchMedia ||
  ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }));

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// Import the REAL production module so drift in the guard is caught.
const { jumpToSlide } = await import("../../client/src/pages/publicReport/sections");

function fakeClick() {
  let prevented = false;
  return { preventDefault: () => { prevented = true; }, wasPrevented: () => prevented };
}

// --- Scenario A: normal jump to a different slide pushes exactly once ---
{
  window.scrollTo = (() => {}) as any;
  const pushed: string[] = [];
  const originalPushState = window.history.pushState.bind(window.history);
  window.history.pushState = ((_state: any, _title: string, url?: string | URL | null) => {
    pushed.push(String(url));
  }) as any;

  window.history.replaceState(null, "", "#cover");
  const evt = fakeClick();
  jumpToSlide(evt, "agenda");

  assert(evt.wasPrevented(), "default anchor navigation should be prevented");
  assert(pushed.length === 1 && pushed[0] === "#agenda", `expected exactly one push to #agenda, got ${JSON.stringify(pushed)}`);

  window.history.pushState = originalPushState;
}

// --- Scenario B: re-clicking the slide already active skips pushState ---
{
  window.scrollTo = (() => {}) as any;
  const pushed: string[] = [];
  const originalPushState = window.history.pushState.bind(window.history);
  window.history.pushState = ((_state: any, _title: string, url?: string | URL | null) => {
    pushed.push(String(url));
  }) as any;

  window.history.replaceState(null, "", "#agenda");
  const evt = fakeClick();
  jumpToSlide(evt, "agenda");

  assert(pushed.length === 0, `re-clicking the active slide's own anchor must not push a redundant history entry, got ${JSON.stringify(pushed)}`);

  window.history.pushState = originalPushState;
}

// --- Scenario C: a rate-limited pushState (SecurityError) never escapes ---
{
  window.scrollTo = (() => {}) as any;
  window.history.replaceState(null, "", "#cover");
  const originalPushState = window.history.pushState.bind(window.history);
  window.history.pushState = (() => {
    throw new DOMException(
      "Attempt to use history.pushState() more than 100 times per 10 seconds",
      "SecurityError",
    );
  }) as any;

  const evt = fakeClick();
  let threw = false;
  try {
    jumpToSlide(evt, "marketing");
  } catch {
    threw = true;
  }

  assert(!threw, "a pushState rate-limit SecurityError must be swallowed, not crash the whole report");

  window.history.pushState = originalPushState;
}

console.log("PublicReport jumpToSlide pushState guard: all scenarios passed");
