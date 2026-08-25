/* test-registration
{
  "name": "Comms desktop notifications — background-tab notification with sender+preview, click deep-links to channel+message, DND/mute/own-message suppression (Task #3310)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3310: desktop-notification deep-link + suppression contracts — backgrounded tab fires a Notification with sender + preview, click navigates to /comms?channel=<id>&message=<id> (MessagePane anchor jump), and DND / muted channel / own messages suppress. Hook-level jsdom test with a fake Notification API; DB-free, network-free.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3310 — desktop notification deep-link + suppression contracts.
 *
 * Pins the useDesktopNotifications hook behavior:
 *  A. A qualifying comms:message SSE event while the tab is hidden creates a
 *     browser Notification carrying sender name + content preview.
 *  B. Clicking the notification navigates to /comms?channel=<id>&message=<id>
 *     (the ?message param drives MessagePane's anchor-window jump/highlight).
 *  C. DND active suppresses the notification entirely.
 *  D. A muted channel suppresses the notification entirely.
 *  E. Own messages never notify.
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/comms" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).history = dom.window.history;
(globalThis as any).location = dom.window.location;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ── Fake Notification API ─────────────────────────────────────────────────────
const created: FakeNotification[] = [];
class FakeNotification {
  static permission: NotificationPermission = "granted";
  title: string;
  body: string;
  tag: string | undefined;
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(title: string, opts?: { body?: string; tag?: string; icon?: string }) {
    this.title = title;
    this.body = opts?.body ?? "";
    this.tag = opts?.tag;
    created.push(this);
  }
  close() { this.closed = true; this.onclose?.(); }
}
(dom.window as any).Notification = FakeNotification;
(globalThis as any).Notification = FakeNotification;

// Simulate a backgrounded tab: document.hidden === true.
Object.defineProperty(dom.window.document, "hidden", { get: () => true });

// window.focus stub
(dom.window as any).focus = () => {};

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ── Imports after jsdom ───────────────────────────────────────────────────────
const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useDesktopNotifications } = await import(
  "../../client/src/components/comms/useDesktopNotifications"
);

const MY_ID = "user-me";
const SENDER = { id: "user-sender", firstName: "Jane", lastName: "Doe", profileImageUrl: null };

const settingsBase = {
  globalDefault: "all" as const,
  soundEnabled: false,
  soundChoice: "default" as const,
  desktopEnabled: true,
  suppressSnippetPrivate: false,
  keywords: [] as string[],
};

type Listener = (e: MessageEvent) => void;

function makeHarness(opts: {
  isDndActive?: boolean;
  notifPref?: "all" | "mentions" | "muted" | null;
}) {
  let listener: Listener | null = null;
  const addSseListener = (fn: Listener) => {
    listener = fn;
    return () => { listener = null; };
  };
  const channels = [
    {
      id: "chan-1",
      name: "general",
      type: "channel",
      visibility: "public",
      notifPref: opts.notifPref ?? "all",
    },
  ] as any[];

  function Harness() {
    useDesktopNotifications({
      settings: settingsBase as any,
      channels,
      myUserId: MY_ID,
      isDndActive: opts.isDndActive ?? false,
      addSseListener,
    });
    return null;
  }
  return { Harness, fire: (payload: any) => listener?.({ data: JSON.stringify(payload) } as MessageEvent) };
}

function messageEvent(overrides: Record<string, any> = {}) {
  return {
    type: "comms:message",
    channelId: "chan-1",
    message: {
      id: "msg-42",
      userId: SENDER.id,
      content: "hello from the background",
      contentType: "text",
      user: SENDER,
      createdAt: new Date().toISOString(),
      ...overrides,
    },
  };
}

async function mountAndFire(
  opts: Parameters<typeof makeHarness>[0],
  payload: any,
): Promise<void> {
  const { Harness, fire } = makeHarness(opts);
  const root = createRoot(document.getElementById("root")!);
  await act(async () => { root.render(React.createElement(Harness)); });
  await act(async () => { fire(payload); });
  await act(async () => { root.unmount(); });
}

async function main(): Promise<void> {
  // A + B — qualifying message → notification with sender + preview; click deep-links.
  created.length = 0;
  await mountAndFire({}, messageEvent());
  assert(created.length === 1, `expected 1 notification, got ${created.length}`);
  const n = created[0];
  assert(n.title === "Jane Doe", `title carries sender name (got "${n.title}")`);
  assert(
    n.body.includes("hello from the background"),
    `body carries content preview (got "${n.body}")`,
  );
  console.log("  ok  backgrounded tab → notification with sender + preview");

  n.onclick?.();
  const loc = dom.window.location;
  const search = new URLSearchParams(loc.search);
  assert(loc.pathname === "/comms", `click navigates to /comms (got ${loc.pathname})`);
  assert(search.get("channel") === "chan-1", `click carries channel id (got ${loc.search})`);
  assert(search.get("message") === "msg-42", `click carries message id for scroll-to (got ${loc.search})`);
  assert(n.closed, "notification closes after click");
  console.log("  ok  click → /comms?channel=chan-1&message=msg-42");

  // C — DND suppresses.
  created.length = 0;
  await mountAndFire({ isDndActive: true }, messageEvent({ id: "msg-dnd" }));
  assert(created.length === 0, "DND active → no notification");
  console.log("  ok  DND suppresses notification");

  // D — muted channel suppresses.
  created.length = 0;
  await mountAndFire({ notifPref: "muted" }, messageEvent({ id: "msg-muted" }));
  assert(created.length === 0, "muted channel → no notification");
  console.log("  ok  muted channel suppresses notification");

  // E — own message never notifies.
  created.length = 0;
  await mountAndFire({}, messageEvent({ id: "msg-own", userId: MY_ID }));
  assert(created.length === 0, "own message → no notification");
  console.log("  ok  own messages never notify");

  console.log("All desktop-notification deep-link tests passed");
}

await main();
