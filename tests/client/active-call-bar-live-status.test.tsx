/* test-registration
{
  "name": "Active Call Bar live-status flow (Task #1273)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~3.7s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #1273 — component-level test for the Active Call Bar's live-status
 * flow.
 *
 * NOTE (post-rebase): Task #1272 (merged into main concurrently with
 * this work) replaced the original 2 s REST poll with a server-pushed
 * `call:status` SSE event. There is no longer a polling hook in
 * ConversationHub to test. What survives — and what this test pins —
 * are the pure exports the SSE handler now delegates to:
 *
 *   - `mapTwilioStatusToActiveCallStatus`     — Twilio CallStatus → bar enum
 *   - `ACTIVE_CALL_TERMINAL_TWILIO_STATUSES`  — terminal-status set
 *   - `ACTIVE_CALL_BAR_RETIRE_DELAY_MS`       — final-flash delay constant
 *   - `ActiveCallBar`                         — rendered call bar component
 *
 * The SSE handler in ConversationHub.tsx now calls
 * `mapTwilioStatusToActiveCallStatus(remote)` and gates the terminal
 * retire on `ACTIVE_CALL_TERMINAL_TWILIO_STATUSES.has(remote)` with the
 * `ACTIVE_CALL_BAR_RETIRE_DELAY_MS` setTimeout — so any drift in those
 * primitives (or in the bar's label expression / test-ids) is caught.
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
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).SVGElement = dom.window.SVGElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(dom.window as any).matchMedia =
  (dom.window as any).matchMedia ||
  ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Imports — after jsdom is in place. We import the REAL production module
// so any drift in the helpers / bar is caught.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const {
  ActiveCallBar,
  mapTwilioStatusToActiveCallStatus,
  ACTIVE_CALL_TERMINAL_TWILIO_STATUSES,
  ACTIVE_CALL_BAR_RETIRE_DELAY_MS,
} = await import("../../client/src/pages/ConversationHub");

type ActiveCallStatus = "calling" | "ringing" | "in-progress" | "ending" | "ended";
type ActiveCallState = {
  thread: { key: string; displayName: string };
  phone: string;
  startedAt: number;
  status: ActiveCallStatus;
  callId: string | null;
  mode: "browser" | "forward";
};

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ====================================================================
  // Section A — pure-function coverage of the exported helpers.
  // The SSE handler in ConversationHub.tsx delegates to these directly,
  // so any change to the Twilio→bar status vocabulary or the terminal
  // set will fail here even though we don't simulate SSE itself.
  // ====================================================================
  console.log("— A. mapTwilioStatusToActiveCallStatus + terminal-set contracts —");

  // Twilio CallStatus reference values: queued, ringing, in-progress,
  // completed, busy, failed, no-answer, canceled, plus the less-common
  // 'initiated' that Twilio sometimes returns.
  assert(
    mapTwilioStatusToActiveCallStatus("ringing") === "ringing",
    "ringing → ringing",
  );
  assert(
    mapTwilioStatusToActiveCallStatus("RINGING") === "ringing",
    "mapping must be case-insensitive (RINGING → ringing)",
  );
  assert(
    mapTwilioStatusToActiveCallStatus("in-progress") === "in-progress",
    "in-progress → in-progress",
  );
  assert(
    mapTwilioStatusToActiveCallStatus("queued") === "calling",
    "queued → calling",
  );
  assert(
    mapTwilioStatusToActiveCallStatus("initiated") === "calling",
    "initiated → calling",
  );
  for (const t of ["completed", "no-answer", "busy", "failed", "canceled"]) {
    assert(
      mapTwilioStatusToActiveCallStatus(t) === "ended",
      `${t} → ended (terminal)`,
    );
    assert(
      ACTIVE_CALL_TERMINAL_TWILIO_STATUSES.has(t),
      `ACTIVE_CALL_TERMINAL_TWILIO_STATUSES must include ${t}`,
    );
  }
  assert(
    mapTwilioStatusToActiveCallStatus("") === null,
    "unknown status → null (SSE handler must leave bar untouched)",
  );
  assert(
    mapTwilioStatusToActiveCallStatus("garbage") === null,
    "garbage status → null",
  );
  assert(
    typeof ACTIVE_CALL_BAR_RETIRE_DELAY_MS === "number" &&
      ACTIVE_CALL_BAR_RETIRE_DELAY_MS > 0,
    "ACTIVE_CALL_BAR_RETIRE_DELAY_MS must be a positive number",
  );
  console.log("  ✓ all mapping + terminal-set assertions passed");

  // ====================================================================
  // Section B — real ActiveCallBar renders the ringing → in-progress →
  // completed lifecycle. We drive transitions by re-rendering the bar
  // with each status the SSE handler would set after consulting
  // `mapTwilioStatusToActiveCallStatus`, then assert the visible label
  // changes the operator would see.
  // ====================================================================
  console.log("\n— B. ActiveCallBar lifecycle labels —");

  const baseCall: Omit<ActiveCallState, "status"> = {
    callId: "call-task-1273",
    mode: "forward",
    startedAt: Date.now(),
    thread: { key: "thread-key-xyz", displayName: "Forward Call Test" },
    phone: "+15551112222",
  };

  const container = document.getElementById("root")!;
  let root: Root | null = null;

  function renderBar(status: ActiveCallStatus): void {
    if (!root) root = createRoot(container);
    root.render(
      React.createElement(ActiveCallBar as any, {
        call: { ...baseCall, status },
        onEnd: () => {},
        isMuted: false,
        onToggleMute: () => {},
        muteAvailable: false,
      }),
    );
  }

  // -- Twilio "ringing" → bar shows "Ringing" -----------------------------
  await act(async () => {
    renderBar(mapTwilioStatusToActiveCallStatus("ringing")!);
  });
  await flush();
  assert(
    $("active-call-bar") !== null,
    "active-call-bar test-id (owned by real ActiveCallBar) must render",
  );
  assert(
    $("active-call-name")?.textContent === "Forward Call Test",
    "real ActiveCallBar must surface call.thread.displayName as active-call-name",
  );
  assert(
    /Ringing/.test($("active-call-meta")?.textContent ?? ""),
    `real ActiveCallBar meta must include 'Ringing' for ringing status (got "${$("active-call-meta")?.textContent}")`,
  );
  assert(
    $("button-end-active-call") !== null,
    "real ActiveCallBar must render its End button",
  );

  // -- Twilio "in-progress" → bar shows "On call" -------------------------
  await act(async () => {
    renderBar(mapTwilioStatusToActiveCallStatus("in-progress")!);
  });
  await flush();
  assert(
    /On call/.test($("active-call-meta")?.textContent ?? ""),
    `real ActiveCallBar meta must transition to 'On call' on in-progress (got "${$("active-call-meta")?.textContent}")`,
  );

  // -- Twilio "completed" maps to "ended"; bar shows "Ended" --------------
  // This is the state the SSE handler holds for ACTIVE_CALL_BAR_RETIRE_DELAY_MS
  // before retiring the bar entirely.
  const mappedTerminal = mapTwilioStatusToActiveCallStatus("completed");
  assert(mappedTerminal === "ended", "completed must map to ended");
  await act(async () => {
    renderBar(mappedTerminal!);
  });
  await flush();
  assert(
    /Ended/.test($("active-call-meta")?.textContent ?? ""),
    `real ActiveCallBar meta must flash 'Ended' on terminal status (got "${$("active-call-meta")?.textContent}")`,
  );

  // -- Bar is retired by parent (SSE handler does this in production) ----
  // Simulate: re-render the parent without the bar to confirm unmount
  // doesn't throw and the test-id disappears.
  await act(async () => {
    root!.render(
      React.createElement(
        "div",
        { "data-testid": "active-call-bar-absent" },
        "no call",
      ),
    );
  });
  await flush();
  assert(
    $("active-call-bar") === null,
    "active-call-bar test-id must disappear after the parent retires the bar",
  );
  assert(
    $("active-call-bar-absent") !== null,
    "absent-state placeholder must render after retire",
  );

  await act(async () => {
    root!.unmount();
  });

  console.log("  ✓ real ActiveCallBar renders Ringing → On call → Ended");
  console.log("\nactive-call-bar-live-status: all sections passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
