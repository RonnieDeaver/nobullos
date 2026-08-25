/* test-registration
{
  "name": "ClientDetail Role Assignments panel — Doer/Checker Edit/Save",
  "regression": true,
  "smoke": true,
  "smokeReason": "The ClientDetail role-assignment EDIT flow needs browser coverage so neutral-route, explicit-null, and save-feedback regressions cannot make operators think an override saved when it did not.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/sd-client-detail-edit-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4198 — browser-level coverage for the ClientDetail Service Desk Team
 * panel's EDIT/SAVE path (ClientSdTeamPanel.saveEdit in
 * client/src/pages/ClientDetail.tsx), reached the way an operator does:
 * /clients/:id?tab=sd-team → Edit → pick assignees → Save.
 *
 * The READ side (inherited-default badges) is pinned by
 * tests/client/sd-client-detail-default-badges.test.tsx (Task #4174); server
 * behavior by tests/sd-client-dept-assignments-route.test.ts. This suite pins:
 *
 *   A. Save PUTs /api/admin/role-assignments/clients/:clientId/departments/:deptId with
 *      Doer and capability-approved Checker values, empty picks serialized as
 *      explicit null (never ""); on success
 *      the "Assignment saved" toast fires and the edit form closes. Task #4206:
 *      the assignments GET then serves the UPDATED payload (override cleared),
 *      so the suite also proves the invalidate/refetch wiring re-renders the
 *      row as "Inherited default" (name + badge) — not the stale override.
 *   B. A failed save (500 {error}) fires the destructive "Save failed" toast
 *      with the server's error message, and the edit form STAYS OPEN so the
 *      operator's picks aren't silently discarded.
 *
 * Select interaction uses the interactive @radix-ui/react-select shim (see
 * tests/client/sd-team-ui-setup.mjs pattern): options render inline and a
 * plain click fires onValueChange. Toasts are recorded on
 * globalThis.__capturedToasts by the shared toast stub loader; assertions
 * filter by title, never total count (shared QueryCache onError can toast).
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";
import { PAID_SEARCH_DEPARTMENT_ID } from "../../shared/departmentRoleCapabilities";

const CLIENT_ID = "c-4198";
const DEPT_OK_ID = PAID_SEARCH_DEPARTMENT_ID;

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
  { id: "u-dc", email: "dc@x.com", firstName: "Carl", lastName: "DefaultChecker", role: "member" },
];
const TEST_USER = { id: "u-op", email: "op@x.com", firstName: "Op", lastName: "Erator", role: "ceo" };

const roleState = (
  userId: string | null,
  source: "client_override" | "default" | "company" | null,
) => ({
  userId,
  source,
  eligibility: userId ? "eligible" : "unassigned",
  stale: false,
});

// D-OK: save succeeds. D-FAIL: server returns 500 {error:"boom from server"}.
const DEPT_OK = {
  id: DEPT_OK_ID,
  name: "Paid Search",
  active: true,
  sortOrder: 1,
  assignmentScope: "per_client",
  roleCapabilities: { checker: true },
  // Department default Doer exists so clearing the explicit client assignment
  // visibly falls back to the inherited-default name + badge after refetch.
  defaultPrimaryUserId: "u-dc",
  defaultCheckerUserId: null,
};
const DEPT_FAIL = {
  id: "d-fail",
  name: "Intake",
  active: true,
  sortOrder: 2,
  assignmentScope: "per_client",
  roleCapabilities: { checker: false },
  defaultPrimaryUserId: null,
};

const ASSIGNMENTS_PAYLOAD = {
  assignments: [
    // d-ok starts with an explicit Doer the operator will clear (→ null).
    {
      id: "a1",
      clientId: CLIENT_ID,
      departmentId: DEPT_OK_ID,
      primaryUserId: "u-exp",
      checkerUserId: null,
    },
  ],
  departments: [DEPT_OK, DEPT_FAIL],
  membersByDept: {
    [DEPT_OK_ID]: ["u-exp", "u-dc"],
    "d-fail": ["u-exp", "u-dc"],
  },
  resolvedAssignments: [
    {
      departmentId: DEPT_OK_ID,
      roles: {
        doer: roleState("u-exp", "client_override"),
        checker: roleState(null, null),
      },
    },
    {
      departmentId: "d-fail",
      roles: {
        doer: roleState(null, null),
      },
    },
  ],
};

const TEST_CLIENT = {
  id: CLIENT_ID,
  firmName: "Edit Save Law",
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

// Task #4206 — after the successful d-ok save, the assignments GET serves the
// UPDATED payload (override cleared, checker set) so the suite proves the
// invalidate/refetch wiring re-renders the row from the refetched state
// instead of the stale cache.
const ASSIGNMENTS_PAYLOAD_AFTER_SAVE = {
  ...ASSIGNMENTS_PAYLOAD,
  assignments: [
    {
      id: "a1",
      clientId: CLIENT_ID,
      departmentId: DEPT_OK_ID,
      primaryUserId: null,
      checkerUserId: "u-dc",
    },
  ],
  resolvedAssignments: [
    {
      departmentId: DEPT_OK_ID,
      roles: {
        doer: roleState("u-dc", "default"),
        checker: roleState("u-dc", "client_override"),
      },
    },
    ASSIGNMENTS_PAYLOAD.resolvedAssignments[1],
  ],
};

// Mutable pointer the GET route serves; flipped by the successful d-ok PUT.
let servedAssignments: typeof ASSIGNMENTS_PAYLOAD = ASSIGNMENTS_PAYLOAD;

// Every PUT to the assignments endpoint lands here for later assertions.
const putCalls: Array<{ url: string; body: any }> = [];

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      method: "PUT",
      test: (url: string) =>
        url.includes(`/api/admin/role-assignments/clients/${CLIENT_ID}/departments/`),
      respond: ({ url, init }: any) => {
        const body = init?.body ? JSON.parse(init.body) : undefined;
        putCalls.push({ url, body });
        if (url.includes("/departments/d-fail")) {
          return { status: 500, json: { error: "boom from server" } };
        }
        servedAssignments = ASSIGNMENTS_PAYLOAD_AFTER_SAVE;
        return { status: 200, json: { ok: true } };
      },
    },
    { path: "/api/auth/user", json: TEST_USER },
    {
      test: (url: string) =>
        url.includes(`/api/admin/role-assignments/clients/${CLIENT_ID}`),
      json: () => servedAssignments,
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
// Without TSX_TSCONFIG_PATH=./tsconfig.tests.json the root tsconfig's
// "jsx": "preserve" makes tsx emit classic-runtime JSX (React.createElement),
// so app components need a global React at render time. The registered
// extraEnv provides the env; this keeps a bare `npx tsx --import …` run green.
(globalThis as any).React = React;
(dom.window as any).React = React;
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

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush(5);
}

/**
 * Pick an option in one of the shimmed assignment selects. The interactive
 * shim renders every option inline; scope the lookup to the field wrapper of
 * the given trigger so the three selects (which share option values) don't
 * cross-match.
 */
async function pickOption(triggerTestId: string, value: string): Promise<void> {
  const trigger = $(triggerTestId);
  assert(trigger !== null, `select trigger ${triggerTestId} must render`);
  // The shim renders the listbox inline as a sibling of the trigger button
  // inside the per-field wrapper div (Label + trigger + listbox); scope there.
  const field = trigger!.parentElement as HTMLElement;
  const option = field.querySelector(`[data-select-item-value="${value}"]`);
  assert(option !== null, `option ${value} must render inline for ${triggerTestId}`);
  await click(option!);
}

function toastsTitled(title: string): any[] {
  const all = ((globalThis as any).__capturedToasts ?? []) as any[];
  return all.filter((t) => t?.title === title);
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

    console.log("\n— Scenario A: edit + save PUTs Doer/Checker only and toasts 'Assignment saved' —");
    // Pre-save: the Checker-capable department shows the explicit override.
    assert(
      $(`text-primary-name-${DEPT_OK_ID}`)?.textContent === "Eve Explicit",
      "before save the override name (Eve Explicit) must show",
    );
    assert($(`badge-client-override-${DEPT_OK_ID}`) !== null, "before save the 'Explicit' badge must show");
    assert($(`badge-dept-default-${DEPT_OK_ID}`) === null, "before save the inherited-default badge must NOT show");
    await click($(`button-edit-assignment-${DEPT_OK_ID}`)!);
    assert($(`edit-form-${DEPT_OK_ID}`) !== null, "Edit must open the inline edit form");
    // Clear the explicit Doer (pick "None") and pick an explicit Checker.
    await pickOption(`select-primary-${DEPT_OK_ID}`, "__none__");
    await pickOption(`select-checker-${DEPT_OK_ID}`, "u-dc");
    await click($(`button-save-assignment-${DEPT_OK_ID}`)!);
    await flush();

    assert(putCalls.length === 1, `exactly one PUT expected, got ${putCalls.length}`);
    const okCall = putCalls[0];
    assert(
      okCall.url.endsWith(`/api/admin/role-assignments/clients/${CLIENT_ID}/departments/${DEPT_OK_ID}`),
      `PUT must target the client+dept assignment endpoint, got ${okCall.url}`,
    );
    assert("primaryUserId" in okCall.body, "body must carry primaryUserId key");
    assert(okCall.body.primaryUserId === null, "cleared Doer must serialize as explicit null");
    assert(okCall.body.checkerUserId === "u-dc", "picked Checker must serialize as the user id");
    assert(toastsTitled("Assignment saved").length === 1, "success must toast 'Assignment saved'");
    assert(toastsTitled("Save failed").length === 0, "success path must not toast 'Save failed'");
    assert($(`edit-form-${DEPT_OK_ID}`) === null, "edit form must close after a successful save");
    console.log("  ✓ PUT url/body (Doer/Checker only) + saved toast + form closed");

    // Task #4206 — the panel must re-render from the REFETCHED assignments
    // (invalidateQueries after save), not the stale cache: with the override
    // cleared, the row falls back to the dept-default name + badge.
    assert(
      $(`text-primary-name-${DEPT_OK_ID}`)?.textContent === "Carl DefaultChecker",
      `after refetch the dept-default name (Carl DefaultChecker) must show, got ${$(`text-primary-name-${DEPT_OK_ID}`)?.textContent}`,
    );
    assert(
      $(`badge-dept-default-${DEPT_OK_ID}`) !== null,
      "after refetch the inherited-default badge must show on the cleared row",
    );
    assert(
      $(`badge-client-override-${DEPT_OK_ID}`) === null,
      "after refetch the Explicit badge must be gone",
    );
    assert(
      $(`text-checker-name-${DEPT_OK_ID}`)?.textContent === "Carl DefaultChecker",
      "after refetch the saved Checker pick must render from the new payload",
    );
    console.log("  ✓ refetched state renders: dept-default name + badge, override badge gone");

    console.log("\n— Scenario B: failed save toasts destructive 'Save failed' and keeps the form open —");
    await click($("button-edit-assignment-d-fail")!);
    assert($("edit-form-d-fail") !== null, "Edit must open the failing dept's form");
    await pickOption("select-primary-d-fail", "u-exp");
    await click($("button-save-assignment-d-fail")!);
    await flush();

    assert(putCalls.length === 2, `second PUT expected, got ${putCalls.length}`);
    const failCall = putCalls[1];
    assert(
      failCall.url.endsWith(`/api/admin/role-assignments/clients/${CLIENT_ID}/departments/d-fail`),
      `failing PUT must target d-fail, got ${failCall.url}`,
    );
    assert(failCall.body.primaryUserId === "u-exp", "failing PUT still carries the operator's pick");
    assert(!("checkerUserId" in failCall.body), "Doer-only department PUT must omit unsupported Checker");
    const failedToasts = toastsTitled("Save failed");
    assert(failedToasts.length === 1, "failed save must toast 'Save failed' exactly once");
    assert(failedToasts[0].variant === "destructive", "'Save failed' toast must be destructive");
    assert(
      String(failedToasts[0].description ?? "").includes("boom from server"),
      "'Save failed' toast must surface the server's error message",
    );
    assert(toastsTitled("Assignment saved").length === 1, "failure must NOT add a success toast");
    assert($("edit-form-d-fail") !== null, "edit form must STAY OPEN after a failed save");
    console.log("  ✓ destructive failed toast with server message; picks not discarded");
  } finally {
    if (root)
      await act(async () => {
        root!.unmount();
      });
  }

  console.log("\nsd-client-detail-edit-save: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
