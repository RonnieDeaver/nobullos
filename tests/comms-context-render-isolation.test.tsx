/* test-registration
{
  "name": "Comms context render isolation — SSE presence/message bursts re-render only whole-snapshot (comms-surface) consumers; a non-comms page child, a narrow useCommsSelector consumer (GlobalTitleManager's chat count), and per-popup channel/status slices stay idle unless their own slice changes (Tasks #3838/#3848)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Tasks #3838/#3848: busy chat activity must not re-render the whole app OR other open popups. Mounts the REAL CommsProvider in jsdom, injects SSE presence, user_status and read_state events, and asserts via render-count probes: (1) a plain child page never re-renders, (2) a useCommsSelector(totalUnread+totalThreadUnread) consumer re-renders ONLY when the count changes, (3) useCommsContext consumers (comms surfaces) still see every update, (4) per-popup probes (a popup's channel slice + one user's status slice) re-render ONLY when their own channel/user changes — activity in channel A leaves popup B idle. Also source-guards that GlobalTitleManager, the popup internals (CommsPopupManager, MessagePane, Composer, MessageItem) and CommsRail (per-field selectors + memoized rows) use the narrow selector. DB-free, network-free.",
  "extraNodeArgs": [
    "--import",
    "./tests/comms-clients-subgroup-collapse-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/components/GlobalTitleManager.tsx",
    "client/src/components/comms/CommsPopupManager.tsx",
    "client/src/components/comms/CommsRail.tsx",
    "client/src/components/comms/Composer.tsx",
    "client/src/components/comms/MessageItem.tsx",
    "client/src/components/comms/MessagePane.tsx",
    "client/src/contexts/CommsContext.tsx"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #3838 — Keep busy chat activity from re-rendering the whole app.
 *
 * CommsProvider now publishes a STABLE store object through context; consumers
 * subscribe via useSyncExternalStore. This test mounts the REAL provider with
 * three render-count probes:
 *
 *   - PageProbe: a plain child under the provider that uses NO comms hooks —
 *     stands in for "an unrelated page". Must never re-render on SSE events.
 *   - SelectorProbe: useCommsSelector(s => s.totalUnread + s.totalThreadUnread)
 *     — the exact slice GlobalTitleManager uses. Must re-render only when the
 *     count changes, not on presence churn.
 *   - FullProbe: useCommsContext() — a comms surface. Must re-render on every
 *     provider update (unchanged behavior; rail/popups rely on this).
 *
 * Scenario: channels load with 2 unreads → inject a comms:presence SSE event
 * (hot churn, count unchanged) → inject comms:read_state (count 2 → 0).
 *
 * DB-free, network-free. Run with TSX_TSCONFIG_PATH=./tsconfig.tests.json and
 * --import ./tests/comms-clients-subgroup-collapse-setup.mjs (same loader
 * stack: use-auth stub, truthy quicklinks gate, heavy-client stubs).
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).sessionStorage = dom.window.sessionStorage;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// EventSource fake that CAPTURES listeners so the test can inject SSE events.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  listeners = new Map<string, Array<(e: unknown) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  removeEventListener(): void {}
  close(): void {}
  emit(type: string, payload: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data: JSON.stringify(payload) });
    }
  }
}
(globalThis as any).EventSource = FakeEventSource;
(dom.window as any).EventSource = FakeEventSource;

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFetchStub } from "./helpers/createFetchStub.mjs";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function section(title: string): void {
  console.log(`\n— ${title} —`);
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();
const CHANNELS = [
  {
    id: "ch1",
    name: "ch1",
    slug: "ch1",
    type: "channel" as const,
    visibility: "public",
    topic: null,
    description: null,
    clientId: null,
    createdBy: "user-me",
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    unreadCount: 2,
    mentionCount: 0,
    members: [],
    lastMessageAt: NOW,
  },
  {
    id: "ch2",
    name: "ch2",
    slug: "ch2",
    type: "channel" as const,
    visibility: "public",
    topic: null,
    description: null,
    clientId: null,
    createdBy: "user-me",
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    unreadCount: 0,
    mentionCount: 0,
    members: [],
    lastMessageAt: NOW,
  },
];

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { method: "GET", path: /\/api\/comms\/channels(\?|$)/, json: () => CHANNELS.map((c) => ({ ...c })) },
    { method: "GET", path: /\/api\/comms\/sidebar\/categories(\?|$)/, json: [] },
    { method: "GET", path: /\/api\/comms\/drafts(\?|$)/, json: [] },
    {
      method: "GET",
      path: /\/api\/comms\/threads\/unread-summary(\?|$)/,
      json: { totalUnreadReplies: 0, totalMentions: 0 },
    },
  ],
  defaultJson: {},
}) as typeof fetch;

// ─── Render-count probes ─────────────────────────────────────────────────────

const renders = { page: 0, selector: 0, full: 0, popupCh1: 0, popupCh2: 0, statusA: 0, statusB: 0 };

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function main(): Promise<void> {
  const { CommsProvider, useCommsContext, useCommsSelector } = await import(
    "../client/src/contexts/CommsContext"
  );
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

  function PageProbe() {
    renders.page++;
    return React.createElement("div", { "data-testid": "page-probe" }, "unrelated page");
  }

  function SelectorProbe() {
    renders.selector++;
    // Same slice GlobalTitleManager subscribes to.
    const chatCount = useCommsSelector((s) => s.totalUnread + s.totalThreadUnread);
    return React.createElement("div", { "data-testid": "selector-probe" }, String(chatCount));
  }

  function FullProbe() {
    renders.full++;
    const { totalUnread } = useCommsContext();
    return React.createElement("div", { "data-testid": "full-probe" }, String(totalUnread));
  }

  // Per-popup render probes (Task #3848): each subscribes to exactly the
  // slices an open CommsPopup needs — its OWN channel object and one user's
  // effective status. Activity elsewhere must leave them idle.
  function makePopupProbe(channelId: string, key: "popupCh1" | "popupCh2") {
    return function PopupProbe() {
      renders[key]++;
      const channel = useCommsSelector(
        (s: any) => s.channels.find((c: any) => c.id === channelId) ?? null,
      );
      return React.createElement(
        "div",
        { "data-testid": `popup-probe-${channelId}` },
        String(channel?.unreadCount ?? "none"),
      );
    };
  }
  function makeStatusProbe(userId: string, key: "statusA" | "statusB") {
    return function StatusProbe() {
      renders[key]++;
      const status = useCommsSelector(
        (s: any) => s.userStatuses.get(userId)?.effectiveStatus ?? "offline",
      );
      return React.createElement(
        "div",
        { "data-testid": `status-probe-${userId}` },
        status,
      );
    };
  }
  const PopupProbeCh1 = makePopupProbe("ch1", "popupCh1");
  const PopupProbeCh2 = makePopupProbe("ch2", "popupCh2");
  const StatusProbeA = makeStatusProbe("user-a", "statusA");
  const StatusProbeB = makeStatusProbe("user-b", "statusB");

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const container = document.getElementById("root")!;
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(
          CommsProvider,
          null,
          React.createElement(PageProbe),
          React.createElement(SelectorProbe),
          React.createElement(FullProbe),
          React.createElement(PopupProbeCh1),
          React.createElement(PopupProbeCh2),
          React.createElement(StatusProbeA),
          React.createElement(StatusProbeB),
        ),
      ),
    );
  });
  await flush();
  await flush();

  const text = (id: string) =>
    document.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

  section("Mount + initial channel load (2 unreads)");
  assert(text("selector-probe") === "2", `selector probe shows chat count 2 (got ${text("selector-probe")})`);
  assert(text("full-probe") === "2", `full-context probe shows totalUnread 2 (got ${text("full-probe")})`);
  const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  assert(!!es && es.url.includes("/api/comms/events"), "provider opened the SSE stream");

  // ── Presence churn: count unchanged → only comms surfaces re-render ────────
  section("comms:presence burst — page + selector probes stay idle");
  const base = { ...renders };
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      es.emit("comms:presence", { type: "comms:presence", userId: `u-${i}`, online: true });
    }
  });
  await flush();

  assert(
    renders.page === base.page,
    `unrelated page child did NOT re-render on presence events (got +${renders.page - base.page})`,
  );
  assert(
    renders.selector === base.selector,
    `narrow selector consumer did NOT re-render on presence events (got +${renders.selector - base.selector})`,
  );
  assert(
    renders.full > base.full,
    `whole-snapshot (comms surface) consumer DID re-render on presence events (got +${renders.full - base.full})`,
  );
  assert(
    renders.popupCh1 === base.popupCh1 && renders.popupCh2 === base.popupCh2,
    `per-popup channel probes did NOT re-render on presence events (got +${renders.popupCh1 - base.popupCh1}/+${renders.popupCh2 - base.popupCh2})`,
  );
  assert(
    renders.statusA === base.statusA && renders.statusB === base.statusB,
    `per-user status probes did NOT re-render on presence events (got +${renders.statusA - base.statusA}/+${renders.statusB - base.statusB})`,
  );

  // ── user_status for user-a: only user-a's status slice updates ─────────────
  section("comms:user_status(user-a) — only user-a's popup status dot re-renders");
  const preStatus = { ...renders };
  await act(async () => {
    es.emit("comms:user_status", {
      type: "comms:user_status",
      userId: "user-a",
      effectiveStatus: "dnd",
      manualStatus: "dnd",
      customEmoji: null,
      customText: null,
    });
  });
  await flush();
  assert(
    renders.statusA > preStatus.statusA,
    `user-a status probe re-rendered on its own status change (got +${renders.statusA - preStatus.statusA})`,
  );
  assert(
    text("status-probe-user-a") === "dnd",
    `user-a status probe shows dnd (got ${text("status-probe-user-a")})`,
  );
  assert(
    renders.statusB === preStatus.statusB,
    `user-b status probe stayed idle on user-a's change (got +${renders.statusB - preStatus.statusB})`,
  );
  assert(
    renders.popupCh1 === preStatus.popupCh1 && renders.popupCh2 === preStatus.popupCh2,
    `popup channel probes stayed idle on a status change (got +${renders.popupCh1 - preStatus.popupCh1}/+${renders.popupCh2 - preStatus.popupCh2})`,
  );
  assert(
    renders.page === preStatus.page,
    `unrelated page child stayed idle on a status change (got +${renders.page - preStatus.page})`,
  );

  // ── read_state zeroes the unread count → selector consumer updates ────────
  section("comms:read_state — chat count 2 → 0 reaches the selector consumer");
  const before = { ...renders };
  await act(async () => {
    es.emit("comms:read_state", { type: "comms:read_state", channelId: "ch1" });
  });
  await flush();

  assert(
    renders.selector > before.selector,
    `selector consumer re-rendered when its slice changed (got +${renders.selector - before.selector})`,
  );
  assert(text("selector-probe") === "0", `selector probe now shows 0 (got ${text("selector-probe")})`);
  assert(text("full-probe") === "0", `full probe now shows 0 (got ${text("full-probe")})`);
  assert(
    renders.page === before.page,
    `unrelated page child still never re-rendered (got +${renders.page - before.page})`,
  );
  // Task #3848: activity in channel ch1 must not re-render a popup open on ch2.
  // read_state replaces ch1's channel object (unread 2 → 0) but the provider
  // preserves ch2's object identity, so ch2's channel slice is unchanged.
  assert(
    renders.popupCh1 > before.popupCh1,
    `popup probe for the READ channel (ch1) re-rendered (got +${renders.popupCh1 - before.popupCh1})`,
  );
  assert(
    text("popup-probe-ch1") === "0",
    `popup probe ch1 shows unreadCount 0 (got ${text("popup-probe-ch1")})`,
  );
  assert(
    renders.popupCh2 === before.popupCh2,
    `popup probe for the OTHER channel (ch2) stayed idle — per-popup isolation (got +${renders.popupCh2 - before.popupCh2})`,
  );

  await act(async () => {
    root.unmount();
  });

  // ── Source guards: the wiring that makes this hold app-wide ────────────────
  section("Source guards");
  const titleSrc = readFileSync(
    join(process.cwd(), "client/src/components/GlobalTitleManager.tsx"),
    "utf-8",
  );
  assert(
    titleSrc.includes("useCommsSelector"),
    "GlobalTitleManager subscribes via the narrow useCommsSelector (not the whole context)",
  );
  assert(
    !titleSrc.includes("useCommsContext"),
    "GlobalTitleManager no longer uses the whole-snapshot useCommsContext",
  );
  const ctxSrc = readFileSync(
    join(process.cwd(), "client/src/contexts/CommsContext.tsx"),
    "utf-8",
  );
  assert(
    ctxSrc.includes("useSyncExternalStore"),
    "CommsContext publishes updates through useSyncExternalStore (stable store in context)",
  );
  // Task #3848: the popup surfaces themselves subscribe narrowly.
  // CommsRail joined them: per-field selectors + memoized rows, so presence
  // churn and other channels' activity leave the rail (and its rows) idle.
  for (const rel of [
    "client/src/components/comms/CommsPopupManager.tsx",
    "client/src/components/comms/MessagePane.tsx",
    "client/src/components/comms/Composer.tsx",
    "client/src/components/comms/MessageItem.tsx",
    "client/src/components/comms/CommsRail.tsx",
  ]) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    assert(
      src.includes("useCommsSelector"),
      `${rel} subscribes via the narrow useCommsSelector`,
    );
    assert(
      !src.includes("useCommsContext"),
      `${rel} no longer uses the whole-snapshot useCommsContext`,
    );
  }
  // The rail's per-channel row is memoized so identity-preserved channels
  // (Task #3848) skip re-rendering rows for channels that did not change.
  const railSrc = readFileSync(
    join(process.cwd(), "client/src/components/comms/CommsRail.tsx"),
    "utf-8",
  );
  assert(
    /const ExpandedChannelRow = memo\(/.test(railSrc),
    "CommsRail's ExpandedChannelRow is wrapped in React.memo",
  );
  assert(
    !railSrc.includes("onlineUserIds={onlineUserIds}"),
    "CommsRail no longer threads onlineUserIds through row props (presence churn stays out of the rail)",
  );

  console.log(`\n${passed} passed, ${failed} failed`);
}

main().then(
  () => process.exit(failed > 0 ? 1 : 0),
  (err) => {
    console.error("Test run crashed:", err);
    process.exit(1);
  },
);
