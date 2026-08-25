/* test-registration
{
  "name": "Deleted-user restore success path — no conflict (Task #2047)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2599: the six `tests/client/user-restore-*.test.tsx` admin tests all mount the real `UserManagement` page. They silently rotted for a while — every one crashed on mount after the CEO-only \"Restored-email cleanup\" card (Task #2029) added a `/api/users/restored-email-cleanup/status` fetch the tests never stubbed — and nothing caught it because they were flagged `regression: true` but never selected by the gate. Gate the success-path test as the representative: it mounts the full page graph (including that cleanup card, the exact crash source) and exercises the core restore happy path, so any future mount-time/contract regression on the User Management surface fails fast. Fast, deterministic jsdom render — no DB, fully stubbed fetch.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/user-restore-success-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2047 — Frontend regression test for the deleted-user restore
 * happy path (no email conflict) on
 * `client/src/pages/admin/UserManagement.tsx`.
 *
 * Mounts the real `UserManagement` page (as a CEO) against the
 * production `client/src/lib/queryClient` with a stubbed
 * `globalThis.fetch`. The stub serves the auth probe + the GETs the page
 * issues on mount (including a single soft-deleted user from
 * `/api/users/deleted`) and records every POST /api/users/:id/restore.
 *
 * The deleted fixture is `nina` — soft-deleted with email
 * `nina@example.com.deleted.123`. Her stripped original
 * (`nina@example.com`) is NOT owned by any active user, so the strict
 * restore succeeds with a 200 and no conflict dialog ever opens.
 *
 * Scenario:
 *
 *   1. Success path: clicking Restore issues the strict POST, the server
 *      returns 200, the `restoreUserMutation.onSuccess` handler fires the
 *      success toast and invalidates the users / deleted-users queries.
 *      The refetched `/api/users/deleted` now returns an empty list, so
 *      nina's deleted row (and the whole Deleted Users card) disappears,
 *      and the conflict dialog never opens.
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
(globalThis as any).HTMLSelectElement = dom.window.HTMLSelectElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).FocusEvent = dom.window.FocusEvent;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).MutationObserver = dom.window.MutationObserver;
(globalThis as any).DOMRect = dom.window.DOMRect;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
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
// Fixtures
// ---------------------------------------------------------------------------

const CEO_USER = {
  id: "ceo-2047",
  email: "ceo@example.com",
  firstName: "Cee",
  lastName: "Oh",
  role: "ceo",
};

// The soft-deleted user the CEO is restoring. Her stripped original
// (`nina@example.com`) is NOT owned by any active user, so the strict
// restore succeeds.
const NINA_DELETED = {
  id: "u-nina-deleted",
  email: "nina@example.com.deleted.123",
  firstName: "Nina",
  lastName: "Deleted",
  role: "account_manager",
  callMode: "browser",
  functions: [],
  authorityLevel: "core",
};

const ACTIVE_USERS = [CEO_USER];

// `deletedUsers` flips to empty once the restore POST has succeeded — this
// mirrors the server dropping nina's soft-delete mark, so the invalidated
// /api/users/deleted refetch returns an empty list.
let restoreSucceeded = false;

type RestoreCall = { url: string; body: any };
let restoreCalls: RestoreCall[] = [];

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      method: "POST",
      path: /\/api\/users\/[^/]+\/restore$/,
      respond: ({ url, init }: any) => {
        let parsed: any = null;
        try {
          parsed = init?.body ? JSON.parse(String(init.body)) : null;
        } catch {
          parsed = init?.body ?? null;
        }
        restoreCalls.push({ url, body: parsed });
        // No collision — the strict restore succeeds outright.
        restoreSucceeded = true;
        return { status: 200, json: { ok: true } };
      },
    },
    { path: "/api/auth/user", json: CEO_USER },
    { path: "/api/users/deleted", json: () => (restoreSucceeded ? [] : [NINA_DELETED]) },
    { path: "/api/users/delete-history", json: {} },
    { path: "/api/users/reassign-history", json: {} },
    // CEO-only restored-email cleanup card reads cleanupStatus.config; stub it
    // so the panel renders (component requires this endpoint).
    {
      path: "/api/users/restored-email-cleanup/status",
      json: {
        config: {
          enabled: false,
          maxPerTick: 25,
          collisionAlertThreshold: 5,
          collisionStuckHours: 48,
          tickIntervalMinutes: 60,
        },
        lastRunStatus: "never_run",
        lastRun: null,
      },
    },
    { path: "/api/users", json: ACTIVE_USERS },
    { path: "/api/admin/role-permissions/status", json: { permissive: true, effectiveAccessLabel: "All" } },
    { path: "/api/admin/role-backfill-banner", json: { dismissed: true } },
    {
      path: "/api/twilio/config",
      json: { isConfigured: true, browserCalling: { isConfigured: true } },
    },
    { path: "/api/notifications", json: [] },
  ],
  defaultJson: {},
});

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const UserManagement = (
  await import("../../client/src/pages/admin/UserManagement")
).default;

async function flush(times = 16): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

function $(testid: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
}

async function clickById(testId: string): Promise<void> {
  const el = $(testId);
  assert(el !== null, `expected [data-testid="${testId}"] to exist before click`);
  await act(async () => {
    el!.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  await flush();
}

async function mountPage(): Promise<Root> {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(UserManagement as any),
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
  restoreCalls = [];
  restoreSucceeded = false;
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

async function scenario1_restoreSuccessRemovesRow(): Promise<void> {
  console.log(
    "\n— Scenario 1: 200 from restore fires the strict POST, invalidates queries, and removes the deleted row —",
  );
  const root = await mountPage();
  try {
    // Sanity: the deleted-users card rendered nina's restore button.
    assert(
      $(`row-deleted-user-${NINA_DELETED.id}`) !== null,
      "nina's deleted-user row must render after /api/users/deleted resolves",
    );
    assert(
      $("dialog-restore-email-conflict") === null,
      "conflict dialog must be closed before the restore click",
    );

    await clickById(`button-restore-user-${NINA_DELETED.id}`);

    // The strict restore POST must have fired exactly once.
    const strict = restoreCalls.filter((c) =>
      c.url.endsWith(`/api/users/${NINA_DELETED.id}/restore`),
    );
    assert(
      strict.length === 1,
      `expected exactly 1 restore POST, got ${strict.length} (all: ${JSON.stringify(restoreCalls)})`,
    );
    assert(
      strict[0].body && strict[0].body.emailConflictStrategy === "strict",
      `restore must use strict strategy — got ${JSON.stringify(strict[0].body)}`,
    );

    // The success path never opens the conflict dialog.
    assert(
      $("dialog-restore-email-conflict") === null,
      "a successful restore must not open the conflict dialog",
    );

    // onSuccess invalidates /api/users/deleted; the refetch now returns
    // an empty list, so nina's row and the Deleted Users card are gone.
    assert(
      $(`row-deleted-user-${NINA_DELETED.id}`) === null,
      "the restored user's deleted row must be removed after a successful restore",
    );
    assert(
      $("card-deleted-users") === null,
      "the Deleted Users card must disappear once the last deleted user is restored",
    );

    console.log(
      "  ✓ 200 → strict POST fired, conflict dialog stays closed, deleted row removed",
    );
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenario1_restoreSuccessRemovesRow();
  console.log("\nuser-restore-success: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
