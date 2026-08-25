/* test-registration
{
  "name": "design-contract ratchet lints guard (Task #4347)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4347 + #4500 + #4726: guards the design-token gate policy — six frozen-count ratchets (hex colors, text-[Npx], rounded-*, z-*, sub-10px chart fontSize, bg-primary+text-white pairings) that stop the client token fork from regrowing. Pins the committed baseline artifact by self-hash + frozen authoring-time ceilings (delete-and-regen laundering protection), proves each category fails on a synthetic new violation with the token remedy, proves below-baseline counts demand a regen, proves the regen script refuses per-category total increases AND per-file increases hidden by offsetting reductions (Task #4507: absorption needs git rename evidence or an audited --audited-move reason), and that the lints have no write/flag path. Fast, DB-free, tmp-fixture based.",
  "tier": "medium"
}
test-registration */
/**
 * Task #4347 (+ #4500 chartFontSize) — guard tests for the five design-contract ratchet lints.
 *
 * Spec matrix:
 *   1. Masking + matcher semantics on a synthetic fixture: comments and regex
 *      literals never count; strings, template chunks, and nested strings
 *      inside template interpolations DO count; HTML entities, 7-digit hexes,
 *      all-digit non-repeated short hexes (#123-style refs), prose like
 *      "well-rounded", subtext-[13px], var(--z-…) tails, zIndex type
 *      annotations / non-literal values / var(--z-…) strings, and the allowed
 *      token forms (z-auto, z-[var(--z-…)], rounded-none/full/pill + side
 *      -none/-full variants, rounded-[var(--radius…)]) never count. v2
 *      definitions (Task #4425): short hexes with a hex letter or repeated
 *      digit, text-[Nrem]/text-[length:…], and inline-style zIndex literals
 *      DO count.
 *   2. The REAL repository passes all five lints against the committed
 *      baseline artifact, and the artifact itself validates (self-hash,
 *      client/src-only paths).
 *   3. Frozen authoring-time ceilings: per-category totals never exceed the
 *      2026-08-10 freeze (2761/1477/970/69) — deleting the artifact and
 *      re-bootstrapping at a higher count fails here.
 *   4. A synthetic NEW violation fails ONLY its category, naming file, line,
 *      token, and the client/src/index.css remedy.
 *   5. Below-baseline counts fail with the regen command (ratchet lock-in),
 *      including vanished files.
 *   6. Baseline integrity: hand-edited counts and hashes are rejected, merge
 *      conflict markers get the regen-on-rebase message, a missing artifact
 *      names the bootstrap command.
 *   7. Regen semantics: refuses any per-category total increase naming the
 *      offenders; refuses per-file increases hidden by offsetting reductions
 *      unless covered by git rename evidence or an audited override (Task
 *      #4507), absorbing evidenced moves with a loud warning; bootstraps a
 *      missing artifact; refuses to run from an invalid one.
 *   8. The lint sources have no fs-write APIs and no CLI flags; the env skip
 *      announces itself; every lint exports runLint/cliMain and the import
 *      is side-effect-free (this file imports all five at top level).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BASELINE_RELPATH,
  CATEGORY_IDS,
  parseBaselineJson,
  scanFileContent,
  type DesignCategoryId,
  type DesignLintResult,
  type RunDesignLintOptions,
} from "../scripts/designContractRatchet";
import { regenerateBaseline } from "../scripts/regen-design-contract-baseline";
import { cliMain as hexCliMain, runLint as runHexLint } from "../scripts/lint-design-hex-colors";
import { cliMain as textCliMain, runLint as runTextLint } from "../scripts/lint-design-text-px";
import { cliMain as roundedCliMain, runLint as runRoundedLint } from "../scripts/lint-design-rounded";
import { cliMain as zCliMain, runLint as runZLint } from "../scripts/lint-design-z-index";
import { cliMain as chartCliMain, runLint as runChartLint } from "../scripts/lint-design-chart-font-size";
import { cliMain as pwCliMain, runLint as runPrimaryWhiteLint } from "../scripts/lint-design-primary-white";

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

const RUNNERS: Record<DesignCategoryId, (opts?: RunDesignLintOptions) => DesignLintResult> = {
  hexColors: runHexLint,
  textPx: runTextLint,
  rounded: runRoundedLint,
  zIndex: runZLint,
  chartFontSize: runChartLint,
  primaryWhite: runPrimaryWhiteLint,
};

// Authoring-time freeze (2026-08-10). Totals only move DOWN from here; a
// deleted-artifact re-bootstrap at higher counts trips these ceilings.
const FROZEN_CEILINGS: Record<DesignCategoryId, number> = {
  hexColors: 2761,
  textPx: 1477,
  rounded: 970,
  zIndex: 69,
  // Task #4500: chart fontSize floor authored at ZERO — all sub-10px labels snapped.
  chartFontSize: 0,
  // Task #4726 froze the 46 remaining split-form pairings; Task #4731 swept
  // them all onto text-primary-foreground — the pairing floor is now hard ZERO.
  primaryWhite: 0,
};

function fixture(files: Record<string, string>): { root: string; rel: string[]; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "design-ratchet-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return { root, rel: Object.keys(files), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const sink = (): void => undefined;

function baselineFor(root: string, rel: string[]): string {
  const res = regenerateBaseline({ rootDir: root, files: rel, existingBaselineJson: null, log: sink, logError: sink });
  if (!res.ok || res.artifactJson === null) throw new Error("fixture baseline generation was refused");
  return res.artifactJson;
}

interface CapturedRun {
  result: DesignLintResult;
  out: string;
}

function runCategory(
  id: DesignCategoryId,
  opts: { root: string; files: string[]; baselineJson: string; skipEnv?: string },
): CapturedRun {
  const lines: string[] = [];
  const capture = (l: string): void => {
    lines.push(l);
  };
  const result = RUNNERS[id]({
    rootDir: opts.root,
    files: opts.files,
    baselineJson: opts.baselineJson,
    skipEnv: opts.skipEnv,
    log: capture,
    logError: capture,
  });
  return { result, out: lines.join("\n") };
}

console.log("1) masking + matcher semantics on the synthetic matrix fixture");
{
  const MATRIX_FIXTURE = [
    "// #ABCDEF in a line comment never counts",
    "/* block: text-[99px] z-50 rounded-lg #ABCDEF */",
    "const re = /#AABBCC|rounded-lg|z-50|text-\\[13px\\]/g;",
    "const division = width / 2;",
    'const x = 1; /* #ABCDEF */ const y = "#ABCDEF";',
    'const hexA = "#8B2E31";',
    'const hexUpper = "#FFD24A";',
    'const hex8 = "#AABBCCDD";',
    'const hex7 = "#1234567";',
    'const short3 = "#fff";',
    'const short4 = "#F0F0";',
    'const shortRep = "#000";',
    'const refs = "issue #123 or #4347 never count";',
    'const entity = "&#123456;";',
    'const jsxText = <div className="z-50">a/b</div>;',
    'const second = <span className="rounded-lg">x</span>;',
    'const tmpl = cn(`rounded-xl ${active ? "z-30" : "text-[11px]"} pad`);',
    'const px = "text-[13px] md:text-[14.5px]";',
    'const pxNo = "subtext-[13px]";',
    'const rem = "text-[1.5rem]";',
    'const remDot = "text-[.875rem]";',
    'const lenForm = "text-[length:var(--step-1)]";',
    'const vwNo = "text-[10vw]";',
    'const allowedZ = "z-[var(--z-toast)] z-auto z-(--z-nav)";',
    'const rawZ = "z-[60] -z-10 md:z-50";',
    'const varTail = "var(--z-40)";',
    'const zNegVar = "-z-[var(--z-raised)]";',
    "const styleNum = { zIndex: 60 };",
    'const styleStr = { zIndex: "55" };',
    'const styleOk = { zIndex: "var(--z-toast)" };',
    "interface ZProps { zIndex?: number }",
    "const styleExpr = { zIndex: navZ };",
    "const jsxApos = <p>Reader's z-40 note</p>;",
    'const okRound = "rounded-full rounded-none rounded-pill rounded-t-none rounded-l-full";',
    'const roundVar = "rounded-[var(--radius-pill)] rounded-(--radius-pill)";',
    'const badRound = "rounded-sm rounded-tl-lg rounded-[10px] rounded-(--spacing-2)";',
    'const prose = "a well-rounded rounded-off approach";',
    'const bare = "rounded rounded-t border";',
    'const cornerBad = "rounded-tr-2xl";',
    "// chartFontSize (Task #4500): fontSize={9} in a comment never counts",
    "const tinyJsx = <XAxis fontSize={9} />;",
    "const tinyObj = { fontSize: 8.5 };",
    "const tickObj = <YAxis tick={{ fontSize: 9, fill: c }} />;",
    "const floorOk = <XAxis fontSize={10} />;",
    "const bigObj = { fontSize: 11 };",
    "const strPx = { fontSize: \"9px\" };",
    "const remTiny = { fontSize: \"0.5rem\" };",
    "const remOk = { fontSize: \"0.75rem\" };",
    "const quotedTiny = <text fontSize=\"8\" />;",
    "const quotedOk = <text fontSize=\"12\" />;",
    "const ternary = <XAxis fontSize={dense ? 10 : 8} />;",
    "const ternaryOk = <XAxis fontSize={dense ? 12 : 10} />;",
    "const exprFs = { fontSize: tiny };",
    "// primaryWhite (Task #4726): bg-primary text-white in a comment never counts",
    'const pw = "bg-primary text-white";',
    'const pwRev = "text-white bg-primary";',
    'const pwSplit = cn("bg-primary hover:bg-primary/90", active && "text-white");',
    'const pwOpacity = "bg-primary/80 text-white/90 shadow";',
    'const pwHoverOnly = "hover:bg-primary text-white p-2";',
    'const pwDarkText = "dark:text-white bg-primary p-2";',
    'const pwToken = "bg-primary text-primary-foreground";',
    'const pwFgBg = "bg-primary-foreground text-white";',
    'const pwLineA = "bg-primary";',
    'const pwLineB = "text-white";',
    "",
  ].join("\n");
  const scan = scanFileContent(MATRIX_FIXTURE);
  assert(scan.hexColors.count === 7, `hex: exactly 7 counted (got ${scan.hexColors.count})`);
  assert(
    scan.hexColors.samples.some((s) => s.token === "#fff") &&
      scan.hexColors.samples.some((s) => s.token === "#F0F0") &&
      scan.hexColors.samples.some((s) => s.token === "#000"),
    "hex: short hexes with a letter or repeated digit counted (v2)",
  );
  assert(
    !scan.hexColors.samples.some((s) => s.token === "#123" || s.token === "#4347"),
    "hex: all-digit non-repeated short forms (issue refs) NOT counted",
  );
  assert(
    scan.hexColors.samples.some((s) => s.token === "#8B2E31" && s.line === 6),
    "hex: sample carries token + 1-based line number",
  );
  assert(
    scan.hexColors.samples.some((s) => s.token === "#AABBCCDD"),
    "hex: 8-digit #RRGGBBAA form counted",
  );
  assert(scan.textPx.count === 6, `textPx: exactly 6 counted (got ${scan.textPx.count})`);
  assert(
    scan.textPx.samples.some((s) => s.token === "text-[1.5rem]") &&
      scan.textPx.samples.some((s) => s.token === "text-[.875rem]") &&
      scan.textPx.samples.some((s) => s.token === "text-[length:var(--step-1)]"),
    "textPx: rem + length: arbitrary forms counted (v2)",
  );
  assert(
    !scan.textPx.samples.some((s) => s.token.includes("10vw")),
    "textPx: non-size text-[10vw] arbitrary value NOT counted",
  );
  assert(scan.rounded.count === 7, `rounded: exactly 7 counted (got ${scan.rounded.count})`);
  assert(scan.chartFontSize.count === 7, `chartFontSize: exactly 7 sub-floor sites counted (got ${scan.chartFontSize.count})`);
  assert(
    scan.chartFontSize.samples.some((s) => s.token.includes("fontSize={9}")) &&
      scan.chartFontSize.samples.some((s) => s.token.includes("fontSize: 8.5")) &&
      scan.chartFontSize.samples.some((s) => s.token.trim() === "fontSize: 9"),
    "chartFontSize: JSX prop, object literal, and nested tick object forms counted",
  );
  assert(
    scan.chartFontSize.samples.some((s) => s.token.includes('fontSize="8"')) &&
      scan.chartFontSize.samples.some((s) => s.token.includes("? 10 : 8")) &&
      scan.chartFontSize.samples.some((s) => s.token.includes('"9px"')) &&
      scan.chartFontSize.samples.some((s) => s.token.includes('"0.5rem"')),
    "chartFontSize: quoted-numeric, ternary-branch, px-string, and rem-string evasion forms counted",
  );
  assert(
    !scan.chartFontSize.samples.some(
      (s) =>
        s.token.includes("fontSize={10}") ||
        s.token.includes("fontSize: 11") ||
        s.token.includes('"12"') ||
        s.token.includes("0.75rem") ||
        s.token.includes("? 12 : 10") ||
        s.token.includes("tiny"),
    ),
    "chartFontSize: at/above-floor values (incl. all-branches-ok ternaries, rem >= floor) and non-literal expressions NOT counted",
  );
  assert(
    scan.rounded.samples.some((s) => s.token === "rounded-(--spacing-2)"),
    "rounded: non-radius Tailwind v4 var shorthand counted",
  );
  assert(scan.zIndex.count === 9, `zIndex: exactly 9 counted (got ${scan.zIndex.count})`);
  assert(
    scan.zIndex.samples.some((s) => s.token === "zIndex: 60") &&
      scan.zIndex.samples.some((s) => s.token === 'zIndex: "55"'),
    "zIndex: inline-style numeric + string literals counted (v2)",
  );
  assert(
    !scan.zIndex.samples.some(
      (s) => s.token.includes("var(--z-toast)") || s.token.includes("navZ") || s.token.includes("number"),
    ),
    "zIndex: inline var(--z-…), non-literal values, and type annotations NOT counted",
  );
  assert(
    scan.zIndex.samples.some((s) => s.token === "-z-[var(--z-raised)]"),
    "zIndex: negative var reference counted (off-scale)",
  );
  assert(
    scan.primaryWhite.count === 4,
    `primaryWhite: exactly 4 same-line pairings counted (got ${scan.primaryWhite.count})`,
  );
  assert(
    scan.primaryWhite.samples.some((s) => s.token.includes('const pw = "bg-primary text-white"')) &&
      scan.primaryWhite.samples.some((s) => s.token.includes("text-white bg-primary")) &&
      scan.primaryWhite.samples.some((s) => s.token.includes("pwSplit")) &&
      scan.primaryWhite.samples.some((s) => s.token.includes("bg-primary/80 text-white/90")),
    "primaryWhite: adjacent, reversed, split-across-strings, and opacity-suffixed pairings counted",
  );
  assert(
    !scan.primaryWhite.samples.some(
      (s) =>
        s.token.includes("pwHoverOnly") ||
        s.token.includes("pwDarkText") ||
        s.token.includes("pwToken") ||
        s.token.includes("pwFgBg") ||
        s.token.includes("pwLine"),
    ),
    "primaryWhite: variant-prefixed forms, the token pair, bg-primary-foreground, and cross-line tokens NOT counted",
  );
  const reportScan = scanFileContent(
    'const deck = <div className="report-surface">…</div>;\nconst chip = "bg-primary text-white";\n',
  );
  assert(
    reportScan.primaryWhite.count === 0,
    "primaryWhite: files carrying the report-surface marker class are exempt (pinned-light report deck)",
  );
  const commentOnlyScan = scanFileContent(
    '// styled like the .report-surface deck\nconst chip = "bg-primary text-white";\n',
  );
  assert(
    commentOnlyScan.primaryWhite.count === 1,
    "primaryWhite: a report-surface mention in a COMMENT does not exempt the file (masked-source predicate)",
  );
  assert(
    !scan.zIndex.samples.some((s) => s.token.includes("z-[var(--z-toast)]")),
    "zIndex: positive z-[var(--z-…)] reference NOT counted",
  );
}

console.log("2) REAL repository passes all five lints against the committed artifact");
{
  for (const id of CATEGORY_IDS) {
    const lines: string[] = [];
    const capture = (l: string): void => {
      lines.push(l);
    };
    const res = RUNNERS[id]({ log: capture, logError: capture });
    assert(
      res.exitCode === 0 && !res.skipped,
      `${id}: real client tree passes (exit ${res.exitCode}, ${res.actualTotal} occurrences in ${res.scannedFiles} files)`,
    );
    assert(res.scannedFiles > 400, `${id}: discovery found the client tree (${res.scannedFiles} files)`);
    assert(
      lines.join("\n").includes("match the frozen baseline"),
      `${id}: pass output names the frozen baseline + ratchet direction`,
    );
    assert(
      res.actualTotal <= FROZEN_CEILINGS[id] && res.baselineTotal <= FROZEN_CEILINGS[id],
      `${id}: totals within the authoring-time ceiling ${FROZEN_CEILINGS[id]} (actual ${res.actualTotal}, baseline ${res.baselineTotal})`,
    );
    if (id === "chartFontSize") {
      assert(res.baselineTotal === 0, `chartFontSize: baseline stays ZERO — the 10px floor is hard (${res.baselineTotal})`);
    } else if (id === "primaryWhite") {
      // Task #4731 swept the last 46 pairings — the baseline stays ZERO.
      assert(res.baselineTotal === 0, `primaryWhite: baseline stays ZERO — pairing sweep complete (${res.baselineTotal})`);
    } else {
      assert(res.baselineTotal > 0, `${id}: committed baseline is non-degenerate (${res.baselineTotal})`);
    }
  }
}

console.log("3) committed artifact validates (self-hash, scope)");
{
  const raw = readFileSync(BASELINE_RELPATH, "utf8");
  const parsed = parseBaselineJson(raw);
  assert(parsed.ok, `committed ${BASELINE_RELPATH} parses + self-hash matches (${parsed.error ?? "ok"})`);
  if (parsed.ok && parsed.baseline) {
    const allFiles = CATEGORY_IDS.flatMap((id) => Object.keys(parsed.baseline!.categories[id].files));
    assert(
      allFiles.length > 0 && allFiles.every((f) => f.startsWith("client/src/")),
      "every baseline path is inside client/src/",
    );
    assert(parsed.baseline.version === 4, "artifact version is 4 (Task #4726 added primaryWhite)");
  }
}

console.log("4) a synthetic NEW violation fails ONLY its category, with remedy + location");
{
  const cleanFiles = {
    "client/src/pages/DemoA.tsx": 'export const palette = { primary: "var(--color-primary)" };\n',
    "client/src/pages/DemoB.tsx": 'const cls = "text-body rounded-none z-[var(--z-nav)]";\n',
  };
  const { root, rel, cleanup } = fixture(cleanFiles);
  try {
    const baselineJson = baselineFor(root, rel);
    // Clean tree passes every category.
    for (const id of CATEGORY_IDS) {
      const { result } = runCategory(id, { root, files: rel, baselineJson });
      assert(result.exitCode === 0, `${id}: clean fixture tree passes`);
    }
    // Introduce a brand-new file with one hex color.
    writeFileSync(
      join(root, "client/src/pages/DemoC.tsx"),
      '// new component\nconst accent = "#ABCDEF";\n',
    );
    const withNew = [...rel, "client/src/pages/DemoC.tsx"];
    const hex = runCategory("hexColors", { root, files: withNew, baselineJson });
    assert(hex.result.exitCode === 1, "hexColors: new file with a hex fails");
    assert(
      hex.result.newViolations.length === 1 &&
        hex.result.newViolations[0].file === "client/src/pages/DemoC.tsx" &&
        hex.result.newViolations[0].baseline === 0 &&
        hex.result.newViolations[0].actual === 1,
      "hexColors: violation entry names the new file with baseline 0 → 1",
    );
    assert(hex.out.includes("L2: #ABCDEF"), "hexColors: output pinpoints line + token");
    assert(hex.out.includes("client/src/index.css"), "hexColors: output names the token remedy in index.css");
    assert(
      hex.out.includes("regen script refuses count increases"),
      "hexColors: output says the baseline cannot absorb increases",
    );
    for (const id of CATEGORY_IDS.filter((c) => c !== "hexColors")) {
      const { result } = runCategory(id, { root, files: withNew, baselineJson });
      assert(result.exitCode === 0, `${id}: unaffected category still passes with the new file present`);
    }
    // Increase INSIDE an existing file trips the per-file two-sided compare.
    writeFileSync(
      join(root, "client/src/pages/DemoB.tsx"),
      'const cls = "text-body rounded-none z-[var(--z-nav)]";\nconst extra = "text-[17px]";\n',
    );
    const text = runCategory("textPx", { root, files: withNew, baselineJson });
    assert(
      text.result.exitCode === 1 && text.result.newViolations.length === 1,
      "textPx: count increase inside an existing file fails",
    );
  } finally {
    cleanup();
  }
}

console.log("5) below-baseline counts fail with the regen command (lock-in)");
{
  const files = {
    "client/src/pages/Sweep.tsx": 'const a = "#111111";\nconst b = "#222222";\n',
    "client/src/pages/Gone.tsx": 'const c = "#333333";\n',
  };
  const { root, rel, cleanup } = fixture(files);
  try {
    const baselineJson = baselineFor(root, rel);
    // Sweep removes one hex and deletes the other file entirely.
    writeFileSync(join(root, "client/src/pages/Sweep.tsx"), 'const a = "#111111";\n');
    rmSync(join(root, "client/src/pages/Gone.tsx"));
    const res = runCategory("hexColors", { root, files: rel, baselineJson });
    assert(res.result.exitCode === 1, "hexColors: below-baseline counts fail until locked in");
    assert(res.result.newViolations.length === 0, "hexColors: reductions produce no new-violation entries");
    assert(
      res.result.staleEntries.length === 2 &&
        res.result.staleEntries.some((s) => s.file === "client/src/pages/Gone.tsx" && s.actual === 0),
      "hexColors: both the reduced file and the vanished file are reported stale",
    );
    assert(
      res.out.includes("npx tsx scripts/regen-design-contract-baseline.ts"),
      "hexColors: stale output names the regen command",
    );
    assert(res.out.includes("regen on the rebased tree"), "hexColors: stale output documents regen-on-rebase");
  } finally {
    cleanup();
  }
}

console.log("6) baseline integrity: hand edits, conflict markers, missing artifact");
{
  const files = { "client/src/pages/One.tsx": 'const a = "#111111";\n' };
  const { root, rel, cleanup } = fixture(files);
  try {
    const valid = baselineFor(root, rel);

    const tamperedHash = valid.replace(/"sha256": "[0-9a-f]{8}/, '"sha256": "00000000');
    const hashRes = runCategory("hexColors", { root, files: rel, baselineJson: tamperedHash });
    assert(
      hashRes.result.exitCode === 1 &&
        (hashRes.result.integrityError ?? "").includes("hand-edited"),
      "tampered sha256 is rejected as a hand edit",
    );

    const obj = JSON.parse(valid) as {
      categories: Record<string, { total: number; files: Record<string, number> }>;
    };
    obj.categories.hexColors.files["client/src/pages/One.tsx"] = 5; // total left at 1
    const countRes = runCategory("hexColors", {
      root,
      files: rel,
      baselineJson: JSON.stringify(obj),
    });
    assert(
      countRes.result.exitCode === 1 && (countRes.result.integrityError ?? "").includes("hand-edited"),
      "tampered per-file count (total mismatch) is rejected as a hand edit",
    );

    const conflicted = "<<<<<<< ours\n" + valid;
    const conflictRes = runCategory("hexColors", { root, files: rel, baselineJson: conflicted });
    assert(
      conflictRes.result.exitCode === 1 &&
        (conflictRes.result.integrityError ?? "").includes("merge conflict markers"),
      "conflict markers are detected before JSON parsing",
    );
    assert(
      (conflictRes.result.integrityError ?? "").includes("regen on the rebased tree"),
      "conflict-marker error documents the regen-on-rebase resolution",
    );

    const missingLines: string[] = [];
    const missing = RUNNERS.hexColors({
      rootDir: root,
      files: rel,
      log: (l: string) => {
        missingLines.push(l);
      },
      logError: (l: string) => {
        missingLines.push(l);
      },
    });
    assert(
      missing.exitCode === 1 && (missing.integrityError ?? "").includes("bootstrap it with"),
      "missing artifact fails and names the bootstrap command",
    );
  } finally {
    cleanup();
  }
}

console.log("7) regen semantics: refuse increases + unevidenced offsets, absorb evidenced moves, bootstrap, invalid existing");
{
  const files = {
    "client/src/pages/A.tsx": 'const a = "#111111";\nconst b = "#222222";\n',
  };
  const { root, rel, cleanup } = fixture(files);
  try {
    const baselineJson = baselineFor(root, rel);

    // Increase: a second file appears with a fresh hex → per-category total rises.
    writeFileSync(join(root, "client/src/pages/B.tsx"), 'const c = "#333333";\n');
    const withB = [...rel, "client/src/pages/B.tsx"];
    const refuse = regenerateBaseline({
      rootDir: root,
      files: withB,
      existingBaselineJson: baselineJson,
      log: sink,
      logError: sink,
    });
    assert(!refuse.ok && refuse.artifactJson === null, "regen refuses a per-category total increase");
    assert(
      refuse.refusals.some(
        (r) => r.includes("lint-design-hex-colors") && r.includes("RISE") && r.includes("client/src/pages/B.tsx"),
      ),
      "refusal names the category and the offending file",
    );

    // Offset increase WITHOUT move evidence: A drops to one hex, B keeps one
    // → total stays 2, but B's +1 is a brand-new break hidden by the
    // reduction. Task #4507: regen REFUSES without rename/audit evidence.
    writeFileSync(join(root, "client/src/pages/A.tsx"), 'const a = "#111111";\n');
    const hidden = regenerateBaseline({
      rootDir: root,
      files: withB,
      existingBaselineJson: baselineJson,
      renamePairs: [],
      log: sink,
      logError: sink,
    });
    assert(
      !hidden.ok && hidden.artifactJson === null,
      "offset per-file increase without move evidence is REFUSED (Task #4507)",
    );
    assert(
      hidden.refusals.some(
        (r) =>
          r.includes("client/src/pages/B.tsx") &&
          r.includes("no move evidence") &&
          r.includes("--audited-move") &&
          r.includes("git add -A"),
      ),
      "refusal names the file and both evidence remedies (git rename / audited override)",
    );

    // Rename evidence that does NOT cover the increase is also refused:
    // the claimed source never held a hex in the baseline.
    writeFileSync(join(root, "client/src/pages/Empty.tsx"), "export {};\n");
    const badPair = regenerateBaseline({
      rootDir: root,
      files: [...withB, "client/src/pages/Empty.tsx"],
      existingBaselineJson: baselineJson,
      renamePairs: [{ from: "client/src/pages/Empty.tsx", to: "client/src/pages/B.tsx" }],
      log: sink,
      logError: sink,
    });
    assert(
      !badPair.ok && badPair.refusals.some((r) => r.includes("client/src/pages/B.tsx")),
      "rename evidence whose source count does not cover the increase is refused",
    );

    // Count-conserving move WITH git rename evidence: A → B is absorbed.
    const move = regenerateBaseline({
      rootDir: root,
      files: withB,
      existingBaselineJson: baselineJson,
      renamePairs: [{ from: "client/src/pages/A.tsx", to: "client/src/pages/B.tsx" }],
      log: sink,
      logError: sink,
    });
    assert(move.ok && move.artifactJson !== null, "count-conserving move with rename evidence regenerates");
    assert(
      move.moveWarnings.some(
        (w) => w.includes("client/src/pages/B.tsx") && w.includes("count-conserving move") && w.includes("A.tsx"),
      ),
      "the absorbed move warns loudly, naming the rename pair",
    );
    assert(
      move.totals.hexColors === 2 && move.prevTotals?.hexColors === 2,
      "totals are conserved across the move",
    );

    // Audited override: no rename evidence, but an explicit reason absorbs
    // the increase and logs it loudly.
    const audited = regenerateBaseline({
      rootDir: root,
      files: withB,
      existingBaselineJson: baselineJson,
      renamePairs: [],
      auditedMoveReason: "hex intentionally relocated for the demo split",
      log: sink,
      logError: sink,
    });
    assert(audited.ok && audited.artifactJson !== null, "audited override absorbs the offset increase");
    assert(
      audited.moveWarnings.some(
        (w) => w.includes("AUDITED override") && w.includes("hex intentionally relocated"),
      ),
      "audited absorption logs the reason verbatim",
    );

    // Pure reduction: no warnings, artifact regenerates.
    rmSync(join(root, "client/src/pages/B.tsx"));
    const reduce = regenerateBaseline({
      rootDir: root,
      files: rel,
      existingBaselineJson: baselineJson,
      log: sink,
      logError: sink,
    });
    assert(
      reduce.ok && reduce.moveWarnings.length === 0 && reduce.totals.hexColors === 1,
      "pure reduction regenerates without warnings",
    );

    // Bootstrap: no existing artifact.
    const boot = regenerateBaseline({
      rootDir: root,
      files: rel,
      existingBaselineJson: null,
      log: sink,
      logError: sink,
    });
    assert(boot.ok && boot.bootstrap, "bootstrap mode freezes the current tree");

    // Invalid existing artifact: refuse with restore guidance.
    const invalid = regenerateBaseline({
      rootDir: root,
      files: rel,
      existingBaselineJson: "not json at all",
      log: sink,
      logError: sink,
    });
    assert(
      !invalid.ok && invalid.refusals.some((r) => r.includes("invalid")),
      "regen refuses to run from an invalid existing artifact",
    );

    // Regenerated fixture artifact validates round-trip.
    const roundTrip = parseBaselineJson(move.artifactJson!);
    assert(roundTrip.ok, "regenerated artifact parses + self-hash matches");
  } finally {
    cleanup();
  }
}

console.log("7b) definition migration: older-version artifact — lints refuse, regen re-freezes (increases allowed once)");
{
  const files = { "client/src/pages/Mig.tsx": 'const a = "#111111";\n' };
  const { root, rel, cleanup } = fixture(files);
  try {
    const v2 = baselineFor(root, rel);
    const v1obj = JSON.parse(v2) as { version: number };
    v1obj.version = 1;
    const v1json = JSON.stringify(v1obj);

    // The lints refuse to compare against a stale-version artifact.
    const stale = runCategory("hexColors", { root, files: rel, baselineJson: v1json });
    assert(
      stale.result.exitCode === 1 &&
        (stale.result.integrityError ?? "").includes("predates the current scanner definitions"),
      "lint refuses an older-version artifact and names the regen command",
    );
    assert(stale.out.includes("regen-design-contract-baseline"), "stale-version error names the regen script");

    // Regen from a v1 artifact is a one-time migration: a total increase is permitted.
    writeFileSync(join(root, "client/src/pages/Mig.tsx"), 'const a = "#111111";\nconst b = "#fff";\n');
    const migLines: string[] = [];
    const mig = regenerateBaseline({
      rootDir: root,
      files: rel,
      existingBaselineJson: v1json,
      log: (l: string) => {
        migLines.push(l);
      },
      logError: (l: string) => {
        migLines.push(l);
      },
    });
    assert(mig.ok && mig.artifactJson !== null, "regen migrates an older-version artifact despite the total increase");
    assert(
      migLines.join("\n").includes("definition migration") && mig.totals.hexColors === 2,
      "migration announces itself loudly and re-freezes the new counts",
    );
    const migParsed = parseBaselineJson(mig.artifactJson!);
    assert(
      migParsed.ok && migParsed.baseline?.version === 4,
      "migrated artifact carries the current version and validates",
    );

    // A same-version artifact still refuses increases (migration is not a loophole).
    const refuse = regenerateBaseline({
      rootDir: root,
      files: rel,
      existingBaselineJson: v2,
      log: sink,
      logError: sink,
    });
    assert(!refuse.ok, "same-version regen still refuses the total increase");

    // Unsupported future versions are rejected outright.
    const v9obj = JSON.parse(v2) as { version: number };
    v9obj.version = 9;
    const v9 = runCategory("hexColors", { root, files: rel, baselineJson: JSON.stringify(v9obj) });
    assert(
      v9.result.exitCode === 1 && (v9.result.integrityError ?? "").includes("unsupported baseline version"),
      "unknown future version is rejected",
    );
  } finally {
    cleanup();
  }
}

console.log("8) wiring lockstep: gate, Validate workflow, TASK_SELFCHECK");
{
  const gateSrc = readFileSync("scripts/gate.ts", "utf8");
  const driftSrc = readFileSync("scripts/lint-gate-workflow-drift.ts", "utf8");
  const selfcheck = readFileSync("TASK_SELFCHECK.md", "utf8");
  const NAMES = [
    "lint-design-hex-colors",
    "lint-design-text-px",
    "lint-design-rounded",
    "lint-design-z-index",
    "lint-design-chart-font-size",
    "lint-design-primary-white",
  ];
  for (const name of NAMES) {
    assert(
      gateSrc.includes(`{ name: "${name}", script: "scripts/${name}.ts" }`),
      `gate.ts registers ${name} in LINT_CHECKS`,
    );
    assert(selfcheck.includes(`scripts/${name}.ts`), `TASK_SELFCHECK.md documents ${name}`);
  }
  assert(
    /export const VALIDATION_WORKFLOW\s*=\s*\{[\s\S]*?command:\s*"npm run gate"/.test(driftSrc),
    "lint-gate-workflow-drift.ts defines VALIDATION_WORKFLOW with command npm run gate",
  );
}

console.log("9) no write/flag path in the lint sources");
{
  const sources = [
    "scripts/designContractRatchet.ts",
    "scripts/lint-design-hex-colors.ts",
    "scripts/lint-design-text-px.ts",
    "scripts/lint-design-rounded.ts",
    "scripts/lint-design-z-index.ts",
    "scripts/lint-design-chart-font-size.ts",
    "scripts/lint-design-primary-white.ts",
  ];
  for (const p of sources) {
    const src = readFileSync(p, "utf8");
    assert(
      !/\b(writeFileSync|appendFileSync|createWriteStream|writeFile|rmSync|renameSync)\s*\(/.test(src),
      `${p} calls no fs-write APIs`,
    );
    assert(
      !/argv\.slice|argv\.includes|parseArgs|of process\.argv/.test(src),
      `${p} parses no CLI flags (no --update-style regen path)`,
    );
  }
}

console.log("10) env skip announces itself; exports present");
{
  const lines: string[] = [];
  const res = RUNNERS.hexColors({
    skipEnv: "1",
    log: (l: string) => {
      lines.push(l);
    },
    logError: (l: string) => {
      lines.push(l);
    },
  });
  assert(res.exitCode === 0 && res.skipped, "skipEnv=1 reports skipped:true with exit 0");
  assert(
    lines.join("\n").includes("SKIPPED via LINT_DESIGN_CONTRACT_SKIP=1"),
    "the skip announces the env var by name",
  );

  assert(CATEGORY_IDS.length === 6, "exactly six ratchet categories");
  const cliMains = [hexCliMain, textCliMain, roundedCliMain, zCliMain, chartCliMain, pwCliMain];
  assert(
    cliMains.every((fn) => typeof fn === "function"),
    "every lint exports cliMain (gate in-process contract); top-level import ran without side effects",
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
