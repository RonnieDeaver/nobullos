/* test-registration
{
  "name": "Conversation Hub renders a multi-recipient send as one grouped bubble (Task #5300)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #5300: a user reading N per-recipient twilio_messages rows from one compose action as 'it sent duplicates' is a real UX bug even though the backend sends exactly one SMS per recipient. Mounts the REAL ConversationHub page in jsdom against a group thread whose fetched messages are the two rows a 2-recipient send produces, and asserts the Hub renders ONE grouped bubble (not two look-alike message bubbles) while keeping each recipient's own delivery status/failure reason visible. Fast, deterministic, fully stubbed fetch — no DB.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/conversation-hub-day-separators-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "medium",
  "tierReason": "The suite keeps the medium tier because it mounts the real ConversationHub page with the shared jsdom bootstrap; the browser-like resource setup is materially heavier than a pure component assertion despite the short measured test body."
}
test-registration */
/**
 * Task #5300 — "Make group text sends look like one message, not duplicates".
 *
 * Reuses the day-separators suite's jsdom bootstrap (same globals + signed-in
 * Clerk stub) since it is generic Hub-mounting scaffolding, not specific to
 * that task.
 *
 * Fixture: a 2-participant group thread. `GET .../messages` returns the two
 * `twilio_messages` rows that server/routes/twilio.ts's per-recipient
 * Promise.allSettled fan-out would have produced for ONE compose action
 * (same body, same fromNumber, near-simultaneous createdAt, one delivered
 * and one failed) — this is exactly the shape that used to render as two
 * indistinguishable bubbles.
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
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
(globalThis as any).SVGElement = dom.window.SVGElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).PointerEvent =
  (dom.window as any).PointerEvent ?? (dom.window as any).MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
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
// Fixture: a group thread with 2 participants. Both outbound rows below are
// the fan-out of ONE compose action — identical body/fromNumber, ~200ms
// apart, distinct recipients. Second recipient's send failed (Task #5300
// explicitly requires per-recipient failures to stay visible in the
// grouped view).
// ---------------------------------------------------------------------------

const CONV_ID = "conv-group-5300";
const FROM = "+15559990000";
const ALICE = "+15551110001";
const BOB = "+15551110002";
const GROUP_KEY = `group:${CONV_ID}`;

const T0 = new Date();
T0.setHours(9, 0, 0, 0);
const T1 = new Date(T0.getTime() + 200);

const CONVERSATION = {
  id: CONV_ID,
  clientId: null,
  clientContactId: null,
  contactPhone: null,
  contactName: null,
  displayName: "Weekly check-in crew",
  twilioPhoneNumber: FROM,
  status: "active",
  conversationType: "group",
  participants: [
    { phone: ALICE, name: "Alice Andrews" },
    { phone: BOB, name: "Bob Baker" },
  ],
  lastMessageAt: T1.toISOString(),
  lastMessagePreview: "Meeting moved to 3pm",
  unreadCount: 0,
};

const MESSAGES = [
  {
    id: "msg-group-alice",
    conversationId: CONV_ID,
    twilioSid: "SM-alice",
    direction: "outbound",
    fromNumber: FROM,
    toNumber: ALICE,
    body: "Meeting moved to 3pm",
    status: "delivered",
    sentByUserId: "user-1",
    createdAt: T0.toISOString(),
  },
  {
    id: "msg-group-bob",
    conversationId: CONV_ID,
    twilioSid: "SM-bob",
    direction: "outbound",
    fromNumber: FROM,
    toNumber: BOB,
    body: "Meeting moved to 3pm",
    status: "failed",
    errorCode: "30003",
    errorMessage: "Unreachable",
    sentByUserId: "user-1",
    createdAt: T1.toISOString(),
  },
];

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: { id: "user-1", email: "op@nobull.com", firstName: "Op", lastName: "Erator", role: "ceo" } },
    { path: "/api/users/me/twilio-settings", json: { callMode: "forward", callRoutingPhone: "+15550009999" } },
    // Messages route MUST precede the conversations route (prefix matcher).
    { path: `/api/twilio/conversations/${CONV_ID}/messages`, json: MESSAGES },
    { method: "POST", path: `/api/twilio/conversations/${CONV_ID}/read`, json: { ok: true } },
    { path: "/api/twilio/conversations", json: [CONVERSATION] },
    { path: "/api/twilio/calls", json: [] },
    { path: "/api/twilio/threads/notes", json: [] },
    { path: "/api/twilio/threads/assignments", json: [] },
    { path: "/api/twilio/threads/read-states", json: [] },
    { path: "/api/twilio/threads/assignees", json: [] },
    { method: "POST", path: "/api/twilio/threads/assignment-notifications/mark-read", json: { ok: true } },
    { path: "/api/twilio/threads/assignment-notifications", json: [] },
    { path: "/api/twilio/config", json: { isConfigured: true, phoneNumbers: [FROM] } },
    { path: "/api/twilio/client-suggestions", json: [] },
    { path: "/api/twilio/client-contacts/search", json: [] },
    { path: "/api/clients-basic-hub", json: [] },
  ],
  defaultJson: {},
}) as any;

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../../client/src/components/ui/tooltip");
const ConversationHub = (await import("../../client/src/pages/ConversationHub")).default;

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}
function $$(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll(selector)) as HTMLElement[];
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function main(): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  queryClient.setQueryData(["/api/users/me/twilio-settings"], {
    callMode: "forward", callRoutingPhone: "+15550009999",
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
          React.createElement(ConversationHub),
        ),
      ),
    );
  });
  await flush();

  const row = $(`row-thread-${GROUP_KEY}`);
  assert(row, `inbox row row-thread-${GROUP_KEY} renders`);
  await act(async () => {
    row!.click();
  });
  await flush();

  console.log("— A. the 2-recipient send renders as ONE grouped bubble, not two per-recipient bubbles —");
  assert(!$("message-msg-group-alice"), "the raw per-recipient row (Alice) is NOT rendered as its own bubble");
  assert(!$("message-msg-group-bob"), "the raw per-recipient row (Bob) is NOT rendered as its own bubble");
  const groupBubbles = $$('[data-testid^="message-group-"]');
  assert(groupBubbles.length === 1, `exactly one grouped bubble renders (got ${groupBubbles.length})`);
  const groupId = groupBubbles[0].getAttribute("data-testid")!.replace("message-group-", "");

  console.log("— B. the grouped bubble names both recipients and shows the shared text once —");
  const recipientsLine = $(`text-group-recipients-${groupId}`);
  assert(recipientsLine, "recipients summary line renders");
  assert(recipientsLine!.textContent!.includes("Alice Andrews"), "recipients line names Alice");
  assert(recipientsLine!.textContent!.includes("Bob Baker"), "recipients line names Bob");
  const bodyOccurrences = groupBubbles[0].textContent!.split("Meeting moved to 3pm").length - 1;
  assert(bodyOccurrences === 1, `message body appears exactly once in the bubble (got ${bodyOccurrences})`);

  console.log("— C. per-recipient delivery status stays visible, including the failure —");
  const aliceRow = $("row-group-recipient-msg-group-alice");
  const bobRow = $("row-group-recipient-msg-group-bob");
  assert(aliceRow, "Alice's per-recipient row renders inside the group");
  assert(bobRow, "Bob's per-recipient row renders inside the group");
  assert(aliceRow!.textContent!.includes("Delivered"), `Alice's row shows Delivered (got "${aliceRow!.textContent}")`);
  assert(bobRow!.textContent!.includes("Failed"), `Bob's row shows Failed (got "${bobRow!.textContent}")`);
  const bobReason = $("reason-sms-msg-group-bob");
  assert(bobReason, "Bob's failure reason chip renders");
  assert(bobReason!.textContent!.includes("Phone unreachable"), `Bob's reason names the Twilio error (got "${bobReason!.textContent}")`);

  console.log("— D. the failed recipient (and only the failed recipient) gets a Retry action —");
  assert($("button-retry-sms-msg-group-bob"), "Retry is offered for Bob (failed)");
  assert(!$("button-retry-sms-msg-group-alice"), "Retry is NOT offered for Alice (delivered)");

  await act(async () => {
    root.unmount();
  });
  queryClient.clear();

  console.log("conversation-hub-group-send-grouping: ALL TESTS PASSED");
}

await main();
process.exit(0);
