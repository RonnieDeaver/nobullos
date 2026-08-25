/**
 * lint-design-hex-colors — Task #4347 design-contract ratchet (1 of 4).
 *
 * Frozen-count ratchet: hardcoded 6/8-digit hex colors in tracked
 * client/src/**\/*.{ts,tsx} may only DECREASE relative to the committed
 * baseline scripts/design-contract-baseline.json. New occurrences fail the
 * gate with the token alternative (client/src/index.css palette); reductions
 * are locked in via: npx tsx scripts/regen-design-contract-baseline.ts
 *
 * Shared engine: scripts/designContractRatchet.ts (masking, matcher, baseline
 * integrity, two-sided comparison). Read-only by contract — no fs-write APIs,
 * no CLI flags (guard-tested). Registered in gate.ts LINT_CHECKS; guard suite:
 * tests/lint-design-contract-ratchets.test.ts.
 */
import {
  runDesignLint,
  type DesignLintResult,
  type RunDesignLintOptions,
} from "./designContractRatchet.ts";

export function runLint(opts: RunDesignLintOptions = {}): DesignLintResult {
  return runDesignLint("hexColors", opts);
}

export function cliMain(): number {
  return runLint().exitCode;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-design-hex-colors.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
