/* test-registration
{
  "name": "Task-validation instruction surfaces retain the manual-gate, built-in-review policy",
  "regression": true,
  "smoke": true,
  "smokeReason": "The owner-approved manual-gate task-validation policy (2026-08-26) is repeated across task-facing runbooks, every-agent guidance, planner guidance, and canonical policy. Stale mandatory-gate wording could re-impose a required per-task npm run gate and contradict the built-in-review policy. Pure fs marker assertions are DB-free, network-free, deterministic, and run in milliseconds; lint-* makes this repo-scanning guard always-run.",
  "scanPaths": ["TASK_PREFLIGHT.md", "TASK_SELFCHECK.md", "TESTING.md", "CODE_QUALITY.md", "RUNBOOKS.md", "replit.md", ".agents/skills/architecture-governor/SKILL.md", "audits/preflight-selfcheck-findings.md", ".agents/memory/MEMORY.md", ".agents/memory/completion-review-stale-base.md", ".agents/memory/rerun-failed-suite-with-extranodeargs.md", ".agents/memory/upstream-red-attribution-rails.md", ".agents/memory/completion-commit-sweeps-untracked.md", "scripts/taskGatePolicy.ts"],
  "tier": "small"
}
test-registration */
/**
 * Guards the task-facing validation policy against prose drift.
 *
 * Owner decision (2026-08-26): routine task completion is validated by
 * Replit's own built-in completion review. `npm run gate` (typecheck + every
 * registered lint + the related-smoke test subset) is no longer a required
 * per-task completion step — it remains a fully-functional, manual,
 * operator-triggered audit tool with its own nightly/weekly/post-merge
 * lanes. These surfaces are deliberately read by different roles; they must
 * all state that plainly and must not reintroduce a mandatory per-task gate
 * run. The canonical TESTING.md section still describes the gate mechanics
 * (dispositions, fail-closed matrix, test-control-plane handoff) for whenever
 * it runs manually or on a scheduled lane — that is not a mandate either.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const read = (path: string): string => readFileSync(join(repoRoot, path), "utf8");
const normalize = (text: string): string => text.replace(/\s+/g, " ");

const TASK_FACING_SURFACES = [
  "TASK_PREFLIGHT.md",
  "TASK_SELFCHECK.md",
  "CODE_QUALITY.md",
  "replit.md",
  ".agents/skills/architecture-governor/SKILL.md",
] as const;

const POLICY_TEXT_SURFACES = [
  ...TASK_FACING_SURFACES,
  "TESTING.md",
  "RUNBOOKS.md",
  "audits/preflight-selfcheck-findings.md",
  ".agents/memory/MEMORY.md",
  ".agents/memory/completion-review-stale-base.md",
  ".agents/memory/rerun-failed-suite-with-extranodeargs.md",
  ".agents/memory/upstream-red-attribution-rails.md",
  ".agents/memory/completion-commit-sweeps-untracked.md",
] as const;

function assertMarkers(path: string, markers: readonly string[]): void {
  const content = normalize(read(path)).toLowerCase();
  for (const marker of markers) {
    assert.ok(
      content.includes(marker.toLowerCase()),
      `${path} lost manual-gate task-validation anchor "${marker}". Restore the owner-approved (2026-08-26) policy statement.`,
    );
  }
}

function assertNoMandatoryGateMandate(path: string): void {
  const content = read(path);
  const obsoleteMandates = [
    /(?:task agent|task branch|task completion|every task)[\s\S]{0,240}(?:must|is required to|has to)[\s\S]{0,240}(?:run|pass)[\s\S]{0,120}npm run gate/i,
    /npm run gate[\s\S]{0,120}must (?:pass|be run)[\s\S]{0,120}before[\s\S]{0,120}(?:marking|complet)/i,
    /run one final bounded[\s\S]{0,40}npm run gate/i,
    /focused behavior (?:check|coverage) plus one final bounded gate/i,
    /A task touching the test control plane[\s\S]{0,400}(?:must|requires)[\s\S]{0,400}(?:TEST_FORCE_ALL=1|--force-all)[\s\S]{0,400}(?:full-smoke|full-integrity)/i,
    /zero-skip,\s*zero-deferral full-integrity gate/i,
    /(?:run|execute|pass)\s+(?:`?npm run gate`?|`?npm run check`?|`?npm test[^.\n]*|a focused (?:test|check|lint))[^.\n]{0,140}(?:before|prior to)[^.\n]{0,100}(?:mark|complete|done)/i,
    /(?:before|prior to)\s+(?:marking|declaring|completing)[^.\n]{0,100}[,:]\s*(?:run|execute|pass)\s+(?:`?npm run gate`?|`?npm run check`?|`?npm test|a focused (?:test|check|lint))/i,
    /(?:routine|normal|every|each)\s+(?:task|task agent|completion)[^.\n]{0,180}(?:must|should|is required to)\s+(?:run|execute|pass|verify)[^.\n]{0,140}(?:gate|test|lint|typecheck)/i,
    /(?:completion|built-in review|review rejection)[^.\n]{0,180}(?:must|should|is required to)\s+(?:run|retry|rerun|launch)[^.\n]{0,140}(?:test|lint|typecheck|gate|review)/i,
    /(?:after|following)\s+(?:a\s+)?(?:completion|built-in)\s+review[^.\n]{0,120}[,:]\s*(?:run|retry|rerun|launch)/i,
    /gates?\s+(?:merges?|completions?)/i,
  ];
  for (const pattern of obsoleteMandates) {
    assert.doesNotMatch(
      content,
      pattern,
      `${path} restored an obsolete mandatory per-task gate requirement (${pattern}).`,
    );
  }
}

function assertBoundedReviewResponse(path: string): void {
  const content = normalize(read(path)).toLowerCase();
  for (const marker of [
    "preserve the task diff",
    "do not request a fresh review",
    "task-owned",
    "compensating",
  ]) {
    assert.ok(
      content.includes(marker),
      `${path} lost the bounded completion-review response marker "${marker}".`,
    );
  }
}

function assertNoFreshReviewRequest(path: string): void {
  const content = normalize(read(path)).replace(
    /\b(?:do not|never)\s+request(?:ing)?\s+(?:at most one|a|one)\s+fresh review\b/gi,
    "",
  );
  for (const pattern of [
    /\brequest\s+(?:at most one|a|one)\s+fresh review\b/i,
    /\b(?:at most one|one)\s+fresh review at most\b/i,
    /\brequest_fresh_code_review\b/i,
  ]) {
    assert.doesNotMatch(
      content,
      pattern,
      `${path} restored a credit-consuming fresh-review request (${pattern}).`,
    );
  }
}

const COMMON_MARKERS = [
  "built-in completion review",
  "manual, operator-triggered",
  "operator",
  "review-by-inspection",
] as const;

// replit.md is a one-line pointer to the canonical policy and deliberately
// does not restate the owner-decision date or every disposition label; the
// detailed runbooks/skill do.
const SURFACE_MARKERS: Record<(typeof TASK_FACING_SURFACES)[number], readonly string[]> = {
  "TASK_PREFLIGHT.md": [...COMMON_MARKERS, "deferred-and-not-verified", "2026-08-26"],
  "TASK_SELFCHECK.md": [...COMMON_MARKERS, "deferred-and-not-verified", "2026-08-26"],
  "CODE_QUALITY.md": [...COMMON_MARKERS, "2026-08-26"],
  "replit.md": COMMON_MARKERS,
  ".agents/skills/architecture-governor/SKILL.md": [...COMMON_MARKERS, "deferred-and-not-verified", "2026-08-26"],
};

test("all task-facing instruction surfaces state the manual-gate, built-in-review policy", () => {
  for (const path of TASK_FACING_SURFACES) {
    assertMarkers(path, SURFACE_MARKERS[path]);
    assertBoundedReviewResponse(path);
    assertNoFreshReviewRequest(path);
    assertNoMandatoryGateMandate(path);
  }
});

test("canonical testing policy states the owner decision and still describes gate mechanics", () => {
  const testing = normalize(read("TESTING.md"));
  for (const marker of [
    "### Bounded task-validation policy (owner-approved)",
    "Owner decision (2026-08-26): for routine task completion, this repository",
    "relies on Replit's own built-in completion review",
    "is no longer a required per-task completion step",
    "That does not touch the harness.",
    "Running the harness manually.",
    "Test-control-plane changes.",
    "validated the same way as any other routine task — by Replit's built-in",
  ]) {
    assert.ok(testing.includes(normalize(marker)), `TESTING.md lost canonical manual-gate policy anchor "${marker}".`);
  }
  assertNoMandatoryGateMandate("TESTING.md");
  assertBoundedReviewResponse("TESTING.md");
  assertNoFreshReviewRequest("TESTING.md");
});

test("historical and memory guidance cannot restore completion-review test loops", () => {
  for (const path of POLICY_TEXT_SURFACES) {
    assertNoMandatoryGateMandate(path);
    assertNoFreshReviewRequest(path);
  }
  assertMarkers("RUNBOOKS.md", [
    "non-executing inspection",
    "manual, operator-triggered",
    "built-in review",
  ]);
  assertBoundedReviewResponse(".agents/memory/completion-review-stale-base.md");
});

test("task-gate policy preserves the explicit central-integrity deferred proof", () => {
  const policy = normalize(read("scripts/taskGatePolicy.ts"));
  for (const marker of [
    '"deferred-and-not-verified"',
    '"central-integrity"',
    "centralIntegrityDeferred",
    "test-control-plane changes require a central-integrity handoff",
    "deferred work lacks accepted-green or central-integrity proof",
  ]) {
    assert.ok(policy.includes(marker), `scripts/taskGatePolicy.ts lost central-integrity marker "${marker}".`);
  }
});

// End of task-validation policy guard.
