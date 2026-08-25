/**
 * Task #1611 — Runbook coverage drift check.
 *
 * Verifies, by parsing replit.md + RUNBOOKS.md and listing repo-root
 * markdown files, that:
 *
 *   1. Every integration listed in the Runtime Truth Table's
 *      "Primary integrations" row (in replit.md) is referenced (as a row)
 *      in the Integration Runbook Coverage Matrix (in RUNBOOKS.md).
 *
 *   2. Every *.md file at the repo root (excluding replit.md and
 *      RUNBOOKS.md themselves and ad-hoc report outputs that match
 *      *-report.md / *-results.md) is referenced in the Runbook Index
 *      (in RUNBOOKS.md).
 *
 * Exits non-zero with a clear message when something is missing so that
 * scripts/predeploy.sh can block a deploy on coverage drift.
 *
 * Usage: `tsx scripts/verify-runbook-coverage.ts`
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const REPLIT_MD = join(REPO_ROOT, "replit.md");
const RUNBOOKS_MD = join(REPO_ROOT, "RUNBOOKS.md");

const REPORT_EXCLUDE_PATTERNS: RegExp[] = [
  /^replit\.md$/i,
  /^RUNBOOKS\.md$/i,
  /-report\.md$/i,
  /-results\.md$/i,
];

interface Section {
  heading: string;
  body: string;
}

function readSections(md: string): Section[] {
  const lines = md.split("\n");
  const sections: Section[] = [];
  let currentHeading = "";
  let currentBody: string[] = [];
  for (const line of lines) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) {
      if (currentHeading) {
        sections.push({ heading: currentHeading, body: currentBody.join("\n") });
      }
      currentHeading = m[1].trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentHeading) {
    sections.push({ heading: currentHeading, body: currentBody.join("\n") });
  }
  return sections;
}

function findSection(
  sections: Section[],
  heading: string,
  sourceFile: string,
): Section {
  const s = sections.find((x) => x.heading === heading);
  if (!s) {
    throw new Error(`${sourceFile} is missing required section "## ${heading}"`);
  }
  return s;
}

function parseTableRows(body: string): string[][] {
  const rows: string[][] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|") || !line.endsWith("|")) continue;
    if (/^\|\s*-+\s*(\|\s*-+\s*)+\|$/.test(line)) continue; // separator
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    rows.push(cells);
  }
  return rows;
}

/**
 * Expand the comma-separated "Primary integrations" cell into individual
 * integration names that should each appear as a row in the Integration
 * Runbook Coverage Matrix.
 *
 *   "Google (Calendar/Drive/Maps)" -> ["Google Calendar", "Google Drive", "Google Maps"]
 *   "Rev.ai/Rev.com"               -> ["Rev.ai / Rev.com"]
 *   "OpenAI"                       -> ["OpenAI"]
 */
function expandIntegrationTokens(cell: string): string[] {
  const tokens = cell.split(",").map((t) => t.trim()).filter(Boolean);
  const out: string[] = [];
  for (const token of tokens) {
    const grouped = /^(.+?)\s*\(([^)]+)\)$/.exec(token);
    if (grouped) {
      const prefix = grouped[1].trim();
      for (const part of grouped[2].split("/").map((p) => p.trim()).filter(Boolean)) {
        out.push(`${prefix} ${part}`);
      }
      continue;
    }
    if (token.includes("/")) {
      out.push(
        token
          .split("/")
          .map((p) => p.trim())
          .filter(Boolean)
          .join(" / "),
      );
      continue;
    }
    out.push(token);
  }
  return out;
}

function getPrimaryIntegrations(sections: Section[]): string[] {
  // The Runtime Truth Table is the first H2 ("Runtime Truth Table").
  const truth = findSection(sections, "Runtime Truth Table", "replit.md");
  const rows = parseTableRows(truth.body);
  const row = rows.find((r) => r[0] === "Primary integrations");
  if (!row) {
    throw new Error(
      'Runtime Truth Table is missing the "Primary integrations" row.',
    );
  }
  return expandIntegrationTokens(row[1]);
}

function getIntegrationMatrixNames(sections: Section[]): Set<string> {
  const matrix = findSection(
    sections,
    "Integration Runbook Coverage Matrix",
    "RUNBOOKS.md",
  );
  const rows = parseTableRows(matrix.body);
  // Skip header row ("Integration" | "Owning runbook(s)").
  const names = new Set<string>();
  for (const r of rows) {
    if (r[0].toLowerCase() === "integration") continue;
    names.add(r[0]);
  }
  return names;
}

function getRunbookIndexFiles(sections: Section[]): Set<string> {
  const idx = findSection(sections, "Runbook Index", "RUNBOOKS.md");
  const rows = parseTableRows(idx.body);
  const files = new Set<string>();
  for (const r of rows) {
    if (r[0].toLowerCase() === "runbook") continue;
    // Cell looks like "[FOO.md](./FOO.md)"; extract the link text.
    const m = /\[([^\]]+\.md)\]/.exec(r[0]);
    if (m) files.add(m[1]);
  }
  return files;
}

function listRootRunbookCandidates(): string[] {
  const entries = readdirSync(REPO_ROOT, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => e.name)
    .filter((name) => !REPORT_EXCLUDE_PATTERNS.some((re) => re.test(name)))
    .sort();
}

function main(): void {
  const replitSections = readSections(readFileSync(REPLIT_MD, "utf8"));
  const runbooksSections = readSections(readFileSync(RUNBOOKS_MD, "utf8"));

  const errors: string[] = [];

  // Check 1: every Primary integration (from replit.md Runtime Truth Table)
  // has a matrix row in RUNBOOKS.md.
  const integrations = getPrimaryIntegrations(replitSections);
  const matrixNames = getIntegrationMatrixNames(runbooksSections);
  const missingIntegrations = integrations.filter((i) => !matrixNames.has(i));
  if (missingIntegrations.length > 0) {
    errors.push(
      `Integration Runbook Coverage Matrix is missing rows for: ${missingIntegrations.join(", ")}`,
    );
  }

  // Check 2: every root-level *.md (minus reports / replit.md / RUNBOOKS.md)
  // is in the Runbook Index in RUNBOOKS.md.
  const candidates = listRootRunbookCandidates();
  const indexed = getRunbookIndexFiles(runbooksSections);
  const missingRunbooks = candidates.filter((f) => !indexed.has(f));
  if (missingRunbooks.length > 0) {
    errors.push(
      `Runbook Index is missing entries for the following root-level markdown files: ${missingRunbooks.join(", ")}\n` +
        `  (If a file is an ad-hoc report, rename it to end with -report.md or -results.md so this check ignores it.)`,
    );
  }

  if (errors.length > 0) {
    console.error("");
    console.error("============================================================");
    console.error("  verify-runbook-coverage FAILED");
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    console.error(
      "  Update RUNBOOKS.md so the Runbook Index + Integration Runbook",
    );
    console.error(
      "  Coverage Matrix reflect the new runbook / integration, then re-run.",
    );
    console.error("============================================================");
    process.exit(1);
  }

  console.log(
    `verify-runbook-coverage OK — ${integrations.length} integrations and ${candidates.length} runbooks all covered.`,
  );
}

main();
