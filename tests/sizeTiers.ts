/**
 * Test-size tier policy (Task #5031).
 *
 * Registration remains decentralized: each suite records its tier in its own
 * test-registration block. This module owns the shared meanings so lints,
 * portfolio governance, and policy guards cannot drift.
 */
import type { TestRegistration } from "./testRegistry";

export const TEST_SIZE_TIERS = ["small", "medium", "large"] as const;
export type TestSizeTier = (typeof TEST_SIZE_TIERS)[number];

/**
 * Ceiling is the measured-duration boundary before the 25% observation
 * headroom applied by the lint. Large is deliberately capped: a suite above
 * this needs to be split or optimized, not silently become an unbounded lane.
 */
export const TIER_CEILING_MS: Record<TestSizeTier, number> = {
  small: 30_000,
  medium: 90_000,
  large: 420_000,
};
export const TIER_MEASUREMENT_HEADROOM = 1.25;

export interface KeepBlockingException {
  file: string;
  reason: string;
}

/**
 * Owner-approved exceptions only. Empty by explicit approval for the initial
 * migration: a future large suite can remain smoke-gated only with a
 * substantive entry here and a policy-guard update.
 */
export const KEEP_BLOCKING_EXCEPTIONS: readonly KeepBlockingException[] = [];

/**
 * Deliberately import/call-shaped rather than word-shaped: fixture prose that
 * merely names a browser vendor must not make an ordinary test large.
 */
const BROWSER_HARNESS_PATTERN =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](?:puppeteer(?:-core)?|playwright(?:-core|\/test)?)["']/;
const DEV_SERVER_HARNESS_PATTERN =
  /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|execa|execaSync)\s*\(\s*["'](?:npx|npm|pnpm|yarn|tsx|vite|next|node)["'][\s\S]{0,220}?(?:["'](?:dev|start|serve|vite|next)["']|["'](?:server|app)\/[^"']+["'])/;

export interface HarnessClassification {
  browser: boolean;
  devServer: boolean;
}

export function classifyHarness(source: string): HarnessClassification {
  return {
    browser: BROWSER_HARNESS_PATTERN.test(source),
    devServer: DEV_SERVER_HARNESS_PATTERN.test(source),
  };
}

export function isHeavyHarness(source: string): boolean {
  const harness = classifyHarness(source);
  return harness.browser || harness.devServer;
}

/**
 * Mechanical initial tier. An unmeasured suite defaults to medium: "small"
 * must be earned by a published measurement. Browser/dev-server harnesses are
 * large even if their last green was fast because their resources are costly.
 */
export function recommendTier(source: string, durationMs: number | null): TestSizeTier {
  if (isHeavyHarness(source)) return "large";
  if (durationMs === null) return "medium";
  if (durationMs > TIER_CEILING_MS.medium) return "large";
  if (durationMs > TIER_CEILING_MS.small) return "medium";
  return "small";
}

export function isKeepBlocking(file: string): boolean {
  return KEEP_BLOCKING_EXCEPTIONS.some((entry) => entry.file === file);
}

export interface TierValidationInput {
  file: string;
  source: string;
  durationMs: number | null;
  registration: TestRegistration;
}

/**
 * Semantic policy validation. Structural field type validation remains in
 * testRegistry.ts; this deliberately stays lint-level so a missing annotation
 * cannot make the runner silently omit a suite.
 */
export function validateTierPolicy(input: TierValidationInput): string[] {
  const { file, source, durationMs, registration } = input;
  const errors: string[] = [];
  const tier = registration.tier;
  if (!tier) {
    errors.push(
      `"tier" is required — classify this suite as "small", "medium", or "large" (run the mechanical classifier; unmeasured suites default to "medium")`,
    );
    return errors;
  }

  const expected = recommendTier(source, durationMs);
  if (tier === "large" && !registration.tierReason) {
    errors.push(
      `"tier": "large" requires a substantive "tierReason" (slow measurement or browser/dev-server resource need)`,
    );
  }
  if (tier !== expected && !registration.tierReason) {
    errors.push(
      `"tier": "${tier}" differs from its mechanical "${expected}" classification and requires "tierReason" explaining the override`,
    );
  }

  if (durationMs !== null) {
    const allowed = TIER_CEILING_MS[tier] * TIER_MEASUREMENT_HEADROOM;
    if (durationMs > allowed) {
      errors.push(
        `measured ${Math.round(durationMs)}ms exceeds the "${tier}" tier ceiling of ${TIER_CEILING_MS[tier]}ms with ${Math.round((TIER_MEASUREMENT_HEADROOM - 1) * 100)}% headroom — split or optimize the suite, or justify a tier bump${tier === "large" ? " (large is the final tier)" : ""}`,
      );
    }
  }

  if (isHeavyHarness(source) && tier !== "large") {
    errors.push(
      `browser/dev-server harnesses require "tier": "large" regardless of last measured duration`,
    );
  }
  if (tier === "large" && registration.smoke === true && !isKeepBlocking(file)) {
    errors.push(
      `"tier": "large" cannot declare "smoke": true — remove it and record a sweepOnlyReason; only an owner-approved KEEP_BLOCKING_EXCEPTIONS entry may retain blocking status`,
    );
  }
  if (isKeepBlocking(file) && tier !== "large") {
    errors.push(
      `KEEP_BLOCKING_EXCEPTIONS contains this suite but it is not "tier": "large" — remove the stale exception`,
    );
  }
  return errors;
}