/* test-registration
{
  "name": "Deleted-user restore EMAIL_CONFLICT cancel leaves deleted user untouched (Task #2133)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.7s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/user-restore-conflict-cancel-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2133 — Frontend regression test for the deleted-user restore
 * EMAIL_CONFLICT *cancel* (dismiss) branch on
 * `client/src/pages/admin/UserManagement.tsx`.
 *
 * Mounts the real `UserManagement` page (as a CEO) against the
 * production `client/src/lib/queryClient` with a stubbed
 * `globalThis.fetch`. The stub serves the auth probe + the GETs the page
 * issues on mount (including a single soft-deleted user from
 * `/api/users/deleted`) and records every POST /api/users/:id/restore.
 *
 * The deleted fixture is `dora` — soft-deleted with email
 * `dora@example.com.deleted.123`. Restoring her re-collides on the
 * stripped original `dora@example.com`, which an active user
 * (`Dora@Example.com`, case-insensitive) already owns, so the strict
 * restore returns 409 EMAIL_CONFLICT and the conflict dialog opens.
 *
 * This test covers the remaining untested branch: after the conflict
 * dialog opens, the CEO clicks Cancel (`button-cancel-restore-conflict`)
 * instead of confirming the suffix fallback. `AlertDialogCancel` closes
 * the dialog which fires `onOpenChange(false)` -> clears `restoreConflict`.
 * No second restore POST may fire, no toast may be shown, and the
 * soft-deleted user's row must remain in place (the deleted row is
 * untouched).
 *
 * Because the page's `<Toaster />` is not mounted in this harness, a tiny
 * `ToastProbe` component subscribes to the shared `use-toast` store (the
 * same module-level singleton the page's `toast()` dispatches into) and
 * mirrors any active toast into the DOM so the test can assert what fires.
 *
 * Note: the restore mutation is now `meta: { silent: true }`, so the global
 * `MutationCache.onError` in `queryClient` is suppressed for it. The strict
 * 409 EMAIL_CONFLICT therefore fires NO toast when the conflict dialog opens
 * — the dedicated conflict dialog owns all user-facing messaging, and the
 * mutation's own `onError` is the only thing that could toast (and it does
 * not on the conflict branch). The cancel assertions verify that, from the
 * moment the dialog opens through clicking Cancel, no toast is ever shown —
 * and critically never the "User restored" success toast — i.e. Cancel
 * performs no restore.
 *
 * Scenario:
 *
 *   1. Cancel dismiss: strict restore → 409 (dialog opens with no toast),
 *      click Cancel → the conflict dialog closes, only the single strict
 *      restore POST was issued (no suffix retry), no toast is ever shown
 *      (never the success toast), and the deleted-user row still renders
 *      untouched.
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
  id: "ceo-2133",
  email: "ceo@example.com",
  firstName: "Cee",
  lastName: "Oh",
  role: "ceo",
};

// Active user whose email differs only in case from dora's stripped
// original — the account that currently owns the colliding address.
const DORA_ACTIVE = {
  id: "u-dora-active",
  email: "Dora@Example.com",
  firstName: "Dora",
  lastName: "Active",
  role: "account_manager",
  callMode: "browser",
  functions: [],
  authorityLevel: "core",
};

// The soft-deleted user the CEO is trying to restore.
const DORA_DELETED = {
  id: "u-dora-deleted",
  email: "dora@example.com.deleted.123",
  firstName: "Dora",
  lastName: "Deleted",
  role: "account_manager",
  callMode: "browser",
  functions: [],
  authorityLevel: "core",
};

const ACTIVE_USERS = [CEO_USER, DORA_ACTIVE];
const DELETED_USERS = [DORA_DELETED];

type RestoreCall = { url: string; body: any };
let restoreCalls: RestoreCall[] = [];

// The 409 EMAIL_CONFLICT body the server returns on the strict restore.
const CONFLICT_BODY = {
  code: "EMAIL_CONFLICT",
  error: "Email already in use",
  email: "dora@example.com",
  collidingUser: {
    id: DORA_ACTIVE.id,
    email: "Dora@Example.com",
    displayName: "Dora Active",
  },
  fallback: {
    previewEmail: "dora@example.com.restored.789",
  },
};

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
        // Every restore attempt collides; the test cancels rather than
        // confirming the suffix fallback, so only the strict POST should fire.
        return { status: 409, json: CONFLICT_BODY };
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
// the page fires NO toast on the cancel path (the page's own <Toaster />
// isn't mounted here). `toast()` in the page and `useToast()` here share
// the same module-level singleton store.
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

async function scenario1_cancelLeavesDeletedUserUntouched(): Promise<void> {
  console.log(
    "\n— Scenario 1: canceling the EMAIL_CONFLICT dialog closes it, fires no suffix retry, shows no toast, and leaves the deleted user untouched —",
  );
  const root = await mountPage();
  try {
    // Sanity: the deleted-users card rendered dora's restore button.
    assert(
      $(`row-deleted-user-${DORA_DELETED.id}`) !== null,
      "dora's deleted-user row must render after /api/users/deleted resolves",
    );
    assert(
      $("dialog-restore-email-conflict") === null,
      "conflict dialog must be closed before the restore click",
    );
    assert(
      $("toast-item") === null,
      "no toast must be shown before the restore click",
    );

    // Strict restore → 409 EMAIL_CONFLICT opens the conflict dialog.
    await clickById(`button-restore-user-${DORA_DELETED.id}`);
    assert(
      $("dialog-restore-email-conflict") !== null,
      "the strict 409 EMAIL_CONFLICT must open the conflict dialog",
    );

    // Exactly the single strict restore POST must have fired so far.
    const strict = restoreCalls.filter((c) =>
      c.url.endsWith(`/api/users/${DORA_DELETED.id}/restore`),
    );
    assert(
      strict.length === 1,
      `expected exactly 1 restore POST after opening the dialog, got ${strict.length} (all: ${JSON.stringify(restoreCalls)})`,
    );
    assert(
      strict[0].body && strict[0].body.emailConflictStrategy === "strict",
      `first restore must use strict strategy — got ${JSON.stringify(strict[0].body)}`,
    );

    // The restore mutation is `meta.silent`, so the global MutationCache no
    // longer surfaces a generic "Action failed" toast for the strict 409 —
    // the conflict dialog owns all messaging. No toast may exist at the
    // moment the dialog opens. Snapshot it so we can prove Cancel adds none.
    assert(
      $("toast-item") === null,
      "the silent restore mutation must not flash any toast when the conflict dialog opens",
    );
    const toastTextAtOpen = $("toast-item")?.textContent ?? null;

    // Click Cancel — the dismiss branch, not the suffix fallback.
    await clickById("button-cancel-restore-conflict");

    // The conflict dialog must close.
    assert(
      $("dialog-restore-email-conflict") === null,
      "canceling must close the conflict dialog",
    );

    // No SECOND restore POST may fire — Cancel must not retry with suffix.
    const after = restoreCalls.filter((c) =>
      c.url.endsWith(`/api/users/${DORA_DELETED.id}/restore`),
    );
    assert(
      after.length === 1,
      `canceling must not issue another restore POST — got ${after.length} (all: ${JSON.stringify(restoreCalls)})`,
    );
    assert(
      !after.some((c) => c.body && c.body.emailConflictStrategy === "suffix"),
      `canceling must not issue a suffix-strategy restore — got ${JSON.stringify(after)}`,
    );

    // Cancel must fire NO toast — the toast state is unchanged from the
    // moment the dialog opened (no toast at all, since the restore mutation
    // is silent and the conflict branch owns messaging via the dialog).
    const toastTextAfterCancel = $("toast-item")?.textContent ?? null;
    assert(
      toastTextAfterCancel === toastTextAtOpen,
      `canceling must not change the toast state — was "${toastTextAtOpen}", now "${toastTextAfterCancel}"`,
    );

    // Critically, Cancel must NEVER surface the "User restored" success
    // toast — that would mean a restore actually happened.
    assert(
      !(toastTextAfterCancel || "").includes("User restored"),
      `canceling must not show a success toast — got "${toastTextAfterCancel}"`,
    );

    // The soft-deleted user's row must still render — the deleted row is
    // untouched, so the CEO can try again later.
    assert(
      $(`row-deleted-user-${DORA_DELETED.id}`) !== null,
      "the deleted-user row must remain after canceling the conflict dialog",
    );

    console.log(
      "  ✓ cancel → dialog closes, only the strict POST fired, no toast, deleted row untouched",
    );
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenario1_cancelLeavesDeletedUserUntouched();
  console.log("\nuser-restore-conflict-cancel: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
