/* test-registration
{
  "name": "ClickUp Profile card setup notice — inline 503 notice + callback URL, persists, clears on 200 (Task #3400)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3400: ClickUp Profile card setup-notice UI smoke. Mounts the REAL ClickUpConnectionCard in jsdom with a stubbed fetch and asserts the persistent inline \"OAuth app not configured\" notice renders on an authorize 503 (with the copyable callback URL + both secret names, no \"Connection failed\" toast), persists across renders, and clears on a subsequent 200 authorize. DB-free, network-free, fast.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3400 — Profile ClickUp card: persistent inline "OAuth app not
 * configured" notice (Task #3385 behavior).
 *
 * The authorize endpoint answers 503 when the company-wide ClickUp OAuth
 * app secrets are missing. The card must render the persistent inline
 * notice (data-testid `notice-clickup-oauth-not-configured`) with the
 * copyable callback URL — NOT an auto-dismissing toast — and the notice
 * must clear on a subsequent successful (200) authorize attempt.
 *
 * Mounts the real `ClickUpConnectionCard` (client/src/pages/Profile.tsx)
 * with a stubbed `globalThis.fetch`:
 *   1. Cold mount, status = not connected → no notice, Connect button.
 *   2. Click Connect while authorize returns 503 → notice renders with
 *      the exact callback URL + copy button; Connect button stays usable.
 *   3. Notice persists across a re-render (it is not a transient toast).
 *   4. Swap authorize to 200 { url } and click Connect again → notice
 *      clears, and no "Connection failed" toast fired for the 503 path.
 *
 * Harness pattern: tests/client/integrations-hub-all-status-unknown.test.tsx.
 * Server-side authorize 503/200 contract coverage lives in
 * tests/clickup-oauth-flow.test.ts (Task #3386).
 *
 * Registered in tests/run-all.ts.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
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
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
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
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const STATUS_NOT_CONNECTED = {
  connected: false,
  clickupEmail: null,
  clickupUsername: null,
  workspaceId: null,
  status: "disconnected",
  lastError: null,
};

const EXPECTED_CALLBACK_URL = "http://localhost/api/integrations/clickup/callback";

// Mutable authorize behavior: the test flips this between the 503
// (not-configured) and 200 (configured) contracts.
let authorizeResponse: { status: number; json: unknown } = {
  status: 503,
  json: { error: "ClickUp OAuth app is not configured" },
};
let authorizeCalls = 0;

const fetchStub = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/integrations/clickup/status", json: STATUS_NOT_CONNECTED },
    {
      path: "/api/integrations/clickup/authorize",
      respond: () => {
        authorizeCalls++;
        return { status: authorizeResponse.status, json: authorizeResponse.json };
      },
    },
  ],
  defaultJson: {},
}) as any;
(globalThis as any).fetch = fetchStub;
(dom.window as any).fetch = fetchStub;

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom globals + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
(globalThis as any).React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ClickUpConnectionCard } = await import("../../client/src/pages/Profile");

// Capture toasts via the real use-toast store so we can assert the 503
// path does NOT fire the old toast-only behavior. A probe component
// subscribes with the actual useToast() hook — the same store the card
// dispatches into — and mirrors the live toast list to a global.
const { useToast } = await import("../../client/src/hooks/use-toast");
let observedToasts: Array<{ title?: unknown }> = [];
function ToastProbe(): null {
  const { toasts } = useToast();
  observedToasts = toasts as any;
  return null;
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function main(): Promise<void> {
  console.log("ClickUp setup notice — appears on authorize 503, clears on 200 (Task #3400)");

  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(
          React.Fragment,
          null,
          React.createElement(ClickUpConnectionCard as any),
          React.createElement(ToastProbe as any),
        ),
      ),
    );
  });
  await flush();

  // 1 — cold mount: not connected, no notice yet.
  assert($("text-clickup-not-connected") !== null, "not-connected line renders on cold mount");
  assert(
    $("notice-clickup-oauth-not-configured") === null,
    "notice must NOT render before any connect attempt",
  );
  const connectBtn = $("button-clickup-connect");
  assert(connectBtn !== null, "Connect ClickUp button renders");

  // 2 — Connect while the OAuth app is unconfigured (authorize 503).
  await click(connectBtn!);
  assert(authorizeCalls === 1, `authorize endpoint hit once (got ${authorizeCalls})`);

  const notice = $("notice-clickup-oauth-not-configured");
  assert(notice !== null, "inline notice renders after authorize returns 503");
  assert(
    /ClickUp OAuth app not configured/i.test(notice!.textContent || ""),
    `notice names the condition — got "${notice!.textContent?.slice(0, 80)}"`,
  );
  const cb = $("text-clickup-callback-url");
  assert(cb !== null, "callback URL element renders inside the notice");
  assert(
    (cb!.textContent || "").trim() === EXPECTED_CALLBACK_URL,
    `callback URL is the origin-derived redirect — got "${cb!.textContent}"`,
  );
  assert($("button-copy-clickup-callback") !== null, "copy button renders next to the callback URL");
  assert(
    /CLICKUP_CLIENT_ID/.test(notice!.textContent || "") &&
      /CLICKUP_CLIENT_SECRET/.test(notice!.textContent || ""),
    "notice names both required secrets",
  );
  // Connect button must remain available for the retry.
  const retryBtn = $("button-clickup-connect");
  assert(retryBtn !== null && !(retryBtn as HTMLButtonElement).disabled,
    "Connect button remains enabled for retry after the 503");
  assert(
    !observedToasts.some((t) => /connection failed/i.test(String(t?.title || ""))),
    "503 must NOT fire the old 'Connection failed' toast (persistent notice instead)",
  );

  // 3 — the notice is persistent, not a transient toast: it survives
  // additional render/flush cycles.
  await flush(6);
  assert(
    $("notice-clickup-oauth-not-configured") !== null,
    "notice persists across subsequent renders (not auto-dismissed)",
  );

  // 4 — secrets configured: authorize now answers 200 with a redirect URL.
  authorizeResponse = {
    status: 200,
    json: { url: "https://app.clickup.com/api?client_id=abc&state=xyz" },
  };
  await click($("button-clickup-connect")!);
  assert(authorizeCalls === 2, `authorize endpoint hit again on retry (got ${authorizeCalls})`);
  assert(
    $("notice-clickup-oauth-not-configured") === null,
    "notice clears after a successful (200) authorize attempt",
  );

  await act(async () => {
    root!.unmount();
  });
  queryClient.clear();

  console.log("\nclickup-oauth-notice: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
