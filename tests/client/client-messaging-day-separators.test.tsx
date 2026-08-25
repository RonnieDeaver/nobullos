/* test-registration
{
  "name": "Client texting panel shows day separators between messages (Task #2778)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2778: day separators in the client-page texting panel (user-reported feedback: messages had no date context). The rendered test pins the grouped-by-day wiring in ClientMessaging (separator testids, Today/ Yesterday/short-date labels, per-bubble h:mm a + full-date hover title), which no lower-level test covers. Fast, deterministic jsdom render — no DB, fully stubbed fetch.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2778 — day separators in the client-page texting panel.
 *
 * Feedback: "Would it be possible to get dates added to the messages?"
 * ClientMessaging.tsx previously rendered each SMS bubble with time only
 * (`h:mm a`) and no date context between days. This test mounts the REAL
 * ClientMessaging component in jsdom with a stubbed conversation whose
 * messages span 3 distinct days and asserts:
 *
 *   (A) one `separator-day-<yyyy-mm-dd>` renders per distinct day, in
 *       chronological order (oldest first, matching the thread's order);
 *   (B) separator labels are "Today" / "Yesterday" / a short-month date
 *       ("MMM d, yyyy" style) for older days — same vocabulary as the
 *       Conversation Hub's day headers (shared `groupItemsByDay` helper
 *       in client/src/lib/conversationModel.ts);
 *   (C) each bubble keeps its `h:mm a` time, and the time span carries a
 *       full-date `title` tooltip so hovering shows the exact date+time.
 *
 * The grouping helper itself is the SAME function the Conversation Hub's
 * groupTimelineByDate delegates to, so drift between the two surfaces'
 * day-bucketing is impossible by construction; this test pins the WIRING
 * in ClientMessaging (grouped render + testids + labels).
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
(globalThis as any).PointerEvent =
  (dom.window as any).PointerEvent ?? (dom.window as any).MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).localStorage = dom.window.localStorage;
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
// Fixture: one conversation whose messages span three distinct days.
// ---------------------------------------------------------------------------

const CLIENT_ID = "client-2778";
const CONV_ID = "conv-2778";

function atLocal(daysAgo: number, hours: number, minutes: number): Date {
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

// Oldest → newest: 3 days ago, yesterday, today.
const TS_OLD = atLocal(3, 8, 15);
const TS_YESTERDAY = atLocal(1, 14, 30);
const TS_TODAY = atLocal(0, 9, 5);

// The separator testid key uses the same local-midnight → ISO-slice logic
// as the shared helper.
function dayKey(ts: Date): string {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

const CONVERSATION = {
  id: CONV_ID,
  clientId: CLIENT_ID,
  contactPhone: "+15551230001",
  contactName: "Brett Barney",
  twilioPhoneNumber: "+15559990000",
  status: "active",
  conversationType: "individual",
  participants: [{ phone: "+15551230001", name: "Brett Barney" }],
  lastMessageAt: TS_TODAY.toISOString(),
  lastMessagePreview: "Sounds good",
  unreadCount: 0,
};

// The API returns newest-first; ClientMessaging reverses to oldest-first.
const MESSAGES = [
  {
    id: "msg-today",
    conversationId: CONV_ID,
    direction: "inbound",
    fromNumber: "+15551230001",
    toNumber: "+15559990000",
    body: "Sounds good",
    status: "received",
    createdAt: TS_TODAY.toISOString(),
  },
  {
    id: "msg-yesterday",
    conversationId: CONV_ID,
    direction: "outbound",
    fromNumber: "+15559990000",
    toNumber: "+15551230001",
    body: "Following up on the report",
    status: "delivered",
    createdAt: TS_YESTERDAY.toISOString(),
  },
  {
    id: "msg-old",
    conversationId: CONV_ID,
    direction: "inbound",
    fromNumber: "+15551230001",
    toNumber: "+15559990000",
    body: "Can we review the numbers?",
    status: "received",
    createdAt: TS_OLD.toISOString(),
  },
];

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    // forward mode keeps useTwilioDevice disabled (no voice-sdk import).
    { path: "/api/users/me/twilio-settings", json: { callMode: "forward", callRoutingPhone: "+15550009999" } },
    { path: `/api/twilio/conversations/${CONV_ID}/messages`, json: MESSAGES },
    { method: "POST", path: `/api/twilio/conversations/${CONV_ID}/read`, json: { ok: true } },
    { path: "/api/twilio/conversations", json: [CONVERSATION] },
    { path: "/api/twilio/config", json: { isConfigured: true, phoneNumbers: ["+15559990000"] } },
    { path: /\/api\/clients\/[^/]+\/contacts$/, json: [] },
    // Task #2957 — SMS history now lives inside the Comms tab
    // (RawCommunicationLog embeds ClientMessaging).
    { path: /\/api\/clients\/[^/]+\/communications\?/, json: [] },
    { path: /\/api\/clients\/[^/]+\/suggestions\/count$/, json: { count: 0 } },
    { path: /\/api\/clients\/[^/]+\/conversation-summary$/, json: null },
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
const ClientMessaging = (await import("../../client/src/components/ClientMessaging")).default;
const RawCommunicationLog = (await import("../../client/src/components/RawCommunicationLog")).default;
const { format } = await import("date-fns");

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
        React.createElement(ClientMessaging, { clientId: CLIENT_ID }),
      ),
    );
  });
  await flush();

  // Open the conversation.
  const convButton = $(`button-client-conv-${CONV_ID}`);
  assert(convButton, "conversation list button renders");
  await act(async () => {
    convButton!.click();
  });
  await flush();

  // Bubbles rendered.
  for (const m of MESSAGES) {
    assert($(`message-${m.id}`), `bubble message-${m.id} renders`);
  }

  console.log("— A. one day separator per distinct day, in chronological order —");
  const separators = Array.from(
    document.querySelectorAll('[data-testid^="separator-day-"]'),
  ) as HTMLElement[];
  assert(separators.length === 3, `expected 3 day separators, found ${separators.length}`);
  const expectedOrder = [dayKey(TS_OLD), dayKey(TS_YESTERDAY), dayKey(TS_TODAY)];
  const actualOrder = separators.map((el) =>
    el.getAttribute("data-testid")!.replace("separator-day-", ""),
  );
  assert(
    JSON.stringify(actualOrder) === JSON.stringify(expectedOrder),
    `separator order ${JSON.stringify(actualOrder)} !== expected ${JSON.stringify(expectedOrder)}`,
  );

  // Each separator precedes its day's bubble in DOM order.
  const oldBubble = $("message-msg-old")!;
  assert(
    separators[0].compareDocumentPosition(oldBubble) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    "oldest-day separator renders before the oldest bubble",
  );
  const todayBubble = $("message-msg-today")!;
  assert(
    separators[2].compareDocumentPosition(todayBubble) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    "today separator renders before today's bubble",
  );

  console.log("— B. labels: Today / Yesterday / short-month date —");
  assert(
    separators[2].textContent!.includes("Today"),
    `today separator label says "Today" (got "${separators[2].textContent}")`,
  );
  assert(
    separators[1].textContent!.includes("Yesterday"),
    `yesterday separator label says "Yesterday" (got "${separators[1].textContent}")`,
  );
  // Older day: localized short-month date (e.g. "Jul 5, 2026") — pin via the
  // same locale API the helper uses so this isn't locale-brittle.
  const oldDay = new Date(TS_OLD);
  oldDay.setHours(0, 0, 0, 0);
  const expectedOldLabel = oldDay.toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
  });
  assert(
    separators[0].textContent!.includes(expectedOldLabel),
    `old-day separator label "${separators[0].textContent}" includes "${expectedOldLabel}"`,
  );
  assert(
    !separators[0].textContent!.includes("Today") && !separators[0].textContent!.includes("Yesterday"),
    "old-day separator is not mislabeled Today/Yesterday",
  );

  console.log("— C. bubbles keep h:mm a times + full-date hover title —");
  for (const [id, ts] of [
    ["msg-old", TS_OLD],
    ["msg-yesterday", TS_YESTERDAY],
    ["msg-today", TS_TODAY],
  ] as Array<[string, Date]>) {
    const bubble = $(`message-${id}`)!;
    const expectedTime = format(ts, "h:mm a");
    assert(
      bubble.textContent!.includes(expectedTime),
      `bubble ${id} shows time "${expectedTime}" (got "${bubble.textContent}")`,
    );
    const titled = bubble.querySelector(`[title*="${format(ts, "MMM d, yyyy")}"]`);
    assert(titled, `bubble ${id} time carries a full-date title tooltip`);
  }

  await act(async () => {
    root.unmount();
  });
  queryClient.clear();

  // -------------------------------------------------------------------------
  // D. Task #2957 — the SMS history renders in its new home: embedded inside
  // the Comms tab's RawCommunicationLog (the standalone Messaging tab is gone).
  // -------------------------------------------------------------------------
  console.log("— D. SMS history renders inside RawCommunicationLog (Comms tab) —");
  const qc2 = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const root2 = createRoot(document.getElementById("root")!);
  await act(async () => {
    root2.render(
      React.createElement(
        QueryClientProvider,
        { client: qc2 },
        React.createElement(RawCommunicationLog, {
          clientId: CLIENT_ID,
          currentUser: { id: "user-1", role: "ceo" },
        }),
      ),
    );
  });
  await flush();

  assert($("raw-communication-log"), "RawCommunicationLog renders");
  assert($("section-sms-history"), "SMS history section renders inside the Comms log");
  const convButton2 = $(`button-client-conv-${CONV_ID}`);
  assert(convButton2, "SMS conversation list renders inside the Comms log");
  await act(async () => {
    convButton2!.click();
  });
  await flush();
  const separators2 = document.querySelectorAll('[data-testid^="separator-day-"]');
  assert(
    separators2.length === 3,
    `day separators still render in the embedded thread (found ${separators2.length})`,
  );
  assert(
    $("button-open-hub-new-message"),
    "New Message in Hub launch button survives in the merged view",
  );
  assert(
    $(`button-hub-message-${CONV_ID}`) && $(`button-hub-call-${CONV_ID}`),
    "Message/Call Hub deep-link buttons survive in the merged view",
  );

  await act(async () => {
    root2.unmount();
  });
  qc2.clear();

  console.log("client-messaging-day-separators: ALL TESTS PASSED");
}

await main();
process.exit(0);
