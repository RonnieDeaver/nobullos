/* test-registration
{
  "name": "ClientDetail Command Panel client-information edit path — hydration, PATCH refresh, empty/read-only states (Task #5224)",
  "regression": true,
  "smoke": true,
  "smokeReason": "The in-context Client Information action is the operator-facing path to the existing client editor. This DB-free component mount pins role visibility, current-value hydration, Consult Type + multi-select Practice Areas PATCH serialization, summary refetch, and explicit empty states so the shortcut cannot silently diverge from the page-header editor.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/client-detail-command-panel-edit-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json",
    "NODE_ENV": "test"
  },
  "tier": "medium"
}
test-registration */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/clients/client-5224?tab=command-panel" },
);

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLDivElement: dom.window.HTMLDivElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  HTMLFormElement: dom.window.HTMLFormElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  DocumentFragment: dom.window.DocumentFragment,
  ShadowRoot: dom.window.ShadowRoot,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  MutationObserver: dom.window.MutationObserver,
  DOMRect: dom.window.DOMRect,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  localStorage: dom.window.localStorage,
  location: dom.window.location,
  history: dom.window.history,
  addEventListener: dom.window.addEventListener.bind(dom.window),
  removeEventListener: dom.window.removeEventListener.bind(dom.window),
  dispatchEvent: dom.window.dispatchEvent.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});

(dom.window as any).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;
(dom.window as any).ResizeObserver = ResizeObserverStub;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const CLIENT_ID = "client-5224";
const CEO_USER = {
  id: "user-5224",
  email: "operator@test.local",
  firstName: "Op",
  lastName: "Erator",
  role: "ceo",
};

const BASE_CLIENT = {
  id: CLIENT_ID,
  clientCode: "C-5224",
  firmName: "Hydrated Law",
  contactName: "Pat Partner",
  contactEmail: "pat@hydrated.test",
  contactPhone: null,
  consultType: "paid",
  practiceAreas: ["Personal Injury"],
  products: [],
  ownerId: null,
  averageCaseValue: 0,
  monthlyReviewTarget: 0,
  initialLeads: 0,
  initialReviews: 0,
  initialCases: 0,
  stripeCustomerId: null,
  isArchived: false,
  isDemo: false,
  clientStartDate: null,
  hasPostConsultReviewAccess: false,
  hasPostCaseClosedReviewAccess: false,
  hideOtherLeads: false,
  terminology: null,
  emailDomains: [],
};

const PANEL = {
  id: "panel-5224",
  clientId: CLIENT_ID,
  productTypes: [],
  priorityMarkets: [],
  secondaryMarkets: [],
  externalSystemLinks: [],
  lastReviewedAt: new Date().toISOString(),
  lastReviewedBy: CEO_USER.id,
};

let servedClient = { ...BASE_CLIENT };
const patchBodies: Array<Record<string, unknown>> = [];

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      method: "PATCH",
      test: (url: string) => url.endsWith(`/api/clients/${CLIENT_ID}`),
      respond: ({ init }: any) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        patchBodies.push(body);
        servedClient = { ...servedClient, ...body };
        return { status: 200, json: servedClient };
      },
    },
    { path: "/api/auth/user", json: CEO_USER },
    {
      test: (url: string) => url.includes(`/api/clients/${CLIENT_ID}/summary`),
      json: () => ({
        client: servedClient,
        reports: [],
        dataAccess: [],
        contacts: [],
        offboarding: null,
      }),
    },
    { path: `/api/clients/${CLIENT_ID}/command-panel/unmatched-zoom`, json: [] },
    { path: `/api/clients/${CLIENT_ID}/command-panel/history`, json: [] },
    { path: `/api/clients/${CLIENT_ID}/command-panel/key-calls`, json: [] },
    { path: `/api/clients/${CLIENT_ID}/command-panel/rer-recordings`, json: [] },
    { path: `/api/clients/${CLIENT_ID}/command-panel`, json: PANEL },
    { path: `/api/clients/${CLIENT_ID}/locations/audit`, json: [] },
    { path: `/api/clients/${CLIENT_ID}/locations`, json: [] },
    { path: `/api/clients/${CLIENT_ID}/contacts/audit`, json: [] },
    { path: `/api/clients/${CLIENT_ID}/contacts`, json: [] },
    { path: `/api/clients/${CLIENT_ID}/communications`, json: [] },
    { path: `/api/clients/${CLIENT_ID}/data-access`, json: [] },
    { path: `/api/clients/${CLIENT_ID}/pandadoc-documents`, json: [] },
    { path: "/api/import-suggestions", json: { items: [] } },
    { path: "/api/users", json: [CEO_USER] },
    { path: "/api/audit-history", json: {} },
    { path: "/api/clients", json: [] },
    { path: "/api/notifications", json: [] },
  ],
  defaultJson: {},
});

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { getQueryFn } = await import("../../client/src/lib/queryClient");
const { Router, Route } = await import("wouter");
const ClientDetail = (await import("../../client/src/pages/ClientDetail")).default;
const CommandPanel = (await import("../../client/src/components/CommandPanel")).default;

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        queryFn: getQueryFn({ on401: "throw" }),
        retry: false,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}

async function flush(times = 28): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function mount(element: React.ReactElement, queryClient: InstanceType<typeof QueryClient>): Promise<Root> {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(QueryClientProvider, { client: queryClient }, element));
  });
  await flush();
  return root!;
}

async function unmount(root: Root, queryClient: InstanceType<typeof QueryClient>): Promise<void> {
  await act(async () => root.unmount());
  queryClient.clear();
}

async function scenarioEditableFlow(): Promise<void> {
  console.log("\n— light desktop: editable client-information path hydrates, saves, and refreshes —");
  document.documentElement.classList.remove("dark");
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 1280 });
  servedClient = { ...BASE_CLIENT };
  patchBodies.length = 0;
  const queryClient = makeQueryClient();
  const root = await mount(
    React.createElement(
      Router,
      null,
      React.createElement(Route, {
        path: "/clients/:id",
        component: ClientDetail,
      }),
    ),
    queryClient,
  );

  try {
    assert($("button-edit-client") !== null, "the existing page-header Edit action must remain");
    assert($("button-edit-client-details") !== null, "editable users must see Edit client details");
    assert($("card-client-info-context")?.className.includes("bg-surface-warm-1"), "light view keeps the tokenized Client Information surface");
    assert($("text-client-consult-type")?.textContent?.trim() === "paid", "read view starts with Paid");
    assert(document.body.textContent?.includes("Personal Injury"), "read view starts with Personal Injury");

    await click($("button-edit-client-details")!);
    const paidOption = document.querySelector('[data-select-item-value="paid"]');
    assert($("select-consult-type")?.textContent?.trim() === "paid", "current Consult Type hydrates as paid");
    assert(paidOption !== null, "interactive Consult Type options render");
    assert(
      ($("checkbox-practice-area-personal-injury") as HTMLInputElement | null)?.checked === true,
      "current Practice Area hydrates as selected",
    );

    await click(document.querySelector('[data-select-item-value="free"]')!);
    await click($("checkbox-practice-area-personal-injury")!);
    await click($("checkbox-practice-area-family-law")!);

    const saveButton = $("button-save-client");
    assert(saveButton !== null, "existing Edit Client save button remains");
    const form = saveButton.closest("form");
    assert(form !== null, "save button remains in the existing Edit Client form");
    await act(async () => {
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush(45);

    assert(patchBodies.length === 1, `one PATCH expected, got ${patchBodies.length}`);
    assert(patchBodies[0].consultType === "free", "PATCH carries changed Consult Type");
    assert(
      JSON.stringify(patchBodies[0].practiceAreas) === JSON.stringify(["Family Law"]),
      `PATCH carries changed multi-select Practice Areas, got ${JSON.stringify(patchBodies[0].practiceAreas)}`,
    );
    assert($("text-client-consult-type")?.textContent?.trim() === "free", "refetched panel shows Free");
    assert(document.body.textContent?.includes("Family Law"), "refetched panel shows Family Law");
    assert(!document.body.textContent?.includes("Personal Injury"), "removed Practice Area leaves the read view");
    console.log("  ✓ shared dialog + PATCH + summary refetch update the Command Panel");
  } finally {
    await unmount(root, queryClient);
  }
}

async function scenarioReadOnlyEmptyState(): Promise<void> {
  console.log("\n— dark mobile: read-only users see explicit empty states without an edit action —");
  document.documentElement.classList.add("dark");
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 375 });
  const queryClient = makeQueryClient();
  let editCalls = 0;
  const root = await mount(
    React.createElement(CommandPanel as any, {
      clientId: CLIENT_ID,
      client: { ...BASE_CLIENT, consultType: null, practiceAreas: [] },
      currentUser: { ...CEO_USER, role: "sales" },
      allUsers: [],
      onEditClient: () => { editCalls += 1; },
      primaryReady: true,
    }),
    queryClient,
  );

  try {
    assert($("button-edit-client-details") === null, "read-only users must not see Edit client details");
    assert(document.documentElement.classList.contains("dark"), "dark-theme class remains active for the mobile render");
    assert($("card-client-info-context")?.querySelector(".flex-wrap") !== null, "mobile header keeps its wrap affordance");
    assert($("text-client-consult-type")?.textContent?.trim() === "No consult type selected", "unset Consult Type stays visible");
    assert($("text-client-practice-areas-empty")?.textContent?.trim() === "No practice areas selected", "unset Practice Areas stays visible");
    assert(editCalls === 0, "hidden edit action cannot invoke the editor");
    console.log("  ✓ explicit empty states remain visible and editing stays hidden");
  } finally {
    await unmount(root, queryClient);
  }
}

async function main(): Promise<void> {
  await scenarioEditableFlow();
  await scenarioReadOnlyEmptyState();
  console.log("\nclient-detail-command-panel-edit: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });