/* test-registration
{
  "name": "ClickUp Epic 14 UI — People plan banner + sections, Shared empty/rows, AccessPanel caveat, SharingDialog cost gate (Task #3052)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3052: ClickUp Epic 14 tabs UI smoke. Mounts the REAL ClickUpModule in jsdom (inline Radix select/dialog shims) with a mocked connected workspace and asserts the People plan banner + Members/Roles/Groups pills, Shared empty-state and task rows, the AccessPanel inherited-access caveat with a list selected, and the SharingDialog cost-warning checkbox gating Apply. DB-free, network-free (stubbed fetch), fast.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/clickup-epic14-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3052 — Epic 14 UI smoke test: ClickUp Access, People and Shared tabs.
 *
 * Epic 14 added three tabs (Access, People, Shared) and four sub-sections
 * (Members, Custom Roles, User Groups, SharingDialog) to ClickUpModule with
 * no automated coverage. This smoke test mounts the REAL ClickUpModule with
 * a mocked connected status + workspace selection and verifies:
 *
 *   1. People tab — the plan banner renders (plan name from the /plan
 *      endpoint, seat counts from /seats) and the three section pills
 *      (Members / Custom Roles / User Groups) render.
 *   2. Shared tab — the empty state renders when /shared is empty, and a
 *      task row renders when /shared returns a task.
 *   3. Access tab — with a list selected via the sidebar, the AccessPanel
 *      renders with the inherited-access caveat note.
 *   4. SharingDialog — the cost-warning checkbox gates the Apply button:
 *      disabled until checked, enabled after.
 *
 * Radix Select (workspace picker) and Radix Dialog (SharingDialog) never
 * mount under the raw jsdom harness, so both are shimmed inline via the
 * resolve hook in `clickup-epic14-loader.mjs`
 * (--import ./tests/client/clickup-epic14-setup.mjs).
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/admin/clickup" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
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
(dom.window.HTMLElement.prototype as any).hasPointerCapture =
  (dom.window.HTMLElement.prototype as any).hasPointerCapture || function () { return false; };
(dom.window.HTMLElement.prototype as any).releasePointerCapture =
  (dom.window.HTMLElement.prototype as any).releasePointerCapture || function () {};
(dom.window.HTMLElement.prototype as any).setPointerCapture =
  (dom.window.HTMLElement.prototype as any).setPointerCapture || function () {};
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
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
(globalThis as any).confirm = () => true;
(dom.window as any).confirm = () => true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Fetch stub
// ---------------------------------------------------------------------------

const ADMIN_USER = {
  id: "admin-3052",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};

const STATUS_PAYLOAD = {
  connected: true,
  user: { username: "nobull-ops", email: "ops@example.com", profilePicture: null },
  workspaces: [{ id: "ws1", name: "Main Workspace", color: null }],
};

// Shared tab payload is swappable between scenarios (fresh QueryClient per
// mount, so no cache carry-over).
let sharedOverride: { tasks: any[]; lists: any[]; folders: any[] } = {
  tasks: [],
  lists: [],
  folders: [],
};

const INHERITED_NOTE =
  "Members shown here have explicit access; others may inherit access from the parent Space or Folder.";

const aclCalls: Array<{ url: string; body: any }> = [];

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: ADMIN_USER },
    { path: "/api/integrations/clickup/status", json: STATUS_PAYLOAD },
    {
      path: "/api/clickup/workspaces/ws1/spaces",
      json: { spaces: [{ id: "sp1", name: "Space One", archived: false }] },
    },
    { path: "/api/clickup/spaces/sp1/folders", json: { folders: [] } },
    {
      path: "/api/clickup/spaces/sp1/lists",
      json: { lists: [{ id: "li1", name: "List One" }] },
    },
    { path: "/api/clickup/workspaces/ws1/plan", json: { plan: "Business" } },
    {
      path: "/api/clickup/workspaces/ws1/seats",
      json: {
        members: { filled: 5, total: 10 },
        guests: { filled: 1, total: 5 },
      },
    },
    { path: "/api/clickup/workspaces/ws1/shared", json: () => sharedOverride },
    {
      path: "/api/clickup/lists/li1/members",
      json: { members: [], inheritedNote: INHERITED_NOTE },
    },
    {
      method: "POST",
      path: "/api/clickup/workspaces/ws1/acl",
      respond: ({ url, init }: any) => {
        aclCalls.push({ url, body: JSON.parse(init?.body ?? "{}") });
        return { status: 200, json: { ok: true } };
      },
    },
  ],
  defaultJson: {},
});

// ---------------------------------------------------------------------------
// Imports — after jsdom globals + fetch shim are set up
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const ClickUpModuleMod = await import("../../client/src/pages/admin/ClickUpModule");
const ClickUpModule = ClickUpModuleMod.default as any;

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

function makeClient(): InstanceType<typeof QueryClient> {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 5 * 60 * 1000 },
    },
  });
}

async function mount(node: any): Promise<Root> {
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(node);
  });
  await flush();
  return root!;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

// Radix TabsTrigger (and plain buttons) — dispatch the full gesture so
// React's synthetic-event tree sees what a real user would produce.
async function press(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
    );
    el.dispatchEvent(
      new dom.window.MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }),
    );
    el.click();
  });
  await flush(8);
}

// Mount the full module and pick the ws1 workspace via the shimmed inline
// Select (items render inline as role=option divs with the real testids).
async function mountModuleWithWorkspace(): Promise<Root> {
  const qc = makeClient();
  const root = await mount(
    React.createElement(QueryClientProvider, { client: qc }, React.createElement(ClickUpModule)),
  );
  assert($("page-clickup-module") !== null, "connected ClickUpModule shell must render");
  const wsOption = $("option-workspace-ws1");
  assert(wsOption !== null, "workspace option ws1 must render (inline select shim)");
  await press(wsOption!);
  assert($("sidebar-nav") !== null, "sidebar must render once a workspace is selected");
  return root;
}

// ---------------------------------------------------------------------------
// Scenario 1: People tab — plan banner + the three section pills.
// ---------------------------------------------------------------------------

async function scenario1_peopleTab(): Promise<void> {
  console.log("\n— Scenario 1: People tab renders plan banner + section pills —");
  const root = await mountModuleWithWorkspace();
  try {
    const tab = $("tab-people");
    assert(tab !== null, "tab-people trigger must render");
    await press(tab!);

    assert($("panel-people") !== null, "PeoplePanel must mount on the People tab");

    const planName = $("plan-name");
    assert(planName !== null, "plan banner (plan-name) must render");
    assert(
      planName!.textContent?.includes("Business plan") === true,
      `plan banner must show 'Business plan' from the /plan endpoint (got '${planName!.textContent}')`,
    );
    const memberSeats = $("member-seats");
    assert(
      memberSeats !== null && memberSeats.textContent?.includes("5/10") === true,
      `member seats must render 5/10 from the /seats endpoint (got '${memberSeats?.textContent}')`,
    );
    console.log("  ✓ plan banner shows the plan name + seat counts");

    for (const s of ["members", "roles", "groups"]) {
      assert($(`people-section-${s}`) !== null, `section pill people-section-${s} must render`);
    }
    console.log("  ✓ Members / Custom Roles / User Groups pills all render");

    // Default section is Members with its inherited-access guidance.
    assert($("section-members") !== null, "Members section must be the default");
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: Shared tab — empty state, then a populated task row.
// ---------------------------------------------------------------------------

async function scenario2_sharedTab(): Promise<void> {
  console.log("\n— Scenario 2: Shared tab renders empty state and task rows —");

  // 2a: empty payload → empty state.
  sharedOverride = { tasks: [], lists: [], folders: [] };
  let root = await mountModuleWithWorkspace();
  try {
    await press($("tab-shared")!);
    assert($("shared-empty") !== null, "Shared tab must render the empty state when nothing is shared");
    console.log("  ✓ empty state renders when /shared returns no items");
  } finally {
    await unmount(root);
  }

  // 2b: a shared task → panel with a task row (fresh mount = fresh cache).
  sharedOverride = {
    tasks: [{ id: "t1", name: "Shared task one", status: { status: "open" }, url: null }],
    lists: [],
    folders: [],
  };
  root = await mountModuleWithWorkspace();
  try {
    await press($("tab-shared")!);
    assert($("panel-shared") !== null, "Shared panel must render when items exist");
    const row = $("shared-task-t1");
    assert(row !== null, "shared task row shared-task-t1 must render");
    assert(
      row!.textContent?.includes("Shared task one") === true,
      `shared task row must show the task name (got '${row!.textContent}')`,
    );
    console.log("  ✓ a shared task row renders with its name");
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 3: Access tab (list selected) — AccessPanel + inherited caveat.
// Scenario 4: SharingDialog — cost-warning checkbox gates Apply.
// ---------------------------------------------------------------------------

async function scenario3and4_accessTabAndSharingDialog(): Promise<void> {
  console.log("\n— Scenario 3: Access tab renders AccessPanel with the inherited-access caveat —");
  const root = await mountModuleWithWorkspace();
  try {
    // The Access tab is disabled until a list is selected via the sidebar.
    const accessTab = $("tab-access");
    assert(accessTab !== null, "tab-access trigger must render");
    assert(
      accessTab!.hasAttribute("disabled") || accessTab!.getAttribute("data-disabled") !== null,
      "Access tab must be disabled before a list is selected",
    );

    // Expand the space, then select its list.
    await press($("nav-space-sp1")!);
    const listBtn = $("nav-list-li1");
    assert(listBtn !== null, "nav-list-li1 must render under the expanded space");
    await press(listBtn!);

    await press($("tab-access")!);
    assert($("panel-access") !== null, "AccessPanel must mount on the Access tab once a list is selected");
    assert($("access-empty") !== null, "AccessPanel must render the no-explicit-members empty state");

    const accessPanel = $("panel-access")!;
    assert(
      accessPanel.textContent?.includes("inherit") === true,
      "AccessPanel must render the inherited-access caveat note from the /members payload",
    );
    console.log("  ✓ AccessPanel renders with the inherited-access caveat");

    console.log("\n— Scenario 4: SharingDialog cost-warning checkbox gates the Apply button —");
    await press($("button-open-sharing")!);

    // The dialog defaults to "Make private" ON; the cost checkbox only
    // renders when the toggle moves toward public (Task #3051 behavior).
    assert(
      $("checkbox-cost-confirm") === null,
      "cost-confirm checkbox must be hidden while the item stays private",
    );
    const privacySwitch = $("switch-make-private");
    assert(privacySwitch !== null, "SharingDialog make-private switch must render");
    await press(privacySwitch!);

    const applyBtn = $("button-apply-acl") as HTMLButtonElement | null;
    const checkbox = $("checkbox-cost-confirm") as HTMLInputElement | null;
    assert(applyBtn !== null, "SharingDialog Apply button must render (inline dialog shim)");
    assert(checkbox !== null, "SharingDialog cost-confirm checkbox must render after toggling toward public");
    assert(applyBtn!.disabled === true, "Apply must be DISABLED while the cost warning is unchecked");
    console.log("  ✓ Apply is blocked before the cost warning is acknowledged");

    // Confirm clicking disabled Apply does nothing.
    await press(applyBtn!);
    assert(aclCalls.length === 0, "clicking the disabled Apply button must not call the ACL endpoint");

    await act(async () => {
      checkbox!.click();
    });
    await flush(4);
    assert(checkbox!.checked === true, "checkbox must become checked after click");
    assert(
      ($("button-apply-acl") as HTMLButtonElement).disabled === false,
      "Apply must be ENABLED once the cost warning is checked",
    );
    console.log("  ✓ Apply unlocks after the checkbox is checked");
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

let failed = false;
try {
  await scenario1_peopleTab();
  await scenario2_sharedTab();
  await scenario3and4_accessTabAndSharingDialog();
} catch (err) {
  failed = true;
  console.error("\n✗ clickup-epic14-people-shared-access FAILED:", err);
}

if (!failed) {
  console.log("\nclickup-epic14-people-shared-access: all scenarios passed");
}
process.exit(failed ? 1 : 0);
