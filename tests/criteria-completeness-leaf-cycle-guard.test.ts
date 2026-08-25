/* test-registration
{
  "name": "criteriaCompletenessHelpers leaf import-cycle guard",
  "regression": true,
  "smoke": true,
  "smokeReason": "Pins the pure-leaf contract for criteriaCompletenessHelpers.ts, which was extracted to break the static import cycle between seededCriteriaIncompletenessAlerts.ts and platformOpsActions.ts. The leaf must have zero runtime imports so neither consumer can re-introduce the cycle by importing through it. Pure source scan, no DB.",
  "scanPaths": [
    "server/services/adsOs/criteriaCompletenessHelpers.ts",
    "server/services/adsOs/seededCriteriaIncompletenessAlerts.ts",
    "server/services/prodActions/platformOpsActions.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Static guard for the criteriaCompletenessHelpers.ts leaf module.
 *
 * The cycle between seededCriteriaIncompletenessAlerts.ts and
 * platformOpsActions.ts was broken by extracting the shared pure helpers
 * (isSeededMinimal, isOverdue, STALE_THRESHOLD_MS) into the dependency-free
 * leaf criteriaCompletenessHelpers.ts. This guard pins the shape that keeps
 * the cycle from coming back:
 *
 *   1. The leaf has NO runtime imports at all — not from platformOpsActions,
 *      not from seededCriteriaIncompletenessAlerts, not from any other module.
 *      A single import edge from the leaf back into either consumer would
 *      re-close the cycle.
 *
 *   2. The leaf exports isSeededMinimal and isOverdue (so the guard is not
 *      vacuous — it is actually scanning the real module).
 *
 *   3. platformOpsActions.ts does NOT import seededCriteriaIncompletenessAlerts
 *      (static or dynamic) — the one-way fan-in via the shared leaf is the
 *      only permitted dependency structure.
 *
 *   4. seededCriteriaIncompletenessAlerts.ts does NOT import platformOpsActions
 *      statically — SCHEDULE_SYNC_TARGETS is the only symbol it needs from
 *      that direction, and it arrives via the static import that already exists;
 *      no new direct edges may be added in the reverse direction.
 *
 * Comments are stripped before scanning so prose mentions of module names in
 * JSDoc cannot produce false positives.
 */

import * as fs from "fs";

const LEAF = "server/services/adsOs/criteriaCompletenessHelpers.ts";
const ALERTS = "server/services/adsOs/seededCriteriaIncompletenessAlerts.ts";
const PLATFORM_OPS = "server/services/prodActions/platformOpsActions.ts";

let failed = 0;
function check(cond: boolean, okMsg: string, failMsg: string): void {
  if (cond) {
    console.log(`  ok  ${okMsg}`);
  } else {
    console.error(`  FAIL ${failMsg}`);
    failed++;
  }
}

/**
 * Strip block and line comments so prose mentions of module names in doc
 * comments cannot produce false positives. String literals (import specifiers)
 * are left intact.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Collect every import specifier in the comment-stripped source:
 *   - static:  import ... from "spec" / export ... from "spec"
 *   - bare:    import "spec"
 *   - dynamic: import("spec")
 *   - CJS:     require("spec")
 * Type-only imports are collected separately — they are erased at compile time
 * and cannot form a runtime cycle.
 */
function collectImportSpecifiers(stripped: string): {
  runtime: string[];
  typeOnly: string[];
} {
  const runtime: string[] = [];
  const typeOnly: string[] = [];

  const fromRe = /\b(import|export)\s+(type\s+)?[^"'()]*?\bfrom\s*["']([^"']+)["']/g;
  for (const m of stripped.matchAll(fromRe)) {
    (m[2] ? typeOnly : runtime).push(m[3]);
  }
  const bareImportRe = /\bimport\s*["']([^"']+)["']/g;
  for (const m of stripped.matchAll(bareImportRe)) runtime.push(m[1]);

  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of stripped.matchAll(dynamicRe)) runtime.push(m[1]);

  const requireRe = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of stripped.matchAll(requireRe)) runtime.push(m[1]);

  return { runtime, typeOnly };
}

console.log("\n=== criteriaCompletenessHelpers leaf import-cycle guard ===");

for (const f of [LEAF, ALERTS, PLATFORM_OPS]) {
  if (!fs.existsSync(f)) {
    console.error(`  FAIL expected source file missing: ${f}`);
    failed++;
  }
}

if (failed === 0) {
  const leafSrc = stripComments(fs.readFileSync(LEAF, "utf8"));
  const alertsSrc = stripComments(fs.readFileSync(ALERTS, "utf8"));
  const platformOpsSrc = stripComments(fs.readFileSync(PLATFORM_OPS, "utf8"));

  // ── 1. The leaf has NO runtime imports at all ────────────────────────────
  //
  // criteriaCompletenessHelpers.ts must remain a pure dependency-free module.
  // Any runtime import edge from the leaf back into either consumer (or into
  // db/storage/routes/schedulers) re-closes the cycle the extraction broke.
  {
    const { runtime } = collectImportSpecifiers(leafSrc);
    check(
      runtime.length === 0,
      "criteriaCompletenessHelpers.ts has zero runtime imports (pure leaf)",
      `criteriaCompletenessHelpers.ts grew runtime import(s): ${runtime.join(", ")}. ` +
        "The leaf must stay fully dependency-free — no db, storage, route, scheduler, " +
        "or service imports. If shared helpers are needed, extract another pure leaf.",
    );
  }

  // ── 2. The leaf does NOT import platformOpsActions ───────────────────────
  {
    const { runtime, typeOnly } = collectImportSpecifiers(leafSrc);
    const offending = [...runtime, ...typeOnly].filter((s) =>
      s.includes("platformOpsActions"),
    );
    check(
      offending.length === 0,
      "criteriaCompletenessHelpers.ts does not import platformOpsActions (no cycle)",
      `criteriaCompletenessHelpers.ts imports platformOpsActions (${offending.join(", ")}) — ` +
        "this re-closes the import cycle the leaf extraction was designed to break.",
    );
  }

  // ── 3. The leaf does NOT import seededCriteriaIncompletenessAlerts ───────
  {
    const { runtime, typeOnly } = collectImportSpecifiers(leafSrc);
    const offending = [...runtime, ...typeOnly].filter((s) =>
      s.includes("seededCriteriaIncompletenessAlerts"),
    );
    check(
      offending.length === 0,
      "criteriaCompletenessHelpers.ts does not import seededCriteriaIncompletenessAlerts (no cycle)",
      `criteriaCompletenessHelpers.ts imports seededCriteriaIncompletenessAlerts (${offending.join(", ")}) — ` +
        "this re-closes the import cycle the leaf extraction was designed to break.",
    );
  }

  // ── 4. The leaf exports isSeededMinimal and isOverdue (not vacuous) ──────
  //
  // Confirms the guard is scanning the real live module, not passing vacuously
  // on an empty or renamed file.
  {
    check(
      /\bexport\s+function\s+isSeededMinimal\s*\(/.test(leafSrc),
      "criteriaCompletenessHelpers.ts exports isSeededMinimal",
      "criteriaCompletenessHelpers.ts no longer exports isSeededMinimal — " +
        "if the function moved, update this guard and every importer in lockstep.",
    );
    check(
      /\bexport\s+function\s+isOverdue\s*\(/.test(leafSrc),
      "criteriaCompletenessHelpers.ts exports isOverdue",
      "criteriaCompletenessHelpers.ts no longer exports isOverdue — " +
        "if the function moved, update this guard and every importer in lockstep.",
    );
  }

  // ── 5. platformOpsActions does NOT import seededCriteriaIncompletenessAlerts
  //
  // The allowed structure is: both files import FROM the leaf. platformOpsActions
  // must never add a direct edge to seededCriteriaIncompletenessAlerts (that
  // would re-open the cycle through the back door).
  {
    const { runtime, typeOnly } = collectImportSpecifiers(platformOpsSrc);
    const offending = [...runtime, ...typeOnly].filter((s) =>
      s.includes("seededCriteriaIncompletenessAlerts"),
    );
    check(
      offending.length === 0,
      "platformOpsActions.ts does not import seededCriteriaIncompletenessAlerts",
      `platformOpsActions.ts imports seededCriteriaIncompletenessAlerts (${offending.join(", ")}) — ` +
        "this creates a new cycle edge. Both modules should import only from the " +
        "shared leaf criteriaCompletenessHelpers.ts.",
    );
  }

  // ── 6. seededCriteriaIncompletenessAlerts does NOT statically import platformOpsActions
  //      for anything other than SCHEDULE_SYNC_TARGETS ────────────────────────
  //
  // The existing static import of SCHEDULE_SYNC_TARGETS from platformOpsActions
  // is a one-way edge that is acceptable (alerts → ops). What must never happen
  // is a new reverse edge (ops → alerts). We guard that platformOpsActions has
  // no import of seededCriteriaIncompletenessAlerts (checked above in check 5)
  // and that seededCriteriaIncompletenessAlerts still imports criteriaCompletenessHelpers
  // (so helpers are shared via the leaf, not re-inlined).
  {
    const { runtime } = collectImportSpecifiers(alertsSrc);
    check(
      runtime.some((s) => s.includes("criteriaCompletenessHelpers")),
      "seededCriteriaIncompletenessAlerts.ts imports helpers from the shared leaf",
      "seededCriteriaIncompletenessAlerts.ts no longer imports criteriaCompletenessHelpers — " +
        "if the helpers were inlined or moved, update this guard; if they are still " +
        "needed they must come from the leaf, not a local copy.",
    );
  }
}

if (failed > 0) {
  console.error(`\n${failed} cycle-guard check(s) failed`);
  process.exit(1);
}
console.log("\nAll criteriaCompletenessHelpers cycle-guard checks passed.");
process.exit(0);
