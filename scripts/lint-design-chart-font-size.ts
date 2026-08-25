/**
 * lint-design-chart-font-size — Task #4500 design-contract ratchet (5 of 5).
 *
 * Frozen-count ratchet with a sanctioned hard floor: numeric fontSize literals
 * (fontSize={N} / fontSize: N — recharts axis ticks, legends, tooltip styles,
 * inline SVG labels) in tracked client/src/**\/*.{ts,tsx} below the 10px
 * chart-internal label floor may only DECREASE relative to the committed
 * baseline scripts/design-contract-baseline.json. The general UI floor stays
 * text-caption 12px (audits/internal-os-design-audit-2026-08.md §4.3,
 * Task #4481); charts are sanctioned down to 10px — never below. The current
 * baseline is ZERO (all offenders snapped in Task #4500), so any new sub-10
 * fontSize fails the gate; reductions are locked in via:
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
  return runDesignLint("chartFontSize", opts);
}

export function cliMain(): number {
  return runLint().exitCode;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-design-chart-font-size.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
