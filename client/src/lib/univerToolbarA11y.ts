/**
 * univerToolbarA11y — accessible names for the Univer vendor toolbar.
 *
 * The pinned Univer version (0.25.x) renders its ribbon/toolbar buttons with
 * NO accessible name: each item is an icon-only <button> (or selector <div>)
 * whose human name exists only as a hover tooltip that never reaches the DOM
 * until hover (TooltipWrapper renders it lazily). There is no locale or
 * accessibility config that would emit aria-labels — verified against the
 * shipped `@univerjs/ui` build: only the ribbon "more"/"menu"/sidebar-close
 * controls get aria-labels upstream.
 *
 * What Univer DOES stamp on every toolbar item is `data-u-command` — the id
 * of the command the item executes (e.g. "doc.command.set-inline-format-bold").
 * That id is a stable public identifier (it is the same id used by
 * `commandService.executeCommand`), so we key a bounded post-mount labeling
 * pass on it:
 *
 *   - known ids get the exact wording of Univer's own en-US tooltips
 *     (copied from `@univerjs/docs-ui` locale so SR users hear what sighted
 *     users read on hover);
 *   - unknown ids (new buttons after an upgrade) fall back to a humanized
 *     form of the id's last segment, so nothing regresses to nameless;
 *   - items that already have visible text (font/size/heading selectors) or
 *     an aria-label are skipped.
 *
 * Re-renders are handled by a childList-only MutationObserver (the pass only
 * sets attributes, so it can never re-trigger itself) with microtask
 * coalescing. Purely additive — never touches Univer's handlers or layout.
 *
 * Revisit on Univer upgrade: if a future version ships native accessible
 * names (grep the vendor bundle for `aria-label` on ToolbarButton), delete
 * this shim.
 */

/**
 * Exact en-US tooltip wording from `@univerjs/docs-ui` (locale/en-US),
 * keyed by the command id Univer stamps as `data-u-command`.
 */
export const UNIVER_TOOLBAR_LABELS: Record<string, string> = {
  // Core (from @univerjs/core / ui)
  "univer.command.undo": "Undo",
  "univer.command.redo": "Redo",
  "univer.command.copy": "Copy",
  "univer.command.cut": "Cut",
  "univer.command.paste": "Paste",
  // Docs inline formatting (@univerjs/docs-ui)
  "doc.command.set-inline-format-bold": "Bold",
  "doc.command.set-inline-format-italic": "Italic",
  "doc.command.set-inline-format-underline": "Underline",
  "doc.command.set-inline-format-strikethrough": "Strikethrough",
  "doc.command.set-inline-format-subscript": "Subscript",
  "doc.command.set-inline-format-superscript": "Superscript",
  "doc.command.set-inline-format-font-family": "Font",
  "doc.command.set-inline-format-fontsize": "Font size",
  "doc.command.set-inline-format-text-color": "Text color",
  "doc.command.reset-inline-format-text-background-color": "Text background color",
  // Docs structure / layout
  "doc.command.set-paragraph-named-style": "Heading",
  "doc.command.order-list": "Ordered list",
  "doc.command.bullet-list": "Unordered list",
  "doc.command.check-list": "Task list",
  "doc.command.remove-horizontal-line": "Horizontal line",
  "doc.command.create-table": "Table",
  "doc.command.open-header-footer-panel": "Header & Footer",
  "docs.operation.open-page-setting": "Page Setup",
  "doc.command.switch-mode": "Modern Mode",
  // Seen live in the rendered toolbar (no docs-ui tooltip key of their own)
  "doc.command.align-action": "Alignment",
  "base-ui.operation.toggle-shortcut-panel": "Keyboard shortcuts",
  // Sheets toolbar (@univerjs/sheets-ui menu tooltip keys → en-US locale
  // wording; command ids from @univerjs/sheets / sheets-ui 0.25.x builds).
  "sheet.command.set-once-format-painter": "Paint format",
  "sheet.command.set-range-bold": "Bold",
  "sheet.command.set-range-italic": "Italic",
  "sheet.command.set-range-underline": "Underline",
  "sheet.command.set-range-stroke": "Strikethrough",
  "sheet.command.set-range-subscript": "Subscript",
  "sheet.command.set-range-superscript": "Superscript",
  "sheet.command.set-range-font-family": "Font",
  "sheet.command.set-range-fontsize": "Font size",
  "sheet.command.set-range-font-increase": "Increase font size",
  "sheet.command.set-range-font-decrease": "Decrease font size",
  "sheet.command.set-range-text-color": "Text color",
  "sheet.command.set-background-color": "Fill color",
  "sheet.command.set-border-basic": "Border",
  "sheet.command.add-worksheet-merge": "Merge cells",
  "sheet.command.set-horizontal-text-align": "Horizontal align",
  "sheet.command.set-vertical-text-align": "Vertical align",
  "sheet.command.set-text-wrap": "Text wrap",
  "sheet.command.set-text-rotation": "Text rotate",
  "sheet.command.toggle-gridlines": "Toggle Gridlines",
  "sheet.command.clear-selection-all": "Clear All",
  "sheet.command.add-range-protection-from-toolbar": "Protection",
  // Number format (@univerjs/sheets-numfmt-ui en-US tooltips) — the decimal
  // buttons' ids end in ".command", which the humanizer would turn into a
  // useless bare "Command".
  "sheet.command.numfmt.set.percent": "Percentage",
  "sheet.command.numfmt.set.currency": "Currency",
  "sheet.command.numfmt.add.decimal.command": "Increase decimal places",
  "sheet.command.numfmt.subtract.decimal.command": "Decreasing decimal places",
};

/**
 * Fallback for command ids missing from the map (e.g. buttons added by a
 * future Univer upgrade): humanize the last dot-segment —
 * "doc.command.set-inline-format-bold" → "Set inline format bold".
 */
export function humanizeUniverCommandId(id: string): string {
  const tail = id.split(".").pop() ?? "";
  const words = tail.split("-").filter(Boolean).join(" ").trim();
  if (!words) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * One bounded labeling pass: give every `[data-u-command]` toolbar item under
 * `root` an aria-label unless it already has one or already exposes visible
 * text (selector-style items render their value as text). Returns the number
 * of elements labeled (useful for tests/diagnostics).
 */
export function labelUniverToolbar(root: ParentNode): number {
  let labeled = 0;
  const items = root.querySelectorAll<HTMLElement>(
    "[data-u-command]:not([aria-label])",
  );
  items.forEach((el) => {
    const commandId = el.getAttribute("data-u-command");
    if (!commandId) return;
    // Visible text is already an accessible name — don't double-speak it.
    if ((el.textContent ?? "").trim().length > 0) return;
    const label =
      UNIVER_TOOLBAR_LABELS[commandId] ?? humanizeUniverCommandId(commandId);
    if (!label) return;
    el.setAttribute("aria-label", label);
    labeled += 1;
  });
  return labeled;
}

/**
 * Run the labeling pass now and again after every DOM change under `root`
 * (Univer re-creates toolbar items on state changes / overflow re-layout).
 * childList-only: our own setAttribute calls can never re-trigger the
 * observer, and bursts coalesce onto one microtask. Returns a disposer.
 */
export function observeUniverToolbarA11y(root: HTMLElement): () => void {
  labelUniverToolbar(root);
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      labelUniverToolbar(root);
    });
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
