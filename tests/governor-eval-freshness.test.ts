/* test-registration
{
  "name": "Governor eval-prompt freshness guard (Task #4194)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Fast (~0.2s) deterministic fs-only scan with no DB or network; guards the eval-prompt-rot bug class (task #4182's premise-mismatch waste) so it earns a routine-gate slot, and scanPaths route it into related-smoke when the evals pack or schema models churn.",
  "scanPaths": [
    ".agents/skills/architecture-governor/evals/evals.json",
    ".agents/skills/architecture-governor/SKILL.md",
    ".agents/skills/architecture-governor/references",
    "shared/models"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4194 — Guard test for scripts/check-governor-eval-freshness.ts.
 *
 * Proves:
 *   1. A fixture evals pack referencing a missing column / missing table /
 *      missing test file is flagged with the offending case id.
 *   2. A fixture pack whose references all exist passes.
 *   3. An empty/unparseable pack fails loudly (never silently checks nothing).
 *   4. The REAL evals pack is currently fresh against the live repo tree.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint, runSkillDocsLint, extractReferences, extractExpectedFileRefs, extractSkillDocFileRefs } from "../scripts/check-governor-eval-freshness";

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

function makeFixture(evalsJson: string): { root: string; cleanup: () => void } {
  // fixture-only: temp tree feeding the freshness analyzer, never repo state
  const root = mkdtempSync(join(tmpdir(), "gov-eval-fresh-"));
  mkdirSync(join(root, "shared/models"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(
    join(root, "shared/models/clients.ts"),
    `import { pgTable, text } from "drizzle-orm/pg-core";\n` +
      `export const clients = pgTable("clients", {\n  firmName: text("firm_name").notNull(),\n});\n` +
      `export const fse = pgTable("front_sync_emails", {\n  subject: text("subject"),\n});\n`,
  );
  writeFileSync(join(root, "tests/booking-availability.test.ts"), "// fixture suite\n");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs/pool-epic-baseline.md"), "# fixture doc\n");
  writeFileSync(join(root, "tests/green-baseline.json"), "{}\n");
  writeFileSync(join(root, "evals.json"), evalsJson);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runOn(root: string) {
  return runLint({
    repoRoot: root,
    evalsPath: join(root, "evals.json"),
    modelsDir: join(root, "shared/models"),
  });
}

// ---- 1. Stale references are flagged with case ids ----
{
  const stale = JSON.stringify({
    cases: [
      { id: 5, kind: "positive", prompt: "Rename the clients.status column to something else." },
      { id: 14, kind: "positive", prompt: "Change one assertion in tests/booking-window.test.ts to match." },
      { id: 15, kind: "positive", prompt: "Add a column to the high-volume front_sync_email_bodies table." },
      { id: 16, kind: "negative", prompt: "Change the dashboard greeting copy." },
      {
        id: 17,
        kind: "positive",
        prompt: "Bump the pool size.",
        expected: [
          "requires the pool-headroom measurement (docs/pool-epic-gone.md recipe) before any size change",
          "does not edit gone-baseline.json or registration timeouts",
        ],
      },
    ],
  });
  const fx = makeFixture(stale);
  try {
    const res = runOn(fx.root);
    assert(!res.ok, "stale pack fails");
    assert(res.checked === 5, "all cases counted");
    const byRef = new Map(res.offenders.map((o) => [o.reference, o.caseId]));
    assert(byRef.get("clients.status") === 5, "missing column flagged with case id 5");
    assert(byRef.get("tests/booking-window.test.ts") === 14, "missing test file flagged with case id 14");
    assert(byRef.get("front_sync_email_bodies table") === 15, "missing bare table flagged with case id 15");
    assert(byRef.get("docs/pool-epic-gone.md") === 17, "missing expected dir-path flagged with case id 17");
    assert(byRef.get("gone-baseline.json") === 17, "missing expected bare filename flagged with case id 17");
    assert(res.offenders.length === 5, `exactly 5 offenders (got ${res.offenders.length})`);
  } finally {
    fx.cleanup();
  }
}

// ---- 2. Fresh references pass ----
{
  const fresh = JSON.stringify({
    cases: [
      { id: 5, kind: "positive", prompt: "Rename the clients.firm_name column to company_name." },
      { id: 14, kind: "positive", prompt: "Change one assertion in tests/booking-availability.test.ts only." },
      { id: 15, kind: "positive", prompt: "Add a nullable column to the high-volume front_sync_emails table." },
      { id: 12, kind: "positive", prompt: "Install lodash so we can use debounce in one settings form." },
      {
        id: 17,
        kind: "positive",
        prompt: "Bump the pool size.",
        expected: [
          "requires the pool-headroom measurement (docs/pool-epic-baseline.md recipe) before any size change",
          "does not edit green-baseline.json, registration timeouts, retries, or quarantine",
        ],
      },
    ],
  });
  const fx = makeFixture(fresh);
  try {
    const res = runOn(fx.root);
    assert(res.ok, `fresh pack passes (offenders: ${JSON.stringify(res.offenders)})`);
  } finally {
    fx.cleanup();
  }
}

// ---- 3. Empty / unparseable packs fail loudly ----
{
  const fx = makeFixture(JSON.stringify({ cases: [] }));
  try {
    const res = runOn(fx.root);
    assert(!res.ok, "zero-case pack fails (extraction never silently checks nothing)");
  } finally {
    fx.cleanup();
  }
}
{
  const fx = makeFixture("{ not json");
  try {
    const res = runOn(fx.root);
    assert(!res.ok, "unparseable pack fails");
  } finally {
    fx.cleanup();
  }
}

// ---- 4. Extraction ignores prose/filename noise ----
{
  const refs = extractReferences(
    "Run npm test -- --file=tests/run-all.ts and read docs/pool-epic-baseline.md; bump widget.js version.",
  );
  assert(refs.dottedPairs.length === 0, "filename-like dotted pairs ignored");
  assert(refs.testPaths.length === 0, "non-.test.ts paths ignored");
}

// ---- 4b. Expected-string extraction is conservative (Task #4212) ----
{
  const refs = extractExpectedFileRefs(
    "requires docs/pool-epic-baseline.md evidence; does not edit green-baseline.json; bump widget.js version; " +
      "cites server/services/regressionSweepScheduler.ts and .agents/skills/x/evals/evals.json; L2/L3 classification",
  );
  assert(
    JSON.stringify(refs.dirPaths) ===
      JSON.stringify(["docs/pool-epic-baseline.md", "server/services/regressionSweepScheduler.ts"]),
    `dir-prefixed paths extracted exactly (got ${JSON.stringify(refs.dirPaths)})`,
  );
  assert(
    JSON.stringify(refs.bareFiles) === JSON.stringify(["green-baseline.json"]),
    `bare filenames narrow — widget.js and slash-prefixed json excluded (got ${JSON.stringify(refs.bareFiles)})`,
  );
}
{
  const refs = extractExpectedFileRefs(
    "walks the integration checklist: owning adapter, RUNBOOKS matrix row, status cache, audit label; " +
      "routes through the existing queue, never a new broker; answers ownership, growth/10x volume, retention",
  );
  assert(refs.dirPaths.length === 0 && refs.bareFiles.length === 0, "pure prose expected strings yield no refs");
}

// ---- 4c. Skill-doc scan flags stale dir-prefixed refs, names the doc (Task #4239) ----
{
  // fixture-only: temp tree feeding the skill-docs scanner, never repo state
  const root = mkdtempSync(join(tmpdir(), "gov-skill-docs-"));
  try {
    const skillDir = join(root, "skill");
    mkdirSync(join(skillDir, "references"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "scripts/gate-fixture.ts"), "// fixture\n");
    mkdirSync(join(skillDir, "assets"), { recursive: true });
    writeFileSync(join(skillDir, "assets/impact-review-fixture.md"), "# fixture asset\n");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/repo-doc-fixture.md"), "# repo doc fixture\n");
    writeFileSync(join(root, "ROOT-RUNBOOK-FIXTURE.md"), "# root runbook fixture\n");
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "# Trigger matrix\nAny change to scripts/gate-fixture.ts or tests/run-all-gone.ts is L3.\n" +
        "Use assets/impact-review-fixture.md; assets/gone-template.md is stale.\n" +
        // Task #4325 — bare .md mentions may resolve to repo doc dirs too.
        "Consult repo-doc-fixture.md and ROOT-RUNBOOK-FIXTURE.md.\n",
    );
    writeFileSync(join(skillDir, "references/sibling-fixture.md"), "# sibling fixture\n");
    writeFileSync(
      join(skillDir, "references/fixture-ref.md"),
      "See server/boot/gone-init.ts and references/fixture-ref.md; bare mentions like green-baseline.json or prose stay unchecked.\n" +
        // Task #4325 — bare *.md sibling mentions ARE checked now.
        "Pair with sibling-fixture.md; gone-sibling.md was renamed away. Prose like widget.js version stays out.\n",
    );

    const res = runSkillDocsLint({ skillDir, repoRoot: root });
    assert(!res.ok, "skill docs with stale refs fail");
    assert(res.docsChecked === 3, `all fixture docs scanned (got ${res.docsChecked})`);
    const byRef = new Map(res.offenders.map((o) => [o.reference, o.doc]));
    assert(
      byRef.get("tests/run-all-gone.ts")?.endsWith("SKILL.md") === true,
      "stale SKILL.md ref flagged with the offending doc",
    );
    assert(
      byRef.get("assets/gone-template.md")?.endsWith("SKILL.md") === true,
      "stale skill-relative assets/*.md ref flagged (eval-only dir scope not inherited)",
    );
    assert(
      byRef.get("server/boot/gone-init.ts")?.endsWith("references/fixture-ref.md") === true,
      "stale references/*.md ref flagged with the offending doc",
    );
    assert(!byRef.has("scripts/gate-fixture.ts"), "existing repo-root ref not flagged");
    assert(!byRef.has("assets/impact-review-fixture.md"), "existing skill-relative assets ref not flagged");
    assert(!byRef.has("references/fixture-ref.md"), "existing skill-relative sibling-doc ref not flagged");
    // Task #4325 — bare *.md sibling mentions are checked too.
    assert(
      byRef.get("gone-sibling.md")?.endsWith("references/fixture-ref.md") === true,
      "renamed-away bare .md sibling mention flagged with the offending doc",
    );
    assert(!byRef.has("sibling-fixture.md"), "existing bare .md sibling mention not flagged");
    assert(!byRef.has("repo-doc-fixture.md"), "bare .md resolving in repo docs/ not flagged");
    assert(!byRef.has("ROOT-RUNBOOK-FIXTURE.md"), "bare .md resolving at repo root not flagged");
    assert(!byRef.has("green-baseline.json"), "bare non-.md filenames stay out of scope");
    assert(!byRef.has("widget.js"), "prose filename noise stays out of scope");
    assert(res.offenders.length === 4, `exactly 4 offenders (got ${res.offenders.length})`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
{
  // Empty skill dir fails loudly — never silently checks nothing.
  const root = mkdtempSync(join(tmpdir(), "gov-skill-docs-empty-"));
  try {
    const res = runSkillDocsLint({ skillDir: join(root, "nope"), repoRoot: root });
    assert(!res.ok, "missing skill docs fail loudly (scan never silently checks nothing)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- 5. The REAL evals pack is fresh against the live tree ----
{
  const res = runLint();
  assert(res.checked >= 17, `real pack has >= 17 cases (got ${res.checked})`);
  assert(
    res.ok,
    `real Governor evals pack is fresh (offenders: ${JSON.stringify(res.offenders)}) — refresh the prompt per audits/architecture-governor-bootstrap-report.md §9`,
  );

  const docsRes = runSkillDocsLint();
  assert(docsRes.docsChecked >= 8, `real skill docs scanned: SKILL.md + references (got ${docsRes.docsChecked})`);
  assert(docsRes.refsChecked >= 20, `real skill docs contain dir-prefixed refs worth checking (got ${docsRes.refsChecked})`);
  assert(
    docsRes.ok,
    `real Governor skill docs are fresh (offenders: ${JSON.stringify(docsRes.offenders)}) — update the offending doc against the live tree`,
  );
}

console.log(`\ngovernor-eval-freshness guard: passed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exit(1);
