/**
 * Task #1865 — Structural guardrails for `replit.md`.
 *
 * Required checks (all reported with file:line:section context):
 *
 *   1. Bullet length budget under `## System Architecture` and
 *      `## Core Features`:
 *        - top-level bullets ≤ MAX_BULLET_CHARS chars
 *        - indented sub-bullets ≤ MAX_SUB_BULLET_CHARS chars
 *   2. Sentence count budget under the same sections: top-level bullets
 *      ≤ MAX_SENTENCES sentences (sub-bullets exempt).
 *   3. Required canonical sections must exist (case-sensitive H2 match).
 *   4. Runbook filename link rule: any bullet (anywhere in the file)
 *      that mentions a runbook filename of the form `FOO.md` must
 *      contain a markdown link to that file. Bare filename mentions
 *      are flagged.
 *   5. Migration filename rule: any prose match of `migration\s+\d{4}\b`
 *      (case-insensitive) outside a code span must be followed within
 *      the same line by an `_` or `.sql` form, OR be a meta-statement
 *      explicitly demonstrating the rule (the Doc Hygiene example).
 *   6. Whole-file size budget (anti-regrowth): the file must stay under
 *      MAX_FILE_LINES lines AND MAX_FILE_CHARS chars. `replit.md` is an
 *      orientation index, not a changelog — when it grows, RELOCATE the
 *      detail into the owning runbook and leave a one-line pointer.
 *   7. Per-section bullet-count cap: the sections most prone to per-task
 *      changelog accretion (`### Core Features`, `### Backend`) may hold
 *      at most BULLET_COUNT_CAPS[section] bullets (top-level + sub).
 *      Over budget means a per-task chain should be collapsed into one
 *      durable subsystem bullet with detail RELOCATED to a runbook.
 *   8. Optional baseline support: `scripts/lint-replit-md.baseline.txt`
 *      may contain one SHA1 hash of an offending bullet line per row
 *      (lines starting with `#` are comments). Hashes present in the
 *      baseline are reported as "grandfathered" but do not fail the
 *      build. Goal: keep the baseline empty.
 *
 * Levers when over budget (rules 6 & 7) — never just delete a fact:
 *   (1) relocate detail into the owning runbook, leaving a labeled pointer;
 *   (2) de-duplicate; (3) collapse a per-task changelog chain into one
 *   durable subsystem bullet. Every durable fact must remain reachable
 *   inline or via an obvious pointer.
 *
 * Exit code:
 *   0 — only grandfathered offenders remain (or none).
 *   1 — at least one new (non-baselined) violation.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Scope intentionally fixed (Task #2846): this lint structurally guards the
// single replit.md file; there is nothing to discover repo-wide.
const BASELINE = "scripts/lint-replit-md.baseline.txt";

const MAX_BULLET_CHARS = 400;
const MAX_SUB_BULLET_CHARS = 600;
const MAX_SENTENCES = 2;

// Rule 6 — whole-file anti-regrowth budget. Both must hold.
const MAX_FILE_LINES = 114; // trimmed to 105 lines; cap is ~8% above actual
const MAX_FILE_CHARS = 16400; // trimmed to ~14.9 KB; cap is ~10% above actual

// Rule 7 — per-section bullet-count cap (top-level + sub bullets) for the
// H3 sections most prone to per-task changelog accretion.
const BULLET_COUNT_CAPS: Record<string, number> = {
  "Core Features": 14, // trimmed to 13 bullets; cap is ~8% above actual
  Backend: 10, // trimmed to 9 bullets; cap is ~11% above actual
};

const GATED_HEADINGS = new Set(["System Architecture", "Core Features"]);

const REQUIRED_H2_SECTIONS = [
  "System Architecture",
  "Runtime Truth Table",
  "Env Var, System Setting & Kill Switch Index",
  "Doc Hygiene",
  "Audit Tracks",
  "Runbooks",
];
const REQUIRED_H3_SECTIONS = ["Core Features"];

// Runbook filenames that are surface-level architectural references.
// If any of these appear in a bullet, they must be inside a markdown
// link `[…](./RUNBOOK.md…)`. Bare appearance fails the lint.
const RUNBOOK_NAMES_RX = /\b([A-Z][A-Z0-9_]{2,}\.md)\b/g;

interface Violation {
  line: number;
  section: string;
  kind:
    | "bullet-chars"
    | "sub-bullet-chars"
    | "sentence-count"
    | "missing-section"
    | "runbook-link"
    | "migration-filename";
  detail: string;
  raw: string;
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

function loadBaseline(): Set<string> {
  const path = resolve(BASELINE);
  if (!existsSync(path)) return new Set();
  const lines = readFileSync(path, "utf8").split("\n");
  const set = new Set<string>();
  for (const ln of lines) {
    const t = ln.trim();
    if (!t || t.startsWith("#")) continue;
    set.add(t);
  }
  return set;
}

function stripInlineForSentenceCount(s: string): string {
  return s
    .replace(/`[^`]*`/g, "CODE")
    .replace(/\[[^\]]*\]\([^)]*\)/g, "LINK");
}

function countSentences(body: string): number {
  const stripped = stripInlineForSentenceCount(body);
  const matches = stripped.match(/[.!?](?:\s|$)/g);
  return matches ? matches.length : 0;
}

function stripCodeSpans(s: string): string {
  return s.replace(/`[^`]*`/g, "CODE");
}

function bulletHasLinkTo(body: string, filename: string): boolean {
  // Match a markdown link target whose URL ends with /filename or equals filename.
  const re = new RegExp(
    `\\]\\([^)]*?(?:^|/)${filename.replace(/\./g, "\\.")}(?:#[^)]*)?\\)`,
    "i",
  );
  return re.test(body);
}

export function lintReplitMd(path: string): {
  active: Violation[];
  grandfathered: Violation[];
} {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  const baseline = loadBaseline();

  const active: Violation[] = [];
  const grandfathered: Violation[] = [];
  const push = (v: Violation) => {
    const h = sha1(v.raw);
    if (baseline.has(h)) grandfathered.push(v);
    else active.push(v);
  };

  // Rule 6 — whole-file size budget (anti-regrowth). File-level, not
  // grandfatherable: the only fix is to relocate detail into a runbook.
  if (lines.length > MAX_FILE_LINES) {
    active.push({
      line: 0,
      section: "(file)",
      kind: "file-size",
      detail: `file has ${lines.length} lines > ${MAX_FILE_LINES}. RELOCATE detail into the owning runbook and leave a one-line pointer — do NOT delete durable facts.`,
      raw: `FILE_SIZE:lines:${lines.length}`,
    });
  }
  if (raw.length > MAX_FILE_CHARS) {
    active.push({
      line: 0,
      section: "(file)",
      kind: "file-size",
      detail: `file has ${raw.length} chars (~${Math.round(raw.length / 4)} tokens) > ${MAX_FILE_CHARS}. RELOCATE detail into the owning runbook and leave a one-line pointer — do NOT delete durable facts.`,
      raw: `FILE_SIZE:chars:${raw.length}`,
    });
  }

  // Required-section presence.
  const foundH2 = new Set<string>();
  const foundH3 = new Set<string>();
  for (const line of lines) {
    const m2 = /^## (.+?)\s*$/.exec(line);
    if (m2) foundH2.add(m2[1]);
    const m3 = /^### (.+?)\s*$/.exec(line);
    if (m3) foundH3.add(m3[1]);
  }
  for (const required of REQUIRED_H2_SECTIONS) {
    if (!foundH2.has(required)) {
      active.push({
        line: 0,
        section: "(file)",
        kind: "missing-section",
        detail: `required canonical section "## ${required}" is missing`,
        raw: `MISSING_SECTION:H2:${required}`,
      });
    }
  }
  for (const required of REQUIRED_H3_SECTIONS) {
    if (!foundH3.has(required)) {
      active.push({
        line: 0,
        section: "(file)",
        kind: "missing-section",
        detail: `required canonical section "### ${required}" is missing`,
        raw: `MISSING_SECTION:H3:${required}`,
      });
    }
  }

  let currentH2: string | null = null;
  let currentH3: string | null = null;

  // Rule 7 — per-section bullet tallies (top-level + sub).
  const bulletCounts = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h2 = /^## (.+?)\s*$/.exec(line);
    if (h2) {
      currentH2 = h2[1];
      currentH3 = null;
      continue;
    }
    const h3 = /^### (.+?)\s*$/.exec(line);
    if (h3) {
      currentH3 = h3[1];
      continue;
    }

    const topBullet = /^- (.+)$/.exec(line);
    const subBullet = /^  - (.+)$/.exec(line);

    if (!topBullet && !subBullet) {
      // Migration-filename rule applies to any prose line.
      checkMigrationRule(line, i + 1, currentH3 ?? currentH2 ?? "(file)", push);
      continue;
    }

    if (currentH3 && Object.prototype.hasOwnProperty.call(BULLET_COUNT_CAPS, currentH3)) {
      bulletCounts.set(currentH3, (bulletCounts.get(currentH3) ?? 0) + 1);
    }

    const body = (topBullet ?? subBullet)![1];
    const section = currentH3 ? `${currentH2} / ${currentH3}` : currentH2 ?? "(file)";

    // 1 + 2: char + sentence budgets under gated sections.
    if (currentH2 && GATED_HEADINGS.has(currentH2)) {
      if (topBullet && line.length > MAX_BULLET_CHARS) {
        push({
          line: i + 1,
          section,
          kind: "bullet-chars",
          detail: `bullet too long: ${line.length} chars > ${MAX_BULLET_CHARS}. Move detail to runbook and link it.`,
          raw: line,
        });
      }
      if (subBullet && line.length > MAX_SUB_BULLET_CHARS) {
        push({
          line: i + 1,
          section,
          kind: "sub-bullet-chars",
          detail: `sub-bullet too long: ${line.length} chars > ${MAX_SUB_BULLET_CHARS}. Move detail to runbook.`,
          raw: line,
        });
      }
      if (topBullet) {
        const sentences = countSentences(body);
        if (sentences > MAX_SENTENCES) {
          push({
            line: i + 1,
            section,
            kind: "sentence-count",
            detail: `bullet has ${sentences} sentences > ${MAX_SENTENCES}. Split or move detail to runbook.`,
            raw: line,
          });
        }
      }
    }

    // 4: runbook-link rule. Any bullet mentioning a runbook filename
    // must contain a markdown link to it. Skip mentions inside inline
    // code spans (which are documentation of the convention, not links).
    const bodyNoCode = stripCodeSpans(body);
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = RUNBOOK_NAMES_RX.exec(bodyNoCode)) !== null) {
      const fname = m[1];
      if (seen.has(fname)) continue;
      seen.add(fname);
      if (!bulletHasLinkTo(body, fname)) {
        push({
          line: i + 1,
          section,
          kind: "runbook-link",
          detail: `runbook filename "${fname}" mentioned but not linked. Use \`See [${fname}](./${fname}).\``,
          raw: line,
        });
      }
    }

    // 5: migration filename rule on bullet prose.
    checkMigrationRule(line, i + 1, section, push);
  }

  // Rule 7 — per-section bullet-count cap. Over budget is not deletable:
  // collapse a per-task chain into one durable subsystem bullet and
  // RELOCATE the detail into the owning runbook.
  for (const [sectionName, cap] of Object.entries(BULLET_COUNT_CAPS)) {
    const count = bulletCounts.get(sectionName) ?? 0;
    if (count > cap) {
      active.push({
        line: 0,
        section: sectionName,
        kind: "bullet-count",
        detail: `section "### ${sectionName}" has ${count} bullets > ${cap}. Collapse a per-task changelog chain into one durable subsystem bullet and RELOCATE detail into the owning runbook — do NOT delete durable facts.`,
        raw: `BULLET_COUNT:${sectionName}:${count}`,
      });
    }
  }

  return { active, grandfathered };
}

function checkMigrationRule(
  line: string,
  lineNumber: number,
  section: string,
  push: (v: Violation) => void,
): void {
  const noCode = stripCodeSpans(line);
  const rx = /migration\s+(\d{4})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(noCode)) !== null) {
    // Acceptable if the same line also contains a 4-digit migration
    // number followed by `_` (filename body) or `.sql` (extension).
    if (/\b\d{4}_[A-Za-z0-9_]+\.sql\b/i.test(noCode)) continue;
    if (/\b\d{4}\.sql\b/i.test(noCode)) continue;
    // Quoted "migration 0055" inside a meta-rule that explicitly
    // demonstrates the violation is allowed.
    if (/"migration\s+\d{4}"/.test(line)) continue;
    push({
      line: lineNumber,
      section,
      kind: "migration-filename",
      detail: `bare migration reference "${m[0]}" — cite the full filename (e.g. \`0055_add_x.sql\`) instead.`,
      raw: line,
    });
    return;
  }
}

function isMainModule(): boolean {
  try {
    return (process.argv[1] ?? "").endsWith("lint-replit-md.ts");
  } catch {
    return false;
  }
}

export function cliMain(argv: string[] = process.argv.slice(2)): number {
  const FILE = argv[0] ?? "replit.md";
  const { active, grandfathered } = lintReplitMd(FILE);

  if (grandfathered.length > 0) {
    console.log(
      `lint-replit-md: ${grandfathered.length} grandfathered violation(s) remaining in ${BASELINE} — goal is zero.`,
    );
  }

  if (active.length === 0) {
    console.log(
      `lint-replit-md: OK (${FILE}: budgets, canonical sections, runbook links, and migration references all pass)`,
    );
    return 0;
  }

  console.error("");
  console.error(
    `✗ lint-replit-md: ${active.length} violation(s) in ${FILE}`,
  );
  console.error("");
  console.error("  Rules:");
  console.error(`    1. Top-level bullets under "## System Architecture" / "## Core Features": ≤ ${MAX_BULLET_CHARS} chars, ≤ ${MAX_SENTENCES} sentences.`);
  console.error(`    2. Sub-bullets in the same sections: ≤ ${MAX_SUB_BULLET_CHARS} chars.`);
  console.error(`    3. Canonical H2 sections required: ${REQUIRED_H2_SECTIONS.join(", ")}; H3 required: ${REQUIRED_H3_SECTIONS.join(", ")}.`);
  console.error(`    4. Runbook filenames (\`FOO.md\`) in bullets must be inside a markdown link.`);
  console.error(`    5. Bare "migration NNNN" references must be replaced with the full filename (e.g. \`NNNN_add_x.sql\`).`);
  console.error(`    6. Whole-file budget (anti-regrowth): ≤ ${MAX_FILE_LINES} lines AND ≤ ${MAX_FILE_CHARS} chars (~${Math.round(MAX_FILE_CHARS / 4)} tokens).`);
  console.error(`    7. Per-section bullet cap (top+sub): ${Object.entries(BULLET_COUNT_CAPS).map(([s, c]) => `"${s}" ≤ ${c}`).join(", ")}.`);
  console.error(
    `  Over budget? Use only these levers — never delete a durable fact: RELOCATE detail into the owning runbook (leave a labeled pointer), de-duplicate, or collapse a per-task changelog chain into one durable subsystem bullet:`,
  );
  console.error(
    `    - **Feature (Task #NNNN):** One-sentence what+why. See [RUNBOOK.md § Section](./RUNBOOK.md#anchor).`,
  );
  console.error("");
  console.error("  Violations:");
  for (const v of active) {
    const loc = v.line > 0 ? `${FILE}:${v.line}` : FILE;
    console.error(`    - ${loc} [${v.section}] ${v.kind}: ${v.detail}`);
    if (v.line > 0) {
      const preview = v.raw.slice(0, 100) + (v.raw.length > 100 ? "…" : "");
      console.error(`        ${preview}`);
    }
  }
  console.error("");
  console.error(
    `  To grandfather an offender during incremental cleanup, add its SHA1 hash to ${BASELINE} (one per line).`,
  );
  console.error("");
  return 1;
}

if (isMainModule()) {
  process.exit(cliMain());
}
