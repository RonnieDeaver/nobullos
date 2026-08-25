/* test-registration
{
  "name": "Recovery setting Revert buttons (Task #1162)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.4s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/recovery-revert-buttons-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #1162 — Frontend regression test for the per-row "Revert" buttons
 * inside the Front historical-recovery panel's max-age and prune-interval
 * history lists (originally added by Task #700).
 *
 * Mounts the real `FrontHistoricalRecoveryPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch` that
 * serves the integration-status / max-age / prune-interval / history
 * payloads and records every PUT.
 *
 * Asserts:
 *
 *   1. Clicking Revert on a max-age history row issues
 *      PUT /api/integrations/front/historical-recovery/max-age with
 *      that row's `oldValues.maxAgeDays`.
 *
 *   2. Clicking Revert on a prune-interval history row issues
 *      PUT /api/integrations/front/historical-recovery/prune-interval
 *      with that row's `oldValues.intervalMinutes`.
 *
 *   3. Buttons are disabled when `oldValues` is missing, equals the
 *      current value, or falls outside the server-reported min/max
 *      range.
 *
 *   4. Buttons are NOT rendered for non-admin users (the surrounding
 *      sections never mount because their queries are gated by
 *      `isAdmin`, so no `button-rma-history-revert-*` /
 *      `button-rpi-history-revert-*` element exists on the page).
 *
 * The PUT-call assertion locks in the audit + activity-log path: the
 * server endpoints already log on every successful write, so verifying
 * the button hits the right endpoint with the right body is equivalent
 * to verifying a new audit + activity-log entry is produced.
 */

import { JSDOM } from "jsdom";
import { installJsdomGlobals } from "../helpers/installJsdomGlobals";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
installJsdomGlobals(dom);

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Configurable fetch stub + PUT recorder
// ---------------------------------------------------------------------------

type PutCall = { url: string; body: any };
let putCalls: PutCall[] = [];

const ADMIN_USER = {
  id: "admin-1162",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};
const VIEWER_USER = {
  id: "viewer-1162",
  email: "viewer@example.com",
  firstName: "Vic",
  lastName: "Tor",
  role: "account_manager",
};

const MAX_AGE_RESPONSE = {
  maxAgeDays: 30,
  defaultDays: 30,
  minDays: 1,
  maxDays: 365,
  lastEdited: null,
};
const PRUNE_RESPONSE = {
  intervalMinutes: 60,
  defaultMinutes: 60,
  minMinutes: 5,
  maxMinutes: 1440,
  lastEdited: null,
};

// Three max-age history rows:
//   ma-good   → oldValues.maxAgeDays = 14 (in range, != current 30)  → revertable
//   ma-equal  → oldValues.maxAgeDays = 30 (equals current)           → disabled
//   ma-oor    → oldValues.maxAgeDays = 9999 (out of range)           → disabled
//   ma-null   → oldValues = null                                     → disabled
const MAX_AGE_HISTORY = {
  history: [
    {
      id: "ma-good",
      changedBy: "admin-1162",
      changedByName: "Ada Min",
      changedByEmail: "admin@example.com",
      oldValues: { maxAgeDays: 14 },
      newValues: { maxAgeDays: 30 },
      changedAt: "2026-05-10T12:00:00.000Z",
    },
    {
      id: "ma-equal",
      changedBy: "admin-1162",
      changedByName: "Ada Min",
      changedByEmail: "admin@example.com",
      oldValues: { maxAgeDays: 30 },
      newValues: { maxAgeDays: 45 },
      changedAt: "2026-05-09T12:00:00.000Z",
    },
    {
      id: "ma-oor",
      changedBy: "admin-1162",
      changedByName: "Ada Min",
      changedByEmail: "admin@example.com",
      oldValues: { maxAgeDays: 9999 },
      newValues: { maxAgeDays: 30 },
      changedAt: "2026-05-08T12:00:00.000Z",
    },
    {
      id: "ma-null",
      changedBy: null,
      changedByName: null,
      changedByEmail: null,
      oldValues: null,
      newValues: { maxAgeDays: 30 },
      changedAt: "2026-05-07T12:00:00.000Z",
    },
  ],
};

const PRUNE_HISTORY = {
  history: [
    {
      id: "pi-good",
      changedBy: "admin-1162",
      changedByName: "Ada Min",
      changedByEmail: "admin@example.com",
      oldValues: { intervalMinutes: 30 },
      newValues: { intervalMinutes: 60 },
      changedAt: "2026-05-10T12:00:00.000Z",
    },
    {
      id: "pi-equal",
      changedBy: "admin-1162",
      changedByName: "Ada Min",
      changedByEmail: "admin@example.com",
      oldValues: { intervalMinutes: 60 },
      newValues: { intervalMinutes: 120 },
      changedAt: "2026-05-09T12:00:00.000Z",
    },
    {
      id: "pi-oor",
      changedBy: "admin-1162",
      changedByName: "Ada Min",
      changedByEmail: "admin@example.com",
      oldValues: { intervalMinutes: 1 }, // < minMinutes (5)
      newValues: { intervalMinutes: 60 },
      changedAt: "2026-05-08T12:00:00.000Z",
    },
    {
      id: "pi-null",
      changedBy: null,
      changedByName: null,
      changedByEmail: null,
      oldValues: null,
      newValues: { intervalMinutes: 60 },
      changedAt: "2026-05-07T12:00:00.000Z",
    },
  ],
};

function makeFetchHandler(opts: { user: any }): (url: string, init?: any) => Promise<Response> {
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      {
        method: "PUT",
        respond: ({ url, init }: any) => {
          let parsed: any = null;
          try {
            parsed = init?.body ? JSON.parse(String(init.body)) : null;
          } catch {
            parsed = init?.body ?? null;
          }
          putCalls.push({ url, body: parsed });
          if (url.endsWith("/historical-recovery/max-age")) {
            return { status: 200, json: { maxAgeDays: parsed?.maxAgeDays ?? 30, pruned: 0 } };
          }
          if (url.endsWith("/historical-recovery/prune-interval")) {
            return { status: 200, json: { intervalMinutes: parsed?.intervalMinutes ?? 60 } };
          }
          return { status: 200, json: {} };
        },
      },
      {
        path: "/api/auth/user",
        respond: () =>
          opts.user
            ? { status: 200, json: opts.user }
            : { status: 401, json: {} },
      },
      { path: "/api/integrations/all-status", json: { front: { connected: true } } },
      { path: /\/historical-recovery\/max-age$/, json: MAX_AGE_RESPONSE },
      { path: /\/historical-recovery\/max-age\/history$/, json: MAX_AGE_HISTORY },
      { path: /\/historical-recovery\/prune-interval$/, json: PRUNE_RESPONSE },
      { path: /\/historical-recovery\/prune-interval\/history$/, json: PRUNE_HISTORY },
      {
        path: /\/historical-recovery\/auto-continue-max-attempts/,
        respond: ({ url }: any) =>
          url.endsWith("/history")
            ? { status: 200, json: { history: [] } }
            : {
                status: 200,
                json: {
                  maxAttempts: 5,
                  defaultAttempts: 5,
                  minAttempts: 1,
                  maxAttemptsAllowed: 20,
                },
              },
      },
      // Everything else (jobs list, coverage, sweep status, etc.) — return
      // benign empty payloads so the panel doesn't error on incidental
      // requests we don't care about.
      { path: /\/historical-recovery\/jobs/, json: { jobs: [] } },
      { path: /\/historical-recovery\/coverage/, json: { windows: [] } },
      {
        path: /\/historical-recovery\/sweep-status/,
        json: {
          running: false,
          inFlight: false,
          intervalMs: 60000,
          lastSweepAt: null,
          lastPrunedCount: 0,
          lastError: null,
        },
      },
      { path: /\/historical-recovery\/manual-sweep-history/, json: { entries: [] } },
    ],
    defaultJson: {},
  });
}

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom globals + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider, QueryClient } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const { FrontHistoricalRecoveryPanel } = await import(
  "../../client/src/components/admin/FrontHistoricalRecoveryPanel"
);

let activeFetchHandler: (url: string, init?: any) => Promise<Response> = async () => {
  throw new Error("no fetch handler set");
};
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  return activeFetchHandler(url, init);
};

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}
function $all(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll(selector)) as HTMLElement[];
}

async function mountPanel(): Promise<Root> {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(FrontHistoricalRecoveryPanel as any),
      ),
    );
  });
  await flush();
  return root!;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  queryClient.clear();
  putCalls = [];
}

async function clickById(testId: string): Promise<void> {
  const el = $(testId);
  assert(el !== null, `expected element [data-testid="${testId}"] to exist before click`);
  await act(async () => {
    el!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenario1_revertMaxAge(): Promise<void> {
  console.log("\n— Scenario 1: admin clicks max-age Revert → PUT max-age with oldValues —");
  activeFetchHandler = makeFetchHandler({ user: ADMIN_USER });
  const root = await mountPanel();
  try {
    // Open the max-age history list.
    await clickById("button-recovery-max-age-history-toggle");
    await flush(8);

    assert(
      $("recovery-max-age-history-ma-good") !== null,
      "max-age history row ma-good must render after toggling history open",
    );

    const goodBtn = $("button-rma-history-revert-ma-good") as HTMLButtonElement | null;
    const equalBtn = $("button-rma-history-revert-ma-equal") as HTMLButtonElement | null;
    const oorBtn = $("button-rma-history-revert-ma-oor") as HTMLButtonElement | null;
    const nullBtn = $("button-rma-history-revert-ma-null") as HTMLButtonElement | null;

    assert(goodBtn !== null, "max-age Revert button must render for revertable row ma-good");
    assert(equalBtn !== null, "max-age Revert button must render (disabled) for ma-equal row");
    assert(oorBtn !== null, "max-age Revert button must render (disabled) for ma-oor row");
    assert(nullBtn !== null, "max-age Revert button must render (disabled) for ma-null row");

    assert(
      !goodBtn!.disabled,
      "max-age Revert must be enabled for ma-good (oldValues.maxAgeDays=14, in range, != current 30)",
    );
    assert(
      equalBtn!.disabled,
      "max-age Revert must be disabled when oldValues.maxAgeDays equals the current value",
    );
    assert(
      oorBtn!.disabled,
      "max-age Revert must be disabled when oldValues.maxAgeDays is outside [minDays, maxDays]",
    );
    assert(
      nullBtn!.disabled,
      "max-age Revert must be disabled when oldValues is null",
    );

    putCalls = [];
    await clickById("button-rma-history-revert-ma-good");
    // Task #4589: Revert now confirms via ConfirmActionDialog — no PUT until
    // the dialog's confirm button is clicked.
    assert(
      putCalls.filter((c) => c.url.endsWith("/historical-recovery/max-age")).length === 0,
      "no PUT may fire before the confirm dialog is accepted",
    );
    await clickById("dialog-rma-history-revert-ma-good-confirm");

    const maxAgePuts = putCalls.filter((c) => c.url.endsWith("/historical-recovery/max-age"));
    assert(
      maxAgePuts.length === 1,
      `expected exactly 1 PUT to /historical-recovery/max-age, got ${maxAgePuts.length} (all calls: ${JSON.stringify(putCalls)})`,
    );
    assert(
      maxAgePuts[0].body && maxAgePuts[0].body.maxAgeDays === 14,
      `PUT body must be { maxAgeDays: 14 } — got ${JSON.stringify(maxAgePuts[0].body)}`,
    );
    console.log("  ✓ PUT /historical-recovery/max-age fired with { maxAgeDays: 14 }");
    console.log("  ✓ disabled-state matrix verified (equal / out-of-range / null oldValues)");
  } finally {
    await unmount(root);
  }
}

async function scenario2_revertPruneInterval(): Promise<void> {
  console.log("\n— Scenario 2: admin clicks prune-interval Revert → PUT prune-interval with oldValues —");
  activeFetchHandler = makeFetchHandler({ user: ADMIN_USER });
  const root = await mountPanel();
  try {
    await clickById("button-recovery-prune-interval-history-toggle");
    await flush(8);

    assert(
      $("recovery-prune-interval-history-pi-good") !== null,
      "prune-interval history row pi-good must render after toggling history open",
    );

    const goodBtn = $("button-rpi-history-revert-pi-good") as HTMLButtonElement | null;
    const equalBtn = $("button-rpi-history-revert-pi-equal") as HTMLButtonElement | null;
    const oorBtn = $("button-rpi-history-revert-pi-oor") as HTMLButtonElement | null;
    const nullBtn = $("button-rpi-history-revert-pi-null") as HTMLButtonElement | null;

    assert(goodBtn !== null, "prune-interval Revert button must render for revertable row pi-good");
    assert(equalBtn !== null, "prune-interval Revert button must render (disabled) for pi-equal");
    assert(oorBtn !== null, "prune-interval Revert button must render (disabled) for pi-oor");
    assert(nullBtn !== null, "prune-interval Revert button must render (disabled) for pi-null");

    assert(
      !goodBtn!.disabled,
      "prune-interval Revert must be enabled for pi-good (oldValues.intervalMinutes=30, in range, != current 60)",
    );
    assert(
      equalBtn!.disabled,
      "prune-interval Revert must be disabled when oldValues.intervalMinutes equals the current value",
    );
    assert(
      oorBtn!.disabled,
      "prune-interval Revert must be disabled when oldValues.intervalMinutes is below minMinutes",
    );
    assert(
      nullBtn!.disabled,
      "prune-interval Revert must be disabled when oldValues is null",
    );

    putCalls = [];
    await clickById("button-rpi-history-revert-pi-good");
    // Task #4589: Revert now confirms via ConfirmActionDialog — no PUT until
    // the dialog's confirm button is clicked.
    assert(
      putCalls.filter((c) => c.url.endsWith("/historical-recovery/prune-interval")).length === 0,
      "no PUT may fire before the confirm dialog is accepted",
    );
    await clickById("dialog-rpi-history-revert-pi-good-confirm");

    const pruneputs = putCalls.filter((c) =>
      c.url.endsWith("/historical-recovery/prune-interval"),
    );
    assert(
      pruneputs.length === 1,
      `expected exactly 1 PUT to /historical-recovery/prune-interval, got ${pruneputs.length} (all calls: ${JSON.stringify(putCalls)})`,
    );
    assert(
      pruneputs[0].body && pruneputs[0].body.intervalMinutes === 30,
      `PUT body must be { intervalMinutes: 30 } — got ${JSON.stringify(pruneputs[0].body)}`,
    );
    console.log("  ✓ PUT /historical-recovery/prune-interval fired with { intervalMinutes: 30 }");
    console.log("  ✓ disabled-state matrix verified (equal / out-of-range / null oldValues)");
  } finally {
    await unmount(root);
  }
}

async function scenario3_nonAdminHidesRevert(): Promise<void> {
  console.log("\n— Scenario 3: non-admin viewer → no Revert buttons render —");
  activeFetchHandler = makeFetchHandler({ user: VIEWER_USER });
  const root = await mountPanel();
  try {
    await flush(10);

    const rmaButtons = $all('[data-testid^="button-rma-history-revert-"]');
    const rpiButtons = $all('[data-testid^="button-rpi-history-revert-"]');

    assert(
      rmaButtons.length === 0,
      `non-admin viewer must not see any max-age Revert buttons (found ${rmaButtons.length})`,
    );
    assert(
      rpiButtons.length === 0,
      `non-admin viewer must not see any prune-interval Revert buttons (found ${rpiButtons.length})`,
    );

    // No PUT must have been fired during this scenario (mount only).
    assert(
      putCalls.length === 0,
      `non-admin mount must not produce any PUT requests (got ${JSON.stringify(putCalls)})`,
    );
    console.log("  ✓ no Revert buttons present for non-admin user");
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  await scenario1_revertMaxAge();
  await scenario2_revertPruneInterval();
  await scenario3_nonAdminHidesRevert();

  console.log("\nrecovery-revert-buttons: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
