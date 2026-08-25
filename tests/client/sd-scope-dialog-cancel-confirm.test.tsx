/* test-registration
{
  "name": "Departments panel scope-change dialog — opens with assignment count, Cancel keeps old scope with no PUT, Confirm PUTs the new assignmentScope, failing PUT toasts destructive Failed and keeps the old value (Tasks #4204/#4235)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4204: the scope-flip confirmation dialog (Task #4173) was only ever verified by a one-off browser QA pass (audits/task-4199-scope-dialog-browser-qa.md). A DepartmentsPanel refactor could silently make Cancel apply the flip (or Confirm stop firing the PUT) with no test going red. Fast, DB-free, network-stubbed jsdom render test.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/sd-scope-dialog-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4204 — mount coverage for the Departments panel's scope-change
 * confirmation dialog (Task #4173,
 * client/src/pages/admin/ServiceDeskSettings.tsx → DepartmentsPanel).
 *
 * Browser QA (Task #4199) proved the behavior once; this pins it:
 *
 *   A. Changing a department's Scope select opens the confirmation dialog
 *      (dialog-scope-confirm) showing the per-client assignment-row count,
 *      WITHOUT firing any PUT — the select stays controlled by the server
 *      value, so the trigger still shows the old scope.
 *   B. Cancel closes the dialog, fires NO PUT, and the select is unchanged.
 *   C. Re-opening and clicking Confirm fires exactly one
 *      PUT /api/service-desk/departments/:id with the new assignmentScope,
 *      and the dialog closes.
 *   D. (Task #4235) Confirm on a FAILING PUT raises the destructive "Failed"
 *      toast (no success toast), the dialog still closes via onSettled, and
 *      the select stays on the old server value — a regression here would
 *      silently show success while nothing changed.
 *
 * Radix Select never portals in raw jsdom and this test must PICK an option,
 * so the interactive select shim + dialog shim are wired via
 * tests/client/sd-scope-dialog-setup.mjs.
 */

import { JSDOM } from "jsdom";
import { createFetchStub, createJsonResponse } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/admin/service-desk" },
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

const CEO_USER = { id: "u-ceo", email: "ceo@x.com", firstName: "Cee", lastName: "Oh", role: "ceo" };

const DEPT = {
  id: "d1",
  name: "SEO",
  active: true,
  sortOrder: 1,
  assignmentScope: "per_client" as const,
  assignmentCount: 3,
  lastAssignmentUpdatedAt: null,
  memberCount: 2,
};

// Captured PUT bodies against /api/service-desk/departments/:id.
let putCalls: { url: string; body: any }[] = [];

// Task #4235 — when true, the next PUT fails with a 500 so the error path
// (destructive "Failed" toast + select stays on the server value) is exercised.
let failNextPut = false;

const jsonResponse = createJsonResponse(dom.window.Headers) as (status: number, body: any) => Response;

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      method: "PUT",
      test: (url: string) => /\/api\/service-desk\/departments\/[^/]+$/.test(url),
      respond: ({ url, init }: any) => {
        let parsed: any = null;
        try {
          parsed = init?.body ? JSON.parse(String(init.body)) : null;
        } catch {
          parsed = null;
        }
        putCalls.push({ url, body: parsed });
        if (failNextPut) {
          failNextPut = false;
          return jsonResponse(500, { message: "scope flip exploded" });
        }
        return jsonResponse(200, { department: { ...DEPT, assignmentScope: parsed?.assignmentScope ?? DEPT.assignmentScope } });
      },
    },
    { path: "/api/auth/user", json: CEO_USER },
    { path: "/api/service-desk/config", json: { config: null } },
    { path: "/api/service-desk/departments", json: { departments: [DEPT] } },
    { path: "/api/service-desk/request-types", json: { requestTypes: [] } },
    { path: "/api/service-desk/setup/verify", json: { checks: [] } },
    { path: "/api/integrations/clickup/status", json: { connected: false, status: "not_connected" } },
    { path: "/api/service-desk/coverage", json: { rows: [], companyRows: [], departments: [], membersByDept: {} } },
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
const ServiceDeskSettings = (await import("../../client/src/pages/admin/ServiceDeskSettings")).default;

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
async function pickScopeOption(deptId: string, value: string): Promise<void> {
  const trigger = $(`select-dept-scope-${deptId}`);
  assert(trigger !== null, `scope select trigger for ${deptId} must render`);
  const scope = trigger!.closest("td") ?? trigger!.parentElement!;
  const opt = (Array.from(scope.querySelectorAll('[role="option"]')) as HTMLElement[]).find(
    (o) => o.getAttribute("data-select-item-value") === value,
  );
  assert(opt, `scope select must offer the "${value}" option`);
  await clickEl(opt!);
}

function scopeTriggerText(deptId: string): string {
  return ($(`select-dept-scope-${deptId}`)?.textContent ?? "").trim();
}

async function main(): Promise<void> {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(ServiceDeskSettings as any),
      ),
    );
  });
  await flush();

  assert($("page-service-desk-settings") !== null, "settings page must mount for the CEO user");

  // Open the Departments tab.
  await clickById("tab-departments");
  assert($(`select-dept-scope-${DEPT.id}`) !== null, "Departments tab must render the scope select");
  assert($("dialog-scope-confirm") === null, "confirm dialog must be closed initially");
  const initialText = scopeTriggerText(DEPT.id);
  assert(
    initialText.includes("per_client") || /per.?client/i.test(initialText),
    `scope trigger must reflect the server per_client value — got "${initialText}"`,
  );

  // — Scenario A: picking the other scope opens the dialog, fires no PUT —
  console.log("\n— Scenario A: scope change opens the confirmation dialog —");
  await pickScopeOption(DEPT.id, "company");
  const dialog = $("dialog-scope-confirm");
  assert(dialog !== null, "picking a new scope must open the confirmation dialog");
  const body = ($("text-scope-confirm-body")?.textContent ?? "");
  assert(
    body.includes(`${DEPT.assignmentCount}`) && /assignment rows/.test(body),
    `dialog body must state the per-client assignment-row count — got "${body}"`,
  );
  assert(putCalls.length === 0, `merely opening the dialog must not PUT — saw ${putCalls.length} call(s)`);

  // — Scenario B: Cancel closes with NO PUT and the select unchanged —
  console.log("— Scenario B: Cancel keeps the old scope, fires no PUT —");
  await clickById("button-scope-cancel");
  assert($("dialog-scope-confirm") === null, "Cancel must close the dialog");
  assert(putCalls.length === 0, `Cancel must fire NO PUT — saw ${putCalls.length} call(s)`);
  const afterCancel = scopeTriggerText(DEPT.id);
  assert(
    afterCancel === initialText,
    `after Cancel the select must be unchanged — was "${initialText}", now "${afterCancel}"`,
  );
  console.log("  ✓ Cancel discarded the pending flip");

  // — Scenario C: Confirm fires PUT /departments/:id with the new scope —
  console.log("— Scenario C: Confirm PUTs the new assignmentScope —");
  await pickScopeOption(DEPT.id, "company");
  assert($("dialog-scope-confirm") !== null, "re-picking must re-open the dialog");
  await clickById("button-scope-confirm");
  await flush(8);
  assert(putCalls.length === 1, `Confirm must fire exactly one PUT — saw ${putCalls.length}`);
  assert(
    new RegExp(`/api/service-desk/departments/${DEPT.id}$`).test(putCalls[0].url),
    `PUT must target the department — got ${putCalls[0].url}`,
  );
  assert(
    putCalls[0].body?.assignmentScope === "company",
    `PUT body must carry the new assignmentScope — got ${JSON.stringify(putCalls[0].body)}`,
  );
  assert($("dialog-scope-confirm") === null, "the dialog must close after Confirm settles");
  const toasts = ((globalThis as any).__capturedToasts ?? []) as any[];
  assert(
    toasts.some((t) => String(t.title ?? "") === "Now company-wide"),
    `confirm must toast the scope flip — saw ${JSON.stringify(toasts.map((t) => t.title))}`,
  );
  console.log("  ✓ Confirm applied the flip via PUT");

  // — Scenario D (Task #4235): a FAILING PUT toasts destructive "Failed",
  //   the dialog still closes via onSettled, and the select keeps the old
  //   server value (no pretend-success). —
  console.log("— Scenario D: failing PUT raises the destructive Failed toast, select unchanged —");
  const toastsBeforeFail = (((globalThis as any).__capturedToasts ?? []) as any[]).length;
  const putsBeforeFail = putCalls.length;
  failNextPut = true;
  await pickScopeOption(DEPT.id, "company");
  assert($("dialog-scope-confirm") !== null, "re-picking must re-open the dialog before the failing Confirm");
  await clickById("button-scope-confirm");
  await flush(8);
  assert(
    putCalls.length === putsBeforeFail + 1,
    `failing Confirm must still fire exactly one PUT — saw ${putCalls.length - putsBeforeFail}`,
  );
  const failToasts = (((globalThis as any).__capturedToasts ?? []) as any[]).slice(toastsBeforeFail);
  const failed = failToasts.find((t) => String(t.title ?? "") === "Failed");
  assert(
    failed,
    `failing PUT must raise the "Failed" toast — saw ${JSON.stringify(failToasts.map((t) => t.title))}`,
  );
  assert(
    failed.variant === "destructive",
    `the Failed toast must be destructive — got variant "${failed.variant}"`,
  );
  assert(
    !failToasts.some((t) => String(t.title ?? "") === "Now company-wide" || String(t.title ?? "") === "Now per-client"),
    `a failing PUT must raise NO success toast — saw ${JSON.stringify(failToasts.map((t) => t.title))}`,
  );
  assert($("dialog-scope-confirm") === null, "the dialog must close via onSettled even when the PUT fails");
  const afterFail = scopeTriggerText(DEPT.id);
  assert(
    afterFail === initialText,
    `after a failed PUT the select must stay on the old server value — was "${initialText}", now "${afterFail}"`,
  );
  console.log("  ✓ Failing PUT surfaced the destructive toast and kept the old scope");

  await act(async () => {
    root!.unmount();
  });
  queryClient.clear();
  console.log("\nsd-scope-dialog-cancel-confirm: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
