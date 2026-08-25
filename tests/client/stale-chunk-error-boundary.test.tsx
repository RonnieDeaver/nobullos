/* test-registration
{
  "name": "Stale-deploy chunk-load auto-recovery — classifier, loop guard, and boundary render (Task #2881)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2881: the GlobalErrorBoundary stale-deploy auto-recovery is the fix for \"Something went wrong\" on reports.nobullmarketing.com after each publish. A regression in the classifier (wrong patterns), the loop guard (fails open → reload storm, or fails closed → no recovery), or the render path (chunk-load error shows error screen instead of recovering) would silently bring the user-visible blank screen back. Gate this fast, DB-free, deterministic test (jsdom + React; no network; group A = pure classifier unit, group B = pure guard unit, group C = boundary render scenarios).",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2881 — Auto-recover from stale-deploy chunk load failures.
 *
 * Three groups of assertions:
 *
 *   A. Unit: isChunkLoadError() classifier — browser message variants that
 *      must classify as chunk-load failures vs. genuine runtime errors that
 *      must NOT.
 *
 *   B. Unit: canAutoReload() / markAutoReloaded() loop guard — at most one
 *      auto-reload per URL per 30-second window; a subsequent stale-chunk
 *      error after the guard is set must NOT trigger another reload.
 *
 *   C. Render: GlobalErrorBoundary mounted in jsdom — stale-chunk error
 *      triggers window.location.reload() and hides the error screen; a
 *      generic runtime error shows the error screen and does NOT reload;
 *      a second stale-chunk error while the guard is active also shows the
 *      error screen (loop guard).
 */

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// ---- jsdom environment ---------------------------------------------------

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
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).sessionStorage = dom.window.sessionStorage;
(globalThis as any).localStorage = dom.window.localStorage;
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
    dispatchEvent() { return false; },
  }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ---- Helpers ---------------------------------------------------------------

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function flush(times = 4) {
  const { act } = await import("react");
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function byTestId(id: string): Element | null {
  return dom.window.document.querySelector(`[data-testid="${id}"]`);
}

function bodyText(): string {
  return dom.window.document.body.textContent ?? "";
}

// ---- Group A: isChunkLoadError unit tests ----------------------------------

async function testClassifier() {
  const { isChunkLoadError } = await import("../../client/src/lib/chunkLoadError");

  const CHUNK_MESSAGES = [
    "Importing a module script failed.",
    "Failed to fetch dynamically imported module: https://app.example.com/assets/Dashboard-BXa3k9Lm.js",
    "error loading dynamically imported module",
    "Loading chunk 42 failed.",
    "Loading CSS chunk vendors-BXa3k9Lm failed.",
    "ChunkLoadError: Loading chunk 7 failed.",
  ];

  const NON_CHUNK_MESSAGES = [
    "Cannot read properties of null (reading 'map')",
    "TypeError: undefined is not a function",
    "Network request failed",
    "ReferenceError: window is not defined",
    "Unexpected token '<'",
  ];

  for (const msg of CHUNK_MESSAGES) {
    const err = new Error(msg);
    assert.ok(
      isChunkLoadError(err),
      `Expected isChunkLoadError to return true for: ${msg}`,
    );
  }

  const chunkNameError = new Error("chunk load");
  (chunkNameError as any).name = "ChunkLoadError";
  assert.ok(isChunkLoadError(chunkNameError), "Expected true for error.name === 'ChunkLoadError'");

  for (const msg of NON_CHUNK_MESSAGES) {
    const err = new Error(msg);
    assert.ok(
      !isChunkLoadError(err),
      `Expected isChunkLoadError to return false for: ${msg}`,
    );
  }

  assert.ok(!isChunkLoadError(null), "Expected false for null");
  assert.ok(!isChunkLoadError(undefined), "Expected false for undefined");

  console.log("  ✓ Group A: isChunkLoadError classifies all browser variants correctly");
}

// ---- Group B: loop guard unit tests ----------------------------------------

async function testLoopGuard() {
  const { canAutoReload, markAutoReloaded, clearAutoReloadGuard } =
    await import("../../client/src/lib/chunkLoadError");

  dom.window.sessionStorage.clear();

  assert.ok(canAutoReload(), "fresh session: canAutoReload() must be true");

  markAutoReloaded();
  assert.ok(!canAutoReload(), "after markAutoReloaded: canAutoReload() must be false (guard active)");

  clearAutoReloadGuard();
  assert.ok(canAutoReload(), "after clearAutoReloadGuard: canAutoReload() must be true again");

  console.log("  ✓ Group B: loop guard set/check/clear contract holds");
}

// ---- Group C: GlobalErrorBoundary render tests -----------------------------

async function testErrorBoundaryRender() {
  const React = (await import("react")).default as any;
  const { createRoot } = (await import("react-dom/client")) as any;
  const { act } = (await import("react")) as any;
  const { GlobalErrorBoundary } = await import(
    "../../client/src/components/GlobalErrorBoundary"
  );
  const { canAutoReload, markAutoReloaded, clearAutoReloadGuard } = await import(
    "../../client/src/lib/chunkLoadError"
  );

  // We verify the auto-reload path was taken via two observables:
  //   1. sessionStorage guard is set after a chunk-load error (markAutoReloaded ran)
  //   2. The error screen is NOT rendered (boundary returns null during isAutoReloading)
  // window.location.reload() is a no-op in jsdom and is not spied on; we infer
  // the reload was triggered from the two observables above.

  // Suppress React's boundary-error console.error during these render tests.
  const origConsoleError = console.error.bind(console);
  console.error = (...args: any[]) => {
    const msg = typeof args[0] === "string" ? args[0] : "";
    if (
      msg.includes("The above error occurred") ||
      msg.includes("[ErrorBoundary]") ||
      msg.includes("React will try to recreate") ||
      msg.includes("act(") ||
      msg.includes("Error: Failed to fetch dynamically") ||
      msg.includes("Error: Importing a module script") ||
      msg.includes("Error: Cannot read") ||
      msg.includes("Not implemented: navigation")
    ) return;
    origConsoleError(...args);
  };

  const container = dom.window.document.getElementById("root")!;

  // Helper: a child component that throws the given error on render.
  function Thrower({ error }: { error: Error }) {
    throw error;
  }

  // ---- Scenario C1: stale-chunk error → auto-reload path, no error screen ----
  //
  // We infer the reload path was taken via two observables:
  //   a) sessionStorage guard was set (markAutoReloaded ran inside componentDidCatch)
  //   b) error-boundary-fallback is NOT rendered (boundary renders null while isAutoReloading=true)

  dom.window.sessionStorage.clear();

  const chunkErr = new Error(
    "Failed to fetch dynamically imported module: https://app.example.com/assets/Dashboard-BXa3k9Lm.js",
  );

  let root: any;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(GlobalErrorBoundary, null,
        React.createElement(Thrower, { error: chunkErr }),
      ),
    );
  });
  await flush(4);

  assert.equal(
    byTestId("error-boundary-fallback"),
    null,
    "C1: error-boundary-fallback must NOT be shown during auto-reload (boundary renders null)",
  );
  assert.ok(
    !canAutoReload(),
    "C1: sessionStorage guard must be set after the auto-reload path fires",
  );

  await act(async () => { root.unmount(); });
  console.log("  ✓ Scenario C1: stale-chunk error → auto-reload path, no error screen, guard set");

  // ---- Scenario C2: generic runtime error → error screen, no guard set ----

  dom.window.sessionStorage.clear();

  container.innerHTML = "";
  const runtimeErr = new Error("Cannot read properties of null (reading 'map')");

  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(GlobalErrorBoundary, null,
        React.createElement(Thrower, { error: runtimeErr }),
      ),
    );
  });
  await flush(4);

  assert.ok(
    byTestId("error-boundary-fallback") !== null,
    "C2: error-boundary-fallback must be shown for a genuine runtime error",
  );
  assert.ok(
    bodyText().includes("Something went wrong"),
    "C2: 'Something went wrong' heading must be visible",
  );
  assert.ok(
    canAutoReload(),
    "C2: sessionStorage guard must NOT be set for a genuine runtime error (it is not a chunk-load failure)",
  );

  await act(async () => { root.unmount(); });
  console.log("  ✓ Scenario C2: generic runtime error → error screen shown, no guard set");

  // ---- Scenario C3: second chunk-load error while guard is active → error screen ----

  dom.window.sessionStorage.clear();
  markAutoReloaded(); // simulate: guard already set (first auto-reload already happened)

  container.innerHTML = "";
  const chunkErr2 = new Error("Importing a module script failed.");

  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(GlobalErrorBoundary, null,
        React.createElement(Thrower, { error: chunkErr2 }),
      ),
    );
  });
  await flush(4);

  assert.ok(
    byTestId("error-boundary-fallback") !== null,
    "C3: error screen must show when loop-guard is active (no second auto-reload)",
  );
  assert.ok(
    !canAutoReload(),
    "C3: guard must still be set (not cleared by the fallback-render path)",
  );

  await act(async () => { root.unmount(); });

  // Cleanup.
  clearAutoReloadGuard();
  dom.window.sessionStorage.clear();
  console.error = origConsoleError;

  console.log("  ✓ Scenario C3: second chunk-load error while guard active → error screen (no loop)");
}

// ---- Group D: guard cleared on successful mount ----------------------------
//
// Models the App.tsx useEffect that calls clearAutoReloadGuard() after a
// successful render.  Verifies that a component which mounts normally resets
// the one-shot budget so the NEXT stale-chunk error can still auto-reload.

async function testGuardClearedOnSuccessfulMount() {
  const { act } = await import("react");
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { GlobalErrorBoundary } = await import("../../client/src/components/GlobalErrorBoundary");
  const { markAutoReloaded, canAutoReload, clearAutoReloadGuard } =
    await import("../../client/src/lib/chunkLoadError");
  const { useEffect } = React;

  dom.window.sessionStorage.clear();

  // Pre-condition: guard was set by a previous auto-reload.
  markAutoReloaded();
  assert.ok(
    !canAutoReload(),
    "D setup: guard must be active after markAutoReloaded()",
  );

  // A thin component that mirrors the App.tsx useEffect pattern.
  function GuardClearer() {
    useEffect(() => { clearAutoReloadGuard(); }, []);
    return React.createElement("div", { "data-testid": "guard-clearer" }, "ok");
  }

  const container = dom.window.document.getElementById("root")!;
  let root: any;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(GlobalErrorBoundary, null,
        React.createElement(GuardClearer),
      ),
    );
  });
  await flush(4);

  assert.ok(
    canAutoReload(),
    "D1: guard must be cleared after successful startup mount (App's clearAutoReloadGuard effect ran)",
  );

  await act(async () => { root.unmount(); });
  dom.window.sessionStorage.clear();

  console.log(
    "  ✓ Scenario D1: successful mount clears reload guard → next stale-chunk can auto-reload",
  );
}

// ---- Group E: unhandledrejection path (Task #2885) --------------------------
//
// Chunk errors raised inside async data fetches / event handlers never reach
// the React error boundary — they surface as unhandled promise rejections.
// initChunkLoadErrorHandler() attaches a window listener applying the same
// isChunkLoadError + loop-guard logic.

async function testUnhandledRejectionPath() {
  const { initChunkLoadErrorHandler, __test_resetChunkLoadErrorHandler } =
    await import("../../client/src/lib/chunkLoadErrorInit");
  const { canAutoReload, markAutoReloaded, clearAutoReloadGuard } =
    await import("../../client/src/lib/chunkLoadError");

  // jsdom's location.reload is non-configurable, so we use the handler's
  // injectable reload seam to observe reload calls.
  let reloadCount = 0;

  function dispatchRejection(reason: unknown): boolean {
    const event = new dom.window.Event("unhandledrejection", { cancelable: true });
    (event as any).reason = reason;
    dom.window.dispatchEvent(event);
    return event.defaultPrevented;
  }

  __test_resetChunkLoadErrorHandler();
  initChunkLoadErrorHandler({ reload: () => { reloadCount++; } });
  // Idempotency: calling twice must not attach a second listener.
  initChunkLoadErrorHandler({ reload: () => { reloadCount++; } });

  // ---- E1: stale-chunk rejection → reload + guard set ----
  dom.window.sessionStorage.clear();
  reloadCount = 0;

  const prevented = dispatchRejection(
    new Error("Failed to fetch dynamically imported module: https://app.example.com/assets/Reports-Ck2x.js"),
  );

  assert.equal(reloadCount, 1, "E1: exactly one reload for a stale-chunk rejection (double-listener would reload twice)");
  assert.ok(!canAutoReload(), "E1: guard must be set after the unhandledrejection auto-reload");
  assert.ok(prevented, "E1: event.preventDefault() must be called for the handled rejection");
  console.log("  ✓ Scenario E1: stale-chunk unhandledrejection → single reload, guard set");

  // ---- E2: generic rejection → no reload, no guard ----
  dom.window.sessionStorage.clear();
  reloadCount = 0;

  dispatchRejection(new Error("Cannot read properties of null (reading 'map')"));
  dispatchRejection("some string rejection");
  dispatchRejection(undefined);

  assert.equal(reloadCount, 0, "E2: no reload for non-chunk rejections");
  assert.ok(canAutoReload(), "E2: guard must NOT be set for non-chunk rejections");
  console.log("  ✓ Scenario E2: generic rejections → no reload, no guard");

  // ---- E3: stale-chunk rejection while guard active → no second reload ----
  dom.window.sessionStorage.clear();
  markAutoReloaded();
  reloadCount = 0;

  dispatchRejection(new Error("Importing a module script failed."));

  assert.equal(reloadCount, 0, "E3: no reload while the loop guard is active");
  assert.ok(!canAutoReload(), "E3: guard must remain set");
  console.log("  ✓ Scenario E3: stale-chunk rejection while guard active → no reload loop");

  // Cleanup.
  clearAutoReloadGuard();
  dom.window.sessionStorage.clear();
}

// ---- Run all ----------------------------------------------------------------

async function main() {
  await testClassifier();
  await testLoopGuard();
  await testErrorBoundaryRender();
  await testGuardClearedOnSuccessfulMount();
  await testUnhandledRejectionPath();
}

main()
  .then(() => {
    console.log("\nPASS tests/client/stale-chunk-error-boundary.test.tsx");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nFAIL tests/client/stale-chunk-error-boundary.test.tsx");
    console.error(err);
    process.exit(1);
  });
