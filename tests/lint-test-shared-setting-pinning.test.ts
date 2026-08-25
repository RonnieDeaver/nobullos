/* test-registration
{
  "name": "Shared-setting pinning guardrail lint (Task #2379)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2379 — Regression test for the shared-setting pinning guard.
 *
 * Proves:
 *   1. A suite that lists a high-risk switch in its keys-to-restore backup
 *      set (and touches the settings store) but never pins it is flagged.
 *   2. A suite that pins the switch it depends on passes.
 *   3. Referencing the raw key string instead of the constant is still
 *      caught.
 *   4. A suite that never touches the settings store (e.g. a React
 *      component test using the key only as a UI label) is out of scope.
 *   5. A reference that lives only in an import line or a comment is not a
 *      dependency.
 *   6. The real `tests/` tree is clean (every dependent suite pins).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint } from "../scripts/lint-test-shared-setting-pinning";

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

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lint-shared-setting-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// 1. Depends (in backup set, touches store) but never pins → flagged.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "offender.test.ts"),
      [
        "import { SETTING_REFRESH_ENABLED } from '../server/services/frontAnalyticsCoverage';",
        "import { storage } from '../server/storage';",
        "await withSettingsBackup([SETTING_REFRESH_ENABLED], async () => {",
        "  const v = await storage.getSystemSetting(SETTING_REFRESH_ENABLED);",
        "  void v;",
        "});",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(!res.ok, "backed-up-but-unpinned switch trips the lint");
    assert(
      res.offenders.some((o) =>
        /front_analytics_refresh_enabled/.test(o.switchKey),
      ),
      "the unpinned switch is reported",
    );
  } finally {
    cleanup();
  }
}

// 2. Pins the switch it depends on → passes.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "good.test.ts"),
      [
        "import { SETTING_REFRESH_ENABLED } from '../server/services/frontAnalyticsCoverage';",
        "import { storage } from '../server/storage';",
        "await withSettingsBackup([SETTING_REFRESH_ENABLED], async () => {",
        "  await storage.setSystemSetting(SETTING_REFRESH_ENABLED, 'true', 'test');",
        "});",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(res.ok, "pinned switch passes");
    assert(res.offenders.length === 0, "no offenders reported when pinned");
  } finally {
    cleanup();
  }
}

// 3. Raw key string (no constant) is still caught.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "rawkey.test.ts"),
      [
        "import { storage } from '../server/storage';",
        "const KEYS = ['front_analytics_refresh_enabled'];",
        "void KEYS;",
        "const v = await storage.getSystemSetting('front_analytics_refresh_enabled');",
        "void v;",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(!res.ok, "raw-key dependency without a pin is caught");
  } finally {
    cleanup();
  }
}

// 4. Never touches the settings store → out of scope.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "ui-label.test.tsx"),
      [
        "const SETTING = 'front_analytics_refresh_enabled';",
        "render(<Toast label={`${SETTING}=false`} />);",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(
      res.ok,
      "a suite that never calls get/setSystemSetting is out of scope",
    );
  } finally {
    cleanup();
  }
}

// 5. Reference only in an import line or comment is not a dependency.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "import-and-comment.test.ts"),
      [
        "import { SETTING_REFRESH_ENABLED } from '../server/services/frontAnalyticsCoverage';",
        "import { storage } from '../server/storage';",
        "// SETTING_REFRESH_ENABLED is the master; we inject the value below.",
        "await storage.setSystemSetting('some_other_key', 'x', 'test');",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(
      res.ok,
      "a switch referenced only in an import/comment is not a dependency",
    );
  } finally {
    cleanup();
  }
}

// 6. The real tests/ tree is clean.
{
  const res = runLint("tests");
  if (!res.ok) {
    for (const o of res.offenders) {
      console.error(`    ${o.file} > ${o.reason}`);
    }
  }
  assert(
    res.ok,
    "tests/ tree: every suite depending on a high-risk switch pins it",
  );
}

console.log(`\n  passed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exit(1);
