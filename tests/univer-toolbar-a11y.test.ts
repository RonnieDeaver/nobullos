/* test-registration
{
  "name": "Univer toolbar a11y shim — vendor data-u-command items get accessible names, visible-text and pre-labeled items untouched, MutationObserver re-labels re-renders",
  "regression": true,
  "smoke": true,
  "smokeReason": "The doc-editor Univer toolbar is vendor DOM with zero accessible names (Task #4660 flag) — this shim is the ONLY thing that makes ~12 formatting buttons usable with a screen reader. Pins the whole contract in jsdom against a replica of the vendor markup: known command ids get Univer's own tooltip wording, unknown ids humanize instead of staying nameless, visible-text selectors and pre-labeled elements are never double-labeled, and the observer re-labels vendor re-renders. DB-free, network-free, ~1s.",
  "extraEnv": {
    "NODE_ENV": "test",
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Tests for client/src/lib/univerToolbarA11y.ts — the post-mount labeling
 * pass that gives Univer's icon-only toolbar buttons accessible names, keyed
 * on the `data-u-command` attribute Univer stamps on every toolbar item
 * (verified against the pinned @univerjs/ui 0.25.1 build).
 *
 * The fixture DOM replicates the vendor toolbar shapes that matter:
 *   - icon-only <button data-u-command> (the flagged unlabeled set),
 *   - selector <div data-u-command> with visible text (font/size/heading —
 *     must NOT be double-labeled),
 *   - icon-only selector <div data-u-command> (text color) — labeled,
 *   - an element that already has an aria-label — untouched,
 *   - an unknown command id — humanized fallback, never nameless.
 *
 * No React, no Univer: pure DOM contract in jsdom.
 */
import { strict as assert } from "node:assert";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='wrap'></div></body></html>");
const { document } = dom.window;
// The observer helper news up MutationObserver + queueMicrotask from globals.
(globalThis as any).MutationObserver = dom.window.MutationObserver;

const {
  labelUniverToolbar,
  observeUniverToolbarA11y,
  humanizeUniverCommandId,
  UNIVER_TOOLBAR_LABELS,
} = await import("../client/src/lib/univerToolbarA11y");

function buildToolbar(): HTMLElement {
  const wrap = document.getElementById("wrap")!;
  wrap.innerHTML = `
    <div data-u-comp="ribbon-toolbar">
      <button type="button" data-u-command="doc.command.set-inline-format-bold"><svg></svg></button>
      <button type="button" data-u-command="doc.command.set-inline-format-italic"><svg></svg></button>
      <button type="button" data-u-command="doc.command.order-list"><svg></svg></button>
      <div data-u-command="doc.command.set-inline-format-font-family"><span>Arial</span></div>
      <div data-u-command="doc.command.set-inline-format-text-color"><svg></svg><svg></svg></div>
      <button type="button" data-u-command="univer.command.undo" aria-label="Undo already"><svg></svg></button>
      <button type="button" data-u-command="doc.command.some-future-thing"><svg></svg></button>
    </div>`;
  return wrap;
}

// ── 1. Known ids get Univer's own tooltip wording ────────────────────────────
{
  const wrap = buildToolbar();
  const labeled = labelUniverToolbar(wrap);
  assert.equal(
    wrap.querySelector("[data-u-command$='bold']")!.getAttribute("aria-label"),
    "Bold",
    "bold button gets Univer's tooltip wording",
  );
  assert.equal(
    wrap.querySelector("[data-u-command$='italic']")!.getAttribute("aria-label"),
    "Italic",
  );
  assert.equal(
    wrap.querySelector("[data-u-command$='order-list']")!.getAttribute("aria-label"),
    "Ordered list",
  );
  // Icon-only selector div (text color) is labeled too.
  assert.equal(
    wrap.querySelector("[data-u-command$='text-color']")!.getAttribute("aria-label"),
    "Text color",
  );
  // 2. Visible-text selector is NOT double-labeled.
  assert.equal(
    wrap.querySelector("[data-u-command$='font-family']")!.getAttribute("aria-label"),
    null,
    "selector with visible text must not get an aria-label",
  );
  // 3. Pre-labeled element untouched.
  assert.equal(
    wrap.querySelector("[data-u-command='univer.command.undo']")!.getAttribute("aria-label"),
    "Undo already",
  );
  // 4. Unknown id falls back to humanized form — never nameless.
  assert.equal(
    wrap.querySelector("[data-u-command$='future-thing']")!.getAttribute("aria-label"),
    "Some future thing",
  );
  assert.equal(labeled, 5, "labels exactly the nameless icon-only items");
  // Idempotent: second pass labels nothing new.
  assert.equal(labelUniverToolbar(wrap), 0);
}

// ── humanizer unit cases ─────────────────────────────────────────────────────
assert.equal(
  humanizeUniverCommandId("doc.command.set-inline-format-bold"),
  "Set inline format bold",
);
assert.equal(humanizeUniverCommandId(""), "");
// The map's wording stays aligned with @univerjs/docs-ui en-US tooltips.
assert.equal(UNIVER_TOOLBAR_LABELS["doc.command.check-list"], "Task list");
assert.equal(UNIVER_TOOLBAR_LABELS["docs.operation.open-page-setting"], "Page Setup");
// Sheet toolbar ids (Task #4707) stay aligned with @univerjs/sheets-ui en-US.
assert.equal(UNIVER_TOOLBAR_LABELS["sheet.command.set-range-bold"], "Bold");
assert.equal(UNIVER_TOOLBAR_LABELS["sheet.command.set-once-format-painter"], "Paint format");
assert.equal(UNIVER_TOOLBAR_LABELS["sheet.command.add-worksheet-merge"], "Merge cells");
assert.equal(UNIVER_TOOLBAR_LABELS["sheet.command.set-range-stroke"], "Strikethrough");

// ── 5. Observer re-labels vendor re-renders ──────────────────────────────────
{
  const wrap = buildToolbar();
  const dispose = observeUniverToolbarA11y(wrap);
  // Initial pass ran synchronously.
  assert.equal(
    wrap.querySelector("[data-u-command$='bold']")!.getAttribute("aria-label"),
    "Bold",
  );
  // Simulate a Univer re-render: new nameless button appears.
  const btn = document.createElement("button");
  btn.setAttribute("data-u-command", "doc.command.set-inline-format-underline");
  wrap.querySelector("[data-u-comp='ribbon-toolbar']")!.appendChild(btn);
  // MutationObserver callbacks + our coalescing run on microtasks.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(
    btn.getAttribute("aria-label"),
    "Underline",
    "observer labels buttons added by vendor re-renders",
  );
  dispose();
  // After dispose, new buttons are no longer labeled.
  const btn2 = document.createElement("button");
  btn2.setAttribute("data-u-command", "doc.command.set-inline-format-strikethrough");
  wrap.querySelector("[data-u-comp='ribbon-toolbar']")!.appendChild(btn2);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(btn2.getAttribute("aria-label"), null, "disposer disconnects the observer");
}

console.log("univer-toolbar-a11y: all assertions passed");
