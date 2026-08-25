/* test-registration
{
  "name": "lint-notification-shared-row drift guard (Task #4514)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4514: guards the Task #4473 NotificationRow consolidation. The bell dropdown and /notifications page must keep rendering the shared NotificationRow or the visual parity gap silently reopens. The Validate workflow runs npm run gate, including this lint through gate.ts LINT_CHECKS. Fast, DB-free, deterministic (string fixtures + real-tree check).",
  "tier": "small"
}
test-registration */
/**
 * Task #4514 — Regression test for scripts/lint-notification-shared-row.ts.
 *
 * Proves:
 *   1. Fixture surfaces that import the shared NotificationRow pass.
 *   2. Dropping the shared import from either surface fails.
 *   3. A local `function/const NotificationRow` re-declaration fails.
 *   4. Importing NotificationRow from a non-shared module fails.
 *   4b. Retaining the shared import but never rendering <NotificationRow>
 *       (e.g. a differently named local replacement) fails — for BOTH
 *       surfaces.
 *   5. Declarations inside comments do NOT trip the guard.
 *   6. The REAL repository surfaces pass (the assertion that keeps the
 *      Task #4473 consolidation from regressing) and the shared file exists.
 *   7. Wiring lockstep: gate.ts LINT_CHECKS registers the lint and the drift
 *      guard defines `VALIDATION_WORKFLOW` with command `npm run gate`.
 */

import { readFileSync } from "node:fs";
import { runLint, SURFACE_FILES } from "../scripts/lint-notification-shared-row";

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

const BELL = SURFACE_FILES[0];
const PAGE = SURFACE_FILES[1];

const GOOD = `import { NotificationRow } from "@/components/NotificationRow";
export function Surface() {
  return <NotificationRow variant="compact" />;
}
`;

// 1. Both surfaces import the shared row → passes.
{
  const res = runLint({
    sourceOverrides: { [BELL]: GOOD, [PAGE]: GOOD },
    skipSharedFileCheck: true,
  });
  assert(res.ok, "good fixture surfaces pass");
}

// 2. Dropping the shared import from one surface → fails, names the surface.
{
  const res = runLint({
    sourceOverrides: { [BELL]: GOOD, [PAGE]: "export function Surface() { return null; }" },
    skipSharedFileCheck: true,
  });
  assert(!res.ok, "missing shared import fails");
  assert(
    res.errors.some((e) => e.includes(PAGE) && e.includes("no longer imports")),
    "violation names the surface that dropped the import",
  );
}

// 3. Local re-declaration → fails.
{
  const bad =
    GOOD + `function NotificationRow() { return null; }\n`;
  const res = runLint({
    sourceOverrides: { [BELL]: bad, [PAGE]: GOOD },
    skipSharedFileCheck: true,
  });
  assert(!res.ok, "local function NotificationRow declaration fails");
  assert(
    res.errors.some((e) => e.includes(BELL) && e.includes("local `function NotificationRow`")),
    "violation names the local declaration",
  );

  const badConst =
    GOOD + `const NotificationRow = () => null;\n`;
  const res2 = runLint({
    sourceOverrides: { [BELL]: GOOD, [PAGE]: badConst },
    skipSharedFileCheck: true,
  });
  assert(!res2.ok, "local const NotificationRow declaration fails");
}

// 4. Import from a non-shared module → fails.
{
  const bad = `import { NotificationRow } from "./localRow";
export function Surface() { return <NotificationRow />; }
`;
  const res = runLint({
    sourceOverrides: { [BELL]: bad, [PAGE]: GOOD },
    skipSharedFileCheck: true,
  });
  assert(!res.ok, "non-shared-module import fails");
  assert(
    res.errors.some((e) => e.includes('"./localRow"')),
    "violation names the offending module",
  );

  const aliased = `import { Row as NotificationRow } from "./localRow";
export function Surface() { return <NotificationRow />; }
`;
  const res2 = runLint({
    sourceOverrides: { [BELL]: GOOD, [PAGE]: aliased },
    skipSharedFileCheck: true,
  });
  assert(!res2.ok, "aliased import from non-shared module fails");
}

// 4b. Unused shared import + differently named local replacement → fails
//     (on whichever surface drifted).
{
  const unusedImport = `import { NotificationRow } from "@/components/NotificationRow";
function BellRow() { return <div />; }
export function Surface() { return <BellRow />; }
`;
  for (const drifted of [BELL, PAGE]) {
    const other = drifted === BELL ? PAGE : BELL;
    const res = runLint({
      sourceOverrides: { [drifted]: unusedImport, [other]: GOOD },
      skipSharedFileCheck: true,
    });
    assert(!res.ok, `unused shared import + local replacement fails (${drifted})`);
    assert(
      res.errors.some((e) => e.includes(drifted) && e.includes("never renders")),
      `violation names the non-rendering surface (${drifted})`,
    );
  }
  // Self-closing and attribute-carrying JSX usages both count as rendering.
  const selfClosing = `import { NotificationRow } from "@/components/NotificationRow";
export function Surface() { return <NotificationRow/>; }
`;
  const res3 = runLint({
    sourceOverrides: { [BELL]: selfClosing, [PAGE]: GOOD },
    skipSharedFileCheck: true,
  });
  assert(res3.ok, "self-closing <NotificationRow/> counts as rendering");
}

// 5. Declarations inside comments don't trip the guard.
{
  const commented =
    GOOD +
    `// const NotificationRow = old;\n/* function NotificationRow() {} */\n`;
  const res = runLint({
    sourceOverrides: { [BELL]: commented, [PAGE]: GOOD },
    skipSharedFileCheck: true,
  });
  assert(res.ok, "commented-out declarations are ignored");
}

// 6. The REAL repository surfaces pass.
{
  const res = runLint();
  assert(res.ok, "real repo surfaces use the shared NotificationRow");
  if (!res.ok) for (const e of res.errors) console.error(`    ${e}`);
}

// 7. Wiring lockstep: gate LINT_CHECKS + Validate workflow command.
{
  const gateSrc = readFileSync(new URL("../scripts/gate.ts", import.meta.url), "utf8");
  const driftSrc = readFileSync(
    new URL("../scripts/lint-gate-workflow-drift.ts", import.meta.url),
    "utf8",
  );
  assert(
    gateSrc.includes('"lint-notification-shared-row"'),
    "gate.ts LINT_CHECKS registers the lint",
  );
  assert(
    /export const VALIDATION_WORKFLOW\s*=\s*\{[\s\S]*?command:\s*"npm run gate"/.test(driftSrc),
    "drift guard defines VALIDATION_WORKFLOW with command npm run gate",
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
