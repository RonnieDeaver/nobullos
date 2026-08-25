#!/usr/bin/env bash
# Pre-deploy validation: runs the full test suite before the deploy build.
# Wired into [deployment].build in .replit so a failing test blocks the deploy.
#
# Skip with PREDEPLOY_SKIP_TESTS=1 (emergency only).

set -euo pipefail

if [[ "${PREDEPLOY_SKIP_TESTS:-0}" == "1" ]]; then
  echo "==> [predeploy] PREDEPLOY_SKIP_TESTS=1 set — SKIPPING test suite. This should only be used for emergency deploys."
  exit 0
fi

echo "==> [predeploy] Running scratch self-clean (Task #3794)..."
set +e
npx tsx scripts/clean-scratch.ts --stale-only
CLEAN_SCRATCH_EXIT_CODE=$?
set -e
if [[ "${CLEAN_SCRATCH_EXIT_CODE}" -ne 0 ]]; then
  echo ""
  echo "============================================================"
  echo "  DEPLOY BLOCKED: clean-scratch FAILED"
  echo "  The scratch GC hit real errors (failed deletions) while"
  echo "  pruning untracked junk and the declared scratch zones."
  echo "  Inspect the errors above; the publish image must not carry"
  echo "  scratch weight (WORKTREE_HYGIENE.md)."
  echo "  (Emergency override: set PREDEPLOY_SKIP_TESTS=1 or"
  echo "   CLEAN_SCRATCH_SKIP=1)"
  echo "============================================================"
  exit "${CLEAN_SCRATCH_EXIT_CODE}"
fi

echo "==> [predeploy] Running worktree-hygiene lint (Task #3794)..."
set +e
npx tsx scripts/lint-worktree-hygiene.ts
HYGIENE_EXIT_CODE=$?
set -e
if [[ "${HYGIENE_EXIT_CODE}" -ne 0 ]]; then
  echo ""
  echo "============================================================"
  echo "  DEPLOY BLOCKED: lint-worktree-hygiene FAILED"
  echo "  Junk-pattern files or unregistered root-level entries are"
  echo "  in the worktree and would ship in the publish image."
  echo "  Run \`npm run clean:scratch\`, move scratch to"
  echo "  .local/scratch/ or tmp/, and register any deliberate new"
  echo "  root entry in scripts/worktreePolicy.ts (WORKTREE_HYGIENE.md)."
  echo "  (Emergency override: set PREDEPLOY_SKIP_TESTS=1 or"
  echo "   LINT_WORKTREE_HYGIENE_SKIP=1)"
  echo "============================================================"
  exit "${HYGIENE_EXIT_CODE}"
fi

echo "==> [predeploy] Running fast SQL array-binding lint (Task #1201)..."
set +e
npx tsx scripts/lint-sql-array-bindings.ts
LINT_EXIT_CODE=$?
set -e
if [[ "${LINT_EXIT_CODE}" -ne 0 ]]; then
  echo ""
  echo "============================================================"
  echo "  DEPLOY BLOCKED: lint-sql-array-bindings FAILED"
  echo "  A production file uses the broken ANY(\${arr}::TYPE[]) pattern."
  echo "  Replace it with bindArrayParam from server/utils/sqlArray.ts."
  echo "  (Emergency override: set PREDEPLOY_SKIP_TESTS=1)"
  echo "============================================================"
  exit "${LINT_EXIT_CODE}"
fi

echo "==> [predeploy] Running migration prefix collision lint (Task #1868)..."
set +e
npx tsx scripts/lint-migration-prefixes.ts
MIG_LINT_EXIT_CODE=$?
set -e
if [[ "${MIG_LINT_EXIT_CODE}" -ne 0 ]]; then
  echo ""
  echo "============================================================"
  echo "  DEPLOY BLOCKED: lint-migration-prefixes FAILED"
  echo "  Two migration files share the same NNNN_ prefix; the deploy"
  echo "  path will silently apply only one (Task #1867 prod incident)."
  echo "  Rename the new file to the next free prefix in migrations/."
  echo "  (Emergency override: set PREDEPLOY_SKIP_TESTS=1 or"
  echo "   LINT_MIGRATION_PREFIXES_SKIP=1)"
  echo "============================================================"
  exit "${MIG_LINT_EXIT_CODE}"
fi

echo "==> [predeploy] Running runbook coverage check (Task #1611)..."
set +e
npx tsx scripts/verify-runbook-coverage.ts
RUNBOOK_EXIT_CODE=$?
set -e
if [[ "${RUNBOOK_EXIT_CODE}" -ne 0 ]]; then
  echo ""
  echo "============================================================"
  echo "  DEPLOY BLOCKED: verify-runbook-coverage FAILED"
  echo "  A new integration or runbook is missing from RUNBOOKS.md's"
  echo "  Runbook Index or Integration Runbook Coverage Matrix."
  echo "  Update RUNBOOKS.md per the messages above and re-run."
  echo "  (Emergency override: set PREDEPLOY_SKIP_TESTS=1)"
  echo "============================================================"
  exit "${RUNBOOK_EXIT_CODE}"
fi

echo "==> [predeploy] Running gate/workflow drift check (Task #3581)..."
set +e
npx tsx scripts/lint-gate-workflow-drift.ts
DRIFT_EXIT_CODE=$?
set -e
if [[ "${DRIFT_EXIT_CODE}" -ne 0 ]]; then
  echo ""
  echo "============================================================"
  echo "  DEPLOY BLOCKED: lint-gate-workflow-drift FAILED"
  echo "  scripts/gate.ts LINT_CHECKS and .replit workflows are out"
  echo "  of sync. When adding a lint script, update BOTH in the"
  echo "  same change (TASK_SELFCHECK.md § 4)."
  echo "  (Emergency override: set PREDEPLOY_SKIP_TESTS=1)"
  echo "============================================================"
  exit "${DRIFT_EXIT_CODE}"
fi

echo "==> [predeploy] Running Front sync_email triage lint (Task #1271)..."
set +e
npx tsx scripts/lint-front-sync-email-triage.ts
TRIAGE_LINT_EXIT_CODE=$?
set -e
if [[ "${TRIAGE_LINT_EXIT_CODE}" -ne 0 ]]; then
  echo ""
  echo "============================================================"
  echo "  DEPLOY BLOCKED: lint-front-sync-email-triage FAILED"
  echo "  A Front sync_email ingestion site skipped triageSyncEmailForMatching,"
  echo "  or an unexpected file writes matchStatus: blocked/dismissed."
  echo "  Route the row through server/services/frontSyncEmailTriage.ts."
  echo "  (Emergency override: set PREDEPLOY_SKIP_TESTS=1)"
  echo "============================================================"
  exit "${TRIAGE_LINT_EXIT_CODE}"
fi

# Task #2893 follow-up: the deploy build runs with the PRODUCTION
# DATABASE_URL (Neon). The test suite bootstraps schema/migrations and
# writes test rows, so it must NEVER run against the prod DB. The full
# gate (lints + typecheck + smoke suite) runs in the dev workspace
# before publish; here we only keep the code-only lints above.
# Discriminator: per the Runtime Truth Table, dev = Helium and prod =
# Neon — the neon.tech hostname IS the environment contract for this
# project. If a non-prod Neon environment is ever introduced, replace
# this with an explicit APP_ENV/DB_ROLE variable in both this script
# and tests/run-all.ts.
if [[ "${DATABASE_URL:-}" == *"neon.tech"* || "${REPLIT_DEPLOYMENT:-}" == "1" ]]; then
  echo "==> [predeploy] Production database detected (deploy build) — SKIPPING the DB-backed test suite."
  echo "    Tests are gated in the dev workspace; running them here would write to the live DB."
  exit 0
fi

# Task #3791 — the test run below is INCREMENTAL: tests/run-all.ts skips
# suites whose input fingerprint matches their last GREEN run in this
# environment (store: .local/state/test-green-store.json, gitignored).
# Publishing after a quiet period therefore no longer pays the full 60–90 min
# suite. The safety guards live in the runner itself, so the command here is
# unchanged:
#   - missing/invalid store, or no full-suite green within the staleness
#     window (TEST_FULL_GREEN_WINDOW_DAYS, default 7) → the runner executes
#     EVERY suite (integrity run);
#   - any store/trace/hash error falls open to executing, never to skipping;
#   - failures never record green; the always-run core is never skipped.
# Set PREDEPLOY_FULL_TESTS=1 to force a genuine full execution regardless of
# the green store (maps to the runner's TEST_FORCE_ALL escape hatch).
if [[ "${PREDEPLOY_FULL_TESTS:-0}" == "1" ]]; then
  echo "==> [predeploy] PREDEPLOY_FULL_TESTS=1 — forcing execution of every suite (no green-skipping)."
  export TEST_FORCE_ALL=1
fi

echo "==> [predeploy] Running test suite (npm test, incremental — Task #3791) before build..."
START_TS=$(date +%s)

# Temporarily disable errexit so we can capture npm test's real exit code.
set +e
npm test
EXIT_CODE=$?
set -e

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

if [[ "${EXIT_CODE}" -ne 0 ]]; then
  echo ""
  echo "============================================================"
  echo "  DEPLOY BLOCKED: pre-deploy test suite FAILED"
  echo "  Elapsed: ${ELAPSED}s   Exit code: ${EXIT_CODE}"
  echo "  Fix the failing tests above and re-run the deploy."
  echo "  (Emergency override: set PREDEPLOY_SKIP_TESTS=1)"
  echo "============================================================"
  exit "${EXIT_CODE}"
fi

echo "==> [predeploy] Test suite PASSED in ${ELAPSED}s. Proceeding to build."
