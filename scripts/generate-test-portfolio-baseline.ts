/**
 * Task #4178 — governance inventory #4: test-portfolio static baseline.
 *
 * Emits audits/governance/test-portfolio-baseline.json: one row per
 * registered suite (derived from tests/testRegistry.ts discovery — the same
 * parser the runner uses), with:
 *   - the full registration metadata (regression/smoke/reasons/tier/timeouts/
 *     loaders/env/scanPaths/notes);
 *   - derived process-boundary cost: "solo" (extraNodeArgs forces its own
 *     `npx tsx` process) vs "batchable" (may share a batch child — mirrors
 *     tests/run-all.ts batchKey());
 *   - a suite-FILE-level DB-sensitivity hint using the same content markers
 *     as tests/suiteFingerprint.ts (suite file only, NOT the full import
 *     closure — closure-level classification stays the runner's job, so this
 *     field is "db-marker-in-file" | "hermetic-harness-import" | "unknown");
 *   - layer, derived only where provable from path/extension, else "unknown";
 *   - per-suite source hash (sha256 of the suite file).
 *
 * Provenance carries generatorVersion + sourceCommit + universeHash. This
 * artifact is a SEPARATE file — it never reads or writes
 * tests/green-baseline.json.
 *
 * Regenerate: npx tsx scripts/generate-test-portfolio-baseline.ts
 * Freshness:  npx tsx scripts/generate-test-portfolio-baseline.ts --check
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTestRegistry } from "../tests/testRegistry";
import {
  buildDocument,
  runGeneratorCli,
  sha256,
  type InventoryDocument,
} from "./governanceInventoryLib";

export const ARTIFACT_PATH = "audits/governance/test-portfolio-baseline.json";
export const GENERATOR_VERSION = 2;
const REGEN = "npx tsx scripts/generate-test-portfolio-baseline.ts";

export const DEFAULT_TIMEOUT_MS = 180_000;

/** Mirrors tests/suiteFingerprint.ts DB_CONTENT_PATTERNS (suite-file level). */
const DB_CONTENT_PATTERNS: readonly RegExp[] = [
  /from\s+["']pg["']/,
  /require\(\s*["']pg["']\s*\)/,
  /import\(\s*["']pg["']\s*\)/,
  /@neondatabase\/serverless/,
  /drizzle-orm\/node-postgres/,
  /process\.env\.DATABASE_URL/,
  /server\/index\.ts/,
];

interface SuiteEntry {
  file: string;
  name: string;
  regression: boolean;
  smoke: boolean;
  smokeReason: string | null;
  sweepOnlyReason: string | null;
  tier: "small" | "medium" | "large" | null;
  tierReason: string | null;
  timeoutMs: number;
  timeoutIsOverride: boolean;
  extraNodeArgs: string[];
  extraEnvKeys: string[];
  scanPaths: string[];
  notes: string | null;
  layer: string;
  processBoundary: "solo" | "batchable";
  dbSensitivityHint: "db-marker-in-file" | "hermetic-harness-import" | "unknown";
  sourceHash: string;
}

export function generateFacts(repoRoot: string = process.cwd()): {
  suites: SuiteEntry[];
  totals: Record<string, number>;
} {
  const registry = buildTestRegistry({ repoRoot });
  if (registry.problems.length > 0) {
    throw new Error(
      `test registry has ${registry.problems.length} structural problem(s) — fix registrations first:\n` +
        registry.problems.map((p) => `  - ${p.file}: ${p.message}`).join("\n"),
    );
  }
  const suites: SuiteEntry[] = [];
  for (const [file, reg] of [...registry.registrations.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const src = readFileSync(join(repoRoot, file), "utf8");
    const layer = file.startsWith("client/src/")
      ? "client-component"
      : file.endsWith(".tsx")
        ? "client-component"
        : file.startsWith("tests/lint-")
          ? "lint-guard"
          : "unknown";
    const dbHint = src.includes("tests/hermetic/")
      ? "hermetic-harness-import"
      : DB_CONTENT_PATTERNS.some((re) => re.test(src))
        ? "db-marker-in-file"
        : "unknown";
    suites.push({
      file,
      name: reg.name,
      regression: reg.regression === true,
      smoke: reg.smoke === true,
      smokeReason: reg.smokeReason ?? null,
      sweepOnlyReason: reg.sweepOnlyReason ?? null,
      tier: reg.tier ?? null,
      tierReason: reg.tierReason ?? null,
      timeoutMs: reg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      timeoutIsOverride: reg.timeoutMs !== undefined,
      extraNodeArgs: reg.extraNodeArgs ?? [],
      extraEnvKeys: Object.keys(reg.extraEnv ?? {}).sort(),
      scanPaths: reg.scanPaths ?? [],
      notes: reg.notes ?? null,
      layer,
      processBoundary: reg.extraNodeArgs ? "solo" : "batchable",
      dbSensitivityHint: dbHint,
      sourceHash: sha256(src),
    });
  }
  return {
    suites,
    totals: {
      suites: suites.length,
      smoke: suites.filter((s) => s.smoke).length,
      regression: suites.filter((s) => s.regression).length,
      neitherSmokeNorRegression: suites.filter((s) => !s.smoke && !s.regression).length,
      timeoutOverrides: suites.filter((s) => s.timeoutIsOverride).length,
      soloProcess: suites.filter((s) => s.processBoundary === "solo").length,
    },
  };
}

export function generate(repoRoot: string = process.cwd()): InventoryDocument {
  return buildDocument({
    generator: "scripts/generate-test-portfolio-baseline.ts",
    generatorVersion: GENERATOR_VERSION,
    regenerateCommand: REGEN,
    facts: generateFacts(repoRoot),
    repoRoot,
  });
}

export function cliMain(argv: string[] = process.argv.slice(2)): number {
  return runGeneratorCli({
    argv,
    artifactPath: ARTIFACT_PATH,
    generate: () => generate(),
    label: "test-portfolio-baseline",
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(cliMain());
}
