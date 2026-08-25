/* test-registration
{
  "name": "Rail create-channel rendered — non-CEO opens dialog, one POST, popup on 201, visible error (Task #3235)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3235: rendered proof that a non-CEO (account_manager) user can create a group channel from the rail popover: \"New channel…\" opens the dialog, submit fires exactly one POST /api/comms/channels with the right body, a 201 closes the dialog + opens the popup, and a 403 shows a visible error (no silent failure). Mounts the REAL NewChatPopover; Radix popover/dialog shimmed. DB-free, no network (stubbed fetch).",
  "extraNodeArgs": [
    "--import",
    "./tests/client/rail-create-channel-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3235 — non-CEO user creates a group channel from the sidebar rail.
 *
 * The RailCreateChannelDialog (Task #3168) was previously covered only by a
 * static source scan (tests/comms-new-chat-actions.test.ts). This test mounts
 * the REAL NewChatPopover from CommsRail.tsx in jsdom as an account_manager
 * user (not CEO), stubs POST /api/comms/channels, and proves end-to-end:
 *
 *   (1) The "New channel…" button is visible in the rail popover and clicking
 *       it opens the create-channel dialog (form was not mounted before).
 *   (2) Typing a name + submitting fires EXACTLY ONE POST to
 *       /api/comms/channels with the right body ({ name, visibility }).
 *   (3) On 201 the dialog closes and the onOpenChannel callback (openPopup in
 *       CommsRail) is called with the new channel id.
 *   (4) On a server error (403) a visible error message appears inside the
 *       dialog (rail-create-channel-error) — no silent failure — the dialog
 *       stays open, and no popup is opened.
 *
 * Radix Popover + Dialog are shimmed via the shared heavy-client loader (their
 * portal content never mounts in this raw jsdom harness); everything else —
 * the popover component, dialog form, submit flow, error handling — is the
 * real code. DB-free, no network (stubbed fetch).
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/dashboard" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).SVGElement = dom.window.SVGElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).PointerEvent =
  (dom.window as any).PointerEvent ?? (dom.window as any).MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).sessionStorage = dom.window.sessionStorage;
(globalThis as any).history = dom.window.history;
(globalThis as any).location = dom.window.location;
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
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Fixtures — a NON-CEO user (the regression under test: account_manager can
// create a channel from the rail without a permissions error).
// ---------------------------------------------------------------------------

const AM_USER = {
  id: "user-am-3235",
  email: "am@nobull.test",
  firstName: "Account",
  lastName: "Manager",
  role: "account_manager",
};

const NEW_CHANNEL_ID = "ch-new-3235";

// Mutable switch: first submit succeeds (201), later submits fail (403).
let createChannelMode: "success" | "forbidden" = "success";
const createChannelCalls: Array<{ body: any }> = [];

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: AM_USER },
    { path: "/api/comms/users", json: [] },
    {
      method: "POST",
      path: "/api/comms/channels",
      respond: ({ init, jsonResponse }: any) => {
        const body = init?.body ? JSON.parse(init.body) : null;
        createChannelCalls.push({ body });
        if (createChannelMode === "forbidden") {
          return jsonResponse(403, { message: "Forbidden" });
        }
        return jsonResponse(201, {
          id: NEW_CHANNEL_ID,
          name: body?.name ?? "x",
          slug: body?.name ?? "x",
          type: "channel",
          visibility: body?.visibility ?? "public",
          unreadCount: 0,
        });
      },
    },
  ],
  defaultJson: {},
}) as any;

// ---------------------------------------------------------------------------
// Mount the real NewChatPopover
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../../client/src/components/ui/tooltip");
const { NewChatPopover } = await import(
  "../../client/src/components/comms/CommsRail"
);

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function typeInto(testId: string, value: string): void {
  const el = $(testId) as HTMLInputElement | null;
  assert(el, `input ${testId} is present`);
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(el, value);
  el!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

const openedChannelIds: string[] = [];
const refetchCalls: number[] = [];

async function main(): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(NewChatPopover, {
            channels: [],
            onlineUserIds: [],
            onOpenChannel: (id: string) => openedChannelIds.push(id),
            refetchChannels: () => refetchCalls.push(1),
          }),
        ),
      ),
    );
  });
  await flush();

  console.log("— 1. 'New channel…' button opens the dialog —");
  assert(
    !$("rail-new-channel-name-input"),
    "create-channel dialog form is NOT mounted before the button is clicked",
  );
  const newChannelBtn = $("rail-new-channel-button");
  assert(newChannelBtn, "'New channel…' button is visible in the rail popover");
  await act(async () => {
    newChannelBtn!.click();
  });
  await flush(2);
  assert(
    $("rail-new-channel-name-input"),
    "clicking 'New channel…' opens the create-channel dialog (name input mounted)",
  );

  console.log("— 2. submit fires exactly one POST with the right body —");
  typeInto("rail-new-channel-name-input", "am-created-channel");
  await flush(1);
  const submitBtn = $("rail-create-channel-submit");
  assert(submitBtn, "submit button is present in the dialog");
  assert(
    !(submitBtn as HTMLButtonElement).disabled,
    "submit button enables once a name is typed",
  );
  await act(async () => {
    submitBtn!.click();
  });
  await flush();
  assert(
    createChannelCalls.length === 1,
    `exactly one POST /api/comms/channels fired (got ${createChannelCalls.length})`,
  );
  const body = createChannelCalls[0].body;
  assert(
    body && body.name === "am-created-channel" && body.visibility === "public",
    `POST body has name + visibility (got ${JSON.stringify(body)})`,
  );

  console.log("— 3. on 201 the dialog closes and openPopup gets the new id —");
  assert(
    !$("rail-new-channel-name-input"),
    "dialog closes after a successful create",
  );
  assert(
    JSON.stringify(openedChannelIds) === JSON.stringify([NEW_CHANNEL_ID]),
    `onOpenChannel called exactly once with the new channel id (got ${JSON.stringify(openedChannelIds)})`,
  );
  assert(refetchCalls.length >= 1, "channel list refetch is triggered on success");

  console.log("— 4. on error a visible message appears (no silent failure) —");
  createChannelMode = "forbidden";
  await act(async () => {
    $("rail-new-channel-button")!.click();
  });
  await flush(2);
  typeInto("rail-new-channel-name-input", "will-fail");
  await flush(1);
  await act(async () => {
    $("rail-create-channel-submit")!.click();
  });
  await flush();
  assert(
    createChannelCalls.length === 2,
    `second submit fired a second POST (got ${createChannelCalls.length})`,
  );
  const errEl = $("rail-create-channel-error");
  assert(errEl, "error message element renders inside the dialog on failure");
  assert(
    (errEl!.textContent ?? "").trim().length > 0,
    "error message has visible text (no silent failure)",
  );
  assert(
    $("rail-new-channel-name-input"),
    "dialog stays open on failure so the user can retry",
  );
  assert(
    openedChannelIds.length === 1,
    "no popup is opened on the failed create",
  );

  await act(async () => {
    root.unmount();
  });
  queryClient.clear();

  console.log("rail-create-channel: ALL TESTS PASSED");
}

await main();
process.exit(0);
