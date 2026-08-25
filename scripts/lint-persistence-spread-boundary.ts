/**
 * lint-persistence-spread-boundary.ts (Task #4201)
 *
 * Guards the F8 regression class (Task #4153): a server route/webhook/worker
 * spreading an object derived from raw request data (`...req.body`-shaped)
 * into a Drizzle `.set({ ... })` / `.values({ ... })` write without passing
 * it through a Zod parse first. F8 fixed the four live boundaries; this lint
 * keeps the pattern from reappearing in NEW code.
 *
 * How it works (frozen-snapshot ratchet — see
 * .agents/memory/ratchet-frozen-snapshot-pattern.md):
 *   - Scans tracked `server/**` TypeScript (tests live outside server/ and
 *     are out of scope) with strings/comments/regexes masked, and finds every
 *     spread (`...expr`) inside the object-literal argument of a
 *     `.set({...})` / `.values({...})` call — the same balanced-brace method
 *     the F8 inventory (audits/f8-spread-write-inventory-2026-08-09.md,
 *     75 classified sites) was built with.
 *   - Every historical site is grandfathered by ONE frozen snapshot
 *     (FROZEN_SPREAD_SITES below), keyed `file::kind::spreadExpr` with an
 *     occurrence count. The snapshot passes only while unchanged or
 *     shrinking; there is no update/refresh flag and this lint never writes
 *     any file. tests/lint-persistence-spread-boundary.test.ts pins the
 *     snapshot by sha-256, so widening it is a loud two-file reviewed diff.
 *   - A NEW site (key absent from the snapshot, or occurrences beyond the
 *     frozen count) passes only when one of these holds:
 *       1. The spread expression is itself a Zod parse result — it contains
 *          `.parse(` / `.safeParse(` inline, or is `<ident>.data` while the
 *          same file performs a `.parse(`/`.safeParse(` (the `parsed.data`
 *          convention used by every category-1 site in the F8 inventory),
 *          or is a bare identifier whose LEXICAL BINDING at the use site is
 *          a direct `const` declared from an actual `.parse(` call earlier
 *          in an enclosing scope (the F8 cat-6 storage-method convention),
 *          resolved per use site with a syntax-only TypeScript AST walk —
 *          parameters, catch/loop variables, imports, `let`/`var`,
 *          destructured bindings, shadowing declarations in other scopes,
 *          and declarations AFTER the write all reject. `.safeParse(`-
 *          assigned identifiers stay rejected: spreading a
 *          SafeParseReturnType envelope into a row write is itself a bug
 *          worth flagging.
 *       2. The line carrying the `.set(`/`.values(` (the expression's START
 *          line) has an explicit reviewed marker:
 *            // spread-write-approved: <reason>
 *          for sites that are genuinely internal/whitelisted (F8 categories
 *          2/5) — the reason is mandatory and greppable.
 *   - Anything else fails with the exact file:line, the spread expression,
 *     and the required fix (parse through a focused/derived zod schema that
 *     strips unknowns and keeps ownership/audit/sync-state columns out —
 *     the repo convention documented in
 *     .agents/memory/persistence-write-boundaries.md).
 *
 * Emergency escape hatch (audited, loud):
 *   LINT_PERSISTENCE_SPREAD_SKIP=1 skips the check entirely.
 *
 * Exit code: 0 clean, 1 violations.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { isScannablePath, listTrackedFiles } from "./lintFileDiscovery";

export const APPROVE_MARKER = "spread-write-approved:";

// ---------------------------------------------------------------------------
// Source masking: blank out string/template contents, comments, and regex
// literals so brace matching and pattern scans only see real code structure.
// Newlines are preserved so line numbers survive masking.
// ---------------------------------------------------------------------------
export function maskSource(src: string): string {
  const n = src.length;
  const out = src.split("");
  let i = 0;
  let prev = ""; // last significant char, for regex-vs-division heuristic
  const keepNl = (idx: number) => (src[idx] === "\n" ? "\n" : " ");
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      // Preserve line comments' text? No — mask, but KEEP approval markers
      // detectable: markers are re-read from the RAW source per line.
      while (i < n && src[i] !== "\n") (out[i] = " "), i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) (out[i] = keepNl(i)), i++;
      if (i < n) (out[i] = " "), (out[i + 1] = " "), (i += 2);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++; // keep the opening quote in place
      while (i < n) {
        if (src[i] === "\\") {
          out[i] = " ";
          if (i + 1 < n) out[i + 1] = " ";
          i += 2;
          continue;
        }
        if (quote === "`" && src[i] === "$" && src[i + 1] === "{") {
          // Template interpolation: mask it too (conservative — spread
          // detection never needs template internals).
          let depth = 0;
          while (i < n) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}" && --depth === 0) {
              out[i] = " ";
              i++;
              break;
            }
            out[i] = keepNl(i);
            i++;
          }
          continue;
        }
        if (src[i] === quote) break;
        out[i] = keepNl(i);
        i++;
      }
      if (i < n) i++; // closing quote stays
      prev = quote;
      continue;
    }
    if (c === "/") {
      // Regex literal heuristic: a `/` after an operand is division; after
      // an operator/keyword boundary it starts a regex.
      const isRegex = !prev || "=(,:;!&|?{}[+-*%<>~^\n".includes(prev);
      if (isRegex) {
        out[i] = " ";
        i++;
        let inClass = false;
        while (i < n) {
          const ch = src[i];
          if (ch === "\\") {
            out[i] = " ";
            if (i + 1 < n) out[i + 1] = " ";
            i += 2;
            continue;
          }
          if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) {
            out[i] = " ";
            i++;
            break;
          }
          out[i] = keepNl(i);
          i++;
        }
        while (i < n && /[a-z]/i.test(src[i] ?? "")) (out[i] = " "), i++;
        prev = ")";
        continue;
      }
      prev = "/";
      i++;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

function matchBrace(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

export type SpreadSite = {
  file: string;
  line: number; // 1-based line of the .set(/.values( token
  kind: "set" | "values";
  spreadExpr: string; // normalized text of the spread expression
  spreadOffset: number; // char offset of the spread expression start (masking preserves positions)
  key: string; // file::kind::spreadExpr
};

const CALL_RE = /\.(set|values)\s*\(/g;

/**
 * Extract the spread expression text starting right after a `...` at index
 * `start` in masked source: consume until a top-level `,` or the closing
 * brace of the containing object literal. Whitespace collapsed.
 */
function readSpreadExpr(masked: string, start: number, end: number): string {
  let depth = 0;
  let i = start;
  for (; i < end; i++) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth--;
    } else if (ch === "," && depth === 0) break;
  }
  return masked
    .slice(start, i)
    .replace(/\s+/g, " ")
    .trim();
}

/** All spread-into-persistence sites in one file's source. */
export function scanFileForSpreadSites(file: string, src: string): SpreadSite[] {
  if (!src.includes(".set(") && !src.includes(".values(") && !/\.(set|values)\s*\(/.test(src)) {
    return [];
  }
  const masked = maskSource(src);
  const sites: SpreadSite[] = [];
  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(masked))) {
    const kind = m[1] as "set" | "values";
    // First non-space char after the open paren must start an object literal
    // (possibly after a newline).
    let j = m.index + m[0].length;
    while (j < masked.length && /\s/.test(masked[j])) j++;
    if (masked[j] !== "{") continue;
    const close = matchBrace(masked, j);
    if (close === -1) continue;
    // Find every `...` anywhere inside the argument object (F8 method:
    // any position, any nesting inside the braces).
    for (let k = j + 1; k < close; k++) {
      if (masked[k] === "." && masked[k + 1] === "." && masked[k + 2] === ".") {
        const expr = readSpreadExpr(masked, k + 3, close);
        const line = masked.slice(0, m.index).split("\n").length;
        let exprStart = k + 3;
        while (exprStart < close && /\s/.test(masked[exprStart])) exprStart++;
        sites.push({
          file,
          line,
          kind,
          spreadExpr: expr,
          spreadOffset: exprStart,
          key: `${file}::${kind}::${expr}`,
        });
        k += 2 + expr.length;
      }
    }
  }
  return sites;
}

/** True when the spread expression is evidently a Zod parse product. */
export function isZodParsedSpread(spreadExpr: string, maskedFileSrc: string): boolean {
  if (/\.(parse|safeParse)\s*\(/.test(spreadExpr)) return true;
  // The `parsed.data` convention: `<ident>.data` (optionally with a `!` or
  // `?.data`) while the same file performs a zod parse.
  if (/^[A-Za-z_$][\w$]*[!?]?\.?\??\.data\b/.test(spreadExpr.replace(/\s/g, ""))) {
    return /\.(parse|safeParse)\s*\(/.test(maskedFileSrc);
  }
  // Bare identifiers are NOT decided here: they need lexical binding
  // resolution at the specific use site (scope + ordering + binding kind) —
  // see isParseAssignedIdentifierSpread. A file-wide textual rule was
  // rejected in review as unsound (same-file shadowing bypass).
  return false;
}

// ---------------------------------------------------------------------------
// Bare-identifier acceptance: `const patch = updateSchema.parse(data)` →
// `.set({ ...patch })` — the F8 cat-6 storage-method convention. Resolved
// per USE SITE with a syntax-only TypeScript AST (no type checker — the
// two-tier pattern: only non-frozen, non-textually-accepted bare-identifier
// sites ever reach a parse, so repo-wide cost stays negligible). Walk
// outward from the spread identifier; the FIRST enclosing scope that binds
// the name decides (innermost binding = shadowing-safe). Accept ONLY a
// direct (non-destructured) `const` whose initializer — unwrapped of
// await/parens/as/satisfies/! — is a `<expr>.parse(...)` call and whose
// declaration starts BEFORE the spread. Everything else rejects:
// parameters (caller-controlled), catch/loop variables, imports,
// function/class/enum/module names, `let`/`var` (reassignable),
// destructured patterns, `.safeParse(` (envelope, not row data),
// declarations after the write, and unresolvable identifiers.
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

function isDotParseCall(init: ts.Expression): boolean {
  const inner = unwrapExpression(init);
  return (
    ts.isCallExpression(inner) &&
    ts.isPropertyAccessExpression(inner.expression) &&
    inner.expression.name.text === "parse"
  );
}

/** Does this binding name (identifier or destructuring pattern) bind `ident`? */
function bindingBinds(name: ts.BindingName, ident: string): "direct" | "destructured" | null {
  if (ts.isIdentifier(name)) return name.text === ident ? "direct" : null;
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue;
    if (bindingBinds(el.name, ident)) return "destructured";
  }
  return null;
}

type ScopeVerdict = { bound: boolean; accepted: boolean };

/** Bindings introduced directly by `scope` for `ident`; accepted only for a
 * direct const-from-`.parse(` declaration that precedes `useOffset`. */
function scopeBinding(scope: ts.Node, ident: string, sf: ts.SourceFile, useOffset: number): ScopeVerdict {
  const reject: ScopeVerdict = { bound: true, accepted: false };
  if (ts.isFunctionLike(scope)) {
    for (const p of scope.parameters) {
      if (bindingBinds(p.name, ident)) return reject; // caller-controlled
    }
    const fnName = (scope as { name?: ts.PropertyName }).name;
    if (fnName && ts.isIdentifier(fnName) && fnName.text === ident) return reject;
  }
  if (ts.isCatchClause(scope) && scope.variableDeclaration && bindingBinds(scope.variableDeclaration.name, ident)) {
    return reject;
  }
  if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    const init = scope.initializer;
    if (init && ts.isVariableDeclarationList(init)) {
      for (const d of init.declarations) {
        if (bindingBinds(d.name, ident)) return reject; // loop variables
      }
    }
  }
  const statements: readonly ts.Statement[] | undefined =
    ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isSourceFile(scope)
      ? scope.statements
      : ts.isCaseBlock(scope)
        ? scope.clauses.flatMap((c) => [...c.statements])
        : undefined;
  if (!statements) return { bound: false, accepted: false };
  for (const st of statements) {
    if (ts.isVariableStatement(st)) {
      for (const decl of st.declarationList.declarations) {
        const how = bindingBinds(decl.name, ident);
        if (!how) continue;
        if (how === "destructured") return reject;
        if ((st.declarationList.flags & ts.NodeFlags.Const) === 0) return reject; // let/var
        if (!decl.initializer || !isDotParseCall(decl.initializer)) return reject;
        if (decl.getStart(sf) >= useOffset) return reject; // must precede the write
        return { bound: true, accepted: true };
      }
    } else if (
      (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) &&
      st.name &&
      ts.isIdentifier(st.name) &&
      st.name.text === ident
    ) {
      return reject;
    } else if (ts.isImportDeclaration(st) && st.importClause) {
      const ic = st.importClause;
      if (ic.name?.text === ident) return reject;
      const nb = ic.namedBindings;
      if (nb) {
        if (ts.isNamespaceImport(nb) && nb.name.text === ident) return reject;
        if (ts.isNamedImports(nb) && nb.elements.some((el) => el.name.text === ident)) return reject;
      }
    } else if (ts.isImportEqualsDeclaration(st) && st.name.text === ident) {
      return reject;
    }
  }
  return { bound: false, accepted: false };
}

function findIdentifierAt(sf: ts.SourceFile, ident: string, offset: number): ts.Identifier | undefined {
  let found: ts.Identifier | undefined;
  const visit = (n: ts.Node): void => {
    if (found || offset < n.getFullStart() || offset >= n.getEnd()) return;
    if (ts.isIdentifier(n) && n.getStart(sf) === offset && n.text === ident) {
      found = n;
      return;
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return found;
}

/** Per-use-site lexical acceptance — see the block comment above. */
export function isParseAssignedIdentifierSpread(
  rawSrc: string,
  fileName: string,
  ident: string,
  useOffset: number,
): boolean {
  const sf = ts.createSourceFile(
    fileName,
    rawSrc,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const use = findIdentifierAt(sf, ident, useOffset);
  if (!use) return false; // cannot locate the use — conservative reject
  for (let scope: ts.Node | undefined = use.parent; scope; scope = scope.parent) {
    const v = scopeBinding(scope, ident, sf, useOffset);
    if (v.bound) return v.accepted; // innermost binding decides
  }
  return false; // unbound (global/ambient) — reject
}

export type LintOptions = {
  /** Fixture mode: scan these relative paths under rootDir instead of git. */
  rootDir?: string;
  files?: string[];
  frozen?: ReadonlyMap<string, number>;
  skipEnv?: string | undefined;
};

export type Violation = { site: SpreadSite; message: string };

export type LintResult = {
  ok: boolean;
  skipped: boolean;
  scannedFiles: number;
  sites: SpreadSite[];
  violations: Violation[];
};

export function discoverServerFiles(): string[] {
  return listTrackedFiles().filter(
    (f) => f.startsWith("server/") && (f.endsWith(".ts") || f.endsWith(".tsx")) && isScannablePath(f),
  );
}

export function runLint(opts: LintOptions = {}): LintResult {
  const skipEnv = "skipEnv" in opts ? opts.skipEnv : process.env.LINT_PERSISTENCE_SPREAD_SKIP;
  if (skipEnv === "1") {
    console.error(
      "⚠️  lint-persistence-spread-boundary: SKIPPED via LINT_PERSISTENCE_SPREAD_SKIP=1 — " +
        "this must be a deliberate, documented exception.",
    );
    return { ok: true, skipped: true, scannedFiles: 0, sites: [], violations: [] };
  }
  const frozen = opts.frozen ?? FROZEN_SPREAD_SITES;
  const files = opts.files ?? discoverServerFiles();
  const remaining = new Map(frozen);
  const sites: SpreadSite[] = [];
  const violations: Violation[] = [];

  for (const rel of files) {
    const abs = opts.rootDir ? join(opts.rootDir, rel) : rel;
    let src: string;
    try {
      src = readFileSync(abs, "utf8");
    } catch {
      continue; // deleted since ls-files snapshot
    }
    const fileSites = scanFileForSpreadSites(rel, src);
    if (fileSites.length === 0) continue;
    const masked = maskSource(src);
    const rawLines = src.split("\n");
    for (const site of fileSites) {
      sites.push(site);
      const left = remaining.get(site.key) ?? 0;
      if (left > 0) {
        remaining.set(site.key, left - 1); // grandfathered (shrink-only)
        continue;
      }
      if (isZodParsedSpread(site.spreadExpr, masked)) continue;
      const bare = /^[A-Za-z_$][\w$]*$/.exec(site.spreadExpr);
      if (bare && isParseAssignedIdentifierSpread(src, rel, bare[0], site.spreadOffset)) continue;
      const startLine = rawLines[site.line - 1] ?? "";
      if (startLine.includes(APPROVE_MARKER)) {
        const reason = startLine.split(APPROVE_MARKER)[1]?.trim();
        if (reason && reason.length >= 8) continue;
        violations.push({
          site,
          message:
            `${site.file}:${site.line} — "${APPROVE_MARKER}" marker present but the reason is ` +
            `missing/too short. Write WHY this spread cannot carry request-shaped data.`,
        });
        continue;
      }
      violations.push({
        site,
        message:
          `${site.file}:${site.line} — new spread \`...${site.spreadExpr}\` inside ` +
          `.${site.kind}({...}) is not grandfathered and shows no Zod parse.`,
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
      "✗ lint-persistence-spread-boundary: raw-spread persistence write(s) without validation",
    );
    console.error("");
    console.error(
      "  A server site spreads an object into a Drizzle .set({...})/.values({...})",
    );
    console.error(
      "  without evidence of Zod validation. Request-shaped spreads let clients write",
    );
    console.error(
      "  ownership/audit/sync-state columns (the F8 incident class — see",
    );
    console.error("  audits/f8-spread-write-inventory-2026-08-09.md).");
    console.error("");
    console.error("  Fix — one of:");
    console.error(
      "   1. Parse the object through a focused/derived zod schema first (repo",
    );
    console.error(
      "      convention: strip unknowns, omit ownership/audit/sync-state columns,",
    );
    console.error(
      '      400 {error: issues} on invalid), then spread `parsed.data`.',
    );
    console.error(
      "   2. If NO request-shaped data can reach this spread (trusted internal",
    );
    console.error(
      `      domain object / explicit whitelist), append \`// ${APPROVE_MARKER} <reason>\``,
    );
    console.error(
      "      to the .set(/.values( line — the reason is mandatory and reviewed.",
    );
    console.error("");
    console.error("  Offenders:");
    for (const v of res.violations) {
      console.error(`    ${v.message}`);
    }
    console.error("");
    return 1;
  }
  console.log(
    `lint-persistence-spread-boundary: OK (${res.scannedFiles} server files, ` +
      `${res.sites.length} spread-into-persistence sites, all grandfathered/validated)`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// FROZEN baseline — the exact spread-into-persistence population at the F8
// inventory HEAD (audits/f8-spread-write-inventory-2026-08-09.md, 75 sites).
// Write-once: never regenerate or widen routinely; entries only shrink as
// sites are converted to schema-validated writes. The guard test pins the
// sha-256 of the sorted `key=count` entries.
// ---------------------------------------------------------------------------
export const FROZEN_SPREAD_SITES: ReadonlyMap<string, number> = new Map<string, number>([
  ["server/routes/ats.ts::set::(safeToAdvanceStage ? { stage: \" \" } : {})", 2],
  ["server/routes/ats.ts::set::autoBaseFields", 1],
  ["server/routes/ats.ts::set::autoBaseFieldsV1", 1],
  ["server/routes/ats.ts::set::baseFieldsV1", 1],
  ["server/routes/ats.ts::set::baseScoreFields", 1],
  ["server/routes/ats.ts::set::currentAiJson", 4],
  ["server/routes/ats.ts::set::existingHistory", 4],
  ["server/routes/ats.ts::set::fields", 2],
  ["server/routes/ats.ts::values::submissionFields", 1],
  ["server/routes/heatmap.ts::set::parsed.data", 1],
  ["server/routes/heatmap.ts::values::parsed.data", 1],
  ["server/routes/roadmap.ts::set::body", 1],
  ["server/routes/serviceDesk/configSetup.ts::set::parsed.data", 1],
  ["server/routes/serviceDesk/configSetup.ts::set::updates", 1],
  ["server/routes/serviceDesk/configSetup.ts::values::parsed.data", 1],
  ["server/routes/serviceDesk/helpers.ts::set::(clearedChecker ? { checkerUserId: null } : {})", 1],
  ["server/routes/serviceDesk/helpers.ts::set::(clearedPrimary ? { primaryUserId: null } : {})", 1],
  ["server/routes/serviceDesk/helpers.ts::set::(departmentSlots.clearedChecker ? { defaultCheckerUserId: null } : {})", 1],
  ["server/routes/serviceDesk/helpers.ts::set::(departmentSlots.clearedPrimary ? { defaultPrimaryUserId: null } : {})", 1],
  ["server/routes/serviceDesk/ticketActions.ts::values::set", 1],
  ["server/routes/serviceDesk/ticketsRead.ts::values::vals", 1],
  ["server/services/amCoachingRun.ts::set::(amFailed ? { failedManagers: sql` ` } : {})", 1],
  ["server/services/churnRiskRadar.ts::set::(bucket === \" \" ? { analyzedClients: sql` ` } : bucket === \" \" ? { insufficientClients: sql` ` } : { errorClients: sql` ` })", 1],
  ["server/services/conversationDedupe.ts::set::promotion", 1],
  ["server/services/conversationDedupe.ts::values::args.data", 2],
  ["server/services/conversationDedupe.ts::values::normalizedFields", 2],
  ["server/services/heatmapService.ts::values::staged.metrics", 1],
  ["server/services/pipelineProcessor.ts::values::event", 1],
  ["server/services/ris/risCatalog.ts::values::check", 1],
  ["server/services/semrushInventorySync.ts::values::heatmapPayload", 1],
  ["server/services/semrushLocationSyncState.ts::set::(opts?.resetAttempts ? { attemptCount: 0 } : {})", 1],
  ["server/services/zoomIntegration.ts::set::(extra?.revAiMarker ? { zoomRevAiTranscription: extra.revAiMarker } : {})", 1],
  ["server/services/zoomIntegration.ts::set::payload", 2],
  ["server/storage/agentStorage.ts::set::data", 2],
  ["server/storage/bookingStorage.ts::set::data", 3],
  ["server/storage/clientStorage.ts::set::data", 1],
  ["server/storage/clientStorage.ts::values::data", 2],
  ["server/storage/commandCenterStorage.ts::set::data", 2],
  ["server/storage/comms/bookmarks.ts::set::data", 1],
  ["server/storage/comms/calls.ts::values::data", 1],
  ["server/storage/comms/channels.ts::set::data", 1],
  ["server/storage/comms/draftsScheduled.ts::set::data", 1],
  ["server/storage/comms/userSettings.ts::values::data", 1],
  ["server/storage/communicationStorage.ts::set::data", 3],
  ["server/storage/communicationStorage.ts::values::(options?.isTouchpoint !== undefined ? { isTouchpoint: options.isTouchpoint } : {})", 1],
  ["server/storage/communicationStorage.ts::values::data", 2],
  ["server/storage/dailyJudgmentStorage.ts::set::data", 2],
  ["server/storage/docsStorage.ts::values::data", 2],
  ["server/storage/googleAdsHygieneStorage.ts::set::patch", 1],
  ["server/storage/googleAdsStorage.ts::set::patch", 2],
  ["server/storage/healthMetricsStorage.ts::set::patch", 1],
  ["server/storage/reportStorage.ts::set::data", 2],
  ["server/storage/reportStorage.ts::values::data", 2],
  ["server/storage/risStorage.ts::set::(clearAuto ? { autoError: null, confirmedAt: null, confirmedBy: null } : {})", 1],
  ["server/storage/risStorage.ts::set::patch", 3],
  ["server/storage/risStorage.ts::values::data", 1],
  ["server/storage/risStorage.ts::values::input", 1],
  ["server/storage/semrushEnrichmentCacheStorage.ts::values::row", 1],
  ["server/storage/sheetsStorage.ts::set::data", 2],
  ["server/storage/sheetsStorage.ts::set::patch", 1],
  ["server/storage/sheetsStorage.ts::values::data", 2],
  ["server/storage/twilioStorage.ts::set::data", 2],
  ["server/storage/twilioStorage.ts::values::data", 2],
  ["server/storage/twilioStorage.ts::values::normalized", 1],
  ["server/storage/twilioStorage.ts::values::values", 2],
]);

export function frozenSnapshotHash(frozen: ReadonlyMap<string, number> = FROZEN_SPREAD_SITES): string {
  const entries = [...frozen.entries()].map(([k, v]) => `${k}=${v}`).sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-persistence-spread-boundary.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
