/* test-registration
{
  "name": "Epic-decomposition policy surfaces: replit.md rule bullet + TASK_PREFLIGHT.md § 13 + epic-decomposition skill all present (Task #4939)",
  "regression": true,
  "smoke": true,
  "smokeReason": "The epic-by-default decomposition policy (Task #4939, from the #4904 crash-loop incident) lives on three instruction surfaces that are all under active size-budget/trim pressure: the replit.md every-agent rules list (lint-replit-md char/line caps force periodic trims), TASK_PREFLIGHT.md, and the .agents/skills tree. A future budget trim can silently drop the rule bullet, the § 13 section, or the skill file — exactly the drift this guard rejects. Pure fs reads of three text files + marker asserts: deterministic, DB-free, milliseconds.",
  "scanPaths": ["replit.md", "TASK_PREFLIGHT.md", ".agents/skills/epic-decomposition/SKILL.md"],
  "tier": "small"
}
test-registration */
/**
 * Task #4939 — drift guard for the epic-by-default task decomposition policy.
 *
 * The policy must stay on ALL THREE instruction surfaces agents actually read:
 *   1. replit.md — the every-agent rules list carries a "Task-sizing rule"
 *      bullet pointing at the detailed policy;
 *   2. TASK_PREFLIGHT.md — router-table row + "## 13. Epic Decomposition"
 *      section with the six-point policy;
 *   3. .agents/skills/epic-decomposition/SKILL.md — auto-loadable skill whose
 *      frontmatter description triggers BEFORE planning/accepting large-scope
 *      tasks, carrying the full playbook.
 *
 * Each file is under recurring trim pressure (replit.md sits flush against
 * lint-replit-md's char/line caps; preflight and skills get reorganized), so
 * a well-meaning budget trim could silently delete the policy. This guard
 * fails loudly if any surface loses its policy anchors. Missing files fail
 * via readFileSync throwing — the negatives execute; nothing here can
 * "0 of 0" skip.
 *
 * Anchors are deliberately coarse (stable headings, pointer paths, policy
 * catch-phrases) so wording polish survives but removal does not.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

const SKILL_PATH = ".agents/skills/epic-decomposition/SKILL.md";

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
  for (const marker of ["epic", "full scope", "never trimmed", "TASK_PREFLIGHT.md", SKILL_PATH]) {
    assert.ok(
      bullet.includes(marker),
      `replit.md Task-sizing bullet lost its "${marker}" anchor. Current bullet: ${bullet}`,
    );
  }
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
  // Six-point policy anchors + the worked example + the bail-out mechanism.
  for (const marker of [
    "Default to epics",
    "Full scope, never downsizing",
    "Oversize signals",
    "Stage shape",
    "Mid-flight bail-out",
    "Worked example",
    "`dependsOn`",
    "proposeFollowUpTasks",
    "#4904",
    "#4923–#4926",
    SKILL_PATH,
  ]) {
    assert.ok(
      preflight.includes(marker),
      `TASK_PREFLIGHT.md § 13 lost its "${marker}" policy anchor (Task #4939).`,
    );
  }
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
  for (const marker of ["Load BEFORE planning", "oversize", "rebuild", "context compaction"]) {
    assert.ok(
      description.includes(marker),
      `${SKILL_PATH} description lost its "${marker}" loading trigger.`,
    );
  }
  const body = skill.slice(skill.indexOf("\n---", 4) + 4);
  for (const marker of [
    "Default to epics",
    "Full scope, never downsizing",
    "Oversize signals",
    "Stage shape",
    "Mid-flight bail-out",
    "Worked example",
    "`dependsOn`",
    "proposeFollowUpTasks",
    "superseded-task",
    "#4904",
    "#4923–#4926",
  ]) {
    assert.ok(body.includes(marker), `${SKILL_PATH} playbook lost its "${marker}" section/anchor.`);
  }
});
