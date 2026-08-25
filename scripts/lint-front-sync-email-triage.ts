/**
 * Pre-deploy lint guard for the Front sync_email ingestion triage helper
 * (Task #1271).
 *
 * Task #825 wired filter-rule evaluation into Front sync_email ingestion,
 * but every ingestion site in `server/services/frontIntegration.ts`
 * re-implemented the same "filter-rule → operational classifier → match"
 * branching inline. That made it easy for a future ingestion path to
 * forget the filter-rule call and silently regress — a brand-new email
 * could slip past a "block" rule until the next re-evaluation cycle.
 *
 * Task #1271 consolidates the triage into
 * `server/services/frontSyncEmailTriage.ts` (`triageSyncEmailForMatching`).
 *
 * This script enforces the consolidation in two ways:
 *
 *  1. Every function declaration in `server/services/frontIntegration.ts`
 *     whose body iterates `front_sync_emails` rows (i.e. calls one of the
 *     LIST_HELPERS below) must also call `triageSyncEmailForMatching`
 *     somewhere in the same function body. The parser uses the TypeScript
 *     compiler API to walk the AST so typed object parameters
 *     (`function x(opts: { limit: number }) { ... }`) don't fool the
 *     brace matcher.
 *
 *  2. The matchStatus values `"blocked"` and `"dismissed"` — the two
 *     outcomes filter-rule evaluation owns — may only be written from an
 *     allow-listed set of files. New code that writes those statuses
 *     anywhere else must either go through the triage helper or be added
 *     to the allow-list with a justification.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

// Scope intentionally fixed (Task #2846): this lint guards the single Front
// ingestion file (plus the enumerated allow-listed writers below); the triage
// contract lives nowhere else.
const INGESTION_FILE = "server/services/frontIntegration.ts";
const TRIAGE_FILE = "server/services/frontSyncEmailTriage.ts";

// Task #1698: tests/front-sync-email-triage.test.ts simulates an offender
// by writing a TEMP COPY of the ingestion file (pristine + offender block)
// and pointing the lint at that copy via this env var. The real ingestion
// file is never mutated, so a SIGKILL'd test child can't leave the
// production source polluted across runs.
const INGESTION_TARGET = process.env.LINT_FRONT_TRIAGE_TARGET || INGESTION_FILE;

const LIST_HELPER_METHODS = new Set([
  "listFrontSyncEmails",
  "listUnmatchedFrontSyncEmails",
]);
const TRIAGE_FN = "triageSyncEmailForMatching";

// Files that legitimately write matchStatus: "blocked" | "dismissed"
// outside the triage helper.
const STATUS_WRITE_ALLOWLIST: Record<string, string> = {
  [TRIAGE_FILE]: "canonical filter-rule application (this is the helper)",
  "server/routes/integrations/unmatched.ts": "operator-facing /block and /dismiss endpoints",
  "server/services/frontBulkActions.ts": "bulk operator-initiated block / dismiss",
  "server/services/frontIntegration.ts": "dismissUnmatchedEmail helper (manual operator action)",
};

// Functions in INGESTION_FILE that are allowed to list front_sync_emails
// without calling the triage helper directly. Each entry must document
// why the function is safe — generally because it is a pure enumerator
// that returns IDs/rows to a downstream consumer that goes through the
// helper itself.
const FUNCTION_ALLOWLIST: Record<string, string> = {
  enumerateSyncEmailIds:
    "pure ID enumerator for the rematch producer — IDs are consumed by rematchSyncEmailBatch which calls triageSyncEmailForMatching per row",
  enumerateReprocessEmailIds:
    "pure ID enumerator for the reprocess producer — IDs are consumed by reprocessSyncEmailBatch which calls triageSyncEmailForMatching per row",
  reEvaluateExistingUnmatchedProducer:
    "pure producer that enqueues batches of IDs into repair queues — the downstream consumer (reEvaluateExistingUnmatched) calls triageSyncEmailForMatching per row",
  rematchDismissedOperationalBatch:
    "thin head-of-cohort fetch (Task #2641) — delegates every fetched row to processDismissedOperationalChunk, which calls triageSyncEmailForMatching per row",
};

type Offender = { kind: "missing_triage" | "unexpected_status_write"; message: string };

// ---------- Check 1: every ingestion function calls the helper ----------

function getCalledNames(body: ts.Node): { calls: Set<string>; methodCalls: Set<string> } {
  // Returns the names of every callee in the subtree. `calls` covers plain
  // identifier calls (`foo(...)`) and `methodCalls` covers property-access
  // calls (`obj.foo(...)`) — both are needed because list helpers are
  // invoked as `storage.listFrontSyncEmails(...)` while the triage helper
  // is invoked as a bare `triageSyncEmailForMatching(...)`.
  const calls = new Set<string>();
  const methodCalls = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const ex = node.expression;
      if (ts.isIdentifier(ex)) calls.add(ex.text);
      else if (ts.isPropertyAccessExpression(ex) && ts.isIdentifier(ex.name)) methodCalls.add(ex.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return { calls, methodCalls };
}

function functionName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isVariableStatement(node)) {
    for (const d of node.declarationList.declarations) {
      if (
        ts.isIdentifier(d.name) &&
        d.initializer &&
        (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
      ) {
        return d.name.text;
      }
    }
  }
  return null;
}

function functionBody(node: ts.Node): ts.Node | null {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body) return node.body;
  if (ts.isVariableStatement(node)) {
    for (const d of node.declarationList.declarations) {
      if (
        d.initializer &&
        (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
      ) {
        return d.initializer.body;
      }
    }
  }
  return null;
}

// Task #1698: defense-in-depth — if a prior signal-killed test run ever
// strands a fixture function named `__lintTestOffender*` in the real
// ingestion file, ignore it here so the clean-repo assertion can't
// silently regress. The triage test deliberately uses a different name
// (`__triageOffenderFixture*`) for its simulated offender so this guard
// does not mask the test's real-offender detection assertion.
const TEST_FIXTURE_NAME_PREFIX = "__lintTestOffender";

function walkTopLevel(node: ts.Node, offenders: Offender[]): void {
  const name = functionName(node);
  const body = functionBody(node);
  if (name && body) {
    if (name.startsWith(TEST_FIXTURE_NAME_PREFIX)) return;
    const { calls, methodCalls } = getCalledNames(body);
    const listHelperHit = [...LIST_HELPER_METHODS].find((m) => methodCalls.has(m));
    if (listHelperHit && !calls.has(TRIAGE_FN) && !(name in FUNCTION_ALLOWLIST)) {
      offenders.push({
        kind: "missing_triage",
        message:
          `${INGESTION_TARGET} :: ${name}() iterates front_sync_emails via ` +
          `storage.${listHelperHit}(...) but does not call ${TRIAGE_FN}(). ` +
          `Route the row through the helper before matching, or add ${name} to ` +
          `FUNCTION_ALLOWLIST in scripts/lint-front-sync-email-triage.ts with a justification.`,
      });
    }
    // Don't descend into function bodies for the "is it a function?" search —
    // we only police top-level (file-scope) function declarations.
    return;
  }
  ts.forEachChild(node, (child) => walkTopLevel(child, offenders));
}

// ---------- Check 2: matchStatus="blocked"|"dismissed" allowlist ----------

const STATUS_RE = /matchStatus\s*:\s*["'](blocked|dismissed)["']/;

function walkFiles(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent === "node_modules" || ent.startsWith(".")) continue;
    const full = join(dir, ent);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkFiles(full, out);
      continue;
    }
    if (!full.endsWith(".ts") && !full.endsWith(".tsx")) continue;
    out.push(full);
  }
}

export function cliMain(): number {
  const offenders: Offender[] = [];

  // ---------- Check 1: every ingestion function calls the helper ----------

  const ingestionSrc = readFileSync(INGESTION_TARGET, "utf8");
  const sourceFile = ts.createSourceFile(INGESTION_TARGET, ingestionSrc, ts.ScriptTarget.ESNext, /*setParentNodes*/ true);
  walkTopLevel(sourceFile, offenders);

  // ---------- Check 2: matchStatus="blocked"|"dismissed" allowlist ----------

  const files: string[] = [];
  walkFiles("server", files);

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (!STATUS_RE.test(src)) continue;
    const normalized = file.replace(/\\/g, "/");
    if (normalized in STATUS_WRITE_ALLOWLIST) continue;
    offenders.push({
      kind: "unexpected_status_write",
      message:
        `${normalized} writes matchStatus: "blocked"|"dismissed" but is not allow-listed. ` +
        `Route the write through triageSyncEmailForMatching(), or add a justification to ` +
        `STATUS_WRITE_ALLOWLIST in scripts/lint-front-sync-email-triage.ts.`,
    });
  }

  // ---------- Report ----------

  if (offenders.length > 0) {
    console.error("");
    console.error("✗ lint-front-sync-email-triage: ingestion-triage guard violations");
    console.error("");
    console.error("  Front sync_email ingestion must route every row through the canonical");
    console.error("  helper so filter rules apply to brand-new email as it arrives:");
    console.error("");
    console.error("    import { triageSyncEmailForMatching } from \"./frontSyncEmailTriage\";");
    console.error("    const triage = await triageSyncEmailForMatching(email);");
    console.error("    if (triage.outcome === \"filter_rule_handled\") continue;");
    console.error("    if (triage.outcome === \"operational_dismissed\") continue;");
    console.error("    if (triage.outcome === \"skip_match\") continue;  // never_match");
    console.error("    // outcome === \"proceed\" — run your matcher");
    console.error("");
    console.error("  Offenders:");
    for (const o of offenders) console.error(`    [${o.kind}] ${o.message}`);
    console.error("");
    return 1;
  }

  console.log(`lint-front-sync-email-triage: OK (scanned ${INGESTION_FILE} and server/**)`);
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-front-sync-email-triage.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
