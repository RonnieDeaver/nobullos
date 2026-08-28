/* test-registration
{
  "name": "Mandatory epic-intake policy surfaces stay complete (Task #5287)",
  "regression": true,
  "smoke": true,
  "smokeReason": "The mandatory epic-intake contract (from the #4904 crash-loop incident) is repeated across four instruction surfaces under trim and policy-drift pressure: the every-agent rules, preflight router, epic-decomposition skill, and Governor skill. A softened stop, lost trigger, missing stage/dependency rule, or restored one-task default would route an oversized request into another context-exhausting task. Pure fs reads + marker asserts: deterministic, DB-free, milliseconds; no runner or task-panel behavior.",
  "scanPaths": ["replit.md", "TASK_PREFLIGHT.md", ".agents/skills/epic-decomposition/SKILL.md", ".agents/skills/architecture-governor/SKILL.md"],
  "tier": "small",
  "tierReason": "Deliberately small, overriding the unmeasured default of medium: this is a deterministic DB-free marker scan over instruction files with no browser, server, network, or long-lived resource."
}
test-registration */
/**
 * Task #5287 — drift guard for the mandatory epic-intake policy.
 *
 * The policy must stay on ALL FOUR instruction surfaces agents actually read:
 *   1. replit.md — the every-agent rules list carries the compressed policy;
 *   2. TASK_PREFLIGHT.md — router-table row + "## 13. Epic Decomposition"
 *      section with the six-point policy;
 *   3. .agents/skills/epic-decomposition/SKILL.md — auto-loadable skill with
 *      the trigger-rich description and full playbook;
 *   4. .agents/skills/architecture-governor/SKILL.md — the Governor's
 *      mandatory-intake summary must not contradict the detailed policy.
 *
 * Each file is under recurring trim pressure (replit.md sits flush against
 * lint-replit-md's char/line caps; preflight and skills get reorganized), so
 * a well-meaning budget trim could silently delete the policy. This guard
 * fails loudly if any surface loses its policy anchors. Missing files fail
 * via readFileSync throwing — the negatives execute; nothing here can
 * "0 of 0" skip.
 *
 * Anchors are deliberately coarse (stable headings, pointer paths, policy
 * catch-phrases) so wording polish survives but removal does not. The
 * contract assertions are intentionally stronger than the original presence
 * check: all five oversize trigger families, dependency/stage requirements,
 * mid-flight bail-out, and the absence of a conflicting one-task default are
 * protected.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

const SKILL_PATH = ".agents/skills/epic-decomposition/SKILL.md";
const GOVERNOR_PATH = ".agents/skills/architecture-governor/SKILL.md";

const CONFLICTING_DEFAULT_PATTERNS = [
  /default\s+to\s+(?:a\s+)?single[- ]task\b/i,
  /default\s+to\s+(?:a\s+)?one[- ]task\b/i,
  /\b(?:single[- ]task|one[- ]task)\s+(?:plan\s+)?(?:is|should be|remains)\s+(?:the\s+)?default\b/i,
  /\bprefer\s+(?:a\s+)?(?:single[- ]task|one[- ]task)\b/i,
];

function assertMarkers(text: string, markers: string[], surface: string): void {
  const normalized = text.replace(/\s+/g, " ");
  for (const marker of markers) {
    assert.ok(normalized.includes(marker), `${surface} lost mandatory epic-intake anchor "${marker}".`);
  }
}

function assertNoConflictingDefault(text: string, surface: string): void {
  for (const pattern of CONFLICTING_DEFAULT_PATTERNS) {
    assert.doesNotMatch(
      text,
      pattern,
      `${surface} restored conflicting single-task planning guidance (${pattern}).`,
    );
  }
}

test("replit.md keeps the every-agent Task-sizing rule bullet with both policy pointers", () => {
  const replitMd = read("replit.md");
  const bulletMatch = replitMd.match(/^- Task-sizing rule: .+$/m);
  assert.ok(
    bulletMatch,
    "replit.md lost the '- Task-sizing rule: …' bullet from the every-agent rules list. " +
      "If a budget trim removed it, restore it (relocate other detail instead) — the epic-decomposition " +
      "policy must stay on every instruction surface (Task #4939).",
  );
  const bullet = bulletMatch![0];
  assert.ok(bullet.length >= 100, `Task-sizing bullet was gutted (${bullet.length} chars): ${bullet}`);
  for (const marker of [
    "epic",
    "full scope",
    "never trimmed",
    "any oversize signal",
    "3+ clusters",
    "800+ lines/10+ files",
    "giant file",
    "rebuild/restructure",
    "multi-pass verification",
    "dependsOn",
    "final stage integration/full verification",
    "stop/split on compaction or retries",
    "TASK_PREFLIGHT.md",
    SKILL_PATH,
    "vendor-stub infra",
  ]) {
    assert.ok(
      bullet.includes(marker),
      `replit.md Task-sizing bullet lost its "${marker}" anchor. Current bullet: ${bullet}`,
    );
  }
  assertNoConflictingDefault(replitMd, "replit.md");
});

test("TASK_PREFLIGHT.md keeps the § 13 Epic Decomposition section and its router row", () => {
  const preflight = read("TASK_PREFLIGHT.md");
  assert.match(
    preflight,
    /^## 13\. Epic Decomposition$/m,
    "TASK_PREFLIGHT.md lost the '## 13. Epic Decomposition' section heading (Task #4939).",
  );
  const routerRow = preflight
    .split("\n")
    .find((line) => line.startsWith("|") && line.includes("(#13-epic-decomposition)"));
  assert.ok(
    routerRow,
    "TASK_PREFLIGHT.md router table lost the § 13 Epic Decomposition row — agents no longer get " +
      "routed to the task-sizing policy pre-code (Task #4939).",
  );
  assert.ok(
    /rebuild\/restructure/i.test(routerRow!),
    `§ 13 router row lost its rebuild/restructure trigger phrasing: ${routerRow}`,
  );
  // Six-point policy anchors + every trigger family + the worked example +
  // the complete dependency/stage contract + the bail-out mechanism.
  for (const marker of [
    "Default to epics",
    "MUST NOT be proposed, accepted, started, or continued as a one-task plan",
    "Full scope, never downsizing",
    "Oversize signals",
    "3+ distinct deliverable clusters",
    "beyond ~800 changed lines or ~10 files",
    "single file over ~1,000 lines",
    "rebuild / restructure / overhaul / all N sections",
    "multiple independent passes",
    "Stage shape",
    "One deliverable cluster per stage",
    "independently finishable",
    "final stage covers integration + regeneration + full verification",
    "Mid-flight bail-out",
    "stops early",
    "ALL remaining scope",
    "dependency-ordered tasks",
    "Worked example",
    "`dependsOn`",
    "proposeFollowUpTasks",
    "#4904",
    "#4923–#4926",
    SKILL_PATH,
    "authoring new external-service/vendor mocking infrastructure",
    "does not already exist for that vendor",
    "check for an existing shared stub first",
    "build the missing harness",
    "verify the actual feature",
    "#5298",
  ]) {
    assert.ok(
      preflight.includes(marker),
      `TASK_PREFLIGHT.md § 13 lost its "${marker}" policy anchor (Task #4939).`,
    );
  }
  assertNoConflictingDefault(preflight, "TASK_PREFLIGHT.md");
});

test("epic-decomposition skill exists with a trigger-rich frontmatter description and the full playbook", () => {
  const skill = read(SKILL_PATH);
  assert.ok(skill.startsWith("---\n"), `${SKILL_PATH} lost its frontmatter block.`);
  const frontmatter = skill.slice(4, skill.indexOf("\n---", 4));
  assert.match(frontmatter, /^name: epic-decomposition$/m, `${SKILL_PATH} frontmatter lost its name.`);
  const descMatch = frontmatter.match(/^description: (.+)$/m);
  assert.ok(descMatch, `${SKILL_PATH} frontmatter lost its description — the skill can no longer auto-load.`);
  const description = descMatch![1];
  assert.ok(
    description.length >= 300,
    `${SKILL_PATH} description shrank to ${description.length} chars — it must stay trigger-rich enough ` +
      "to load before any large-scope task is planned or accepted.",
  );
  for (const marker of [
    "Load BEFORE planning",
    "oversize",
    "rebuild",
    "context compaction",
    "hard stop",
    "dependency-ordered stages",
  ]) {
    assert.ok(
      description.includes(marker),
      `${SKILL_PATH} description lost its "${marker}" loading trigger.`,
    );
  }
  const body = skill.slice(skill.indexOf("\n---", 4) + 4);
  assertMarkers(
    body,
    [
    "Default to epics",
    "MUST NOT be proposed, accepted, started, or continued as a one-task plan",
    "Full scope, never downsizing",
    "Oversize signals",
    "~3+ distinct deliverable clusters",
    "beyond roughly 800 changed lines or ~10 files",
    "single file over ~1,000 lines",
    "\"rebuild / restructure / overhaul / all N sections\" phrasing",
    "multiple independent passes",
    "Stage shape",
    "One deliverable cluster per stage",
    "independently finishable",
    "final stage covers integration + regeneration + full verification",
    "Mid-flight bail-out",
    "stops early",
    "ALL remaining scope",
    "dependency-ordered tasks",
    "Worked example",
    "`dependsOn`",
    "proposeFollowUpTasks",
    "superseded-task",
    "#4904",
      "#4923–#4926",
    "authoring new external-service/vendor mocking",
    "does not already exist for that vendor",
    "check for an existing shared stub",
    "build the missing harness",
    "verify the actual feature",
    "#5298",
    "build the shared stub",
    "wire up the feature",
    ],
    SKILL_PATH,
  );
  assertNoConflictingDefault(skill, SKILL_PATH);
});

test("Architecture Governor keeps the mandatory intake stop aligned with the epic policy", () => {
  const governor = read(GOVERNOR_PATH);
  assertMarkers(
    governor,
    [
      "Mandatory epic-intake rule:",
      "when any oversize signal in the",
      "planner MUST stop",
      "Do not propose,",
      "accept, start, or continue a one-task plan.",
      "complete requested scope as dependency-ordered,",
      "independently finishable stages",
      "with integration and full verification in the final stage.",
      "technically intercept a task created directly in an external Replit task panel.",
    ],
    GOVERNOR_PATH,
  );
  assertNoConflictingDefault(governor, GOVERNOR_PATH);
});
