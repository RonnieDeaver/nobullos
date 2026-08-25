/**
 * lint-design-primary-white — Task #4726 design-contract ratchet (6th category).
 *
 * Frozen-count ratchet: hand-rolled white-on-primary pairings (a line carrying
 * both an unprefixed `bg-primary[/NN]` and an unprefixed `text-white[/NN]`
 * token) in tracked client/src/**\/*.{ts,tsx} may only DECREASE relative to
 * the committed baseline scripts/design-contract-baseline.json. Task #4719
 * swept the hard-coded `bg-primary text-white` chips onto
 * text-primary-foreground; new pairings fail the gate with that remedy.
 * Report-deck files (.report-surface marker, pinned light theme) are exempt.
 * Reductions are locked in via: npx tsx scripts/regen-design-contract-baseline.ts
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
  return runDesignLint("primaryWhite", opts);
}

export function cliMain(): number {
  return runLint().exitCode;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-design-primary-white.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
