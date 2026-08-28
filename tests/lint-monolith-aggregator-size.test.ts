/* test-registration
{
  "name": "lint-monolith-aggregator-size regrowth guard (Task #3787)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3787 + Task #4161/F13: the monolith-split regrowth guard. The fourteen split composition roots (server/index.ts, server/routes.ts, serviceDesk/comms routes, commsStorage, Comms.tsx, ClickUpModule.tsx, PublicReport.tsx, plus the 2026-08 program roots: integrations routes, prodActionsRegistry, FrontHistoricalRecoveryPanel, MatchSettings, RateLimitUsers, HealthDashboardSection) must stay thin or whole-file merge conflicts return. The managed Long validation workflow runs the reviewed routine-gate profile, including this lint through gate.ts LINT_CHECKS. Fast, DB-free, deterministic (line-count fixtures + real-tree scan).",
  "tier": "small"
}
test-registration */
/**
 * Task #3787 — Regression test for the monolith-split regrowth guard.
 * Task #4161/F13 extended the covered set with the 2026-08 architecture
 * program's six composition roots (F6, F7, F11A–D).
 *
 * The fourteen files covered by scripts/lint-monolith-aggregator-size.ts were
 * 2,300–10,800-line monoliths and the top source of whole-file merge
 * conflicts before the per-feature splits. This test proves:
 *   1. A fixture tree with all registered aggregators within budget passes.
 *   2. An over-budget aggregator is flagged, and the violation points at
 *      the per-feature module directory where the code belongs instead.
 *   3. A missing aggregator is reported as unreadable (file moves update
 *      BUDGETS in the same change).
 *   4. The REAL repository's aggregators are within budget — the assertion
 *      that keeps the Task #3787 split from regressing.
 *   5. Wiring lockstep: gate.ts LINT_CHECKS registers the lint and the drift
 *      guard defines `LONG_VALIDATION_WORKFLOW` with the exact managed Long validation command.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runLint } from "../scripts/lint-monolith-aggregator-size";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const AGGREGATORS = [
  "server/index.ts",
  "server/routes/serviceDesk.ts",
  "server/routes/comms.ts",
  "server/storage/commsStorage.ts",
  "client/src/pages/Comms.tsx",
  "client/src/pages/admin/ClickUpModule.tsx",
  // PR9 (Task f1425127): routes.ts joined the capped aggregators after its
  // 6.4k-line inline route block moved into server/routes/* feature modules.
  "server/routes.ts",
  // Task #4161/F13: the 2026-08 architecture program's six split roots
  // (F6 integrations routes, F7 prod-actions barrel, F11A–D admin roots).
  "server/routes/integrations.ts",
  "server/services/prodActionsRegistry.ts",
  "client/src/components/admin/FrontHistoricalRecoveryPanel.tsx",
  "client/src/pages/admin/MatchSettings.tsx",
  "client/src/pages/admin/RateLimitUsers.tsx",
  "client/src/components/admin/health/HealthDashboardSection.tsx",
  // Task #4271: the PublicReport client-report monolith joined after its
  // per-slide split into client/src/pages/publicReport/.
  "client/src/pages/PublicReport.tsx",
];

function writeLines(root: string, rel: string, lineCount: number): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, Array.from({ length: lineCount }, (_, i) => `// line ${i}`).join("\n") + "\n");
}

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lint-monolith-size-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// 1. All registered aggregators within budget → passes.
{
  const { root, cleanup } = fixture();
  try {
    for (const rel of AGGREGATORS) writeLines(root, rel, 10);
    const res = runLint(root);
    assert(res.ok, "all-under-budget fixture passes");
  } finally {
    cleanup();
  }
}

// 2. One aggregator over budget → flagged with the module-dir redirect.
{
  const { root, cleanup } = fixture();
  try {
    for (const rel of AGGREGATORS) writeLines(root, rel, 10);
    writeLines(root, "server/routes/comms.ts", 200); // budget for this aggregator: 80
    const res = runLint(root);
    assert(!res.ok, "over-budget aggregator fails the lint");
    assert(
      res.message.includes("server/routes/comms.ts"),
      "violation names the offending aggregator",
    );
    assert(
      res.message.includes("server/routes/comms/"),
      "violation points at the per-feature module dir",
    );
  } finally {
    cleanup();
  }
}

// 3. Missing aggregator → unreadable violation demanding a BUDGETS update.
{
  const { root, cleanup } = fixture();
  try {
    for (const rel of AGGREGATORS) writeLines(root, rel, 10);
    rmSync(join(root, "server/index.ts"));
    const res = runLint(root);
    assert(!res.ok, "missing aggregator fails the lint");
    assert(res.message.includes("unreadable"), "missing file reported as unreadable");
  } finally {
    cleanup();
  }
}

// 4. The real repository's aggregators are within budget.
{
  const res = runLint();
  assert(res.ok, `real repo aggregators within budget (${res.message})`);
  if (!res.ok) console.error(`    ${res.message}`);
}

// 5. Wiring lockstep: gate LINT_CHECKS + managed Long validation workflow command.
{
  const gateSrc = readFileSync(new URL("../scripts/gate.ts", import.meta.url), "utf8");
  const driftSrc = readFileSync(
    new URL("../scripts/lint-gate-workflow-drift.ts", import.meta.url),
    "utf8",
  );
  assert(
    gateSrc.includes('"lint-monolith-aggregator-size"'),
    "gate.ts LINT_CHECKS registers the lint",
  );
  assert(
    /export const LONG_VALIDATION_WORKFLOW\s*=\s*\{[\s\S]*?command:\s*"npm run validate:long -- --request \.local\/runs\/long-validation-request\.json"/.test(driftSrc),
    "drift guard defines LONG_VALIDATION_WORKFLOW with the exact managed Long validation command",
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
