/* test-registration
{
  "name": "lint-sql-array-bindings scripts-tree expansion guard (Task #3944)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3944: guards the SQL-array-binding lint's expanded scope (server/shared/scripts), its comment/string/regex masking, and its deliberate exclusions. The two operational-script defects this expansion caught are fixed in the same change; this matrix keeps the class closed. Task #4303: also pins the cast-less bare form (ANY of a bare JS array tuple-expands into invalid SQL — the Sheets last-activity 500) with its bindArrayParam/column-ref allow-rules. Fast, DB-free, deterministic (tmp-dir fixtures + real-tree scan).",
  "tier": "small"
}
test-registration */
/**
 * Task #3944 — guard tests for scripts/lint-sql-array-bindings.ts.
 *
 * The lint originally scanned server/ + shared/ only ("scope intentionally
 * fixed", Task #2846), which let two genuinely broken raw
 * `ANY(${...}::text[])` uses ship in scripts/ (cancel-stale-front-backlog,
 * remediate-twilio-failures — both run against the real database). This
 * matrix pins the expanded scope and the masking that makes it safe:
 *
 *   1. The historical broken pattern fails in scripts/.
 *   2. The same broken pattern still fails in server/ and shared/.
 *   3. The repository-approved bindArrayParam form passes.
 *   4. A scalar interpolation is not falsely classified as an array.
 *   5. Comments / strings / regex literals containing the bad pattern do
 *      not falsely fail (template-literal text stays visible — that is
 *      where genuine offenders live).
 *   6. Extension handling matches the corpus (.ts/.tsx/.mts/.mjs/.cjs/.js
 *      scanned; other extensions ignored).
 *   7. Excluded generated/vendored/separate-package trees stay excluded
 *      (node_modules, dist, build, dot-dirs; website/public + artifacts/
 *      by not being roots).
 *   8. Cast-less bare form (Task #4303): `ANY(${ids})` with no cast fails
 *      (Drizzle tuple-expands the bare array into invalid `ANY(($1, $2))`
 *      SQL — the Sheets last-activity 500). Call expressions and
 *      variable-held bindArrayParam fragments fail too; inline
 *      `bindArrayParam(...)` fragments and Drizzle column refs
 *      (`ANY(${table.column})`) pass, as does inline literal SQL
 *      (`ANY(ARRAY[...]::text[])` with no interpolation).
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  runLint,
  maskSource,
  hasBrokenArrayBinding,
  BROKEN,
  ROOTS,
  SCANNED_EXTENSIONS,
} from "../scripts/lint-sql-array-bindings";

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

const BROKEN_LINE = "await db.execute(sql`SELECT 1 WHERE id = ANY(${ids}::text[])`);\n";
const APPROVED_LINE =
  "await db.execute(sql`SELECT 1 WHERE id = ANY(${bindArrayParam(ids, \"text\")})`);\n";

// Task #4303 — cast-less bare-form fixtures.
const BARE_BROKEN_LINE = "await db.execute(sql`SELECT 1 WHERE id = ANY(${ids})`);\n";
const CALL_EXPR_LINE =
  "await db.execute(sql`SELECT 1 WHERE r = ANY(${Array.from(RETRYABLE)})`);\n";
const HELD_FRAGMENT_LINES =
  'const p = bindArrayParam(ids, "text");\n' +
  "await db.execute(sql`SELECT 1 WHERE id = ANY(${p})`);\n";
const COLUMN_REF_LINE =
  "await db.select().from(t).where(sql`${val} = ANY(${actionLogEntries.impactedSystems})`);\n";
const INLINE_LITERAL_LINE =
  "await db.execute(sql`SELECT 1 WHERE q = ANY(ARRAY['a','b']::text[])`);\n";

function fixture(): { root: string; write: (rel: string, content: string) => void; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lint-sql-array-"));
  return {
    root,
    write: (rel, content) => {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

console.log("1+2) broken pattern fails in scripts/, server/, and shared/");
{
  const { root, write, cleanup } = fixture();
  try {
    write("scripts/one-off.ts", BROKEN_LINE);
    write("server/services/x.ts", BROKEN_LINE);
    write("shared/util.ts", BROKEN_LINE);
    const { offenders } = runLint({ cwd: root });
    assert(offenders.length === 3, `all three roots flagged (got ${offenders.length})`);
    assert(
      offenders.some((f) => f.endsWith("scripts/one-off.ts")),
      "scripts/ offender detected (the Task #2846 blind spot)",
    );
    assert(
      offenders.some((f) => f.endsWith("server/services/x.ts")) &&
        offenders.some((f) => f.endsWith("shared/util.ts")),
      "server/ and shared/ coverage preserved",
    );
  } finally {
    cleanup();
  }
}

console.log("3+4) approved form and scalar interpolation pass");
{
  const { root, write, cleanup } = fixture();
  try {
    write("scripts/good.ts", APPROVED_LINE);
    write(
      "server/scalar.ts",
      "await db.execute(sql`SELECT 1 WHERE id = ${id} AND kind = ANY(${bindArrayParam(kinds)})`);\n" +
        "await db.execute(sql`UPDATE t SET n = ${count}::int WHERE d < NOW() - (${days} || ' days')::interval`);\n",
    );
    const { offenders } = runLint({ cwd: root });
    assert(offenders.length === 0, `bindArrayParam form + scalar casts pass (got: ${offenders.join(", ")})`);
  } finally {
    cleanup();
  }
}

console.log("5) comments, strings, and regex literals are masked; template text is not");
{
  const { root, write, cleanup } = fixture();
  try {
    write(
      "scripts/docs-only.ts",
      "// bad shape: ANY(${arr}::text[]) — documentation only\n" +
        "// bare form doc (Task #4303): ANY(${arr}) is broken too\n" +
        "/* block doc:\n   ANY(${arr}::uuid[])\n   ANY(${arr})\n*/\n" +
        'const msg = "never write ANY(${arr}::text[]) directly";\n' +
        'const bareMsg = "never write ANY(${arr}) either";\n' +
        "const single = 'ANY(${arr}::int[]) is broken';\n" +
        "const re = /ANY\\(\\$\\{[^}]+\\}::\\w+\\[\\]\\)/;\n" +
        'const quoteInRegex = s.replace(/"/g, "&quot;");\n' +
        APPROVED_LINE,
    );
    const clean = runLint({ cwd: root });
    assert(clean.offenders.length === 0, "comment/string/regex mentions never trip the lint");

    // Template-literal text stays visible: a genuine offender AFTER a
    // quote-bearing regex literal is still caught (the masking lesson).
    write(
      "scripts/regex-then-offender.ts",
      'const q = s.replace(/"/g, "&quot;");\n' + BROKEN_LINE,
    );
    const dirty = runLint({ cwd: root });
    assert(
      dirty.offenders.length === 1 && dirty.offenders[0].endsWith("scripts/regex-then-offender.ts"),
      "offender after a quote-bearing regex literal is still detected",
    );
  } finally {
    cleanup();
  }
}

console.log("5b) maskSource unit behavior");
{
  const masked = maskSource("// ANY(${a}::text[])\nconst x = sql`ANY(${a}::text[])`;\n");
  assert(!BROKEN.test(masked.split("\n")[0]), "line-comment content masked");
  assert(BROKEN.test(masked), "template-literal content preserved for matching");
  const strMasked = maskSource('const s = "ANY(${a}::text[])";');
  assert(!BROKEN.test(strMasked), "double-quoted string content masked");
  const nested = maskSource("const t = sql`x ${'ANY(${a}::text[])'} y`;");
  assert(!BROKEN.test(nested), "string nested inside a template interpolation is masked");

  // Task #4303 — hasBrokenArrayBinding unit behavior on the bare form.
  assert(
    hasBrokenArrayBinding(maskSource("const x = sql`WHERE id = ANY(${a})`;\n")),
    "bare identifier interpolation detected",
  );
  assert(
    !hasBrokenArrayBinding(maskSource("// ANY(${a}) doc only\n")),
    "bare form inside a comment is masked",
  );
  assert(
    !hasBrokenArrayBinding(maskSource(APPROVED_LINE)),
    "inline bindArrayParam fragment allowed",
  );
  assert(
    !hasBrokenArrayBinding(maskSource(COLUMN_REF_LINE)),
    "drizzle column ref (dotted path) allowed",
  );
  assert(
    hasBrokenArrayBinding(maskSource(CALL_EXPR_LINE)),
    "call expression (Array.from) flagged",
  );
  assert(
    hasBrokenArrayBinding(maskSource("const x = sql`WHERE id = ANY( ${ids} )`;\n")),
    "whitespace around the interpolation still detected",
  );
}

console.log("6) extension handling per the actual corpus");
{
  const { root, write, cleanup } = fixture();
  try {
    write("scripts/broken.mjs", BROKEN_LINE);
    write("scripts/broken.js", BROKEN_LINE);
    write("scripts/notes.md", BROKEN_LINE); // not a scanned extension
    write("scripts/query.sql", "-- ANY(${arr}::text[])\n"); // not scanned
    const { offenders } = runLint({ cwd: root });
    assert(
      offenders.length === 2 &&
        offenders.some((f) => f.endsWith("broken.mjs")) &&
        offenders.some((f) => f.endsWith("broken.js")),
      ".mjs/.js scanned; .md/.sql ignored",
    );
    assert(
      [".ts", ".tsx", ".mjs"].every((e) => SCANNED_EXTENSIONS.includes(e)),
      "scanned-extension set covers the corpus (.ts/.tsx/.mjs at minimum)",
    );
  } finally {
    cleanup();
  }
}

console.log("7) deliberate exclusions stay excluded");
{
  const { root, write, cleanup } = fixture();
  try {
    write("scripts/node_modules/pkg/index.ts", BROKEN_LINE);
    write("server/dist/bundle.js", BROKEN_LINE);
    write("scripts/build/out.ts", BROKEN_LINE);
    write("scripts/.cache/tmp.ts", BROKEN_LINE);
    // Not roots at all — a broken file there is out of scope by construction:
    write("website/public/gen.js", BROKEN_LINE);
    write("artifacts/mockup-sandbox/src/x.ts", BROKEN_LINE);
    const { offenders, scannedRoots } = runLint({ cwd: root });
    assert(offenders.length === 0, `vendored/generated trees excluded (got: ${offenders.join(", ")})`);
    assert(
      !scannedRoots.includes("website") && !scannedRoots.includes("artifacts"),
      "website/ and artifacts/ are deliberately not roots",
    );
  } finally {
    cleanup();
  }
}

console.log("8) cast-less bare form (Task #4303)");
{
  const { root, write, cleanup } = fixture();
  try {
    write("server/bare.ts", BARE_BROKEN_LINE);
    write("scripts/call-expr.ts", CALL_EXPR_LINE);
    write("shared/held.ts", HELD_FRAGMENT_LINES);
    write("server/col-ref.ts", COLUMN_REF_LINE);
    write("server/inline-literal.ts", INLINE_LITERAL_LINE);
    write("scripts/approved-still-good.ts", APPROVED_LINE);
    const { offenders } = runLint({ cwd: root });
    assert(
      offenders.length === 3,
      `bare/call-expr/held flagged; col-ref/inline-literal/bindArrayParam pass (got ${offenders.length}: ${offenders.join(", ")})`,
    );
    assert(
      offenders.some((f) => f.endsWith("server/bare.ts")),
      "bare ANY(${ids}) flagged (the sheets last-activity defect class)",
    );
    assert(
      offenders.some((f) => f.endsWith("scripts/call-expr.ts")),
      "call expression ANY(${Array.from(...)}) flagged",
    );
    assert(
      offenders.some((f) => f.endsWith("shared/held.ts")),
      "variable-held bindArrayParam fragment flagged (inline it at the use site)",
    );
  } finally {
    cleanup();
  }
}

console.log("9) real repository state");
{
  const real = runLint();
  assert(
    real.offenders.length === 0,
    `REAL tree passes for both forms — cast-carrying and cast-less (offenders: ${real.offenders.join(", ")})`,
  );
  assert(
    JSON.stringify(ROOTS) === JSON.stringify(["server", "shared", "scripts"]),
    "ROOTS pinned to server, shared, scripts",
  );
}

console.log("");
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
