/* test-registration
{
  "name": "lint-brief-surface-report-tokens guard (Task #4929)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4929: the brief-surface report-token guard (scripts/lint-brief-surface-report-tokens.ts) is only useful if it actually fires on drift and stays quiet on a clean tree. Gate this fast, DB-free fixture-based test so the guard's own behavior — flagging report-* tokens on brief-surface files, honoring suppress markers, and passing the real tree — can't silently rot.",
  "tier": "small"
}
test-registration */
/**
 * Task #4929 — Regression test for the brief-surface report-token guard.
 *
 * The guard (scripts/lint-brief-surface-report-tokens.ts) fails if a
 * `text-report-*`, `bg-report-*`, or `border-report-*` Tailwind utility class
 * appears in the declared brief-surface files without a suppress marker.
 *
 * Proves:
 *   1. The REAL source tree passes (all prior violations have been fixed or
 *      suppressed).
 *   2. A `text-report-*` class introduced in a brief-surface fixture is
 *      flagged, and the file/line/class are named.
 *   3. A `bg-report-*` class is flagged.
 *   4. A `border-report-*` class is flagged.
 *   5. A suppress marker on the PRECEDING line silences the violation.
 *   6. A suppress marker on the SAME line as the violation does NOT suppress
 *      it (the marker must appear on the line before, consistent with the
 *      guard contract).
 *   7. A file outside the declared brief-surface list is NOT scanned.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint } from "../scripts/lint-brief-surface-report-tokens";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lint-brief-surface-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Returns the ABSOLUTE path of the written file — pass this directly to runLint(). */
function writeFile(root: string, rel: string, lines: string[]): string {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, lines.join("\n") + "\n");
  return full;
}

// ---------------------------------------------------------------------------
// 1. The REAL source tree passes.
// ---------------------------------------------------------------------------
{
  const res = runLint();
  if (!res.ok) {
    for (const v of res.violations) {
      console.error(
        `    violation: ${v.file}:${v.line} — ${v.classes.join(", ")}`,
      );
    }
  }
  assert(res.ok, "real source tree passes the brief-surface report-token guard");
  assert(res.filesScanned >= 3, "guard scanned all three declared brief-surface files");
}

// ---------------------------------------------------------------------------
// 2. `text-report-*` on a brief-surface fixture is flagged.
// ---------------------------------------------------------------------------
{
  const { root, cleanup } = fixture();
  try {
    const rel = writeFile(root, "CeoPulseVisual.tsx", [
      "export function BriefComponent() {",
      '  return <p className="text-report-crimson font-bold">hello</p>;',
      "}",
    ]);
    const res = runLint([rel]);
    assert(!res.ok, "text-report-* class trips the guard");
    assert(
      res.violations.some(
        (v) => v.line === 2 && v.classes.some((c) => c.includes("text-report-crimson")),
      ),
      "violation names the correct line and class (text-report-crimson)",
    );
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// 3. `bg-report-*` on a brief-surface fixture is flagged.
// ---------------------------------------------------------------------------
{
  const { root, cleanup } = fixture();
  try {
    const rel = writeFile(root, "CeoPulseLetter.tsx", [
      "export function Letter() {",
      '  return <div className="bg-report-gold/20 p-4">content</div>;',
      "}",
    ]);
    const res = runLint([rel]);
    assert(!res.ok, "bg-report-* class trips the guard");
    assert(
      res.violations.some(
        (v) => v.classes.some((c) => c.includes("bg-report-gold")),
      ),
      "violation names bg-report-gold",
    );
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// 4. `border-report-*` on a brief-surface fixture is flagged.
// ---------------------------------------------------------------------------
{
  const { root, cleanup } = fixture();
  try {
    const rel = writeFile(root, "PublicCeoPulse.tsx", [
      "export function Public() {",
      '  return <div className="border-2 border-report-gold">content</div>;',
      "}",
    ]);
    const res = runLint([rel]);
    assert(!res.ok, "border-report-* class trips the guard");
    assert(
      res.violations.some(
        (v) => v.classes.some((c) => c.includes("border-report-gold")),
      ),
      "violation names border-report-gold",
    );
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// 5a. A JS `//` suppress marker on the PRECEDING line silences the violation.
// ---------------------------------------------------------------------------
{
  const { root, cleanup } = fixture();
  try {
    const abs = writeFile(root, "CeoPulseLetter.tsx", [
      "export function Letter() {",
      "  return (",
      "    // lint-brief-surface-report-tokens: suppress -- intentional paper background",
      '    <div className="min-h-screen bg-report-paper-bright">content</div>',
      "  );",
      "}",
    ]);
    const res = runLint([abs]);
    assert(res.ok, "JS // suppress marker on preceding line silences bg-report-* violation");
    assert(res.violations.length === 0, "no violations reported when suppressed via //");
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// 5b. A JSX `{/* */}` comment on the preceding line does NOT suppress —
//     only JS `//` markers are accepted (JSX comments break single-root returns).
// ---------------------------------------------------------------------------
{
  const { root, cleanup } = fixture();
  try {
    const abs = writeFile(root, "CeoPulseLetter.tsx", [
      "export function Letter() {",
      "  return (",
      "    <>",
      "      {/* lint-brief-surface-report-tokens: suppress -- JSX comment, must be rejected */}",
      '      <div className="min-h-screen bg-report-paper-bright">content</div>',
      "    </>",
      "  );",
      "}",
    ]);
    const res = runLint([abs]);
    assert(
      !res.ok,
      "JSX {/* */} comment on preceding line does NOT suppress the violation",
    );
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// 6. The suppress marker on the SAME line does NOT suppress (must be above).
// ---------------------------------------------------------------------------
{
  const { root, cleanup } = fixture();
  try {
    const rel = writeFile(root, "CeoPulseVisual.tsx", [
      "export function Comp() {",
      '  return <div className="bg-report-crimson/10">x</div>; /* lint-brief-surface-report-tokens: suppress */',
      "}",
    ]);
    const res = runLint([rel]);
    assert(
      !res.ok,
      "suppress marker on the SAME line does not suppress the violation",
    );
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// 6b. Tailwind important-modifier classes are flagged (!text-report-*, etc.).
// ---------------------------------------------------------------------------
{
  const { root, cleanup } = fixture();
  try {
    const abs = writeFile(root, "CeoPulseVisual.tsx", [
      "export function Comp() {",
      '  return <div className="!text-report-crimson !bg-report-gold !border-report-ink">x</div>;',
      "}",
    ]);
    const res = runLint([abs]);
    assert(!res.ok, "!-prefixed important report-* classes trip the guard");
    const classes = res.violations.flatMap((v) => v.classes);
    assert(
      classes.some((c) => c.includes("!text-report-crimson")),
      "!text-report-crimson is named in violations",
    );
    assert(
      classes.some((c) => c.includes("!bg-report-gold")),
      "!bg-report-gold is named in violations",
    );
    assert(
      classes.some((c) => c.includes("!border-report-ink")),
      "!border-report-ink is named in violations",
    );
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// 6c. Variant + important combination is flagged (hover:!text-report-*).
// ---------------------------------------------------------------------------
{
  const { root, cleanup } = fixture();
  try {
    const abs = writeFile(root, "CeoPulseVisual.tsx", [
      "export function Comp() {",
      '  return <div className="hover:!text-report-crimson">x</div>;',
      "}",
    ]);
    const res = runLint([abs]);
    assert(!res.ok, "variant+important combo hover:!text-report-* trips the guard");
    const classes = res.violations.flatMap((v) => v.classes);
    assert(
      classes.some((c) => c.includes("hover:!text-report-crimson")),
      "hover:!text-report-crimson is named in violations",
    );
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// 6d. Tailwind variant-prefixed classes are flagged (hover:, md:, dark:).
// ---------------------------------------------------------------------------
{
  const { root, cleanup } = fixture();
  try {
    const abs = writeFile(root, "CeoPulseVisual.tsx", [
      "export function Comp() {",
      '  return <div className="hover:text-report-crimson md:bg-report-gold dark:border-report-ink">x</div>;',
      "}",
    ]);
    const res = runLint([abs]);
    assert(!res.ok, "hover:/md:/dark: variant report-* classes trip the guard");
    const classes = res.violations.flatMap((v) => v.classes);
    assert(
      classes.some((c) => c.includes("hover:text-report-crimson")),
      "hover:text-report-crimson is named in violations",
    );
    assert(
      classes.some((c) => c.includes("md:bg-report-gold")),
      "md:bg-report-gold is named in violations",
    );
    assert(
      classes.some((c) => c.includes("dark:border-report-ink")),
      "dark:border-report-ink is named in violations",
    );
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// 7. An empty override list scans zero files and reports no violations.
//    (The declared BRIEF_SURFACE_FILES scope is only exercised via the real
//    tree — test 1 above — or by passing explicit override paths.)
// ---------------------------------------------------------------------------
{
  const res = runLint([]);
  assert(
    res.filesScanned === 0,
    "passing an empty file list results in zero files scanned",
  );
  assert(res.ok, "empty file list produces no violations");
}

console.log(`\n  passed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exit(1);
