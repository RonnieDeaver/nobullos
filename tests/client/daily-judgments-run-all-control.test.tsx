/* test-registration
{
  "name": "Daily judgments run-all control — confirmation and feedback",
  "regression": true,
  "smoke": true,
  "smokeReason": "The CEO-only portfolio action must stay deliberate: this deterministic UI test locks visible scope, cancel-without-POST, confirmed POST, actual success feedback, and destructive request-failure feedback.",
  "extraNodeArgs": [
    "--import",
    "./tests/daily-judgments-run-all-control-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small",
  "tierReason": "The mechanical source-size classifier counts jsdom harness setup, while the test performs two bounded UI scenarios with no database, network, or browser process."
}
test-registration */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(dom.window as any).matchMedia = () => ({
  matches: false, media: "", onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
});
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const STATUSES = { actions: [], active: [], completed: [], selfHealEnabled: false, selfHealLastRun: null };
let startStatus = 200;
let startBody: any = { message: "Daily judgment generation started for 12 active clients" };
let startRequests = 0;

const fetchHandler = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      method: "POST",
      path: "/api/admin/daily-judgments/run-all",
      respond: () => {
        startRequests += 1;
        return { status: startStatus, json: startBody };
      },
    },
    { path: "/api/admin/prod-actions/runs", json: { runs: [] } },
    { path: "/api/admin/prod-actions", json: STATUSES },
  ],
  defaultJson: {},
});

const React = (await import("react")).default ?? (await import("react"));
(globalThis as any).React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const { ProdActionsPanel } = await import("../../client/src/components/admin/ProdActionsPanel");
const { useToast } = await import("../../client/src/hooks/use-toast");

(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  return fetchHandler(url, init);
};

let lastToast: { title?: unknown; description?: unknown; variant?: unknown } | null = null;
function ToastRecorder(): null {
  const { toasts } = (useToast as any)();
  if (toasts?.[0]) lastToast = toasts[0];
  return null;
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function click(testId: string): Promise<void> {
  const element = $(testId);
  assert(element, `expected ${testId} to exist`);
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function mount(): Promise<Root> {
  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(ProdActionsPanel as any),
        React.createElement(ToastRecorder as any),
      ),
    );
  });
  await flush();
  await click("header-prod-actions-toggle");
  return root;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => root.unmount());
  queryClient.clear();
  lastToast = null;
  document.getElementById("root")!.replaceChildren();
}

async function main(): Promise<void> {
  console.log("Daily judgments run-all control");

  startStatus = 200;
  startBody = { message: "Daily judgment generation started for 12 active clients" };
  startRequests = 0;
  let root = await mount();
  try {
    assert($("button-daily-judgments-run-all"), "CEOs must see the portfolio ratings control");
    await click("button-daily-judgments-run-all");
    assert($("dialog-daily-judgments-run-all-confirm"), "the action must require confirmation");
    assert(
      $("text-daily-judgments-run-all-scope")?.textContent?.includes("every active client"),
      "the confirmation must state the full active-client scope",
    );
    await click("button-daily-judgments-run-all-cancel");
    assert(!$("dialog-daily-judgments-run-all-confirm"), "Cancel must close the confirmation");
    assert(startRequests === 0, "Cancel must not send a portfolio-wide request");

    await click("button-daily-judgments-run-all");
    await click("button-daily-judgments-run-all-confirm");
    assert(startRequests === 1, "Confirm must POST exactly once");
    assert(lastToast?.title === "Client ratings started", "success feedback must name the started ratings");
    assert(
      lastToast?.description === "Daily judgment generation started for 12 active clients",
      "success feedback must surface the actual response message",
    );
    console.log("  ✓ scope, cancel, confirmed POST, and response feedback");
  } finally {
    await unmount(root);
  }

  startStatus = 503;
  startBody = { message: "Daily judgments are temporarily unavailable" };
  root = await mount();
  try {
    await click("button-daily-judgments-run-all");
    await click("button-daily-judgments-run-all-confirm");
    assert(lastToast?.title === "Could not start client ratings", "failure feedback must name the failed action");
    assert(lastToast?.variant === "destructive", "request failures must use destructive feedback");
    assert(
      String(lastToast?.description).includes("Daily judgments are temporarily unavailable"),
      "failure feedback must surface the actual request error",
    );
    console.log("  ✓ request failure has destructive feedback");
  } finally {
    await unmount(root);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });