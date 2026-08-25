/* test-registration
{
  "name": "Rate limit multipliers preview",
  "tier": "medium"
}
test-registration */
/**
 * End-to-end UI test for the Effective Rate Limits preview table on the
 * Rate Limit Multipliers admin page.
 *
 * The table previews unsaved typed multiplier values:
 *  - cells whose computed value differs from the saved value switch to
 *    "preview" styling (data-preview="true") and show the new computed
 *    number plus a "(was X)" suffix,
 *  - a "Preview (unsaved)" badge appears while changes are pending and goes
 *    away after save,
 *  - adding a brand-new role adds a column tagged "new" until saved.
 *
 * This test renders the production EffectiveRateLimitsPreviewTable component
 * (the same component the admin page renders) into jsdom via
 * react-dom/client. It then exercises the same state transitions the page
 * performs in response to typing a multiplier, adding a role, and clicking
 * save (via a small test harness wired to the same callbacks the page
 * passes to its inputs and Save button), and asserts on the rendered DOM
 * by the same data-testid attributes the page uses. The saved-value
 * pipeline runs through the real server-side computeEffectiveLimits so the
 * end-to-end data flow matches production.
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import * as React from "react";
import { useImperativeHandle, useState, forwardRef, act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  registerLimiterConfig,
  computeEffectiveLimits,
  getLimiterConfigs,
} from "../../server/services/rateLimitMonitor";
import { EffectiveRateLimitsPreviewTable } from "../../client/src/pages/admin/EffectiveRateLimitsPreviewTable";
import type { EffectiveLimitsData } from "../../client/src/pages/admin/rateLimitMultipliersPreview";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

function require$(testId: string): HTMLElement {
  const el = $(testId);
  if (!el) throw new Error(`Expected element [data-testid="${testId}"] to exist in the DOM`);
  return el;
}

interface HarnessHandle {
  /** Equivalent to the user typing a new value in the per-role input. */
  setMultiplier(role: string, value: string): void;
  /** Equivalent to the user filling the new-role inputs and clicking Add. */
  addRole(role: string, value: string): void;
  /** Equivalent to the user clicking the Save Changes button. */
  save(): void;
}

/**
 * Test harness that recreates the slice of the admin page above the preview
 * table: it owns the same editValues/hasChanges state machine the real page
 * uses and renders the production EffectiveRateLimitsPreviewTable. The
 * imperative handle methods invoke the same callbacks the page wires up to
 * the multiplier inputs and the Save button — they simulate the user
 * actions while letting us flush React updates synchronously through act().
 */
const PreviewHarness = forwardRef<HarnessHandle, { initialMultipliers: Record<string, number> }>(
  function PreviewHarness(props, ref) {
    const [savedLimits, setSavedLimits] = useState<EffectiveLimitsData>(() =>
      computeEffectiveLimits(props.initialMultipliers),
    );
    const [editValues, setEditValues] = useState<Record<string, string>>(() => {
      const out: Record<string, string> = {};
      for (const [r, v] of Object.entries(props.initialMultipliers)) out[r] = String(v);
      return out;
    });
    const [hasChanges, setHasChanges] = useState(false);

    useImperativeHandle(
      ref,
      () => ({
        setMultiplier: (role: string, value: string) => {
          setEditValues((prev) => ({ ...prev, [role]: value }));
          setHasChanges(true);
        },
        addRole: (role: string, value: string) => {
          setEditValues((prev) => ({ ...prev, [role]: value }));
          setHasChanges(true);
        },
        save: () => {
          // Same as the page's saveMutation onSuccess: server returns the
          // recomputed effective limits and the page clears hasChanges.
          const next: Record<string, number> = {};
          for (const [r, str] of Object.entries(editValues)) {
            const n = parseFloat(str);
            if (!isNaN(n) && n >= 0.1 && n <= 100) next[r] = n;
          }
          setSavedLimits(computeEffectiveLimits(next));
          setHasChanges(false);
        },
      }),
      [editValues],
    );

    return React.createElement(EffectiveRateLimitsPreviewTable, {
      savedLimits,
      editValues,
      hasPendingEdits: hasChanges,
    });
  },
);

async function main() {
  // Pin a deterministic limiter surface (independent of whatever the running
  // server has registered): two role-aware categories with different bases
  // plus one non-role-aware category. Multipliers must NEVER preview the
  // non-role-aware category.
  const limiterConfigs = getLimiterConfigs();
  limiterConfigs.clear();
  registerLimiterConfig("api", 60_000, 100, true);
  registerLimiterConfig("auth", 60_000, 10, true);
  registerLimiterConfig("static", 60_000, 1000, false);

  const container = document.getElementById("root")!;
  const harnessRef = React.createRef<HarnessHandle>();
  let root: Root | null = null;

  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(PreviewHarness, {
        initialMultipliers: { ceo: 2, team_lead: 1.5 },
        ref: harnessRef,
      } as any),
    );
  });
  if (!harnessRef.current) throw new Error("PreviewHarness ref was not populated");
  // Helper that always reads the current handle. useImperativeHandle re-binds
  // a fresh closure when editValues changes, so calling through the ref
  // ensures save()/addRole() see the latest typed values.
  const harness = {
    setMultiplier: (r: string, v: string) => harnessRef.current!.setMultiplier(r, v),
    addRole: (r: string, v: string) => harnessRef.current!.addRole(r, v),
    save: () => harnessRef.current!.save(),
  };

  // -- Initial load: no preview, no badge -----------------------------------
  assert($("section-effective-limits") !== null, "preview table section must render");
  assert($("badge-preview-unsaved") === null, "Preview (unsaved) badge must NOT show on initial load");
  assert($("badge-new-role-ceo") === null, "ceo header must not have a 'new' tag on initial load");
  for (const cat of ["api", "auth", "static"]) {
    for (const role of ["ceo", "team_lead"]) {
      const cell = require$(`cell-effective-${cat}-${role}`);
      assert(
        cell.getAttribute("data-preview") === "false",
        `[${cat}/${role}] cell must NOT be in preview state on initial load`,
      );
    }
  }
  // Initial rendered numbers reflect saved values.
  assert(
    require$("cell-effective-api-ceo").textContent?.startsWith("200"),
    `api/ceo must show saved value 200 initially, got "${require$("cell-effective-api-ceo").textContent}"`,
  );
  assert(
    require$("cell-effective-static-ceo").textContent?.includes("1000"),
    `static/ceo must show base 1000 initially, got "${require$("cell-effective-static-ceo").textContent}"`,
  );

  // -- Step 1: simulate typing ceo=3 in the multiplier input ----------------
  await act(async () => {
    harness.setMultiplier("ceo", "3");
  });

  // The "Preview (unsaved)" badge appears.
  const badge = require$("badge-preview-unsaved");
  assert(
    badge.textContent?.trim() === "Preview (unsaved)",
    `badge text must be "Preview (unsaved)", got "${badge.textContent}"`,
  );

  // Role-aware ceo cells switch to preview with the new computed value
  // and a "(was X)" suffix.
  const apiCeoCell = require$("cell-effective-api-ceo");
  assert(
    apiCeoCell.getAttribute("data-preview") === "true",
    "api/ceo cell must be in preview state after typing ceo=3",
  );
  assert(
    /\b300\b/.test(apiCeoCell.textContent || ""),
    `api/ceo preview value must include 300 (=100*3), got "${apiCeoCell.textContent}"`,
  );
  assert(
    /was 200/.test(apiCeoCell.textContent || ""),
    `api/ceo cell must show "(was 200)" suffix, got "${apiCeoCell.textContent}"`,
  );
  assert(
    apiCeoCell.className.includes("bg-amber-50"),
    `api/ceo cell must apply preview styling (amber background), got "${apiCeoCell.className}"`,
  );

  const authCeoCell = require$("cell-effective-auth-ceo");
  assert(
    authCeoCell.getAttribute("data-preview") === "true" &&
      /\b30\b/.test(authCeoCell.textContent || ""),
    `auth/ceo must preview to 30, got "${authCeoCell.textContent}"`,
  );

  // Non-role-aware category never previews.
  const staticCeoCell = require$("cell-effective-static-ceo");
  assert(
    staticCeoCell.getAttribute("data-preview") === "false",
    `static/ceo must NOT be in preview state (category is not role-aware)`,
  );

  // Untouched team_lead cell stays non-preview.
  const apiTeamCell = require$("cell-effective-api-team_lead");
  assert(
    apiTeamCell.getAttribute("data-preview") === "false",
    `api/team_lead must remain non-preview when only ceo was changed`,
  );

  // -- Step 2: save → badge clears, no cells preview, value is now saved ---
  await act(async () => {
    harnessRef.current!.save();
  });

  assert($("badge-preview-unsaved") === null, "Preview (unsaved) badge must disappear after save");
  for (const cat of ["api", "auth", "static"]) {
    for (const role of ["ceo", "team_lead"]) {
      const cell = require$(`cell-effective-${cat}-${role}`);
      assert(
        cell.getAttribute("data-preview") === "false",
        `[${cat}/${role}] cell must NOT be in preview state after save`,
      );
    }
  }
  const apiCeoAfterSave = require$("cell-effective-api-ceo");
  assert(
    /\b300\b/.test(apiCeoAfterSave.textContent || "") &&
      !/was/.test(apiCeoAfterSave.textContent || ""),
    `after save api/ceo must show 300 with no "(was X)" suffix, got "${apiCeoAfterSave.textContent}"`,
  );

  // -- Step 3: add a brand-new role 'intern' = 0.5 -------------------------
  await act(async () => {
    harness.addRole("intern", "0.5");
  });

  // New column appears with "new" tag.
  assert($("header-effective-intern") !== null, "intern column header must be rendered");
  const newTag = require$("badge-new-role-intern");
  assert(
    newTag.textContent?.trim() === "new",
    `intern column must have a 'new' tag, got "${newTag.textContent}"`,
  );
  // Existing columns must NOT have a 'new' tag.
  assert(
    $("badge-new-role-ceo") === null,
    "ceo column must NOT have a 'new' tag while intern is the new role",
  );

  // Badge shows again because there's a pending change.
  assert(
    $("badge-preview-unsaved") !== null,
    "Preview (unsaved) badge must show while a new role is pending",
  );

  // Every intern cell is in preview state and has no "(was X)" suffix.
  for (const cat of ["api", "auth", "static"]) {
    const cell = require$(`cell-effective-${cat}-intern`);
    assert(
      cell.getAttribute("data-preview") === "true",
      `[${cat}/intern] cell must be in preview state (new role has no saved value)`,
    );
    assert(
      !/was/.test(cell.textContent || ""),
      `[${cat}/intern] must not show "(was X)" suffix, got "${cell.textContent}"`,
    );
  }
  // Specifically: role-aware previews compute base*0.5 ceil; non-role-aware
  // shows base.
  assert(
    /\b50\b/.test(require$("cell-effective-api-intern").textContent || ""),
    `api/intern must show 50 (=100*0.5), got "${require$("cell-effective-api-intern").textContent}"`,
  );
  assert(
    /\b1000\b/.test(require$("cell-effective-static-intern").textContent || ""),
    `static/intern must show 1000 (base, not multiplied), got "${require$("cell-effective-static-intern").textContent}"`,
  );

  // -- Step 4: save again → 'new' tag and badge both go away ---------------
  await act(async () => {
    harness.save();
  });

  assert(
    $("badge-new-role-intern") === null,
    "intern column must lose the 'new' tag after save",
  );
  assert(
    $("header-effective-intern") !== null,
    "intern column must remain in the table after save",
  );
  assert(
    $("badge-preview-unsaved") === null,
    "Preview (unsaved) badge must disappear after saving the new role",
  );
  for (const cat of ["api", "auth", "static"]) {
    const cell = require$(`cell-effective-${cat}-intern`);
    assert(
      cell.getAttribute("data-preview") === "false",
      `[${cat}/intern] cell must NOT be in preview state after save`,
    );
  }

  // -- Bonus: an out-of-range typed value must NOT change the rendered
  // -- preview value for that role's cells (the helper drops it). The
  // -- production page also surfaces a toast on save, but that path is
  // -- outside the table component's responsibility.
  await act(async () => {
    harness.setMultiplier("ceo", "999"); // above the 100 ceiling
  });
  const apiCeoOutOfRange = require$("cell-effective-api-ceo");
  assert(
    /\b300\b/.test(apiCeoOutOfRange.textContent || ""),
    `api/ceo must keep showing the saved 300 when typed value is out of range, got "${apiCeoOutOfRange.textContent}"`,
  );
  assert(
    apiCeoOutOfRange.getAttribute("data-preview") === "false",
    "api/ceo must NOT flip to preview when typed value is out of range",
  );

  await act(async () => {
    root!.unmount();
  });

  console.log("rate-limit-multipliers-preview: all DOM cases passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
