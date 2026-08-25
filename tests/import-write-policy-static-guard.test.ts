/* test-registration
{
  "name": "Import write policy static guard (Task #757)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "scanPaths": ["server/routes", "server/services"],
  "tier": "small"
}
test-registration */
/**
 * Static-analysis guard for the canonical Import Write Policy (Task #757).
 *
 * Task #755 introduced `evaluateImportWrite` (server/services/importWritePolicy.ts)
 * and routed the four known import surfaces (PDF webhook, Front sync, SEMrush
 * sync, matcher) through it. The runtime policy has good unit coverage in
 * `tests/import-write-policy.test.ts`, but nothing prevents a future
 * contributor from adding a *new* import path that calls one of the
 * authoritative-create methods directly without consulting the policy.
 *
 * This test walks `server/services/`, `server/routes/`, and `server/workers/`
 * and fails if any file:
 *   1. Mentions one of the import-related path keywords
 *      (PDF import, Front sync, SEMrush sync, matcher / matching), AND
 *   2. Calls one of the forbidden authoritative-create methods
 *      (`createClient`, `createClientLocation`, `createClientContact`,
 *      `createSemrushLocationCampaign`), AND
 *   3. Does NOT also reference `evaluateImportWrite` (proof that the file
 *      consulted the canonical policy before the write).
 *
 * Operator-action paths (Command Panel routes, Client Settings routes,
 * the per-client CRM contact route) and the explicit
 * `promoteEmailsToClientContact` helper are allow-listed — those are the
 * sanctioned authoritative-create entry points and never go through the
 * import policy.
 */

import * as fs from "fs";
import * as path from "path";

const ROOTS = ["server/services", "server/routes", "server/workers"]; // fs-scan-inputs-ignore -- server/workers no longer exists (walk tolerates missing); the live roots are declared as scanPaths

/**
 * Files that are explicitly allowed to call the forbidden authoritative-
 * create methods directly. These are operator-driven entry points (UI
 * routes the operator clicks) or the single sanctioned promotion helper.
 */
const ALLOW_LIST = new Set<string>([
  // Operator UI: Client Settings page (POST /api/clients, locations CRUD).
  "server/routes/clients.ts",
  // Operator UI: Command Panel routes.
  "server/routes/commandCenter.ts",
  // Operator UI: per-client CRM contact create (POST /api/clients/:id/contacts).
  "server/routes/agents.ts",
  // The single sanctioned manual-match → contact promotion helper.
  "server/services/clientContactPromotion.ts",
]);

const FORBIDDEN_METHODS = [
  "createClient",
  "createClientLocation",
  "createClientContact",
  "createSemrushLocationCampaign",
];

// Word-boundary regex — `createClient` must not also match
// `createClientContact` etc. We test each method individually with a
// trailing `(` so we only count actual call sites, not type imports.
const FORBIDDEN_CALL_RE = new RegExp(
  "\\b(?:" + FORBIDDEN_METHODS.join("|") + ")\\s*\\(",
);

// Keywords that mark a file as "import-related" — i.e. one of the surfaces
// the policy was designed to gate. Case-insensitive.
// Note: no `\b` anchors — JavaScript word boundaries don't fire between
// camelCase letters (e.g. `createSemrushLocationCampaign` has no word break
// before "Semrush"), and an import path that mentions a keyword inside a
// camelCase identifier should still be flagged.
const IMPORT_KEYWORD_RE = /(pdf[_-]?import|pdfParser|frontWebhook|frontIntegration|frontHistorical|frontHardMatch|frontApply|frontPipeline|frontBulk|frontFilter|frontRecovery|semrush|matcher|matching|matchPolicy|matchSettings|webhookIngestion|applyHandlers|applyPipeline|hardMatch|inventorySync|localDominanceSync)/i;

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && /\.(ts|tsx)$/.test(ent.name)) out.push(full);
    }
  }
  return out;
}

interface Violation {
  file: string;
  hits: string[];
  keywordHit: string;
}

function scanFile(file: string): Violation | null {
  const rel = file.replace(/\\/g, "/");
  if (ALLOW_LIST.has(rel)) return null;

  const src = fs.readFileSync(file, "utf8");

  // Strip block + line comments so a doc-comment that mentions e.g.
  // "createClient" or "matcher" can't trip the guard.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  if (!FORBIDDEN_CALL_RE.test(stripped)) return null;

  const kwMatch = stripped.match(IMPORT_KEYWORD_RE);
  if (!kwMatch) return null;

  // Allow if the file already consults the canonical policy.
  if (/\bevaluateImportWrite\b/.test(stripped)) return null;

  const hits: string[] = [];
  for (const m of FORBIDDEN_METHODS) {
    const re = new RegExp("\\b" + m + "\\s*\\(", "g");
    const matches = stripped.match(re);
    if (matches) hits.push(`${m} x${matches.length}`);
  }
  return { file: rel, hits, keywordHit: kwMatch[0] };
}

console.log("\n=== Import-write-policy static guard (Task #757) ===");

const violations: Violation[] = [];
let scanned = 0;
for (const root of ROOTS) {
  for (const f of walk(root)) {
    scanned++;
    const v = scanFile(f);
    if (v) violations.push(v);
  }
}

console.log(`  scanned ${scanned} file(s) under ${ROOTS.join(", ")}`);
console.log(`  allow-listed ${ALLOW_LIST.size} operator-action file(s)`);

if (violations.length > 0) {
  console.error(
    "\nFAIL: the following files appear to be import-related (matched a " +
      "PDF/Front/SEMrush/matcher keyword) AND call one of the forbidden " +
      "authoritative-create methods without first calling " +
      "`evaluateImportWrite`:\n",
  );
  for (const v of violations) {
    console.error(
      `  - ${v.file}\n      keyword: ${v.keywordHit}\n      forbidden calls: ${v.hits.join(", ")}`,
    );
  }
  console.error(
    "\nIf this is a legitimate operator-action surface, add it to the " +
      "ALLOW_LIST in tests/import-write-policy-static-guard.test.ts. " +
      "Otherwise route the write through `evaluateImportWrite` " +
      "(server/services/importWritePolicy.ts) before performing the create.",
  );
  process.exit(1);
}

console.log("  ok  no bypass of the canonical import-write policy detected");
console.log("\nAll import-write-policy static-guard checks passed.");
process.exit(0);
