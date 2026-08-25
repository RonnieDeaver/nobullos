/* test-registration
{
  "name": "Public report branded error states — expired/invalid link, not-ready, load-failure, and staff-preview login each render the branded NoBull state page (masthead logo, client copy with zero operator vocabulary, working mailto recovery CTA) with the REAL shared queryClient proving the Task #4225 zero-toast contract; server error strings extracted from server/routes/reports.ts so contract drift fails here (Task #4283)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4283: the share page's error states are the client-facing trust surface — a regression here shows operator vocabulary or an unbranded dead-end to a paying client at exactly the moment something already went wrong, and a toast regression re-breaks Task #4225. Fully stubbed jsdom mount (no DB/network); the only suite covering PublicReport's error branch.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json",
    "NODE_ENV": "test"
  },
  "scanPaths": [
    "server/routes/reports.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4283 — branded public error/empty states for the share-report page
 * (audit backlog #12 remainder; toast suppression itself shipped in #4225).
 *
 * Route-level contract, mounted through wouter `Route` exactly as App.tsx
 * wires it (`/share/:token`, `/preview/:reportId`):
 *
 *   1. 404 "Report not found"            → data-state="expired"  (client copy
 *      "link has expired", mailto CTA to the client-service inbox)
 *   2. 403 "…not yet finalized…"         → data-state="not-ready" — the
 *      server's operator string must NOT leak into the page
 *   3. 500 "Report operation failed"     → data-state="error" with a Try-again
 *      reload button + mailto link (raw server text never shown)
 *   4. network failure (fetch rejects)   → data-state="error" after the
 *      transient retry policy runs out (real shared-queryClient retry loop)
 *   5. 401 "Unauthorized" on /preview    → data-state="login" (staff-only
 *      surface, sign-in link) — still branded, still toast-free
 *
 * Every scenario runs against the REAL shared `queryClient`, so the
 * QueryCache.onError → toast path is genuinely in the loop: the use-toast
 * stub loader records any toast, and each state asserts zero. A positive
 * control (a non-silent query failing 400) proves the recorder actually
 * captures toasts — the zero-assertions are not vacuous.
 *
 * The 403/404 fixture bodies are extracted from server/routes/reports.ts at
 * runtime (scanPaths declares the read): if the server reword-drifts those
 * strings, the extraction or the state-detection cross-check fails here,
 * forcing the client detection to move in lockstep.
 *
 * Banned vocabulary (asserted absent from every rendered state): final/
 * finalized, draft, token, "NoBull OS", unauthorized, "marked as", "not
 * found", invalid, "logged in", "operation failed".
 */

import { register } from "node:module";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

// Heavy browser-only graph shims (recharts/framer-motion/maplibre/css) +
// the use-toast recorder feeding globalThis.__capturedToasts.
register("./review-velocity-render-loader.mjs", import.meta.url);
register("../dashboard-toast-stub-loader.mjs", import.meta.url);

// ---------------------------------------------------------------------------
// Server contract extraction — the EXACT strings the share/preview routes
// serve (server/routes/reports.ts). The client keys its state detection off
// these bodies, so the fixtures must be the live strings, not copies.
// ---------------------------------------------------------------------------
const reportsSource = readFileSync(
  new URL("../../server/routes/reports.ts", import.meta.url),
  "utf8",
);
const notFinalizedMatch = reportsSource.match(/"(This report is not yet finalized[^"]*)"/);
assert.ok(
  notFinalizedMatch,
  "share route 403 body ('This report is not yet finalized…') not found in server/routes/reports.ts — the not-ready state detection in ReportStatePage.tsx keys off this string and must move in lockstep",
);
const NOT_FINALIZED_BODY = notFinalizedMatch![1];
assert.ok(
  reportsSource.includes('{ error: "Report not found" }'),
  "share route 404 body ('Report not found') not found in server/routes/reports.ts — the expired-link state detection keys off this string and must move in lockstep",
);
const NOT_FOUND_BODY = "Report not found";

// ---------------------------------------------------------------------------
// jsdom environment (globals installed before any react-dom evaluation)
// ---------------------------------------------------------------------------
const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/share/initial-token" },
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
(globalThis as any).sessionStorage = dom.window.sessionStorage;
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
(globalThis as any).scrollTo = () => {};
(dom.window as any).scrollTo = () => {};
(globalThis as any).__capturedToasts = [];

// ---------------------------------------------------------------------------
// Client modules (imported AFTER globals + loaders are in place)
// ---------------------------------------------------------------------------
const React = (await import("react")).default;
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { Route } = await import("wouter");
const { useQuery, QueryClientProvider } = await import("@tanstack/react-query");
const { queryClient } = await import("@/lib/queryClient");
// Task #4791 — scenario 4's terminal network failure legitimately opens the
// connection-lost tracker's outage window (backoff probe timers + a recovery
// refetch of errored queries). Reset the tracker between scenarios so a late
// jittered probe success can't refetch an errored query mid-scenario
// (scenario 6 asserts EXACTLY one captured toast for its control query).
const { __test_resetConnectionLostTracker } = await import("@/lib/connectionLost");
const PublicReport = (await import("@/pages/PublicReport")).default;
const { resolveReportStateKind, REPORT_CONTACT_EMAIL } = await import(
  "@/pages/publicReport/ReportStatePage"
);

// ---------------------------------------------------------------------------
// State-detection cross-check against the LIVE server strings. This is the
// lockstep tripwire: a server reword lands here before any DOM work.
// ---------------------------------------------------------------------------
assert.equal(resolveReportStateKind(NOT_FINALIZED_BODY), "not-ready");
assert.equal(resolveReportStateKind(NOT_FOUND_BODY), "expired");
assert.equal(resolveReportStateKind("Unauthorized"), "login");
assert.equal(resolveReportStateKind("Report operation failed"), "error");
assert.equal(resolveReportStateKind("Request failed (502)"), "error");
assert.equal(resolveReportStateKind(undefined), "error");

// Client copy must never surface operator vocabulary or raw server text.
const BANNED_VOCABULARY: Array<[RegExp, string]> = [
  [/\bfinal/i, "final/finalized (operator workflow term)"],
  [/\bdraft\b/i, "draft (operator workflow term)"],
  [/\btoken\b/i, "token (auth mechanics)"],
  [/nobull os/i, "NoBull OS (internal product name)"],
  [/\bunauthorized\b/i, "unauthorized (raw auth error)"],
  [/marked as/i, "'marked as' (operator instruction)"],
  [/not found/i, "'not found' (raw 404 phrasing)"],
  [/\binvalid\b/i, "invalid (raw validation phrasing)"],
  [/logged in/i, "'logged in' (old operator copy)"],
  [/operation failed/i, "raw 500 body text"],
];

const doc = dom.window.document;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await sleep(ms);
  });
}

let activeRoot: any = null;

async function unmountActive(): Promise<void> {
  if (activeRoot) {
    const root = activeRoot;
    activeRoot = null;
    await act(async () => {
      root.unmount();
    });
  }
  doc.getElementById("root")!.innerHTML = "";
  queryClient.clear();
  __test_resetConnectionLostTracker();
}

async function mountAt(path: string, element: any): Promise<void> {
  await unmountActive();
  dom.window.history.replaceState(null, "", path);
  const container = doc.getElementById("root")!;
  await act(async () => {
    activeRoot = ReactDOMClient.createRoot(container);
    activeRoot.render(
      React.createElement(QueryClientProvider, { client: queryClient }, element),
    );
  });
  await flush(0);
}

async function waitForStatePage(label: string, timeoutMs = 15000): Promise<Element> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const el = doc.querySelector('[data-testid="report-state-page"]');
    if (el) return el;
    if (Date.now() > deadline) {
      throw new Error(`${label}: report-state-page never rendered; body: ${doc.body.textContent}`);
    }
    await flush(50);
  }
}

function assertBrandedState(label: string, page: Element, expectedState: string): void {
  assert.equal(
    page.getAttribute("data-state"),
    expectedState,
    `${label}: data-state must be "${expectedState}"`,
  );
  const logo = page.querySelector('[data-testid="report-state-logo"]') as HTMLImageElement | null;
  assert.ok(logo, `${label}: branded masthead logo must render`);
  assert.ok(
    (logo!.getAttribute("src") || "").includes("NoBull.Primary.Logo.White"),
    `${label}: masthead uses the white primary logo (got src=${logo!.getAttribute("src")})`,
  );
  assert.equal(logo!.getAttribute("alt"), "NoBull Marketing", `${label}: client-facing logo alt`);
  const title = page.querySelector('[data-testid="report-state-title"]');
  assert.ok(title && (title.textContent || "").trim().length > 0, `${label}: headline renders`);
  const text = page.textContent || "";
  for (const [pattern, why] of BANNED_VOCABULARY) {
    assert.ok(
      !pattern.test(text),
      `${label}: page text must not contain ${why} — matched ${pattern} in: ${text}`,
    );
  }
  assert.equal(
    (globalThis as any).__capturedToasts.length,
    0,
    `${label}: zero toasts on the branded state (Task #4225 contract) — got ${JSON.stringify(
      (globalThis as any).__capturedToasts,
    )}`,
  );
}

function assertMailtoCta(label: string, page: Element): void {
  const cta = page.querySelector('[data-testid="report-state-cta-email"]') as HTMLAnchorElement | null;
  assert.ok(cta, `${label}: mailto recovery CTA must render`);
  const href = cta!.getAttribute("href") || "";
  assert.ok(
    href.startsWith(`mailto:${REPORT_CONTACT_EMAIL}?`),
    `${label}: CTA is a mailto to the client-service inbox (got ${href})`,
  );
  assert.ok(href.includes("subject="), `${label}: mailto carries a prefilled subject`);
  const plain = page.querySelector('[data-testid="report-state-email-plain"]');
  assert.equal(
    plain?.textContent,
    REPORT_CONTACT_EMAIL,
    `${label}: plain-text email visible for devices without a mail client`,
  );
}

function shareRoute(): any {
  return React.createElement(Route, { path: "/share/:token", component: PublicReport as any });
}

function previewRoute(): any {
  return React.createElement(Route, { path: "/preview/:reportId" }, () =>
    React.createElement(PublicReport as any, { isPreview: true }),
  );
}

async function run(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. Expired / invalid link — share 404 with the live server body.
  // -------------------------------------------------------------------------
  globalThis.fetch = createFetchStub({
    Headers: dom.window.Headers,
    routes: [{ path: "/api/share", status: 404, json: { error: NOT_FOUND_BODY } }],
    defaultJson: {},
  }) as any;
  await mountAt("/share/expired-link-1", shareRoute());
  let page = await waitForStatePage("expired");
  assertBrandedState("expired", page, "expired");
  assertMailtoCta("expired", page);
  assert.ok(
    /link has expired/i.test(page.textContent || ""),
    "expired: client copy explains the link expired",
  );
  assert.ok(
    /account manager/i.test(page.textContent || ""),
    "expired: copy routes recovery through the account manager",
  );
  console.log("  ✓ expired/invalid link → branded expired state with mailto CTA, no toast");

  // -------------------------------------------------------------------------
  // 2. Not ready — share 403 with the live "not yet finalized" body. The
  //    operator string arrives on the wire and must NOT reach the page.
  // -------------------------------------------------------------------------
  globalThis.fetch = createFetchStub({
    Headers: dom.window.Headers,
    routes: [{ path: "/api/share", status: 403, json: { error: NOT_FINALIZED_BODY } }],
    defaultJson: {},
  }) as any;
  await mountAt("/share/draft-report-2", shareRoute());
  page = await waitForStatePage("not-ready");
  assertBrandedState("not-ready", page, "not-ready");
  assertMailtoCta("not-ready", page);
  assert.ok(
    /almost ready/i.test(page.textContent || ""),
    "not-ready: client copy frames the report as in preparation",
  );
  console.log("  ✓ draft/not-ready → branded not-ready state, operator vocabulary filtered, no toast");

  // -------------------------------------------------------------------------
  // 3. Load failure — share 500. Try-again reload button + mailto link.
  // -------------------------------------------------------------------------
  globalThis.fetch = createFetchStub({
    Headers: dom.window.Headers,
    routes: [{ path: "/api/share", status: 500, json: { error: "Report operation failed" } }],
    defaultJson: {},
  }) as any;
  await mountAt("/share/broken-backend-3", shareRoute());
  page = await waitForStatePage("error-500");
  assertBrandedState("error-500", page, "error");
  assertMailtoCta("error-500", page);
  assert.ok(
    page.querySelector('[data-testid="report-state-retry"]'),
    "error-500: Try-again recovery button renders",
  );
  console.log("  ✓ server 500 → branded load-failure state with Try again + mailto, no toast");

  // -------------------------------------------------------------------------
  // 4. Network failure — fetch rejects; the shared queryClient's transient
  //    retry policy (2 retries, 1s+2s backoff) runs out, then the branded
  //    error state renders. Proves rejection (not just non-2xx) lands there.
  // -------------------------------------------------------------------------
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as any;
  await mountAt("/share/network-dead-4", shareRoute());
  page = await waitForStatePage("error-network", 20000);
  assertBrandedState("error-network", page, "error");
  assert.ok(
    page.querySelector('[data-testid="report-state-retry"]'),
    "error-network: Try-again recovery button renders",
  );
  console.log("  ✓ network failure → branded load-failure state after transient retries, no toast");

  // -------------------------------------------------------------------------
  // 5. Staff preview, signed out — 401 Unauthorized on /api/preview.
  // -------------------------------------------------------------------------
  globalThis.fetch = createFetchStub({
    Headers: dom.window.Headers,
    routes: [{ path: "/api/preview", status: 401, json: { error: "Unauthorized" } }],
    defaultJson: {},
  }) as any;
  await mountAt("/preview/report-5", previewRoute());
  page = await waitForStatePage("login");
  assertBrandedState("login", page, "login");
  const signIn = page.querySelector('[data-testid="report-state-cta-signin"]');
  assert.ok(signIn, "login: sign-in CTA renders");
  assert.equal(signIn!.getAttribute("href"), "/", "login: sign-in CTA links to the app root");
  console.log("  ✓ signed-out staff preview → branded login state, no toast");

  // -------------------------------------------------------------------------
  // 6. Positive control — a NON-silent query failing terminally MUST fire the
  //    global toast through the same recorder, proving every zero-toast
  //    assertion above had a live capture path.
  // -------------------------------------------------------------------------
  globalThis.fetch = createFetchStub({
    Headers: dom.window.Headers,
    routes: [{ path: "/api/toast-control", status: 400, json: { error: "control failure" } }],
    defaultJson: {},
  }) as any;
  function ToastControl(): null {
    useQuery({ queryKey: ["/api/toast-control"] });
    return null;
  }
  await mountAt("/share/toast-control-6", React.createElement(ToastControl));
  const controlDeadline = Date.now() + 10000;
  while ((globalThis as any).__capturedToasts.length === 0 && Date.now() < controlDeadline) {
    await flush(50);
  }
  assert.equal(
    (globalThis as any).__capturedToasts.length,
    1,
    "positive control: the non-silent failing query fires exactly one global toast",
  );
  assert.equal(
    (globalThis as any).__capturedToasts[0]?.variant,
    "destructive",
    "positive control: the captured toast is the global destructive error toast",
  );
  console.log("  ✓ positive control: non-silent query failure fires the recorded toast");

  await unmountActive();
}

run()
  .then(() => {
    console.log("\nPASS tests/client/public-report-branded-error-states.test.tsx");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nFAIL tests/client/public-report-branded-error-states.test.tsx");
    console.error(err);
    process.exit(1);
  });
