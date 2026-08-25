/* test-registration
{
  "name": "NotificationRow client-name link — /clients/<id> href from metadata, stopPropagation vs row click, plain-text fallback (Task #4513)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Fast (~2s) deterministic jsdom component test with no DB writes; guards the stopPropagation contract that keeps the inner client link from also firing the bell row's deep-link navigation (Task #4513) — a silent-double-navigation regression the full suite alone would catch too late.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/components/NotificationRow.tsx",
    "client/src/components/NotificationBell.tsx",
    "client/src/pages/Notifications.tsx"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4513 — the client-name segment on notification rows is a shortcut to
 * that client's page.
 *
 * Renders the REAL NotificationRow (client/src/components/NotificationRow.tsx)
 * in jsdom and asserts:
 *
 *   (A) notificationClientHref() resolves `/clients/<clientId>` from raw row
 *       metadata, and returns null for missing / non-string / empty clientId
 *       so the segment degrades to plain text.
 *   (B) Full variant: with clientHref set, the client segment renders as an
 *       anchor with the client-page href (testIds.client preserved).
 *   (C) Compact variant (bell dropdown): clicking the client link does NOT
 *       fire the whole-row onRowClick handler (stopPropagation), while a
 *       click elsewhere on the row still does — the inner link must never
 *       also trigger the row's own deep-link navigation.
 *   (D) Without clientHref, the client name stays a plain <span> (no anchor).
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).history = dom.window.history;
// wouter's use-browser-location subscribes via bare addEventListener.
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).location = dom.window.location;
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { NotificationRow, notificationClientHref } = await import(
  "../../client/src/components/NotificationRow"
);

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function render(props: any): Promise<Root> {
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(NotificationRow, props));
  });
  return root!;
}

// ── (A) helper resolution ──
assert(
  notificationClientHref({ clientId: "abc-123" }) === "/clients/abc-123",
  "string clientId resolves to /clients/<id>",
);
assert(notificationClientHref(null) === null, "null metadata -> null");
assert(notificationClientHref(undefined) === null, "undefined metadata -> null");
assert(notificationClientHref({}) === null, "no clientId key -> null");
assert(notificationClientHref({ clientId: 42 }) === null, "non-string clientId -> null");
assert(notificationClientHref({ clientId: "" }) === null, "empty clientId -> null");
assert(notificationClientHref("abc") === null, "non-object metadata -> null");

const baseProps = {
  category: "comms.sms",
  title: "New SMS",
  body: "Hello there",
  timestamp: new Date().toISOString(),
  unread: true,
  unreadTone: "primary" as const,
  clientName: "Harper & Lane",
};

// ── (B) full variant renders anchor ──
{
  const root = await render({
    ...baseProps,
    variant: "full",
    clientHref: "/clients/abc-123",
    testIds: { root: "row-full", client: "client-seg" },
  });
  const seg = $("client-seg");
  assert(seg, "full variant renders client segment");
  assert(seg!.tagName === "A", `full-variant client segment is an anchor (got ${seg!.tagName})`);
  assert(
    seg!.getAttribute("href") === "/clients/abc-123",
    "full-variant anchor href is the client page",
  );
  assert(seg!.textContent === "Harper & Lane", "anchor shows the client name");
  await act(async () => root.unmount());
}

// ── (C) compact variant: link click stops row propagation ──
{
  let rowClicks = 0;
  const root = await render({
    ...baseProps,
    variant: "compact",
    clientHref: "/clients/abc-123",
    onRowClick: () => {
      rowClicks++;
    },
    testIds: { root: "row-compact", client: "client-seg-compact", title: "title-compact" },
  });
  const seg = $("client-seg-compact");
  assert(seg && seg.tagName === "A", "compact-variant client segment is an anchor");
  assert(
    seg!.getAttribute("href") === "/clients/abc-123",
    "compact-variant anchor href is the client page",
  );

  await act(async () => {
    seg!.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  assert(
    rowClicks === 0,
    `clicking the client link must NOT fire the row's onRowClick (got ${rowClicks})`,
  );

  await act(async () => {
    $("title-compact")!.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  assert(
    rowClicks === 1,
    `clicking elsewhere on the row still fires onRowClick (got ${rowClicks})`,
  );
  await act(async () => root.unmount());
}

// ── (D) no clientHref -> plain span, no anchor ──
{
  const root = await render({
    ...baseProps,
    variant: "full",
    clientHref: null,
    testIds: { root: "row-plain", client: "client-seg-plain" },
  });
  const seg = $("client-seg-plain");
  assert(seg, "client segment still renders without href");
  assert(
    seg!.tagName === "SPAN",
    `without clientHref the segment stays a plain span (got ${seg!.tagName})`,
  );
  assert(seg!.querySelector("a") === null, "no nested anchor without clientHref");
  await act(async () => root.unmount());
}

console.log("notification-row-client-link: all assertions passed");
