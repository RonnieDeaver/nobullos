/* test-registration
{
  "name": "One-click restore-original-email flow (Task #2030)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/user-restore-original-email-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2030 — Frontend regression test for the one-click "Restore
 * original email" flow on `client/src/pages/admin/UserManagement.tsx`
 * (added by Task #2012).
 *
 * Mounts the real `UserManagement` page against the production
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. The
 * stub serves the auth probe + the handful of GETs the page issues on
 * mount, and records every PATCH /api/users/:id/email so the tests can
 * assert the one-click restore hits the right endpoint with the
 * stripped original address.
 *
 * The users fixture contains two restored-fallback rows:
 *
 *   alice — stripped original `alice@example.com` is free (no active
 *           user owns it) → the "Restore original email" button renders
 *           and the "Original taken" hint does NOT.
 *
 *   carol — stripped original `carol@example.com` collides (case-
 *           insensitively) with an active user whose email is
 *           `Carol@Example.com` → the "Original taken — edit manually"
 *           hint renders and the restore button does NOT.
 *
 * Scenarios:
 *
 *   1. Button-vs-hint matrix: alice shows the restore button (no hint);
 *      carol shows the taken hint (no button). This locks in the
 *      `originalEmailIsTaken` / `activeEmailLookup` case-insensitive
 *      free/taken decision.
 *
 *   2. Race fallback: when the one-click restore PATCH returns 409
 *      EMAIL_CONFLICT, the manual edit dialog opens pre-filled with the
 *      stripped original address AND surfaces the colliding user's
 *      display name (`updateEmailMutation.onError`).
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
  id: "ceo-2030",
  email: "ceo@example.com",
  firstName: "Cee",
  lastName: "Oh",
  role: "ceo",
};

const ALICE = {
  id: "u-alice",
  email: "alice@example.com.restored.456",
  firstName: "Alice",
  lastName: "Free",
  role: "account_manager",
  callMode: "browser",
  functions: [],
  authorityLevel: "core",
};

// Active user whose email differs only in case from carol's stripped
// original — proves the collision check is case-insensitive.
const CAROL_ACTIVE = {
  id: "u-carol-active",
  email: "Carol@Example.com",
  firstName: "Carol",
  lastName: "Conflict",
  role: "account_manager",
  callMode: "browser",
  functions: [],
  authorityLevel: "core",
};

const CAROL_FALLBACK = {
  id: "u-carol-fallback",
  email: "carol@example.com.restored.999",
  firstName: "Carol",
  lastName: "Stale",
  role: "account_manager",
  callMode: "browser",
  functions: [],
  authorityLevel: "core",
};

const USERS = [CEO_USER, ALICE, CAROL_ACTIVE, CAROL_FALLBACK];

type PatchCall = { url: string; body: any };
let patchCalls: PatchCall[] = [];
// When set, the next PATCH /api/users/:id/email returns this 409 body.
let emailPatchConflict: any = null;

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      method: "PATCH",
      path: /\/api\/users\/[^/]+\/email$/,
      respond: ({ url, init }: any) => {
        let parsed: any = null;
        try {
          parsed = init?.body ? JSON.parse(String(init.body)) : null;
        } catch {
          parsed = init?.body ?? null;
        }
        patchCalls.push({ url, body: parsed });
        if (emailPatchConflict) {
          return { status: 409, json: emailPatchConflict };
        }
        return { status: 200, json: { ok: true } };
      },
    },
    { path: "/api/auth/user", json: CEO_USER },
    { path: "/api/users/deleted", json: [] },
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
    { path: "/api/users", json: USERS },
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
  patchCalls = [];
  emailPatchConflict = null;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenario1_buttonVsHint(): Promise<void> {
  console.log(
    "\n— Scenario 1: restore button only when original free; taken hint when collision (case-insensitive) —",
  );
  const root = await mountPage();
  try {
    // Sanity: the page rendered the user rows.
    assert(
      $(`text-user-name-${ALICE.id}`) !== null,
      "Alice's row must render after the users query resolves",
    );

    // alice — original free → button present, no taken hint.
    const aliceBtn = $(`button-restore-original-email-${ALICE.id}`);
    const aliceHint = $(`text-original-email-taken-${ALICE.id}`);
    assert(
      aliceBtn !== null,
      "Restore button must render for alice (stripped original alice@example.com is free)",
    );
    assert(
      aliceHint === null,
      "Taken hint must NOT render for alice (her original address has no active collision)",
    );

    // carol fallback — original collides case-insensitively → hint, no button.
    const carolBtn = $(`button-restore-original-email-${CAROL_FALLBACK.id}`);
    const carolHint = $(`text-original-email-taken-${CAROL_FALLBACK.id}`);
    assert(
      carolHint !== null,
      "Taken hint must render for carol (carol@example.com collides with active Carol@Example.com — case-insensitive)",
    );
    assert(
      carolBtn === null,
      "Restore button must NOT render for carol (her original address is taken by another active user)",
    );

    console.log(
      "  ✓ alice → restore button (free); carol → taken hint (case-insensitive collision)",
    );
  } finally {
    await unmount(root);
  }
}

async function scenario2_raceFallbackOpensDialog(): Promise<void> {
  console.log(
    "\n— Scenario 2: 409 from one-click restore opens manual edit dialog pre-filled with colliding name —",
  );
  const root = await mountPage();
  try {
    // The dialog must not be open before the click.
    assert(
      $("dialog-edit-user-email") === null,
      "edit-email dialog must be closed before the one-click restore",
    );

    // Arm the next PATCH to lose the race with a 409 EMAIL_CONFLICT.
    emailPatchConflict = {
      code: "EMAIL_CONFLICT",
      error: "Email already in use",
      collidingUser: {
        id: "racer-1",
        email: "alice@example.com",
        displayName: "Racy McRacer",
      },
    };

    await clickById(`button-restore-original-email-${ALICE.id}`);

    // The one-click path must have PATCHed with the stripped original.
    const emailPatches = patchCalls.filter((c) =>
      c.url.endsWith(`/api/users/${ALICE.id}/email`),
    );
    assert(
      emailPatches.length === 1,
      `expected exactly 1 PATCH to /api/users/${ALICE.id}/email, got ${emailPatches.length} (all: ${JSON.stringify(patchCalls)})`,
    );
    assert(
      emailPatches[0].body && emailPatches[0].body.email === "alice@example.com",
      `one-click restore must PATCH the stripped original — got ${JSON.stringify(emailPatches[0].body)}`,
    );

    // The 409 must open the manual edit dialog, pre-filled.
    assert(
      $("dialog-edit-user-email") !== null,
      "a 409 EMAIL_CONFLICT from the one-click restore must open the manual edit dialog",
    );
    const input = $("input-edit-email") as HTMLInputElement | null;
    assert(input !== null, "manual edit dialog must contain the email input");
    assert(
      input!.value === "alice@example.com",
      `manual edit dialog must be pre-filled with the stripped original — got "${input!.value}"`,
    );

    // The conflict hint must name the colliding user.
    const conflict = $("text-edit-email-conflict");
    assert(
      conflict !== null,
      "manual edit dialog must surface the conflict hint after a 409",
    );
    assert(
      (conflict!.textContent || "").includes("Racy McRacer"),
      `conflict hint must name the colliding user — got "${conflict!.textContent}"`,
    );

    console.log(
      "  ✓ 409 → dialog opens pre-filled with alice@example.com and names Racy McRacer",
    );
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenario1_buttonVsHint();
  await scenario2_raceFallbackOpensDialog();
  console.log("\nuser-restore-original-email: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
