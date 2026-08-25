/* test-registration
{
  "name": "Deleted-user restore generic (non-conflict) failure (Task #2069)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.6s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/user-restore-generic-failure-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2069 — Frontend regression test for the deleted-user restore
 * generic (non-conflict) failure branch on
 * `client/src/pages/admin/UserManagement.tsx`.
 *
 * Mounts the real `UserManagement` page (as a CEO) against the
 * production `client/src/lib/queryClient` with a stubbed
 * `globalThis.fetch`. The stub serves the auth probe + the GETs the page
 * issues on mount (including a single soft-deleted user from
 * `/api/users/deleted`) and records every POST /api/users/:id/restore.
 *
 * The deleted fixture is `quinn` — soft-deleted with email
 * `quinn@example.com.deleted.123`. The stubbed restore POST returns a
 * non-409 error (HTTP 500), exercising `restoreUserMutation.onError`'s
 * generic branch: it must fire the destructive "Failed to restore user"
 * toast, must NOT open the email-conflict dialog, and must leave quinn's
 * deleted row in place (no query invalidation on failure).
 *
 * Because the page's `<Toaster />` is not mounted in this harness, a tiny
 * `ToastProbe` component subscribes to the shared `use-toast` store (the
 * same module-level singleton the page's `toast()` dispatches into) and
 * mirrors the active toast's title + variant into the DOM so the test can
 * assert on it.
 *
 * Scenario:
 *
 *   1. Generic failure: clicking Restore issues the strict POST, the
 *      server returns 500, `onError` shows the destructive failure toast,
 *      the conflict dialog stays closed, and quinn's deleted row remains.
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
  id: "ceo-2069",
  email: "ceo@example.com",
  firstName: "Cee",
  lastName: "Oh",
  role: "ceo",
};

// The soft-deleted user the CEO is trying to restore. The stubbed restore
// POST fails with a non-conflict 500, so onError's generic branch runs.
const QUINN_DELETED = {
  id: "u-quinn-deleted",
  email: "quinn@example.com.deleted.123",
  firstName: "Quinn",
  lastName: "Deleted",
  role: "account_manager",
  callMode: "browser",
  functions: [],
  authorityLevel: "core",
};

const ACTIVE_USERS = [CEO_USER];
const DELETED_USERS = [QUINN_DELETED];

type RestoreCall = { url: string; body: any };
let restoreCalls: RestoreCall[] = [];

// A non-conflict failure response whose body has no parseable JSON, so the
// mutation falls back to its generic "Failed to restore user" message
// (mirrors a bare 500 with no structured error payload).
function failureResponse(status: number): Response {
  return {
    ok: false,
    status,
    statusText: "Internal Server Error",
    headers: new dom.window.Headers({ "Content-Type": "text/plain" }),
    json: async () => {
      throw new Error("not json");
    },
    text: async () => "Internal Server Error",
  } as unknown as Response;
}

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
        // Non-conflict failure: the restore never succeeds, the deleted row
        // stays put, and onError takes the generic (non-EMAIL_CONFLICT) path.
        return failureResponse(500);
      },
    },
    { path: "/api/auth/user", json: CEO_USER },
    { path: "/api/users/deleted", json: DELETED_USERS },
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
const { useToast } = await import("../../client/src/hooks/use-toast");
const UserManagement = (
  await import("../../client/src/pages/admin/UserManagement")
).default;

// Mirrors the shared use-toast store into the DOM so the test can assert
// on the toast the page fires (the page's own <Toaster /> isn't mounted
// here). `toast()` in the page and `useToast()` here share the same
// module-level singleton store.
function ToastProbe(): any {
  const { toasts } = useToast();
  return React.createElement(
    "div",
    { "data-testid": "toast-probe" },
    toasts.map((t: any) =>
      React.createElement(
        "div",
        {
          key: t.id,
          "data-testid": "toast-item",
          "data-variant": t.variant ?? "default",
        },
        String(t.title ?? ""),
      ),
    ),
  );
}

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
        React.createElement(
          React.Fragment,
          null,
          React.createElement(UserManagement as any),
          React.createElement(ToastProbe as any),
        ),
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
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

async function scenario1_genericFailureToast(): Promise<void> {
  console.log(
    "\n— Scenario 1: a non-409 restore failure shows the destructive toast, keeps the dialog closed, and leaves the deleted row —",
  );
  const root = await mountPage();
  try {
    // Sanity: the deleted-users card rendered quinn's restore button.
    assert(
      $(`row-deleted-user-${QUINN_DELETED.id}`) !== null,
      "quinn's deleted-user row must render after /api/users/deleted resolves",
    );
    assert(
      $("dialog-restore-email-conflict") === null,
      "conflict dialog must be closed before the restore click",
    );
    // No toast before the click.
    assert(
      $("toast-item") === null,
      "no toast must be shown before the restore click",
    );

    await clickById(`button-restore-user-${QUINN_DELETED.id}`);

    // The strict restore POST must have fired exactly once.
    const strict = restoreCalls.filter((c) =>
      c.url.endsWith(`/api/users/${QUINN_DELETED.id}/restore`),
    );
    assert(
      strict.length === 1,
      `expected exactly 1 restore POST, got ${strict.length} (all: ${JSON.stringify(restoreCalls)})`,
    );
    assert(
      strict[0].body && strict[0].body.emailConflictStrategy === "strict",
      `restore must use strict strategy — got ${JSON.stringify(strict[0].body)}`,
    );

    // The generic failure must NOT open the conflict dialog.
    assert(
      $("dialog-restore-email-conflict") === null,
      "a non-conflict failure must not open the email-conflict dialog",
    );

    // The destructive "Failed to restore user" toast must be shown.
    const toastItem = $("toast-item");
    assert(
      toastItem !== null,
      "a failure toast must be shown after a non-conflict restore error",
    );
    assert(
      (toastItem!.textContent || "").includes("Failed to restore user"),
      `toast must read "Failed to restore user" — got "${toastItem!.textContent}"`,
    );
    assert(
      toastItem!.getAttribute("data-variant") === "destructive",
      `toast must be destructive — got "${toastItem!.getAttribute("data-variant")}"`,
    );

    // The restore failed, so quinn's deleted row must remain.
    assert(
      $(`row-deleted-user-${QUINN_DELETED.id}`) !== null,
      "the deleted row must remain after a failed restore",
    );

    console.log(
      "  ✓ 500 → strict POST fired, destructive toast shown, dialog stays closed, deleted row remains",
    );
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenario1_genericFailureToast();
  console.log("\nuser-restore-generic-failure: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
