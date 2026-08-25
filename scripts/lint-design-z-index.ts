/**
 * lint-design-z-index — Task #4347 design-contract ratchet (4 of 4).
 *
 * Frozen-count ratchet: raw Tailwind z utilities (z-10, z-50, -z-10, z-[60],
 * …) in tracked client/src/**\/*.{ts,tsx} may only DECREASE relative to the
 * committed baseline scripts/design-contract-baseline.json. The layering
 * contract is the CSS z-scale in client/src/index.css (--z-base 0, --z-raised
 * 2, --z-sticky 10, --z-nav 40, --z-overlay 50, --z-toast 100); z-auto and
 * z-[var(--z-…)] / z-(--z-…) references are allowed. Reductions are locked in
 * via: npx tsx scripts/regen-design-contract-baseline.ts
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
  return runDesignLint("zIndex", opts);
}

export function cliMain(): number {
  return runLint().exitCode;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-design-z-index.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
