/**
 * Task #2150 — Guardrail against the "swallow a thrown credential read
 * into a real Not-Connected badge" bug class.
 *
 * Background (durable rule: .agents/memory/credential-detection-absent-
 * vs-unknown.md): a settings-backed integration probe must distinguish
 * THREE states for its credential/settings read —
 *
 *   1. confirmed present  → continue (maybe "connected")
 *   2. confirmed empty    → "unauthorized" / "Not Connected"
 *   3. read could not complete (the DB read THREW under pool saturation,
 *      a dropped connection, a timeout) → "probe_failed" / preserve the
 *      last-known badge — NEVER "unauthorized".
 *
 * The recurring regression (fixed in Stripe #2099, PandaDoc/GDrive #2101,
 * Google Ads #2115, Slack) collapsed states (2) and (3) by wrapping the
 * credential read in `.catch(() => null)` / `.catch(() => undefined)` and
 * then mapping the swallowed `null` straight into an `unauthorized`
 * outcome. A degraded DB then flips a perfectly healthy integration card
 * to "Not Connected". The fix is always: replace the swallow with a
 * try/catch that surfaces a thrown read as `probe_failed` (state 3) and
 * only returns `unauthorized` for a *confirmed* empty value (state 2).
 *
 * This lint flags that shape in TWO forms:
 *
 *   (a) Same-function (the original Task #2150 shape): a
 *       `.catch(() => null | undefined)` on a credential/settings read inside
 *       a function whose body ALSO yields a disconnect outcome
 *       (`outcome: "unauthorized"` or the three-state resolver's
 *       `status: "empty"`).
 *
 *   (b) Cross-function, same file (Task #2170): the historical bug sometimes
 *       SPLITS the shape across two functions — a credential *resolver* swallows
 *       the read with `.catch(() => null)` and returns the null, and a SEPARATE
 *       *probe* function calls that resolver by name and turns the null into
 *       `outcome: "unauthorized"` / `status: "empty"`. The swallow is flagged
 *       on the resolver when any disconnect-yielding function in the same file
 *       calls the resolver directly by name.
 *
 *   (c) Cross-FILE (Task #2212): the resolver and the probe can live in
 *       SEPARATE modules — a credential resolver EXPORTED from file A swallows
 *       the read with `.catch(() => null)` and returns the null, and a
 *       disconnect-yielding probe in file B `import`s that resolver and calls it
 *       by name, mapping the null into `outcome: "unauthorized"` / `status:
 *       "empty"`. Per-file analysis (form (b)) misses this because the consumer
 *       lives in another file. `runLint` resolves imports/exports across the
 *       whole scanned tree: a swallow on an exported resolver in A is flagged
 *       when ANY file B contains a disconnect-yielding function that imports that
 *       resolver from A and calls it directly. Matching is by the resolver's
 *       PUBLIC export name and honors both `as`-aliased imports
 *       (`import { resolveX as r }`) and aliased exports
 *       (`export { resolveX as publicResolveX }`).
 *
 *   (d) Cross-FILE through indirection (Task #2248): the probe can reach the
 *       swallowing resolver in A without a direct named import of A —
 *         · Re-export barrels: an index/barrel file re-exports the resolver
 *           (`export { resolveX } from "./a"` or `export * from "./a"`) and the
 *           probe imports it from the barrel. `runLint` follows a bounded chain
 *           of re-export edges back to the originating resolver file.
 *         · Namespace imports: `import * as creds from "./a"` then
 *           `creds.resolveX()`. The namespace binding (`creds`) is resolved to
 *           A's module specifier and the property call (`resolveX`) matched
 *           against A's public export names (through barrels too).
 *       Still out of scope: default imports and dynamic `import()`. These would
 *       need the same fix but are not yet linked; no current probe uses them.
 *
 * All forms stay precise:
 *
 *   - The already-fixed probes (Stripe, PandaDoc, Slack)
 *     use try/catch three-state resolvers — no swallow on the credential
 *     read in the unauthorized-yielding function — so they pass. (Google
 *     Ads retired its stored-connection probe in Task #4008: its auth state
 *     is env presence + the shared env-trio mint's in-process snapshot, no
 *     credential read to swallow.)
 *   - The route-layer `.catch(() => null)` on display-only metadata reads
 *     (e.g. `getServiceAccountEmail()`) is NOT flagged: those cache
 *     callbacks yield `outcome: "commit" | "preserve"`, never
 *     `"unauthorized"`, and nothing maps their result to a disconnect.
 *
 * Allowlist (mirrors the other lint scripts):
 *   - File-path ALLOWLIST set below for whole-file exceptions.
 *   - Inline suppression comment `// lint-probe-swallow-ok: <reason>` on
 *     the offending `.catch(...)` line or the line directly above it, for
 *     a single genuinely-safe construct.
 *
 * Exit code:
 *   0 — no offenders.
 *   1 — at least one swallow-into-unauthorized offender.
 *
 * Usage: npx tsx scripts/lint-probe-swallow-into-unauthorized.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";

// Scope intentionally fixed (Task #2846): probe/status accessors that could
// swallow errors into "unauthorized" live only in server runtime code.
const SCAN_ROOTS = ["server"];
const SELF = "lint-probe-swallow-into-unauthorized";
const SUPPRESS_MARKER = "lint-probe-swallow-ok";

/**
 * Whole-file exceptions. Prefer the inline `// lint-probe-swallow-ok`
 * comment for a single construct; reach for this set only when a file is
 * a documented special case. Mirrors the ALLOWLIST set in
 * scripts/lint-oauth-refresh-single-flight.ts.
 */
export const ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // (empty) — add a path here only with a written justification.
]);

/**
 * Callee names that read a credential / settings value. The bug class is
 * specifically swallowing one of THESE reads. Kept reasonably inclusive
 * because the same-function disconnect-yield requirement already makes the
 * rule precise.
 */
const CREDENTIAL_READ_RX =
  /^(getSystemSetting|getServiceAccountCredentials|getServiceAccountEmail|getApiKey|getBotToken|getAccessToken|getValidAccessToken|get[A-Za-z0-9]*(Connection|Credentials?|Token|Key|Secret|ApiKey)|resolve[A-Za-z0-9]*(Token|Key|Secret|Credential|ApiKey))$/;

export interface Offender {
  file: string;
  line: number;
  enclosingFn: string;
  snippet: string;
}

function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) {
    return e.name.text;
  }
  return null;
}

/** True if the subtree contains a credential/settings read call. */
function subtreeHasCredentialRead(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name && CREDENTIAL_READ_RX.test(name)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * True if the arrow/function body definitively resolves to `null` or
 * `undefined` (the swallow). Matches `() => null`, `() => undefined`,
 * `() => { return null; }`, and the same with ignored params.
 */
function isSwallowHandler(node: ts.Node): boolean {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  const body = node.body;
  // Concise arrow body: `() => null` / `() => undefined`.
  if (body.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(body) && body.text === "undefined") return true;
  // Block body: a single `return null;` / `return undefined;` (or an
  // implicit `return;`).
  if (ts.isBlock(body)) {
    const stmts = body.statements.filter(
      (s) => !ts.isEmptyStatement(s),
    );
    if (stmts.length === 0) return true; // `() => {}` resolves undefined
    if (stmts.length === 1 && ts.isReturnStatement(stmts[0])) {
      const expr = stmts[0].expression;
      if (!expr) return true; // `return;`
      if (expr.kind === ts.SyntaxKind.NullKeyword) return true;
      if (ts.isIdentifier(expr) && expr.text === "undefined") return true;
    }
  }
  return false;
}

/**
 * Message-substring patterns that mark a thrown Error as a *deterministic
 * disconnect* — the "connection is gone, reconnect required" terminal. The
 * rotating-refresh-token hot-path accessors (Google Calendar / Google Ads'
 * `getValidAccessToken`, …) don't RETURN an `outcome: "unauthorized"` /
 * `status: "empty"` object literal; they `throw new Error("… not connected …")`
 * instead. A credential-read swallow (`.catch(() => null)`) inside such an
 * accessor collapses UNKNOWN (the read THREW) into ABSENT (confirmed null)
 * exactly the way the object-literal shape does — the false-disconnect bug just
 * arrives via a throw rather than a return — so these throws must count as a
 * disconnect-yield too (Task #2429).
 *
 * Deliberately precise:
 *   - The transient/UNKNOWN errors these accessors throw on a FAILED read
 *     (`GoogleCalendarAuthUnknownError` / `GoogleAdsAuthUnknownError`, message
 *     "… connection state unknown … will retry (no disconnect declared)") do
 *     NOT match — that is the CORRECT confirm-before-trip handling, not a
 *     disconnect, so the real accessors keep passing.
 *   - Config / programmer errors ("… not configured", "userId is required",
 *     "Google did not return an access_token") do NOT match.
 *
 * Drift guard (Task #2433): the phrase list below is the SINGLE source of
 * truth for what counts as a disconnect throw, and the registered accessors
 * (`DISCONNECT_THROW_ACCESSORS`) are asserted by `checkAccessorCoverage` to each
 * still contain a throw that matches it. If an accessor reworded its
 * "not connected" message tomorrow so the regex stopped covering it, the lint
 * would otherwise SILENTLY lose protection — instead `runLint` fails loudly with
 * a coverage-drift error, forcing either the wording or this list to be fixed in
 * lockstep so the two can never diverge unnoticed.
 */
export const DISCONNECT_THROW_MESSAGE_PATTERNS: readonly string[] = [
  "not connected",
  "reconnect",
  "missing refresh token",
  "credential status is",
];

const DISCONNECT_THROW_MESSAGE_RX = new RegExp(
  DISCONNECT_THROW_MESSAGE_PATTERNS.join("|"),
  "i",
);

/**
 * A credential accessor whose terminal "disconnect" path is a `throw` (not a
 * returned `outcome: "unauthorized"` object literal) and which MUST therefore
 * keep containing at least one throw matching `DISCONNECT_THROW_MESSAGE_RX` for
 * the swallow guard above to cover it. Registered here so the patterns and the
 * accessors can't drift apart unnoticed (Task #2433).
 */
export interface DisconnectThrowAccessor {
  /** Path (repo-root-relative) of the accessor module. */
  file: string;
  /** Name of the function expected to contain a matched disconnect throw. */
  fn: string;
}

/**
 * The throw-based "reconnect required" accessors that must stay covered (Tasks
 * #2433, #2443).
 *
 * Each entry names a credential accessor whose CONFIRMED-empty / revoked path is
 * a `throw` carrying a composed "not connected" / "reconnect" message (NOT a
 * returned `outcome: "unauthorized"` object literal). The swallow guard detects
 * a `.catch(() => null)` feeding such a throw via `DISCONNECT_THROW_MESSAGE_RX`,
 * so if the accessor reworded its message tomorrow the guard would SILENTLY stop
 * covering it. `checkAccessorCoverage` asserts each function below still contains
 * a matching throw, forcing the wording and the pattern list to move in lockstep.
 *
 * Coverage is deliberately limited to the THROW-with-message shape, because that
 * is the only shape exposed to message drift:
 *   - The two Google OAuth accessors (Calendar / Ads) throw "… not connected …".
 *   - Front's confirmed-empty leaf (`acquireValidFrontAccessToken`), Zoom's,
 *     Slack's, PandaDoc's and SEMrush's primary accessors each throw a composed
 *     "<service> not connected …" / "reconnect" message (Task #2443).
 *
 * Deliberately NOT registered:
 *   - Stripe — its disconnect surfaces only as a returned `outcome:
 *     "unauthorized"` object literal (no disconnect throw at all). The swallow
 *     guard matches that shape STRUCTURALLY, independent of any message wording,
 *     so there is nothing to drift.
 *   - Google Drive — retired (Task #4084). Only the Sheets token lane
 *     remains in googleDriveIntegration.ts; its throws are config/transport
 *     errors ("… not configured" / "Google OAuth token exchange failed"),
 *     not a deterministic-disconnect message — by design they must NOT
 *     match the disconnect patterns.
 *   - Front's `getValidFrontAccessToken` — its own body throws a
 *     `FrontAuthError("front_not_connected", …)` whose CODE (underscored) is not
 *     a human "not connected" message; the human message lives in the leaf
 *     `acquireValidFrontAccessToken`, which is the one registered.
 */
export const DISCONNECT_THROW_ACCESSORS: readonly DisconnectThrowAccessor[] = [
  { file: "server/services/googleCalendarIntegration.ts", fn: "getValidAccessToken" },
  { file: "server/services/googleAdsIntegration.ts", fn: "getValidAccessToken" },
  { file: "server/services/frontIntegration.ts", fn: "acquireValidFrontAccessToken" },
  { file: "server/services/zoomIntegration.ts", fn: "getAccessToken" },
  { file: "server/services/slackIntegration.ts", fn: "getBotToken" },
  { file: "server/services/pandadocIntegration.ts", fn: "getApiKey" },
  { file: "server/services/semrushApi.ts", fn: "getAccessToken" },
];

/**
 * Task #2432 — a third way an accessor declares a disconnect: it does NOT put
 * "not connected" in the message at all. Instead it throws an error whose
 * `errorCategory` tag a downstream classifier
 * (`semrushLocationSyncState.classifyError`) folds into a permanent terminal —
 * `paused_auth` / a "Reconnect Required" disconnect. A credential-read
 * `.catch(() => null)` feeding such a throw is the SAME false-disconnect bug
 * (UNKNOWN collapsed into ABSENT) as the message-regex and object-literal
 * shapes, but the message-substring regex above can't see it.
 *
 * This mirrors `PERMANENT_ERROR_CATEGORIES` in
 * server/services/semrushLocationSyncState.ts — categories the classifier
 * treats as non-retryable / deterministic-disconnect. Kept as a local literal
 * (not an import) so this standalone lint script pulls in no runtime/db deps.
 * Keep the two in sync if a category is added/removed there.
 */
const PERMANENT_DISCONNECT_CATEGORIES: ReadonlySet<string> = new Set([
  "not_found",
  "missing_place_id",
  "mapping_disabled",
  "invalid_mapping",
  "auth_config",
  "malformed_payload",
]);

/**
 * Shared empty default for `isDisconnectThrow`'s `disconnectClassNames` param so
 * regex/inline-tag-only callers (e.g. the accessor-drift coverage guard) can
 * invoke it without a per-file class set.
 */
const EMPTY_DISCONNECT_CLASS_NAMES: ReadonlySet<string> = new Set();

/**
 * Unwrap a string-literal value from an expression, seeing through an
 * `as const` / `as <T>` assertion. Returns the literal text, or null if the
 * expression is not a (possibly-asserted) string literal. Used to read an
 * `errorCategory = "auth_config" as const` class field or a `{ errorCategory:
 * "auth_config" }` tag.
 */
function stringLiteralValue(node: ts.Expression): string | null {
  let e: ts.Node = node;
  while (ts.isAsExpression(e)) e = e.expression;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    return e.text;
  }
  return null;
}

/**
 * True if a class declaration tags itself with a *permanent* (deterministic
 * disconnect) `errorCategory` — either as a property initializer
 * (`errorCategory = "auth_config" as const`) or a constructor assignment
 * (`this.errorCategory = "auth_config"`). This is exactly how
 * `SemrushAuthMissingError` (`errorCategory = "auth_config"`) declares a
 * disconnect while `SemrushAuthUnknownError` (`errorCategory = "transient"`,
 * NOT permanent) does NOT — so the transient UNKNOWN class is naturally
 * excluded and the confirm-before-trip accessors keep passing.
 */
function classHasPermanentErrorCategory(cls: ts.ClassDeclaration): boolean {
  for (const m of cls.members) {
    if (
      ts.isPropertyDeclaration(m) &&
      m.name &&
      ts.isIdentifier(m.name) &&
      m.name.text === "errorCategory" &&
      m.initializer
    ) {
      const v = stringLiteralValue(m.initializer);
      if (v && PERMANENT_DISCONNECT_CATEGORIES.has(v)) return true;
    }
    if (ts.isConstructorDeclaration(m) && m.body) {
      let found = false;
      const walk = (n: ts.Node): void => {
        if (found) return;
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(n.left) &&
          n.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
          ts.isIdentifier(n.left.name) &&
          n.left.name.text === "errorCategory"
        ) {
          const v = stringLiteralValue(n.right);
          if (v && PERMANENT_DISCONNECT_CATEGORIES.has(v)) found = true;
        }
        ts.forEachChild(n, walk);
      };
      walk(m.body);
      if (found) return true;
    }
  }
  return false;
}

/**
 * Names of error classes declared *in this file* that tag themselves with a
 * permanent disconnect `errorCategory`. A `throw new <name>(...)` of one of
 * these is a disconnect-yield (the throw-based, category-tagged equivalent of
 * returning `{ outcome: "unauthorized" }`). Discovery is by the
 * `errorCategory` field, never by class name, so the transient UNKNOWN class
 * (e.g. `*AuthUnknownError`, `errorCategory = "transient"`) is excluded.
 */
function collectDisconnectClassNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isClassDeclaration(node) &&
      node.name &&
      classHasPermanentErrorCategory(node)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/**
 * True if the thrown expression carries an inline `errorCategory: "<permanent>"`
 * tag — e.g. `throw Object.assign(new Error(msg), { errorCategory:
 * "auth_config" })`. Searches the thrown subtree for an object literal whose
 * `errorCategory` property is a permanent disconnect category string.
 */
function throwExprHasPermanentCategoryTag(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const key = ts.isIdentifier(p.name)
          ? p.name.text
          : ts.isStringLiteral(p.name)
            ? p.name.text
            : null;
        if (key !== "errorCategory") continue;
        const v = stringLiteralValue(p.initializer);
        if (v && PERMANENT_DISCONNECT_CATEGORIES.has(v)) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * True if `node` is a `throw` of a deterministic disconnect / reconnect-required
 * Error — the throw-based equivalent of returning an `outcome: "unauthorized"` /
 * `status: "empty"` object literal. Recognized THREE ways:
 *   1. the thrown expression's source text matches `DISCONNECT_THROW_MESSAGE_RX`
 *      (`throw new Error("… not connected …")` / template-literal messages);
 *   2. (Task #2432) `throw new <KnownDisconnectClass>(...)` where the class is
 *      one declared in this file with a permanent `errorCategory` tag
 *      (`disconnectClassNames`);
 *   3. (Task #2432) the thrown expression carries an inline `errorCategory:
 *      "<permanent>"` tag (e.g. `Object.assign(new Error(...), { errorCategory:
 *      "auth_config" })`).
 * Forms 2 and 3 catch the category-tagged disconnect that hides without the
 * literal words "not connected" in its message.
 */
function isDisconnectThrow(
  node: ts.Node,
  disconnectClassNames: ReadonlySet<string> = EMPTY_DISCONNECT_CLASS_NAMES,
): boolean {
  if (!ts.isThrowStatement(node) || !node.expression) return false;
  const expr = node.expression;
  if (DISCONNECT_THROW_MESSAGE_RX.test(expr.getText())) return true;
  if (
    ts.isNewExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    disconnectClassNames.has(expr.expression.text)
  ) {
    return true;
  }
  if (throwExprHasPermanentCategoryTag(expr)) return true;
  return false;
}

/**
 * Why a registered accessor failed the coverage-drift check.
 *   - `file-unreadable` — the accessor module could not be read.
 *   - `fn-not-found`    — no function named `fn` exists in the module.
 *   - `no-matched-throw`— the function(s) exist but none contains a `throw`
 *                          matching `DISCONNECT_THROW_MESSAGE_RX` anymore.
 */
export type AccessorDriftReason =
  | "file-unreadable"
  | "fn-not-found"
  | "no-matched-throw";

export interface AccessorDriftFailure {
  file: string;
  fn: string;
  reason: AccessorDriftReason;
}

/** True if any throw inside `fn`'s subtree matches the disconnect regex. */
function fnContainsDisconnectThrow(fn: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (isDisconnectThrow(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return found;
}

/**
 * Coverage-drift guard (Task #2433). For each registered accessor, assert the
 * named function still contains a throw matching `DISCONNECT_THROW_MESSAGE_RX`.
 * This is the loud-failure half of "the disconnect-message list can't drift from
 * the accessors": the patterns are the single source of truth, and if an
 * accessor's wording stops matching them, this returns a failure instead of the
 * swallow guard silently going dark on that accessor.
 */
export function checkAccessorCoverage(
  registry: readonly DisconnectThrowAccessor[] = DISCONNECT_THROW_ACCESSORS,
): AccessorDriftFailure[] {
  const failures: AccessorDriftFailure[] = [];
  for (const acc of registry) {
    let source: string;
    try {
      source = readFileSync(acc.file, "utf8");
    } catch {
      failures.push({ file: acc.file, fn: acc.fn, reason: "file-unreadable" });
      continue;
    }
    const sf = ts.createSourceFile(
      acc.file,
      source,
      ts.ScriptTarget.Latest,
      /*setParentNodes*/ true,
      acc.file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const matchingFns: FnNode[] = [];
    const find = (n: ts.Node): void => {
      if (isFnNode(n) && fnName(n) === acc.fn) matchingFns.push(n);
      ts.forEachChild(n, find);
    };
    find(sf);
    if (matchingFns.length === 0) {
      failures.push({ file: acc.file, fn: acc.fn, reason: "fn-not-found" });
      continue;
    }
    if (!matchingFns.some((fn) => fnContainsDisconnectThrow(fn))) {
      failures.push({ file: acc.file, fn: acc.fn, reason: "no-matched-throw" });
    }
  }
  return failures;
}

/** True if the object literal property `name` is the string literal `value`. */
function propIsStringLiteral(
  obj: ts.ObjectLiteralExpression,
  name: string,
  value: string,
): boolean {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = p.name;
    const keyText = ts.isIdentifier(key)
      ? key.text
      : ts.isStringLiteral(key)
        ? key.text
        : null;
    if (keyText !== name) continue;
    const init = p.initializer;
    if (
      (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) &&
      init.text === value
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True if the subtree yields a "disconnect" outcome — an object literal
 * with `outcome: "unauthorized"` (probe contract) or `status: "empty"`
 * (three-state credential resolver). These are the shapes that surface as
 * a Not-Connected badge downstream.
 */
function subtreeYieldsDisconnect(
  node: ts.Node,
  disconnectClassNames: ReadonlySet<string>,
): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isObjectLiteralExpression(n)) {
      if (
        propIsStringLiteral(n, "outcome", "unauthorized") ||
        propIsStringLiteral(n, "status", "empty")
      ) {
        found = true;
        return;
      }
    }
    // Throw-based disconnect (Task #2429) — same hazard, arrives via a throw.
    if (isDisconnectThrow(n, disconnectClassNames)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

type FnNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

function isFnNode(node: ts.Node): node is FnNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** Nearest enclosing function-like node containing `node`. */
function nearestEnclosingFn(node: ts.Node): FnNode | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (isFnNode(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}

function fnName(fn: FnNode): string {
  if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) {
    if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  }
  // Arrow / function expression assigned to a variable or property.
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent)) {
    const key = parent.name;
    if (ts.isIdentifier(key)) return key.text;
    if (ts.isStringLiteral(key)) return key.text;
  }
  return "<anonymous>";
}

function lineSuppressed(lines: string[], lineIdx0: number): boolean {
  const here = lines[lineIdx0] ?? "";
  const above = lineIdx0 > 0 ? lines[lineIdx0 - 1] : "";
  return here.includes(SUPPRESS_MARKER) || above.includes(SUPPRESS_MARKER);
}

/**
 * Visit `root` and every descendant that is NOT inside a *nested* function.
 * We stop at function boundaries so that work attributed to a function is its
 * OWN body, not code that merely happens to be defined inside it (a nested
 * arrow/callback). The nested function's whole subtree is skipped.
 */
function visitSkippingNestedFns(root: ts.Node, cb: (n: ts.Node) => void): void {
  cb(root);
  ts.forEachChild(root, (child) => {
    if (isFnNode(child)) return; // skip the nested function's subtree entirely
    visitSkippingNestedFns(child, cb);
  });
}

/**
 * True if `fn` *itself* yields a disconnect outcome — a disconnect object
 * literal (`outcome: "unauthorized"` / `status: "empty"`) that lives directly
 * in `fn`'s body, not inside a nested function. This is the "probe" half of
 * the cross-function bug: the function that turns a swallowed `null` into a
 * Not-Connected badge.
 */
function fnYieldsDisconnectDirectly(
  fn: FnNode,
  disconnectClassNames: ReadonlySet<string>,
): boolean {
  const body = fn.body;
  if (!body) return false;
  let found = false;
  visitSkippingNestedFns(body, (n) => {
    if (found) return;
    if (
      ts.isObjectLiteralExpression(n) &&
      (propIsStringLiteral(n, "outcome", "unauthorized") ||
        propIsStringLiteral(n, "status", "empty"))
    ) {
      found = true;
    }
    // Throw-based disconnect (Task #2429) — the rotating-refresh-token hot-path
    // accessors throw a "not connected" Error instead of returning a disconnect
    // object literal; treat that throw as a disconnect-yield too.
    if (isDisconnectThrow(n, disconnectClassNames)) found = true;
  });
  return found;
}

/** Names of functions/methods called *directly* in `fn`'s own body. */
function directCallees(fn: FnNode): Set<string> {
  const out = new Set<string>();
  const body = fn.body;
  if (!body) return out;
  visitSkippingNestedFns(body, (n) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name) out.add(name);
    }
  });
  return out;
}

/**
 * Namespace-qualified callees (`ns.fn()`) invoked *directly* in `fn`'s own body,
 * returned as `"ns.fn"`. Only single-level `<identifier>.<identifier>()` calls
 * qualify — deeper chains (`a.b.c()`) don't correspond to a namespace import.
 */
function directNamespaceCallees(fn: FnNode): Set<string> {
  const out = new Set<string>();
  const body = fn.body;
  if (!body) return out;
  visitSkippingNestedFns(body, (n) => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (
        ts.isPropertyAccessExpression(e) &&
        ts.isIdentifier(e.expression) &&
        ts.isIdentifier(e.name)
      ) {
        out.add(`${e.expression.text}.${e.name.text}`);
      }
    }
  });
  return out;
}

/**
 * True if `node` is a `<credentialRead>.catch(() => null | undefined)` swallow
 * — the exact shape that collapses a thrown read into an absent value.
 */
function isCredentialReadSwallow(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.name) &&
    node.expression.name.text === "catch" &&
    node.arguments.length === 1 &&
    isSwallowHandler(node.arguments[0]) &&
    subtreeHasCredentialRead(node.expression.expression)
  );
}

/**
 * A single credential-read swallow site, with the facts needed to classify it
 * as an offender either per-file (forms (a)/(b)) or across the tree (form (c)).
 */
interface SwallowSite {
  /** 0-based line of the `.catch(...)` swallow. */
  line: number;
  /** Name of the enclosing function (the resolver/probe). */
  enclosingFn: string;
  snippet: string;
  /** The `.catch` line carries a `// lint-probe-swallow-ok` suppression. */
  suppressed: boolean;
  /**
   * Already an offender from per-file analysis — either the enclosing function
   * itself yields a disconnect (form (a)) or a same-file disconnect-yielding
   * function calls it by name (form (b)).
   */
  flaggedSameFile: boolean;
  /**
   * The PUBLIC names under which the enclosing resolver is exported from this
   * file (empty if not exported). Differs from `enclosingFn` under an
   * `export { localFn as exportedFn }` alias — importers in other files see the
   * exported name, so cross-file linking matches against THESE names.
   */
  publicNames: Set<string>;
}

/**
 * One named import binding: the local name it is bound to in the importing
 * file, the original exported name in the source module (differs under an
 * `as` alias), and the raw module specifier.
 */
interface ImportBinding {
  localName: string;
  importedName: string;
  specifier: string;
}

/**
 * One re-export EDGE in a barrel file. Either a named re-export
 * (`export { importedName as exportedName } from "./src"`) or a wildcard
 * (`export * from "./src"`, which passes EVERY name through unchanged).
 */
interface ReExportEdge {
  /** `export * from "./src"` — any imported name flows through unchanged. */
  wildcard: boolean;
  /** Public name importers see (null for a wildcard). */
  exportedName: string | null;
  /** Original name in the source module (null for a wildcard). */
  importedName: string | null;
  /** Raw module specifier the names are re-exported FROM. */
  specifier: string;
}

/**
 * One namespace import: `import * as localName from "specifier"`. Calls of the
 * form `localName.fn()` reach `fn` exported by the resolved module.
 */
interface NamespaceImport {
  localName: string;
  specifier: string;
}

/**
 * Everything `runLint` needs from a single file to do both per-file detection
 * and cross-file import/export linking.
 */
export interface FileFacts {
  file: string;
  swallowSites: SwallowSite[];
  /**
   * Local callee names invoked *directly* by any disconnect-yielding function
   * in this file. This is the "consumer" index: the names this file maps into
   * a Not-Connected badge.
   */
  disconnectConsumerCallees: Set<string>;
  /**
   * Namespace-qualified callees (`ns.fn`) invoked *directly* by any
   * disconnect-yielding function in this file, recorded as `"ns.fn"`. Keeps the
   * namespace binding that `disconnectConsumerCallees` (property-name only)
   * loses, so `ns` can be resolved back to a module specifier.
   */
  disconnectConsumerNamespaceCallees: Set<string>;
  /** Named imports in this file, keyed by local name. */
  imports: Map<string, ImportBinding>;
  /** Namespace imports (`import * as ns from "..."`) in this file. */
  namespaceImports: NamespaceImport[];
  /** Re-export edges (barrel `export … from "..."`) declared by this file. */
  reExports: ReExportEdge[];
}

/**
 * Map each locally-declared name to the set of PUBLIC names it is exported as
 * by this file. For a direct export the public name equals the local name; for
 * `export { localFn as exportedFn }` the local declaration `localFn` is visible
 * to importers under `exportedFn`. Re-export barrels (`export { x } from "./y"`)
 * carry no local declaration and are captured separately as re-export EDGES
 * (see `collectReExports`); default exports are not followed.
 */
function collectExportPublicNames(sf: ts.SourceFile): Map<string, Set<string>> {
  const byLocal = new Map<string, Set<string>>();
  const add = (local: string, exported: string): void => {
    let s = byLocal.get(local);
    if (!s) {
      s = new Set<string>();
      byLocal.set(local, s);
    }
    s.add(exported);
  };
  for (const stmt of sf.statements) {
    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    const hasExport = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(stmt) && hasExport && stmt.name) {
      add(stmt.name.text, stmt.name.text);
    } else if (ts.isVariableStatement(stmt) && hasExport) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) add(d.name.text, d.name.text);
      }
    } else if (
      ts.isExportDeclaration(stmt) &&
      !stmt.moduleSpecifier && // skip re-export barrels (no local declaration)
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      for (const el of stmt.exportClause.elements) {
        const exported = el.name.text;
        const local = el.propertyName ? el.propertyName.text : el.name.text;
        add(local, exported);
      }
    }
  }
  return byLocal;
}

/** Collect named imports of this file, keyed by local name (honoring `as`). */
function collectImports(sf: ts.SourceFile): Map<string, ImportBinding> {
  const out = new Map<string, ImportBinding>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const specifier = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (!clause) continue;
    const nb = clause.namedBindings;
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        const localName = el.name.text;
        const importedName = el.propertyName ? el.propertyName.text : el.name.text;
        out.set(localName, { localName, importedName, specifier });
      }
    }
  }
  return out;
}

/** Collect namespace imports (`import * as ns from "..."`) of this file. */
function collectNamespaceImports(sf: ts.SourceFile): NamespaceImport[] {
  const out: NamespaceImport[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const specifier = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (!clause) continue;
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) {
      out.push({ localName: nb.name.text, specifier });
    }
  }
  return out;
}

/**
 * Collect re-export edges of a barrel file: named re-exports
 * (`export { a as b } from "./src"`) and wildcards (`export * from "./src"`).
 * `export * as ns from "./src"` is intentionally skipped — it binds the source
 * under a namespace and does not surface the inner names as importable named
 * exports (the realistic probe layout doesn't use it).
 */
function collectReExports(sf: ts.SourceFile): ReExportEdge[] {
  const out: ReExportEdge[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt)) continue;
    if (!stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const specifier = stmt.moduleSpecifier.text;
    if (!stmt.exportClause) {
      // `export * from "./src"` — every name flows through unchanged.
      out.push({ wildcard: true, exportedName: null, importedName: null, specifier });
    } else if (ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        const exportedName = el.name.text;
        const importedName = el.propertyName ? el.propertyName.text : el.name.text;
        out.push({ wildcard: false, exportedName, importedName, specifier });
      }
    }
  }
  return out;
}

/**
 * Normalize a module path to a comparison key: strip the TS/JS extension and a
 * trailing `/index`, so `a/resolver.ts`, `a/resolver`, and `a/resolver/index.ts`
 * all compare equal.
 */
function moduleKey(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/\.(d\.ts|tsx|ts|jsx|js)$/, "")
    .replace(/\/index$/, "");
}

/**
 * Parse one file into the facts needed for per-file and cross-file analysis.
 */
export function collectFileFacts(filePath: string, source: string): FileFacts {
  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines = source.split("\n");
  const exportPublicNames = collectExportPublicNames(sf);
  const imports = collectImports(sf);
  const namespaceImports = collectNamespaceImports(sf);
  const reExports = collectReExports(sf);
  // Task #2432: error classes declared in this file whose `errorCategory` tag a
  // downstream classifier folds into a permanent disconnect; a `throw new <name>`
  // of one is a disconnect-yield even with no "not connected" in its message.
  const disconnectClassNames = collectDisconnectClassNames(sf);

  // Collect every credential-read swallow node, plus the set of callee names
  // invoked *directly* by any function that yields a disconnect outcome (the
  // same-file "consumer" index used for form (b)). Namespace-qualified calls
  // (`ns.fn()`) are kept separately so the `ns` binding survives for form (d).
  const swallowNodes: ts.CallExpression[] = [];
  const disconnectConsumerCallees = new Set<string>();
  const disconnectConsumerNamespaceCallees = new Set<string>();

  const collect = (node: ts.Node): void => {
    if (isCredentialReadSwallow(node)) swallowNodes.push(node);
    if (isFnNode(node) && fnYieldsDisconnectDirectly(node, disconnectClassNames)) {
      for (const name of directCallees(node)) disconnectConsumerCallees.add(name);
      for (const ns of directNamespaceCallees(node)) {
        disconnectConsumerNamespaceCallees.add(ns);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const swallowSites: SwallowSite[] = [];
  const seenLines = new Set<number>();
  for (const node of swallowNodes) {
    const enclosing = nearestEnclosingFn(node);
    if (!enclosing) continue;
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    if (seenLines.has(pos.line)) continue;
    seenLines.add(pos.line);

    const name = fnName(enclosing);
    const sameFunction = subtreeYieldsDisconnect(
      enclosing.body ?? enclosing,
      disconnectClassNames,
    );
    const sameFileCross =
      !sameFunction &&
      name !== "<anonymous>" &&
      disconnectConsumerCallees.has(name);

    const publicNames =
      name !== "<anonymous>"
        ? (exportPublicNames.get(name) ?? new Set<string>())
        : new Set<string>();

    swallowSites.push({
      line: pos.line,
      enclosingFn: name,
      snippet: (lines[pos.line] ?? "").trim().slice(0, 200),
      suppressed: lineSuppressed(lines, pos.line),
      flaggedSameFile: sameFunction || sameFileCross,
      publicNames,
    });
  }

  return {
    file: filePath,
    swallowSites,
    disconnectConsumerCallees,
    disconnectConsumerNamespaceCallees,
    imports,
    namespaceImports,
    reExports,
  };
}

/**
 * Per-file analysis (forms (a) and (b) only). Cross-file form (c) requires the
 * whole-tree symbol resolution done in `runLint`.
 */
export function analyzeSource(filePath: string, source: string): Offender[] {
  const facts = collectFileFacts(filePath, source);
  const offenders: Offender[] = [];
  for (const s of facts.swallowSites) {
    if (s.suppressed || !s.flaggedSameFile) continue;
    offenders.push({
      file: filePath,
      line: s.line + 1,
      enclosingFn: s.enclosingFn,
      snippet: s.snippet,
    });
  }
  return offenders;
}

export function analyzeFile(filePath: string): Offender[] {
  return analyzeSource(filePath, readFileSync(filePath, "utf8"));
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".d.ts") &&
      !entry.includes(SELF) &&
      !full.includes("__tests__")
    ) {
      out.push(full);
    }
  }
}

export interface LintResult {
  ok: boolean;
  scanned: number;
  offenders: Offender[];
  /**
   * Coverage-drift failures (Task #2433): registered accessors whose disconnect
   * throw no longer matches `DISCONNECT_THROW_MESSAGE_RX`. A non-empty list makes
   * `ok` false so the wording and the pattern list can't silently diverge.
   */
  accessorDrift: AccessorDriftFailure[];
}

export function runLint(
  opts: {
    roots?: string[];
    allowlist?: ReadonlySet<string>;
    accessorRegistry?: readonly DisconnectThrowAccessor[];
  } = {},
): LintResult {
  const roots = opts.roots ?? SCAN_ROOTS;
  const allowlist = opts.allowlist ?? ALLOWLIST;
  const accessorRegistry = opts.accessorRegistry ?? DISCONNECT_THROW_ACCESSORS;
  const files: string[] = [];
  for (const root of roots) walk(root, files);

  // ── Pass 1: parse every (non-allowlisted) file once into FileFacts.
  const facts: FileFacts[] = [];
  for (const file of files) {
    if (allowlist.has(file)) continue;
    facts.push(collectFileFacts(file, readFileSync(file, "utf8")));
  }

  const offenders: Offender[] = [];
  const emit = (file: string, s: SwallowSite): void => {
    offenders.push({
      file,
      line: s.line + 1,
      enclosingFn: s.enclosingFn,
      snippet: s.snippet,
    });
  };

  // ── Pass 2: per-file offenders (forms (a) same-function and (b) same-file
  // cross-function), and identify the swallow sites still eligible for the
  // cross-FILE link (an exported resolver not already flagged same-file).
  const seen = new Set<string>(); // "file:line" dedupe across both passes
  const crossFileCandidates: Array<{ file: string; site: SwallowSite }> = [];
  for (const f of facts) {
    for (const s of f.swallowSites) {
      if (s.suppressed) continue;
      const key = `${f.file}:${s.line}`;
      if (s.flaggedSameFile) {
        if (seen.has(key)) continue;
        seen.add(key);
        emit(f.file, s);
      } else if (s.publicNames.size > 0) {
        crossFileCandidates.push({ file: f.file, site: s });
      }
    }
  }

  // ── Pass 3: cross-FILE linking (forms (c) and (d)). An exported, swallowing
  // resolver in file A is an offender when some OTHER file B has a
  // disconnect-yielding function that reaches that resolver — directly, through
  // a bounded chain of re-export barrels, or via a namespace import — and calls
  // it. Matching is by the resolver's PUBLIC export names (honoring `as`-aliased
  // imports and `export { localFn as exportedFn }` aliases).
  const factsByModuleKey = new Map<string, FileFacts>();
  for (const f of facts) factsByModuleKey.set(moduleKey(f.file), f);

  // Resolve a relative module specifier (from `fromFile`) to a module key, or
  // null for a bare/non-relative specifier we don't follow.
  const specifierToModuleKey = (
    fromFile: string,
    specifier: string,
  ): string | null => {
    if (!specifier.startsWith(".")) return null;
    return moduleKey(join(dirname(fromFile), specifier));
  };

  const MAX_REEXPORT_DEPTH = 8;

  // True if importing `name` from module `modKey` reaches a swallowing resolver
  // in `resolverFile` exported under one of `publicNames` — directly, or by
  // following a bounded chain of re-export barrels (named or `export *`).
  const importReachesResolver = (
    modKey: string,
    name: string,
    resolverFile: string,
    publicNames: ReadonlySet<string>,
    depth: number,
    visited: Set<string>,
  ): boolean => {
    const m = factsByModuleKey.get(modKey);
    if (!m) return false;
    if (m.file === resolverFile && publicNames.has(name)) return true;
    if (depth <= 0) return false;
    const visitKey = `${modKey}|${name}`;
    if (visited.has(visitKey)) return false;
    visited.add(visitKey);
    for (const edge of m.reExports) {
      const targetKey = specifierToModuleKey(m.file, edge.specifier);
      if (!targetKey) continue;
      if (edge.wildcard) {
        // `export * from "./src"` — `name` flows through unchanged.
        if (
          importReachesResolver(
            targetKey,
            name,
            resolverFile,
            publicNames,
            depth - 1,
            visited,
          )
        ) {
          return true;
        }
      } else if (edge.exportedName === name) {
        // `export { importedName as exportedName } from "./src"`.
        if (
          importReachesResolver(
            targetKey,
            edge.importedName as string,
            resolverFile,
            publicNames,
            depth - 1,
            visited,
          )
        ) {
          return true;
        }
      }
    }
    return false;
  };

  for (const { file: resolverFile, site } of crossFileCandidates) {
    const key = `${resolverFile}:${site.line}`;
    if (seen.has(key)) continue;
    const linked = facts.some((b) => {
      if (b.file === resolverFile) return false;
      // Direct named imports, possibly through a re-export barrel chain.
      for (const binding of b.imports.values()) {
        if (!b.disconnectConsumerCallees.has(binding.localName)) continue;
        const modKey = specifierToModuleKey(b.file, binding.specifier);
        if (!modKey) continue;
        if (
          importReachesResolver(
            modKey,
            binding.importedName,
            resolverFile,
            site.publicNames,
            MAX_REEXPORT_DEPTH,
            new Set<string>(),
          )
        ) {
          return true;
        }
      }
      // Namespace imports: `import * as ns from "..."` then `ns.fn()`.
      for (const nsImport of b.namespaceImports) {
        const modKey = specifierToModuleKey(b.file, nsImport.specifier);
        if (!modKey) continue;
        const prefix = `${nsImport.localName}.`;
        for (const nsCall of b.disconnectConsumerNamespaceCallees) {
          if (!nsCall.startsWith(prefix)) continue;
          const prop = nsCall.slice(prefix.length);
          if (
            importReachesResolver(
              modKey,
              prop,
              resolverFile,
              site.publicNames,
              MAX_REEXPORT_DEPTH,
              new Set<string>(),
            )
          ) {
            return true;
          }
        }
      }
      return false;
    });
    if (linked) {
      seen.add(key);
      emit(resolverFile, site);
    }
  }

  // ── Pass 4: coverage-drift guard (Task #2433). The registered throw-based
  // accessors must each still contain a disconnect throw matching
  // `DISCONNECT_THROW_MESSAGE_RX`. If one reworded its message so it no longer
  // matches, fail loudly here instead of silently losing swallow-guard coverage.
  const accessorDrift = checkAccessorCoverage(accessorRegistry);

  return {
    ok: offenders.length === 0 && accessorDrift.length === 0,
    offenders,
    scanned: facts.length,
    accessorDrift,
  };
}

export function cliMain(): number {
  const result = runLint();
  if (result.ok) {
    console.log(
      `[${SELF}] OK — scanned ${result.scanned} files, no swallow-into-unauthorized probes found.`,
    );
    return 0;
  }
  if (result.offenders.length > 0) {
    console.error(
      `[${SELF}] FAILED — ${result.offenders.length} probe(s) collapse a thrown credential read into "unauthorized":`,
    );
    for (const o of result.offenders) {
      console.error(`  ${o.file}:${o.line}  (in ${o.enclosingFn}())`);
      console.error(`    > ${o.snippet}`);
    }
    console.error(
      "\nFix: a credential/settings read that THROWS is not evidence the credential is missing.",
    );
    console.error(
      "  Replace `.catch(() => null)` with a try/catch that returns a transient outcome",
    );
    console.error(
      '  (`probe_failed` / `status: "unknown"`) for a thrown read, and reserve `unauthorized`',
    );
    console.error(
      "  for a CONFIRMED empty value. See .agents/memory/credential-detection-absent-vs-unknown.md.",
    );
    console.error(
      `\n  Genuinely-safe construct? Add \`// ${SUPPRESS_MARKER}: <reason>\` on the .catch line`,
    );
    console.error("  (or the line above), or add the file to ALLOWLIST with a justification.");
  }
  if (result.accessorDrift.length > 0) {
    const reasonText: Record<AccessorDriftReason, string> = {
      "file-unreadable": "module could not be read",
      "fn-not-found": "the registered function no longer exists",
      "no-matched-throw":
        "no disconnect throw matches DISCONNECT_THROW_MESSAGE_RX anymore",
    };
    console.error(
      `\n[${SELF}] FAILED — ${result.accessorDrift.length} registered accessor(s) drifted from the disconnect-message patterns:`,
    );
    for (const d of result.accessorDrift) {
      console.error(`  ${d.file}  (${d.fn}()) — ${reasonText[d.reason]}`);
    }
    console.error(
      "\nThe disconnect-message patterns (DISCONNECT_THROW_MESSAGE_PATTERNS) and the registered",
    );
    console.error(
      "  accessors (DISCONNECT_THROW_ACCESSORS) are kept in lockstep so the swallow guard can't",
    );
    console.error(
      "  silently stop covering an accessor. Fix by EITHER restoring the accessor's throw wording",
    );
    console.error(
      "  to match a pattern, OR updating the pattern list / registry in this file to match the",
    );
    console.error("  intended new wording.");
  }
  return 1;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("lint-probe-swallow-into-unauthorized.ts");

if (isMain) {
  process.exit(cliMain());
}
