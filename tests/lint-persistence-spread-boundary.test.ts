/* test-registration
{
  "name": "lint-persistence-spread-boundary ratchet guard (Task #4201)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4201: guards the F8 regression class — new server sites spreading request-shaped objects into Drizzle .set/.values without Zod validation. Pins the frozen F8-era baseline by sha-256 (allow-list-growth leak protection), proves new raw spreads fail with exact file:line + expression, proves zod-parsed spreads/reviewed markers pass, and that the lint has no write/update path. Fast, DB-free, tmp-fixture based.",
  "tier": "small"
}
test-registration */
/**
 * Task #4201 — guard tests for scripts/lint-persistence-spread-boundary.ts.
 *
 * Spec matrix:
 *   1. The REAL repository passes (every existing site grandfathered by the
 *      frozen snapshot or evidently zod-parsed).
 *   2. The frozen snapshot is content-hash-pinned — widening the ratchet
 *      requires a reviewed edit to BOTH files in one diff.
 *   3. NEW raw spread into .set/.values fails, naming file:line + expression
 *      (the negative case, proven to EXECUTE).
 *   4. Zod-parsed spreads pass: inline `.parse(`/`.safeParse(` in the spread
 *      expression, the `parsed.data` convention when the file parses, and a
 *      bare identifier whose lexical binding AT THE USE SITE is a `const`
 *      declared from `.parse(` earlier in an enclosing scope (F8 cat-6
 *      storage convention) — including through nested callbacks. Rejections
 *      proven: identifier not declared from a parse (even when the file
 *      parses elsewhere), `.safeParse(`-assigned (envelope, not row data),
 *      a PARAMETER shadowing a parse-const in a sibling function, a parse
 *      declaration AFTER the write, and `let`-declared parse results.
 *   5. `// spread-write-approved: <reason>` on the .set/.values line passes;
 *      a marker with a missing/too-short reason fails.
 *   6. Shrink-only: removing a grandfathered site passes; EXCEEDING a frozen
 *      occurrence count fails.
 *   7. The lint source has no fs-write APIs and no update/refresh CLI flag.
 *   8. The env skip announces itself and reports skipped.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  APPROVE_MARKER,
  FROZEN_SPREAD_SITES,
  frozenSnapshotHash,
  runLint,
  scanFileForSpreadSites,
} from "../scripts/lint-persistence-spread-boundary";

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

function fixture(files: Record<string, string>): { root: string; rel: string[]; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lint-spread-boundary-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return { root, rel: Object.keys(files), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(files: Record<string, string>, frozen: ReadonlyMap<string, number> = new Map()) {
  const { root, rel, cleanup } = fixture(files);
  try {
    return runLint({ rootDir: root, files: rel, frozen, skipEnv: undefined });
  } finally {
    cleanup();
  }
}

console.log("1) REAL repository passes under the frozen snapshot");
{
  const real = runLint({ skipEnv: undefined });
  assert(real.ok, `real server/** scan passes (${real.violations.length} violations)`);
  assert(!real.skipped, "real run is not skipped");
  assert(real.sites.length > 0, `real scan finds the grandfathered population (${real.sites.length} sites)`);
}

console.log("2) frozen snapshot is content-hash-pinned");
{
  // Widening the ratchet must edit BOTH the frozen map and this pin.
  assert(
    frozenSnapshotHash() === "7eabdbaa5c832522da075ab6777139847c0af6f0f330a45b3222b16b6f7fe1d9",
    "sha-256 of the sorted frozen entries matches the pin",
  );
  assert(FROZEN_SPREAD_SITES.size === 65, `frozen snapshot has exactly 65 keys (${FROZEN_SPREAD_SITES.size})`);
  const occurrences = [...FROZEN_SPREAD_SITES.values()].reduce((a, b) => a + b, 0);
  assert(occurrences === 96, `frozen snapshot totals exactly 96 occurrences (${occurrences})`);
}

console.log("3) NEW raw spread fails, naming file:line + expression");
{
  const res = run({
    "server/routes/newThing.ts": [
      "export async function handler(req: any) {",
      "  await db.update(widgets).set({ ...req.body, updatedAt: new Date() });",
      "}",
      "",
    ].join("\n"),
  });
  assert(!res.ok, "raw ...req.body spread into .set fails");
  assert(
    res.violations.some(
      (v) => v.message.includes("server/routes/newThing.ts:2") && v.message.includes("req.body"),
    ),
    "violation names the exact file:line and spread expression",
  );

  const vals = run({
    "server/routes/newThing.ts": "await db.insert(widgets).values({ ...payload });\n",
  });
  assert(!vals.ok, "raw spread into .values fails too");
}

console.log("4) zod-parsed spreads pass");
{
  const inline = run({
    "server/routes/ok.ts": "await db.update(w).set({ ...schema.parse(req.body) });\n",
  });
  assert(inline.ok, "inline .parse( in the spread expression passes");

  const parsedData = run({
    "server/routes/ok2.ts": [
      "const parsed = updateSchema.safeParse(req.body);",
      "if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });",
      "await db.update(w).set({ ...parsed.data, updatedAt: new Date() });",
      "",
    ].join("\n"),
  });
  assert(parsedData.ok, "parsed.data convention (safeParse in same file) passes");

  const bareData = run({
    "server/routes/notok.ts": "await db.update(w).set({ ...thing.data });\n",
  });
  assert(!bareData.ok, "'.data' spread WITHOUT any zod parse in the file still fails");

  const parseAssigned = run({
    "server/storage/ok3.ts": [
      "export async function update(id: string, data: UpdateThing) {",
      "  const patch = updateThingSchema.parse(data);",
      "  await db.update(w).set({ ...patch, updatedAt: new Date() });",
      "}",
      "",
    ].join("\n"),
  });
  assert(parseAssigned.ok, "bare identifier declared from .parse( in the same file passes (F8 cat-6 storage convention)");

  const parseElsewhere = run({
    "server/storage/notok2.ts": [
      "const other = someSchema.parse(x);",
      "const patch = req.body;",
      "await db.update(w).set({ ...patch });",
      "",
    ].join("\n"),
  });
  assert(!parseElsewhere.ok, "identifier NOT declared from a parse fails even when the file parses elsewhere");

  const safeParseAssigned = run({
    "server/storage/notok3.ts": [
      "const patch = updateThingSchema.safeParse(data);",
      "await db.update(w).set({ ...patch });",
      "",
    ].join("\n"),
  });
  assert(!safeParseAssigned.ok, "identifier declared from .safeParse( (envelope, not row data) still fails");

  // Binding resolution is per USE SITE (review-directed hardening): a parse
  // const in ONE function must not launder a same-named raw parameter
  // spread in a SIBLING function.
  const shadowedParam = run({
    "server/storage/notok4.ts": [
      "export function safeUpdate(data: unknown) {",
      "  const patch = updateThingSchema.parse(data);",
      "  return patch;",
      "}",
      "export async function unsafeUpdate(patch: any) {",
      "  await db.update(w).set({ ...patch });",
      "}",
      "",
    ].join("\n"),
  });
  assert(
    !shadowedParam.ok,
    "parameter spread fails even when a sibling function declares a parse-const of the same name (shadowing)",
  );

  const parseAfterWrite = run({
    "server/storage/notok5.ts": [
      "export async function update(x: unknown) {",
      "  await db.update(w).set({ ...cfg });",
      "  const cfg = updateThingSchema.parse(x);",
      "}",
      "",
    ].join("\n"),
  });
  assert(!parseAfterWrite.ok, "parse declaration AFTER the write fails (ordering-aware)");

  const letAssigned = run({
    "server/storage/notok6.ts": [
      "let patch = updateThingSchema.parse(data);",
      "await db.update(w).set({ ...patch });",
      "",
    ].join("\n"),
  });
  assert(!letAssigned.ok, "let-declared parse result fails (reassignable binding; const-only)");

  const closureSpread = run({
    "server/storage/ok4.ts": [
      "export async function update(data: unknown) {",
      "  const parsed = updateThingSchema.parse(data);",
      "  await db.transaction(async (tx) => {",
      "    await tx.update(w).set({ ...parsed, updatedAt: new Date() });",
      "  });",
      "}",
      "",
    ].join("\n"),
  });
  assert(closureSpread.ok, "parse-const spread through a nested callback (transaction shape) still passes");
}

console.log("5) reviewed approval marker semantics");
{
  const approved = run({
    "server/services/internal.ts":
      `await db.update(w).set({ ...internalPatch }); // ${APPROVE_MARKER} internal worker literal, no request-shaped caller\n`,
  });
  assert(approved.ok, "marker with a substantive reason passes");

  const bareMarker = run({
    "server/services/internal.ts": `await db.update(w).set({ ...internalPatch }); // ${APPROVE_MARKER}\n`,
  });
  assert(!bareMarker.ok, "marker without a reason fails");
  assert(
    bareMarker.violations.some((v) => v.message.includes("reason")),
    "the reasonless-marker violation says the reason is missing",
  );
}

console.log("6) shrink-only ratchet semantics");
{
  const frozen = new Map<string, number>([
    ["server/storage/x.ts::set::data", 1],
    ["server/storage/gone.ts::set::stuff", 2],
  ]);
  const shrink = run({ "server/storage/x.ts": "await db.update(t).set({ ...data });\n" }, frozen);
  assert(shrink.ok, "grandfathered site passes; vanished frozen entries are fine (shrink allowed)");

  const exceed = run(
    {
      "server/storage/x.ts": [
        "await db.update(t).set({ ...data });",
        "await db.update(t2).set({ ...data });",
        "",
      ].join("\n"),
    },
    frozen,
  );
  assert(!exceed.ok, "a second occurrence beyond the frozen count fails");
}

console.log("7) no write/update path in the lint source");
{
  const src = readFileSync("scripts/lint-persistence-spread-boundary.ts", "utf8");
  assert(
    !/\b(writeFileSync|appendFileSync|createWriteStream|writeFile|rmSync|renameSync)\s*\(/.test(src),
    "lint source calls no fs-write APIs",
  );
  assert(
    !/argv\.slice|argv\.includes|parseArgs|of process\.argv/.test(src),
    "lint source parses no CLI flags (no --update-style regen path)",
  );
}

console.log("8) env skip announces itself");
{
  const res = runLint({ files: [], skipEnv: "1" });
  assert(res.ok && res.skipped, "skipEnv=1 reports skipped:true");
}

console.log("9) scanner shape sanity (masking + nesting)");
{
  const src = [
    "// comment mentioning .set({ ...req.body }) must not count",
    'const s = ".values({ ...req.body })";',
    "await db.update(t).set({ nested: { ...req.body } });",
    "",
  ].join("\n");
  const sites = scanFileForSpreadSites("server/routes/s.ts", src);
  assert(sites.length === 1 && sites[0].line === 3, "comments/strings masked; nested spreads inside the argument object counted");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
