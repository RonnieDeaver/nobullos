/* test-registration
{
  "name": "Reduced-motion smooth-scroll guard (Task #4699) — no client source file may hard-code behavior: \"smooth\"; programmatic smooth scrolls go through motionSafeScrollBehavior()",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4699: fast pure AST source scan (no DB, no network); a hard-coded behavior: \"smooth\" silently re-breaks prefers-reduced-motion for that call site — the exact regression Tasks #4676/#4699 swept out of pages/ and components/.",
  "scanPaths": [
    "client/src"
  ],
  "tier": "small"
}
test-registration */
// Task #4699 — source contract for the reduced-motion scroll sweep.
//
// Background: CSS `scroll-behavior` rules cannot override an explicit JS
// `behavior` option, so every programmatic smooth scroll must consult
// prefers-reduced-motion itself. Task #4676 swept client/src/pages/ onto
// motionSafeScrollBehavior() (client/src/lib/scrollBehavior.ts); Task #4699
// swept client/src/components/. This scan keeps FUTURE call sites honest:
// no client source file may pass a literal "smooth" as a `behavior`
// property — use motionSafeScrollBehavior() instead.
//
// Detector (AST, not grep): flags any object-literal property assignment
// `behavior: "smooth"` (string literal or substitution-free template,
// including `as const`/parenthesized/satisfies wrappers, and quoted
// property names). `behavior: motionSafeScrollBehavior()` has no literal,
// so it never matches. The helper module itself is exempt (it mentions the
// literal "smooth" as the non-reduced-motion return value).

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";

let passed = 0;
const ok = (msg: string) => {
  passed++;
  console.log(`  ✓ ${msg}`);
};

function literalString(node: ts.Node): string | null {
  // Unwrap transparent syntactic wrappers so `("smooth")`, `"smooth" as
  // const`, `"smooth" satisfies ScrollBehavior`, and `"smooth"!` all count.
  let n: ts.Node = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isNonNullExpression(n)
  ) {
    n = n.expression;
  }
  if (ts.isStringLiteral(n)) return n.text;
  if (ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  return null;
}

/** 1-based lines of every `behavior: "smooth"` object-literal property. */
export function findHardCodedSmoothBehaviors(source: string, fileName = "scan.tsx"): number[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node)) {
      const name =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
      if (name === "behavior" && literalString(node.initializer) === "smooth") {
        hits.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

// ── (1) Detector self-test ──────────────────────────────────────────────────
{
  assert.deepEqual(
    findHardCodedSmoothBehaviors(`el.scrollIntoView({ behavior: "smooth", block: "start" });`),
    [1],
    "must flag a plain hard-coded smooth scrollIntoView",
  );
  assert.equal(
    findHardCodedSmoothBehaviors(`window.scrollTo({ top: 0, behavior: "smooth" });`).length,
    1,
    "must flag behavior in any property position",
  );
  assert.equal(
    findHardCodedSmoothBehaviors(`el.scrollTo({ behavior: ("smooth" as const) });`).length,
    1,
    "must flag wrapped literals (parens/as const)",
  );
  assert.equal(
    findHardCodedSmoothBehaviors(`el.scrollTo({ "behavior": \`smooth\` });`).length,
    1,
    "must flag quoted property names and template literals",
  );
  assert.equal(
    findHardCodedSmoothBehaviors(
      `el.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });`,
    ).length,
    0,
    "the compliant helper call must pass",
  );
  assert.equal(
    findHardCodedSmoothBehaviors(`el.scrollIntoView({ behavior: "auto" });`).length,
    0,
    "behavior: \"auto\" must pass",
  );
  assert.equal(
    findHardCodedSmoothBehaviors(`const mode = "smooth"; log({ tone: "smooth" });`).length,
    0,
    "unrelated \"smooth\" strings must pass (only the behavior property counts)",
  );
  ok("detector self-test: flags literal behavior:\"smooth\" (wrappers/quoted keys too); helper call, auto, unrelated strings pass");
}

// ── (2) Scan the whole client source tree ───────────────────────────────────
{
  const HELPER = join("client", "src", "lib", "scrollBehavior.ts");
  const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git"]);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) files.push(p);
    }
  };
  walk(join("client", "src"));

  // Volume floor: a broken walk reporting "0 offenders in few files" would be
  // a silent skip, not a pass.
  assert.ok(files.length >= 300, `expected ≥300 client source files, scanned ${files.length}`);
  // Known swept call sites must be in the scan set (guards against walk rot).
  for (const known of [
    join("client", "src", "components", "comms", "MessagePane.tsx"),
    join("client", "src", "components", "admin", "front", "FrontPipelineHealthTab.tsx"),
    HELPER,
  ]) {
    assert.ok(files.includes(known), `known file must be in the scan set: ${known}`);
  }

  const offenders: Array<{ file: string; lines: number[] }> = [];
  for (const file of files) {
    // The helper is the single place allowed to name "smooth" — it returns it
    // when the user has NOT asked for reduced motion.
    if (file.split(sep).join("/") === "client/src/lib/scrollBehavior.ts") continue;
    const lines = findHardCodedSmoothBehaviors(readFileSync(file, "utf8"), file);
    if (lines.length > 0) offenders.push({ file, lines });
  }

  assert.deepEqual(
    offenders,
    [],
    `Hard-coded behavior: "smooth" found:\n` +
      offenders.map(o => `  ${o.file} (line ${o.lines.join(", ")})`).join("\n") +
      `\nUse motionSafeScrollBehavior() from @/lib/scrollBehavior instead so ` +
      `prefers-reduced-motion users get an instant jump.`,
  );
  ok(`no client source file hard-codes behavior: "smooth" (${files.length} files scanned)`);
}

// ── (3) The helper contract stays intact ────────────────────────────────────
{
  const helperSrc = readFileSync("client/src/lib/scrollBehavior.ts", "utf8");
  assert.ok(
    /export function motionSafeScrollBehavior\(/.test(helperSrc),
    "helper must keep exporting motionSafeScrollBehavior()",
  );
  // And the detector must recognize a literal if one were pasted elsewhere —
  // proof against detector rot: the helper's own return value is "smooth".
  assert.ok(
    findHardCodedSmoothBehaviors(`x({ behavior: "smooth" })`).length === 1,
    "detector must keep recognizing the literal shape",
  );
  ok("helper export intact; detector recognizes the canonical literal shape");
}

console.log(`\nReduced-motion smooth-scroll guard: ${passed} checks passed`);
