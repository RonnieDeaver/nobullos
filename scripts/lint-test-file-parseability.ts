/**
 * lint-test-file-parseability.ts
 *
 * Task #3826 — catch broken test files the moment they land.
 *
 * Background: four smoke suites were once committed UNPARSEABLE (three lost
 * their section-opening lines in a bad merge — `Unexpected "}"` — and one had
 * two const-reassignments, an esbuild bundle-mode hard error that tsx only
 * warns about and throws at runtime). They failed every run for days as vague
 * "pre-existing failures", and the non-tolerant related-selection trace
 * failed on them, silently degrading EVERY gate run to the full smoke set.
 *
 * This lint parses every registered test file (plus its registered
 * extraNodeArgs setup/hook entry files) with esbuild bundle-mode semantics via
 * the shared tolerant tracer (tests/relatedSmokeSelection.ts
 * `traceImportClosures` with `tolerateUnresolvable`, the same engine whose
 * skip audit records such files as `<build error: …>` poisoned entries) and
 * fails with file + error detail (exact file:line for located errors) on any
 * parse/build error. Parse-only: nothing executes, no DB, a few seconds.
 *
 * Note: unresolvable IMPORTS are deliberately NOT violations here — several
 * suites import modules their runtime loader shims replace; only genuine
 * `<build error: …>` poisonings (syntax / bundle-mode semantic errors in the
 * file itself) fail this lint.
 *
 * Exit 1 on any build error (or a broken registry / failed trace); 0 clean.
 */

import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { buildTestRegistry } from "../tests/testRegistry";
import { extraNodeArgsEntryFiles, traceImportClosures } from "../tests/relatedSmokeSelection";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

export interface ParseabilityViolation {
  /** Repo-relative file that failed to parse/build. */
  file: string;
  /** esbuild error messages (already carrying file:line where located). */
  errors: string[];
}

export interface ParseabilityResult {
  ok: boolean;
  /** Number of entry files traced (test files + setup/hook files). */
  entryCount: number;
  violations: ParseabilityViolation[];
  /** Fatal machinery problems (broken registry, trace failure). */
  fatal: string[];
}

const BUILD_ERROR_RE = /^<build error(?::\s*(.*))?>$/s;

/**
 * Pure core: trace every registered test entry with the tolerant tracer and
 * collect `<build error: …>` poisonings as violations. Injectable repoRoot
 * so the guard test can drive it against a throwaway fixture tree.
 */
export async function runParseabilityLint(repoRoot: string = ROOT): Promise<ParseabilityResult> {
  const fatal: string[] = [];

  const registry = buildTestRegistry({ repoRoot });
  if (registry.problems.length > 0) {
    // A file so broken its registration block cannot be parsed is exactly
    // the failure class this lint exists to surface — report, don't skip.
    for (const p of registry.problems) fatal.push(`${p.file}: registry problem — ${p.message}`);
  }

  const entries = new Set<string>();
  for (const t of registry.tests) {
    entries.add(t.file);
    for (const extra of extraNodeArgsEntryFiles(t.extraNodeArgs)) entries.add(extra);
  }

  const trace = await traceImportClosures([...entries], repoRoot, { tolerateUnresolvable: true });
  if (!trace.ok) {
    fatal.push(`import trace failed: ${trace.error ?? "unknown error"}`);
    return { ok: false, entryCount: entries.size, violations: [], fatal };
  }

  const violations: ParseabilityViolation[] = [];
  for (const [importer, specs] of trace.unresolved ?? new Map<string, string[]>()) {
    const buildErrors: string[] = [];
    for (const spec of specs) {
      const m = BUILD_ERROR_RE.exec(spec);
      if (m) buildErrors.push(m[1] ?? "unknown build error");
    }
    if (buildErrors.length > 0) violations.push({ file: importer, errors: buildErrors });
  }
  violations.sort((a, b) => a.file.localeCompare(b.file));

  return { ok: violations.length === 0 && fatal.length === 0, entryCount: entries.size, violations, fatal };
}

export function formatResult(result: ParseabilityResult): string {
  const lines: string[] = [];
  if (result.ok) {
    lines.push(
      `lint-test-file-parseability: OK — ${result.entryCount} registered test entry file(s) parse cleanly under esbuild bundle-mode semantics.`,
    );
    return lines.join("\n");
  }
  lines.push("lint-test-file-parseability: FAIL");
  for (const f of result.fatal) lines.push(`  ✗ ${f}`);
  for (const v of result.violations) {
    lines.push(`  ✗ ${v.file} does not parse/build:`);
    for (const e of v.errors) lines.push(`      ${e}`);
  }
  lines.push("");
  lines.push(
    "  A committed test file that esbuild cannot parse fails EVERY subsequent run as a vague " +
      "\"pre-existing failure\" and poisons incremental skip fingerprinting. Fix the syntax/" +
      "bundle-mode error above (tsx may only warn at import time — esbuild bundle semantics are " +
      "the authority here, matching the tracer the gate itself uses).",
  );
  return lines.join("\n");
}

/** Gate worker contract (Task #3789): side-effect-free import + cliMain().
 * Async is fine — scripts/gate-lint-worker.mjs awaits the returned value
 * (same pattern as lint-server-import-cycles / lint-async-correctness). */
export async function cliMain(): Promise<number> {
  const result = await runParseabilityLint(ROOT);
  const text = formatResult(result);
  if (result.ok) console.log(text);
  else console.error(text);
  return result.ok ? 0 : 1;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  process.exit(await cliMain());
}
