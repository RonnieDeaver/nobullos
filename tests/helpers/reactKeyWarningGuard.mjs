/**
 * Task #2822 — shared guard that turns React's missing-key warning into a
 * loud test failure for rendered report tests.
 *
 * Task #2813 fixed a key=null flicker risk in PublicReport (GBP location
 * cards), but nothing stopped a NEW un-keyed list from shipping: the rendered
 * tests printed React's 'Each child in a list should have a unique "key"
 * prop' warning and still passed. This guard hooks console.error, captures
 * ONLY that warning, and lets the test assert zero occurrences at the end.
 *
 * Scope: strictly the unique-key warning. The pre-existing jsdom/recharts
 * SVG casing noise ("<linearGradient> is using incorrect casing",
 * "unrecognized in this browser", etc.) also goes through console.error and
 * MUST NOT trip this guard — the match is the key-warning literal only.
 *
 * Usage (install BEFORE any React render, assert before the PASS log):
 *   import { installReactKeyWarningGuard } from "../helpers/reactKeyWarningGuard.mjs";
 *   const keyWarningGuard = installReactKeyWarningGuard();
 *   ... renders + assertions ...
 *   keyWarningGuard.assertNoKeyWarnings("<test file label>");
 *
 * Note: React 19's warning names the OWNER component ("Check the render
 * method of `X`"), not the offending list, and a visible key= prop can still
 * be null at runtime (rows lacking `id`). See
 * .agents/memory/react-missing-key-warning-localization.md for how to
 * localize the actual map when this guard fires.
 */

const KEY_WARNING_PATTERN = /Each child in a list should have a unique "key" prop/i;

// Task #4702 — also trap React's DUPLICATE-key warning. Task #4692 fixed two
// duplicate-key sources on the public Marketing slide (location cards keyed by
// a name that repeats on multi-location firms once the share sanitizer strips
// `id`; heatmap cards keyed by a snapshotId that can repeat across locations),
// and the #4671 audit only caught them by manual console inspection. Duplicate
// keys are worse than missing ones — React can drop/mis-reconcile children —
// so the guard fails on both warnings.
const DUPLICATE_KEY_PATTERN = /Encountered two children with the same key/i;

export function installReactKeyWarningGuard() {
  const captured = [];
  const originalError = console.error;

  console.error = (...args) => {
    try {
      const text = args
        .map((a) => {
          if (typeof a === "string") return a;
          if (a instanceof Error) return `${a.name}: ${a.message}`;
          try {
            return String(a);
          } catch {
            return "";
          }
        })
        .join(" ");
      if (KEY_WARNING_PATTERN.test(text) || DUPLICATE_KEY_PATTERN.test(text)) {
        captured.push(text);
      }
    } catch {
      // Never let the guard itself break console.error.
    }
    originalError.apply(console, args);
  };

  return {
    /** Snapshot of the captured key warnings (full joined message text). */
    getKeyWarnings() {
      return [...captured];
    },

    /**
     * Throws if React logged the missing-key warning at any point since the
     * guard was installed. Call after all renders, before the PASS log.
     */
    assertNoKeyWarnings(label) {
      if (captured.length > 0) {
        throw new Error(
          `${label}: React logged a missing-key or duplicate-key warning ${captured.length} time(s) during render — ` +
            "an un-keyed (or key=null at runtime) list is a redraw/flicker risk (Task #2813), and DUPLICATE " +
            "keys can make React drop or mis-reconcile children (Task #4692: sanitized share payloads repeat " +
            "location names and heatmap snapshotIds). Warning(s):\n" +
            captured.map((w, i) => `  [${i + 1}] ${w}`).join("\n") +
            "\nTip: the warning names the OWNER component, not the list; a visible key= prop can still be " +
            "null at runtime (rows lacking `id`). See .agents/memory/react-missing-key-warning-localization.md.",
        );
      }
    },

    /** Restores the original console.error (optional — tests exit anyway). */
    restore() {
      console.error = originalError;
    },
  };
}
