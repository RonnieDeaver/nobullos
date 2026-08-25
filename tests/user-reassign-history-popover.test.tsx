/* test-registration
{
  "name": "Active-user reassign-history popover (Task #2019)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/popover-mock-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Frontend coverage for the active-user Reassignments popover
 * (Task #1981 — rendered by ActiveUserReassignPopover in
 * client/src/pages/admin/UserManagement.tsx).
 *
 * Backend route coverage already exists (Task #1999,
 * tests/user-reassign-history-route.test.ts): it pins that
 * GET /api/users/reassign-history buckets the SAME audit rows by source
 * user for the default `out` direction and by destination user for
 * `direction=in`, newest-first, through a shared row-mapper. What had NO
 * coverage was the UI that renders that payload on active-user profiles.
 *
 * This test mocks the two /api/users/reassign-history responses exactly
 * as the UserManagement page consumes them:
 *
 *   - outbound map  = GET /api/users/reassign-history            (keyed by source user)
 *   - inbound  map  = GET /api/users/reassign-history?direction=in (keyed by destination user)
 *
 * It then renders ActiveUserReassignPopover with the per-user slices the
 * page passes (`reassignHistory?.[u.id]` / `inboundReassignHistory?.[u.id]`),
 * opens the popover, and asserts:
 *   - the trigger shows the combined inbound + outbound count
 *   - the "Inherited" (in) section names the from-user counterparties
 *   - the "Shed" (out) section names the to-user counterparties
 *   - moved counts (clients/threads/bookings) render per event
 *   - expandable item labels (clients / threads / bookings) render
 *   - newest-first ordering is preserved in each rendered list
 *
 * The mock payload shape mirrors the fixtures in
 * tests/user-reassign-history-route.test.ts so a divergence between the
 * route contract and what the popover expects would fail here.
 *
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
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  ActiveUserReassignPopover,
  type ReassignmentEvent,
} from "../client/src/pages/admin/UserManagement";

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

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

type ReassignHistoryMap = Record<string, ReassignmentEvent[]>;

// ─────────────────────────────────────────────────────────────────────────────
// Mocked /api/users/reassign-history payloads. Same three audit events as the
// backend route fixture (sam→alex newest, sam→jordan, pat→alex oldest), but
// here we focus on a single subject user "alex" who both inherited (in) and
// shed (out) work, so the popover renders both sections at once.
//
//   Inbound (alex inherited):
//     - sam  → alex  @ 30m  (clients 2, threads 1, bookings 1)  [newest]
//     - pat  → alex  @ 10m  (clients 0, threads 2, bookings 0)  [oldest]
//   Outbound (alex shed):
//     - alex → robin @ 50m  (clients 1, threads 0, bookings 0)  [newest]
//     - alex → dana  @ 40m  (clients 0, threads 0, bookings 1)  [oldest]
// ─────────────────────────────────────────────────────────────────────────────

const ALEX = "user-alex";

const t0 = new Date("2026-01-01T00:00:00Z");
const at = (n: number) => new Date(t0.getTime() + n * 60_000).toISOString();

const evSamToAlex: ReassignmentEvent = {
  id: "ev-sam-alex",
  actorId: "user-ceo",
  actorName: "Cleo Boss",
  timestamp: at(30),
  fromUserId: "user-sam",
  fromUserName: "Sam Source",
  toUserId: ALEX,
  toUserName: "Alex Dest",
  counts: { clients: 2, threads: 1, bookings: 1 },
  items: {
    clients: [
      { id: "c1", label: "Acme Co" },
      { id: "c2", label: "Beta LLC" },
    ],
    threads: [{ threadKey: "thread:abc" }],
    bookings: [{ id: "b1", label: "Intro call", startTimeUtc: "2026-02-01T15:00:00Z" }],
  },
};

const evPatToAlex: ReassignmentEvent = {
  id: "ev-pat-alex",
  actorId: "user-actor",
  actorName: "Audra Actor",
  timestamp: at(10),
  fromUserId: "user-pat",
  fromUserName: "Pat Source",
  toUserId: ALEX,
  toUserName: "Alex Dest",
  counts: { clients: 0, threads: 2, bookings: 0 },
  items: {
    clients: [],
    threads: [{ threadKey: "thread:xyz" }, { threadKey: "thread:qrs" }],
    bookings: [],
  },
};

const evAlexToRobin: ReassignmentEvent = {
  id: "ev-alex-robin",
  actorId: "user-ceo",
  actorName: "Cleo Boss",
  timestamp: at(50),
  fromUserId: ALEX,
  fromUserName: "Alex Dest",
  toUserId: "user-robin",
  toUserName: "Robin Target",
  counts: { clients: 1, threads: 0, bookings: 0 },
  items: {
    clients: [{ id: "c9", label: "Gamma Inc" }],
    threads: [],
    bookings: [],
  },
};

const evAlexToDana: ReassignmentEvent = {
  id: "ev-alex-dana",
  actorId: "user-actor",
  actorName: "Audra Actor",
  timestamp: at(40),
  fromUserId: ALEX,
  fromUserName: "Alex Dest",
  toUserId: "user-dana",
  toUserName: "Dana Target",
  counts: { clients: 0, threads: 0, bookings: 1 },
  items: {
    clients: [],
    threads: [],
    bookings: [{ id: "b9", label: "Review call", startTimeUtc: "2026-03-01T16:00:00Z" }],
  },
};

// Mocked responses, newest-first within each subject bucket (the route's
// ORDER BY guarantee). The page reads `map[u.id]` for the subject user.
const inboundMap: ReassignHistoryMap = {
  [ALEX]: [evSamToAlex, evPatToAlex],
};
const outboundMap: ReassignHistoryMap = {
  [ALEX]: [evAlexToRobin, evAlexToDana],
};

async function render(): Promise<Root> {
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(ActiveUserReassignPopover, {
        userId: ALEX,
        inboundEvents: inboundMap[ALEX] ?? [],
        outboundEvents: outboundMap[ALEX] ?? [],
      }),
    );
  });
  return root;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function orderOf(testIds: string[], ...ids: string[]): boolean {
  // True if `ids` appear in `testIds` in the given relative order.
  const positions = ids.map((id) => testIds.indexOf(`reassign-event-${id}`));
  if (positions.some((p) => p < 0)) return false;
  for (let i = 1; i < positions.length; i++) {
    if (positions[i - 1] >= positions[i]) return false;
  }
  return true;
}

async function main(): Promise<void> {
  section("Active-user Reassignments popover — trigger + both sections");

  const root = await render();

  // Trigger shows combined count (2 inbound + 2 outbound).
  const trigger = $(`button-reassign-history-${ALEX}`);
  assert(trigger != null, `trigger button-reassign-history-${ALEX} rendered`);
  assert(
    trigger?.textContent?.includes("Reassignments (4)") === true,
    `trigger shows combined inbound+outbound count "Reassignments (4)" (got '${trigger?.textContent?.trim()}')`,
  );

  // Open the popover.
  await click(trigger!);

  const popover = $(`popover-reassign-history-${ALEX}`);
  assert(popover != null, `popover-reassign-history-${ALEX} content rendered after open`);

  // Section headers present (Inherited = in, Shed = out).
  const text = document.body.textContent ?? "";
  assert(text.includes("Inherited (moved into this user)"), "Inherited (inbound) section header present");
  assert(text.includes("Shed (moved out of this user)"), "Shed (outbound) section header present");

  // Section containers and their non-empty state.
  assert($(`reassign-inbound-${ALEX}`) != null, "inbound section list rendered (non-empty)");
  assert($(`reassign-outbound-${ALEX}`) != null, "outbound section list rendered (non-empty)");
  assert($(`reassign-inbound-empty-${ALEX}`) == null, "inbound 'None' placeholder absent when events exist");
  assert($(`reassign-outbound-empty-${ALEX}`) == null, "outbound 'None' placeholder absent when events exist");

  section("Counterparty names — inbound shows from-user, outbound shows to-user");

  const samCard = $(`reassign-event-${evSamToAlex.id}`);
  assert(samCard != null, "inbound sam→alex event card rendered");
  assert(
    samCard?.textContent?.includes("moved from") === true &&
      samCard?.textContent?.includes("Sam Source") === true,
    `inbound card reads "moved from Sam Source" (got '${samCard?.textContent?.trim()}')`,
  );
  // total items moved = 2 + 1 + 1 = 4.
  assert(
    samCard?.textContent?.includes("4 items moved from") === true,
    `inbound sam→alex shows total moved = 4 (got '${samCard?.textContent?.trim()}')`,
  );

  const patCard = $(`reassign-event-${evPatToAlex.id}`);
  assert(
    patCard?.textContent?.includes("Pat Source") === true,
    "inbound pat→alex card names from-user Pat Source",
  );

  const robinCard = $(`reassign-event-${evAlexToRobin.id}`);
  assert(robinCard != null, "outbound alex→robin event card rendered");
  assert(
    robinCard?.textContent?.includes("moved to") === true &&
      robinCard?.textContent?.includes("Robin Target") === true,
    `outbound card reads "moved to Robin Target" (got '${robinCard?.textContent?.trim()}')`,
  );

  const danaCard = $(`reassign-event-${evAlexToDana.id}`);
  assert(
    danaCard?.textContent?.includes("Dana Target") === true,
    "outbound alex→dana card names to-user Dana Target",
  );

  section("Per-event moved counts (clients / threads / bookings)");

  // sam→alex: clients 2, threads 1, bookings 1.
  assert($(`reassign-clients-${evSamToAlex.id}`)?.textContent?.includes("Clients (2)") === true,
    "sam→alex clients count = 2");
  assert($(`reassign-threads-${evSamToAlex.id}`)?.textContent?.includes("Threads (1)") === true,
    "sam→alex threads count = 1");
  assert($(`reassign-bookings-${evSamToAlex.id}`)?.textContent?.includes("Bookings (1)") === true,
    "sam→alex bookings count = 1");
  // pat→alex has only threads (2) — clients/bookings sections omitted.
  assert($(`reassign-threads-${evPatToAlex.id}`)?.textContent?.includes("Threads (2)") === true,
    "pat→alex threads count = 2");
  assert($(`reassign-clients-${evPatToAlex.id}`) == null,
    "pat→alex omits the clients section (count 0)");
  assert($(`reassign-bookings-${evPatToAlex.id}`) == null,
    "pat→alex omits the bookings section (count 0)");

  section("Expandable item labels");

  assert($(`reassign-client-c1`)?.textContent?.includes("Acme Co") === true,
    "inbound client label 'Acme Co' rendered");
  assert($(`reassign-client-c2`)?.textContent?.includes("Beta LLC") === true,
    "inbound client label 'Beta LLC' rendered");
  assert($(`reassign-thread-thread:abc`)?.textContent?.includes("thread:abc") === true,
    "inbound thread label 'thread:abc' rendered");
  assert($(`reassign-booking-b1`)?.textContent?.includes("Intro call") === true,
    "inbound booking label 'Intro call' rendered");
  assert($(`reassign-thread-thread:xyz`) != null && $(`reassign-thread-thread:qrs`) != null,
    "both pat→alex thread labels rendered");
  assert($(`reassign-client-c9`)?.textContent?.includes("Gamma Inc") === true,
    "outbound client label 'Gamma Inc' rendered");
  assert($(`reassign-booking-b9`)?.textContent?.includes("Review call") === true,
    "outbound booking label 'Review call' rendered");

  section("Newest-first ordering preserved within each section");

  const cardTestIds = Array.from(document.querySelectorAll("[data-testid^='reassign-event-']")).map(
    (el) => el.getAttribute("data-testid") ?? "",
  );
  // Inbound: sam→alex (30m) before pat→alex (10m).
  assert(orderOf(cardTestIds, evSamToAlex.id, evPatToAlex.id),
    "inbound list newest-first: sam→alex before pat→alex");
  // Outbound: alex→robin (50m) before alex→dana (40m).
  assert(orderOf(cardTestIds, evAlexToRobin.id, evAlexToDana.id),
    "outbound list newest-first: alex→robin before alex→dana");

  await unmount(root);

  section("Empty state — renders nothing when neither side has events");

  const emptyRoot = (() => {
    const container = document.getElementById("root")!;
    container.innerHTML = "";
    return createRoot(container);
  })();
  await act(async () => {
    emptyRoot.render(
      React.createElement(ActiveUserReassignPopover, {
        userId: "user-nobody",
        inboundEvents: [],
        outboundEvents: [],
      }),
    );
  });
  assert($(`button-reassign-history-user-nobody`) == null,
    "no trigger rendered when both inbound and outbound are empty");
  await unmount(emptyRoot);

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.error("user-reassign-history-popover: FAILED");
    process.exit(1);
  }
  console.log("user-reassign-history-popover: PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("user-reassign-history-popover: FAILED");
  console.error(err);
  process.exit(1);
});
