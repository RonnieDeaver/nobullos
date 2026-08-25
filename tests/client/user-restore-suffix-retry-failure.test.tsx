/* test-registration
{
  "name": "Deleted-user restore suffix-fallback retry failure (Task #2080)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.9s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/user-restore-suffix-retry-failure-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2080 — Frontend regression test for the deleted-user restore
 * suffix-fallback retry failure branch on
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
 * dialog opens and the CEO confirms the suffix-fallback retry
 * (`button-confirm-restore-with-suffix`), that SECOND restore POST itself
 * fails with a non-conflict error (HTTP 500). `restoreUserMutation.onError`
 * must take the generic (non-EMAIL_CONFLICT) path: fire the destructive
 * "Failed to restore user" toast WITHOUT clearing `restoreConflict`, so
 * the conflict dialog stays open and the CEO can retry or cancel.
 *
 * Because the page's `<Toaster />` is not mounted in this harness, a tiny
 * `ToastProbe` component subscribes to the shared `use-toast` store (the
 * same module-level singleton the page's `toast()` dispatches into) and
 * mirrors the active toast's title + variant into the DOM so the test can
 * assert on it.
 *
 * Scenario:
 *
 *   1. Suffix retry failure: strict restore → 409 (dialog opens), confirm
 *      fallback → 500, `onError`'s generic branch shows the destructive
 *      failure toast and the conflict dialog remains open.
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
  id: "ceo-2080",
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
      respond: (ctx: any) => {
        let parsed: any = null;
        try {
          parsed = ctx.init?.body ? JSON.parse(String(ctx.init.body)) : null;
        } catch {
          parsed = ctx.init?.body ?? null;
        }
        restoreCalls.push({ url: ctx.url, body: parsed });
        // The strict attempt collides (409); the suffix-fallback retry itself
        // fails with a non-conflict 500, exercising onError's generic branch.
        if (parsed?.emailConflictStrategy === "suffix") {
          return failureResponse(500);
        }
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
    {
      path: "/api/admin/role-permissions/status",
      json: { permissive: true, effectiveAccessLabel: "All" },
    },
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

async function scenario1_suffixRetryFailureToast(): Promise<void> {
  console.log(
    "\n— Scenario 1: a non-409 failure on the suffix retry shows the destructive toast and keeps the conflict dialog open —",
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

    // Confirm the suffix fallback — the second POST fails with a 500.
    await clickById("button-confirm-restore-with-suffix");

    // Both restore POSTs must have fired: strict then suffix.
    const calls = restoreCalls.filter((c) =>
      c.url.endsWith(`/api/users/${DORA_DELETED.id}/restore`),
    );
    assert(
      calls.length === 2,
      `expected 2 restore POSTs (strict then suffix), got ${calls.length} (all: ${JSON.stringify(restoreCalls)})`,
    );
    assert(
      calls[0].body && calls[0].body.emailConflictStrategy === "strict",
      `first restore must be strict — got ${JSON.stringify(calls[0].body)}`,
    );
    assert(
      calls[1].body && calls[1].body.emailConflictStrategy === "suffix",
      `fallback confirm must re-issue restore with suffix strategy — got ${JSON.stringify(calls[1].body)}`,
    );

    // The destructive "Failed to restore user" toast must be shown.
    const toastItem = $("toast-item");
    assert(
      toastItem !== null,
      "a failure toast must be shown after the suffix retry fails",
    );
    assert(
      (toastItem!.textContent || "").includes("Failed to restore user"),
      `toast must read "Failed to restore user" — got "${toastItem!.textContent}"`,
    );
    assert(
      toastItem!.getAttribute("data-variant") === "destructive",
      `toast must be destructive — got "${toastItem!.getAttribute("data-variant")}"`,
    );

    // The dialog must stay open so the CEO can retry or cancel.
    assert(
      $("dialog-restore-email-conflict") !== null,
      "a non-conflict failure on the suffix retry must keep the conflict dialog open",
    );

    console.log(
      "  ✓ suffix retry 500 → destructive toast shown, conflict dialog stays open for retry/cancel",
    );
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenario1_suffixRetryFailureToast();
  console.log("\nuser-restore-suffix-retry-failure: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
