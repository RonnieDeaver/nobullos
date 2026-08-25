/* test-registration
{
  "name": "lint-test-registration guard (Task #3306, reworked by Task #3786)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3306/#3786: the test-registration guard's own test. Since #3786 the runner derives its registry from per-file registration blocks by discovery; a test file with a missing/invalid block would make the runner refuse to start, so this lint (and this test of it) is what keeps that failure fast and attributable in the routine gate. The final assertions run the lint over the REAL repo tree. Fast, DB-free, deterministic (directory walk + block parsing).",
  "tier": "small"
}
test-registration */
/**
 * Tests for scripts/lint-test-registration.ts (Task #3306, reworked by
 * Task #3786 to enforce per-file registration blocks instead of a central
 * TESTS array in tests/run-all.ts).
 *
 * Covers:
 *  - discovery (nested dirs, .ts/.tsx, non-test files ignored, client/src
 *    scanned too — the pre-#3786 lint only walked tests/)
 *  - structural validation (missing block, block not at line 1, unclosed
 *    block, invalid JSON, unknown keys, field type errors, BOM tolerance)
 *  - the real repo is clean (every on-disk test file carries a valid block)
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint } from "../scripts/lint-test-registration";
import {
  MAX_BLOCK_LINES,
  parseRegistration,
  validateRegistrationShape,
} from "./testRegistry";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function block(json: unknown): string {
  return `/* test-registration\n${JSON.stringify({ tier: "medium", ...(json as object) }, null, 2)}\ntest-registration */\n`;
}

// ---------------------------------------------------------------------------
console.log("parseRegistration — structural cases");
{
  const good = parseRegistration(block({ name: "X" }) + "export {};\n");
  check("minimal valid block parses", good.registration?.name === "X");

  const bom = parseRegistration("\uFEFF" + block({ name: "X" }));
  check("BOM before the marker is tolerated", bom.registration?.name === "X");

  const missing = parseRegistration(`import x from "y";\n`);
  check(
    "missing block is an error mentioning line 1",
    missing.registration === null && /line 1/.test(missing.errors[0] ?? ""),
  );

  const notFirst = parseRegistration("\n" + block({ name: "X" }));
  check("block not starting at line 1 is an error", notFirst.registration === null);

  const unclosed = parseRegistration(`/* test-registration\n{ "name": "X" }\n`);
  check(
    "unclosed block is an error mentioning the end marker",
    unclosed.registration === null && /never closes/.test(unclosed.errors[0] ?? ""),
  );

  const farEnd =
    "/* test-registration\n" +
    `{ "name": "X" }\n` +
    "\n".repeat(MAX_BLOCK_LINES + 10) +
    "test-registration */\n";
  check("end marker beyond MAX_BLOCK_LINES is an error", parseRegistration(farEnd).registration === null);

  const badJson = parseRegistration(`/* test-registration\n{ name: X }\ntest-registration */\n`);
  check(
    "invalid JSON is an error mentioning JSON",
    badJson.registration === null && /JSON/.test(badJson.errors[0] ?? ""),
  );
}

// ---------------------------------------------------------------------------
console.log("validateRegistrationShape — field validation");
{
  const cases: Array<[string, unknown, RegExp]> = [
    ["non-object rejected", [1, 2], /object/],
    ["missing name rejected", {}, /"name"/],
    ["empty name rejected", { name: "  " }, /"name"/],
    ["unknown key rejected", { name: "X", smokeFiles: true }, /unknown key "smokeFiles"/],
    // Task #3862: the retired shared-dev escape hatch must stay rejected so a
    // suite can never quietly re-tag itself back onto the shared dev DB.
    ["retired sharedDev key rejected", { name: "X", sharedDev: true, sharedDevReason: "r" }, /unknown key "sharedDev"/],
    ["retired sharedDevReason key rejected", { name: "X", sharedDevReason: "r" }, /unknown key "sharedDevReason"/],
    ["non-boolean regression rejected", { name: "X", regression: "yes" }, /"regression"/],
    ["non-boolean smoke rejected", { name: "X", smoke: 1 }, /"smoke"/],
    ["missing size tier rejected", { name: "X" }, /"tier" is required/],
    ["unknown size tier rejected", { name: "X", tier: "tiny" }, /"tier"/],
    ["empty smokeReason rejected", { name: "X", smokeReason: "" }, /"smokeReason"/],
    ["zero timeoutMs rejected", { name: "X", timeoutMs: 0 }, /"timeoutMs"/],
    ["fractional timeoutMs rejected", { name: "X", timeoutMs: 1.5 }, /"timeoutMs"/],
    ["empty extraNodeArgs rejected", { name: "X", extraNodeArgs: [] }, /"extraNodeArgs"/],
    ["non-string extraNodeArgs item rejected", { name: "X", extraNodeArgs: [1] }, /"extraNodeArgs"/],
    ["empty extraEnv rejected", { name: "X", extraEnv: {} }, /"extraEnv"/],
    ["non-string extraEnv value rejected", { name: "X", extraEnv: { A: 1 } }, /"extraEnv"/],
  ];
  for (const [label, input, re] of cases) {
    const { registration, errors } = validateRegistrationShape(input);
    check(label, registration === null && errors.some((e) => re.test(e)), errors.join("; "));
  }

  const full = validateRegistrationShape({
    name: "X",
    regression: true,
    smoke: true,
    smokeReason: "fast",
    tier: "small",
    timeoutMs: 300_000,
    extraNodeArgs: ["--import", "./tests/setup.mjs"],
    extraEnv: { TSX_TSCONFIG_PATH: "./tsconfig.tests.json" },
    notes: "context",
  });
  check("fully-populated valid registration accepted", full.registration !== null, full.errors.join("; "));
}

// ---------------------------------------------------------------------------
console.log("runLint — fixture tree");
const root = mkdtempSync(join(tmpdir(), "lint-test-registration-"));
try {
  mkdirSync(join(root, "tests/nested"), { recursive: true });
  mkdirSync(join(root, "client/src/components"), { recursive: true });

  writeFileSync(join(root, "tests/good.test.ts"), block({ name: "Good" }) + "export {};\n");
  writeFileSync(
    join(root, "tests/nested/good2.test.tsx"),
    block({ name: "Good2", regression: true, sweepOnlyReason: "slow" }) + "export {};\n",
  );
  writeFileSync(join(root, "tests/helper.ts"), "export const h = 1;\n"); // not a test — ignored
  writeFileSync(join(root, "tests/setup.mjs"), "export {};\n"); // not a test — ignored
  writeFileSync(join(root, "tests/missing.test.ts"), "export {};\n");
  writeFileSync(join(root, "tests/badjson.test.ts"), `/* test-registration\n{ nope }\ntest-registration */\n`);
  writeFileSync(join(root, "tests/badfield.test.ts"), block({ name: "X", timeoutMs: -5 }));
  writeFileSync(
    join(root, "client/src/components/widget.test.ts"),
    "export {};\n", // client/src is scanned too (pre-#3786 blind spot)
  );

  const res = runLint({ repoRoot: root });
  check("fixture: onDiskCount counts only *.test.ts(x)", res.onDiskCount === 6, String(res.onDiskCount));
  check("fixture: validCount", res.validCount === 2, String(res.validCount));
  check("fixture: not ok", res.ok === false);
  const offenderFiles = res.offenders.map((o) => o.file);
  check(
    "fixture: missing-block file flagged",
    offenderFiles.includes("tests/missing.test.ts"),
  );
  check("fixture: bad-JSON file flagged", offenderFiles.includes("tests/badjson.test.ts"));
  check("fixture: bad-field file flagged", offenderFiles.includes("tests/badfield.test.ts"));
  check(
    "fixture: client/src file without a block flagged (old lint's blind spot closed)",
    offenderFiles.includes("client/src/components/widget.test.ts"),
  );
  check(
    "fixture: helper/setup files not flagged",
    !offenderFiles.some((f) => f.endsWith("helper.ts") || f.endsWith("setup.mjs")),
  );

  // Fix the offenders → lint turns green.
  writeFileSync(join(root, "tests/missing.test.ts"), block({ name: "M" }) + "export {};\n");
  writeFileSync(join(root, "tests/badjson.test.ts"), block({ name: "B" }) + "export {};\n");
  writeFileSync(join(root, "tests/badfield.test.ts"), block({ name: "F", timeoutMs: 60_000 }));
  writeFileSync(
    join(root, "client/src/components/widget.test.ts"),
    block({ name: "W" }) + "export {};\n",
  );
  const green = runLint({ repoRoot: root });
  check("fixture: all repaired → ok", green.ok === true && green.validCount === 6, JSON.stringify(green.offenders));
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("real repo is clean");
{
  const real = runLint();
  check("real repo: ok", real.ok === true, JSON.stringify(real.offenders.slice(0, 5)));
  check("real repo: every discovered file valid", real.validCount === real.onDiskCount);
  check(
    "real repo: discovery sees the full suite (>700 files)",
    real.onDiskCount > 700,
    String(real.onDiskCount),
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll lint-test-registration checks passed");
