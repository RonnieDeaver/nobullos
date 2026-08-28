/* test-registration
{
  "name": "Workflow topology guard: application and durable long-validation roles",
  "smoke": true,
  "smokeReason": "Protects the approved application and durable long-validation workflow topology so normal Run cannot fan out or bypass the canonical gate.",
  "regression": true,
  "tier": "medium",
  "tierReason": "Scans workflow topology and fixture cases to enforce the approved gate structure.",
  "scanPaths": [".replit", "scripts/lint-gate-workflow-drift.ts", "artifacts/mockup-sandbox/.replit-artifact/artifact.toml"]
}
test-registration */

import { readFileSync } from "node:fs";
import { runLint } from "../scripts/lint-gate-workflow-drift.ts";

let failed = 0;
function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

const canonical = readFileSync(".replit", "utf8");

function expectFailure(
  label: string,
  source: string,
  expectedMessage: string,
): void {
  const result = runLint({ replitSource: source });
  assert(!result.ok, `${label} fails`);
  assert(result.message.includes(expectedMessage), `${label} explains the violation`);
}

console.log("1) approved repository topology");
{
  const result = runLint({ replitSource: canonical });
  assert(result.ok, "real .replit passes the approved workflow topology contract");
  assert(
    result.message.includes("Long validation is the sole durable allowlisted control runner"),
    "success output records the durable requested-gate path",
  );
  assert(
    canonical.includes(
      'purpose = "Durable operator-requested canonical gate and main-workspace-only central-integrity control runner (full-control/matched-comparison refused in task/sub-environments)"',
    ),
    "Long validation metadata identifies the durable requested-gate role",
  );
}

console.log("\n2) migration regressions are rejected");
expectFailure(
  "retired foreground validation role",
  `${canonical}\n[[workflows.workflow]]\nname = "Validate"\nauthor = "agent"\n\n[[workflows.workflow.tasks]]\ntask = "shell.exec"\nargs = "npm run gate"\n`,
  'forbidden workflow "Validate"',
);
expectFailure(
  "duplicate role",
  canonical.replace(
    'name = "Long validation"',
    'name = "Long validation"\n\n[[workflows.workflow]]\nname = "Long validation"',
  ),
  'duplicate workflow role "Long validation"',
);
expectFailure(
  "wrong durable validation command",
  canonical.replace(
    'args = "npm run validate:long -- --request .local/runs/long-validation-request.json"',
    'args = "npm run gate"',
  ),
  '"Long validation" command must be "npm run validate:long -- --request .local/runs/long-validation-request.json"',
);
expectFailure(
  "stale foreground validation command",
  canonical.replace(
    'args = "npm run validate:long -- --request .local/runs/long-validation-request.json"',
    'args = "npm run gate"',
  ),
  '"Long validation" command must be "npm run validate:long -- --request .local/runs/long-validation-request.json"',
);
expectFailure(
  "excess workflow",
  `${canonical}\n[[workflows.workflow]]\nname = "Extra"\nauthor = "agent"\n\n[[workflows.workflow.tasks]]\ntask = "shell.exec"\nargs = "true"\n`,
  "workflow capacity is 2 roles with 0 spare slots",
);
expectFailure(
  "forbidden per-lint workflow",
  `${canonical}\n[[workflows.workflow]]\nname = "lint-example"\nauthor = "agent"\n\n[[workflows.workflow.tasks]]\ntask = "shell.exec"\nargs = "npx tsx scripts/lint-example.ts"\n`,
  'forbidden per-lint workflow "lint-example"',
);
expectFailure(
  "wrong long-control command",
  canonical.replace(
    'args = "npm run validate:long -- --request .local/runs/long-validation-request.json"',
    'args = "npm run gate --full-smoke"',
  ),
  '"Long validation" command must be "npm run validate:long -- --request .local/runs/long-validation-request.json"',
);
expectFailure(
  "invalid Run-button target",
  canonical.replace('runButton = "Start application"', 'runButton = "Validate"'),
  'runButton must target "Start application"',
);
expectFailure(
  "application replaced with a long-control command",
  canonical.replace(
    'args = "BOOKING_FEATURE_FLAGS_CACHE_TTL_MS=200 npm run dev"',
    'args = "npm run validate:long -- --request .local/runs/long-validation-request.json"',
  ),
  '"Start application" command must be "BOOKING_FEATURE_FLAGS_CACHE_TTL_MS=200 npm run dev"',
);
expectFailure(
  "application shares the Mockup Sandbox port",
  canonical.replace("waitForPort = 5000", "waitForPort = 23636"),
  '"Start application" attempts to use artifact-reserved port 23636',
);
expectFailure(
  "workflow has no owner metadata",
  canonical.replace('owner = "NoBull OS Control Plane"', 'owner = "Unknown"'),
  'metadata.owner must be "NoBull OS Control Plane"',
);
expectFailure(
  "duplicate protected port mapping",
  `${canonical}\n[[ports]]\nlocalPort = 23636\nexternalPort = 3001\n`,
  "duplicate local port mapping 23636",
);
{
  const result = runLint({
    replitSource: canonical,
    artifactSource: `kind = "design"\npreviewPath = "/__mockup/"\n[[services]]\nname = "Component Preview Server"\npaths = ["/__mockup/"]\nlocalPort = 23636\n[services.development]\nrun = "npm run validate:long -- --request .local/runs/long-validation-request.json"\n[services.env]\nPORT = "23636"\nBASE_PATH = "/__mockup/"\n`,
  });
  assert(!result.ok, "artifact preview cannot be pointed at the long-control command");
  assert(
    result.message.includes("Mockup Sandbox artifact command may not run validation or long-control commands"),
    "artifact fallback violation has a direct remediation",
  );
}

if (failed === 0) {
  console.log("\nlint-gate-workflow-drift test: all assertions passed");
  process.exit(0);
}
console.error(`\nlint-gate-workflow-drift test: ${failed} assertion(s) FAILED`);
process.exit(1);