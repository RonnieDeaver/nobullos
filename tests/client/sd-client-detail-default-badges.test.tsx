/* test-registration
{
  "name": "ClientDetail Role Assignments panel — inherited-default badges vs explicit assignments",
  "regression": true,
  "smoke": true,
  "smokeReason": "The ClientDetail inherited and explicit assignment markers need mount coverage so a neutral assignments-query or source-label regression cannot ship while route tests stay green. Fast, DB-free, network-stubbed jsdom render test.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/client-detail-tab-from-url-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4174 — mount coverage for ClientDetail's Service Desk Team panel
 * (Task #4171, ClientSdTeamPanel inside client/src/pages/ClientDetail.tsx),
 * reached the way an operator does: /clients/:id?tab=sd-team.
 *
 * Server behavior is pinned by tests/sd-client-dept-assignments-route.test.ts;
 * this pins the operator-visible inheritance markers:
 *
 *   A. When a client-facing department has NO explicit Checker on the client's
 *      assignment but the department defines a default, the panel shows the
 *      default person's NAME plus the "Inherited default" badge, and the Doer
 *      slot shows badge-dept-default-<deptId> when inherited.
 *   B. When the Checker slot IS explicitly assigned, the explicit person's
 *      name shows and the inheritance badge is ABSENT (Doer shows "Explicit"
 *      instead).
 *   C. Company-scope departments never render as per-client rows.
 *
 * Reuses tests/client/client-detail-tab-from-url-setup.mjs (Task #2517): the
 * heavy sibling panels (CommandPanel, LocalDominanceDashboard, …) are stubbed
 * — none of them matter for the SD Team tab content under test.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const CLIENT_ID = "c-4174";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: `http://localhost/clients/${CLIENT_ID}?tab=sd-team` },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).HTMLSelectElement = dom.window.HTMLSelectElement;
(globalThis as any).HTMLFormElement = dom.window.HTMLFormElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).FocusEvent = dom.window.FocusEvent;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).MutationObserver = dom.window.MutationObserver;
(globalThis as any).DOMRect = dom.window.DOMRect;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
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
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;
(dom.window as any).ResizeObserver = ResizeObserverStub;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USERS = [
  { id: "u-exp", email: "eve@x.com", firstName: "Eve", lastName: "Explicit", role: "member" },
  { id: "u-dp", email: "dp@x.com", firstName: "Dana", lastName: "DefaultDoer", role: "member" },
  { id: "u-dc", email: "dc@x.com", firstName: "Carl", lastName: "DefaultChecker", role: "member" },
  { id: "u-stale", email: "stale@x.com", firstName: "Sam", lastName: "Stale", role: "member" },
];
const TEST_USER = { id: "u-op", email: "op@x.com", firstName: "Op", lastName: "Erator", role: "ceo" };

// D1: explicit Doer, inherited Checker.
// D2: explicit Checker, inherited Doer.
// CD: company-scope — must not render a per-client row at all.
const DEPT_INHERITED = {
  id: "d-inherit",
  name: "SEO",
  active: true,
  sortOrder: 1,
  assignmentScope: "per_client",
  roleCapabilities: { doer: true, checker: true },
  defaultPrimaryUserId: "u-dp",
  defaultCheckerUserId: "u-dc",
};
const DEPT_EXPLICIT = {
  id: "d-explicit",
  name: "Intake",
  active: true,
  sortOrder: 2,
  assignmentScope: "per_client",
  roleCapabilities: { doer: true, checker: true },
  defaultPrimaryUserId: "u-dp",
  defaultCheckerUserId: "u-dc",
};
const DEPT_COMPANY = {
  id: "d-company",
  name: "Finance",
  active: true,
  sortOrder: 3,
  assignmentScope: "company",
  roleCapabilities: { doer: true, checker: true },
  defaultPrimaryUserId: null,
  defaultCheckerUserId: null,
};
const DEPT_STALE = {
  id: "d-stale",
  name: "Content",
  active: true,
  sortOrder: 4,
  assignmentScope: "per_client",
  roleCapabilities: { doer: true, checker: false },
  defaultPrimaryUserId: null,
  defaultCheckerUserId: null,
};

const roleState = (
  userId: string | null,
  source: "client_override" | "default" | "company" | null,
  eligible = !!userId,
) => ({
  userId,
  source,
  eligibility: !userId ? "unassigned" : eligible ? "eligible" : "ineligible",
  stale: !!userId && !eligible,
});

const ASSIGNMENTS_PAYLOAD = {
  assignments: [
    {
      id: "a1",
      clientId: CLIENT_ID,
      departmentId: "d-inherit",
      primaryUserId: "u-exp",
      checkerUserId: null,
    },
    {
      id: "a2",
      clientId: CLIENT_ID,
      departmentId: "d-explicit",
      primaryUserId: null,
      checkerUserId: "u-exp",
    },
    {
      id: "a3",
      clientId: CLIENT_ID,
      departmentId: "d-stale",
      primaryUserId: "u-stale",
      checkerUserId: null,
    },
  ],
  departments: [DEPT_INHERITED, DEPT_EXPLICIT, DEPT_COMPANY, DEPT_STALE],
  membersByDept: {
    "d-inherit": ["u-exp", "u-dp", "u-dc"],
    "d-explicit": ["u-exp", "u-dp", "u-dc"],
    "d-stale": [],
  },
  resolvedAssignments: [
    {
      departmentId: "d-inherit",
      roles: {
        doer: roleState("u-exp", "client_override"),
        checker: roleState("u-dc", "default"),
      },
    },
    {
      departmentId: "d-explicit",
      roles: {
        doer: roleState("u-dp", "default"),
        checker: roleState("u-exp", "client_override"),
      },
    },
    {
      departmentId: "d-stale",
      roles: {
        doer: roleState("u-stale", "client_override", false),
        checker: roleState(null, null),
      },
    },
  ],
};

const TEST_CLIENT = {
  id: CLIENT_ID,
  firmName: "Badge Test Law",
  email: null,
  phoneNumber: null,
  websiteUrl: null,
  city: null,
  state: null,
  products: ["gbp"],
  practiceAreas: [],
  ownerId: null,
  averageCaseValue: null,
  initialLeads: null,
  initialReviews: null,
  initialCases: null,
  stripeCustomerId: null,
  isArchived: false,
  clientStartDate: null,
  hasPostConsultReviewAccess: false,
  hasPostCaseClosedReviewAccess: false,
  terminology: null,
  emailDomains: [],
};

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: TEST_USER },
    {
      test: (url: string) =>
        url.includes(`/api/admin/role-assignments/clients/${CLIENT_ID}`),
      json: ASSIGNMENTS_PAYLOAD,
    },
    {
      test: (url: string) => url.includes("/api/clients/") && url.includes("/summary"),
      json: { client: TEST_CLIENT, reports: [], dataAccess: [], contacts: [] },
    },
    { path: "/api/users", json: [TEST_USER, ...USERS] },
    { path: "/api/audit-history", json: {} },
    { path: /\/communications/, json: [] },
    { path: /\/command-panel/, json: [] },
    { path: "/api/clients", json: [] },
    { path: "/api/notifications", json: [] },
  ],
  defaultJson: {},
});

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom globals + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { getQueryFn } = await import("../../client/src/lib/queryClient");
const { Router, Route } = await import("wouter");
const ClientDetail = (await import("../../client/src/pages/ClientDetail")).default;

async function flush(times = 25): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

function textOf(testId: string): string {
  const el = $(testId);
  assert(el !== null, `[data-testid="${testId}"] must render`);
  return el!.textContent ?? "";
}

async function main(): Promise<void> {
  const container = document.getElementById("root")!;
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        queryFn: getQueryFn({ on401: "throw" }) as any,
        retry: false,
        refetchOnWindowFocus: false,
      },
    },
  });
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: qc } as any,
        React.createElement(
          Router as any,
          null,
          React.createElement(Route as any, { path: "/clients/:id", component: ClientDetail }),
        ),
      ),
    );
  });
  await flush();

  try {
    assert($("client-sd-team-panel") !== null, "?tab=sd-team must render the SD Team panel");

    console.log("\n— Scenario A: inherited Checker shows name + inherited-default badge —");
    const d1 = "d-inherit";
    assert($(`sd-dept-row-${d1}`) !== null, "client-facing department row must render");
    const checkerBadge = $(`badge-dept-default-checker-${d1}`);
    assert(checkerBadge !== null, "inherited Checker slot must show the inherited-default badge");
    assert(
      (checkerBadge!.textContent ?? "").includes("Inherited default"),
      "checker badge must read 'Inherited default'",
    );
    assert(
      textOf(`text-checker-name-${d1}`).includes("Carl DefaultChecker"),
      "inherited Checker slot must show the DEFAULT person's name",
    );
    // Doer is explicit here → Explicit, NOT inherited default.
    assert($(`badge-client-override-${d1}`) !== null, "explicit Doer must show the Explicit badge");
    assert($(`badge-dept-default-${d1}`) === null, "explicit Doer must NOT show the inherited-default badge");
    assert(
      textOf(`text-primary-name-${d1}`).includes("Eve Explicit"),
      "explicit Doer shows the explicit person's name",
    );
    console.log("  ✓ inherited Checker: default name + badge; explicit primary: override badge");

    console.log("\n— Scenario B: explicit Checker renders name WITHOUT badge —");
    const d2 = "d-explicit";
    assert($(`badge-dept-default-checker-${d2}`) === null, "explicit Checker must not carry the badge");
    assert(
      textOf(`text-checker-name-${d2}`).includes("Eve Explicit"),
      "explicit Checker shows the explicit person's name",
    );
    // Doer inherited here → inherited-default badge + default name.
    assert($(`badge-dept-default-${d2}`) !== null, "inherited Doer must show the inherited-default badge");
    assert(
      textOf(`text-primary-name-${d2}`).includes("Dana DefaultDoer"),
      "inherited Doer shows the default person's name",
    );
    console.log("  ✓ explicit Checker: name only, no inheritance badge");

    console.log("\n— Scenario C: stale explicit Doer is visible but does not count as coverage —");
    assert($("sd-dept-row-d-stale") !== null, "stale assignment department row must render");
    assert(textOf("text-primary-name-d-stale").includes("Sam Stale"), "stale assigned person's name must remain visible");
    assert($("badge-client-override-d-stale") !== null, "stale explicit assignment must retain its source label");
    assert($("badge-stale-primary-d-stale") !== null, "stale assignment must be labeled as stale membership");
    assert($("badge-no-coverage-d-stale") !== null, "stale Doer must not count as effective coverage");
    assert(
      $("text-checker-name-d-stale") === null,
      "a default-deny/Doer-only department read must omit the unsupported Checker slot",
    );
    console.log("  ✓ stale assignment is labeled and excluded from coverage");

    console.log("\n— Scenario D: company-scope departments render no per-client row —");
    assert($("sd-dept-row-d-company") === null, "company-scope department must not render a per-client row");
    console.log("  ✓ company-scope dept excluded");
  } finally {
    if (root)
      await act(async () => {
        root!.unmount();
      });
  }

  console.log("\nsd-client-detail-default-badges: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
