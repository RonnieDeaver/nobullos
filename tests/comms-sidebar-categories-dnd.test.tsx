/* test-registration
{
  "name": "Comms sidebar categories drag-and-drop — within-category reorder (PUT channels/order with correct slot), cross-category move (DELETE→POST in order), residual↔custom moves (POST-only / DELETE-only), same-category no-op, category header reorder (PUT categories/order), optimistic DOM order, no rollback refetch on success (Task #3416)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3416: sidebar categories drag-and-drop can't silently fail — mounts the REAL CommsProvider + CommsSidebarCategories and asserts every drag shape fires the exact API calls in order (within-category PUT channels/order, cross-category DELETE→POST, residual POST-only / DELETE-only, same-category no-op, category-header PUT categories/order) with optimistic DOM reorder and no rollback refetch. DB-free, network-free.",
  "extraNodeArgs": [
    "--import",
    "./tests/comms-sidebar-categories-dnd-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Rendered coverage for drag-and-drop conversation sorting in the comms
 * sidebar categories UI (Task #3416).
 *
 * The server routes are covered by tests/comms-sidebar-categories.test.ts,
 * but the component's drag interactions had no UI-level test — a regression
 * would look like drags that "do nothing" or reorder to the wrong slot.
 *
 * Mounts the REAL CommsProvider (CommsContext.tsx) + the real
 * CommsSidebarCategories component in jsdom, with a fetch stub recording
 * every mutating API call, and asserts:
 *   - drag within an explicit category → ONE
 *     PUT /api/comms/sidebar/categories/:id/channels/order with the channel
 *     spliced into the correct slot, and the DOM order updates optimistically;
 *   - drag between explicit categories → DELETE (old category) then POST
 *     (new category), in that order;
 *   - drag from a residual built-in section into a custom category → POST
 *     only (no DELETE — the channel had no explicit assignment);
 *   - drag from a custom category onto a residual built-in section →
 *     DELETE only;
 *   - dropping a channel back onto its own category → NO API call;
 *   - dragging a category header onto another category →
 *     PUT /api/comms/sidebar/categories/order with the full reordered id list.
 *
 * DB-free, network-free. Run with TSX_TSCONFIG_PATH=./tsconfig.tests.json and
 * --import ./tests/comms-sidebar-categories-dnd-setup.mjs.
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

// Inert EventSource — CommsProvider opens one SSE stream on mount.
class FakeEventSource {
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
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

function makeChannel(id: string, type: "channel" | "dm" = "channel") {
  return {
    id,
    name: id,
    slug: id,
    type,
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
  };
}

const CHANNELS = [
  makeChannel("c1"),
  makeChannel("c2"),
  makeChannel("c3"),
  makeChannel("c4"),
  makeChannel("c5"),
  // c6 stays residual for the whole test so the built-in Channels section
  // remains a visible drop target (DELETE-only branch in step 4).
  makeChannel("c6"),
];

function makeCategory(
  id: string,
  type: "favorites" | "custom" | "channels" | "dms",
  channelIds: string[],
  sortOrder: number,
) {
  return {
    id,
    userId: "user-me",
    name: id,
    type,
    sortOrder,
    collapsed: false,
    sorting: type === "favorites" || type === "custom" ? "manual" : "recent",
    unreadsOnTop: false,
    channelIds,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const CATEGORIES = [
  makeCategory("fav", "favorites", ["c1", "c2", "c3"], 0),
  makeCategory("cust", "custom", ["c4"], 1),
  makeCategory("chn", "channels", [], 2),
  makeCategory("dm", "dms", [], 3),
];

// ─── Fetch stub — records every mutating call in order ──────────────────────

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

const calls: RecordedCall[] = [];
let categoryListGets = 0;

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      method: "GET",
      path: /\/api\/comms\/sidebar\/categories(\?|$)/,
      json: () => {
        categoryListGets++;
        return CATEGORIES;
      },
    },
    { method: "GET", path: /\/api\/comms\/channels(\?|$)/, json: [] },
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
    calls.push({ method, url, body });
  },
}) as typeof fetch;

// ─── Drag-event helpers ──────────────────────────────────────────────────────

function byTestId(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`element not rendered: ${id}`);
  return el;
}

function makeDragEvent(type: string) {
  const ev = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", {
    value: {
      effectAllowed: "",
      dropEffect: "",
      setData: () => {},
      getData: () => "",
      types: [],
      files: [],
      items: [],
    },
  });
  return ev;
}

async function fire(el: HTMLElement, type: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(makeDragEvent(type));
  });
}

/** Simulate dragging `sourceTestId` and dropping it on `targetTestId`. */
async function drag(sourceTestId: string, targetTestId: string): Promise<void> {
  await fire(byTestId(sourceTestId), "dragstart");
  const target = byTestId(targetTestId);
  await fire(target, "dragover");
  await fire(target, "drop");
  // Flush the apiRequest promise chain (DELETE → POST for moves).
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Rendered channel ids inside a category, in DOM order. */
function itemIdsIn(categoryId: string): string[] {
  const container = byTestId(`rail-category-${categoryId}`);
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-testid^='rail-category-item-']"),
  ).map((el) => el.getAttribute("data-testid")!.replace(`rail-category-item-${categoryId}-`, ""));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { CommsProvider } = await import("../client/src/contexts/CommsContext");
  const { CommsSidebarCategories } = await import(
    "../client/src/components/comms/CommsSidebarCategories"
  );
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

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
          React.createElement(CommsSidebarCategories, {
            channels: CHANNELS as any,
            renderChannel: (ch: any) =>
              React.createElement("span", { "data-testid": `chan-label-${ch.id}` }, ch.id),
          }),
        ),
      ),
    );
  });
  // Let the provider's mount fetches (categories, channels, drafts) settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  section("Initial render");
  assert(
    document.querySelector('[data-testid="rail-sidebar-categories"]') != null,
    "sidebar categories container renders",
  );
  assert(categoryListGets === 1, "categories fetched exactly once on mount");
  assert(
    JSON.stringify(itemIdsIn("fav")) === JSON.stringify(["c1", "c2", "c3"]),
    "favorites renders c1,c2,c3 in server order",
  );
  assert(
    JSON.stringify(itemIdsIn("cust")) === JSON.stringify(["c4"]),
    "custom category renders c4",
  );
  assert(
    JSON.stringify(itemIdsIn("chn")) === JSON.stringify(["c5", "c6"]),
    "built-in Channels shows residual c5,c6",
  );

  // ── 1. Reorder within an explicit category ────────────────────────────────
  section("Drag within a category → PUT channels/order with the new order");
  calls.length = 0;
  await drag("rail-category-item-fav-c1", "rail-category-item-fav-c3");

  assert(calls.length === 1, `exactly one API call fired (got ${calls.length})`);
  assert(
    calls[0]?.method === "PUT" &&
      calls[0]?.url === "/api/comms/sidebar/categories/fav/channels/order",
    "call is PUT /api/comms/sidebar/categories/fav/channels/order",
  );
  assert(
    JSON.stringify((calls[0]?.body as any)?.orderedChannelIds) ===
      JSON.stringify(["c2", "c3", "c1"]),
    "body carries the reordered list [c2,c3,c1] (c1 dropped onto c3's slot)",
  );
  assert(
    JSON.stringify(itemIdsIn("fav")) === JSON.stringify(["c2", "c3", "c1"]),
    "DOM order updates optimistically to c2,c3,c1",
  );

  // ── 2. Move between explicit categories ──────────────────────────────────
  section("Drag between categories → DELETE old, then POST new, in order");
  calls.length = 0;
  await drag("rail-category-item-fav-c2", "rail-category-cust");

  assert(calls.length === 2, `exactly two API calls fired (got ${calls.length})`);
  assert(
    calls[0]?.method === "DELETE" &&
      calls[0]?.url === "/api/comms/sidebar/categories/fav/channels/c2",
    "first call is DELETE from the source category",
  );
  assert(
    calls[1]?.method === "POST" &&
      calls[1]?.url === "/api/comms/sidebar/categories/cust/channels" &&
      (calls[1]?.body as any)?.channelId === "c2",
    "second call is POST {channelId:c2} to the target category",
  );
  assert(
    JSON.stringify(itemIdsIn("fav")) === JSON.stringify(["c3", "c1"]),
    "favorites no longer contains c2",
  );
  assert(
    JSON.stringify(itemIdsIn("cust")) === JSON.stringify(["c4", "c2"]),
    "custom category appends c2",
  );

  // ── 3. Residual built-in → custom category (no explicit source) ──────────
  section("Drag from a residual built-in into a custom category → POST only");
  calls.length = 0;
  await drag("rail-category-item-chn-c5", "rail-category-cust");

  assert(calls.length === 1, `exactly one API call fired (got ${calls.length})`);
  assert(
    calls[0]?.method === "POST" &&
      calls[0]?.url === "/api/comms/sidebar/categories/cust/channels" &&
      (calls[0]?.body as any)?.channelId === "c5",
    "single POST {channelId:c5} to the custom category (no DELETE — residual source)",
  );
  assert(
    JSON.stringify(itemIdsIn("cust")) === JSON.stringify(["c4", "c2", "c5"]),
    "custom category appends c5",
  );

  // ── 4. Custom category → residual built-in (drop back) ───────────────────
  section("Drag from a custom category onto a built-in section → DELETE only");
  calls.length = 0;
  // c6 has stayed residual, so the built-in Channels section is still a
  // visible drop target. Dropping cust's c5 there removes its explicit
  // assignment (toCategoryId = null) — DELETE only, no POST.
  await drag("rail-category-item-cust-c5", "rail-category-chn");
  assert(calls.length === 1, `exactly one API call fired (got ${calls.length})`);
  assert(
    calls[0]?.method === "DELETE" &&
      calls[0]?.url === "/api/comms/sidebar/categories/cust/channels/c5",
    "single DELETE removes the explicit assignment (no POST — residual target)",
  );
  assert(
    JSON.stringify(itemIdsIn("cust")) === JSON.stringify(["c4", "c2"]),
    "custom category no longer contains c5",
  );
  assert(
    itemIdsIn("chn").includes("c5"),
    "c5 reappears in the residual built-in Channels section",
  );

  // ── 5. Drop back onto the same category → no API call ────────────────────
  section("Drop onto the source category itself → no API call");
  calls.length = 0;
  await drag("rail-category-item-cust-c4", "rail-category-cust");
  assert(calls.length === 0, "no API call fired for a same-category drop");

  // ── 6. Category header reorder ────────────────────────────────────────────
  section("Drag a category header onto another category → PUT categories/order");
  calls.length = 0;
  await drag("rail-category-header-cust", "rail-category-fav");

  assert(calls.length === 1, `exactly one API call fired (got ${calls.length})`);
  assert(
    calls[0]?.method === "PUT" && calls[0]?.url === "/api/comms/sidebar/categories/order",
    "call is PUT /api/comms/sidebar/categories/order",
  );
  assert(
    JSON.stringify((calls[0]?.body as any)?.orderedIds) ===
      JSON.stringify(["cust", "fav", "chn", "dm"]),
    "body carries the full reordered category id list [cust,fav,chn,dm]",
  );
  {
    const containers = Array.from(
      document.querySelectorAll<HTMLElement>("[data-testid^='rail-category-'][data-testid$='fav'], [data-testid^='rail-category-'][data-testid$='cust']"),
    )
      .map((el) => el.getAttribute("data-testid"))
      .filter((id) => id === "rail-category-fav" || id === "rail-category-cust");
    assert(
      JSON.stringify(containers) === JSON.stringify(["rail-category-cust", "rail-category-fav"]),
      "custom category now renders above favorites (optimistic reorder)",
    );
  }

  // ── 7. Success path never triggered a rollback refetch ───────────────────
  section("No silent rollback");
  assert(
    categoryListGets === 1,
    "categories were never refetched (no rollback — every mutation succeeded)",
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
