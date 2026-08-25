/* test-registration
{
  "name": "Conversation Hub timeline shows day separators between SMS/call events (Task #2780)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2780: the Conversation Hub is the OTHER texting surface with day separators; its unified timeline reuses the same shared groupItemsByDay helper, but the Hub-side rendered wiring (timeline-divider testids, Today/Yesterday/long-date labels, one divider shared by same-day SMS + call events) had no coverage and could rot silently in the giant ConversationHub component. Fast, deterministic jsdom render — no DB, fully stubbed fetch.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/conversation-hub-day-separators-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2780 — day separators in the Conversation Hub SMS/timeline view.
 *
 * Task #2778 added "Today / Yesterday / <date>" day separators to the
 * client-page texting panel via the shared `groupItemsByDay` helper
 * (client/src/lib/conversationModel.ts). The Conversation Hub's unified
 * timeline delegates to the SAME helper through `groupTimelineByDate`,
 * but until now nothing pinned the Hub's rendered wiring — a refactor of
 * TimelineColumn could drop the `timeline-divider-*` headers and no test
 * would fail. This test mounts the REAL ConversationHub page in jsdom
 * with a stubbed thread whose events span 3 distinct days and asserts:
 *
 *   (A) one `timeline-divider-<yyyy-mm-dd>` renders per distinct day, in
 *       chronological order, each preceding its day's events in the DOM;
 *   (B) divider labels use the same vocabulary as the shared helper:
 *       "Today" / "Yesterday" / a long-month date for older days;
 *   (C) an SMS bubble and a call card on the SAME day share ONE divider
 *       (the Hub's timeline is unified — SMS must not mint its own
 *       duplicate day header), and each SMS bubble keeps its `h:mm a`
 *       time under the day header.
 *
 * The grouping math itself is `groupItemsByDay` — identical by
 * construction to the client-page panel pinned by
 * tests/client/client-messaging-day-separators.test.tsx — so this test
 * exists to pin the Hub-side WIRING (grouped render + divider testids +
 * labels), completing day-date coverage across all texting surfaces.
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
// The FAB collider ref (client/src/lib/fabCollider.ts) constructs a
// `new CustomEvent(...)` and dispatches it on `window`; without the global bound
// to this jsdom window, jsdom's dispatchEvent rejects the foreign Event.
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).PointerEvent =
  (dom.window as any).PointerEvent ?? (dom.window as any).MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).localStorage = dom.window.localStorage;
// wouter's useBrowserLocation reads the bare `location`/`history` globals.
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
// NOTE: we deliberately do NOT define EventSource — ConversationHub's SSE
// effect guards on `typeof EventSource === "undefined"` and skips itself.

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Fixture: one individual thread whose events span three distinct days —
// SMS on all three days plus a call on the "yesterday" day (same day as an
// SMS) to prove the unified timeline shares one divider per day.
// ---------------------------------------------------------------------------

const CONV_ID = "conv-2780";
const PHONE = "+15551230001";
// resolveThreadKey: individual conv, no contactId/clientId → phone:<last10>
const THREAD_KEY = "phone:5551230001";

function atLocal(daysAgo: number, hours: number, minutes: number): Date {
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

// Oldest → newest: 3 days ago, yesterday (SMS + call), today.
const TS_OLD = atLocal(3, 8, 15);
const TS_YESTERDAY_SMS = atLocal(1, 14, 30);
const TS_YESTERDAY_CALL = atLocal(1, 10, 0);
const TS_TODAY = atLocal(0, 9, 5);

// The divider testid key uses the same local-midnight → ISO-slice logic as
// the shared groupItemsByDay helper.
function dayKey(ts: Date): string {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

const CONVERSATION = {
  id: CONV_ID,
  clientId: null,
  clientContactId: null,
  contactPhone: PHONE,
  contactName: "Brett Barney",
  displayName: null,
  twilioPhoneNumber: "+15559990000",
  status: "active",
  conversationType: "individual",
  participants: [{ phone: PHONE, name: "Brett Barney" }],
  lastMessageAt: TS_TODAY.toISOString(),
  lastMessagePreview: "Sounds good",
  unreadCount: 0,
};

const MESSAGES = [
  {
    id: "msg-today",
    conversationId: CONV_ID,
    twilioSid: "SM-today",
    direction: "inbound",
    fromNumber: PHONE,
    toNumber: "+15559990000",
    body: "Sounds good",
    status: "received",
    sentByUserId: null,
    createdAt: TS_TODAY.toISOString(),
  },
  {
    id: "msg-yesterday",
    conversationId: CONV_ID,
    twilioSid: "SM-yesterday",
    direction: "outbound",
    fromNumber: "+15559990000",
    toNumber: PHONE,
    body: "Following up on the report",
    status: "delivered",
    sentByUserId: "user-1",
    createdAt: TS_YESTERDAY_SMS.toISOString(),
  },
  {
    id: "msg-old",
    conversationId: CONV_ID,
    twilioSid: "SM-old",
    direction: "inbound",
    fromNumber: PHONE,
    toNumber: "+15559990000",
    body: "Can we review the numbers?",
    status: "received",
    sentByUserId: null,
    createdAt: TS_OLD.toISOString(),
  },
];

// Inbound completed call from the same phone → merges into the same thread
// (buildUnifiedConversationList keys calls by normalized phone).
const CALL = {
  id: "call-yesterday",
  clientId: null,
  clientContactId: null,
  twilioSid: "CA-yesterday",
  direction: "inbound",
  fromNumber: PHONE,
  toNumber: "+15559990000",
  status: "completed",
  duration: 63,
  initiatedByUserId: null,
  routedToUserId: null,
  routingTier: null,
  answeredAt: TS_YESTERDAY_CALL.toISOString(),
  createdAt: TS_YESTERDAY_CALL.toISOString(),
};

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: { id: "user-1", email: "op@nobull.com", firstName: "Op", lastName: "Erator", role: "ceo" } },
    // forward mode keeps useTwilioDevice disabled (no voice-sdk runtime).
    { path: "/api/users/me/twilio-settings", json: { callMode: "forward", callRoutingPhone: "+15550009999" } },
    // Messages route MUST precede the conversations route — the string
    // matcher is prefix-based and "/api/twilio/conversations" would
    // otherwise swallow the messages URL.
    { path: `/api/twilio/conversations/${CONV_ID}/messages`, json: MESSAGES },
    { method: "POST", path: `/api/twilio/conversations/${CONV_ID}/read`, json: { ok: true } },
    { path: "/api/twilio/conversations", json: [CONVERSATION] },
    { path: "/api/twilio/calls", json: [CALL] },
    { path: "/api/twilio/threads/notes", json: [] },
    { path: "/api/twilio/threads/assignments", json: [] },
    { path: "/api/twilio/threads/read-states", json: [] },
    { path: "/api/twilio/threads/assignees", json: [] },
    { method: "POST", path: "/api/twilio/threads/assignment-notifications/mark-read", json: { ok: true } },
    { path: "/api/twilio/threads/assignment-notifications", json: [] },
    { path: "/api/twilio/config", json: { isConfigured: true, phoneNumbers: ["+15559990000"] } },
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
  // Task #2791: the auth cache is deliberately NOT pre-seeded — the Hub
  // must mount cold with `user` undefined and re-render safely once the
  // stubbed /api/auth/user probe resolves. (The former hook-count crash
  // was fixed by moving the `if (!user) return null` early return below
  // every hook in ConversationHub.tsx; this cold mount pins that fix.)
  // Pre-seed forward call mode: the Hub defaults callMode to "browser"
  // while this query is in flight, which would instantiate the real Twilio
  // Voice SDK Device for one render before the stubbed setting lands.
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

  // Open the thread from the inbox.
  const row = $(`row-thread-${THREAD_KEY}`);
  assert(row, `inbox row row-thread-${THREAD_KEY} renders`);
  await act(async () => {
    row!.click();
  });
  await flush();

  // Timeline mounted with all four events.
  for (const m of MESSAGES) {
    assert($(`message-${m.id}`), `SMS bubble message-${m.id} renders`);
  }
  assert($(`call-card-${CALL.id}`), `call card call-card-${CALL.id} renders`);

  console.log("— A. one timeline divider per distinct day, chronological, before its events —");
  const dividers = Array.from(
    document.querySelectorAll('[data-testid^="timeline-divider-"]'),
  ) as HTMLElement[];
  assert(
    dividers.length === 3,
    `expected exactly 3 day dividers (call shares yesterday's), found ${dividers.length}`,
  );
  const expectedOrder = [dayKey(TS_OLD), dayKey(TS_YESTERDAY_SMS), dayKey(TS_TODAY)];
  const actualOrder = dividers.map((el) =>
    el.getAttribute("data-testid")!.replace("timeline-divider-", ""),
  );
  assert(
    JSON.stringify(actualOrder) === JSON.stringify(expectedOrder),
    `divider order ${JSON.stringify(actualOrder)} !== expected ${JSON.stringify(expectedOrder)}`,
  );

  const FOLLOWING = dom.window.Node.DOCUMENT_POSITION_FOLLOWING;
  assert(
    dividers[0].compareDocumentPosition($("message-msg-old")!) & FOLLOWING,
    "oldest-day divider renders before the oldest bubble",
  );
  assert(
    dividers[2].compareDocumentPosition($("message-msg-today")!) & FOLLOWING,
    "today divider renders before today's bubble",
  );

  console.log("— B. labels: Today / Yesterday / long-month date (shared helper vocabulary) —");
  assert(
    dividers[2].textContent!.includes("Today"),
    `today divider label says "Today" (got "${dividers[2].textContent}")`,
  );
  assert(
    dividers[1].textContent!.includes("Yesterday"),
    `yesterday divider label says "Yesterday" (got "${dividers[1].textContent}")`,
  );
  // Older day: localized long-month date (Hub passes month: "long") — pin via
  // the same locale API the helper uses so this isn't locale-brittle.
  const oldDay = new Date(TS_OLD);
  oldDay.setHours(0, 0, 0, 0);
  const expectedOldLabel = oldDay.toLocaleDateString(undefined, {
    month: "long", day: "numeric", year: "numeric",
  });
  assert(
    dividers[0].textContent!.includes(expectedOldLabel),
    `old-day divider label "${dividers[0].textContent}" includes "${expectedOldLabel}"`,
  );
  assert(
    !dividers[0].textContent!.includes("Today") && !dividers[0].textContent!.includes("Yesterday"),
    "old-day divider is not mislabeled Today/Yesterday",
  );

  console.log("— C. SMS + call on the same day share one divider; bubbles keep h:mm a —");
  // Both yesterday events sit between the yesterday divider and the today
  // divider in DOM order — i.e. they share the single yesterday group.
  const yesterdayBubble = $("message-msg-yesterday")!;
  const yesterdayCall = $(`call-card-${CALL.id}`)!;
  for (const [label, el] of [["SMS bubble", yesterdayBubble], ["call card", yesterdayCall]] as const) {
    assert(
      dividers[1].compareDocumentPosition(el) & FOLLOWING,
      `yesterday ${label} renders after the Yesterday divider`,
    );
    assert(
      el.compareDocumentPosition(dividers[2]) & FOLLOWING,
      `yesterday ${label} renders before the Today divider`,
    );
  }
  for (const [id, ts] of [
    ["msg-old", TS_OLD],
    ["msg-yesterday", TS_YESTERDAY_SMS],
    ["msg-today", TS_TODAY],
  ] as Array<[string, Date]>) {
    const bubble = $(`message-${id}`)!;
    const expectedTime = format(ts, "h:mm a");
    assert(
      bubble.textContent!.includes(expectedTime),
      `bubble ${id} shows time "${expectedTime}" (got "${bubble.textContent}")`,
    );
  }

  await act(async () => {
    root.unmount();
  });
  queryClient.clear();

  console.log("conversation-hub-day-separators: ALL TESTS PASSED");
}

await main();
process.exit(0);
