/* test-registration
{
  "name": "Comms rail Clients sub-group collapse — default-collapsed from server (clientSubgroupCollapsed), badged-only notification peek + aggregate badge (mentions precedence), toggle → optimistic open + one PATCH, remount with persisted value stays open, 5-event comms:message SSE burst → exactly one debounced (800ms) channels refetch (Task #3547)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3547: Clients sub-group in the built-in Channels category — default-collapsed from the server's clientSubgroupCollapsed flag, badged-only notification peek + aggregate header badge, toggle → one persisting PATCH, remount with the persisted value stays open, and a 5-event comms:message SSE burst collapses into exactly one debounced (800ms) channels refetch. DB-free, network-free.",
  "extraNodeArgs": [
    "--import",
    "./tests/comms-clients-subgroup-collapse-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Rendered coverage for the client-channels ("Clients") sub-group inside the
 * built-in Channels category of CommsSidebarCategories (Task #3547).
 *
 * The sub-group's collapsed/expanded state is persisted SERVER-SIDE on the
 * "channels" sidebar category (`clientSubgroupCollapsed`, DB default true) —
 * not in localStorage — so "survives a page reload" means: toggle → PATCH
 * /api/comms/sidebar/categories/:id, and a fresh mount seeded with the
 * persisted value renders the same state.
 *
 * Mounts the REAL CommsProvider + REAL CommsSidebarCategories in jsdom with a
 * fetch stub, and asserts:
 *   - default-collapsed on first visit (server default clientSubgroupCollapsed
 *     = true) — non-client channels visible, unbadged client channels hidden;
 *   - notification peek: client channels WITH unread/mention badges still
 *     render while the sub-group is collapsed;
 *   - collapsed-header badge shows the aggregate count (mentions take
 *     precedence per channel, else unreads);
 *   - toggle → sub-group opens optimistically (all client channels visible,
 *     badge gone) and exactly one PATCH persists clientSubgroupCollapsed:false;
 *   - remount ("page reload") with the persisted value → renders open, no
 *     further PATCH;
 *   - a burst of 5 rapid comms:message SSE events triggers exactly ONE
 *     debounced GET /api/comms/channels, only after the 800ms window.
 *
 * DB-free, network-free. Run with TSX_TSCONFIG_PATH=./tsconfig.tests.json and
 * --import ./tests/comms-clients-subgroup-collapse-setup.mjs.
 * Registered in tests/run-all.ts.
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
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
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

function makeChannel(
  id: string,
  opts: { clientId?: string | null; unreadCount?: number; mentionCount?: number } = {},
) {
  return {
    id,
    name: id,
    slug: id,
    type: "channel" as const,
    visibility: "public",
    topic: null,
    description: null,
    clientId: opts.clientId ?? null,
    createdBy: "user-me",
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    unreadCount: opts.unreadCount ?? 0,
    mentionCount: opts.mentionCount ?? 0,
    members: [],
    lastMessageAt: NOW,
  };
}

// One regular channel + three client channels:
//   cl-unread  → unread 3, no mentions  → contributes 3 to the badge
//   cl-mention → mention 2 (unread 5)   → mentions win → contributes 2
//   cl-quiet   → no badges              → contributes 0, hidden when collapsed
const CHANNELS = [
  makeChannel("reg1"),
  makeChannel("cl-unread", { clientId: "c-abc", unreadCount: 3 }),
  makeChannel("cl-mention", { clientId: "c-abc", unreadCount: 5, mentionCount: 2 }),
  makeChannel("cl-quiet", { clientId: "c-abc" }),
];
const EXPECTED_BADGE = 5; // 3 (unread) + 2 (mention precedence)

function makeCategories(clientSubgroupCollapsed: boolean) {
  return [
    {
      id: "chn",
      userId: "user-me",
      name: "Channels",
      type: "channels",
      sortOrder: 0,
      collapsed: false,
      clientSubgroupCollapsed,
      sorting: "recent",
      unreadsOnTop: false,
      channelIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
}

// Mutable server state — the "reload" scenario flips this to simulate the
// persisted value being served on the next visit.
let serverCategories = makeCategories(true);

// ─── Fetch stub ──────────────────────────────────────────────────────────────

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

const mutations: RecordedCall[] = [];
let channelsGets = 0;

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      method: "GET",
      path: /\/api\/comms\/sidebar\/categories(\?|$)/,
      json: () => serverCategories.map((c) => ({ ...c })),
    },
    {
      method: "GET",
      path: /\/api\/comms\/channels(\?|$)/,
      json: () => {
        channelsGets++;
        return [];
      },
    },
    { method: "GET", path: /\/api\/comms\/drafts(\?|$)/, json: [] },
    { method: "GET", path: /\/api\/comms\/threads(\?|$)/, json: [] },
  ],
  defaultJson: {},
  onCall: ({ url, method, init }) => {
    if (method === "GET") return;
    let body: unknown = null;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    mutations.push({ method, url, body });
  },
}) as typeof fetch;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function q(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function visibleClientItemIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-testid^='rail-category-item-chn-cl-']"),
  ).map((el) => el.getAttribute("data-testid")!.replace("rail-category-item-chn-", ""));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { CommsProvider } = await import("../client/src/contexts/CommsContext");
  const { CommsSidebarCategories } = await import(
    "../client/src/components/comms/CommsSidebarCategories"
  );
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

  const container = document.getElementById("root")!;

  async function mount(): Promise<Root> {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: qc },
          React.createElement(
            CommsProvider,
            null,
            React.createElement(CommsSidebarCategories, {
              channels: CHANNELS as any,
              renderChannel: (ch: any) =>
                React.createElement("span", { "data-testid": `chan-label-${ch.id}` }, ch.id),
            }),
          ),
        ),
      );
    });
    await flush();
    return root;
  }

  // ── 1. First visit: server default is collapsed ───────────────────────────
  section("Default-collapsed on first visit (server default clientSubgroupCollapsed=true)");
  let root = await mount();

  assert(q("rail-clients-sub-group") != null, "Clients sub-group renders");
  assert(q("rail-clients-subgroup-toggle") != null, "Clients sub-group toggle renders");
  assert(
    q("rail-category-item-chn-reg1") != null,
    "non-client channel reg1 renders normally outside the sub-group",
  );
  assert(
    JSON.stringify(visibleClientItemIds()) === JSON.stringify(["cl-mention", "cl-unread"]),
    "collapsed peek: only badged client channels are visible (cl-mention first — recency sorts by unread desc)",
  );
  assert(
    q("rail-category-item-chn-cl-quiet") == null,
    "unbadged client channel cl-quiet is hidden while collapsed",
  );

  section("Aggregate badge on the collapsed header");
  const badge = q("rail-clients-subgroup-badge");
  assert(badge != null, "collapsed header shows the aggregate badge");
  assert(
    badge?.textContent === String(EXPECTED_BADGE),
    `badge shows ${EXPECTED_BADGE} (3 unreads + 2 mentions-take-precedence; got "${badge?.textContent}")`,
  );

  // ── 2. Toggle open → optimistic UI + one persisting PATCH ─────────────────
  section("Toggle → opens optimistically and persists via PATCH");
  mutations.length = 0;
  await act(async () => {
    q("rail-clients-subgroup-toggle")!.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  await flush();

  assert(
    JSON.stringify(visibleClientItemIds()) ===
      JSON.stringify(["cl-mention", "cl-unread", "cl-quiet"]),
    "open: ALL client channels visible, including unbadged cl-quiet",
  );
  assert(q("rail-clients-subgroup-badge") == null, "badge hidden while open");
  assert(mutations.length === 1, `exactly one mutating call fired (got ${mutations.length})`);
  assert(
    mutations[0]?.method === "PATCH" &&
      mutations[0]?.url === "/api/comms/sidebar/categories/chn" &&
      (mutations[0]?.body as any)?.clientSubgroupCollapsed === false,
    "call is PATCH /api/comms/sidebar/categories/chn {clientSubgroupCollapsed:false}",
  );

  await act(async () => {
    root.unmount();
  });

  // ── 3. "Page reload": fresh mount served the persisted open state ─────────
  section("Remount with the persisted value → stays open (survives reload)");
  serverCategories = makeCategories(false); // what the PATCH persisted
  mutations.length = 0;
  root = await mount();

  assert(
    JSON.stringify(visibleClientItemIds()) ===
      JSON.stringify(["cl-mention", "cl-unread", "cl-quiet"]),
    "after remount the sub-group renders open (all client channels visible)",
  );
  assert(q("rail-clients-subgroup-badge") == null, "no badge after remount while open");
  assert(mutations.length === 0, "remount itself issues no mutating calls");

  // ── 4. SSE burst → ONE debounced fetchChannels after 800ms ────────────────
  section("5 rapid comms:message SSE events → exactly one debounced channels refetch");
  const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  assert(!!es && es.url.includes("/api/comms/events"), "provider opened the SSE stream");

  const baseline = channelsGets;
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      es.emit("comms:message", { type: "comms:message", channelId: "reg1" });
    }
  });
  assert(
    channelsGets === baseline,
    `no immediate refetch inside the debounce window (got ${channelsGets - baseline})`,
  );
  await sleep(400);
  assert(
    channelsGets === baseline,
    "still no refetch at 400ms (debounce window is 800ms)",
  );
  await sleep(700); // 1100ms total — past the 800ms window
  await flush();
  assert(
    channelsGets === baseline + 1,
    `exactly ONE channels refetch after the 800ms window (got ${channelsGets - baseline})`,
  );

  // A second burst after the window fires exactly one more.
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      es.emit("comms:message", { type: "comms:message", channelId: "reg1" });
    }
  });
  await sleep(1100);
  await flush();
  assert(
    channelsGets === baseline + 2,
    `a second burst fires exactly one more refetch (got ${channelsGets - baseline})`,
  );

  await act(async () => {
    root.unmount();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
}

main().then(
  () => process.exit(failed > 0 ? 1 : 0),
  (err) => {
    console.error("Test run crashed:", err);
    process.exit(1);
  },
);
