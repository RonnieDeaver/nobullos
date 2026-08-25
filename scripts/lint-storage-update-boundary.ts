/**
 * lint-storage-update-boundary.ts (Task #4250)
 *
 * Guards the storage-layer half of the F8 regression class (Tasks #4200/#4222
 * closed it; audits/f8-spread-write-inventory-2026-08-09.md): a storage edit
 * function that accepts a BROAD `Partial<Insert*-or-Select*>`-shaped patch and
 * feeds it into a Drizzle `.set(...)` un-parsed. Such a function is one raw
 * `req.body` forward away from letting a caller rewrite row ids, ownership
 * keys, and server-managed columns. The sibling
 * scripts/lint-persistence-spread-boundary.ts ratchets SPREAD sites inside
 * `.set({...})/.values({...})` object literals; this lint closes what that
 * one cannot see — the SIGNATURE-level hazard, including direct
 * `.set(data)` (no spread at all) and one-hop `const updates = { ...data }`
 * staging objects.
 *
 * What counts as a BROAD parameter type (syntax-only, per-annotation):
 *   - `Partial<X>` where `X` is a bare `Insert*`/`Select*` type reference
 *     (the drizzle-inferred full-row shapes), anywhere in the annotation
 *     (intersections like `Partial<InsertX> & { updatedAt?: Date }` count);
 *   - `Partial<Omit<Insert*-or-Select*, ...>>` — Omit removes a handful of keys
 *     from a full-row shape and stays broad.
 *   Deliberately NOT broad (they pass):
 *   - `Partial<Pick<...>>` — an explicit focused field whitelist;
 *   - named alias types (e.g. `UpdatableCommFields`) — a reviewed, dedicated
 *     narrow-writer contract;
 *   - zod-inferred `Update*` types (z.infer of a focused update schema).
 *
 * A broad parameter VIOLATES only when it reaches a `.set(` RAW inside the
 * same function body:
 *   - `.set(data)` / `.set({ ...data, ... })` directly, or
 *   - through one-or-more const hops: `const updates = { ...data, x };`
 *     then `.set(updates)` (fixpoint taint propagation through direct
 *     `const y = tainted` aliases and object literals spreading a tainted
 *     identifier).
 * The repo's hardened convention passes naturally: `const parsed =
 * updateXSchema.parse(data)` yields an UNtainted binding (a call result is
 * the sanctioning boundary), so `.set({ ...parsed })` is clean.
 *
 * Frozen-snapshot ratchet (.agents/memory/ratchet-frozen-snapshot-pattern.md):
 * every pre-existing broad-param raw flow is grandfathered by ONE frozen
 * snapshot below (FROZEN_BROAD_UPDATE_SITES), keyed
 * `file::functionName::paramName` with an occurrence count. Shrink-only —
 * there is no update/refresh flag and this lint never writes a file;
 * tests/lint-storage-update-boundary.test.ts pins the snapshot by sha-256 so
 * widening it is a loud two-file reviewed diff.
 *
 * Reviewed escape (rare, audited): append
 *   // storage-broad-update-approved: <reason>
 * to the line carrying the `.set(` token, for flows that genuinely cannot
 * carry request-shaped data. The reason is mandatory and greppable.
 *
 * Emergency escape hatch (audited, loud): LINT_STORAGE_UPDATE_SKIP=1.
 *
 * Exit code: 0 clean, 1 violations.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { isScannablePath, listTrackedFiles } from "./lintFileDiscovery";

export const APPROVE_MARKER = "storage-broad-update-approved:";

const BROAD_TYPE_RE = /^(Insert|Select)[A-Z0-9]/;

// ---------------------------------------------------------------------------
// Broad-type detection (syntax-only)
// ---------------------------------------------------------------------------
function refName(t: ts.TypeNode): string | undefined {
  if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) return t.typeName.text;
  return undefined;
}

function isBroadRowRef(t: ts.TypeNode | undefined): boolean {
  if (!t) return false;
  const name = refName(t);
  return name !== undefined && BROAD_TYPE_RE.test(name);
}

/** True when the annotation contains `Partial<Insert*-or-Select*>` or
 * `Partial<Omit<Insert*-or-Select*, ...>>` anywhere (intersections included). */
export function typeAnnotationIsBroad(type: ts.TypeNode | undefined): boolean {
  if (!type) return false;
  let broad = false;
  const visit = (n: ts.Node): void => {
    if (broad) return;
    if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName) && n.typeName.text === "Partial") {
      const arg = n.typeArguments?.[0];
      if (arg) {
        if (isBroadRowRef(arg)) {
          broad = true;
          return;
        }
        if (
          ts.isTypeReferenceNode(arg) &&
          ts.isIdentifier(arg.typeName) &&
          arg.typeName.text === "Omit" &&
          isBroadRowRef(arg.typeArguments?.[0])
        ) {
          broad = true;
          return;
        }
      }
    }
    n.forEachChild(visit);
  };
  visit(type);
  return broad;
}

// ---------------------------------------------------------------------------
// Taint flow within one function body
// ---------------------------------------------------------------------------
function unwrapExpression(e: ts.Expression): ts.Expression {
  let cur: ts.Expression = e;
  for (;;) {
    if (
      ts.isAwaitExpression(cur) ||
      ts.isParenthesizedExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur)
    ) {
      cur = cur.expression;
    } else {
      return cur;
    }
  }
}

/** Object literal that spreads a tainted identifier at its top level. */
function objectSpreadsTainted(obj: ts.ObjectLiteralExpression, tainted: ReadonlySet<string>): boolean {
  return obj.properties.some((p) => {
    if (!ts.isSpreadAssignment(p)) return false;
    const inner = unwrapExpression(p.expression);
    return ts.isIdentifier(inner) && tainted.has(inner.text);
  });
}

function initializerIsTainted(init: ts.Expression, tainted: ReadonlySet<string>): boolean {
  const inner = unwrapExpression(init);
  if (ts.isIdentifier(inner)) return tainted.has(inner.text);
  if (ts.isObjectLiteralExpression(inner)) return objectSpreadsTainted(inner, tainted);
  return false;
}

export type BroadUpdateSite = {
  file: string;
  /** 1-based line of the offending `.set(` call. */
  line: number;
  fnName: string;
  paramName: string;
  key: string; // file::fnName::paramName
};

function functionName(node: ts.SignatureDeclaration): string {
  const named = node as { name?: ts.PropertyName };
  if (named.name) {
    if (ts.isIdentifier(named.name) || ts.isStringLiteral(named.name)) return named.name.text;
  }
  // const foo = (…) => …  /  const foo = async function (…) {…}
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent) && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))) {
    return parent.name.text;
  }
  return "(anonymous)";
}

/**
 * Scan one file's source for broad-param raw `.set(` flows.
 * Nested function-likes are scanned independently for their OWN parameters;
 * a nested closure body still counts for the enclosing function's taint
 * (transaction callbacks), except where an inner binding shadows the name.
 */
export function scanFileForBroadUpdateSites(file: string, src: string): BroadUpdateSite[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites: BroadUpdateSite[] = [];

  const shadowedIn = (node: ts.Node, name: string): boolean => {
    // Inner function-likes that re-bind the name make deeper uses a
    // DIFFERENT variable — skip their subtrees when hunting flows.
    if (ts.isFunctionLike(node)) {
      for (const p of node.parameters) {
        if (ts.isIdentifier(p.name) && p.name.text === name) return true;
      }
    }
    return false;
  };

  const analyzeFunction = (fn: ts.SignatureDeclaration & { body?: ts.Node }): void => {
    if (!fn.body) return;
    const fnName = functionName(fn);
    for (const p of fn.parameters) {
      if (!ts.isIdentifier(p.name)) continue;
      if (!typeAnnotationIsBroad(p.type)) continue;
      const paramName = p.name.text;

      // Fixpoint taint: param + const aliases/staging objects built from it.
      const tainted = new Set<string>([paramName]);
      let grew = true;
      while (grew) {
        grew = false;
        const collect = (n: ts.Node): void => {
          if (n !== fn.body && ts.isFunctionLike(n) && shadowedIn(n, paramName)) return;
          if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
            if (!tainted.has(n.name.text) && initializerIsTainted(n.initializer, tainted)) {
              tainted.add(n.name.text);
              grew = true;
            }
          }
          n.forEachChild(collect);
        };
        collect(fn.body);
      }

      // Raw flows into `.set(`.
      const hunt = (n: ts.Node): void => {
        if (n !== fn.body && ts.isFunctionLike(n) && shadowedIn(n, paramName)) return;
        if (
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          n.expression.name.text === "set" &&
          n.arguments.length >= 1
        ) {
          const arg = unwrapExpression(n.arguments[0]);
          const hit =
            (ts.isIdentifier(arg) && tainted.has(arg.text)) ||
            (ts.isObjectLiteralExpression(arg) && objectSpreadsTainted(arg, tainted));
          if (hit) {
            const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
            sites.push({ file, line, fnName, paramName, key: `${file}::${fnName}::${paramName}` });
          }
        }
        n.forEachChild(hunt);
      };
      hunt(fn.body);
    }
  };

  const walk = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) && (n as { body?: ts.Node }).body) {
      analyzeFunction(n as ts.SignatureDeclaration & { body?: ts.Node });
    }
    n.forEachChild(walk);
  };
  walk(sf);
  return sites;
}

// ---------------------------------------------------------------------------
// Lint driver
// ---------------------------------------------------------------------------
export type LintOptions = {
  /** Fixture mode: scan these relative paths under rootDir instead of git. */
  rootDir?: string;
  files?: string[];
  frozen?: ReadonlyMap<string, number>;
  skipEnv?: string | undefined;
};

export type Violation = { site: BroadUpdateSite; message: string };

export type LintResult = {
  ok: boolean;
  skipped: boolean;
  scannedFiles: number;
  sites: BroadUpdateSite[];
  violations: Violation[];
};

export function discoverStorageFiles(): string[] {
  return listTrackedFiles().filter(
    (f) => f.startsWith("server/storage/") && f.endsWith(".ts") && isScannablePath(f),
  );
}

export function runLint(opts: LintOptions = {}): LintResult {
  const skipEnv = "skipEnv" in opts ? opts.skipEnv : process.env.LINT_STORAGE_UPDATE_SKIP;
  if (skipEnv === "1") {
    console.error(
      "⚠️  lint-storage-update-boundary: SKIPPED via LINT_STORAGE_UPDATE_SKIP=1 — " +
        "this must be a deliberate, documented exception.",
    );
    return { ok: true, skipped: true, scannedFiles: 0, sites: [], violations: [] };
  }
  const frozen = opts.frozen ?? FROZEN_BROAD_UPDATE_SITES;
  const files = opts.files ?? discoverStorageFiles();
  const remaining = new Map(frozen);
  const sites: BroadUpdateSite[] = [];
  const violations: Violation[] = [];

  for (const rel of files) {
    const abs = opts.rootDir ? join(opts.rootDir, rel) : rel;
    let src: string;
    try {
      src = readFileSync(abs, "utf8");
    } catch {
      continue; // deleted since ls-files snapshot
    }
    const fileSites = scanFileForBroadUpdateSites(rel, src);
    if (fileSites.length === 0) continue;
    const rawLines = src.split("\n");
    for (const site of fileSites) {
      sites.push(site);
      const left = remaining.get(site.key) ?? 0;
      if (left > 0) {
        remaining.set(site.key, left - 1); // grandfathered (shrink-only)
        continue;
      }
      const startLine = rawLines[site.line - 1] ?? "";
      if (startLine.includes(APPROVE_MARKER)) {
        const reason = startLine.split(APPROVE_MARKER)[1]?.trim();
        if (reason && reason.length >= 8) continue;
        violations.push({
          site,
          message:
            `${site.file}:${site.line} — "${APPROVE_MARKER}" marker present but the reason is ` +
            `missing/too short. Write WHY this broad patch cannot carry request-shaped data.`,
        });
        continue;
      }
      violations.push({
        site,
        message:
          `${site.file}:${site.line} — ${site.fnName}(${site.paramName}: Partial<Insert*-or-Select*>) ` +
          `feeds the broad patch into .set(...) without a runtime parse.`,
      });
    }
  }

  return { ok: violations.length === 0, skipped: false, scannedFiles: files.length, sites, violations };
}

export function cliMain(): number {
  const res = runLint();
  if (res.skipped) return 0;
  if (!res.ok) {
    console.error("");
    console.error(
      "✗ lint-storage-update-boundary: broad Partial<Insert*-or-Select*> patch reaches .set() un-parsed",
    );
    console.error("");
    console.error(
      "  A server/storage/** function takes a full-row-shaped Partial patch and writes it",
    );
    console.error(
      "  with Drizzle .set() without a runtime-parsed focused update schema. One caller",
    );
    console.error(
      "  forwarding raw request data could rewrite row ids, ownership keys, and",
    );
    console.error(
      "  server-managed columns (the F8 incident class — see",
    );
    console.error("  audits/f8-spread-write-inventory-2026-08-09.md).");
    console.error("");
    console.error("  Fix — one of:");
    console.error(
      "   1. Parse the patch through a focused/derived zod update schema (shared/models",
    );
    console.error(
      "      update*Schema convention: pick the editable fields, strip unknowns, keep",
    );
    console.error(
      "      ownership/audit/sync-state columns out), then .set({ ...parsed }).",
    );
    console.error(
      "   2. Narrow the parameter to a dedicated writer type (Partial<Pick<...>> or a",
    );
    console.error(
      "      named reviewed alias like UpdatableCommFields).",
    );
    console.error(
      "   3. If NO request-shaped data can reach this function (trusted internal domain",
    );
    console.error(
      `      object only), append \`// ${APPROVE_MARKER} <reason>\` to the .set( line —`,
    );
    console.error("      the reason is mandatory and reviewed.");
    console.error("");
    console.error("  Offenders:");
    for (const v of res.violations) {
      console.error(`    ${v.message}`);
    }
    console.error("");
    return 1;
  }
  console.log(
    `lint-storage-update-boundary: OK (${res.scannedFiles} storage files, ` +
      `${res.sites.length} broad-param .set flows, all grandfathered/approved)`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// FROZEN baseline — the exact broad-param raw `.set(` flow population in
// server/storage/** at Task #4250 HEAD. Write-once: never regenerate or
// widen routinely; entries only shrink as functions are converted to
// schema-parsed or dedicated narrow-writer signatures. The guard test pins
// the sha-256 of the sorted `key=count` entries.
// ---------------------------------------------------------------------------
// Task #4380 closed the entire grandfathered population: all 17 functions
// now parse through a focused shared/models update schema or take a
// dedicated narrow writer type. The map stays permanently empty — every
// broad-param raw `.set(` flow in server/storage/** is a hard failure.
export const FROZEN_BROAD_UPDATE_SITES: ReadonlyMap<string, number> = new Map<string, number>([]);

export function frozenSnapshotHash(
  frozen: ReadonlyMap<string, number> = FROZEN_BROAD_UPDATE_SITES,
): string {
  const entries = [...frozen.entries()].map(([k, v]) => `${k}=${v}`).sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-storage-update-boundary.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
