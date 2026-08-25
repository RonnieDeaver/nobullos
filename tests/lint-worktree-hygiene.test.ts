/* test-registration
{
  "name": "lint-worktree-hygiene guard (Task #3794, absorbs #3790 root-junk)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3794: guards the deny-by-default worktree hygiene gate (junk patterns tree-wide, root-entry allow-list, .gitignore portability) over pure fs fixtures — fast and DB-free. A regression silently lets task environments and the publish image re-accumulate junk; the fs-based subject is invisible to import tracing, so the tests/lint-* name keeps it in the always-run core.",
  "tier": "small"
}
test-registration */
/**
 * Task #3794 — Regression test for the worktree-hygiene guard
 * (scripts/lint-worktree-hygiene.ts, which absorbs Task #3790's
 * lint-root-junk).
 *
 * Proves:
 *   1. A fixture full of the exact debris classes Task #3790 removed
 *      (merge .bak dumps, *_block.txt scratch, nohup.out, tmp_* files,
 *      one-off .html/.log dumps) is flagged — at the root AND nested —
 *      plus unregistered root files, an unregistered top-level directory,
 *      and missing scratch-zone .gitignore lines.
 *   2. Root-only patterns (*.log, *.html) do NOT flag nested files.
 *   3. A clean fixture (allow-listed files/dirs, tsconfig variants,
 *      portable .gitignore) passes; junk dotfiles are still caught.
 *   4. Tracked vs untracked junk get distinct remediations; the baseline
 *      convention grandfathers tracked leftovers.
 *   5. Junk that is git-IGNORED but on disk is flagged (it still bloats
 *      task environments and the publish image).
 *   6. The REAL repository worktree is clean — the assertion that keeps
 *      the #3790 cleanup from regressing and proves the gate self-clean
 *      (clean-scratch) + this lint agree on what "clean" means.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint } from "../scripts/lint-worktree-hygiene";

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
  const root = mkdtempSync(join(tmpdir(), "lint-worktree-hygiene-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const PORTABLE_GITIGNORE = "node_modules\n.local/\ntmp/\n";

// 1. Every debris class + root-entry violations + .gitignore portability.
{
  const { root, cleanup } = fixture();
  try {
    const rootJunk = [
      "ClickUpModule.head.bak",
      "patchwork.orig",
      "patchwork.rej",
      "notes.ts~",
      "nohup.out",
      "tmp_parsecheck.mjs",
      "chat_block.txt",
      "web_api.html",
      "server.log",
      ".DS_Store",
    ];
    for (const f of rootJunk) writeFileSync(join(root, f), "x\n");
    // unregistered root-level files (deny-by-default)
    for (const f of ["validate_final.ts", "pipeline_export.json", "brand_shot.png"]) {
      writeFileSync(join(root, f), "x\n");
    }
    // unregistered top-level directory with nested junk + nested html
    mkdirSync(join(root, "junkdir"));
    writeFileSync(join(root, "junkdir", "deep.bak"), "x\n");
    writeFileSync(join(root, "junkdir", "page.html"), "x\n");
    // registered dir with a clean file; legit root neighbors
    mkdirSync(join(root, "client"));
    writeFileSync(join(root, "client", "index.ts"), "x\n");
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "RUNBOOK_SAMPLE.md"), "# md exempt\n");
    // .gitignore present but missing BOTH required scratch-zone lines
    writeFileSync(join(root, ".gitignore"), "node_modules\n");

    const res = runLint(root);
    const flagged = new Map(res.offenders.map((o) => [o.file, o.reason]));

    assert(!res.ok, "fixture with debris fails the lint");
    for (const f of rootJunk) assert(flagged.has(f), `flagged root junk: ${f}`);
    assert(flagged.has("junkdir/deep.bak"), "nested junk (junkdir/deep.bak) flagged");
    assert(!flagged.has("junkdir/page.html"), "nested .html NOT flagged (root-only pattern)");
    assert(flagged.has("junkdir/"), "unregistered top-level directory flagged");
    for (const f of ["validate_final.ts", "pipeline_export.json", "brand_shot.png"]) {
      assert(flagged.has(f), `unregistered root file flagged: ${f}`);
    }
    assert(
      res.offenders.filter((o) => o.reason.includes("missing required ignore line")).length === 2,
      "both missing .gitignore scratch-zone lines flagged (.local/ + tmp/)",
    );
    assert(!flagged.has("package.json"), "package.json not flagged");
    assert(!flagged.has("RUNBOOK_SAMPLE.md"), "root *.md exempt (runbook lint owns it)");
    assert(!flagged.has("client/index.ts") && !flagged.has("client/"), "registered dir + clean file not flagged");
    const expected = rootJunk.length + 3 + 1 + 1 + 2; // junk + files + nested junk + dir + gitignore
    assert(
      res.offenders.length === expected,
      `exact offender count (${res.offenders.length}/${expected})`,
    );
  } finally {
    cleanup();
  }
}

// 2. Clean fixture passes; junk dotfile caught; tsconfig variants allowed.
{
  const { root, cleanup } = fixture();
  try {
    for (const f of [
      "package.json",
      "package-lock.json",
      "components.json",
      "skills-lock.json",
      "drizzle.config.ts",
      "vite.config.ts",
      "tsconfig.json",
      "tsconfig.tests.json",
      "tsconfig.build.json", // variant pattern
      "replit.nix",
      "README.md",
      "generated-icon.png",
    ]) {
      writeFileSync(join(root, f), "x\n");
    }
    writeFileSync(join(root, ".gitignore"), PORTABLE_GITIGNORE);
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "gate.ts"), "x\n");
    // excluded-dir junk must NOT be flagged (node_modules never walked)
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(root, "node_modules", "dep", "junk.bak"), "x\n");

    const res = runLint(root);
    assert(res.ok, `clean fixture passes (offenders: ${res.offenders.map((o) => o.file).join(", ") || "none"})`);

    writeFileSync(join(root, ".env.bak"), "x\n");
    const res2 = runLint(root);
    assert(!res2.ok, "junk dotfile (.env.bak) is flagged despite dotfile exemption");
    assert(
      res2.offenders.length === 1 && res2.offenders[0].file === ".env.bak",
      "only the .bak dotfile is flagged",
    );
  } finally {
    cleanup();
  }
}

// 3. Tracked vs untracked remediation + baseline grandfathering.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(join(root, ".gitignore"), PORTABLE_GITIGNORE);
    writeFileSync(join(root, "legacy.bak"), "x\n");
    writeFileSync(join(root, "fresh.bak"), "x\n");

    const res = runLint(root, { trackedFiles: ["legacy.bak"] });
    const byFile = new Map(res.offenders.map((o) => [o.file, o.reason]));
    assert(byFile.get("legacy.bak")?.includes("tracked") === true, "tracked junk says `git rm`");
    assert(
      byFile.get("fresh.bak")?.includes("clean:scratch") === true,
      "untracked junk points at npm run clean:scratch",
    );

    const res2 = runLint(root, {
      trackedFiles: ["legacy.bak"],
      baselineLines: ["legacy.bak"],
    });
    assert(
      !res2.offenders.some((o) => o.file === "legacy.bak"),
      "baselined tracked junk is grandfathered",
    );
    assert(
      res2.offenders.some((o) => o.file === "fresh.bak"),
      "non-baselined junk still flagged",
    );
  } finally {
    cleanup();
  }
}

// 4. Git-ignored but on-disk junk is still flagged (publish-image bloat).
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(join(root, ".gitignore"), PORTABLE_GITIGNORE);
    writeFileSync(join(root, "app.ts"), "x\n");
    writeFileSync(join(root, "nohup.out"), "x\n"); // on disk, NOT in tracked/untracked lists
    const res = runLint(root, { trackedFiles: ["app.ts"], untrackedFiles: [] });
    const offender = res.offenders.find((o) => o.file === "nohup.out");
    assert(offender !== undefined, "ignored-but-on-disk junk flagged");
    assert(
      offender?.reason.includes("git-ignored") === true &&
        offender?.reason.includes("clean:scratch") === true,
      "ignored junk remediation names clean:scratch",
    );
    // app.ts is tracked at root but unregistered → deny-by-default still applies
    assert(
      res.offenders.some((o) => o.file === "app.ts"),
      "unregistered tracked root file still flagged in the same run",
    );
  } finally {
    cleanup();
  }
}

// 5. The real repository worktree is clean (guards the ongoing policy).
{
  const res = runLint();
  assert(res.ok, `real repo worktree is clean (${res.offenders.length} offender(s))`);
  assert(res.scanned > 1000, `real scan saw a plausible file count (${res.scanned})`);
  if (!res.ok) {
    for (const o of res.offenders) {
      console.error(`    offender: ${o.file} — ${o.reason}`);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
