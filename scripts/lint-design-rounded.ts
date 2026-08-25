/**
 * lint-design-rounded — Task #4347 design-contract ratchet (3 of 4).
 *
 * Frozen-count ratchet: off-contract rounded-* utilities in tracked
 * client/src/**\/*.{ts,tsx} may only DECREASE relative to the committed
 * baseline scripts/design-contract-baseline.json. The corner contract is
 * square (--radius: 0rem) with rounded-pill as the sole sanctioned exception;
 * rounded-none / rounded-full (and side/corner -none/-full variants for pill
 * segment caps) are allowed. Everything else (rounded-xs…4xl, side variants
 * with those sizes, non-token arbitrary values) is frozen and may not grow.
 * Reductions are locked in via: npx tsx scripts/regen-design-contract-baseline.ts
 *
 * Bare `rounded` and side-only forms (e.g. rounded-t) are deliberately not
 * counted: under Tailwind v4 they resolve to var(--radius) = 0rem — the token.
 *
 * Shared engine: scripts/designContractRatchet.ts. Read-only by contract — no
 * fs-write APIs, no CLI flags (guard-tested). Registered in gate.ts LINT_CHECKS;
 * guard suite: tests/lint-design-contract-ratchets.test.ts.
 */
import {
  runDesignLint,
  type DesignLintResult,
  type RunDesignLintOptions,
} from "./designContractRatchet.ts";

export function runLint(opts: RunDesignLintOptions = {}): DesignLintResult {
  return runDesignLint("rounded", opts);
}

export function cliMain(): number {
  return runLint().exitCode;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-design-rounded.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
