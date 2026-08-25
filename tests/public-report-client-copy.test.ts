/* test-registration
{
  "name": "Public report client-copy guard — banned internal vocabulary ('NoBull OS', all-caps BETA, 'marked as final') never appears in string literals, template text, or JSX text on any public report surface file (/share, /preview, /demo-report, print wrapper, every slide, and the shared components the deck imports); AST-based extraction so code comments may still reference internal history (Task #4287)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4287: sub-second pure AST string scan (no DB, no network, no DOM). The public report deck is the client trust surface — one leaked 'NoBull OS' or 'BETA' string undoes the client-copy pass silently, and nothing else guards slide copy statically. This is the sweep guard the task mandates; scanPaths keeps it gate-selected only when public-surface files change.",
  "scanPaths": [
    "client/src/pages/publicReport",
    "client/src/pages/PublicReport.tsx",
    "client/src/pages/PublicReportPrint.tsx",
    "client/src/pages/DemoReport.tsx",
    "client/src/components/ReportProductUpdates.tsx",
    "client/src/components/RoadmapMarkdown.tsx",
    "client/src/components/RoadmapProgressBar.tsx",
    "client/src/components/CeoPulseChartRenderer.tsx",
    "client/src/components/ceoPulseSlideContent.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4287 — client-copy guard for the public report surface.
 *
 * The audit (audits/client-report-design-audit-2026-08.md §7/§8.6, backlog
 * #24/#23) flagged internal vocabulary leaking into client-visible strings:
 * "NoBull OS" (internal product name — clients see "NoBull Marketing" and
 * "Revenue Engine Report"), "BETA" experiment hedging, and finalize-workflow
 * operator copy ("marked as Final"). This suite is the standing sweep: it
 * extracts every STRING a client could see — string literals, template
 * literal text parts, and JSX text — from every file on the public report
 * surface and fails on any banned phrase.
 *
 * AST-based on purpose: code comments legitimately reference internal
 * history ("the old NoBull OS restore", "BETA hedge removed") and must not
 * trip the guard; a raw grep could never make that distinction. The
 * extractor itself is self-tested below on an inline snippet (string +
 * template + JSX hit, comment miss) so a TypeScript API drift that silently
 * extracts nothing cannot produce a vacuous green — and the main scan also
 * asserts a minimum file/string volume for the same reason.
 *
 * Scope = the four public routes' import surface: the publicReport/ slide
 * directory, the PublicReport orchestration root, the print/demo wrappers,
 * and the shared components the deck renders (product updates + roadmap +
 * CEO Pulse chart/content helpers). New slides land in the scanned
 * directory automatically; a new shared component import must be added to
 * SCAN_EXTRA_FILES (and the registration scanPaths) when it renders client
 * copy.
 *
 * Hermetic: filesystem read + typescript parse only. No DB, no network.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = new URL("..", import.meta.url).pathname;

const SCAN_DIR = "client/src/pages/publicReport";
const SCAN_EXTRA_FILES = [
  "client/src/pages/PublicReport.tsx",
  "client/src/pages/PublicReportPrint.tsx",
  "client/src/pages/DemoReport.tsx",
  "client/src/components/ReportProductUpdates.tsx",
  "client/src/components/RoadmapMarkdown.tsx",
  "client/src/components/RoadmapProgressBar.tsx",
  "client/src/components/CeoPulseChartRenderer.tsx",
  "client/src/components/ceoPulseSlideContent.ts",
];

// Banned internal vocabulary. Each entry documents the client-appropriate
// replacement so a failure message teaches the fix, not just the rule.
const BANNED: Array<{ re: RegExp; label: string }> = [
  {
    re: /nobull\s+os/i,
    label:
      '"NoBull OS" is the internal product name — client surfaces say "NoBull Marketing" (brand) or "Revenue Engine Report" (the deck)',
  },
  {
    // Case-sensitive + word-boundary: catches the "BETA" / "(BETA)" /
    // "BETA — experimental" hedge chips without tripping on prose words
    // ("BESTSELLER") or lowercase identifiers.
    re: /\bBETA\b/,
    label:
      '"BETA" is internal experiment hedging — drop the flag on client surfaces or use client-appropriate framing',
  },
  {
    re: /marked as final/i,
    label:
      '"marked as Final" is operator workflow vocabulary — clients never see finalize-workflow state',
  },
];

interface ExtractedString {
  file: string;
  line: number; // 1-based
  text: string;
}

/** Every string a client could see in a source file: string literals,
 *  template literal text parts, JSX text. Comments are deliberately NOT
 *  extracted. */
function extractStrings(fileLabel: string, source: string): ExtractedString[] {
  const sf = ts.createSourceFile(fileLabel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: ExtractedString[] = [];
  const push = (node: ts.Node, text: string) => {
    if (text.trim().length === 0) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ file: fileLabel, line: line + 1, text });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      push(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      push(node.head, node.head.text);
      for (const span of node.templateSpans) push(span.literal, span.literal.text);
    } else if (ts.isJsxText(node)) {
      push(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function violationsIn(strings: ExtractedString[]): string[] {
  const found: string[] = [];
  for (const s of strings) {
    for (const { re, label } of BANNED) {
      if (re.test(s.text)) {
        found.push(`${s.file}:${s.line} → ${JSON.stringify(s.text.trim().slice(0, 120))}\n    banned: ${label}`);
      }
    }
  }
  return found;
}

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// ---------------------------------------------------------------------------
// 1. Extractor self-test — proves the mechanism catches strings/templates/JSX
//    and skips comments, so the main scan cannot be vacuously green.
// ---------------------------------------------------------------------------
{
  const SELF_TEST = [
    "// comment referencing NoBull OS is allowed (internal history)",
    "/* block comment: BETA and marked as Final also allowed here */",
    'const a = "powered by NoBull OS";',
    "const b = `pipeline momentum ${x} BETA`;",
    "export const j = <p>This report is marked as Final.</p>;",
  ].join("\n");
  const strings = extractStrings("self-test.tsx", SELF_TEST);
  const hits = violationsIn(strings);
  assert.equal(
    hits.length,
    3,
    `extractor self-test expected exactly 3 violations (string literal, template part, JSX text), got ${hits.length}:\n${hits.join("\n")}`,
  );
  assert.ok(
    !hits.some((h) => h.includes(":1 ") || h.includes(":2 ")),
    "extractor self-test: comment lines (1-2) must never produce violations",
  );
  ok("extractor self-test: string/template/JSX hit, comments skipped");
}

// ---------------------------------------------------------------------------
// 2. The sweep — every public-surface file is clean.
// ---------------------------------------------------------------------------
{
  const files: string[] = [];
  for (const entry of readdirSync(join(ROOT, SCAN_DIR))) {
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    files.push(join(SCAN_DIR, entry));
  }
  for (const extra of SCAN_EXTRA_FILES) {
    // statSync throws loudly if a scanned file was renamed/deleted — the
    // guard must fail visibly rather than silently shrink its coverage.
    statSync(join(ROOT, extra));
    files.push(extra);
  }

  assert.ok(
    files.length >= 30,
    `public-surface scan shrank to ${files.length} files (< 30) — was the publicReport directory moved/renamed? Update SCAN_DIR/SCAN_EXTRA_FILES and the registration scanPaths together.`,
  );

  let totalStrings = 0;
  const allViolations: string[] = [];
  for (const rel of files) {
    const strings = extractStrings(rel, readFileSync(join(ROOT, rel), "utf8"));
    totalStrings += strings.length;
    allViolations.push(...violationsIn(strings));
  }

  assert.ok(
    totalStrings > 200,
    `only ${totalStrings} strings extracted across ${files.length} public-surface files — extraction is likely broken (vacuous-green protection)`,
  );

  assert.equal(
    allViolations.length,
    0,
    `internal vocabulary leaked onto the public report surface (${allViolations.length} hit${allViolations.length === 1 ? "" : "s"}):\n\n${allViolations.join("\n")}\n\nRewrite in client voice (audits/client-report-design-audit-2026-08.md §7/§8.6). If the phrase must exist in code, keep it in a comment or identifier — never in a string a client can see.`,
  );

  ok(`sweep clean: ${files.length} files, ${totalStrings} client-reachable strings, 0 banned phrases`);
}

console.log(`\nTest run complete: ${passed} passed, 0 failed`);
