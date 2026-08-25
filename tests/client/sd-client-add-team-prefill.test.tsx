/* test-registration
{
  "name": "Add Client role assignments card — pre-filled inherited defaults, editable selects, POST body, partial-seed warning toast",
  "regression": true,
  "smoke": true,
  "smokeReason": "The Add Client role-assignment card needs mount coverage so option-query, inherited-default copy, and selection regressions cannot ship while route tests stay green. Fast, DB-free, network-stubbed jsdom render test.",
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
 * Task #4174 — mount coverage for the Add Client "Team assignments" card
 * (Task #4171, client/src/pages/ClientAdd.tsx).
 *
 * Server behavior is pinned by tests/sd-client-creation-team-seed.test.ts;
 * this pins what the operator actually sees and sends:
 *
 *   A. One card per client-facing department with a Doer select and only a
 *      capability-approved Checker select. Each
 *      supported select is pre-selected on the "<default person's name>
 *      (inherited default)" sentinel (or
 *      "No default — unassigned" when the department has no default).
 *   B. Changing selects updates the POST /api/clients body: only touched
 *      departments ride along in `teamAssignments`, an explicit member pick
 *      sends the user id, "None" sends null, untouched roles are omitted.
 *   C. A create response carrying `teamAssignmentWarning` raises the
 *      destructive "Team assignments not saved" toast (partial seed), while a
 *      clean response raises only the success toast.
 *
 * Radix Select never portals in raw jsdom, and this test must PICK options,
 * so the interactive select shim is wired via tests/client/sd-team-ui-setup.mjs.
 */

import { JSDOM } from "jsdom";
import { createFetchStub, createJsonResponse } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/clients/new" },
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

const USER = { id: "u-op", email: "op@example.com", firstName: "Op", lastName: "Erator", role: "ceo" };

const DEPT_SEO = {
  // Owner-approved Paid Search UUID: Checker must be available.
  id: "d04fc82e-a7c4-48ad-9e22-1d51830f6479",
  name: "Paid Search",
  sortOrder: 1,
  roleCapabilities: { doer: true, checker: true },
  defaultPrimaryUserId: "u1",
  defaultCheckerUserId: "u2",
};
const DEPT_INTAKE = {
  // Owner-approved GBP / Local SEO UUID: Checker must also be available.
  id: "4d2e06d4-b935-468b-a204-630964e151bc",
  name: "GBP / Local SEO",
  sortOrder: 2,
  roleCapabilities: { doer: true, checker: true },
  defaultPrimaryUserId: "u3",
  defaultCheckerUserId: null,
};
const DEPT_NEW = {
  // A new department is intentionally not capability-approved: default deny.
  id: "dept-new-default-deny",
  name: "New Department",
  sortOrder: 3,
  roleCapabilities: { doer: true, checker: false },
  defaultPrimaryUserId: "u3",
  defaultCheckerUserId: "u3",
};
const TEAM_OPTIONS = {
  departments: [DEPT_SEO, DEPT_INTAKE, DEPT_NEW],
  membersByDept: {
    [DEPT_SEO.id]: [
      { id: "u1", name: "Alice Doe" },
      { id: "u2", name: "Bob Roe" },
    ],
    [DEPT_INTAKE.id]: [{ id: "u3", name: "Cara Poe" }],
    [DEPT_NEW.id]: [{ id: "u3", name: "Cara Poe" }],
  },
};

// Set per scenario: when non-null, the create response carries this
// teamAssignmentWarning (the server's partial-seed path).
let warningToReturn: string | null = null;
let createBodies: any[] = [];

const jsonResponse = createJsonResponse(dom.window.Headers) as (status: number, body: any) => Response;

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      method: "POST",
      test: (url: string) => /\/api\/clients$/.test(url),
      respond: ({ init }: any) => {
        let parsed: any = null;
        try {
          parsed = init?.body ? JSON.parse(String(init.body)) : null;
        } catch {
          parsed = null;
        }
        createBodies.push(parsed);
        const body: any = { id: "client-4174", firmName: parsed?.firmName ?? null };
        if (warningToReturn) body.teamAssignmentWarning = warningToReturn;
        return jsonResponse(201, body);
      },
    },
    {
      method: "PUT",
      test: (url: string) => /\/api\/clients\/[^/]+\/data-access\/[^/?]+$/.test(url),
      json: { ok: true },
    },
    { path: "/api/auth/user", json: USER },
    { path: "/api/service-desk/client-team-options", json: TEAM_OPTIONS },
    { path: "/api/clients", json: [] },
    { path: "/api/users", json: [USER] },
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
const ClientAdd = (await import("../../client/src/pages/ClientAdd")).default;

// Every toast() call is captured by the use-toast stub (see
// tests/dashboard-toast-stub-loader.mjs, registered in sd-team-ui-setup.mjs):
// TOAST_LIMIT = 1 means the warning toast is replaced by the success toast in
// the same synchronous onSuccess, so a render-time recorder would miss it.
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
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush(4);
}

async function clickById(testId: string): Promise<void> {
  const el = $(testId);
  assert(el !== null, `expected [data-testid="${testId}"] to exist before click`);
  await clickEl(el!);
}

async function setInputValue(testId: string, value: string): Promise<void> {
  const el = $(testId) as HTMLInputElement | null;
  assert(el !== null, `input [data-testid="${testId}"] must be in the DOM`);
  await act(async () => {
    const proto = Object.getPrototypeOf(el!);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else (el as any).value = value;
    el!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    el!.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  await flush(2);
}

// The interactive select shim mounts each Select's listbox inline next to its
// trigger, so options are scoped by walking up from the trigger.
function selectOptions(triggerTestId: string): HTMLElement[] {
  const trigger = $(triggerTestId);
  assert(trigger !== null, `select trigger [data-testid="${triggerTestId}"] must render`);
  const scope = trigger!.parentElement!;
  return Array.from(scope.querySelectorAll('[role="option"]')) as HTMLElement[];
}

// The shim's Trigger contains the SelectValue span, which renders the current
// raw value (sentinel/user id/none) — i.e. the SELECTED state, not the options.
function selectedValueOf(triggerTestId: string): string {
  const trigger = $(triggerTestId);
  assert(trigger !== null, `select trigger [data-testid="${triggerTestId}"] must render`);
  return (trigger!.textContent ?? "").trim();
}

async function pickOption(triggerTestId: string, value: string): Promise<void> {
  const opt = selectOptions(triggerTestId).find(
    (o) => o.getAttribute("data-select-item-value") === value,
  );
  assert(opt, `select ${triggerTestId} must offer an option with value "${value}"`);
  await clickEl(opt!);
}

async function mountPage(): Promise<Root> {
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  dom.window.history.replaceState({}, "", "/clients/new");
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(ClientAdd as any),
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
  createBodies = [];
  (globalThis as any).__capturedToasts = [];
}

async function submitForm(): Promise<void> {
  const submitBtn = $("button-submit-client");
  assert(submitBtn !== null, "submit button must render");
  const form = submitBtn!.closest("form");
  assert(form !== null, "submit button must live inside the create form");
  await act(async () => {
    form!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
}

// Fill the minimum the create gate requires: firm name + one product.
async function fillRequiredFields(firm: string): Promise<void> {
  await setInputValue("input-firm-name", firm);
  await clickById("checkbox-product-gbp");
}

// ---------------------------------------------------------------------------
// Scenario A: supported pre-filled defaults render.
// ---------------------------------------------------------------------------

async function scenarioPrefill(): Promise<void> {
  console.log("\n— Scenario A: team card renders dept × role selects with default names —");
  warningToReturn = null;
  const root = await mountPage();
  try {
    for (const dept of [DEPT_SEO, DEPT_INTAKE, DEPT_NEW]) {
      assert($(`team-dept-${dept.id}`) !== null, `team card for ${dept.name} must render`);
      for (const field of [
        "primaryUserId",
        ...(dept.roleCapabilities.checker ? ["checkerUserId"] : []),
      ]) {
        assert(
          $(`select-team-${dept.id}-${field}`) !== null,
          `${dept.name} must render a ${field} select`,
        );
      }
    }

    // Every select must START on the `__default__` sentinel — the pre-fill
    // itself. (The interactive select shim's Trigger renders the current raw
    // value, so the trigger text IS the selected value.) A regression that
    // mounted the selects blank or on "None" would fail here even if the
    // sentinel option still existed in the listbox.
    for (const dept of [DEPT_SEO, DEPT_INTAKE, DEPT_NEW]) {
      for (const field of [
        "primaryUserId",
        ...(dept.roleCapabilities.checker ? ["checkerUserId"] : []),
      ]) {
        const sel = selectedValueOf(`select-team-${dept.id}-${field}`);
        assert(
          sel === "__default__",
          `${dept.name} ${field} select must be pre-selected on the default sentinel (got "${sel}")`,
        );
      }
    }

    // The sentinel option carries the default person's NAME (the point of the
    // pre-fill), or the explicit no-default copy when the slot has none.
    const textOfSentinel = (triggerId: string) => {
      const opt = selectOptions(triggerId).find(
        (o) => o.getAttribute("data-select-item-value") === "__default__",
      );
      assert(opt, `${triggerId} must offer the default sentinel option`);
      return opt!.textContent ?? "";
    };
    assert(
      textOfSentinel(`select-team-${DEPT_SEO.id}-primaryUserId`).includes("Alice Doe (inherited default)"),
      "SEO Doer sentinel must name the default person",
    );
    assert(
      textOfSentinel(`select-team-${DEPT_SEO.id}-checkerUserId`).includes("Bob Roe (inherited default)"),
      "SEO Checker sentinel must name the default person",
    );
    assert(
      textOfSentinel(`select-team-${DEPT_INTAKE.id}-primaryUserId`).includes("Cara Poe (inherited default)"),
      "Intake Doer sentinel must name the default person",
    );
    assert(
      $("select-team-dept-new-default-deny-checkerUserId") === null,
      "a new, unapproved department must omit the unsupported Checker select even when legacy data has a checker default",
    );

    // Members are offered as explicit picks alongside sentinel + None.
    const seoDoerValues = selectOptions(`select-team-${DEPT_SEO.id}-primaryUserId`).map((o) =>
      o.getAttribute("data-select-item-value"),
    );
    for (const v of ["__default__", "__none__", "u1", "u2"]) {
      assert(seoDoerValues.includes(v), `SEO Doer select must offer "${v}" (got ${seoDoerValues})`);
    }
    console.log("  ✓ supported role selects render pre-filled");
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario B: touched selects ride the POST body; untouched depts are omitted.
// ---------------------------------------------------------------------------

async function scenarioMutationBody(): Promise<void> {
  console.log("\n— Scenario B: changed selects update the create POST body —");
  warningToReturn = null;
  const root = await mountPage();
  try {
    await fillRequiredFields("NoBull Team Law");
    // SEO: explicit checker pick + explicit "None" doer; Intake untouched.
    await pickOption(`select-team-${DEPT_SEO.id}-checkerUserId`, "u2");
    await pickOption(`select-team-${DEPT_SEO.id}-primaryUserId`, "__none__");
    // The picks must be reflected in the selects' selected state too.
    assert(
      selectedValueOf(`select-team-${DEPT_SEO.id}-checkerUserId`) === "u2",
      "picked checker must become the select's value",
    );
    assert(
      selectedValueOf(`select-team-${DEPT_SEO.id}-primaryUserId`) === "__none__",
      '"None" pick must become the select\'s value',
    );
    assert(
      selectedValueOf(`select-team-${DEPT_INTAKE.id}-primaryUserId`) === "__default__",
      "untouched selects stay on the default sentinel",
    );
    await submitForm();

    assert(createBodies.length === 1, `expected exactly one create POST, got ${createBodies.length}`);
    const sent = createBodies[0];
    assert(Array.isArray(sent?.teamAssignments), "POST body must carry teamAssignments");
    assert(
      sent.teamAssignments.length === 1 && sent.teamAssignments[0].departmentId === DEPT_SEO.id,
      `only the touched department rides along — got ${JSON.stringify(sent.teamAssignments)}`,
    );
    const seo = sent.teamAssignments[0];
    assert(seo.checkerUserId === "u2", `explicit pick must send the user id — got ${JSON.stringify(seo)}`);
    assert(seo.primaryUserId === null, `"None" must send an explicit null — got ${JSON.stringify(seo)}`);
    console.log("  ✓ POST body: touched dept only, id / null / omitted per pick state");
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario C: teamAssignmentWarning → destructive toast; clean create → none.
// ---------------------------------------------------------------------------

async function scenarioWarningToast(): Promise<void> {
  console.log("\n— Scenario C: partial-seed warning toast —");
  warningToReturn = "Client was created, but team assignments could not be saved.";
  const root = await mountPage();
  try {
    await fillRequiredFields("NoBull Warned Law");
    await submitForm();

    const warning = seenToasts().find((t) => String(t.title ?? "") === "Team assignments not saved");
    assert(warning, `a teamAssignmentWarning response must raise the warning toast — saw ${JSON.stringify(seenToasts().map((t) => t.title))}`);
    assert(warning!.variant === "destructive", "warning toast must be the destructive variant");
    assert(
      String(warning!.description ?? "").includes("could not be saved"),
      "warning toast must carry the server's warning copy",
    );
    assert(
      seenToasts().some((t) => String(t.title ?? "").includes("Client added")),
      "the create itself still succeeds (success toast also raised)",
    );
    console.log("  ✓ destructive warning toast + success toast");
  } finally {
    await unmount(root);
  }

  console.log("\n— Scenario C2: clean create raises no warning toast —");
  warningToReturn = null;
  const root2 = await mountPage();
  try {
    await fillRequiredFields("NoBull Clean Law");
    await submitForm();
    assert(
      !seenToasts().some((t) => String(t.title ?? "") === "Team assignments not saved"),
      "a clean create must NOT raise the warning toast",
    );
    assert(
      seenToasts().some((t) => String(t.title ?? "").includes("Client added")),
      "clean create must raise the success toast",
    );
    console.log("  ✓ clean create: success toast only");
  } finally {
    await unmount(root2);
  }
}

async function main(): Promise<void> {
  await scenarioPrefill();
  await scenarioMutationBody();
  await scenarioWarningToast();
  console.log("\nsd-client-add-team-prefill: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
