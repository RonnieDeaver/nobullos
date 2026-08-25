/* test-registration
{
  "name": "lint-upload-content-verification guard (Task #3984)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3984: guards the upload accept-path lint — per-call-site ordered verification for ACL stamping (import-only / unrelated-function / after-the-stamp verify all fail), awaited-invocation requirement for request-supplied /objects/ handling, the HEAL_FILE-scoped heatmap heal exemption, allow-list + staleness semantics, and literal masking. Pins the real FILE_ALLOWLIST so it cannot silently grow. Fast, DB-free, deterministic (tmp fixtures + real server/ scan).",
  "tier": "small"
}
test-registration */
/**
 * Task #3984 — guard tests for scripts/lint-upload-content-verification.ts.
 *
 * Fixture matrix:
 *   1. trySetObjectEntityAclPolicy call sites require an ORDERED verify
 *      invocation in the SAME function body: no verify → fail; verify
 *      before → pass; import/reference-only (no invocation) → fail; verify
 *      in an UNRELATED function → fail; verify AFTER the stamp → fail.
 *   2. Request-supplied /objects/ handling (literal + req input) requires an
 *      AWAITED verify invocation in the file: none → fail; awaited → pass;
 *      un-awaited reference → fail; literal without request input → clean.
 *   3. Heal exemption is scoped: helper-named function in HEAL_FILE passes;
 *      the SAME code in any other file fails; a heal file that also
 *      independently trips signal B still fails signal B.
 *   4. Masking: signals inside comments/strings never trip.
 *   5. FILE_ALLOWLIST: listed signal-B offender passes; allow-list does NOT
 *      excuse signal-A stamp sites; stale entries (non-suspect / missing
 *      file) fail; missing HEAL_FILE is flagged stale.
 *   6. The object_storage module dir itself is excluded from the scan.
 * Plus repo-level pins: the real server/ tree passes, and FILE_ALLOWLIST is
 * exactly the audited read-only consumer set.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  runLint,
  maskLiterals,
  FILE_ALLOWLIST,
  HEAL_HELPER_ALLOWLIST,
  HEAL_FILE,
  type FileAllowlistEntry,
} from "../scripts/lint-upload-content-verification";

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

function run(
  files: Record<string, string>,
  opts: { allowList?: FileAllowlistEntry[]; healFileRel?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "lint-upload-verify-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    const allowList = (opts.allowList ?? []).map((e) => ({
      ...e,
      file: join(root, "server", e.file),
    }));
    // Default heal file: an existing empty placeholder so fixtures that don't
    // exercise the heal exemption never trip its staleness check.
    let healFile = join(root, "server/__heal_placeholder__.ts");
    if (opts.healFileRel) healFile = join(root, opts.healFileRel);
    if (!Object.keys(files).some((rel) => join(root, rel) === healFile)) {
      mkdirSync(dirname(healFile), { recursive: true });
      writeFileSync(healFile, "export {};\n");
    }
    return runLint({
      root: join(root, "server"),
      excludeDir: join(root, "server/replit_integrations/object_storage"),
      allowList,
      healFile,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const STAMP_NO_VERIFY = `
export async function claim(storage: any, req: any) {
  const objectPath = req.body.objectPath;
  await storage.trySetObjectEntityAclPolicy(objectPath, { owner: "u", visibility: "public" });
}
`;

const STAMP_WITH_ORDERED_VERIFY = `
export async function claim(storage: any, req: any) {
  const objectPath = req.body.objectPath;
  const verdict = await storage.verifyObjectEntityContent(objectPath, { kinds: {} });
  if (!verdict.ok) return;
  await storage.trySetObjectEntityAclPolicy(objectPath, { owner: "u", visibility: "public" });
}
`;

console.log("1) ACL stamping: per-call-site ordered verification");
{
  const r1 = run({ "server/routes/x.ts": STAMP_NO_VERIFY });
  assert(!r1.ok && r1.offenders.length === 1, "unverified trySetObjectEntityAclPolicy call site fails");
  assert(
    r1.offenders[0]?.reason.includes("no preceding") &&
      r1.offenders[0]?.reason.includes("function claim"),
    "offender reason names the call site's enclosing function",
  );
  const r2 = run({ "server/routes/x.ts": STAMP_WITH_ORDERED_VERIFY });
  assert(r2.ok && r2.verifiedStampSites === 1, "verify invoked BEFORE the stamp in the same function passes");

  const importOnly = `
import { verifyObjectEntityContent } from "../replit_integrations/object_storage/uploadContentVerification";
const ref = verifyObjectEntityContent; // referenced, never invoked
export async function claim(storage: any, req: any) {
  await storage.trySetObjectEntityAclPolicy(req.body.objectPath, { owner: "u", visibility: "public" });
}
`;
  const r3 = run({ "server/routes/imp.ts": importOnly });
  assert(!r3.ok, "importing/referencing the verifier without invoking it fails");

  const unrelatedFn = `
export async function elsewhere(storage: any) {
  await storage.verifyObjectEntityContent("/objects/other", { kinds: {} });
}
export async function claim(storage: any, req: any) {
  await storage.trySetObjectEntityAclPolicy(req.body.objectPath, { owner: "u", visibility: "public" });
}
`;
  const r4 = run({ "server/routes/unrelated.ts": unrelatedFn });
  assert(!r4.ok, "verify invocation in an UNRELATED function does not excuse the stamp");

  const verifyAfter = `
export async function claim(storage: any, req: any) {
  const objectPath = req.body.objectPath;
  await storage.trySetObjectEntityAclPolicy(objectPath, { owner: "u", visibility: "public" });
  await storage.verifyObjectEntityContent(objectPath, { kinds: {} }); // too late
}
`;
  const r5 = run({ "server/routes/after.ts": verifyAfter });
  assert(!r5.ok, "verify invoked AFTER the stamp fails (ordering enforced)");

  // Direct (imported-function) invocations in statement/block position must
  // count as call sites — the bare-call bypass the review flagged.
  const directCallNoVerify = `
import { trySetObjectEntityAclPolicy } from "../replit_integrations/object_storage/objectStorage";
export async function claim(req: any) {
  const p = req.body.objectPath;
  trySetObjectEntityAclPolicy(p, { owner: "u", visibility: "public" });
}
`;
  const r6 = run({ "server/routes/direct.ts": directCallNoVerify });
  assert(!r6.ok, "bare direct invocation at block start is a call site and fails without verify");
  const directAfterSemicolon = `
import { trySetObjectEntityAclPolicy } from "../replit_integrations/object_storage/objectStorage";
export async function claim(req: any) {
  const p = req.body.objectPath; trySetObjectEntityAclPolicy(p, { owner: "u", visibility: "public" });
}
`;
  const r7 = run({ "server/routes/direct2.ts": directAfterSemicolon });
  assert(!r7.ok, "bare direct invocation after a semicolon is a call site and fails without verify");
  const directWithVerify = `
import { trySetObjectEntityAclPolicy } from "../replit_integrations/object_storage/objectStorage";
export async function claim(storage: any, req: any) {
  const p = req.body.objectPath;
  const verdict = await storage.verifyObjectEntityContent(p, { kinds: {} });
  if (!verdict.ok) return;
  trySetObjectEntityAclPolicy(p, { owner: "u", visibility: "public" });
}
`;
  const r8 = run({ "server/routes/direct3.ts": directWithVerify });
  assert(r8.ok && r8.verifiedStampSites === 1, "bare direct invocation with preceding same-function verify passes");
  const interfaceSig = `
export interface AclStorage {
  getObjectEntityAclPolicy(objectPath: string): Promise<any>;
  trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: any,
  ): Promise<string>;
}
export type AclStorageAlias = {
  trySetObjectEntityAclPolicy(rawPath: string, aclPolicy: any): Promise<string>;
};
export const x = 1;
`;
  const r9 = run({ "server/routes/iface.ts": interfaceSig });
  assert(r9.ok && r9.scanned === 0, "interface/type-literal method signatures are NOT call sites");

  // Reviewer bypass #3: a verifier invocation inside a NESTED function/arrow
  // declared earlier in the same outer body need not execute — it must NOT
  // satisfy the outer stamp.
  const nestedVerifier = `
export async function claim(storage: any, req: any) {
  const helper = async () => {
    await storage.verifyObjectEntityContent(req.body.objectPath, { kinds: {} });
  };
  void helper; // declared but never invoked
  await storage.trySetObjectEntityAclPolicy(req.body.objectPath, { owner: "u", visibility: "public" });
}
`;
  const r10 = run({ "server/routes/nested.ts": nestedVerifier });
  assert(!r10.ok, "verify inside an uninvoked NESTED function does not excuse the outer stamp");

  // Class methods are real enclosing scopes: a stamp in one method is not
  // excused by verification in ANOTHER method…
  const classUnrelatedMethod = `
export class Uploader {
  async elsewhere(storage: any) {
    await storage.verifyObjectEntityContent("/objects/other", { kinds: {} });
  }
  async claim(storage: any, req: any) {
    await storage.trySetObjectEntityAclPolicy(req.body.objectPath, { owner: "u", visibility: "public" });
  }
}
`;
  const r11 = run({ "server/routes/cls.ts": classUnrelatedMethod });
  assert(!r11.ok, "class-method stamp is not excused by verification in a DIFFERENT method");

  // …but IS verified by an ordered verify in the SAME method body.
  const classSameMethod = `
export class Uploader {
  async claim(storage: any, req: any) {
    const verdict = await storage.verifyObjectEntityContent(req.body.objectPath, { kinds: {} });
    if (!verdict.ok) return;
    await storage.trySetObjectEntityAclPolicy(req.body.objectPath, { owner: "u", visibility: "public" });
  }
}
`;
  const r12 = run({ "server/routes/cls2.ts": classSameMethod });
  assert(r12.ok && r12.verifiedStampSites === 1, "class-method stamp with ordered same-method verify passes");
}

// Task #4023: the general client-file claim verifier is part of the accepted
// verifier contract — an ordered same-scope invocation passes, while the
// missing (generic STAMP_NO_VERIFY above), late, and nested-uninvoked shapes
// still fail for the new name exactly like the legacy names.
console.log("\n1b) general client-file verifier (verifyClientFileObjectContent)");
{
  const clientFileOrdered = `
export async function claim(storage: any, req: any) {
  const objectPath = req.body.objectPath;
  const verdict = await storage.verifyClientFileObjectContent(objectPath, "client-1");
  if (!verdict.ok) return;
  await storage.trySetObjectEntityAclPolicy(objectPath, { owner: "u", visibility: "private" });
}
`;
  const r1 = run({ "server/routes/cf.ts": clientFileOrdered });
  assert(
    r1.ok && r1.verifiedStampSites === 1,
    "verifyClientFileObjectContent invoked BEFORE the stamp in the same function passes",
  );

  const clientFileLate = `
export async function claim(storage: any, req: any) {
  const objectPath = req.body.objectPath;
  await storage.trySetObjectEntityAclPolicy(objectPath, { owner: "u", visibility: "private" });
  await storage.verifyClientFileObjectContent(objectPath, "client-1"); // too late
}
`;
  const r2 = run({ "server/routes/cf2.ts": clientFileLate });
  assert(!r2.ok, "verifyClientFileObjectContent AFTER the stamp fails (ordering enforced for the new name too)");

  const clientFileNested = `
export async function claim(storage: any, req: any) {
  const helper = async () => {
    await storage.verifyClientFileObjectContent(req.body.objectPath, "client-1");
  };
  void helper; // declared but never invoked
  await storage.trySetObjectEntityAclPolicy(req.body.objectPath, { owner: "u", visibility: "private" });
}
`;
  const r3 = run({ "server/routes/cf3.ts": clientFileNested });
  assert(!r3.ok, "verifyClientFileObjectContent inside an uninvoked NESTED arrow does not excuse the stamp");

  const clientFileSignalB = `
export async function submit(storage: any, req: any, db: any) {
  const p = req.body.objectPath;
  if (typeof p !== "string" || !p.startsWith("/objects/")) return;
  const verdict = await storage.verifyClientFileObjectContent(p, "client-1");
  if (!verdict.ok) return;
  return db.insert({ path: p });
}
`;
  const r4 = run({ "server/routes/cf4.ts": clientFileSignalB });
  assert(
    r4.ok && r4.verifiedRequestFiles === 1,
    "awaited verifyClientFileObjectContent satisfies signal B for request-supplied /objects/ paths",
  );
}

console.log("\n2) request-supplied /objects/ handling requires an awaited verify invocation");
{
  const persistNoVerify = `
export function submit(req: any, db: any) {
  const p = req.body.objectPath;
  if (typeof p !== "string" || !p.startsWith("/objects/")) return;
  return db.insert({ path: p });
}
`;
  const r1 = run({ "server/routes/y.ts": persistNoVerify });
  assert(!r1.ok && r1.offenders.length === 1, "persisting a request /objects/ path without verify fails");
  const withAwaitedVerify = `
export async function submit(storage: any, req: any, db: any) {
  const p = req.body.objectPath;
  if (typeof p !== "string" || !p.startsWith("/objects/")) return;
  const verdict = await storage.verifyObjectEntityContent(p, { kinds: {} });
  if (!verdict.ok) return;
  return db.insert({ path: p });
}
`;
  const r2 = run({ "server/routes/y.ts": withAwaitedVerify });
  assert(r2.ok && r2.verifiedRequestFiles === 1, "awaited verify invocation in the file passes");
  const unawaited = persistNoVerify.replace(
    "return db.insert",
    "const f = storage.verifyObjectEntityContent; void f;\n  return db.insert",
  );
  const r3 = run({ "server/routes/y.ts": unawaited });
  assert(!r3.ok, "un-awaited verifier reference does not satisfy signal B");
  const literalOnly = `
export function serve() {
  return "/objects/static-banner.png"; // no request input in this file
}
`;
  const r4 = run({ "server/routes/z.ts": literalOnly });
  assert(r4.ok && r4.scanned === 0, "an /objects/ literal WITHOUT request input is not a suspect");
}

console.log("\n3) heal exemption is scoped to helper functions inside HEAL_FILE");
{
  const healHelper = `
export async function setHeatmapObjectPublic(storage: any, objectPath: string, owner: string) {
  await storage.trySetObjectEntityAclPolicy(objectPath, { owner, visibility: "public" });
}
`;
  const HEAL_REL = "server/services/heatmapImageAcl.ts";
  const r1 = run({ [HEAL_REL]: healHelper }, { healFileRel: HEAL_REL });
  assert(r1.ok && r1.healExcusedSites === 1, "helper-named stamp site inside HEAL_FILE is excused");
  const r2 = run({ "server/routes/copycat.ts": healHelper }, { healFileRel: HEAL_REL + "x" });
  assert(!r2.ok, "identical helper-named code OUTSIDE HEAL_FILE is NOT excused");
  const healPlusRequestPersist = `
export async function setHeatmapObjectPublic(storage: any, objectPath: string, owner: string) {
  await storage.trySetObjectEntityAclPolicy(objectPath, { owner, visibility: "public" });
}
export function persistFromRequest(req: any, db: any) {
  const p = req.body.objectPath;
  if (!p.startsWith("/objects/")) return;
  return db.insert({ path: p });
}
`;
  const r3 = run({ [HEAL_REL]: healPlusRequestPersist }, { healFileRel: HEAL_REL });
  assert(
    !r3.ok && r3.offenders.some((o) => o.reason.includes("request-supplied")),
    "HEAL_FILE tripping signal B independently still fails signal B",
  );
}

console.log("\n4) masking — signals in comments/strings never trip");
{
  const commentOnly = `
// trySetObjectEntityAclPolicy( is discussed here, and req.body too
const doc = "call trySetObjectEntityAclPolicy( with req.body";
export const x = 1;
`;
  const r = run({ "server/routes/doc.ts": commentOnly });
  assert(r.ok && r.scanned === 0, "commented/quoted signals are masked out");
  const masked = maskLiterals('const a = "trySetObjectEntityAclPolicy(";');
  assert(!masked.includes("trySetObjectEntityAclPolicy"), "maskLiterals blanks string contents");
}

console.log("\n5) allow-list scope + staleness");
{
  const requestOnlyReader = `
export async function analyze(req: any, dl: any) {
  const p = req.body.objectStoragePath;
  if (typeof p !== "string" || !p.startsWith("/objects/")) return;
  return dl.download(p);
}
`;
  const r1 = run(
    { "server/routes/reader.ts": requestOnlyReader },
    { allowList: [{ file: "routes/reader.ts", reason: "test read-only exception" }] },
  );
  assert(r1.ok && r1.allowListedCount === 1, "allow-listed signal-B file passes");
  const r2 = run(
    { "server/routes/x.ts": STAMP_NO_VERIFY },
    { allowList: [{ file: "routes/x.ts", reason: "should not excuse stamps" }] },
  );
  assert(!r2.ok, "FILE_ALLOWLIST does NOT excuse unverified ACL stamp call sites");
  const r3 = run(
    { "server/routes/clean.ts": "export const a = 1;\n" },
    { allowList: [{ file: "routes/clean.ts", reason: "stale" }] },
  );
  assert(
    !r3.ok && r3.stale.some((s) => s.includes("no longer handles")),
    "allow-list entry for a non-suspect file is flagged stale",
  );
  const r4 = run(
    { "server/routes/x.ts": STAMP_WITH_ORDERED_VERIFY },
    { allowList: [{ file: "routes/gone.ts", reason: "stale" }] },
  );
  assert(!r4.ok && r4.stale.some((s) => s.includes("no longer exists")), "missing allow-listed file is flagged stale");
  const rHeal = runLint({
    root: "server",
    excludeDir: "server/replit_integrations/object_storage",
    allowList: FILE_ALLOWLIST,
    healFile: "server/services/__definitely_missing__.ts",
  });
  assert(
    !rHeal.ok && rHeal.stale.some((s) => s.includes("HEAL_FILE")),
    "a missing HEAL_FILE is flagged stale",
  );
}

console.log("\n6) object_storage module dir is excluded");
{
  const r = run({
    "server/replit_integrations/object_storage/objectStorage.ts": STAMP_NO_VERIFY,
  });
  assert(r.ok && r.scanned === 0, "files inside the excluded module dir are never suspects");
}

console.log("\n7) real repo scan + pinned exception sets");
{
  const real = runLint();
  assert(
    real.ok,
    `real server/ tree passes (${real.scanned} suspect files: ${real.verifiedStampSites} verified stamp sites, ${real.healExcusedSites} heal-excused, ${real.verifiedRequestFiles} verified request files, ${real.allowListedCount} allow-listed)`,
  );
  if (!real.ok) {
    for (const o of real.offenders) console.error(`    offender: ${o.file}: ${o.reason}`);
    for (const s of real.stale) console.error(`    stale: ${s}`);
  }
  assert(real.healExcusedSites >= 1, "the real heal helper's stamp site is excused via HEAL_FILE (exemption not dead code)");
  assert(
    FILE_ALLOWLIST.length === 1 && FILE_ALLOWLIST[0].file === "server/routes/videoAnalysis.ts",
    "FILE_ALLOWLIST is exactly the audited read-only consumer (videoAnalysis)",
  );
  assert(
    HEAL_HELPER_ALLOWLIST.length === 2 &&
      HEAL_HELPER_ALLOWLIST.includes("setHeatmapObjectPublic") &&
      HEAL_HELPER_ALLOWLIST.includes("ensureHeatmapImagesPublic") &&
      HEAL_FILE === "server/services/heatmapImageAcl.ts",
    "heal exemption is pinned to the two heatmap heal helpers in heatmapImageAcl.ts",
  );
}

if (failed === 0) {
  console.log(`\nlint-upload-content-verification guard: all ${passed} assertions passed`);
  process.exit(0);
}
console.error(`\nlint-upload-content-verification guard: ${failed} assertion(s) FAILED`);
process.exit(1);
