/* test-registration
{
  "name": "Deleted-user restore EMAIL_CONFLICT dialog (Task #2040)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/user-restore-conflict-dialog-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2040 — Frontend regression test for the deleted-user restore
 * EMAIL_CONFLICT dialog on `client/src/pages/admin/UserManagement.tsx`.
 *
 * Mounts the real `UserManagement` page (as a CEO) against the
 * production `client/src/lib/queryClient` with a stubbed
 * `globalThis.fetch`. The stub serves the auth probe + the GETs the page
 * issues on mount (including a single soft-deleted user from
 * `/api/users/deleted`) and records every POST /api/users/:id/restore so
 * the tests can assert the strict→suffix retry contract.
 *
 * The deleted fixture is `dora` — soft-deleted with email
 * `dora@example.com.deleted.123`. Restoring her would re-collide on the
 * stripped original `dora@example.com`, which an active user
 * (`Dora@Example.com`, case-insensitive) already owns.
 *
 * Scenarios:
 *
 *   1. Conflict dialog opens: clicking Restore issues the strict POST,
 *      the server returns 409 EMAIL_CONFLICT, and the
 *      `dialog-restore-email-conflict` dialog opens showing the colliding
 *      user's name + email and the suffix fallback preview email
 *      (`restoreUserMutation.onError` -> `restoreConflict` state).
 *
 *   2. Suffix retry: confirming the fallback
 *      (`button-confirm-restore-with-suffix`) re-issues POST
 *      /api/users/:id/restore with `emailConflictStrategy: "suffix"`.
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
  id: "ceo-2040",
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
        // The suffix-fallback retry succeeds; the strict attempt collides.
        if (parsed?.emailConflictStrategy === "suffix") {
          return { status: 200, json: { ok: true } };
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
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenario1_conflictOpensDialog(): Promise<void> {
  console.log(
    "\n— Scenario 1: 409 EMAIL_CONFLICT from restore opens the conflict dialog with colliding + fallback details —",
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

    await clickById(`button-restore-user-${DORA_DELETED.id}`);

    // The strict restore POST must have fired exactly once.
    const strict = restoreCalls.filter((c) =>
      c.url.endsWith(`/api/users/${DORA_DELETED.id}/restore`),
    );
    assert(
      strict.length === 1,
      `expected exactly 1 restore POST, got ${strict.length} (all: ${JSON.stringify(restoreCalls)})`,
    );
    assert(
      strict[0].body && strict[0].body.emailConflictStrategy === "strict",
      `first restore must use strict strategy — got ${JSON.stringify(strict[0].body)}`,
    );

    // The 409 must open the conflict dialog.
    assert(
      $("dialog-restore-email-conflict") !== null,
      "a 409 EMAIL_CONFLICT must open dialog-restore-email-conflict",
    );

    // The conflicting original address is surfaced.
    const conflictEmail = $("text-restore-conflict-email");
    assert(
      conflictEmail !== null &&
        (conflictEmail.textContent || "").includes("dora@example.com"),
      `dialog must show the colliding original email — got "${conflictEmail?.textContent}"`,
    );

    // The colliding (current owner) user's name + email are shown.
    const collidingName = $("text-restore-conflict-colliding-name");
    assert(
      collidingName !== null &&
        (collidingName.textContent || "").includes("Dora Active"),
      `dialog must name the colliding user — got "${collidingName?.textContent}"`,
    );
    const collidingEmail = $("text-restore-conflict-colliding-email");
    assert(
      collidingEmail !== null &&
        (collidingEmail.textContent || "").includes("Dora@Example.com"),
      `dialog must show the colliding user's email — got "${collidingEmail?.textContent}"`,
    );

    // The suffix fallback preview email is shown.
    const fallback = $("text-restore-conflict-fallback-email");
    assert(
      fallback !== null &&
        (fallback.textContent || "").includes("dora@example.com.restored.789"),
      `dialog must show the fallback preview email — got "${fallback?.textContent}"`,
    );

    console.log(
      "  ✓ 409 → conflict dialog opens with colliding name/email + fallback preview",
    );
  } finally {
    await unmount(root);
  }
}

async function scenario2_suffixRetry(): Promise<void> {
  console.log(
    "\n— Scenario 2: confirming the fallback re-issues restore with emailConflictStrategy: suffix —",
  );
  const root = await mountPage();
  try {
    await clickById(`button-restore-user-${DORA_DELETED.id}`);
    assert(
      $("dialog-restore-email-conflict") !== null,
      "conflict dialog must be open before confirming the fallback",
    );

    await clickById("button-confirm-restore-with-suffix");

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

    // The successful suffix retry closes the conflict dialog.
    assert(
      $("dialog-restore-email-conflict") === null,
      "a successful suffix restore must close the conflict dialog",
    );

    console.log(
      "  ✓ confirm fallback → second POST carries emailConflictStrategy: suffix and dialog closes",
    );
  } finally {
    await unmount(root);
  }
}

async function scenario3_cancelClosesWithoutRetry(): Promise<void> {
  console.log(
    "\n— Scenario 3: clicking Cancel closes the conflict dialog without issuing a suffix retry —",
  );
  const root = await mountPage();
  try {
    await clickById(`button-restore-user-${DORA_DELETED.id}`);
    assert(
      $("dialog-restore-email-conflict") !== null,
      "conflict dialog must be open before clicking Cancel",
    );

    // Exactly the strict attempt has fired so far.
    const before = restoreCalls.filter((c) =>
      c.url.endsWith(`/api/users/${DORA_DELETED.id}/restore`),
    );
    assert(
      before.length === 1,
      `expected exactly 1 restore POST before Cancel, got ${before.length} (all: ${JSON.stringify(restoreCalls)})`,
    );

    await clickById("button-cancel-restore-conflict");

    // Cancel clears restoreConflict state -> dialog unmounts.
    assert(
      $("dialog-restore-email-conflict") === null,
      "clicking Cancel must close dialog-restore-email-conflict",
    );

    // No second restore POST may be issued by the Cancel branch.
    const after = restoreCalls.filter((c) =>
      c.url.endsWith(`/api/users/${DORA_DELETED.id}/restore`),
    );
    assert(
      after.length === 1,
      `Cancel must not issue another restore POST — expected 1 total, got ${after.length} (all: ${JSON.stringify(restoreCalls)})`,
    );
    assert(
      !after.some((c) => c.body && c.body.emailConflictStrategy === "suffix"),
      `Cancel must never send a suffix-strategy restore — got ${JSON.stringify(after)}`,
    );

    console.log(
      "  ✓ Cancel → conflict dialog closes and no second restore POST is issued",
    );
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenario1_conflictOpensDialog();
  await scenario2_suffixRetry();
  await scenario3_cancelClosesWithoutRetry();
  console.log("\nuser-restore-conflict-dialog: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
