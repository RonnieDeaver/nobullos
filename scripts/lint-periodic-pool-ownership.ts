/**
 * Pre-merge lint guard: periodic/background execution paths must not
 * consume the request-serving DB pool (Task #3944).
 *
 * server/db.ts exports two ownership-separated pools (RUNBOOKS.md § DB pool
 * tenancy rules): the request pool (`db` / `apiPool`, sized for interactive
 * HTTP traffic) and the worker pool (`workerDb` / `runWithWorkerDb`, for
 * background jobs). Six separate production incidents (audits/
 * C-db-performance-findings.md P1, P3a–P3e) came from periodic services
 * silently holding request-pool connections and starving interactive
 * traffic. The existing pool lints don't close this class:
 * lint-db-pool-tenancy only requires a declared `@db-pool-intent` header on
 * getDb() callers, and lint-getdb-attribution only enforces attribution
 * wrappers — neither examines HOW a module executes (periodic vs request).
 *
 * What this lint does (AST-based; naive text matching cannot distinguish
 * `import { workerDb as db }` — compliant — from `import { db }`):
 *
 *   1. Classifies a server/ module as a PERIODIC/BACKGROUND execution path
 *      when any of these hold:
 *        - it calls `setInterval(...)` (incl. global./globalThis.);
 *        - it value-imports `node-cron` (statically or dynamically);
 *        - it calls `startSupervisedSampler(...)` (the repo's supervised
 *          recurring-sampler registration);
 *        - it is registered by a boot seed file (server/boot/
 *          schedulerInits.ts, server/boot/workersAndCleanup.ts) via a
 *          dynamic `import("...")` — the authoritative background-service
 *          registration lists.
 *   2. Fails a periodic module that CONSUMES the request pool:
 *        - static value-import of `db` or `apiPool` from server/db.ts
 *          (alias-tracked by IMPORTED name: `workerDb as db` passes,
 *          `db as anything` fails; type-only imports are exempt);
 *        - namespace-import (`* as m`) or stored dynamic-import binding
 *          followed by `m.db` / `m.apiPool`;
 *        - dynamic-import destructuring of `db` / `apiPool` (including
 *          `.then(({ db }) => ...)`).
 *   3. Fails ANY scanned module (periodic or not) that re-exports `db` /
 *      `apiPool` (named, aliased, or `export *`) from server/db.ts — a
 *      barrel would let a periodic module consume the request pool through
 *      an untracked specifier. server/db.ts itself is the only legal
 *      export site. (Zero such barrels exist today.)
 *
 * Deliberately NOT flagged (documented boundary):
 *   - `getDb()` — ambient AsyncLocalStorage routing; governed by
 *     lint-db-pool-tenancy (+ lint-getdb-attribution). A periodic path that
 *     runs inside runWithWorkerDb() gets the worker pool from getDb().
 *   - `probePool` — 2-connection breaker-probe pool, its consumers are
 *     probes by design.
 *   - Transitive consumption (periodic module → helper that uses db):
 *     helpers use getDb() ambient routing, which the tenancy lint owns.
 *     This lint draws the line at direct request-pool imports.
 *   - The boot seed files themselves: they are registration lists whose
 *     inline `{ db }` destructures run ONCE at startup (audited one-shot
 *     migrations/cleanups, not recurring loops).
 *
 * Exception mechanism (narrow, per-file, reason REQUIRED — there is no
 * filename allow-list in this lint):
 *     // @periodic-request-pool-exception: <one-line justification>
 *   in the first 80 lines of the file. A marker on a file that does not
 *   actually trip the detector is itself a violation (stale marker), so
 *   the exception set cannot silently rot. The sanctioned set is pinned by
 *   tests/lint-periodic-pool-ownership.test.ts.
 *
 * Exit code: 0 = clean, 1 = violations (each names the file, line, and the
 * approved worker boundary).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import ts from "typescript";

export const EXCEPTION_MARKER = "@periodic-request-pool-exception:";
const MARKER_SCAN_LINES = 80;
const MIN_REASON_LENGTH = 10;
export const REQUEST_POOL_EXPORTS = new Set(["db", "apiPool"]);
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", "build"]);

export interface PoolOwnershipViolation {
  file: string;
  line: number;
  kind:
    | "static-import"
    | "namespace-access"
    | "dynamic-destructure"
    | "barrel-reexport"
    | "stale-exception-marker"
    | "empty-exception-reason";
  message: string;
}

export interface PoolOwnershipLintOptions {
  /** Base directory everything below is relative to (default "."). */
  cwd?: string;
  /** Root scanned for modules (default "server"). */
  root?: string;
  /** The request-pool module (default "server/db.ts"). */
  dbModulePath?: string;
  /** Boot registration lists whose dynamic imports seed the periodic set. */
  bootSeedFiles?: string[];
}

export interface PoolOwnershipLintResult {
  ok: boolean;
  violations: PoolOwnershipViolation[];
  /** Files classified periodic/background (repo-relative). */
  periodicFiles: string[];
  /** Files carrying an honored exception marker. */
  exceptionFiles: string[];
  summaryLine: string;
}

interface FileFacts {
  periodicReasons: string[];
  poolUses: Array<{ line: number; kind: PoolOwnershipViolation["kind"]; detail: string }>;
  barrelReexports: Array<{ line: number; detail: string }>;
}

function isDbModuleSpecifier(spec: string, fromFile: string, dbModuleAbs: string): boolean {
  if (!spec.startsWith(".")) return false;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, base.replace(/\.js$/, ".ts"), join(base, "index.ts")];
  return candidates.some((c) => c === dbModuleAbs);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Extract relative dynamic-import specifiers from a boot seed file. */
function seededSpecifiers(bootFileAbs: string): string[] {
  if (!existsSync(bootFileAbs)) return [];
  const sf = ts.createSourceFile(
    bootFileAbs,
    readFileSync(bootFileAbs, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const spec = (node.arguments[0] as ts.StringLiteralLike).text;
      if (spec.startsWith(".")) specs.push(resolve(dirname(bootFileAbs), spec));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

function analyzeFile(fileAbs: string, dbModuleAbs: string): FileFacts {
  const src = readFileSync(fileAbs, "utf8");
  const sf = ts.createSourceFile(fileAbs, src, ts.ScriptTarget.Latest, true);
  const facts: FileFacts = { periodicReasons: [], poolUses: [], barrelReexports: [] };
  /** Local identifiers whose properties are the db module's exports. */
  const dbNamespaceAliases = new Set<string>();

  const noteInterval = (node: ts.Node): void => {
    if (!facts.periodicReasons.includes("setInterval")) facts.periodicReasons.push("setInterval");
    void node;
  };

  const visit = (node: ts.Node): void => {
    // ---- periodic constructs ----
    if (ts.isCallExpression(node)) {
      const ex = node.expression;
      if (ts.isIdentifier(ex) && ex.text === "setInterval") noteInterval(node);
      if (
        ts.isPropertyAccessExpression(ex) &&
        ex.name.text === "setInterval" &&
        ts.isIdentifier(ex.expression) &&
        (ex.expression.text === "global" || ex.expression.text === "globalThis" || ex.expression.text === "window")
      ) {
        noteInterval(node);
      }
      if (
        (ts.isIdentifier(ex) && ex.text === "startSupervisedSampler") ||
        (ts.isPropertyAccessExpression(ex) && ex.name.text === "startSupervisedSampler")
      ) {
        if (!facts.periodicReasons.includes("startSupervisedSampler")) {
          facts.periodicReasons.push("startSupervisedSampler");
        }
      }
      // dynamic import(...)
      if (
        ex.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const spec = (node.arguments[0] as ts.StringLiteralLike).text;
        if (spec === "node-cron") {
          if (!facts.periodicReasons.includes("node-cron")) facts.periodicReasons.push("node-cron");
        }
        if (isDbModuleSpecifier(spec, fileAbs, dbModuleAbs)) {
          handleDynamicDbImport(node);
        }
      }
    }

    // ---- static imports ----
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (spec === "node-cron" && clause && !clause.isTypeOnly) {
        if (!facts.periodicReasons.includes("node-cron")) facts.periodicReasons.push("node-cron");
      }
      if (isDbModuleSpecifier(spec, fileAbs, dbModuleAbs) && clause && !clause.isTypeOnly) {
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            if (el.isTypeOnly) continue;
            const importedName = (el.propertyName ?? el.name).text;
            if (REQUEST_POOL_EXPORTS.has(importedName)) {
              facts.poolUses.push({
                line: lineOf(sf, el),
                kind: "static-import",
                detail: `imports \`${importedName}\`${el.propertyName ? ` (as \`${el.name.text}\`)` : ""}`,
              });
            }
          }
        }
        if (bindings && ts.isNamespaceImport(bindings)) {
          dbNamespaceAliases.add(bindings.name.text);
        }
      }
    }

    // ---- barrel re-exports of the request pool ----
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      isDbModuleSpecifier(node.moduleSpecifier.text, fileAbs, dbModuleAbs) &&
      !node.isTypeOnly
    ) {
      if (!node.exportClause) {
        facts.barrelReexports.push({
          line: lineOf(sf, node),
          detail: "`export *` re-exports the request pool",
        });
      } else if (ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          if (el.isTypeOnly) continue;
          const exportedFrom = (el.propertyName ?? el.name).text;
          if (REQUEST_POOL_EXPORTS.has(exportedFrom)) {
            facts.barrelReexports.push({
              line: lineOf(sf, el),
              detail: `re-exports \`${exportedFrom}\``,
            });
          }
        }
      }
    }

    // ---- namespace / stored-import property access ----
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      dbNamespaceAliases.has(node.expression.text) &&
      REQUEST_POOL_EXPORTS.has(node.name.text)
    ) {
      facts.poolUses.push({
        line: lineOf(sf, node),
        kind: "namespace-access",
        detail: `accesses \`${node.expression.text}.${node.name.text}\``,
      });
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      dbNamespaceAliases.has(node.expression.text) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      REQUEST_POOL_EXPORTS.has(node.argumentExpression.text)
    ) {
      facts.poolUses.push({
        line: lineOf(sf, node),
        kind: "namespace-access",
        detail: `accesses \`${node.expression.text}["${node.argumentExpression.text}"]\``,
      });
    }

    ts.forEachChild(node, visit);
  };

  /** Record destructures/bindings hanging off a dynamic db-module import. */
  const handleDynamicDbImport = (importCall: ts.CallExpression): void => {
    // const { db } = await import("../db")  /  const m = await import("../db")
    let p: ts.Node = importCall;
    while (p.parent && (ts.isAwaitExpression(p.parent) || ts.isParenthesizedExpression(p.parent))) {
      p = p.parent;
    }
    const parent = p.parent;
    if (parent && ts.isVariableDeclaration(parent)) {
      if (ts.isObjectBindingPattern(parent.name)) {
        for (const el of parent.name.elements) {
          const importedName = ts.isBindingElement(el)
            ? ((el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : undefined) ??
              (ts.isIdentifier(el.name) ? el.name.text : undefined))
            : undefined;
          if (importedName && REQUEST_POOL_EXPORTS.has(importedName)) {
            facts.poolUses.push({
              line: lineOf(sf, el),
              kind: "dynamic-destructure",
              detail: `destructures \`${importedName}\` from a dynamic import of the db module`,
            });
          }
        }
      } else if (ts.isIdentifier(parent.name)) {
        dbNamespaceAliases.add(parent.name.text);
      }
    }
    // import("../db").then(({ db }) => ...)
    if (
      parent &&
      ts.isPropertyAccessExpression(parent) &&
      parent.name.text === "then" &&
      parent.parent &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.arguments.length >= 1
    ) {
      const cb = parent.parent.arguments[0];
      if ((ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters.length >= 1) {
        const param = cb.parameters[0].name;
        if (ts.isObjectBindingPattern(param)) {
          for (const el of param.elements) {
            const importedName =
              (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : undefined) ??
              (ts.isIdentifier(el.name) ? el.name.text : undefined);
            if (importedName && REQUEST_POOL_EXPORTS.has(importedName)) {
              facts.poolUses.push({
                line: lineOf(sf, el),
                kind: "dynamic-destructure",
                detail: `destructures \`${importedName}\` in .then() of a dynamic db-module import`,
              });
            }
          }
        }
      }
    }
  };

  visit(sf);
  return facts;
}

function readExceptionMarker(fileAbs: string): { present: boolean; reason: string } {
  const head = readFileSync(fileAbs, "utf8").split("\n", MARKER_SCAN_LINES).join("\n");
  const idx = head.indexOf(EXCEPTION_MARKER);
  if (idx === -1) return { present: false, reason: "" };
  const rest = head.slice(idx + EXCEPTION_MARKER.length);
  const reason = (rest.split("\n")[0] ?? "").replace(/\*\/\s*$/, "").trim();
  return { present: true, reason };
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const ent of entries) {
    if (EXCLUDED_DIR_NAMES.has(ent) || ent.startsWith(".")) continue;
    const full = join(dir, ent);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
}

export function runLint(opts: PoolOwnershipLintOptions = {}): PoolOwnershipLintResult {
  const cwd = resolve(opts.cwd ?? ".");
  const root = join(cwd, opts.root ?? "server");
  const dbModuleAbs = join(cwd, opts.dbModulePath ?? "server/db.ts");
  const bootSeedFiles = (opts.bootSeedFiles ?? [
    "server/boot/schedulerInits.ts",
    "server/boot/workersAndCleanup.ts",
  ]).map((f) => join(cwd, f));

  const seeded = new Set<string>();
  for (const boot of bootSeedFiles) {
    for (const spec of seededSpecifiers(boot)) {
      for (const cand of [spec, `${spec}.ts`, `${spec}.tsx`, join(spec, "index.ts")]) {
        if (existsSync(cand) && statSync(cand).isFile()) {
          seeded.add(resolve(cand));
          break;
        }
      }
    }
  }

  const files: string[] = [];
  walk(root, files);

  const violations: PoolOwnershipViolation[] = [];
  const periodicFiles: string[] = [];
  const exceptionFiles: string[] = [];
  const rel = (f: string): string => f.startsWith(`${cwd}/`) ? f.slice(cwd.length + 1) : f;

  for (const fileAbs of files) {
    if (resolve(fileAbs) === resolve(dbModuleAbs)) continue;
    if (bootSeedFiles.some((b) => resolve(b) === resolve(fileAbs))) continue;

    const facts = analyzeFile(fileAbs, dbModuleAbs);
    const isSeeded = seeded.has(resolve(fileAbs));
    if (isSeeded) facts.periodicReasons.push("boot-seeded");
    const isPeriodic = facts.periodicReasons.length > 0;
    if (isPeriodic) periodicFiles.push(rel(fileAbs));

    // Barrel re-exports are structural violations regardless of periodicity.
    for (const b of facts.barrelReexports) {
      violations.push({
        file: rel(fileAbs),
        line: b.line,
        kind: "barrel-reexport",
        message:
          `${rel(fileAbs)}:${b.line} ${b.detail} from server/db.ts — the request pool must only be ` +
          `importable from its owning module so periodic consumers stay visible to this lint.`,
      });
    }

    const marker = readExceptionMarker(fileAbs);
    const trips = isPeriodic && facts.poolUses.length > 0;

    if (marker.present && marker.reason.length < MIN_REASON_LENGTH) {
      violations.push({
        file: rel(fileAbs),
        line: 1,
        kind: "empty-exception-reason",
        message:
          `${rel(fileAbs)}: ${EXCEPTION_MARKER} marker present but the justification is missing/too ` +
          `short — state WHY this periodic path may consume the request pool.`,
      });
      continue;
    }
    if (marker.present && !trips) {
      violations.push({
        file: rel(fileAbs),
        line: 1,
        kind: "stale-exception-marker",
        message:
          `${rel(fileAbs)}: stale ${EXCEPTION_MARKER} marker — the file is ` +
          `${isPeriodic ? "periodic but no longer consumes the request pool" : "not classified as a periodic/background execution path"}. ` +
          `Remove the marker so the exception set stays honest.`,
      });
      continue;
    }
    if (marker.present && trips) {
      exceptionFiles.push(rel(fileAbs));
      continue;
    }
    if (trips) {
      const why = facts.periodicReasons.join(" + ");
      for (const use of facts.poolUses) {
        violations.push({
          file: rel(fileAbs),
          line: use.line,
          kind: use.kind,
          message:
            `${rel(fileAbs)}:${use.line} ${use.detail}, but this module is a periodic/background ` +
            `execution path (${why}). Background work must use the worker boundary: import ` +
            `\`workerDb\` (or wrap the job in \`runWithWorkerDb()\` so ambient getDb() routes to the ` +
            `worker pool) — see RUNBOOKS.md § DB pool tenancy rules. If this file is a sanctioned ` +
            `dual-use module, add \`// ${EXCEPTION_MARKER} <justification>\` in the first ` +
            `${MARKER_SCAN_LINES} lines and pin it in tests/lint-periodic-pool-ownership.test.ts.`,
        });
      }
    }
  }

  periodicFiles.sort();
  exceptionFiles.sort();
  const summaryLine =
    `lint-periodic-pool-ownership: ${violations.length === 0 ? "OK" : "FAILED"} ` +
    `(${files.length} files scanned, ${periodicFiles.length} periodic/background, ` +
    `${exceptionFiles.length} documented exceptions, ${violations.length} violations)`;

  return { ok: violations.length === 0, violations, periodicFiles, exceptionFiles, summaryLine };
}

export function cliMain(): number {
  const result = runLint();
  if (!result.ok) {
    console.error("");
    console.error("✗ lint-periodic-pool-ownership: request-pool consumption in periodic/background code");
    console.error("");
    console.error("  Periodic services holding request-pool (`db`/`apiPool`) connections have");
    console.error("  starved interactive traffic six separate times (audits/C-db-performance-");
    console.error("  findings.md P1, P3a–P3e). Background work belongs on the worker boundary:");
    console.error("  `workerDb`, or `runWithWorkerDb()` + ambient `getDb()`.");
    console.error("");
    for (const v of result.violations) console.error(`  - ${v.message}`);
    console.error("");
    console.error(`  ${result.summaryLine}`);
    console.error("");
    return 1;
  }
  console.log(result.summaryLine);
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-periodic-pool-ownership.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
