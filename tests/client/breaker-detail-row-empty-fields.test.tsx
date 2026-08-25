/* test-registration
{
  "name": "BreakerDetailRow hides empty fields gracefully \u2014 render-nothing + partial-field branches (Task #2273)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2273 — Direct component test that `BreakerDetailRow`
 * (`client/src/components/admin/BreakerDetailRow.tsx`) hides empty fields
 * gracefully and only renders the fields it actually has.
 *
 * The shared breaker detail row renders nothing when there is no tripped time,
 * no cooldown, not self-heal-parked, and zero trips, and otherwise selectively
 * shows only the populated fields (e.g. the Zoom auth-gate is sticky and only
 * ever supplies a "Disconnected at" time with no cooldown or trip count).
 *
 * The existing reconnect-banner tests (Tasks #2231 / #2166 / #2194) always pass
 * a fully-populated detail, so the "render nothing" branch and the partial-field
 * branches are never exercised — a refactor could regress that logic (start
 * rendering an empty red row, or show a stale "Auto-retry at" with no cooldown)
 * without any test failing. This mirrors the jsdom harness used by
 * `tests/client/console-pages-reconnect-banner.test.tsx` but renders the
 * component directly with crafted props.
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
(globalThis as any).HTMLSpanElement = dom.window.HTMLSpanElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { BreakerDetailRow } = await import(
  "../../client/src/components/admin/BreakerDetailRow"
);

const PREFIX = "test";

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function render(props: any): Promise<Root> {
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(BreakerDetailRow, { testIdPrefix: PREFIX, ...props }),
    );
  });
  return root!;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

// ── (a) all fields empty/zero → renders nothing ─────────────────────────
console.log("\n— BreakerDetailRow: all fields empty/zero —");
{
  const root = await render({
    lastTrippedAt: null,
    cooldownUntil: null,
    tripCount: 0,
  });
  try {
    assert(
      $(`text-${PREFIX}-breaker-details`) === null,
      "all-empty: BreakerDetailRow must render null (no breaker-details node)",
    );
    assert(
      $(`text-${PREFIX}-breaker-tripped-at`) === null,
      "all-empty: tripped-at span must not render",
    );
    assert(
      $(`text-${PREFIX}-breaker-cooldown-until`) === null,
      "all-empty: cooldown span must not render",
    );
    assert(
      $(`text-${PREFIX}-breaker-trip-count`) === null,
      "all-empty: trip-count span must not render",
    );
    assert(
      $(`text-${PREFIX}-breaker-selfheal-parked`) === null,
      "all-empty: self-heal-parked span must not render",
    );
    console.log("  ✓ renders nothing when there's nothing to show");
  } finally {
    await unmount(root);
  }
}

// Also exercise the truly-undefined props variant (no fields supplied at all).
{
  const root = await render({});
  try {
    assert(
      $(`text-${PREFIX}-breaker-details`) === null,
      "undefined-props: BreakerDetailRow must render null with no props",
    );
    console.log("  ✓ renders nothing when every field is undefined");
  } finally {
    await unmount(root);
  }
}

// ── (b) only lastTrippedAt set → only tripped-at span renders ────────────
console.log("\n— BreakerDetailRow: only lastTrippedAt (sticky Zoom auth-gate shape) —");
{
  const trippedAt = new Date(Date.now() - 60_000).toISOString();
  const root = await render({
    lastTrippedAt: trippedAt,
    cooldownUntil: null,
    tripCount: 0,
  });
  try {
    assert(
      $(`text-${PREFIX}-breaker-details`) !== null,
      "tripped-only: container must render when there's a tripped time",
    );
    const trippedNode = $(`text-${PREFIX}-breaker-tripped-at`);
    assert(trippedNode !== null, "tripped-only: tripped-at span must render");
    assert(
      (trippedNode!.textContent || "").includes("Disconnected at"),
      `tripped-only: tripped-at must read "Disconnected at", got: ${trippedNode!.textContent}`,
    );
    assert(
      $(`text-${PREFIX}-breaker-cooldown-until`) === null,
      "tripped-only: cooldown span must NOT render (no cooldown supplied)",
    );
    assert(
      $(`text-${PREFIX}-breaker-trip-count`) === null,
      "tripped-only: trip-count span must NOT render (zero trips)",
    );
    assert(
      $(`text-${PREFIX}-breaker-selfheal-parked`) === null,
      "tripped-only: self-heal-parked span must NOT render",
    );
    console.log("  ✓ shows only Disconnected-at, hides cooldown + trip-count");
  } finally {
    await unmount(root);
  }
}

// ── (c) only tripCount > 0 → only trip-count span renders ────────────────
console.log("\n— BreakerDetailRow: only tripCount > 0 —");
{
  const root = await render({
    lastTrippedAt: null,
    cooldownUntil: null,
    tripCount: 4,
  });
  try {
    assert(
      $(`text-${PREFIX}-breaker-details`) !== null,
      "count-only: container must render when trips > 0",
    );
    const countNode = $(`text-${PREFIX}-breaker-trip-count`);
    assert(countNode !== null, "count-only: trip-count span must render");
    assert(
      (countNode!.textContent || "").includes("4 trips"),
      `count-only: trip-count must read "4 trips", got: ${countNode!.textContent}`,
    );
    assert(
      $(`text-${PREFIX}-breaker-tripped-at`) === null,
      "count-only: tripped-at span must NOT render",
    );
    assert(
      $(`text-${PREFIX}-breaker-cooldown-until`) === null,
      "count-only: cooldown span must NOT render",
    );
    console.log("  ✓ shows only trip-count, hides tripped-at + cooldown");
  } finally {
    await unmount(root);
  }
}

// Singular "trip" wording when exactly one trip.
{
  const root = await render({ tripCount: 1 });
  try {
    const countNode = $(`text-${PREFIX}-breaker-trip-count`);
    assert(countNode !== null, "single-trip: trip-count span must render");
    assert(
      (countNode!.textContent || "").trim() === "1 trip",
      `single-trip: must read "1 trip" (singular), got: ${countNode!.textContent}`,
    );
    console.log("  ✓ uses singular 'trip' for exactly one trip");
  } finally {
    await unmount(root);
  }
}

console.log(
  "\nbreaker-detail-row-empty-fields: BreakerDetailRow hides empty fields and renders only populated ones.",
);
