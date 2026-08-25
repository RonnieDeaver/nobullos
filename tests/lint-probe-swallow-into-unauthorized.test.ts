/* test-registration
{
  "name": "lint-probe-swallow-into-unauthorized guard (Task #2150)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~4.9s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
// Task #2150 — Regression test for the swallow-into-unauthorized probe
// guard. Proves:
//
//   1. The canonical anti-pattern (a `.catch(() => null)` on a credential
//      read inside a function that also yields `outcome: "unauthorized"`)
//      is detected.
//   2. The `status: "empty"` three-state resolver variant of the swallow
//      is detected.
//   3. `.catch(() => undefined)` is detected too.
//   4. The already-fixed real probes (Stripe, PandaDoc,
//      Slack, Google Ads) pass — they use try/catch three-state resolvers.
//   5. The historical Google Ads `getGoogleAdsConnection().catch(() => null)` shape inside the
//      single-flight `readRefreshToken` is NOT flagged (its function never
//      yields a disconnect outcome — null propagates to a transient throw).
//   6. A route-layer display-only `.catch(() => null)` (cache callback that
//      yields `outcome: "commit"`/`"preserve"`, never `"unauthorized"`) is
//      NOT flagged.
//   7. A correct try/catch three-state probe (no swallow) passes.
//   8. The inline `// lint-probe-swallow-ok` suppression comment works.
//   9. The file-path ALLOWLIST suppresses an offending file.
//
// Usage: tsx tests/lint-probe-swallow-into-unauthorized.test.ts

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeSource,
  runLint,
  checkAccessorCoverage,
  DISCONNECT_THROW_ACCESSORS,
  DISCONNECT_THROW_MESSAGE_PATTERNS,
  type DisconnectThrowAccessor,
} from "../scripts/lint-probe-swallow-into-unauthorized";

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

console.log("\n[lint-probe-swallow-into-unauthorized] regression suite");

// ─── Case 1: canonical anti-pattern (outcome: "unauthorized") ───────
{
  const src = [
    `import { storage } from "./storage";`,
    `const KEY = "x";`,
    `export async function probeConnection() {`,
    `  const setting = await storage.getSystemSetting(KEY).catch(() => null);`,
    `  if (!setting?.value) {`,
    `    return { outcome: "unauthorized", reason: "no_token" };`,
    `  }`,
    `  return { outcome: "connected" };`,
    `}`,
    ``,
  ].join("\n");
  const offenders = analyzeSource("/virtual/probe.ts", src);
  assert(offenders.length === 1, "case 1: exactly 1 offender for canonical swallow");
  assert(
    offenders[0]?.enclosingFn === "probeConnection",
    "case 1: offender attributed to probeConnection()",
  );
}

// ─── Case 2: three-state resolver variant (status: "empty") ─────────
{
  const src = [
    `import { storage } from "./storage";`,
    `export async function resolveSecretKey() {`,
    `  const setting = await storage.getSystemSetting("k").catch(() => null);`,
    `  if (!setting?.value) return { status: "empty" } as const;`,
    `  return { status: "present", value: setting.value } as const;`,
    `}`,
    ``,
  ].join("\n");
  const offenders = analyzeSource("/virtual/resolver.ts", src);
  assert(offenders.length === 1, 'case 2: status:"empty" swallow detected');
}

// ─── Case 3: .catch(() => undefined) is detected too ────────────────
{
  const src = [
    `import { storage } from "./storage";`,
    `export async function probeConnection() {`,
    `  const c = await storage.getApiKey().catch(() => undefined);`,
    `  if (!c) return { outcome: "unauthorized" };`,
    `  return { outcome: "connected" };`,
    `}`,
    ``,
  ].join("\n");
  const offenders = analyzeSource("/virtual/undef.ts", src);
  assert(offenders.length === 1, "case 3: .catch(() => undefined) detected");
}

// ─── Case 3b: cross-function shape (resolver swallows, probe yields) ─
{
  // The historical split: a credential RESOLVER swallows the read into
  // null, and a SEPARATE probe maps that null straight into
  // outcome: "unauthorized". Today's nearest-enclosing-function heuristic
  // alone would miss this; the cross-function pass must catch it.
  const src = [
    `import { storage } from "./storage";`,
    `async function resolveSecretKey() {`,
    `  const setting = await storage.getSystemSetting("k").catch(() => null);`,
    `  return setting?.value ?? null;`,
    `}`,
    `export async function probeConnection() {`,
    `  const key = await resolveSecretKey();`,
    `  if (!key) return { outcome: "unauthorized", reason: "no_key" };`,
    `  return { outcome: "connected" };`,
    `}`,
    ``,
  ].join("\n");
  const offenders = analyzeSource("/virtual/cross.ts", src);
  assert(offenders.length === 1, "case 3b: cross-function swallow detected");
  assert(
    offenders[0]?.enclosingFn === "resolveSecretKey",
    "case 3b: offender attributed to the resolver, not the probe",
  );
  assert(
    offenders[0]?.line === 3,
    "case 3b: offender points at the resolver's .catch line",
  );
}

// ─── Case 3c: cross-function status:"empty" variant ─────────────────
{
  // Same split, but the consumer is a three-state resolver-style probe
  // that yields status: "empty" from the swallowed null.
  const src = [
    `import { storage } from "./storage";`,
    `async function loadToken() {`,
    `  const row = await storage.getBotToken().catch(() => null);`,
    `  return row?.token ?? null;`,
    `}`,
    `export async function resolveAuth() {`,
    `  const token = await loadToken();`,
    `  if (!token) return { status: "empty" } as const;`,
    `  return { status: "found", token } as const;`,
    `}`,
    ``,
  ].join("\n");
  const offenders = analyzeSource("/virtual/cross-empty.ts", src);
  assert(
    offenders.length === 1,
    'case 3c: cross-function status:"empty" swallow detected',
  );
  assert(
    offenders[0]?.enclosingFn === "loadToken",
    "case 3c: offender attributed to the resolver loadToken()",
  );
}

// ─── Case 3d: cross-function resolver consumed by a NON-disconnect fn ─
{
  // A resolver swallows the read, but the only caller maps the null to a
  // transient throw — never a Not-Connected badge. Must NOT be flagged
  // (mirrors the safe single-flight readRefreshToken shape, by name).
  const src = [
    `import { getAccessToken } from "./storage";`,
    `async function resolveToken() {`,
    `  const c = await getAccessToken().catch(() => null);`,
    `  return c ?? null;`,
    `}`,
    `export async function doWork() {`,
    `  const t = await resolveToken();`,
    `  if (!t) throw new Error("transient — try again");`,
    `  return t;`,
    `}`,
    ``,
  ].join("\n");
  const offenders = analyzeSource("/virtual/cross-safe.ts", src);
  assert(
    offenders.length === 0,
    "case 3d: resolver consumed by a non-disconnect caller not flagged",
  );
}

// ─── Case 3e: swallowing resolver NOT consumed by name (callback) ────
{
  // The resolver swallow is handed as a callback (never called by name) to
  // a helper, and a separate probe yields a disconnect via a DIFFERENT
  // read. Mirrors googleAdsIntegration readRefreshToken — must not flag.
  const src = [
    `import { getConn, helper } from "./storage";`,
    `async function refresh() {`,
    `  return helper({`,
    `    readRefreshToken: async () => {`,
    `      const fresh = await getConn().catch(() => null);`,
    `      return fresh?.refreshTokenEncrypted ?? null;`,
    `    },`,
    `  });`,
    `}`,
    `export async function probeConnection() {`,
    `  let conn;`,
    `  try {`,
    `    conn = await getConn();`,
    `  } catch (err) {`,
    `    return { outcome: "probe_failed" };`,
    `  }`,
    `  if (!conn) return { outcome: "unauthorized", reason: "no_connection" };`,
    `  return { outcome: "connected" };`,
    `}`,
    ``,
  ].join("\n");
  const offenders = analyzeSource("/virtual/cross-callback.ts", src);
  assert(
    offenders.length === 0,
    "case 3e: callback-only swallow (not called by name) not flagged",
  );
}

// ─── Case 4: real already-fixed probes pass ─────────────────────────
{
  const realProbes = [
    "server/stripeClient.ts",
    "server/services/pandadocIntegration.ts",
    "server/services/googleDriveIntegration.ts",
    "server/services/slackIntegration.ts",
    "server/services/googleAdsIntegration.ts",
  ];
  for (const p of realProbes) {
    const offenders = analyzeSource(p, readFileSync(p, "utf8"));
    assert(offenders.length === 0, `case 4: ${p} passes (no swallow-into-unauthorized)`);
  }
}

// ─── Case 5: full server/ tree is clean (real-world guard) ──────────
{
  const result = runLint();
  assert(
    result.ok,
    `case 5: full server/ scan is clean (scanned ${result.scanned} files, ${result.offenders.length} offenders)`,
  );
  if (!result.ok) {
    for (const o of result.offenders) {
      console.error(`      offender: ${o.file}:${o.line} (${o.enclosingFn})`);
    }
  }
}

// ─── Case 6: safe single-flight readRefreshToken shape passes ───────
{
  // Mirrors googleAdsIntegration readRefreshToken: the swallow feeds a
  // token return, not an unauthorized outcome. The unauthorized branch
  // lives in a SEPARATE function that does NOT swallow.
  const src = [
    `import { getGoogleAdsConnection } from "./storage";`,
    `async function refresh() {`,
    `  return withSingleFlightOAuthRefresh({`,
    `    readRefreshToken: async () => {`,
    `      const fresh = await getGoogleAdsConnection().catch(() => null);`,
    `      return fresh?.refreshTokenEncrypted ?? null;`,
    `    },`,
    `  });`,
    `}`,
    `export async function probeConnection() {`,
    `  let conn;`,
    `  try {`,
    `    conn = await getGoogleAdsConnection();`,
    `  } catch (err) {`,
    `    return { outcome: "probe_failed" };`,
    `  }`,
    `  if (!conn) return { outcome: "unauthorized", reason: "no_connection" };`,
    `  return { outcome: "connected" };`,
    `}`,
    ``,
  ].join("\n");
  const offenders = analyzeSource("/virtual/single-flight.ts", src);
  assert(
    offenders.length === 0,
    "case 6: single-flight readRefreshToken swallow not flagged",
  );
}

// ─── Case 7: route-layer display-only catch passes ──────────────────
{
  const src = [
    `import { gdriveMod } from "./mods";`,
    `async function cacheCallback() {`,
    `  const probe = await gdriveMod.probeConnection();`,
    `  const email = probe.email ?? (await gdriveMod.getServiceAccountEmail().catch(() => null));`,
    `  return { outcome: "commit" as const, value: { email } };`,
    `}`,
    ``,
  ].join("\n");
  const offenders = analyzeSource("/virtual/route.ts", src);
  assert(offenders.length === 0, "case 7: display-only metadata catch not flagged");
}

// ─── Case 8: correct try/catch three-state probe passes ─────────────
{
  const src = [
    `import { storage } from "./storage";`,
    `export async function probeConnection() {`,
    `  let setting;`,
    `  try {`,
    `    setting = await storage.getSystemSetting("k");`,
    `  } catch (err) {`,
    `    return { outcome: "probe_failed", reason: "lookup_failed" };`,
    `  }`,
    `  if (!setting?.value) return { outcome: "unauthorized", reason: "no_token" };`,
    `  return { outcome: "connected" };`,
    `}`,
    ``,
  ].join("\n");
  const offenders = analyzeSource("/virtual/correct.ts", src);
  assert(offenders.length === 0, "case 8: try/catch three-state probe passes");
}

// ─── Case 9: inline suppression comment + file-path allowlist ───────
{
  const root = mkdtempSync(join(tmpdir(), "lint-probe-swallow-"));
  mkdirSync(join(root, "server"), { recursive: true });
  try {
    const offending = [
      `import { storage } from "./storage";`,
      `export async function probeConnection() {`,
      `  const c = await storage.getSystemSetting("k").catch(() => null);`,
      `  if (!c) return { outcome: "unauthorized" };`,
      `  return { outcome: "connected" };`,
      `}`,
      ``,
    ].join("\n");

    // 9a — plain offender is flagged by runLint over the temp tree.
    const offFile = join(root, "server", "bad.ts");
    writeFileSync(offFile, offending);
    let result = runLint({ roots: [join(root, "server")] });
    assert(!result.ok, "case 9a: runLint flags the offending temp file");
    assert(
      result.offenders.some((o) => o.file === offFile),
      "case 9a: offending file present in offenders",
    );

    // 9b — file-path ALLOWLIST suppresses it.
    result = runLint({
      roots: [join(root, "server")],
      allowlist: new Set([offFile]),
    });
    assert(result.ok, "case 9b: ALLOWLIST suppresses the offending file");

    // 9c — inline suppression comment suppresses it.
    const suppressed = [
      `import { storage } from "./storage";`,
      `export async function probeConnection() {`,
      `  // lint-probe-swallow-ok: test fixture — intentional`,
      `  const c = await storage.getSystemSetting("k").catch(() => null);`,
      `  if (!c) return { outcome: "unauthorized" };`,
      `  return { outcome: "connected" };`,
      `}`,
      ``,
    ].join("\n");
    writeFileSync(offFile, suppressed);
    result = runLint({ roots: [join(root, "server")] });
    assert(result.ok, "case 9c: inline // lint-probe-swallow-ok suppresses it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Case 10: cross-FILE split (resolver module + probe module) ─────
{
  // The Task #2212 shape: an EXPORTED resolver in file A swallows the
  // credential read into null; a probe in file B imports that resolver and
  // maps the null straight into outcome: "unauthorized". Per-file analysis
  // misses it; the whole-tree pass in runLint must catch it and attribute
  // the offence to the resolver in file A.
  const root = mkdtempSync(join(tmpdir(), "lint-probe-swallow-xfile-"));
  mkdirSync(join(root, "server"), { recursive: true });
  try {
    const resolverFile = join(root, "server", "secretResolver.ts");
    const probeFile = join(root, "server", "secretProbe.ts");
    writeFileSync(
      resolverFile,
      [
        `import { storage } from "./storage";`,
        `export async function resolveSecretKey() {`,
        `  const setting = await storage.getSystemSetting("k").catch(() => null);`,
        `  return setting?.value ?? null;`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeFileSync(
      probeFile,
      [
        `import { resolveSecretKey } from "./secretResolver";`,
        `export async function probeConnection() {`,
        `  const key = await resolveSecretKey();`,
        `  if (!key) return { outcome: "unauthorized", reason: "no_key" };`,
        `  return { outcome: "connected" };`,
        `}`,
        ``,
      ].join("\n"),
    );
    const result = runLint({ roots: [join(root, "server")] });
    assert(!result.ok, "case 10: cross-file split is flagged");
    assert(
      result.offenders.length === 1,
      `case 10: exactly 1 cross-file offender (got ${result.offenders.length})`,
    );
    assert(
      result.offenders[0]?.file === resolverFile,
      "case 10: offence attributed to the swallowing resolver file (A)",
    );
    assert(
      result.offenders[0]?.enclosingFn === "resolveSecretKey",
      "case 10: offence attributed to resolveSecretKey()",
    );
    assert(
      result.offenders[0]?.line === 3,
      "case 10: offender points at the resolver's .catch line",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Case 11: cross-FILE split with an `as` alias import ────────────
{
  // The probe imports the resolver under an alias and calls it by the
  // local name; the link must match the resolver's EXPORTED name, not the
  // local alias.
  const root = mkdtempSync(join(tmpdir(), "lint-probe-swallow-alias-"));
  mkdirSync(join(root, "server"), { recursive: true });
  try {
    const resolverFile = join(root, "server", "tokenResolver.ts");
    writeFileSync(
      resolverFile,
      [
        `import { storage } from "./storage";`,
        `export async function loadBotToken() {`,
        `  const row = await storage.getBotToken().catch(() => null);`,
        `  return row?.token ?? null;`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeFileSync(
      join(root, "server", "tokenProbe.ts"),
      [
        `import { loadBotToken as load } from "./tokenResolver";`,
        `export async function resolveAuth() {`,
        `  const token = await load();`,
        `  if (!token) return { status: "empty" } as const;`,
        `  return { status: "found", token } as const;`,
        `}`,
        ``,
      ].join("\n"),
    );
    const result = runLint({ roots: [join(root, "server")] });
    assert(!result.ok, "case 11: aliased cross-file import is flagged");
    assert(
      result.offenders.length === 1 &&
        result.offenders[0]?.file === resolverFile,
      "case 11: offence attributed to the resolver despite the `as` alias",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Case 12: cross-FILE resolver consumed by a NON-disconnect probe ─
{
  // The exported resolver swallows, but the importing file maps the null to
  // a transient throw — never a Not-Connected badge. Must NOT be flagged.
  const root = mkdtempSync(join(tmpdir(), "lint-probe-swallow-xsafe-"));
  mkdirSync(join(root, "server"), { recursive: true });
  try {
    writeFileSync(
      join(root, "server", "tokenResolver.ts"),
      [
        `import { getAccessToken } from "./storage";`,
        `export async function resolveToken() {`,
        `  const c = await getAccessToken().catch(() => null);`,
        `  return c ?? null;`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeFileSync(
      join(root, "server", "worker.ts"),
      [
        `import { resolveToken } from "./tokenResolver";`,
        `export async function doWork() {`,
        `  const t = await resolveToken();`,
        `  if (!t) throw new Error("transient — try again");`,
        `  return t;`,
        `}`,
        ``,
      ].join("\n"),
    );
    const result = runLint({ roots: [join(root, "server")] });
    assert(
      result.ok,
      "case 12: resolver consumed cross-file by a non-disconnect caller not flagged",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Case 13: cross-FILE name collision (import resolves elsewhere) ──
{
  // File A exports a swallowing resolver `resolveSecretKey`. A separate
  // module C also exports a (harmless) `resolveSecretKey`. The probe in B
  // imports `resolveSecretKey` from C — NOT from A — and yields
  // unauthorized. A must NOT be flagged: name match alone is not enough,
  // the import must resolve to A.
  const root = mkdtempSync(join(tmpdir(), "lint-probe-swallow-collide-"));
  mkdirSync(join(root, "server"), { recursive: true });
  try {
    writeFileSync(
      join(root, "server", "aResolver.ts"),
      [
        `import { storage } from "./storage";`,
        `export async function resolveSecretKey() {`,
        `  const setting = await storage.getSystemSetting("k").catch(() => null);`,
        `  return setting?.value ?? null;`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeFileSync(
      join(root, "server", "cResolver.ts"),
      [
        `export async function resolveSecretKey() {`,
        `  return process.env.SECRET_KEY ?? null;`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeFileSync(
      join(root, "server", "bProbe.ts"),
      [
        `import { resolveSecretKey } from "./cResolver";`,
        `export async function probeConnection() {`,
        `  const key = await resolveSecretKey();`,
        `  if (!key) return { outcome: "unauthorized" };`,
        `  return { outcome: "connected" };`,
        `}`,
        ``,
      ].join("\n"),
    );
    const result = runLint({ roots: [join(root, "server")] });
    assert(
      result.ok,
      "case 13: name collision — A not flagged when the probe imports from C, not A",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Case 14: cross-FILE split via an aliased EXPORT ────────────────
{
  // File A declares `internalResolve` (which swallows the read) but exports it
  // under a different public name via `export { internalResolve as
  // resolveSecretKey }`. File B imports the PUBLIC name and yields
  // unauthorized. The link must match the export alias, not the declared name,
  // and still attribute the offence to the declared resolver in A.
  const root = mkdtempSync(join(tmpdir(), "lint-probe-swallow-xexport-"));
  mkdirSync(join(root, "server"), { recursive: true });
  try {
    const resolverFile = join(root, "server", "aliasResolver.ts");
    writeFileSync(
      resolverFile,
      [
        `import { storage } from "./storage";`,
        `async function internalResolve() {`,
        `  const setting = await storage.getSystemSetting("k").catch(() => null);`,
        `  return setting?.value ?? null;`,
        `}`,
        `export { internalResolve as resolveSecretKey };`,
        ``,
      ].join("\n"),
    );
    writeFileSync(
      join(root, "server", "aliasProbe.ts"),
      [
        `import { resolveSecretKey } from "./aliasResolver";`,
        `export async function probeConnection() {`,
        `  const key = await resolveSecretKey();`,
        `  if (!key) return { outcome: "unauthorized" };`,
        `  return { outcome: "connected" };`,
        `}`,
        ``,
      ].join("\n"),
    );
    const result = runLint({ roots: [join(root, "server")] });
    assert(!result.ok, "case 14: aliased-export cross-file split is flagged");
    assert(
      result.offenders.length === 1 &&
        result.offenders[0]?.file === resolverFile &&
        result.offenders[0]?.enclosingFn === "internalResolve",
      "case 14: offence attributed to the declared resolver despite the export alias",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Case 15: cross-FILE via a named re-export barrel ───────────────
{
  // Task #2248: the probe imports the swallowing resolver from a BARREL
  // (`export { resolveSecretKey } from "./secretResolver"`) rather than
  // directly from the resolver file. The linker must follow the re-export
  // edge back to the resolver and flag it.
  const root = mkdtempSync(join(tmpdir(), "lint-probe-swallow-barrel-"));
  mkdirSync(join(root, "server"), { recursive: true });
  try {
    const resolverFile = join(root, "server", "secretResolver.ts");
    writeFileSync(
      resolverFile,
      [
        `import { storage } from "./storage";`,
        `export async function resolveSecretKey() {`,
        `  const setting = await storage.getSystemSetting("k").catch(() => null);`,
        `  return setting?.value ?? null;`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeFileSync(
      join(root, "server", "index.ts"),
      [`export { resolveSecretKey } from "./secretResolver";`, ``].join("\n"),
    );
    writeFileSync(
      join(root, "server", "secretProbe.ts"),
      [
        `import { resolveSecretKey } from "./index";`,
        `export async function probeConnection() {`,
        `  const key = await resolveSecretKey();`,
        `  if (!key) return { outcome: "unauthorized", reason: "no_key" };`,
        `  return { outcome: "connected" };`,
        `}`,
        ``,
      ].join("\n"),
    );
    const result = runLint({ roots: [join(root, "server")] });
    assert(!result.ok, "case 15: named re-export barrel hop is flagged");
    assert(
      result.offenders.length === 1 &&
        result.offenders[0]?.file === resolverFile &&
        result.offenders[0]?.enclosingFn === "resolveSecretKey",
      "case 15: offence attributed to the resolver through the barrel",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Case 16: cross-FILE via a wildcard `export *` barrel ───────────
{
  // The barrel re-exports with `export * from "./secretResolver"`; the
  // wildcard must pass the imported name through unchanged to the resolver.
  const root = mkdtempSync(join(tmpdir(), "lint-probe-swallow-star-"));
  mkdirSync(join(root, "server"), { recursive: true });
  try {
    const resolverFile = join(root, "server", "secretResolver.ts");
    writeFileSync(
      resolverFile,
      [
        `import { storage } from "./storage";`,
        `export async function resolveSecretKey() {`,
        `  const setting = await storage.getSystemSetting("k").catch(() => null);`,
        `  return setting?.value ?? null;`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeFileSync(
      join(root, "server", "index.ts"),
      [`export * from "./secretResolver";`, ``].join("\n"),
    );
    writeFileSync(
      join(root, "server", "secretProbe.ts"),
      [
        `import { resolveSecretKey } from "./index";`,
        `export async function probeConnection() {`,
        `  const key = await resolveSecretKey();`,
        `  if (!key) return { outcome: "unauthorized" };`,
        `  return { outcome: "connected" };`,
        `}`,
        ``,
      ].join("\n"),
    );
    const result = runLint({ roots: [join(root, "server")] });
    assert(!result.ok, "case 16: wildcard `export *` barrel hop is flagged");
    assert(
      result.offenders.length === 1 &&
        result.offenders[0]?.file === resolverFile,
      "case 16: offence attributed to the resolver through the wildcard barrel",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Case 17: cross-FILE via a namespace import ─────────────────────
{
  // Task #2248: `import * as creds from "./secretResolver"` then
  // `creds.resolveSecretKey()`. The namespace binding must be resolved to the
  // resolver module and the property call matched against its public exports.
  const root = mkdtempSync(join(tmpdir(), "lint-probe-swallow-ns-"));
  mkdirSync(join(root, "server"), { recursive: true });
  try {
    const resolverFile = join(root, "server", "secretResolver.ts");
    writeFileSync(
      resolverFile,
      [
        `import { storage } from "./storage";`,
        `export async function resolveSecretKey() {`,
        `  const setting = await storage.getSystemSetting("k").catch(() => null);`,
        `  return setting?.value ?? null;`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeFileSync(
      join(root, "server", "secretProbe.ts"),
      [
        `import * as creds from "./secretResolver";`,
        `export async function probeConnection() {`,
        `  const key = await creds.resolveSecretKey();`,
        `  if (!key) return { outcome: "unauthorized", reason: "no_key" };`,
        `  return { outcome: "connected" };`,
        `}`,
        ``,
      ].join("\n"),
    );
    const result = runLint({ roots: [join(root, "server")] });
    assert(!result.ok, "case 17: namespace-import call is flagged");
    assert(
      result.offenders.length === 1 &&
        result.offenders[0]?.file === resolverFile &&
        result.offenders[0]?.enclosingFn === "resolveSecretKey",
      "case 17: offence attributed to the resolver behind the namespace call",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Case 18: precision — name collision through an unrelated barrel ─
{
  // A barrel re-exports a HARMLESS `resolveSecretKey` from module C; a
  // separate module A exports a swallowing `resolveSecretKey`. The probe
  // imports the name from the barrel (which resolves to C, not A). A must NOT
  // be flagged: the barrel chain must resolve to the actual swallowing file.
  const root = mkdtempSync(join(tmpdir(), "lint-probe-swallow-barrel-collide-"));
  mkdirSync(join(root, "server"), { recursive: true });
  try {
    writeFileSync(
      join(root, "server", "aResolver.ts"),
      [
        `import { storage } from "./storage";`,
        `export async function resolveSecretKey() {`,
        `  const setting = await storage.getSystemSetting("k").catch(() => null);`,
        `  return setting?.value ?? null;`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeFileSync(
      join(root, "server", "cResolver.ts"),
      [
        `export async function resolveSecretKey() {`,
        `  return process.env.SECRET_KEY ?? null;`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeFileSync(
      join(root, "server", "index.ts"),
      [`export { resolveSecretKey } from "./cResolver";`, ``].join("\n"),
    );
    writeFileSync(
      join(root, "server", "bProbe.ts"),
      [
        `import { resolveSecretKey } from "./index";`,
        `export async function probeConnection() {`,
        `  const key = await resolveSecretKey();`,
        `  if (!key) return { outcome: "unauthorized" };`,
        `  return { outcome: "connected" };`,
        `}`,
        ``,
      ].join("\n"),
    );
    const result = runLint({ roots: [join(root, "server")] });
    assert(
      result.ok,
      "case 18: barrel resolving to a harmless C does not flag the swallowing A",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Case 19: precision — namespace call into a non-swallowing module ─
{
  // The probe uses a namespace import + property call, but the resolved module
  // does not swallow (env-var read). Nothing must be flagged.
  const root = mkdtempSync(join(tmpdir(), "lint-probe-swallow-ns-safe-"));
  mkdirSync(join(root, "server"), { recursive: true });
  try {
    writeFileSync(
      join(root, "server", "envResolver.ts"),
      [
        `export async function resolveSecretKey() {`,
        `  return process.env.SECRET_KEY ?? null;`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeFileSync(
      join(root, "server", "secretProbe.ts"),
      [
        `import * as creds from "./envResolver";`,
        `export async function probeConnection() {`,
        `  const key = await creds.resolveSecretKey();`,
        `  if (!key) return { outcome: "unauthorized" };`,
        `  return { outcome: "connected" };`,
        `}`,
        ``,
      ].join("\n"),
    );
    const result = runLint({ roots: [join(root, "server")] });
    assert(result.ok, "case 19: namespace call into a non-swallowing module not flagged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Case 20: throw-based accessor swallow (Task #2429) ─────────────
{
  // The rotating-refresh-token hot-path accessors (Google Calendar /
  // Google Ads `getValidAccessToken`) THROW a "not connected" Error rather
  // than returning an `outcome: "unauthorized"` object literal. A
  // `.catch(() => null)` on the authoritative credential read collapses a
  // thrown read (UNKNOWN) into a confirmed-null and hits the terminal
  // "not connected" throw — the same false-disconnect bug, just via a throw.
  const src = [
    `import { storage } from "./storage";`,
    `export async function getValidAccessToken(userId: string) {`,
    `  const cred = await storage.getGoogleCalendarCredential(userId).catch(() => null);`,
    `  if (!cred) throw new Error("Google Calendar not connected for this user");`,
    `  return cred.accessToken;`,
    `}`,
    ``,
  ].join("\n");
  const offenders = analyzeSource("/virtual/throw-accessor.ts", src);
  assert(
    offenders.length === 1,
    "case 20: swallow inside a throw-based not-connected accessor is flagged",
  );
  assert(
    offenders[0]?.enclosingFn === "getValidAccessToken",
    "case 20: offence attributed to getValidAccessToken()",
  );
}

// ─── Case 21: throw-based variants — status / missing refresh token ──
{
  // The other terminal throws these accessors use must count too.
  const statusSrc = [
    `import { storage } from "./storage";`,
    `export async function getValidAccessToken() {`,
    `  const conn = await storage.getGoogleAdsConnection().catch(() => null);`,
    `  if (conn?.status !== "connected") {`,
    `    throw new Error(\`Google Ads credential status is "\${conn?.status}"\`);`,
    `  }`,
    `  return conn.accessToken;`,
    `}`,
    ``,
  ].join("\n");
  assert(
    analyzeSource("/virtual/throw-status.ts", statusSrc).length === 1,
    'case 21a: throw `credential status is "…"` (template literal) is flagged',
  );

  const missingTokenSrc = [
    `import { storage } from "./storage";`,
    `export async function getValidAccessToken() {`,
    `  const conn = await storage.getGoogleAdsConnection().catch(() => undefined);`,
    `  if (!conn?.refreshTokenEncrypted) {`,
    `    throw new Error("Google Ads credential missing refresh token");`,
    `  }`,
    `  return conn.refreshTokenEncrypted;`,
    `}`,
    ``,
  ].join("\n");
  assert(
    analyzeSource("/virtual/throw-missing.ts", missingTokenSrc).length === 1,
    'case 21b: throw "… missing refresh token" is flagged',
  );
}

// ─── Case 22: correct confirm-before-trip throw accessor passes ─────
{
  // The REAL shape (Tasks #2416/#2428): the authoritative read is wrapped in
  // try/catch — a thrown read surfaces a transient *AuthUnknownError* (NOT a
  // disconnect), and only a CONFIRMED null throws "not connected". No swallow,
  // so nothing is flagged, and the transient throw must NOT be mistaken for a
  // disconnect.
  const src = [
    `import { storage } from "./storage";`,
    `class GoogleCalendarAuthUnknownError extends Error {}`,
    `export async function getValidAccessToken(userId: string) {`,
    `  let cred;`,
    `  try {`,
    `    cred = await storage.getGoogleCalendarCredential(userId);`,
    `  } catch (err) {`,
    `    throw new GoogleCalendarAuthUnknownError(`,
    `      "Google Calendar connection state unknown — read failed, will retry (no disconnect declared)",`,
    `    );`,
    `  }`,
    `  if (!cred) throw new Error("Google Calendar not connected for this user");`,
    `  return cred.accessToken;`,
    `}`,
    ``,
  ].join("\n");
  const offenders = analyzeSource("/virtual/throw-correct.ts", src);
  assert(
    offenders.length === 0,
    "case 22: try/catch confirm-before-trip throw accessor passes (no swallow)",
  );
}

// ─── Case 23: the real throw-based accessors pass ───────────────────
{
  const throwAccessors = [
    "server/services/googleCalendarIntegration.ts",
    "server/services/googleAdsIntegration.ts",
  ];
  for (const p of throwAccessors) {
    const offenders = analyzeSource(p, readFileSync(p, "utf8"));
    assert(
      offenders.length === 0,
      `case 23: ${p} (throw-based accessor) passes`,
    );
  }
}

// ─── Case 24: deliberately-added swallow in a real accessor is caught ─
{
  // Take the real Google Calendar accessor and inject the exact bug the guard
  // protects against: swallow the authoritative `getGoogleCalendarCredential`
  // read on the hot path. The throw-based "not connected" terminal must make
  // the lint flag it.
  const real = readFileSync(
    "server/services/googleCalendarIntegration.ts",
    "utf8",
  );
  const injected = real.replace(
    "cred = await storage.getGoogleCalendarCredential(userId);",
    "cred = await storage.getGoogleCalendarCredential(userId).catch(() => null);",
  );
  assert(
    injected !== real,
    "case 24: injection point found in the real accessor",
  );
  const offenders = analyzeSource(
    "server/services/googleCalendarIntegration.ts",
    injected,
  );
  assert(
    offenders.some((o) => o.enclosingFn === "getValidAccessToken"),
    "case 24: a deliberately-added swallow in the real accessor is caught",
  );
}

// ─── Case 25: the real registered accessors pass the drift guard ────
{
  // Task #2433: each registered throw-based accessor must still contain a
  // disconnect throw matching the shared pattern list. The real accessors do,
  // so the coverage check returns no drift failures.
  const drift = checkAccessorCoverage();
  assert(
    drift.length === 0,
    `case 25: real registered accessors pass coverage drift (got ${JSON.stringify(
      drift,
    )})`,
  );
  assert(
    DISCONNECT_THROW_ACCESSORS.length >= 2,
    "case 25: at least the two Google accessors are registered",
  );
  assert(
    runLint().accessorDrift.length === 0,
    "case 25: full runLint() reports no accessor drift",
  );
}

// ─── Case 26: a reworded accessor fails the drift guard loudly ──────
{
  // The whole point of Task #2433: if an accessor reworded its "not connected"
  // throw so the shared regex no longer matches, the guard must fail LOUDLY
  // (not silently lose coverage). Point a custom registry at a temp accessor
  // whose throw uses an UNMATCHED message.
  const root = mkdtempSync(join(tmpdir(), "lint-probe-swallow-drift-"));
  mkdirSync(join(root, "server"), { recursive: true });
  try {
    const accessorFile = join(root, "server", "rewordedAccessor.ts");
    writeFileSync(
      accessorFile,
      [
        `import { storage } from "./storage";`,
        `export async function getValidAccessToken(userId: string) {`,
        `  const cred = await storage.getGoogleCalendarCredential(userId);`,
        // Reworded so NONE of the shared patterns match.
        `  if (!cred) throw new Error("Google Calendar link is gone for this AM");`,
        `  return cred.accessToken;`,
        `}`,
        ``,
      ].join("\n"),
    );
    const registry: DisconnectThrowAccessor[] = [
      { file: accessorFile, fn: "getValidAccessToken" },
    ];
    const drift = checkAccessorCoverage(registry);
    assert(
      drift.length === 1 && drift[0]?.reason === "no-matched-throw",
      "case 26: reworded accessor flagged as no-matched-throw",
    );
    const result = runLint({
      roots: [join(root, "server")],
      accessorRegistry: registry,
    });
    assert(
      !result.ok && result.accessorDrift.length === 1,
      "case 26: runLint fails loudly on the drifted accessor",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Case 27: missing function / unreadable file are flagged ────────
{
  const root = mkdtempSync(join(tmpdir(), "lint-probe-swallow-drift2-"));
  mkdirSync(join(root, "server"), { recursive: true });
  try {
    const accessorFile = join(root, "server", "renamedAccessor.ts");
    writeFileSync(
      accessorFile,
      [
        `import { storage } from "./storage";`,
        // The registered fn name no longer exists (it was renamed).
        `export async function fetchAccessToken(userId: string) {`,
        `  const cred = await storage.getGoogleCalendarCredential(userId);`,
        `  if (!cred) throw new Error("Google Calendar not connected for this user");`,
        `  return cred.accessToken;`,
        `}`,
        ``,
      ].join("\n"),
    );
    const missingFn = checkAccessorCoverage([
      { file: accessorFile, fn: "getValidAccessToken" },
    ]);
    assert(
      missingFn.length === 1 && missingFn[0]?.reason === "fn-not-found",
      "case 27a: renamed/absent registered function flagged as fn-not-found",
    );

    const unreadable = checkAccessorCoverage([
      { file: join(root, "server", "does-not-exist.ts"), fn: "getValidAccessToken" },
    ]);
    assert(
      unreadable.length === 1 && unreadable[0]?.reason === "file-unreadable",
      "case 27b: unreadable accessor module flagged as file-unreadable",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Case 28: the shared pattern list still backs the regex ─────────
{
  // The patterns are the single source of truth; an accessor throw that
  // matches the regex must correspond to a phrase in the shared list, and a
  // correct accessor with a matching throw passes coverage.
  assert(
    DISCONNECT_THROW_MESSAGE_PATTERNS.includes("not connected") &&
      DISCONNECT_THROW_MESSAGE_PATTERNS.includes("credential status is"),
    "case 28: shared pattern list contains the canonical disconnect phrases",
  );
  const root = mkdtempSync(join(tmpdir(), "lint-probe-swallow-ok-"));
  mkdirSync(join(root, "server"), { recursive: true });
  try {
    const accessorFile = join(root, "server", "okAccessor.ts");
    writeFileSync(
      accessorFile,
      [
        `import { storage } from "./storage";`,
        `export async function getValidAccessToken() {`,
        `  const conn = await storage.getGoogleAdsConnection();`,
        `  if (conn?.status !== "connected") {`,
        `    throw new Error(\`Google Ads credential status is "\${conn?.status}"\`);`,
        `  }`,
        `  return conn.accessToken;`,
        `}`,
        ``,
      ].join("\n"),
    );
    const drift = checkAccessorCoverage([
      { file: accessorFile, fn: "getValidAccessToken" },
    ]);
    assert(
      drift.length === 0,
      "case 28: accessor whose throw matches a shared pattern passes coverage",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Case 29: category-tagged disconnect throw (Task #2432) ─────────
{
  // A third way an accessor declares a disconnect: it throws a CUSTOM error
  // class tagged with a permanent `errorCategory` (here "auth_config") that a
  // downstream classifier folds into the `paused_auth` terminal — WITHOUT the
  // literal words "not connected" in the message. A `.catch(() => null)` on the
  // authoritative credential read feeding that throw is the same
  // false-disconnect bug, but the message-substring regex can't see it.
  const classSrc = [
    `import { storage } from "./storage";`,
    `class SemrushAuthMissingError extends Error {`,
    `  public readonly errorCategory = "auth_config" as const;`,
    `}`,
    `export async function getAccessToken() {`,
    `  const tok = await storage.getSystemSetting("semrush_access_token").catch(() => null);`,
    `  if (!tok?.value) {`,
    `    throw new SemrushAuthMissingError("Semrush credentials are gone");`,
    `  }`,
    `  return tok.value;`,
    `}`,
    ``,
  ].join("\n");
  const classOffenders = analyzeSource("/virtual/cat-class.ts", classSrc);
  assert(
    classOffenders.length === 1,
    "case 29a: swallow feeding a category-tagged class throw is flagged",
  );
  assert(
    classOffenders[0]?.enclosingFn === "getAccessToken",
    "case 29a: offence attributed to getAccessToken()",
  );

  // Inline tag variant: `Object.assign(new Error(...), { errorCategory:
  // "auth_config" })` — no custom class, the tag rides on the thrown object.
  const inlineSrc = [
    `import { storage } from "./storage";`,
    `export async function getAccessToken() {`,
    `  const tok = await storage.getApiKey().catch(() => null);`,
    `  if (!tok) {`,
    `    throw Object.assign(new Error("credentials gone"), {`,
    `      errorCategory: "auth_config",`,
    `    });`,
    `  }`,
    `  return tok;`,
    `}`,
    ``,
  ].join("\n");
  assert(
    analyzeSource("/virtual/cat-inline.ts", inlineSrc).length === 1,
    "case 29b: swallow feeding an inline errorCategory-tagged throw is flagged",
  );
}

// ─── Case 30: transient *AuthUnknownError class stays excluded ───────
{
  // The confirm-before-trip UNKNOWN class is tagged `errorCategory =
  // "transient"` (NOT a permanent disconnect category). A swallow feeding a
  // throw of THAT class must NOT be flagged — that is the correct retryable
  // path, not a disconnect. (Mirrors the rule that keeps the real accessors
  // passing.)
  const transientSrc = [
    `import { storage } from "./storage";`,
    `class SemrushAuthUnknownError extends Error {`,
    `  public readonly errorCategory = "transient" as const;`,
    `}`,
    `export async function getAccessToken() {`,
    `  const tok = await storage.getSystemSetting("semrush_access_token").catch(() => null);`,
    `  if (!tok?.value) {`,
    `    throw new SemrushAuthUnknownError("read failed, will retry");`,
    `  }`,
    `  return tok.value;`,
    `}`,
    ``,
  ].join("\n");
  assert(
    analyzeSource("/virtual/cat-transient.ts", transientSrc).length === 0,
    "case 30: swallow feeding a transient-tagged throw is NOT flagged",
  );
}

// ─── Case 31: the real SEMrush accessor file passes ─────────────────
{
  // server/services/semrushApi.ts both DECLARES SemrushAuthMissingError
  // (errorCategory="auth_config") and THROWS it from getAccessToken — but it
  // uses try/catch confirm-before-trip on the authoritative read (no swallow),
  // so it must NOT be flagged even with category-tagged-throw detection on.
  const p = "server/services/semrushApi.ts";
  const offenders = analyzeSource(p, readFileSync(p, "utf8"));
  assert(
    offenders.length === 0,
    `case 31: ${p} (category-tagged-throw accessor) passes`,
  );
}

// ─── Case 32: injected swallow in the real SEMrush accessor is caught ─
{
  // Take the real SEMrush accessor and inject the swallow on the authoritative
  // cache-bypassing token re-read. The category-tagged SemrushAuthMissingError
  // throw downstream must make the lint flag it even though the SemrushApi
  // "not connected" message is not what trips this branch.
  const real = readFileSync("server/services/semrushApi.ts", "utf8");
  const injected = real.replace(
    "let tokenSetting = await storage.getSystemSetting(SETTINGS_KEY_ACCESS);",
    "let tokenSetting = await storage.getSystemSetting(SETTINGS_KEY_ACCESS).catch(() => null);",
  );
  assert(injected !== real, "case 32: injection point found in the real accessor");
  const offenders = analyzeSource("server/services/semrushApi.ts", injected);
  assert(
    offenders.some((o) => o.enclosingFn === "getAccessToken"),
    "case 32: a deliberately-added swallow in the real accessor is caught",
  );
}

// ─── Case 33: each newly-registered reconnect accessor is covered ───
{
  // Task #2443: the OTHER rotating-refresh-token accessors that compose a
  // "not connected" / "reconnect" throw independently are now registered too.
  // For each, assert (a) it is present in the registry and (b) the real source
  // file still has that function with a throw matching the shared patterns
  // (checkAccessorCoverage over just that entry reports no drift).
  const newlyRegistered: DisconnectThrowAccessor[] = [
    { file: "server/services/frontIntegration.ts", fn: "acquireValidFrontAccessToken" },
    { file: "server/services/zoomIntegration.ts", fn: "getAccessToken" },
    { file: "server/services/slackIntegration.ts", fn: "getBotToken" },
    { file: "server/services/pandadocIntegration.ts", fn: "getApiKey" },
    { file: "server/services/semrushApi.ts", fn: "getAccessToken" },
  ];
  for (const acc of newlyRegistered) {
    assert(
      DISCONNECT_THROW_ACCESSORS.some(
        (r) => r.file === acc.file && r.fn === acc.fn,
      ),
      `case 33: ${acc.fn}() in ${acc.file} is registered`,
    );
    const drift = checkAccessorCoverage([acc]);
    assert(
      drift.length === 0,
      `case 33: ${acc.fn}() in ${acc.file} still has a matching disconnect throw (got ${JSON.stringify(
        drift,
      )})`,
    );
  }
}

// ─── Case 34: a newly-registered accessor reworded fails loudly ─────
{
  // Prove the drift guard actually bites for the new shape: copy the real
  // Front leaf accessor but reword its confirmed-empty throw so NONE of the
  // shared patterns match. checkAccessorCoverage must flag it no-matched-throw,
  // and runLint (with that custom registry entry) must fail loudly.
  const root = mkdtempSync(join(tmpdir(), "lint-probe-swallow-front-drift-"));
  mkdirSync(join(root, "server"), { recursive: true });
  try {
    const accessorFile = join(root, "server", "frontLeaf.ts");
    writeFileSync(
      accessorFile,
      [
        `import { storage } from "./storage";`,
        `export async function acquireValidFrontAccessToken() {`,
        `  const access = await storage.getSystemSetting("front_access_token");`,
        `  const refresh = await storage.getSystemSetting("front_refresh_token");`,
        // Reworded away from "not connected" / "reconnect".
        `  if (!access?.value && !refresh?.value) throw new Error("Front link is gone");`,
        `  return access?.value ?? "";`,
        `}`,
        ``,
      ].join("\n"),
    );
    const registry: DisconnectThrowAccessor[] = [
      { file: accessorFile, fn: "acquireValidFrontAccessToken" },
    ];
    const drift = checkAccessorCoverage(registry);
    assert(
      drift.length === 1 && drift[0]?.reason === "no-matched-throw",
      "case 34: reworded Front leaf accessor flagged as no-matched-throw",
    );
    const result = runLint({
      roots: [join(root, "server")],
      accessorRegistry: registry,
    });
    assert(
      !result.ok && result.accessorDrift.length === 1,
      "case 34: runLint fails loudly on the reworded Front accessor",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(
  `\n[lint-probe-swallow-into-unauthorized] passed=${passed} failed=${failed}`,
);
if (failed > 0) process.exit(1);
process.exit(0);
