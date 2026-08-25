/* test-registration
{
  "name": "Role Assignments — Company & defaults tab: company rows, per-dept defaults inline editor, role-defaults PUT save + 422 surfacing (Task #4174)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4174: the Role Assignments 'Company & defaults' tab (Task #4171) had no mount coverage — a coverage-query shape change (companyRows/departments defaults) or an editor regression would ship silently while the route tests stay green. Fast, DB-free, network-stubbed jsdom render test.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/sd-team-ui-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4174 — mount coverage for the Role Assignments console's
 * "Company & defaults" tab (Task #4171,
 * client/src/pages/admin/RoleAssignments.tsx → CompanyDefaultsView).
 *
 * Server behavior is pinned by tests/sd-role-assignments-bulk-route.test.ts
 * and the departments route tests; this pins the operator-visible surface:
 *
 *   A. The tab renders one company-roles row per company-scope department
 *      (holder names + Gap badges) and one per-department-defaults row per
 *      client-facing department (default names / — placeholders).
 *   B. The inline supported-role editor saves via
 *      PUT /api/admin/role-assignments/departments/:id with the picked
 *      defaultPrimaryUserId/defaultCheckerUserId and toasts "Role holders saved".
 *   C. A 422 membership-eligibility rejection surfaces the server's per-field
 *      message ("Default checker user must be an active member …") in the
 *      destructive save-failed toast instead of being swallowed.
 *
 * Radix Select is shimmed interactively (options must be PICKED) and toast()
 * calls are captured via tests/dashboard-toast-stub-loader.mjs — both wired in
 * tests/client/sd-team-ui-setup.mjs. Radix Tabs mounts fine in jsdom (no
 * portal); tab switching is a plain trigger click.
 */

import { JSDOM } from "jsdom";
import { createFetchStub, createJsonResponse } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/admin/role-assignments" },
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
(globalThis as any).NodeFilter = dom.window.NodeFilter;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).FocusEvent = dom.window.FocusEvent;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).PointerEvent = (dom.window as any).PointerEvent ?? dom.window.MouseEvent;
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
  { id: "u1", email: "alice@x.com", firstName: "Alice", lastName: "Doe", role: "member" },
  { id: "u2", email: "bob@x.com", firstName: "Bob", lastName: "Roe", role: "member" },
  { id: "u3", email: "cara@x.com", firstName: "Cara", lastName: "Poe", role: "member" },
];

const COMPANY_DEPT = {
  id: "d04fc82e-a7c4-48ad-9e22-1d51830f6479",
  name: "Paid Search",
  active: true,
  sortOrder: 1,
  assignmentScope: "company" as const,
  roleCapabilities: { doer: true, checker: true },
};
const CLIENT_DEPT = {
  id: "4d2e06d4-b935-468b-a204-630964e151bc",
  name: "GBP / Local SEO",
  active: true,
  sortOrder: 2,
  assignmentScope: "per_client" as const,
  roleCapabilities: { doer: true, checker: true },
  defaultPrimaryUserId: "u1",
  defaultCheckerUserId: null,
};
const NEW_DEPT = {
  id: "new-dept-default-deny",
  name: "New Department",
  active: true,
  sortOrder: 3,
  assignmentScope: "per_client" as const,
  roleCapabilities: { doer: true, checker: false },
  defaultPrimaryUserId: "u1",
  // A legacy/default value must not reintroduce an unsupported UI slot.
  defaultCheckerUserId: "u2",
};
const CLIENT_ID = "client-role-defaults-test";

function assignmentState(
  userId: string | null,
  source: "company" | "client_override" | "default" | null,
) {
  return {
    userId,
    source,
    eligibility: userId ? ("eligible" as const) : ("unassigned" as const),
    stale: false,
    projection: {
      externalUserId: null,
      ready: false,
      workspaceVerification: "not_requested" as const,
    },
  };
}

const COVERAGE = {
  rows: [
    {
      clientId: CLIENT_ID,
      firmName: "Acme Co",
      departmentId: CLIENT_DEPT.id,
      deptName: CLIENT_DEPT.name,
      primaryUserId: "u1",
      checkerUserId: null,
      defaultPrimaryUserId: "u1",
      defaultCheckerUserId: null,
      hasCoverage: true,
      stalePrimary: false,
      staleChecker: false,
      missingDoer: false,
      missingChecker: true,
      roleStates: {
        doer: assignmentState("u1", "client_override"),
        checker: assignmentState(null, null),
      },
    },
  ],
  companyRows: [
    {
      departmentId: COMPANY_DEPT.id,
      deptName: COMPANY_DEPT.name,
      primaryUserId: "u1",
      checkerUserId: null,
      stalePrimary: false,
      staleChecker: false,
      missingDoer: false,
      missingChecker: true,
      roleStates: {
        doer: assignmentState("u1", "company"),
        checker: assignmentState(null, null),
      },
    },
  ],
  departments: [COMPANY_DEPT, CLIENT_DEPT, NEW_DEPT],
  membersByDept: {
    [COMPANY_DEPT.id]: ["u1", "u2"],
    [CLIENT_DEPT.id]: ["u1", "u2", "u3"],
    [NEW_DEPT.id]: ["u1", "u2", "u3"],
  },
  memberProjectionByDept: {},
  projectionConfigured: false,
};

// Per-scenario PUT behavior + captured PUT bodies.
let putShould422 = false;
let putCalls: { url: string; body: any }[] = [];
let postCalls: { url: string; body: any }[] = [];

const jsonResponse = createJsonResponse(dom.window.Headers) as (status: number, body: any) => Response;

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      method: "PUT",
      test: (url: string) => /\/api\/admin\/role-assignments\/clients\/[^/]+\/departments\/[^/]+$/.test(url),
      respond: ({ url, init }: any) => {
        putCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        return jsonResponse(200, { assignment: {} });
      },
    },
    {
      method: "PUT",
      test: (url: string) => /\/api\/admin\/role-assignments\/departments\/[^/]+$/.test(url),
      respond: ({ url, init }: any) => {
        let parsed: any = null;
        try {
          parsed = init?.body ? JSON.parse(String(init.body)) : null;
        } catch {
          parsed = null;
        }
        putCalls.push({ url, body: parsed });
        if (putShould422) {
          return jsonResponse(422, {
            error: "Default checker user must be an active member of this department",
          });
        }
        return jsonResponse(200, { department: { id: CLIENT_DEPT.id } });
      },
    },
    {
      method: "POST",
      path: "/api/admin/role-assignments/bulk",
      respond: ({ url, init }: any) => {
        postCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        return jsonResponse(200, { updated: 1 });
      },
    },
    { path: "/api/admin/role-assignments", json: COVERAGE },
    { path: "/api/users", json: USERS },
    { path: "/api/auth/user", json: USERS[0] },
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
const { QueryClientProvider } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const RoleAssignments = (await import("../../client/src/pages/admin/RoleAssignments")).default;

function seenToasts(): { title?: any; description?: any; variant?: any }[] {
  return ((globalThis as any).__capturedToasts ?? []) as any[];
}

async function flush(times = 16): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function clickEl(el: HTMLElement): Promise<void> {
  await act(async () => {
    // Radix Tabs activates on mousedown; buttons on click. Send both.
    el.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush(4);
}

async function clickById(testId: string): Promise<void> {
  const el = $(testId);
  assert(el !== null, `expected [data-testid="${testId}"] to exist before click`);
  await clickEl(el!);
}

// The interactive select shim mounts each Select's listbox inline next to its
// trigger; scope option lookup to the trigger's table cell.
async function pickOption(triggerTestId: string, value: string): Promise<void> {
  const trigger = $(triggerTestId);
  assert(trigger !== null, `select trigger [data-testid="${triggerTestId}"] must render`);
  const scope = trigger!.closest("td") ?? trigger!.parentElement!;
  const opt = (Array.from(scope.querySelectorAll('[role="option"]')) as HTMLElement[]).find(
    (o) => o.getAttribute("data-select-item-value") === value,
  );
  assert(opt, `select ${triggerTestId} must offer an option with value "${value}"`);
  await clickEl(opt!);
}

async function mountPage(): Promise<Root> {
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(RoleAssignments as any),
      ),
    );
  });
  await flush();
  return root!;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  queryClient.clear();
  putCalls = [];
  postCalls = [];
  (globalThis as any).__capturedToasts = [];
}

// ---------------------------------------------------------------------------
// Scenario A: the Company & defaults tab renders both sections.
// ---------------------------------------------------------------------------

async function scenarioRender(root: Root): Promise<void> {
  console.log("\n— Scenario A: Company & defaults tab renders company rows + defaults rows —");
  assert($("role-assignments-page") !== null, "console page must mount");
  await clickById("tab-company-defaults");
  assert(
    $("role-assignments-company-defaults") !== null,
    "the Company & defaults view must render after activating its tab",
  );

  // Company-wide roles expose only supported roles.
  const companyRow = $(`company-row-${COMPANY_DEPT.id}`);
  assert(companyRow !== null, "company-scope department must render a company-roles row");
  const companyText = companyRow!.textContent ?? "";
  assert(companyText.includes("Paid Search"), "company row must show the department name");
  assert(companyText.includes("Alice Doe"), "company row must show the Doer holder's name");
  assert((companyText.match(/Gap/g) ?? []).length === 1, `only missing Checker must render a Gap badge — got "${companyText}"`);

  // Per-department defaults: one row per client-facing department; the
  // company-scope department must NOT appear here.
  const defaultsRow = $(`defaults-row-${CLIENT_DEPT.id}`);
  assert(defaultsRow !== null, "client-facing department must render a defaults row");
  const defaultsText = defaultsRow!.textContent ?? "";
  assert(defaultsText.includes("GBP / Local SEO"), "defaults row must show the department name");
  assert(defaultsText.includes("Alice Doe"), "defaults row must show the default Doer's name");
  assert($(`defaults-row-${COMPANY_DEPT.id}`) === null, "company-scope departments must not appear in the defaults table");
  assert($(`company-row-${CLIENT_DEPT.id}`) === null, "client-facing departments must not appear in the company-roles table");
  const newDepartmentRow = $(`defaults-row-${NEW_DEPT.id}`);
  assert(newDepartmentRow !== null, "new departments still render their supported Doer defaults");
  const defaultsHeaderCells = defaultsRow!.closest("table")!.querySelectorAll("thead th").length;
  assert(
    newDepartmentRow!.querySelectorAll("td").length === defaultsHeaderCells,
    "mixed-capability defaults rows must stay aligned with the global Checker header",
  );
  assert(
    $(`checker-unavailable-defaults-${NEW_DEPT.id}`)?.textContent === "Not available",
    "a Doer-only department must render a non-interactive alignment cell instead of a Checker slot",
  );
  await clickById(`button-edit-defaults-${NEW_DEPT.id}`);
  assert(
    $("select-checker-defaults") === null,
    "the universal console must not render a Checker editor for an unapproved/default-deny department",
  );
  assert(
    newDepartmentRow!.querySelectorAll("td").length === defaultsHeaderCells,
    "mixed-capability defaults rows must remain aligned while editing",
  );
  await clickById("button-cancel-defaults");
  console.log("  ✓ company rows + defaults rows render with names and Gap badges");
}

// ---------------------------------------------------------------------------
// Scenario B: the inline editor saves via PUT …/role-defaults.
// ---------------------------------------------------------------------------

async function scenarioSave(): Promise<void> {
  console.log("\n— Scenario B: defaults inline editor → PUT role-defaults + saved toast —");
  putShould422 = false;
  await clickById(`button-edit-defaults-${CLIENT_DEPT.id}`);
  assert($("select-checker-defaults") !== null, "the inline supported-role editor must render");
  await pickOption("select-checker-defaults", "u2");
  await clickById("button-save-defaults");

  assert(putCalls.length === 1, `expected exactly one role-defaults PUT, got ${putCalls.length}`);
  const call = putCalls[0];
  assert(
    new RegExp(`/api/admin/role-assignments/departments/${CLIENT_DEPT.id}$`).test(call.url),
    `PUT must target the edited department — got ${call.url}`,
  );
  assert(call.body?.defaultPrimaryUserId === "u1" && call.body?.defaultCheckerUserId === "u2",
    `PUT body must carry the kept Doer and picked Checker — got ${JSON.stringify(call.body)}`);
  assert(
    seenToasts().some((t) => String(t.title ?? "") === "Role holders saved"),
    `a clean save must toast "Role holders saved" — saw ${JSON.stringify(seenToasts().map((t) => t.title))}`,
  );
  console.log("  ✓ PUT body + saved toast");
}

// ---------------------------------------------------------------------------
// Scenario C: a 422 rejection surfaces the server's per-field message.
// ---------------------------------------------------------------------------

async function scenario422(): Promise<void> {
  console.log("\n— Scenario C: 422 eligibility rejection surfaces the field message —");
  putShould422 = true;
  (globalThis as any).__capturedToasts = [];
  putCalls = [];

  // The company-roles editor drives the SAME PUT — exercise it from that side.
  await clickById(`button-edit-company-${COMPANY_DEPT.id}`);
  assert($("select-checker-defaults") !== null, "the company-row inline editor must render");
  await pickOption("select-checker-defaults", "u2");
  await clickById("button-save-defaults");

  assert(putCalls.length === 1, `expected one PUT, got ${putCalls.length}`);
  assert(
    new RegExp(`/api/admin/role-assignments/departments/${COMPANY_DEPT.id}$`).test(putCalls[0].url),
    `company-row save must PUT the company department — got ${putCalls[0].url}`,
  );
  const failed = seenToasts().find((t) => String(t.title ?? "") === "Save failed");
  assert(failed, `a 422 must raise the destructive save-failed toast — saw ${JSON.stringify(seenToasts().map((t) => t.title))}`);
  assert(failed!.variant === "destructive", "save-failed toast must be destructive");
  assert(
    String(failed!.description ?? "").includes("Default checker user must be an active member"),
    `the server's per-field 422 message must reach the operator — got "${failed!.description}"`,
  );
  // The editor must NOT report success.
  assert(
    !seenToasts().some((t) => String(t.title ?? "") === "Role holders saved"),
    "a rejected save must not toast success",
  );
  console.log("  ✓ destructive toast carries the per-field 422 message");
}

// ---------------------------------------------------------------------------
// Scenario D: grid and bulk mutations remain supported-role-only.
// ---------------------------------------------------------------------------

async function scenarioGridAndBulk(): Promise<void> {
  console.log("\n— Scenario D: grid + bulk expose and emit only supported roles —");
  putShould422 = false;
  putCalls = [];
  postCalls = [];

  await clickById("tab-by-client");
  const gapFilter = $("select-gap-filter");
  assert(gapFilter !== null, "gap filter must render");
  await clickById("tab-by-person");
  await clickById("tab-by-client");

  await clickById(`button-edit-grid-${CLIENT_ID}-${CLIENT_DEPT.id}`);
  await pickOption("select-primary-grid", "u2");
  await clickById("button-save-grid");
  assert(putCalls.length === 1, `grid save must issue one PUT, got ${putCalls.length}`);
  assert(putCalls[0].body?.primaryUserId === "u2", "grid save must preserve supported Doer behavior");

  await clickById("button-open-bulk-assign");
  await pickOption("select-bulk-department", CLIENT_DEPT.id);
  const bulkRole = $("select-bulk-role");
  assert(bulkRole !== null, "bulk role picker must render");
  const bulkRoleValues = Array.from(bulkRole!.parentElement!.querySelectorAll('[role="option"]')).map(
    (option) => option.getAttribute("data-select-item-value"),
  );
  assert(bulkRoleValues.includes("primary") && bulkRoleValues.includes("checker"),
    `bulk roles must retain Doer and approved Checker — got ${JSON.stringify(bulkRoleValues)}`);
  await clickById("button-select-all-clients");
  await clickById("button-bulk-preview");
  await clickById("button-bulk-apply");
  assert(postCalls.length === 1, `bulk apply must issue one POST, got ${postCalls.length}`);
  assert(postCalls[0].body?.responsibility === "doer",
    `bulk payload must emit supported doer responsibility — got ${JSON.stringify(postCalls[0].body)}`);
  console.log("  ✓ grid/by-person/default/bulk surfaces retain Doer/Checker");
}

async function main(): Promise<void> {
  const root = await mountPage();
  try {
    await scenarioRender(root);
    await scenarioSave();
    await scenario422();
    await scenarioGridAndBulk();
  } finally {
    await unmount(root);
  }
  console.log("\nsd-role-assignments-company-defaults: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
