/**
 * lint-design-text-px — Task #4347 design-contract ratchet (2 of 4).
 *
 * Frozen-count ratchet: arbitrary text-[<number>px] font sizes in tracked
 * client/src/**\/*.{ts,tsx} may only DECREASE relative to the committed
 * baseline scripts/design-contract-baseline.json. New occurrences fail the
 * gate with the type-scale alternative (text-display/heading/body/caption in
 * client/src/index.css); reductions are locked in via:
 * npx tsx scripts/regen-design-contract-baseline.ts
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
  return runDesignLint("textPx", opts);
}

export function cliMain(): number {
  return runLint().exitCode;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-design-text-px.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
