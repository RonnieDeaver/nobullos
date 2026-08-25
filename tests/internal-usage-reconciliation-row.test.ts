/* test-registration
{
  "name": "Internal usage — historical/unattributed reconciliation row in the member table (jsdom)",
  "regression": true,
  "smoke": true,
  "smokeReason": "The reconciliation row exists so the member table visibly accounts for activity that can never be attributed to a person (the prod '11 agent chats vs all-zero member rows' confusion). If it silently vanishes, shows wrong counts, renders when there is nothing to reconcile, or absorbs into member rows, the accuracy dashboard reads as broken again. Mounts the REAL InternalUsage page in jsdom against stubbed auth + report payloads. DB-free, network-free, ~2s.",
  "extraNodeArgs": [
    "--import",
    "./tests/internal-usage-reconciliation-setup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test",
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Internal usage report — reconciliation row for unattributed activity.
 *
 * Mounts the REAL InternalUsage page (client/src/pages/admin/InternalUsage.tsx)
 * in jsdom with stubbed GET /api/auth/user (team_lead) and
 * GET /api/internal-usage payloads, and pins the task's contract:
 *
 *   1. When any unattributed bucket is nonzero, the member table renders a
 *      pinned "Historical — no recorded sender" pseudo-row AFTER the member
 *      rows, visually marked "Not a team member", carrying the per-bucket
 *      counts (bookings/SMS/calls/agent chat; intel deliberately has no
 *      bucket) and their sum — so member rows + this row visibly add up to
 *      the top cards.
 *   2. Expanding the row lists which clients the historical agent chats
 *      belong to (from the report's per-client breakdown the API already
 *      returns), including the no-linked-client bucket, with client links.
 *   3. The Agent chats card sublabel says the chats predate sender tracking
 *      and cannot be counted toward a person (not the terse old wording),
 *      and the footnote names the reconciliation row.
 *   4. Member rows are untouched: real counts render as before, a zero
 *      agent-chat cell still gets the red gap treatment, and nothing from
 *      the unattributed buckets leaks into a member row.
 *   5. When every unattributed bucket is zero, the pseudo-row (and its
 *      drill-down) does not render at all.
 *   6. Edge: unattributed activity with zero members still renders the table
 *      (not the "No team members found." empty state).
 *
 * DB-free / network-free. Harness per memory notes
 * mount-large-client-component-jsdom + jsdom-globals-before-react-dom-eval:
 * jsdom globals installed before the dynamic client imports, CSS stubbed via
 * the shared heavy-client loader (setup: internal-usage-reconciliation-setup
 * .mjs), fetch stubbed via tests/helpers/createFetchStub.mjs.
 */
import { strict as assert } from "node:assert";

import { JSDOM } from "jsdom";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .mjs helper without type declarations
import { createFetchStub } from "./helpers/createFetchStub.mjs";

// ── jsdom bootstrap (must precede the dynamic client imports) ──
const dom = new JSDOM(
  "<!doctype html><html><body></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/admin/internal-usage" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number;
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
if (!(globalThis as any).IS_REACT_ACT_ENVIRONMENT) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
}

// ── Fixtures (shape mirrors server/storage/internalUsageStorage.ts) ──

const TL_USER = {
  id: "tl-1",
  email: "tessa@nobullmarketing.com",
  firstName: "Tessa",
  lastName: "Lead",
  role: "team_lead",
};

const CL_1 = "cl-recon-1";
const CL_2 = "cl-recon-2";

function makeMember(agentChat: number) {
  const counts = {
    bookings: 3,
    bookingsDirect: 2,
    bookingsPublicLink: 1,
    sms: 7,
    calls: 3,
    intel: 6,
    agentChat,
  };
  return {
    userId: "am-alice",
    firstName: "Alice",
    lastName: "Alpha",
    email: "alice@nobullmarketing.com",
    role: "account_manager",
    counts,
    total: counts.bookings + counts.sms + counts.calls + counts.intel + counts.agentChat,
    assignedClientCount: 1,
    clientsWithNoActivity: 0,
    clients: [
      {
        clientId: CL_1,
        firmName: "Firm One",
        counts,
        total: counts.bookings + counts.sms + counts.calls + counts.intel + counts.agentChat,
        agentChatUnattributed: 0,
        othersActivity: 0,
        noActivity: false,
      },
    ],
  };
}

// Mirrors the prod situation that motivated the task: the Agent chats card
// shows 11 while every member row shows 0, because all 11 chats predate
// sender tracking. Bookings/SMS/calls also carry unattributed buckets to
// prove the forward-proofing columns.
const REPORT_WITH_UNATTRIBUTED = {
  days: 30,
  since: "2026-07-07T00:00:00.000Z",
  until: "2026-08-06T00:00:00.000Z",
  totals: {
    bookings: 5,
    bookingsDirect: 2,
    bookingsPublicLink: 3,
    bookingsAttributed: 3,
    bookingsUnattributed: 2,
    sms: 10,
    smsAttributed: 7,
    smsUnattributed: 3,
    calls: 4,
    callsAttributed: 3,
    callsUnattributed: 1,
    intel: 6,
    agentChat: 11,
    agentChatAttributed: 0,
    agentChatUnattributed: 11,
  },
  members: [makeMember(0)],
  unattributedAgentChat: [
    { clientId: CL_1, firmName: "Firm One", count: 7 },
    { clientId: CL_2, firmName: "Firm Two", count: 3 },
    { clientId: null, firmName: null, count: 1 },
  ],
};

// Same window with every unattributed bucket at zero — the pseudo-row must
// not render at all.
const REPORT_ALL_ATTRIBUTED = {
  days: 30,
  since: "2026-07-07T00:00:00.000Z",
  until: "2026-08-06T00:00:00.000Z",
  totals: {
    bookings: 3,
    bookingsDirect: 2,
    bookingsPublicLink: 1,
    bookingsAttributed: 3,
    bookingsUnattributed: 0,
    sms: 7,
    smsAttributed: 7,
    smsUnattributed: 0,
    calls: 3,
    callsAttributed: 3,
    callsUnattributed: 0,
    intel: 6,
    agentChat: 2,
    agentChatAttributed: 2,
    agentChatUnattributed: 0,
  },
  members: [makeMember(2)],
  unattributedAgentChat: [],
};

// Edge: unattributed activity but zero members — the table (with only the
// pseudo-row) must render instead of the "No team members found." empty state.
const REPORT_NO_MEMBERS = {
  ...REPORT_WITH_UNATTRIBUTED,
  members: [],
};

// ── Harness ──

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
  }
}

const $t = (id: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const tText = (id: string): string => $t(id)?.textContent ?? "";

async function run(): Promise<void> {
  console.log("Internal usage — reconciliation row render contract");

  const React = (await import("react")).default as any;
  const { createRoot } = (await import("react-dom/client")) as any;
  const { act } = (await import("react")) as any;
  const { QueryClient, QueryClientProvider } = (await import("@tanstack/react-query")) as any;
  const InternalUsage = (await import("@/pages/admin/InternalUsage")).default as any;

  const flush = async (times = 10) => {
    for (let i = 0; i < times; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };

  const click = async (el: HTMLElement) => {
    await act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush(3);
  };

  // Mounts the page against a given report payload; the caller must await
  // cleanup() before the next mount so testids never collide across scenarios.
  const mountPage = async (report: unknown) => {
    globalThis.fetch = createFetchStub({
      Headers: dom.window.Headers,
      routes: [
        { path: "/api/auth/user", json: TL_USER },
        // Wins-weekly must precede the bare prefix below: createFetchStub is
        // first-match startsWith, and the page crashes on a report-shaped
        // payload (winReport.summary undefined).
        // One synthetic tracked member keeps the win card in its data state:
        // its empty state reuses the exact "No team members found." string the
        // member-table scenario C pins as absent.
        {
          path: "/api/internal-usage/wins-weekly",
          json: {
            weeks: [],
            members: [{ userId: "win-am-1", firstName: "Win", lastName: "Tracker", email: "win-tracker@nobull.test", weeks: [], total: 0 }],
            summary: { accountManagers: 1, metThisWeek: 0 },
            generatedAt: "2026-08-17T00:00:00.000Z",
          },
        },
        { path: "/api/internal-usage", json: report },
      ],
      defaultJson: {},
    }) as any;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const container = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(InternalUsage),
        ),
      );
    });
    await flush();
    return {
      cleanup: async () => {
        await act(async () => {
          root.unmount();
        });
        container.remove();
        queryClient.clear();
      },
    };
  };

  // ── Scenario A: unattributed buckets nonzero ──
  {
    const { cleanup } = await mountPage(REPORT_WITH_UNATTRIBUTED);
    try {
      await check("member row renders untouched (agent chat 0 keeps the red gap cell)", () => {
        assert.ok($t("row-member-am-alice"), "Alice's member row renders");
        assert.equal(tText("cell-am-alice-bookings"), "3", "Alice bookings count");
        assert.equal(tText("cell-am-alice-sms"), "7", "Alice SMS count");
        assert.equal(tText("cell-am-alice-calls"), "3", "Alice calls count");
        assert.equal(tText("cell-am-alice-agentChat"), "0", "Alice agent-chat cell still shows 0");
      });

      await check("reconciliation row renders, pinned after member rows, clearly non-member", () => {
        const row = $t("row-unattributed");
        assert.ok(row, "pseudo-row renders when unattributed buckets are nonzero");
        const label = row!.textContent ?? "";
        assert.ok(label.includes("Historical — no recorded sender"), "row carries the historical label");
        assert.ok(label.includes("Not a team member"), "row explicitly says it is not a team member");
        const memberRow = $t("row-member-am-alice")!;
        assert.ok(
          // eslint-disable-next-line no-bitwise
          memberRow.compareDocumentPosition(row!) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
          "pseudo-row is pinned AFTER the member rows",
        );
      });

      await check("pseudo-row carries every unattributed bucket + their sum", () => {
        assert.equal(tText("cell-unattributed-bookings"), "2", "unattributed bookings");
        assert.equal(tText("cell-unattributed-sms"), "3", "unattributed SMS");
        assert.equal(tText("cell-unattributed-calls"), "1", "unattributed calls");
        assert.equal(tText("cell-unattributed-agentChat"), "11", "historical agent chats");
        assert.equal(tText("cell-unattributed-intel"), "—", "intel has no unattributed bucket — em dash");
        assert.equal(tText("cell-unattributed-total"), "17", "row total = 2+3+1+11");
      });

      await check("columns visibly reconcile: member rows + pseudo-row = top cards", () => {
        assert.ok(tText("card-total-bookings").includes("5"), "bookings card total");
        assert.equal(
          Number(tText("cell-am-alice-bookings")) + Number(tText("cell-unattributed-bookings")),
          5,
          "bookings: member 3 + historical 2 = card 5",
        );
        assert.ok(tText("card-total-agent-chat").includes("11"), "agent chats card total");
        assert.equal(
          Number(tText("cell-am-alice-agentChat")) + Number(tText("cell-unattributed-agentChat")),
          11,
          "agent chats: member 0 + historical 11 = card 11",
        );
      });

      await check("Agent chats card sublabel explains pre-tracking, not the terse old wording", () => {
        const sub = tText("text-agent-chat-unattributed");
        assert.ok(sub.includes("11"), "sublabel carries the count");
        assert.ok(sub.includes("before sender tracking"), "sublabel says chats predate sender tracking");
        assert.ok(sub.toLowerCase().includes("person"), "sublabel says they cannot be counted toward a person");
        assert.ok(!sub.includes("historical (no sender)"), "terse old sublabel is gone");
      });

      await check("footnote names the reconciliation row", () => {
        const note = tText("text-member-footnote");
        assert.ok(note.includes("Historical — no recorded sender"), "footnote references the row by name");
        assert.ok(note.includes("before sender tracking existed"), "footnote explains why no person can be credited");
      });

      await check("expanding the row lists the affected clients", async () => {
        assert.equal($t("grid-unattributed"), null, "drill-down closed before interaction");
        await click($t("row-unattributed")!);
        assert.ok($t("grid-unattributed"), "drill-down opens on click");
        assert.ok(tText(`row-unattributed-client-${CL_1}`).includes("Firm One"), "client 1 named");
        assert.equal(tText(`cell-unattributed-client-${CL_1}`), "7", "client 1 chat count");
        assert.ok(tText(`row-unattributed-client-${CL_2}`).includes("Firm Two"), "client 2 named");
        assert.equal(tText(`cell-unattributed-client-${CL_2}`), "3", "client 2 chat count");
        assert.ok(
          tText("row-unattributed-client-none").includes("No linked client"),
          "client-less chats get their own labelled line",
        );
        assert.equal(tText("cell-unattributed-client-none"), "1", "client-less chat count");
        const link = $t(`row-unattributed-client-${CL_1}`)!.querySelector("a");
        assert.equal(link?.getAttribute("href"), `/clients/${CL_1}`, "client name links to the client page");
      });

      await check("clicking again collapses the drill-down", async () => {
        await click($t("row-unattributed")!);
        assert.equal($t("grid-unattributed"), null, "drill-down closed");
      });
    } finally {
      await cleanup();
    }
  }

  // ── Scenario B: every unattributed bucket zero ──
  {
    const { cleanup } = await mountPage(REPORT_ALL_ATTRIBUTED);
    try {
      await check("pseudo-row absent when there is nothing to reconcile", () => {
        assert.equal($t("row-unattributed"), null, "no pseudo-row");
        assert.equal($t("grid-unattributed"), null, "no drill-down");
        assert.ok(
          !(dom.window.document.body.textContent ?? "").includes("Not a team member"),
          "no non-member marker anywhere",
        );
      });

      await check("member rows and card render normally without the row", () => {
        assert.ok($t("row-member-am-alice"), "Alice's member row renders");
        assert.equal(tText("cell-am-alice-agentChat"), "2", "Alice's attributed chats count normally");
        assert.equal($t("text-agent-chat-unattributed"), null, "no pre-tracking sublabel when bucket is 0");
      });
    } finally {
      await cleanup();
    }
  }

  // ── Scenario C: unattributed activity but zero members ──
  {
    const { cleanup } = await mountPage(REPORT_NO_MEMBERS);
    try {
      await check("table still renders the pseudo-row when no members exist", () => {
        assert.ok($t("row-unattributed"), "pseudo-row renders");
        assert.ok(
          !(dom.window.document.body.textContent ?? "").includes("No team members found."),
          "empty-state message suppressed when there is something to reconcile",
        );
      });
    } finally {
      await cleanup();
    }
  }

  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll internal-usage reconciliation-row checks passed");
}

// jsdom (pretendToBeVisual) + TanStack Query hold live timer handles after
// unmount, so like the other DOM suites this exits explicitly instead of
// waiting for a natural drain that never comes.
run()
  .then(() => {
    console.log("\nPASS tests/internal-usage-reconciliation-row.test.ts");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nFAIL tests/internal-usage-reconciliation-row.test.ts");
    console.error(err?.message ?? err);
    process.exit(1);
  });
