/* test-registration
{
  "name": "Ads OS Phase 0 mutate guard — greps server/services/adsOs/** for Google Ads mutate service names/verbs (Task #3596)",
  "smoke": true,
  "smokeReason": "Task #3596: Ads OS Phase 0 mutate guard — greps server/services/adsOs/** for Google Ads mutate service names/verbs; fails if any appear. The Ads OS rebuild is strictly read-only. DB-free, network-free, fast static-analysis check.",
  "scanPaths": [
    "server/services/adsOs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Ads OS mutate guard.
 *
 * Greps the server/services/adsOs/ directory for Google Ads mutate service names
 * and mutate verbs. Fails immediately if any appear — Ads OS is read-only and must
 * never call a Google Ads mutate endpoint.
 *
 * Checked patterns (from the Google Ads API v24 service reference):
 *   - Any service name ending in "Service" paired with ".mutate" or "Mutate"
 *   - The word "mutate" or "Mutate" as an identifier/method call in context
 *     (excluding this comment and string literals inside test files)
 *   - Known mutate-only service names: CampaignService, AdGroupService,
 *     AdGroupAdService, KeywordPlanService, BudgetService, etc.
 *
 * This test is in SMOKE_FILES so every routine gate run catches a regression.
 */

import * as fs from "fs";
import * as path from "path";
import * as assert from "assert/strict";

const ADS_OS_DIR = path.resolve("server/services/adsOs");

function readDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...readDir(full));
    else if (e.isFile() && /\.(ts|js)$/.test(e.name)) files.push(full);
  }
  return files;
}

const MUTATE_PATTERNS: { name: string; regex: RegExp }[] = [
  // Any call to a mutate method on a Google Ads client object
  { name: ".mutate(", regex: /\.mutate\s*\(/ },
  { name: "Mutate method/service reference", regex: /\bMutate[A-Z]|\b[a-z]+Mutate\s*\(/ },
  // Known mutate-only service names that would never appear in read-only code
  { name: "CampaignService.mutate", regex: /CampaignService/ },
  { name: "AdGroupService", regex: /AdGroupService/ },
  { name: "AdGroupAdService", regex: /AdGroupAdService/ },
  { name: "KeywordPlanService", regex: /KeywordPlanService/ },
  { name: "BudgetService", regex: /BudgetService/ },
  { name: "BiddingStrategyService", regex: /BiddingStrategyService/ },
  { name: "ConversionActionService", regex: /ConversionActionService/ },
  { name: "CustomerService.mutate", regex: /CustomerService.*mutate/i },
];

const tests: { name: string; fn: () => void }[] = [];

tests.push({
  name: "server/services/adsOs directory exists",
  fn() {
    assert.ok(
      fs.existsSync(ADS_OS_DIR),
      `Expected ${ADS_OS_DIR} to exist — Ads OS module not found.`
    );
  },
});

const sourceFiles = readDir(ADS_OS_DIR);

tests.push({
  name: "Ads OS module has at least one source file",
  fn() {
    assert.ok(sourceFiles.length > 0, `No .ts/.js files found in ${ADS_OS_DIR}`);
  },
});

for (const pattern of MUTATE_PATTERNS) {
  tests.push({
    name: `No Google Ads mutate pattern "${pattern.name}" in adsOs/**`,
    fn() {
      const violations: string[] = [];
      for (const file of sourceFiles) {
        const content = fs.readFileSync(file, "utf-8");
        const lines = content.split("\n");
        lines.forEach((line, i) => {
          // Skip comment lines (// and /* */ comments) and string-only contexts
          const trimmed = line.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
          if (pattern.regex.test(line)) {
            violations.push(`${path.relative(".", file)}:${i + 1}: ${trimmed.slice(0, 120)}`);
          }
        });
      }
      assert.deepEqual(
        violations,
        [],
        `Ads OS mutate guard: found forbidden pattern "${pattern.name}" in:\n` +
          violations.join("\n")
      );
    },
  });
}

// ─── Run ─────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

for (const t of tests) {
  try {
    t.fn();
    passed++;
    console.log(`  ✓ ${t.name}`);
  } catch (err: any) {
    failed++;
    const msg = err?.message ?? String(err);
    failures.push(`  ✗ ${t.name}\n    ${msg.split("\n").join("\n    ")}`);
    console.error(`  ✗ ${t.name}\n    ${msg}`);
  }
}

console.log(`\nads-os-mutate-guard: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
