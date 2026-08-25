/**
 * Task #3984 — guard: no upload accept path may skip server-side content
 * verification.
 *
 * Background: Task #3964 (audit A-006) added post-upload verification —
 * size caps + magic-byte sniffing + contentType laundering — in
 * `server/replit_integrations/object_storage/uploadContentVerification.ts`,
 * because presigned PUT URLs minted through the Replit sidecar CANNOT carry
 * size/content-type constraints (signed headers are host-only). Every flow
 * that ACCEPTS an uploaded object (attaches / claims / persists a reference
 * to it, or flips its ACL) must therefore call
 * `verifyObjectEntityContent(objectPath, constraints)` first. The three
 * current accept paths (feedback claim, ATS submit-video, heatmap public-ACL
 * claim) do; nothing STRUCTURALLY stops the next upload feature from
 * skipping it — a new route that takes a client-supplied objectPath and
 * calls `trySetObjectEntityAclPolicy` (or persists the path) silently
 * reopens the hole. This lint is the standing guard.
 *
 * Detection is AST-based (ts.createSourceFile — syntax only, no type
 * checking; files are regex-prefiltered so only candidates are parsed). Two
 * suspect signals, scanned outside `server/replit_integrations/object_storage/`:
 *
 *   A. ACL stamping — every `trySetObjectEntityAclPolicy(...)` CALL
 *      EXPRESSION (property access or bare direct invocation; interface/type
 *      method signatures are not calls and never match) must be preceded by
 *      a verification INVOCATION (`verifyObjectEntityContent(...)` /
 *      `verifyUploadObjectContent(...)`) in the SAME enclosing function
 *      body — the innermost function-like scope (function declaration /
 *      expression, arrow, class or object method, accessor, constructor)
 *      containing the stamp. A verifier that is merely imported/referenced,
 *      invoked in a DIFFERENT function, invoked inside a NESTED
 *      function/arrow declared earlier in the same body (it need not run),
 *      or invoked AFTER the stamp does not pass. The single audited
 *      exception: stamps whose enclosing named function is one of the
 *      heatmap heal helpers (HEAL_HELPER_ALLOWLIST) inside HEAL_FILE — those
 *      re-stamp objects ALREADY referenced as a location's `heatmapImageUrl`
 *      (verified when first accepted via the claim endpoint); the exemption
 *      is stale-checked.
 *
 *   B. Request-supplied `/objects/` handling — a file with a `/objects/`
 *      string/template literal (AST string-literal-like nodes) whose code
 *      reads `req.body`/`req.query`/`req.params` (literal-masked source, so
 *      comments never trip) must contain an AWAITED verification invocation
 *      somewhere in the file, or be listed in FILE_ALLOWLIST with a reason
 *      (audited read-only consumers that never persist the reference or flip
 *      an ACL). Allow-list entries are stale-checked.
 *
 * To fix a flagged file: call
 *   `storage.verifyObjectEntityContent(objectPath, CONSTRAINTS)` (see
 *   `UploadContentVerifyingStorage` in
 *   server/replit_integrations/object_storage/uploadContentVerification.ts)
 * BEFORE attaching/claiming/persisting the object, reject on a failed
 * verdict, and delete the rejected object via
 * `deleteRejectedUploadObject(objectPath, { expectedOwner })`. Copy one of
 * the existing accept paths (feedback claim in server/routes/feedback.ts,
 * ATS submit-video in server/routes/ats.ts, heatmap claim handler in
 * server/services/heatmapImageAcl.ts).
 *
 * Exit codes: 0 — clean; 1 — unverified accept path or stale allow-list.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const DEFAULT_ROOT = "server";
/** The verification module's own home — infrastructure, not an accept path. */
const DEFAULT_EXCLUDE_DIR = "server/replit_integrations/object_storage";
/** The only file whose heal helpers may stamp ACLs without a verify call. */
export const HEAL_FILE = "server/services/heatmapImageAcl.ts";

/** Cheap prefilter: only files matching one of these get an AST parse. */
const PREFILTER_RE = /trySetObjectEntityAclPolicy|\/objects\//;
/** Request-input references in code (masked source — comments never trip). */
const REQUEST_INPUT_RE = /\breq\.(body|query|params)\b/;

const STAMP_NAME = "trySetObjectEntityAclPolicy";
const VERIFY_NAMES = new Set([
  "verifyObjectEntityContent",
  "verifyUploadObjectContent",
  // Task #4023: the general client-file claim verifier (client-files/
  // namespace) — same contract (size cap + magic-byte sniff + reject-delete),
  // implemented next to the legacy verifiers in
  // server/replit_integrations/object_storage/objectStorage.ts.
  "verifyClientFileObjectContent",
]);

/**
 * Deliberate exceptions by ENCLOSING FUNCTION NAME, valid only inside
 * HEAL_FILE: the heatmap heal paths re-stamp `{ owner, visibility: "public" }`
 * onto objects that are already referenced as a location's heatmapImageUrl
 * (claimed + verified when first accepted by the claim endpoint).
 */
export const HEAL_HELPER_ALLOWLIST = [
  "setHeatmapObjectPublic",
  "ensureHeatmapImagesPublic",
] as const;

export interface FileAllowlistEntry {
  file: string;
  reason: string;
}

/**
 * Audited per-file exceptions for signal B. Add an entry ONLY for a flow that
 * consumes a request-supplied `/objects/` path READ-ONLY (never persists the
 * reference, never flips its ACL) — anything that accepts an upload must
 * verify instead. Does NOT excuse signal-A (ACL stamping) call sites.
 */
export const FILE_ALLOWLIST: FileAllowlistEntry[] = [
  {
    file: "server/routes/videoAnalysis.ts",
    reason:
      "read-only consumer: downloads the object via an ownership-checked helper to feed TwelveLabs analysis; never persists the /objects/ reference and never sets an ACL",
  },
];

// ────────────────────────────── literal masking ──────────────────────────────
// Used only for REQUEST_INPUT_RE (signal B) so `req.body` in a comment or
// string never counts as request handling. Signal A and the /objects/ literal
// detection are AST-based and need no masking. Same masking approach as
// lint-cross-instance-locks (regex literals MUST be masked too, or a
// `.replace(/"/g, …)` flips the scanner into string mode).

const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "case", "do", "else",
  "void", "delete", "yield", "await", "new",
]);
const REGEX_PREV_CHARS = "(){[,;:=!&|?+-*/%^~<>";

function prevWord(src: string, idx: number): string {
  let j = idx - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  const end = j;
  while (j >= 0 && /[A-Za-z0-9_$]/.test(src[j])) j--;
  return src.slice(j + 1, end + 1);
}

/**
 * Replace the CONTENTS of string literals, template literals, comments, and
 * regex literals with spaces (length/newline-preserving) so structural scans
 * never trip on identifiers mentioned in comments or strings.
 */
export function maskLiterals(src: string): string {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  let prev = "";
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") (out[i] = " "), i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < n) (out[i] = " "), (out[i + 1] = " "), (i += 2);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out[i] = " ";
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          out[i] = " ";
          if (i + 1 < n && src[i + 1] !== "\n") out[i + 1] = " ";
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          out[i] = " ";
          i++;
          break;
        }
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      prev = ")";
      continue;
    }
    if (c === "/") {
      let isRegex = prev === "" || REGEX_PREV_CHARS.includes(prev);
      if (!isRegex && /[A-Za-z0-9_$]/.test(prev)) {
        isRegex = REGEX_KEYWORDS.has(prevWord(src, i));
      }
      if (isRegex) {
        out[i] = " ";
        i++;
        let inClass = false;
        while (i < n && src[i] !== "\n") {
          const ch = src[i];
          if (ch === "\\") {
            out[i] = " ";
            if (i + 1 < n && src[i + 1] !== "\n") out[i + 1] = " ";
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
          out[i] = " ";
          i++;
        }
        while (i < n && /[a-z]/i.test(src[i])) (out[i] = " "), i++;
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

// ──────────────────────────────── AST helpers ────────────────────────────────

/** A function-like node WITH a body (never interface/type method signatures). */
function isFunctionScope(node: ts.Node): boolean {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    (node as ts.FunctionLikeDeclaration).body !== undefined
  );
}

/** Innermost function-like scope containing `node` (SourceFile at top level). */
function enclosingScope(node: ts.Node): ts.Node {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (isFunctionScope(cur)) return cur;
    cur = cur.parent;
  }
  return node.getSourceFile();
}

/** Best-effort NAME of a function-like scope (declaration/method/`const x =`). */
function scopeName(scope: ts.Node): string | null {
  if (ts.isFunctionDeclaration(scope) || ts.isMethodDeclaration(scope)) {
    return scope.name && ts.isIdentifier(scope.name) ? scope.name.text : null;
  }
  if (ts.isFunctionExpression(scope) && scope.name) return scope.name.text;
  if (
    (ts.isArrowFunction(scope) || ts.isFunctionExpression(scope)) &&
    scope.parent &&
    ts.isVariableDeclaration(scope.parent) &&
    ts.isIdentifier(scope.parent.name)
  ) {
    return scope.parent.name.text;
  }
  return null;
}

/** Callee identifier of a call: `foo(...)` or `a.b.foo(...)` → "foo". */
function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) return e.name.text;
  return null;
}

interface FileAnalysis {
  stamps: Array<{ pos: number; line: number; scope: ts.Node }>;
  verifies: Array<{ pos: number; scope: ts.Node; awaited: boolean }>;
  hasObjectsLiteral: boolean;
}

function analyzeFile(fileName: string, raw: string): FileAnalysis {
  const sf = ts.createSourceFile(
    fileName,
    raw,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const result: FileAnalysis = { stamps: [], verifies: [], hasObjectsLiteral: false };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && node.text.includes("/objects/")) {
      result.hasObjectsLiteral = true;
    }
    if (ts.isTemplateExpression(node) && node.head.text.includes("/objects/")) {
      result.hasObjectsLiteral = true;
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name === STAMP_NAME) {
        const pos = node.getStart(sf);
        result.stamps.push({
          pos,
          line: sf.getLineAndCharacterOfPosition(pos).line + 1,
          scope: enclosingScope(node),
        });
      } else if (name && VERIFY_NAMES.has(name)) {
        result.verifies.push({
          pos: node.getStart(sf),
          scope: enclosingScope(node),
          awaited: node.parent !== undefined && ts.isAwaitExpression(node.parent),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return result;
}

// ─────────────────────────────────── lint ────────────────────────────────────

export interface LintOptions {
  root?: string;
  excludeDir?: string;
  allowList?: FileAllowlistEntry[];
  healFile?: string;
}

export interface LintResult {
  ok: boolean;
  /** Files carrying at least one suspect signal. */
  scanned: number;
  /** trySetObjectEntityAclPolicy call sites with an ordered same-scope verify. */
  verifiedStampSites: number;
  /** Call sites excused as heatmap heal helpers (HEAL_FILE only). */
  healExcusedSites: number;
  /** Signal-B files satisfied by an awaited verify invocation. */
  verifiedRequestFiles: number;
  allowListedCount: number;
  offenders: Array<{ file: string; reason: string }>;
  /** Stale FILE_ALLOWLIST entries / stale heal exemption. */
  stale: string[];
}

export function runLint(options: LintOptions = {}): LintResult {
  const root = options.root ?? DEFAULT_ROOT;
  const excludeDir = (options.excludeDir ?? DEFAULT_EXCLUDE_DIR).replace(/\/$/, "");
  const allowList = options.allowList ?? FILE_ALLOWLIST;
  const healFile = options.healFile ?? HEAL_FILE;
  const allowByFile = new Map(allowList.map((e) => [e.file, e]));
  const healHelpers = new Set<string>(HEAL_HELPER_ALLOWLIST);

  const files: string[] = [];
  (function walk(dir: string): void {
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
      if (st.isDirectory()) walk(full);
      else if (full.endsWith(".ts") || full.endsWith(".tsx")) files.push(full);
    }
  })(root);

  const offenders: Array<{ file: string; reason: string }> = [];
  const suspects = new Set<string>();
  const requestSuspects = new Set<string>();
  let verifiedStampSites = 0;
  let healExcusedSites = 0;
  let verifiedRequestFiles = 0;
  let allowListedCount = 0;

  for (const file of files) {
    if (file === excludeDir || file.startsWith(excludeDir + "/")) continue;
    const raw = readFileSync(file, "utf8");
    if (!PREFILTER_RE.test(raw)) continue;
    const analysis = analyzeFile(file, raw);

    // ── Signal A: per-call-site same-scope ordered verification ────────────
    for (const stamp of analysis.stamps) {
      suspects.add(file);
      // Heal exemption: any enclosing NAMED function of the stamp is an
      // allow-listed heal helper, and the file is the audited heal module.
      if (file === healFile) {
        let excused = false;
        for (let s: ts.Node | null = stamp.scope; s && !ts.isSourceFile(s); s = enclosingScope(s)) {
          const name = scopeName(s);
          if (name && healHelpers.has(name)) {
            excused = true;
            break;
          }
          if (ts.isSourceFile(enclosingScope(s))) break;
        }
        if (excused) {
          healExcusedSites++;
          continue;
        }
      }
      // Verified iff a verify INVOCATION exists in the SAME innermost
      // function scope, positioned BEFORE the stamp. A verifier inside a
      // nested function/arrow has a different scope and never counts (it
      // need not execute); one in another function or after the stamp never
      // counts either.
      const ok = analysis.verifies.some(
        (v) => v.scope === stamp.scope && v.pos < stamp.pos,
      );
      if (ok) {
        verifiedStampSites++;
        continue;
      }
      const where = ts.isSourceFile(stamp.scope)
        ? "top level"
        : `function ${scopeName(stamp.scope) ?? "<anonymous>"}`;
      offenders.push({
        file,
        reason: `trySetObjectEntityAclPolicy(...) at line ${stamp.line} (${where}) has no preceding verifyObjectEntityContent/verifyUploadObjectContent/verifyClientFileObjectContent invocation in the same function body`,
      });
    }

    // ── Signal B: request-supplied /objects/ handling needs an awaited verify ─
    if (analysis.hasObjectsLiteral && REQUEST_INPUT_RE.test(maskLiterals(raw))) {
      suspects.add(file);
      requestSuspects.add(file);
      if (analysis.verifies.some((v) => v.awaited)) {
        verifiedRequestFiles++;
      } else if (allowByFile.has(file)) {
        allowListedCount++;
      } else {
        offenders.push({
          file,
          reason:
            'handles a request-supplied /objects/ reference (has a "/objects/" literal + reads req.body/query/params) with no awaited verifyObjectEntityContent/verifyUploadObjectContent/verifyClientFileObjectContent invocation in the file',
        });
      }
    }
  }

  const stale: string[] = [];
  for (const entry of allowList) {
    if (!existsSync(entry.file)) {
      stale.push(`FILE_ALLOWLIST: ${entry.file} (file no longer exists)`);
      continue;
    }
    if (
      !requestSuspects.has(entry.file) &&
      (entry.file.startsWith(root + "/") || entry.file === root)
    ) {
      stale.push(
        `FILE_ALLOWLIST: ${entry.file} (no longer handles a request-supplied /objects/ reference)`,
      );
    }
  }
  // Heal exemption staleness: the exemption is pinned to healFile — if that
  // file is gone the constant must move with the helpers.
  if (!existsSync(healFile) && (healFile.startsWith(root + "/") || options.healFile === undefined)) {
    stale.push(`HEAL_FILE: ${healFile} (file no longer exists — move or drop the heal exemption)`);
  }

  return {
    ok: offenders.length === 0 && stale.length === 0,
    scanned: suspects.size,
    verifiedStampSites,
    healExcusedSites,
    verifiedRequestFiles,
    allowListedCount,
    offenders,
    stale,
  };
}

export function cliMain(): number {
  const result = runLint();
  if (result.ok) {
    console.log(
      `lint-upload-content-verification: OK (${result.scanned} suspect file${
        result.scanned === 1 ? "" : "s"
      } outside ${DEFAULT_EXCLUDE_DIR}/: ${result.verifiedStampSites} verified ACL stamp site(s), ${result.healExcusedSites} heal-excused site(s), ${result.verifiedRequestFiles} verified request-handling file(s), ${result.allowListedCount} allow-listed)`,
    );
    return 0;
  }

  if (result.offenders.length > 0) {
    console.error("");
    console.error(
      "✗ lint-upload-content-verification: upload accept path(s) without server-side content verification",
    );
    console.error("");
    console.error(
      "  Presigned PUT URLs carry NO size/content-type constraints (sidecar signs",
    );
    console.error(
      "  host only), so an uploader can PUT any bytes with any declared MIME type.",
    );
    console.error(
      "  Every flow that ACCEPTS an uploaded object — claims it, persists its",
    );
    console.error(
      "  /objects/ path, or flips its ACL — must verify the STORED bytes first,",
    );
    console.error(
      "  BEFORE the acceptance operation, in the same function:",
    );
    console.error("");
    console.error(
      "    const verdict = await storage.verifyObjectEntityContent(objectPath, CONSTRAINTS);",
    );
    console.error(
      "    if (!verdict.ok) { reject; await storage.deleteRejectedUploadObject(objectPath, { expectedOwner }); }",
    );
    console.error(
      "    await storage.trySetObjectEntityAclPolicy(objectPath, …); // only after a passing verdict",
    );
    console.error("");
    console.error(
      "  See server/replit_integrations/object_storage/uploadContentVerification.ts",
    );
    console.error(
      "  (UploadContentVerifyingStorage) and copy an existing accept path:",
    );
    console.error(
      "  feedback claim (server/routes/feedback.ts), ATS submit-video",
    );
    console.error(
      "  (server/routes/ats.ts), or the heatmap claim handler",
    );
    console.error("  (server/services/heatmapImageAcl.ts).");
    console.error("");
    console.error(
      "  Read-only consumers that never persist/ACL-flip the path may be added to",
    );
    console.error(
      "  FILE_ALLOWLIST in scripts/lint-upload-content-verification.ts with a reason.",
    );
    console.error("");
    console.error("  Offending files:");
    for (const o of result.offenders) console.error(`    - ${o.file}: ${o.reason}`);
    console.error("");
  }

  if (result.stale.length > 0) {
    console.error("");
    console.error(
      "✗ lint-upload-content-verification: stale exception entries",
    );
    console.error(
      "  Fix these in scripts/lint-upload-content-verification.ts:",
    );
    for (const s of result.stale) console.error(`    - ${s}`);
    console.error("");
  }

  return 1;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("lint-upload-content-verification.ts");

if (isMain) {
  process.exit(cliMain());
}
