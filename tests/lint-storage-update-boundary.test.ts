/* test-registration
{
  "name": "lint-storage-update-boundary ratchet guard (Task #4250)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4250: keeps the F8 storage-signature hole closed — a NEW server/storage function taking a broad Partial<Insert*-or-Select*> patch and feeding it raw into Drizzle .set() must fail. Pins the frozen grandfather baseline by sha-256 (allow-list-growth leak protection), proves new broad-param raw flows fail with exact file:line + function + param (direct .set(data), spread, and one-hop staging consts), proves the hardened parse-then-set convention and dedicated narrow-writer types (Partial<Pick>, named aliases like UpdatableCommFields) pass, marker semantics, shrink-only ratchet, and no write/update path. Fast, DB-free, tmp-fixture based.",
  "tier": "small"
}
test-registration */
/**
 * Task #4250 — guard tests for scripts/lint-storage-update-boundary.ts.
 *
 * Spec matrix:
 *   1. The REAL repository passes (every existing broad-param flow
 *      grandfathered by the frozen snapshot).
 *   2. The frozen snapshot is content-hash-pinned — widening the ratchet
 *      requires a reviewed edit to BOTH files in one diff.
 *   3. NEW broad-param raw flows fail, naming file:line + function + param:
 *      direct `.set(data)`, `.set({ ...data })`, and the one-hop
 *      `const updates = { ...data }; .set(updates)` staging shape — including
 *      through a transaction callback.
 *   4. The hardened convention passes: `const parsed = schema.parse(data)`
 *      then `.set({ ...parsed })` — the call result is the sanctioning
 *      boundary, so the parsed binding is untainted.
 *   5. Narrow signatures pass: `Partial<Pick<...>>`, named alias types
 *      (UpdatableCommFields-style), zod-inferred Update* types; while
 *      `Partial<Omit<Insert*, ...>>` still counts as broad. An inner
 *      closure parameter shadowing the broad name is a different variable.
 *   6. `// storage-broad-update-approved: <reason>` on the .set line passes;
 *      a marker with a missing/too-short reason fails.
 *   7. Shrink-only: vanished frozen entries pass; EXCEEDING a frozen
 *      occurrence count fails.
 *   8. The lint source has no fs-write APIs and no update/refresh CLI flag.
 *   9. The env skip announces itself and reports skipped.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  APPROVE_MARKER,
  FROZEN_BROAD_UPDATE_SITES,
  frozenSnapshotHash,
  runLint,
  scanFileForBroadUpdateSites,
} from "../scripts/lint-storage-update-boundary";

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
  const root = mkdtempSync(join(tmpdir(), "lint-storage-update-"));
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
  assert(real.ok, `real server/storage/** scan passes (${real.violations.length} violations)`);
  assert(!real.skipped, "real run is not skipped");
  // Task #4380 closed the entire grandfathered population — the real repo
  // must contain ZERO broad-param raw `.set(` flows from here on.
  assert(real.sites.length === 0, `real scan finds no broad-update sites (${real.sites.length} sites)`);
}

console.log("2) frozen snapshot is content-hash-pinned");
{
  // Widening the ratchet must edit BOTH the frozen map and this pin.
  // Task #4380: the grandfathered population is fully converted; the frozen
  // map is permanently EMPTY (sha-256 of the empty entry list). Re-adding
  // any entry must edit BOTH the frozen map and this pin.
  assert(
    frozenSnapshotHash() === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "sha-256 of the sorted frozen entries matches the empty-map pin",
  );
  assert(
    FROZEN_BROAD_UPDATE_SITES.size === 0,
    `frozen snapshot has exactly 0 keys (${FROZEN_BROAD_UPDATE_SITES.size})`,
  );
  const occurrences = [...FROZEN_BROAD_UPDATE_SITES.values()].reduce((a, b) => a + b, 0);
  assert(occurrences === 0, `frozen snapshot totals exactly 0 occurrences (${occurrences})`);
}

console.log("3) NEW broad-param raw flows fail, naming file:line + function + param");
{
  const direct = run({
    "server/storage/newStorage.ts": [
      "export async function updateWidget(id: string, data: Partial<InsertWidget>) {",
      "  await db.update(widgets).set(data).where(eq(widgets.id, id));",
      "}",
      "",
    ].join("\n"),
  });
  assert(!direct.ok, "direct .set(data) of a Partial<Insert*> parameter fails");
  assert(
    direct.violations.some(
      (v) =>
        v.message.includes("server/storage/newStorage.ts:2") &&
        v.message.includes("updateWidget") &&
        v.message.includes("data"),
    ),
    "violation names file:line, function, and parameter",
  );

  const spread = run({
    "server/storage/s2.ts": [
      "export async function updateThing(id: string, patch: Partial<SelectThing>) {",
      "  await db.update(things).set({ ...patch, updatedAt: new Date() });",
      "}",
      "",
    ].join("\n"),
  });
  assert(!spread.ok, ".set({ ...patch }) spread of a Partial<Select*> parameter fails");

  const staged = run({
    "server/storage/s3.ts": [
      "export async function updateThing(id: string, data: Partial<InsertThing>) {",
      "  const updates = { ...data, updatedAt: new Date() };",
      "  await db.update(things).set(updates);",
      "}",
      "",
    ].join("\n"),
  });
  assert(!staged.ok, "one-hop staging const built from the broad param still fails (taint propagation)");

  const aliased = run({
    "server/storage/s4.ts": [
      "export async function updateThing(id: string, data: Partial<InsertThing>) {",
      "  const same = data;",
      "  const updates = { ...same };",
      "  await db.transaction(async (tx) => {",
      "    await tx.update(things).set(updates);",
      "  });",
      "}",
      "",
    ].join("\n"),
  });
  assert(!aliased.ok, "alias + staging + transaction-callback flow still fails (fixpoint through closures)");

  const intersect = run({
    "server/storage/s5.ts": [
      "export async function updateThing(id: string, patch: Partial<InsertThing> & { updatedAt?: Date }) {",
      "  await db.update(things).set(patch);",
      "}",
      "",
    ].join("\n"),
  });
  assert(!intersect.ok, "intersection type Partial<Insert*> & {...} still counts as broad");

  const omit = run({
    "server/storage/s6.ts": [
      'export async function updateThing(id: string, patch: Partial<Omit<InsertThing, "id">>) {',
      "  await db.update(things).set(patch);",
      "}",
      "",
    ].join("\n"),
  });
  assert(!omit.ok, "Partial<Omit<Insert*, ...>> still counts as broad (Omit stays full-row-shaped)");
}

console.log("4) hardened parse-then-set convention passes");
{
  const parsed = run({
    "server/storage/ok1.ts": [
      "export async function updateThing(id: string, data: Partial<InsertThing>) {",
      "  const parsed = updateThingSchema.parse(data);",
      "  await db.update(things).set({ ...parsed, updatedAt: new Date() });",
      "}",
      "",
    ].join("\n"),
  });
  assert(parsed.ok, "const parsed = schema.parse(data) → .set({ ...parsed }) passes (parse is the boundary)");

  const inline = run({
    "server/storage/ok2.ts": [
      "export async function updateThing(id: string, data: Partial<InsertThing>) {",
      "  await db.update(things).set(updateThingSchema.parse(data));",
      "}",
      "",
    ].join("\n"),
  });
  assert(inline.ok, "inline .set(schema.parse(data)) passes (call result, not the raw param)");
}

console.log("5) narrow signatures pass; shadowing is scope-aware");
{
  const pick = run({
    "server/storage/ok3.ts": [
      'export async function updateFolder(id: string, patch: Partial<Pick<InsertSheetFolder, "name" | "sortOrder">>) {',
      "  await db.update(folders).set(patch);",
      "}",
      "",
    ].join("\n"),
  });
  assert(pick.ok, "Partial<Pick<...>> (explicit field whitelist) passes");

  const namedAlias = run({
    "server/storage/ok4.ts": [
      'type UpdatableCommFields = Omit<Partial<RawCommunicationRecord>, "isTouchpoint" | "id">;',
      "export async function updateRawCommunication(id: string, data: UpdatableCommFields) {",
      "  await db.update(comms).set(data);",
      "}",
      "",
    ].join("\n"),
  });
  assert(namedAlias.ok, "named reviewed alias type (UpdatableCommFields-style) passes");

  const zodType = run({
    "server/storage/ok5.ts": [
      "export async function updateThing(id: string, data: UpdateThing) {",
      "  await db.update(things).set(data);",
      "}",
      "",
    ].join("\n"),
  });
  assert(zodType.ok, "zod-inferred Update* type passes");

  const shadowed = run({
    "server/storage/ok6.ts": [
      "export async function updateThing(id: string, data: Partial<InsertThing>) {",
      "  const parsed = updateThingSchema.parse(data);",
      "  await withRetry(async (data: SafeRow) => {",
      "    await db.update(things).set(data);",
      "  });",
      "  return parsed;",
      "}",
      "",
    ].join("\n"),
  });
  assert(shadowed.ok, "inner closure param shadowing the broad name is a different variable (no false hit)");
}

console.log("6) reviewed approval marker semantics");
{
  const approved = run({
    "server/storage/internal.ts": [
      "export async function markRunFinished(id: string, patch: Partial<InsertRunRow>) {",
      `  await db.update(runs).set(patch); // ${APPROVE_MARKER} internal worker literal, no request-shaped caller`,
      "}",
      "",
    ].join("\n"),
  });
  assert(approved.ok, "marker with a substantive reason passes");

  const bareMarker = run({
    "server/storage/internal.ts": [
      "export async function markRunFinished(id: string, patch: Partial<InsertRunRow>) {",
      `  await db.update(runs).set(patch); // ${APPROVE_MARKER}`,
      "}",
      "",
    ].join("\n"),
  });
  assert(!bareMarker.ok, "marker without a reason fails");
  assert(
    bareMarker.violations.some((v) => v.message.includes("reason")),
    "the reasonless-marker violation says the reason is missing",
  );
}

console.log("7) shrink-only ratchet semantics");
{
  const frozen = new Map<string, number>([
    ["server/storage/x.ts::updateX::data", 1],
    ["server/storage/gone.ts::updateGone::patch", 2],
  ]);
  const shrink = run(
    {
      "server/storage/x.ts": [
        "export async function updateX(id: string, data: Partial<InsertX>) {",
        "  await db.update(t).set(data);",
        "}",
        "",
      ].join("\n"),
    },
    frozen,
  );
  assert(shrink.ok, "grandfathered site passes; vanished frozen entries are fine (shrink allowed)");

  const exceed = run(
    {
      "server/storage/x.ts": [
        "export async function updateX(id: string, data: Partial<InsertX>) {",
        "  await db.update(t).set(data);",
        "  await db.update(t2).set({ ...data });",
        "}",
        "",
      ].join("\n"),
    },
    frozen,
  );
  assert(!exceed.ok, "a second raw flow beyond the frozen count fails");
}

console.log("8) no write/update path in the lint source");
{
  const src = readFileSync("scripts/lint-storage-update-boundary.ts", "utf8");
  assert(
    !/\b(writeFileSync|appendFileSync|createWriteStream|writeFile|rmSync|renameSync)\s*\(/.test(src),
    "lint source calls no fs-write APIs",
  );
  assert(
    !/argv\.slice|argv\.includes|parseArgs|of process\.argv/.test(src),
    "lint source parses no CLI flags (no --update-style regen path)",
  );
}

console.log("9) env skip announces itself");
{
  const res = runLint({ files: [], skipEnv: "1" });
  assert(res.ok && res.skipped, "skipEnv=1 reports skipped:true");
}

console.log("10) scanner shape sanity");
{
  const src = [
    "// comment: .set(data) on a Partial<InsertX> must not count",
    'const s = "set(data) Partial<InsertX>";',
    "export async function updateX(id: string, data: Partial<InsertX>) {",
    "  await db.update(t).set(data);",
    "}",
    "",
  ].join("\n");
  const sites = scanFileForBroadUpdateSites("server/storage/s.ts", src);
  assert(
    sites.length === 1 && sites[0].line === 4 && sites[0].fnName === "updateX",
    "comments/strings are inert (AST-based); the real flow is found at the right line",
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
