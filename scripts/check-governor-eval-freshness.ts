/**
 * Task #4194 — Governor eval-prompt freshness check (advisory, gate-adjacent).
 *
 * Background: two eval prompts in
 * `.agents/skills/architecture-governor/evals/evals.json` rotted because they
 * named a column (`clients.status`) and a test file
 * (`tests/booking-window.test.ts`) the codebase no longer had; a whole live
 * eval round was spent on premise-mismatch detection instead of the intended
 * risk classes (fixed in task #4182; see
 * `audits/architecture-governor-bootstrap-report.md` §9).
 *
 * This check extracts repo references from each eval case's `prompt` and
 * verifies them against the current tree:
 *   1. `table.column` mentions — the table must be a `pgTable("<name>", …)`
 *      in `shared/models/**` and the column string literal must appear inside
 *      that table's definition block.
 *   2. Bare `<snake_case_name> table` mentions — the table must exist.
 *   3. `tests/**.test.ts(x)` paths — the file must exist on disk.
 * Task #4212 extends this to each case's `expected` behavior strings, which
 * cite repo files too (docs/*.md, scripts/*, server/**, bare filenames like
 * green-baseline.json) and rot the same way:
 *   4. dir-prefixed file paths in `expected` must exist on disk;
 *   5. bare `*.json|*.md|*.sh` filenames in `expected` must exist in one of a
 *      small set of well-known dirs (root, tests/, scripts/, docs/, audits/).
 * Failures name the offending case id and reference.
 * Task #4239 adds a sibling scan (`runSkillDocsLint`) over the skill's
 * SKILL.md + references/*.md: dir-prefixed file paths cited by the docs must
 * exist on disk; failures name the offending doc + reference.
 *
 * NOT wired into the gate (an additive gate lint is an L3 gate-policy change
 * requiring owner approval). Enforcement surface is the registered guard test
 * `tests/governor-eval-freshness.test.ts` (regression sweep + related-smoke
 * via scanPaths on the evals file). Side-effect-free at import; exports a
 * pure `runLint()` plus the standard `cliMain()` contract so future gate
 * wiring needs no script changes.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface EvalFreshnessOffender {
  caseId: number | string;
  reference: string;
  reason: string;
}

export interface EvalFreshnessResult {
  ok: boolean;
  checked: number;
  offenders: EvalFreshnessOffender[];
}

export interface RunLintOptions {
  evalsPath?: string;
  modelsDir?: string;
  repoRoot?: string;
}

const DEFAULT_EVALS_PATH = ".agents/skills/architecture-governor/evals/evals.json";
const DEFAULT_MODELS_DIR = "shared/models";

/** File extensions that make a dotted pair a filename, not a table.column. */
const FILE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "sql", "css", "html", "txt", "yml", "yaml",
]);

interface SchemaIndex {
  /** table name -> body of its pgTable({...}) definition block */
  tables: Map<string, string>;
}

/** Extract the balanced `{...}` block that follows `pgTable("name",`. */
function extractTableBlock(source: string, startIdx: number): string {
  const braceStart = source.indexOf("{", startIdx);
  if (braceStart === -1) return "";
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  return source.slice(braceStart);
}

export function buildSchemaIndex(modelsDir: string): SchemaIndex {
  const tables = new Map<string, string>();
  const files = readdirSync(modelsDir).filter((f) => f.endsWith(".ts"));
  const tableRe = /pgTable\(\s*["'`]([a-zA-Z0-9_]+)["'`]/g;
  for (const file of files) {
    const source = readFileSync(join(modelsDir, file), "utf8");
    let m: RegExpExecArray | null;
    while ((m = tableRe.exec(source)) !== null) {
      tables.set(m[1], extractTableBlock(source, m.index + m[0].length));
    }
  }
  return { tables };
}

function tableHasColumn(block: string, column: string): boolean {
  // Columns are declared via string literals: text("firm_name"), varchar('x')…
  return new RegExp(`["'\`]${column}["'\`]`).test(block);
}

/** Extract candidate repo references from one prompt string. */
export function extractReferences(prompt: string): {
  dottedPairs: Array<{ table: string; column: string }>;
  bareTables: string[];
  testPaths: string[];
} {
  const testPaths: string[] = [];
  const testRe = /tests\/[A-Za-z0-9._\-/]+\.test\.tsx?/g;
  let m: RegExpExecArray | null;
  while ((m = testRe.exec(prompt)) !== null) testPaths.push(m[0]);

  const dottedPairs: Array<{ table: string; column: string }> = [];
  const pairRe = /\b([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\b/g;
  while ((m = pairRe.exec(prompt)) !== null) {
    const before = prompt[m.index - 1];
    // Skip path/filename contexts: preceded by '/', '.', '-' or an extension pair.
    if (before === "/" || before === "." || before === "-") continue;
    if (FILE_EXTENSIONS.has(m[2])) continue;
    dottedPairs.push({ table: m[1], column: m[2] });
  }

  // "<snake_case_name> table" mentions (e.g. "the front_sync_emails table").
  const bareTables: string[] = [];
  const bareRe = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s+table\b/g;
  while ((m = bareRe.exec(prompt)) !== null) bareTables.push(m[1]);

  return { dottedPairs, bareTables, testPaths };
}

/** Top-level repo dirs whose slash-prefixed mentions count as file references. */
const EXPECTED_PATH_DIRS = ["docs", "scripts", "tests", "server", "shared", "client", "migrations", "audits"];

/**
 * Bare (no-slash) filename extensions worth checking. Deliberately narrow —
 * prose like "widget.js version" or class names must not match.
 */
const BARE_FILE_EXTENSIONS = ["json", "md", "sh"];

/** Where a bare filename mention (e.g. "green-baseline.json") may legitimately live. */
const BARE_FILE_SEARCH_DIRS = ["", "tests", "scripts", "docs", "audits"];

/**
 * Task #4212 — extract repo FILE references from an `expected` behavior string.
 * Conservative by construction:
 *   - dir-prefixed paths must start at a known top-level repo dir and end in
 *     an extension (docs/pool-epic-baseline.md, server/services/x.ts, …);
 *   - bare filenames match only a narrow extension set (green-baseline.json).
 */
export function extractExpectedFileRefs(text: string): {
  dirPaths: string[];
  bareFiles: string[];
} {
  const dirPaths: string[] = [];
  const dirRe = new RegExp(
    `(?<![\\w./-])(?:${EXPECTED_PATH_DIRS.join("|")})/[A-Za-z0-9._/-]*\\.[A-Za-z0-9]+`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = dirRe.exec(text)) !== null) dirPaths.push(m[0]);

  const bareFiles: string[] = [];
  const bareRe = new RegExp(
    `(?<![\\w./-])([A-Za-z0-9][A-Za-z0-9_-]*\\.(?:${BARE_FILE_EXTENSIONS.join("|")}))(?![\\w/-])`,
    "g",
  );
  while ((m = bareRe.exec(text)) !== null) bareFiles.push(m[1]);

  return { dirPaths, bareFiles };
}

const DEFAULT_SKILL_DIR = ".agents/skills/architecture-governor";

/**
 * Top-level dirs whose slash-prefixed mentions count as file references in
 * the SKILL docs. Broader than the eval-only set: the docs also cite the
 * repo's `script/` (singular) build dir and skill-relative dirs (`assets/`,
 * `references/`, `evals/`) which resolve against the skill directory.
 */
const SKILL_DOC_PATH_DIRS = [...EXPECTED_PATH_DIRS, "script", "assets", "references", "evals"];

/** Extract dir-prefixed file references from a skill doc's text. */
export function extractSkillDocFileRefs(text: string): string[] {
  const dirRe = new RegExp(
    `(?<![\\w./-])(?:${SKILL_DOC_PATH_DIRS.join("|")})/[A-Za-z0-9._/-]*\\.[A-Za-z0-9]+`,
    "g",
  );
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = dirRe.exec(text)) !== null) out.push(m[0]);
  return out;
}

/**
 * Task #4325 — extract bare (no dir prefix) `*.md` mentions from a skill
 * doc's text. The docs quote sibling reference docs by bare name (e.g.
 * protected-invariants.md mentions test-economics.md); when a reference doc
 * is renamed or deleted those mentions rot silently and route a live review
 * to a missing doc. Conservative by construction: ONLY `.md` names (prose
 * noise like "widget.js version" never matches), and the lookbehind rejects
 * anything that is part of a slash path (those are the dir-prefixed scan's
 * job).
 */
export function extractSkillDocBareMdRefs(text: string): string[] {
  const bareRe = /(?<![\w./-])([A-Za-z0-9][A-Za-z0-9._-]*\.md)(?![\w/-])/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = bareRe.exec(text)) !== null) out.push(m[1]);
  return out;
}

/**
 * Where a bare `*.md` mention in a skill doc may legitimately resolve:
 * sibling reference docs (references/), the skill root itself, and the
 * repo's well-known doc dirs (root runbooks like RUNBOOKS.md/replit.md,
 * docs/, audits/). Skill-relative entries resolve against the skill dir,
 * the rest against the repo root.
 */
const SKILL_DOC_BARE_MD_SKILL_DIRS = ["", "references", "assets"];
const SKILL_DOC_BARE_MD_REPO_DIRS = ["", "docs", "audits"];

export interface SkillDocsLintOptions {
  /** Directory holding SKILL.md and references/*.md. */
  skillDir?: string;
  /** Root against which dir-prefixed references are resolved. */
  repoRoot?: string;
}

export interface SkillDocsOffender {
  doc: string;
  reference: string;
  reason: string;
}

export interface SkillDocsLintResult {
  ok: boolean;
  docsChecked: number;
  refsChecked: number;
  offenders: SkillDocsOffender[];
}

/**
 * Task #4239 — the Governor skill's reference docs (SKILL.md trigger matrix +
 * references/*.md) cite live repo files the same way the eval cases do, and
 * rot the same way (a stale scripts/gate.ts or tests/run-all.ts mention can
 * mislead a live architecture review). Conservative by construction: verifies
 * dir-prefixed paths, plus (Task #4325) bare `*.md` mentions — sibling
 * reference docs are quoted by bare name and rot silently on rename/delete.
 * Other bare filenames (json/sh/ts…) stay deliberately out of scope: the
 * docs use them as prose too often. Skill-relative citations (assets/,
 * references/, evals/) resolve against the skill dir; everything else
 * against the repo root.
 */
export function runSkillDocsLint(options: SkillDocsLintOptions = {}): SkillDocsLintResult {
  const repoRoot = options.repoRoot ?? process.cwd();
  const skillDir = options.skillDir ?? join(repoRoot, DEFAULT_SKILL_DIR);

  const docs: string[] = [];
  const skillMd = join(skillDir, "SKILL.md");
  if (existsSync(skillMd)) docs.push(skillMd);
  const refsDir = join(skillDir, "references");
  if (existsSync(refsDir)) {
    for (const f of readdirSync(refsDir).filter((f) => f.endsWith(".md")).sort()) {
      docs.push(join(refsDir, f));
    }
  }

  const offenders: SkillDocsOffender[] = [];
  if (docs.length === 0) {
    return {
      ok: false,
      docsChecked: 0,
      refsChecked: 0,
      offenders: [
        { doc: skillDir, reference: "-", reason: "no SKILL.md or references/*.md found — scan would silently check nothing" },
      ],
    };
  }

  let refsChecked = 0;
  for (const doc of docs) {
    const text = readFileSync(doc, "utf8");
    const rel = doc.startsWith(repoRoot) ? doc.slice(repoRoot.length + 1) : doc;
    const dirPaths = extractSkillDocFileRefs(text);
    for (const p of new Set(dirPaths)) {
      refsChecked++;
      if (!existsSync(join(repoRoot, p)) && !existsSync(join(skillDir, p))) {
        offenders.push({ doc: rel, reference: p, reason: "referenced repo file does not exist" });
      }
    }

    // Task #4325 — bare *.md mentions must resolve to a sibling doc or a
    // known repo doc dir, or a renamed/deleted reference doc rots silently.
    for (const f of new Set(extractSkillDocBareMdRefs(text))) {
      refsChecked++;
      const found =
        SKILL_DOC_BARE_MD_SKILL_DIRS.some((d) => existsSync(join(skillDir, d, f))) ||
        SKILL_DOC_BARE_MD_REPO_DIRS.some((d) => existsSync(join(repoRoot, d, f)));
      if (!found) {
        offenders.push({
          doc: rel,
          reference: f,
          reason:
            "bare .md mention resolves to no sibling doc (skill root, references/, assets/) " +
            "or known repo doc dir (root, docs/, audits/)",
        });
      }
    }
  }

  return { ok: offenders.length === 0, docsChecked: docs.length, refsChecked, offenders };
}

export function runLint(options: RunLintOptions = {}): EvalFreshnessResult {
  const repoRoot = options.repoRoot ?? process.cwd();
  const evalsPath = options.evalsPath ?? join(repoRoot, DEFAULT_EVALS_PATH);
  const modelsDir = options.modelsDir ?? join(repoRoot, DEFAULT_MODELS_DIR);

  const offenders: EvalFreshnessOffender[] = [];
  let parsed: { cases?: Array<{ id: number | string; prompt?: string; expected?: unknown }> };
  try {
    parsed = JSON.parse(readFileSync(evalsPath, "utf8"));
  } catch (err) {
    return {
      ok: false,
      checked: 0,
      offenders: [
        { caseId: "-", reference: evalsPath, reason: `evals file unreadable/unparseable: ${(err as Error).message}` },
      ],
    };
  }
  const cases = parsed.cases ?? [];
  if (cases.length === 0) {
    return {
      ok: false,
      checked: 0,
      offenders: [{ caseId: "-", reference: evalsPath, reason: "evals file contains zero cases — extraction would silently check nothing" }],
    };
  }

  const schema = buildSchemaIndex(modelsDir);

  for (const c of cases) {
    // Task #4212 — `expected` behavior strings cite repo files too and rot
    // the same way (they silently mis-score a live eval round).
    const expected = Array.isArray(c.expected)
      ? c.expected.filter((e): e is string => typeof e === "string")
      : [];
    for (const line of expected) {
      const fileRefs = extractExpectedFileRefs(line);
      for (const p of fileRefs.dirPaths) {
        if (!existsSync(join(repoRoot, p))) {
          offenders.push({ caseId: c.id, reference: p, reason: "expected-behavior file reference does not exist" });
        }
      }
      for (const f of fileRefs.bareFiles) {
        const found = BARE_FILE_SEARCH_DIRS.some((d) => existsSync(join(repoRoot, d, f)));
        if (!found) {
          offenders.push({
            caseId: c.id,
            reference: f,
            reason: `expected-behavior bare filename not found in any of: ${BARE_FILE_SEARCH_DIRS.map((d) => d || "<root>").join(", ")}`,
          });
        }
      }
    }

    if (typeof c.prompt !== "string") continue;
    const refs = extractReferences(c.prompt);

    for (const p of refs.testPaths) {
      if (!existsSync(join(repoRoot, p))) {
        offenders.push({ caseId: c.id, reference: p, reason: "test file does not exist" });
      }
    }
    for (const t of refs.bareTables) {
      if (!schema.tables.has(t)) {
        offenders.push({ caseId: c.id, reference: `${t} table`, reason: `no pgTable("${t}") found under shared/models/` });
      }
    }
    for (const { table, column } of refs.dottedPairs) {
      const block = schema.tables.get(table);
      if (block === undefined) {
        // Only treat as a stale schema ref when it plausibly names a table
        // (snake_case somewhere in the pair); plain word.word prose is ignored.
        if (table.includes("_") || column.includes("_")) {
          offenders.push({ caseId: c.id, reference: `${table}.${column}`, reason: `no pgTable("${table}") found under shared/models/` });
        }
        continue;
      }
      if (!tableHasColumn(block, column)) {
        offenders.push({ caseId: c.id, reference: `${table}.${column}`, reason: `column "${column}" not found in pgTable("${table}") definition` });
      }
    }
  }

  return { ok: offenders.length === 0, checked: cases.length, offenders };
}

export function cliMain(): number {
  const result = runLint();
  const docsResult = runSkillDocsLint();
  if (result.ok && docsResult.ok) {
    console.log(
      `check-governor-eval-freshness: OK — ${result.checked} eval cases and ${docsResult.docsChecked} skill docs (${docsResult.refsChecked} dir-prefixed refs) checked, all repo references exist.`,
    );
    return 0;
  }
  if (!result.ok) {
    console.error(`check-governor-eval-freshness: FAIL — stale repo references in Governor eval prompts/expected:`);
    for (const o of result.offenders) {
      console.error(`  case ${o.caseId}: ${o.reference} — ${o.reason}`);
    }
  }
  if (!docsResult.ok) {
    console.error(`check-governor-eval-freshness: FAIL — stale repo references in Governor skill docs:`);
    for (const o of docsResult.offenders) {
      console.error(`  ${o.doc}: ${o.reference} — ${o.reason}`);
    }
  }
  console.error("Refresh the offending prompt(s)/doc(s) against the live tree (see audits/architecture-governor-bootstrap-report.md §9).");
  return 1;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("check-governor-eval-freshness.ts") ?? false);
if (isMain) process.exit(cliMain());
