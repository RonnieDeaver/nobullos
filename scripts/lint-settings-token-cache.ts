/**
 * Drift guard: token-bearing system_settings keys must be in the deny-list.
 *
 * Background: `storage.getSystemSetting` routes through a Redis read-through
 * cache (5-minute TTL). This is fine for stable config values but fatal for
 * rotating OAuth tokens — a stale cached access token after a rotation causes
 * 401 storms (Zoom code 124 "Invalid access token.", SEMrush, Front). The fix
 * adds `SETTINGS_CACHE_DENYLIST` in `server/storage/settingsStorage.ts` and
 * makes every read for a deny-listed key go directly to the DB.
 *
 * What this guard checks: any string literal used as a system_settings key in
 * `server/` that matches a token-bearing naming pattern (e.g. `*_access_token`,
 * `*_refresh_token`, `*_auth_token`, `*_secret_key`, `*_api_key_secret`,
 * `*_bot_token`, `*_oauth_state`, `*_device_code`, `*_device_expires_at`,
 * `*_token_expires_at`, `*_client_secret`, `*_user_code`) must appear in
 * SETTINGS_CACHE_DENYLIST. A new token-bearing key added to server/ code without
 * also being added to the deny-list fails this guard.
 *
 * It ALSO guards prefix-style credential keys (Task #3129): dynamic per-user
 * credential keys like `google_calendar_oauth_nonce:<userId>` can never appear
 * in the exact-key Set, so they must be covered by
 * SETTINGS_CACHE_DENYLIST_PREFIXES. Any string literal or template-literal
 * head in server/ that ends with `:` and whose name part matches a
 * credential naming pattern (the token-bearing suffixes above, plus
 * `_oauth_nonce` / `_nonce`) must be covered by a deny-listed prefix.
 *
 * Exit codes: 0 ok, 1 if any violation found.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "server";
const DENYLIST_FILE = "server/storage/settingsStorage.ts";

// Naming patterns that indicate a system_settings key holds token material.
// A string literal in server/ matching any of these patterns must be in the
// deny-list. Patterns are suffix-based (the key name ends with this string).
const TOKEN_BEARING_SUFFIXES: string[] = [
  "_access_token",
  "_refresh_token",
  "_token_expires_at",
  "_auth_token",
  "_api_key_secret",
  "_secret_key",
  "_client_secret",
  "_device_code",
  "_device_expires_at",
  "_oauth_state",
  "_bot_token",
  "_user_code",
];

// Naming patterns that indicate a PREFIX literal (a string ending with ":")
// is used to build dynamic per-user credential keys. The name part (before
// the trailing ":") must match one of these suffixes. Includes all
// token-bearing suffixes above plus nonce-style names, which only ever
// appear as prefixes (`some_oauth_nonce:<userId>`).
const CREDENTIAL_PREFIX_SUFFIXES: string[] = [
  ...TOKEN_BEARING_SUFFIXES,
  "_oauth_nonce",
  "_nonce",
];

// Task #3394: credential-STRUCTURE words. `google_service_account_key` ends
// in `_key` (not a recognized token-bearing suffix like `_secret_key`), so
// the suffix scans above would never have caught it — it had to be added to
// the deny-list by hand. Any future setting holding a JSON credential blob,
// PKCS8 private key, or service-account key under a non-standard name faces
// the same silent gap. This list catches those by SUBSTRING match: any
// snake_case string literal in server/ whose name CONTAINS one of these
// words must be in SETTINGS_CACHE_DENYLIST (or covered by a deny-listed
// prefix). Bare-word literals (a literal that IS exactly the structure word,
// e.g. the JSON field name "private_key" inside a parsed service-account
// blob) are excluded — a settings key always carries a provider prefix.
const CREDENTIAL_STRUCTURE_WORDS: string[] = [
  "service_account",
  "private_key",
  "pkcs",
  "credentials_json",
  "keyfile",
];

// Task #3118: settingsStorage.ts now carries a RUNTIME suffix safety net
// (TOKEN_BEARING_KEY_SUFFIXES) so keys built at runtime (template literals,
// concatenation, DB-only write paths) also bypass the Redis cache. That list
// must stay in lockstep with the naming patterns this lint scans for —
// otherwise the lint could flag a pattern the runtime doesn't protect, or
// the runtime could protect a pattern the lint never audits. runLint()
// parses the runtime list from the deny-list file and compares it against
// CREDENTIAL_PREFIX_SUFFIXES (the full pattern set: token suffixes + nonce
// suffixes).

// Files that are allowed to reference token-bearing key literals without
// being in violation (the storage layer itself defines + enforces the list).
const ALLOWLIST_FILES = new Set<string>([
  "server/storage/settingsStorage.ts",
]);

// String patterns that indicate the literal is a SENTINEL or error-state
// value, not a settings key. These appear as type-union members, return
// values from auth-breaker helpers, or reason codes — never as an argument
// to getSystemSetting / setSystemSetting. We exclude them before flagging.
//
//   Excluded patterns:
//   - contains `_no_` as an interior segment  (e.g. "front_no_refresh_token")
//   - starts with "no_"                        (e.g. "no_refresh_token")
//   - starts with "missing_"                   (e.g. "missing_auth_token")
//   - starts with "invalid_"                    (e.g. "invalid_service_account_json")
const SENTINEL_PATTERNS: Array<(s: string) => boolean> = [
  (s) => s.startsWith("no_"),
  (s) => s.startsWith("missing_"),
  (s) => s.startsWith("invalid_"),
  (s) => s.includes("_no_"),
];

/**
 * Parse the SETTINGS_CACHE_DENYLIST from settingsStorage.ts.
 * Returns the set of key strings extracted from the `new Set([...])` literal.
 */
export function parseDenylist(src: string): Set<string> {
  const result = new Set<string>();
  // Find the SETTINGS_CACHE_DENYLIST block — everything between the
  // `new Set([` and the closing `])`.
  const blockMatch = src.match(/SETTINGS_CACHE_DENYLIST[^=]*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/);
  if (!blockMatch) return result;
  const block = blockMatch[1];
  // Extract all double-quoted string literals from the block.
  const literalRe = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = literalRe.exec(block)) !== null) {
    result.add(m[1]);
  }
  return result;
}

/**
 * Parse SETTINGS_CACHE_DENYLIST_PREFIXES from settingsStorage.ts.
 * Returns the list of prefix strings extracted from the array literal.
 */
export function parseDenylistPrefixes(src: string): string[] {
  const result: string[] = [];
  const blockMatch = src.match(
    /SETTINGS_CACHE_DENYLIST_PREFIXES[^=]*=\s*\[([\s\S]*?)\]/,
  );
  if (!blockMatch) return result;
  const literalRe = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = literalRe.exec(blockMatch[1])) !== null) {
    result.push(m[1]);
  }
  return result;
}

/**
 * Parse TOKEN_BEARING_KEY_SUFFIXES from settingsStorage.ts.
 * Returns the list of suffix strings extracted from the array literal, or
 * null when the block is absent (older fixture files).
 */
export function parseRuntimeSuffixes(src: string): string[] | null {
  const blockMatch = src.match(
    /TOKEN_BEARING_KEY_SUFFIXES[^=]*=\s*\[([\s\S]*?)\]/,
  );
  if (!blockMatch) return null;
  const result: string[] = [];
  // Strip comments inside the block so commented-out entries are ignored.
  const block = blockMatch[1].replace(/\/\/[^\n]*/g, "");
  const literalRe = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = literalRe.exec(block)) !== null) {
    result.push(m[1]);
  }
  return result;
}

/**
 * Parse CREDENTIAL_STRUCTURE_KEY_WORDS from settingsStorage.ts.
 * Returns the list of structure-word strings extracted from the array
 * literal, or null when the block is absent (older fixture files). Used for
 * the lockstep check between this lint's CREDENTIAL_STRUCTURE_WORDS and the
 * runtime cache-bypass net (Task #3401, mirroring the runtime-suffix
 * lockstep above).
 */
export function parseRuntimeStructureWords(src: string): string[] | null {
  const blockMatch = src.match(
    /CREDENTIAL_STRUCTURE_KEY_WORDS[^=]*=\s*\[([\s\S]*?)\]/,
  );
  if (!blockMatch) return null;
  const result: string[] = [];
  // Strip comments inside the block so commented-out entries are ignored.
  const block = blockMatch[1].replace(/\/\/[^\n]*/g, "");
  const literalRe = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = literalRe.exec(block)) !== null) {
    result.push(m[1]);
  }
  return result;
}

/**
 * Given the source of a file, return all prefix-style credential literals:
 * string literals or template-literal heads that end with ":" and whose
 * name part matches a credential naming pattern (CREDENTIAL_PREFIX_SUFFIXES).
 * Catches both `const P = "some_oauth_nonce:"` constants and inline
 * template keys like `` `some_oauth_nonce:${userId}` ``.
 */
export function extractCredentialPrefixLiterals(src: string): string[] {
  const found: string[] = [];
  const stripped = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  // Match "prefix:", 'prefix:', or `prefix:${ — the name must look like a
  // settings key (lowercase snake_case) and end with a colon.
  const literalRe = /["'`]([a-z][a-z0-9_]*):/g;
  let m: RegExpExecArray | null;
  while ((m = literalRe.exec(stripped)) !== null) {
    const name = m[1];
    if (
      CREDENTIAL_PREFIX_SUFFIXES.some((suf) => name.endsWith(suf)) &&
      !SENTINEL_PATTERNS.some((test) => test(name))
    ) {
      found.push(`${name}:`);
    }
  }
  return found;
}

/**
 * Given the source of a file, return all string literals (double-quoted)
 * that match at least one token-bearing suffix pattern AND are not excluded
 * by a SENTINEL_PATTERNS match. Sentinel strings appear as error codes,
 * type-union members, or auth-breaker reason values — never as settings keys.
 */
export function extractTokenBearingLiterals(src: string): string[] {
  const found: string[] = [];
  // Strip single-line comments so we don't pick up commented-out keys.
  const stripped = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const literalRe = /"([a-z][a-z0-9_]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = literalRe.exec(stripped)) !== null) {
    const lit = m[1];
    if (
      TOKEN_BEARING_SUFFIXES.some((suf) => lit.endsWith(suf)) &&
      !SENTINEL_PATTERNS.some((test) => test(lit))
    ) {
      found.push(lit);
    }
  }
  return found;
}

/**
 * Given the source of a file, return all snake_case string literals whose
 * name CONTAINS a credential-structure word (CREDENTIAL_STRUCTURE_WORDS) —
 * e.g. "google_service_account_key" — excluding sentinels and bare-word
 * literals (a literal that is exactly the structure word is a JSON field
 * name, not a settings key). Task #3394.
 */
export function extractCredentialStructureLiterals(src: string): string[] {
  const found: string[] = [];
  const stripped = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const literalRe = /"([a-z][a-z0-9_]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = literalRe.exec(stripped)) !== null) {
    const lit = m[1];
    if (
      CREDENTIAL_STRUCTURE_WORDS.some(
        (word) => lit.includes(word) && lit !== word,
      ) &&
      !SENTINEL_PATTERNS.some((test) => test(lit))
    ) {
      found.push(lit);
    }
  }
  return found;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent === "node_modules" || ent.startsWith(".")) continue;
    const full = join(dir, ent);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!full.endsWith(".ts") && !full.endsWith(".tsx")) continue;
    out.push(full);
  }
}

export interface LintResult {
  ok: boolean;
  filesScanned: number;
  denylistSize: number;
  violations: Array<{ file: string; key: string; reason: string }>;
}

export function runLint(opts?: { root?: string; denylistFile?: string }): LintResult {
  const root = opts?.root ?? ROOT;
  const denylistFile = opts?.denylistFile ?? DENYLIST_FILE;

  let denySrc: string;
  try {
    denySrc = readFileSync(denylistFile, "utf8");
  } catch (err: any) {
    return {
      ok: false,
      filesScanned: 0,
      denylistSize: 0,
      violations: [{ file: denylistFile, key: "", reason: `Could not read denylist file: ${err?.message ?? err}` }],
    };
  }

  const denylist = parseDenylist(denySrc);
  const denylistPrefixes = parseDenylistPrefixes(denySrc);
  const violations: LintResult["violations"] = [];

  // Lockstep check: the runtime suffix safety net in settingsStorage.ts must
  // cover exactly the same naming patterns this lint scans for. Skip when the
  // block is absent (fixture deny-list files used by unit tests).
  const runtimeSuffixes = parseRuntimeSuffixes(denySrc);
  if (runtimeSuffixes !== null) {
    const runtimeSet = new Set(runtimeSuffixes);
    const lintSet = new Set(CREDENTIAL_PREFIX_SUFFIXES);
    for (const suf of lintSet) {
      if (!runtimeSet.has(suf)) {
        violations.push({
          file: denylistFile,
          key: suf,
          reason: `lint pattern "${suf}" is missing from TOKEN_BEARING_KEY_SUFFIXES in ${denylistFile} — the runtime cache-bypass safety net must cover every pattern this lint scans for`,
        });
      }
    }
    for (const suf of runtimeSet) {
      if (!lintSet.has(suf)) {
        violations.push({
          file: denylistFile,
          key: suf,
          reason: `runtime suffix "${suf}" in TOKEN_BEARING_KEY_SUFFIXES is not in this lint's pattern list — add it to TOKEN_BEARING_SUFFIXES (or CREDENTIAL_PREFIX_SUFFIXES) in scripts/lint-settings-token-cache.ts so literals with that pattern are audited too`,
        });
      }
    }
  }

  // Lockstep check (Task #3401): the runtime credential-structure-word net
  // in settingsStorage.ts must cover exactly the same structure words this
  // lint scans for. Skip when the block is absent (fixture deny-list files).
  const runtimeStructureWords = parseRuntimeStructureWords(denySrc);
  if (runtimeStructureWords !== null) {
    const runtimeWordSet = new Set(runtimeStructureWords);
    const lintWordSet = new Set(CREDENTIAL_STRUCTURE_WORDS);
    for (const word of lintWordSet) {
      if (!runtimeWordSet.has(word)) {
        violations.push({
          file: denylistFile,
          key: word,
          reason: `lint structure word "${word}" is missing from CREDENTIAL_STRUCTURE_KEY_WORDS in ${denylistFile} — the runtime cache-bypass safety net must cover every credential-structure word this lint scans for`,
        });
      }
    }
    for (const word of runtimeWordSet) {
      if (!lintWordSet.has(word)) {
        violations.push({
          file: denylistFile,
          key: word,
          reason: `runtime structure word "${word}" in CREDENTIAL_STRUCTURE_KEY_WORDS is not in this lint's CREDENTIAL_STRUCTURE_WORDS in scripts/lint-settings-token-cache.ts — add it so literals containing that word are audited too`,
        });
      }
    }
  }

  const files: string[] = [];
  walk(root, files);

  for (const file of files) {
    if (ALLOWLIST_FILES.has(file)) continue;
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const literals = extractTokenBearingLiterals(src);
    for (const lit of literals) {
      if (!denylist.has(lit)) {
        violations.push({
          file,
          key: lit,
          reason: `"${lit}" matches a token-bearing naming pattern but is absent from SETTINGS_CACHE_DENYLIST in server/storage/settingsStorage.ts — add it to the deny-list so Redis never caches this key`,
        });
      }
    }
    const structureLiterals = extractCredentialStructureLiterals(src);
    for (const lit of structureLiterals) {
      const coveredByPrefix = denylistPrefixes.some((dp) =>
        lit.startsWith(dp.replace(/:$/, "")),
      );
      if (!denylist.has(lit) && !coveredByPrefix) {
        violations.push({
          file,
          key: lit,
          reason: `"${lit}" contains a credential-structure word (service_account / private_key / pkcs / credentials_json / keyfile) but is absent from SETTINGS_CACHE_DENYLIST in server/storage/settingsStorage.ts — credential blobs must never be cached in Redis; add the key to the deny-list (or, if it is NOT a system_settings key, rename it so it doesn't look like one)`,
        });
      }
    }
    const prefixLiterals = extractCredentialPrefixLiterals(src);
    for (const pref of prefixLiterals) {
      const covered = denylistPrefixes.some(
        (dp) => pref === dp || pref.startsWith(dp),
      );
      if (!covered) {
        violations.push({
          file,
          key: pref,
          reason: `"${pref}" looks like a dynamic per-user credential key prefix but is not covered by SETTINGS_CACHE_DENYLIST_PREFIXES in server/storage/settingsStorage.ts — add the prefix so Redis never caches keys built from it`,
        });
      }
    }
  }

  return {
    ok: violations.length === 0,
    filesScanned: files.length,
    denylistSize: denylist.size,
    violations,
  };
}

function main(): void {
  const result = runLint();
  if (result.ok) {
    console.log(
      `lint-settings-token-cache: OK (${result.filesScanned} files scanned, ${result.denylistSize} deny-listed keys)`,
    );
    process.exit(0);
  }
  console.error(`lint-settings-token-cache: ${result.violations.length} violation(s):`);
  for (const v of result.violations) {
    console.error(`  ${v.file}: ${v.reason}`);
  }
  console.error(
    `\nFix: add the key to SETTINGS_CACHE_DENYLIST in server/storage/settingsStorage.ts\n` +
      `so getSystemSetting() bypasses Redis for that key and always reads DB truth.\n` +
      `See the comment block above SETTINGS_CACHE_DENYLIST for the maintenance contract.`,
  );
  process.exit(1);
}

// Guard against process.exit firing when imported as a module in tests.
const isMain =
  process.argv[1]?.endsWith("lint-settings-token-cache.ts") ||
  process.argv[1]?.endsWith("lint-settings-token-cache.js");
if (isMain) main();
