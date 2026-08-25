/* test-registration
{
  "name": "Data-access category label drift guard (Task #4506) — no source file outside shared/models/clients.ts may define its own literal category-id→label pairing; the five data-access category labels come only from dataAccessCategoryDefs",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4506: fast pure AST source scan (no DB, no network); a drift here silently re-forks the five data-access category names across surfaces — exactly the regression Task #4463 unified (Command Panel said 'Follow-Up Touches' while the report said 'Pipeline Momentum Data' for the same id).",
  "scanPaths": [
    "client/src",
    "server",
    "shared"
  ],
  "tier": "small"
}
test-registration */
// Task #4506 — source contract locking the Task #4463 unification.
//
// Background: the five data-access category labels drifted apart because
// pages each kept a local literal list pairing the category ids with label
// strings. Task #4463 made shared/models/clients.ts (dataAccessCategoryDefs)
// the single source of truth; the four consumers now map over the shared
// defs (`label: d.label`), never a literal. Nothing stopped a FUTURE file
// from re-introducing a local literal list — this scan does.
//
// Detector (AST, property-order independent). A file offends when ≥2
// DISTINCT category ids appear in a "literal label pairing":
//   (a) an object literal that contains BOTH a property whose string value
//       is a category id (any property name: id/key/category/…) AND a
//       `label`/`shortLabel`/`name`/`title` property whose value is a
//       LITERAL string (string literal or substitution-free template) —
//       in either order;
//   (b) a Record-style map property `consult_bookings: "Some Label"` whose
//       string value is NOT a status/presence enum value ("unknown",
//       "available", "present", …) — those id-keyed status objects are the
//       legitimate pattern and stay clean.
// The compliant shape (`label: d.label` from dataAccessCategoryDefs.map)
// has no literal label string, so it never matches.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";
import {
  dataAccessCategoryDefs,
  dataAccessCategories,
  dataAccessStatuses,
  dataAccessPresenceValues,
} from "../shared/models/clients";

let passed = 0;
const ok = (msg: string) => {
  passed++;
  console.log(`  ✓ ${msg}`);
};

const CATEGORY_IDS = new Set<string>(dataAccessCategories);
// Values that legitimately pair with an id-named key (status/presence state
// objects like `consult_bookings: "unknown"`), never a display label.
const NON_LABEL_VALUES = new Set<string>([...dataAccessStatuses, ...dataAccessPresenceValues]);
const LABELISH_PROPS = new Set(["label", "shortLabel", "name", "title"]);

function literalString(node: ts.Node): string | null {
  // Unwrap transparent syntactic wrappers so `("A")`, `"A" as const`,
  // `<const>"A"`, `"A" satisfies string`, and `"A"!` all count as literals.
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

function propName(p: ts.PropertyAssignment): string | null {
  if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return p.name.text;
  return null;
}

/** Distinct category ids involved in a literal label pairing anywhere in the source. */
export function findLiteralLabelPairings(source: string, fileName = "scan.tsx"): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits = new Set<string>();

  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const idValues: string[] = [];
      let hasLiteralLabel = false;
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const name = propName(prop);
        const value = literalString(prop.initializer);
        if (value !== null && CATEGORY_IDS.has(value)) idValues.push(value);
        if (name && LABELISH_PROPS.has(name) && value !== null) hasLiteralLabel = true;
        // (b) Record-style map: id-as-key with a non-enum literal string value.
        if (name && CATEGORY_IDS.has(name) && value !== null && !NON_LABEL_VALUES.has(value)) {
          hits.add(name);
        }
      }
      // (a) id value + literal label sibling, regardless of property order.
      if (hasLiteralLabel) for (const id of idValues) hits.add(id);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...hits];
}

function isOffender(source: string): boolean {
  return findLiteralLabelPairings(source).length >= 2;
}

// ── (1) Detector self-test ──────────────────────────────────────────────────
{
  // Pre-#4463 shape: id before label.
  const forked = `
    const DATA_ACCESS_CATEGORIES = [
      { id: "consult_bookings", label: "Consult Bookings", description: "..." },
      { id: "sales_conversions", label: "Sales Conversions" },
    ];
  `;
  assert.equal(isOffender(forked), true, "must flag id-before-label literal lists");

  // Reversed property order (the previous detector's blind spot).
  const labelFirst = `
    const CATS = [
      { label: "Consult Booking Data", id: "consult_bookings" },
      { label: "Pipeline Momentum Data", key: "follow_up_touches" },
    ];
  `;
  assert.equal(isOffender(labelFirst), true, "must flag label-before-id literal lists");

  // Separated properties within one object (other props between them).
  const separated = `
    const CATS = [
      { key: "no_show_rate", weight: 3, icon: X, shortLabel: "No Shows" },
      { key: "sales_transcripts", weight: 1, icon: Y, shortLabel: "Transcripts" },
    ];
  `;
  assert.equal(isOffender(separated), true, "must flag pairings separated by other properties");

  // Wrapped literals (`as const`, parens, satisfies) must not evade detection.
  const wrapped = `
    const CATS = [
      { id: "consult_bookings" as const, label: "A" as const },
      { id: ("sales_conversions"), label: ("B" satisfies string) },
    ];
  `;
  assert.equal(isOffender(wrapped), true, "must flag literals wrapped in as/parens/satisfies");

  // Record-style label map keyed by id.
  const recordMap = `
    const LABELS = {
      consult_bookings: "Consult Booking Data",
      follow_up_touches: "Follow-Up Touches",
    };
  `;
  assert.equal(isOffender(recordMap), true, "must flag Record<id, label> literal maps");

  // Legitimate shapes must NOT flag:
  const sharedMap = `
    const DATA_ACCESS_CATEGORIES = dataAccessCategoryDefs.map(d => ({
      id: d.id, label: d.label, shortLabel: d.shortLabel, description: \`Unlocks \${d.unlocks}\`,
    }));
  `;
  assert.equal(isOffender(sharedMap), false, "mapping the shared defs must pass");

  const statusState = `
    const [dataAccess, setDataAccess] = useState({
      consult_bookings: "unknown",
      sales_conversions: "unknown",
      sales_transcripts: "unknown",
      no_show_rate: "unknown",
      follow_up_touches: "unknown",
    });
  `;
  assert.equal(isOffender(statusState), false, "id-keyed status-state objects must pass");

  const presenceMap = `
    const detection = { consult_bookings: "present", no_show_rate: "absent" };
  `;
  assert.equal(isOffender(presenceMap), false, "id-keyed presence maps must pass");

  const singleMention = `const one = [{ id: "consult_bookings", label: "Only one" }];`;
  assert.equal(isOffender(singleMention), false, "a single pairing must not flag (needs ≥2 distinct ids)");

  ok("detector self-test: order-independent flags for forked lists/maps; shared-map, status/presence state, single pairing pass");
}

// ── (2) Scan every production source tree outside the shared module ────────
{
  const SHARED_SOURCE_OF_TRUTH = join("shared", "models", "clients.ts");
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
  // Production source roots; tests/ and scripts/ fixtures are deliberately out
  // of contract (this file itself quotes offending shapes as fixtures).
  for (const root of ["client/src", "server", "shared"]) walk(root);

  // Volume floor: a broken walk reporting "0 offenders in few files" would be
  // a silent skip, not a pass.
  assert.ok(files.length >= 400, `expected ≥400 source files across roots, scanned ${files.length}`);
  const consumers = [
    join("client", "src", "pages", "CeoInsights.tsx"),
    join("client", "src", "pages", "ClientAdd.tsx"),
    join("client", "src", "pages", "admin", "ClientManagement.tsx"),
    join("client", "src", "components", "CommandPanel.tsx"),
    SHARED_SOURCE_OF_TRUTH,
  ];
  for (const c of consumers) {
    assert.ok(files.includes(c), `known file must be in the scan set: ${c}`);
  }

  const offenders: Array<{ file: string; ids: string[] }> = [];
  for (const file of files) {
    if (file.split(sep).join("/") === "shared/models/clients.ts") continue; // the single source of truth itself
    const ids = findLiteralLabelPairings(readFileSync(file, "utf8"), file);
    if (ids.length >= 2) offenders.push({ file, ids });
  }

  assert.deepEqual(
    offenders,
    [],
    `Local data-access category label list(s) found:\n` +
      offenders.map(o => `  ${o.file} (ids: ${o.ids.join(", ")})`).join("\n") +
      `\nThe five data-access category labels have a single source of truth: ` +
      `dataAccessCategoryDefs in shared/models/clients.ts. Import it and map ` +
      `(label: d.label / shortLabel: d.shortLabel) instead of re-declaring literals.`,
  );
  ok(`no file outside shared/models/clients.ts re-declares category labels (${files.length} files scanned)`);
}

// ── (3) Shared source of truth stays intact ─────────────────────────────────
{
  assert.equal(dataAccessCategoryDefs.length, 5, "shared defs must cover all five categories");
  const defIds = new Set(dataAccessCategoryDefs.map(d => d.id));
  for (const id of dataAccessCategories) {
    assert.ok(defIds.has(id), `shared defs missing category id: ${id}`);
  }
  for (const d of dataAccessCategoryDefs) {
    assert.ok(d.label.trim().length > 0 && d.shortLabel.trim().length > 0, `empty label for ${d.id}`);
  }
  // And the source of truth itself must still trip the detector — proof the
  // scanner would see a copy of it pasted anywhere else.
  const sharedSrc = readFileSync("shared/models/clients.ts", "utf8");
  assert.ok(
    findLiteralLabelPairings(sharedSrc).length >= 5,
    "detector must recognize the canonical defs shape (guards against detector rot)",
  );
  ok("shared dataAccessCategoryDefs covers every category id; detector recognizes the canonical shape");
}

console.log(`\nData-access category label drift guard: ${passed} checks passed`);
