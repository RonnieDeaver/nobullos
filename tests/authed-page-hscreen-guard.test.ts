/* test-registration
{
  "name": "authed-page h-screen source scan — pages under the top nav must size via the nav-height token (Task #4755)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4753 swept every authed page off min-h-screen/h-screen onto min-h-[calc(100dvh-var(--nav-height))] because authed routes render BELOW the sticky global nav, so 100vh sizing overflows the viewport by the nav height (bottom-pinned UI lands just off-fold). Nothing but this scan stops the next new or edited authed page from reintroducing h-screen. Pure filesystem AST scan of client/src/pages; fast, no DB.",
  "scanPaths": [
    "client/src/pages"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4755 — guard the authed-page viewport-sizing convention.
 *
 * Rule: any client STRING (string literal / template chunk, extracted via
 * the TypeScript AST so comments never match) in an AUTHED page file under
 * client/src/pages that contains the Tailwind class `h-screen` or
 * `min-h-screen` (as a whole class token, after stripping variant prefixes
 * like `md:`) is a violation. Authed pages render below the sticky global
 * nav and must size via the shared tokens instead:
 *
 *   min-h-[calc(100dvh-var(--nav-height))]   (or h-[calc(...)] for
 *   full-screen editors) — tokens live in client/src/index.css.
 *
 * Public chrome-less surfaces (no global nav — /share, /book/, /pulse/,
 * /apply/, /roadmap*, /demo-report, sign-in/up, not-found, …) keep
 * min-h-screen and are explicitly allow-listed below. The MCU checker is a
 * hybrid (public path where signed-in users still get the nav): it branches
 * on auth and is allow-listed too. See
 * .agents/memory/editor-hscreen-under-sticky-nav.md for the rationale.
 */

import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const ROOT = process.cwd();
const SCAN_ROOT = "client/src/pages";

/**
 * Public / chrome-less surfaces (and the auth-branching MCU hybrid) that
 * legitimately keep min-h-screen. Paths are relative to the repo root;
 * a trailing "/" allow-lists a whole directory.
 * Keep in sync with client/src/lib/publicPaths.ts + quicklinksVisibility.ts.
 */
const ALLOWED = [
  "client/src/pages/publicReport/", // /share/* slide deck (whole dir)
  "client/src/pages/PublicReport.tsx", // /share/*
  "client/src/pages/PublicReportPrint.tsx", // /share/* print lane
  "client/src/pages/DemoReport.tsx", // /demo-report
  "client/src/pages/PublicCeoPulse.tsx", // /pulse/*
  "client/src/pages/CeoPulseLetter.tsx", // /pulse/* letter view
  "client/src/pages/PublicBookingPage.tsx", // /book/*
  "client/src/pages/PublicBookingCancel.tsx", // /book/* cancel
  "client/src/pages/CandidatePortal.tsx", // /apply/*
  "client/src/pages/Roadmap.tsx", // /roadmap*
  "client/src/pages/SignIn.tsx",
  "client/src/pages/SignUp.tsx",
  "client/src/pages/AccessRevoked.tsx",
  "client/src/pages/NotApproved.tsx",
  "client/src/pages/not-found.tsx",
] as const;

/**
 * Hybrid public-but-navved routes (public path where SIGNED-IN users still
 * get the global nav). These are scanned like authed pages, but a banned
 * token is excused ONLY when the string is the anonymous (whenFalse) branch
 * of a ternary conditioned on `isAuthenticated` — the exact recipe from
 * .agents/memory/editor-hscreen-under-sticky-nav.md. Any h-screen added
 * elsewhere in these files (including the authenticated branch) still flags.
 */
const HYBRID = new Set(["client/src/pages/McuChecker.tsx"]);

/** Banned whole-class tokens (after variant-prefix stripping). */
const BANNED = new Set(["h-screen", "min-h-screen"]);

/** The shape authed pages must use instead — used for volume-floor sanity. */
const TOKEN_SIZING_MARKER = "var(--nav-height)";

interface ExtractedString {
  text: string;
  line: number;
  /**
   * True when this string is (inside) the whenFalse operand of a
   * ConditionalExpression whose condition mentions `isAuthenticated` — the
   * anonymous rendering branch of a hybrid public-but-navved page.
   */
  anonBranch: boolean;
}

/**
 * AST string extraction (house pattern — see
 * .agents/memory/client-copy-ast-guard.md): string literals,
 * no-substitution templates, and template-expression head/middle/tail
 * chunks. Comments are structurally invisible to this pass.
 */
export function extractStrings(source: string, fileName: string): ExtractedString[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: ExtractedString[] = [];
  const push = (text: string, pos: number, anonBranch: boolean) => {
    out.push({
      text,
      line: sf.getLineAndCharacterOfPosition(pos).line + 1,
      anonBranch,
    });
  };
  const visit = (node: ts.Node, anonBranch: boolean): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      push(node.text, node.getStart(sf), anonBranch);
    } else if (ts.isTemplateExpression(node)) {
      push(node.head.text, node.head.getStart(sf), anonBranch);
      for (const span of node.templateSpans) {
        push(span.literal.text, span.literal.getStart(sf), anonBranch);
      }
    } else if (ts.isConditionalExpression(node)) {
      // Polarity is determined STRICTLY via AST node kinds — the exemption
      // applies only to the exact identifier `isAuthenticated` (optionally
      // parenthesized) or its direct unary negation. Every other shape —
      // compound (`isAuthenticated && featureEnabled`), member access
      // (`auth.isAuthenticated`), equality (`isAuthenticated === false`),
      // similarly named identifiers — gets NO exemption on either branch
      // (fail closed): an authenticated user can reach both branches there.
      const unwrap = (e: ts.Expression): ts.Expression =>
        ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e;
      const cond = unwrap(node.condition);
      const isExactIdent = (e: ts.Expression): boolean =>
        ts.isIdentifier(e) && e.text === "isAuthenticated";
      let polarity: "positive" | "negated" | "none" = "none";
      if (isExactIdent(cond)) polarity = "positive";
      else if (
        ts.isPrefixUnaryExpression(cond) &&
        cond.operator === ts.SyntaxKind.ExclamationToken &&
        isExactIdent(unwrap(cond.operand))
      )
        polarity = "negated";
      visit(node.condition, anonBranch);
      visit(node.whenTrue, polarity === "negated" ? true : anonBranch);
      visit(node.whenFalse, polarity === "positive" ? true : anonBranch);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, anonBranch));
  };
  visit(sf, false);
  return out;
}

/**
 * Find banned class tokens in one extracted string. Class-token semantics:
 * split on whitespace, strip Tailwind variant prefixes (`md:`, `dark:`,
 * `print:` — everything up to the last `:` outside brackets), then require
 * an exact match. `max-h-screen` and `h-[calc(100dvh-var(--nav-height))]`
 * never match; `md:min-h-screen` does.
 */
export function findBannedTokens(text: string): string[] {
  const hits: string[] = [];
  for (const rawToken of text.split(/\s+/)) {
    if (!rawToken) continue;
    // Strip variant prefixes: take the segment after the last ":" that is
    // not inside an arbitrary-value bracket. Banned tokens contain no
    // brackets, so if the tail has a "[" it can't match anyway.
    const lastColon = rawToken.lastIndexOf(":");
    let base = lastColon >= 0 ? rawToken.slice(lastColon + 1) : rawToken;
    // Normalize Tailwind's important modifier: legacy leading `!` (also
    // valid before the variant chain) and v4 trailing `!`.
    base = base.replace(/^!+/, "").replace(/!+$/, "");
    if (BANNED.has(base)) hits.push(rawToken);
  }
  return hits;
}

export interface AnalysisResult {
  violations: string[];
  /** Count of strings mentioning the token-sizing marker (sanity floor). */
  tokenSizingCount: number;
  /** Banned tokens excused by the hybrid anonymous-branch allowance. */
  hybridExcused: number;
}

export function analyzeSource(
  source: string,
  rel: string,
  opts: { hybrid?: boolean } = {},
): AnalysisResult {
  const violations: string[] = [];
  let tokenSizingCount = 0;
  let hybridExcused = 0;
  for (const s of extractStrings(source, rel)) {
    if (s.text.includes(TOKEN_SIZING_MARKER)) tokenSizingCount++;
    for (const token of findBannedTokens(s.text)) {
      if (opts.hybrid && s.anonBranch) {
        // Hybrid page anonymous ternary branch — the sanctioned exception.
        hybridExcused++;
        continue;
      }
      violations.push(
        `${rel}:${s.line} — authed page uses "${token}". Authed routes render below the ` +
          `sticky top nav, so 100vh sizing overflows the viewport by the nav height. ` +
          `Use the shared tokens instead: min-h-[calc(100dvh-var(--nav-height))] ` +
          `(or h-[calc(100dvh-var(--nav-height))] for full-screen editors) — see ` +
          `client/src/index.css. If this file is genuinely a public chrome-less ` +
          `surface (no global nav), add it to ALLOWED in tests/authed-page-hscreen-guard.test.ts ` +
          `with a route comment.`,
      );
    }
  }
  return { violations, tokenSizingCount, hybridExcused };
}

function isAllowed(rel: string): boolean {
  return ALLOWED.some((a) => (a.endsWith("/") ? rel.startsWith(a) : rel === a));
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      yield full;
    }
  }
}

/** Inline extractor/checker self-test — vacuous-green protection #1. */
function selfTest(): void {
  const flagged: Array<[string, string]> = [
    ["bare h-screen", 'const a = <div className="h-screen bg-card" />;'],
    ["min-h-screen", 'const a = <div className="min-h-screen flex" />;'],
    ["variant-prefixed", 'const a = <div className="md:min-h-screen" />;'],
    ["template chunk", "const c = `flex ${x} h-screen ${y}`;"],
    ["cn() argument literal", 'const a = cn(dark ? "min-h-screen" : "p-4");'],
    ["important leading !", 'const a = <div className="!h-screen" />;'],
    ["important !min-h-screen", 'const a = <div className="!min-h-screen" />;'],
    ["variant + important", 'const a = <div className="md:!min-h-screen" />;'],
    ["important before variant chain", 'const a = <div className="!md:h-screen" />;'],
    ["v4 trailing important", 'const a = <div className="min-h-screen!" />;'],
  ];
  for (const [label, src] of flagged) {
    const r = analyzeSource(src, "fixture.tsx");
    assert(r.violations.length === 1, `fixture must be flagged (${label}): ${src}`);
  }
  const clean: Array<[string, string]> = [
    [
      "token sizing form",
      'const a = <div className="min-h-[calc(100dvh-var(--nav-height))] flex" />;',
    ],
    [
      "editor token form",
      'const a = <div className="h-[calc(100dvh-var(--nav-height))]" />;',
    ],
    ["max-h-screen is a different (capping) utility", 'const a = <div className="max-h-screen" />;'],
    ["substring inside another token", 'const a = <div className="data-h-screenshot" />;'],
    [
      "quoting the bad form in comments is legal",
      "// never write h-screen on authed pages\n/* min-h-screen is banned here */\nexport {};",
    ],
  ];
  for (const [label, src] of clean) {
    const r = analyzeSource(src, "fixture.tsx");
    assert(
      r.violations.length === 0,
      `fixture must pass (${label}): ${src}\n  ${r.violations.join("\n  ")}`,
    );
  }
  // Extractor must SEE the compliant token-sizing strings, and comments
  // must be invisible.
  assert(
    analyzeSource(clean[0][1], "fixture.tsx").tokenSizingCount === 1,
    "extractor must find the token-sizing marker",
  );
  assert(
    analyzeSource(clean[4][1], "fixture.tsx").tokenSizingCount === 0 &&
      analyzeSource(clean[4][1], "fixture.tsx").violations.length === 0,
    "comments must be invisible to the extractor",
  );
  // Hybrid allowance: excused ONLY on the anonymous (whenFalse) branch of
  // an isAuthenticated ternary, ONLY when the hybrid option is on.
  const hybridSrc =
    'const a = <div className={isAuthenticated ? "min-h-[calc(100dvh-var(--nav-height))]" : "min-h-screen"} />;';
  const hybridOn = analyzeSource(hybridSrc, "fixture.tsx", { hybrid: true });
  assert(
    hybridOn.violations.length === 0 && hybridOn.hybridExcused === 1,
    "hybrid anonymous branch must be excused under the hybrid option",
  );
  const hybridOff = analyzeSource(hybridSrc, "fixture.tsx");
  assert(
    hybridOff.violations.length === 1,
    "the same source must flag when the file is NOT hybrid-listed",
  );
  const hybridAuthedBad =
    'const a = <div className={isAuthenticated ? "h-screen" : "min-h-screen"} />;';
  assert(
    analyzeSource(hybridAuthedBad, "fixture.tsx", { hybrid: true }).violations.length === 1,
    "the AUTHENTICATED branch of a hybrid ternary must still flag",
  );
  // Negated-condition polarity: `!isAuthenticated ? anon : authed`.
  const hybridNegated =
    'const a = <div className={!isAuthenticated ? "min-h-screen" : "min-h-[calc(100dvh-var(--nav-height))]"} />;';
  const negOn = analyzeSource(hybridNegated, "fixture.tsx", { hybrid: true });
  assert(
    negOn.violations.length === 0 && negOn.hybridExcused === 1,
    "negated condition: whenTrue is the anonymous branch and must be excused",
  );
  const hybridNegatedAuthedBad =
    'const a = <div className={!isAuthenticated ? "min-h-screen" : "h-screen"} />;';
  assert(
    analyzeSource(hybridNegatedAuthedBad, "fixture.tsx", { hybrid: true }).violations.length === 1,
    "negated condition: the AUTHENTICATED (whenFalse) branch must still flag",
  );
  // Ambiguous polarity fails closed — no exemption on either branch.
  const hybridAmbiguous =
    'const a = <div className={isAuthenticated === false ? "min-h-screen" : "h-screen"} />;';
  assert(
    analyzeSource(hybridAmbiguous, "fixture.tsx", { hybrid: true }).violations.length === 2,
    "ambiguous condition polarity must get NO exemption (fail closed)",
  );
  // Compound / member / lookalike conditions never grant the exemption on
  // EITHER branch (an authenticated user can reach both).
  for (const [label, condSrc] of [
    ["compound &&", "isAuthenticated && featureEnabled"],
    ["compound ||", "isAuthenticated || preview"],
    ["member access", "auth.isAuthenticated"],
    ["negated member access", "!auth.isAuthenticated"],
    ["lookalike identifier", "someIsAuthenticated"],
    ["equality", "isAuthenticated === false"],
    ["negated compound", "!(isAuthenticated && featureEnabled)"],
  ] as const) {
    const src = `const a = <div className={${condSrc} ? "h-screen" : "min-h-screen"} />;`;
    assert(
      analyzeSource(src, "fixture.tsx", { hybrid: true }).violations.length === 2,
      `non-exact condition (${label}) must excuse NEITHER branch: ${src}`,
    );
  }
  // Parenthesized exact forms still resolve.
  const parenPos = analyzeSource(
    'const a = <div className={(isAuthenticated) ? "min-h-[calc(100dvh-var(--nav-height))]" : "min-h-screen"} />;',
    "fixture.tsx",
    { hybrid: true },
  );
  assert(
    parenPos.violations.length === 0 && parenPos.hybridExcused === 1,
    "parenthesized exact isAuthenticated condition must still be recognized",
  );
  const hybridOutsideTernary =
    'const a = <div className="h-screen" />; const b = isAuthenticated ? "x" : "y";';
  assert(
    analyzeSource(hybridOutsideTernary, "fixture.tsx", { hybrid: true }).violations.length === 1,
    "banned tokens OUTSIDE the anonymous ternary branch must still flag in hybrid files",
  );
  console.log("  ✓ extractor/checker self-test passed");
}

async function main(): Promise<void> {
  console.log("authed-page h-screen source scan (Task #4755)");
  selfTest();

  // Every allow-listed entry must still exist — renames fail loudly instead
  // of silently un-allow-listing (dir entries checked as dirs).
  for (const rel of ALLOWED) {
    statSync(path.join(ROOT, rel.endsWith("/") ? rel.slice(0, -1) : rel));
  }
  for (const rel of HYBRID) statSync(path.join(ROOT, rel));

  const violations: string[] = [];
  let scanned = 0;
  let authedScanned = 0;
  let tokenSizingTotal = 0;
  let allowedWithBanned = 0;
  let hybridExcusedTotal = 0;
  for await (const file of walk(path.join(ROOT, SCAN_ROOT))) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    scanned++;
    const raw = await fs.readFile(file, "utf8");
    if (isAllowed(rel)) {
      // Allow-listed public surfaces: not violations, but count real
      // banned-token occurrences so the scan proves it still SEES them.
      if (!raw.includes("h-screen")) continue;
      const r = analyzeSource(raw, rel);
      if (r.violations.length > 0) allowedWithBanned++;
      continue;
    }
    authedScanned++;
    const hybrid = HYBRID.has(rel);
    if (!raw.includes("h-screen")) {
      if (raw.includes(TOKEN_SIZING_MARKER)) {
        tokenSizingTotal += analyzeSource(raw, rel).tokenSizingCount;
      }
      continue; // cheap prefilter before parsing
    }
    const r = analyzeSource(raw, rel, { hybrid });
    tokenSizingTotal += r.tokenSizingCount;
    hybridExcusedTotal += r.hybridExcused;
    violations.push(...r.violations);
  }

  // Vacuous-green protection #2: volume floors on the real scan.
  assert(scanned > 40, `sanity: scan actually walked ${SCAN_ROOT} (saw ${scanned} files)`);
  assert(
    authedScanned > 25,
    `sanity: expected >25 authed (non-allow-listed) page files (saw ${authedScanned})`,
  );
  assert(
    tokenSizingTotal >= 3,
    `sanity: expected ≥3 ${TOKEN_SIZING_MARKER} sizing strings across authed pages ` +
      `(saw ${tokenSizingTotal}) — if the token convention moved, update this scan ` +
      "rather than letting it go vacuous",
  );
  // Proof the detector fires on real files: several public surfaces
  // legitimately use min-h-screen today (0-of-0 = skipped is not a pass).
  assert(
    allowedWithBanned >= 3,
    `sanity: expected ≥3 allow-listed public surfaces still using min-h-screen ` +
      `(saw ${allowedWithBanned}) — if they all moved off it, repoint this floor ` +
      "at current known occurrences",
  );
  // Proof the hybrid allowance is exercised: McuChecker's anonymous ternary
  // branch keeps min-h-screen today.
  assert(
    hybridExcusedTotal >= 1,
    `sanity: expected ≥1 hybrid anonymous-branch excusal (saw ${hybridExcusedTotal}) — ` +
      "if the hybrid page moved off the ternary recipe, update HYBRID accordingly",
  );

  assert(
    violations.length === 0,
    `h-screen/min-h-screen found on authed pages:\n  ${violations.join("\n  ")}`,
  );
  console.log(
    `  ✓ ${scanned} files scanned (${authedScanned} authed), ` +
      `${tokenSizingTotal} token-sizing strings, ${allowedWithBanned} allow-listed ` +
      `public surfaces still detected, ${hybridExcusedTotal} hybrid excusals — ` +
      "no authed h-screen regressions",
  );
  console.log("\nauthed-page-hscreen-guard: all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
