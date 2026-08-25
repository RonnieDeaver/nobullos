/* test-registration
{
  "name": "Settings token-cache deny-list lint guard (Task #3108)",
  "smoke": true,
  "smokeReason": "Task #3108: deny-list lint guard — the first assertion runs the real server/ tree to catch any token-bearing key name added without a corresponding deny-list entry. The Validate workflow runs npm run gate, including this SMOKE_FILES coverage. Fast, DB-free, deterministic (static source scan + tmpdir fixtures).",
  "tier": "small"
}
test-registration */
// Drift guard: token-bearing system_settings keys must be in the deny-list.
//
// Two groups of assertions:
//
//   Group A — lint behavior on fixture code
//     A1. A file with a token-bearing key literal NOT in the deny-list → violation.
//     A2. A file with the same key literal IN the deny-list → no violation.
//     A3. A key matching the deny-list file itself (settingsStorage.ts) is not
//         flagged even without being checked (ALLOWLIST_FILES).
//     A4. A non-token-bearing key (e.g. "redis_cache_enabled") is never flagged.
//     A5. Commented-out key literals are not flagged.
//     A6. A prefix-style credential key (e.g. "new_oauth_nonce:") NOT covered
//         by SETTINGS_CACHE_DENYLIST_PREFIXES → violation (regression fixture
//         for Task #3129).
//     A7. The same prefix covered by the deny-list prefixes → no violation.
//     A8. Template-literal dynamic keys (`some_oauth_nonce:${userId}`) are
//         detected too.
//
//   Group B — real tree scan
//     B1. The real server/ tree passes the lint (no uncovered token-bearing keys).
//
// Usage: tsx tests/lint-settings-token-cache.test.ts

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDenylist,
  parseDenylistPrefixes,
  parseRuntimeSuffixes,
  extractTokenBearingLiterals,
  extractCredentialPrefixLiterals,
  extractCredentialStructureLiterals,
  parseRuntimeStructureWords,
  runLint,
} from "../scripts/lint-settings-token-cache";
import {
  isSettingsCacheDenylisted,
  TOKEN_BEARING_KEY_SUFFIXES,
  CREDENTIAL_STRUCTURE_KEY_WORDS,
} from "../server/storage/settingsStorage";

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

console.log("\n[lint-settings-token-cache] regression suite");

// ─── parseDenylist ───────────────────────────────────────────────────────────
{
  const src = `
export const SETTINGS_CACHE_DENYLIST: ReadonlySet<string> = new Set([
  "zoom_access_token",
  "zoom_refresh_token",
  "front_access_token",
]);`;
  const dl = parseDenylist(src);
  assert(dl.has("zoom_access_token"), "parseDenylist: zoom_access_token present");
  assert(dl.has("zoom_refresh_token"), "parseDenylist: zoom_refresh_token present");
  assert(dl.has("front_access_token"), "parseDenylist: front_access_token present");
  assert(dl.size === 3, "parseDenylist: exactly 3 entries");
}

// ─── extractTokenBearingLiterals ─────────────────────────────────────────────
{
  const src = `
  const key = "semrush_access_token";
  const val = await storage.getSystemSetting("zoom_refresh_token");
  const cfg = await storage.getSystemSetting("redis_cache_enabled");
  // "front_oauth_state" is commented out
  const other = "some_random_setting";
  `;
  const found = extractTokenBearingLiterals(src);
  assert(found.includes("semrush_access_token"), "extractTokenBearingLiterals: semrush_access_token found");
  assert(found.includes("zoom_refresh_token"), "extractTokenBearingLiterals: zoom_refresh_token found");
  assert(!found.includes("redis_cache_enabled"), "extractTokenBearingLiterals: redis_cache_enabled NOT flagged");
  assert(!found.includes("some_random_setting"), "extractTokenBearingLiterals: some_random_setting NOT flagged");
  assert(!found.includes("front_oauth_state"), "extractTokenBearingLiterals: commented-out key NOT flagged");
}

// ─── parseDenylistPrefixes ───────────────────────────────────────────────────
{
  const src = `
export const SETTINGS_CACHE_DENYLIST_PREFIXES: readonly string[] = [
  "google_ads_oauth_nonce:",
  "clickup_oauth_nonce:",
];`;
  const prefixes = parseDenylistPrefixes(src);
  assert(prefixes.includes("google_ads_oauth_nonce:"), "parseDenylistPrefixes: google_ads_oauth_nonce: present");
  assert(prefixes.includes("clickup_oauth_nonce:"), "parseDenylistPrefixes: clickup_oauth_nonce: present");
  assert(prefixes.length === 2, "parseDenylistPrefixes: exactly 2 entries");
  assert(parseDenylistPrefixes("const x = 1;").length === 0, "parseDenylistPrefixes: empty when block absent");
}

// ─── extractCredentialPrefixLiterals ─────────────────────────────────────────
{
  const src = `
  const P1 = "some_new_oauth_nonce:";
  const key = \`other_oauth_state:\${userId}\`;
  const plain = "zoom_access_token";
  const notCred = "queue_drain_state:";
  const url = "https://example.com/path";
  // "commented_oauth_nonce:" should be ignored
  const sentinel = "no_oauth_nonce:";
  `;
  const found = extractCredentialPrefixLiterals(src);
  assert(found.includes("some_new_oauth_nonce:"), "extractCredentialPrefixLiterals: quoted prefix constant found");
  assert(found.includes("other_oauth_state:"), "extractCredentialPrefixLiterals: template-literal head found");
  assert(!found.includes("zoom_access_token:"), "extractCredentialPrefixLiterals: non-prefix exact key NOT flagged");
  assert(!found.includes("queue_drain_state:"), "extractCredentialPrefixLiterals: non-credential prefix NOT flagged");
  assert(!found.includes("commented_oauth_nonce:"), "extractCredentialPrefixLiterals: commented-out prefix NOT flagged");
  assert(!found.includes("no_oauth_nonce:"), "extractCredentialPrefixLiterals: sentinel prefix NOT flagged");
}

// ─── Group A: fixture-based lint behavior ────────────────────────────────────

const tmpRoot = mkdtempSync(join(tmpdir(), "lint-token-cache-"));
const tmpDenylistFile = join(tmpRoot, "settingsStorage.ts");

// Write a mini deny-list fixture with only zoom_access_token.
writeFileSync(
  tmpDenylistFile,
  `export const SETTINGS_CACHE_DENYLIST: ReadonlySet<string> = new Set([
  "zoom_access_token",
  "zoom_refresh_token",
  "zoom_token_expires_at",
  "zoom_oauth_state",
  "front_access_token",
  "front_refresh_token",
  "front_token_expires_at",
  "front_oauth_state",
  "semrush_access_token",
  "semrush_refresh_token",
  "semrush_token_expires_at",
  "semrush_device_code",
  "semrush_user_code",
  "semrush_device_expires_at",
  "twilio_auth_token",
  "twilio_api_key_secret",
  "stripe_secret_key",
  "slack_bot_token",
]);

export const SETTINGS_CACHE_DENYLIST_PREFIXES: readonly string[] = [
  "google_ads_oauth_nonce:",
];
`,
);

// A1 — key NOT in deny-list → violation
{
  const svcDir = join(tmpRoot, "services");
  mkdirSync(svcDir, { recursive: true });
  const badFile = join(svcDir, "hypotheticalIntegration.ts");
  writeFileSync(
    badFile,
    `const KEY = "new_integration_access_token";
export async function getToken() {
  return storage.getSystemSetting(KEY);
}
`,
  );
  const result = runLint({ root: tmpRoot, denylistFile: tmpDenylistFile });
  assert(!result.ok, "A1: violation detected for key not in deny-list");
  assert(
    result.violations.some((v) => v.key === "new_integration_access_token"),
    "A1: correct key flagged",
  );
  rmSync(badFile);
}

// A2 — key IN deny-list → no violation
{
  const svcDir = join(tmpRoot, "services");
  const goodFile = join(svcDir, "usesDenylisted.ts");
  writeFileSync(
    goodFile,
    `const KEY = "zoom_access_token";
export async function getToken() {
  return storage.getSystemSetting(KEY);
}
`,
  );
  const result = runLint({ root: tmpRoot, denylistFile: tmpDenylistFile });
  assert(result.ok, "A2: no violation for deny-listed key");
  rmSync(goodFile);
}

// A4 — non-token-bearing key never flagged
{
  const svcDir = join(tmpRoot, "services");
  const nonTokenFile = join(svcDir, "killSwitch.ts");
  writeFileSync(
    nonTokenFile,
    `const KEY = "redis_cache_enabled";
const KEY2 = "front_warp_speed_enabled";
const KEY3 = "zoom_token_keepalive_interval_ms";
`,
  );
  const result = runLint({ root: tmpRoot, denylistFile: tmpDenylistFile });
  assert(result.ok, "A4: no violation for non-token-bearing keys");
  rmSync(nonTokenFile);
}

// A5 — commented-out key not flagged
{
  const svcDir = join(tmpRoot, "services");
  const commentFile = join(svcDir, "commented.ts");
  writeFileSync(
    commentFile,
    `// const KEY = "hypothetical_client_secret";
// storage.getSystemSetting("other_bot_token");
const normal = "redis_cache_enabled";
`,
  );
  const result = runLint({ root: tmpRoot, denylistFile: tmpDenylistFile });
  assert(result.ok, "A5: commented-out token-bearing keys are not flagged");
  rmSync(commentFile);
}

// A6 — prefix-style credential key NOT covered by deny-list prefixes → violation
{
  const svcDir = join(tmpRoot, "services");
  const badFile = join(svcDir, "newNonceIntegration.ts");
  writeFileSync(
    badFile,
    `const NONCE_PREFIX = "some_new_oauth_nonce:";
export async function saveNonce(userId: string, nonce: string) {
  await storage.setSystemSetting(NONCE_PREFIX + userId, nonce);
}
`,
  );
  const result = runLint({ root: tmpRoot, denylistFile: tmpDenylistFile });
  assert(!result.ok, "A6: violation detected for prefix not in SETTINGS_CACHE_DENYLIST_PREFIXES");
  assert(
    result.violations.some((v) => v.key === "some_new_oauth_nonce:"),
    "A6: correct prefix flagged",
  );
  rmSync(badFile);
}

// A7 — prefix covered by deny-list prefixes → no violation
{
  const svcDir = join(tmpRoot, "services");
  const goodFile = join(svcDir, "coveredNonce.ts");
  writeFileSync(
    goodFile,
    `const NONCE_PREFIX = "google_ads_oauth_nonce:";
export async function saveNonce(userId: string, nonce: string) {
  await storage.setSystemSetting(NONCE_PREFIX + userId, nonce);
}
`,
  );
  const result = runLint({ root: tmpRoot, denylistFile: tmpDenylistFile });
  assert(result.ok, "A7: no violation for covered prefix");
  rmSync(goodFile);
}

// A8 — template-literal dynamic credential key detected
{
  const svcDir = join(tmpRoot, "services");
  const tplFile = join(svcDir, "templateNonce.ts");
  writeFileSync(
    tplFile,
    "export async function saveNonce(userId: string, nonce: string) {\n" +
      "  await storage.setSystemSetting(`brand_new_oauth_nonce:${userId}`, nonce);\n" +
      "}\n",
  );
  const result = runLint({ root: tmpRoot, denylistFile: tmpDenylistFile });
  assert(!result.ok, "A8: violation detected for uncovered template-literal prefix");
  assert(
    result.violations.some((v) => v.key === "brand_new_oauth_nonce:"),
    "A8: correct template-literal prefix flagged",
  );
  rmSync(tplFile);
}

// A9 — lockstep: runtime suffix list drifted (missing a lint pattern) → violation
{
  const driftedDenylistFile = join(tmpRoot, "driftedSettingsStorage.ts");
  writeFileSync(
    driftedDenylistFile,
    `export const SETTINGS_CACHE_DENYLIST: ReadonlySet<string> = new Set([
  "zoom_access_token",
]);
export const SETTINGS_CACHE_DENYLIST_PREFIXES: readonly string[] = [
  "google_ads_oauth_nonce:",
];
export const TOKEN_BEARING_KEY_SUFFIXES: readonly string[] = [
  "_access_token",
  "_refresh_token",
];
`,
  );
  const result = runLint({ root: tmpRoot, denylistFile: driftedDenylistFile });
  assert(!result.ok, "A9: lockstep violation detected when runtime suffix list is missing lint patterns");
  assert(
    result.violations.some((v) => v.key === "_oauth_state"),
    "A9: missing runtime suffix (_oauth_state) flagged",
  );
  rmSync(driftedDenylistFile);
}

// A10 — lockstep: runtime list has a suffix the lint doesn't scan → violation
{
  const extraDenylistFile = join(tmpRoot, "extraSettingsStorage.ts");
  const allLintSuffixes = [
    "_access_token", "_refresh_token", "_token_expires_at", "_auth_token",
    "_api_key_secret", "_secret_key", "_client_secret", "_device_code",
    "_device_expires_at", "_oauth_state", "_bot_token", "_user_code",
    "_oauth_nonce", "_nonce",
  ];
  writeFileSync(
    extraDenylistFile,
    `export const SETTINGS_CACHE_DENYLIST: ReadonlySet<string> = new Set([]);
export const SETTINGS_CACHE_DENYLIST_PREFIXES: readonly string[] = [];
export const TOKEN_BEARING_KEY_SUFFIXES: readonly string[] = [
${allLintSuffixes.map((s) => `  "${s}",`).join("\n")}
  "_session_cookie",
];
`,
  );
  const result = runLint({ root: tmpRoot, denylistFile: extraDenylistFile });
  assert(!result.ok, "A10: lockstep violation when runtime list has a suffix the lint doesn't audit");
  assert(
    result.violations.some((v) => v.key === "_session_cookie"),
    "A10: extra runtime suffix (_session_cookie) flagged",
  );
  rmSync(extraDenylistFile);
}

// A11 — fixture deny-list files WITHOUT the runtime block are skipped (no
// lockstep violation) — backward compat for the fixtures above.
{
  const result = runLint({ root: tmpRoot, denylistFile: tmpDenylistFile });
  assert(result.ok, "A11: no lockstep violation when TOKEN_BEARING_KEY_SUFFIXES block is absent");
}

// ─── extractCredentialStructureLiterals (Task #3394) ─────────────────────────
{
  const src = `
  const KEY = "aws_service_account_key";
  const K2 = "some_provider_private_key_pem";
  const K3 = "vendor_pkcs8_blob";
  const K4 = "firm_credentials_json";
  const K5 = "gcp_keyfile_contents";
  const field = parsed["private_key"];
  const field2 = "service_account";
  const table = "google_calendar_credentials";
  const sentinel = "no_service_account_key";
  const sentinel2 = "invalid_service_account_json";
  // "commented_service_account_key" should be ignored
  `;
  const found = extractCredentialStructureLiterals(src);
  assert(found.includes("aws_service_account_key"), "structure: service_account key found");
  assert(found.includes("some_provider_private_key_pem"), "structure: private_key key found");
  assert(found.includes("vendor_pkcs8_blob"), "structure: pkcs key found");
  assert(found.includes("firm_credentials_json"), "structure: credentials_json key found");
  assert(found.includes("gcp_keyfile_contents"), "structure: keyfile key found");
  assert(!found.includes("private_key"), "structure: bare JSON field name NOT flagged");
  assert(!found.includes("service_account"), "structure: bare structure word NOT flagged");
  assert(!found.includes("google_calendar_credentials"), "structure: table name without structure word NOT flagged");
  assert(!found.includes("no_service_account_key"), "structure: no_ sentinel NOT flagged");
  assert(!found.includes("invalid_service_account_json"), "structure: invalid_ sentinel NOT flagged");
  assert(!found.includes("commented_service_account_key"), "structure: commented-out key NOT flagged");
}

// A12 — credential-structure key NOT in deny-list → violation (the exact gap:
// a `_key`-suffixed service-account blob the suffix scans can't see).
{
  const svcDir = join(tmpRoot, "services");
  const badFile = join(svcDir, "futureServiceAccount.ts");
  writeFileSync(
    badFile,
    `const KEY = "aws_service_account_key";
export async function getKey() {
  return storage.getSystemSetting(KEY);
}
`,
  );
  const result = runLint({ root: tmpRoot, denylistFile: tmpDenylistFile });
  assert(!result.ok, "A12: violation detected for uncovered service-account-style key");
  assert(
    result.violations.some(
      (v) => v.key === "aws_service_account_key" && v.reason.includes("credential-structure"),
    ),
    "A12: correct key flagged with credential-structure reason",
  );
  rmSync(badFile);
}

// A13 — the same credential-structure key IN the deny-list → no violation.
{
  const denylistWithSA = join(tmpRoot, "settingsStorageWithSA.ts");
  writeFileSync(
    denylistWithSA,
    readFileSync(tmpDenylistFile, "utf8").replace(
      `"stripe_secret_key",`,
      `"stripe_secret_key",\n  "aws_service_account_key",`,
    ),
  );
  const svcDir = join(tmpRoot, "services");
  const goodFile = join(svcDir, "coveredServiceAccount.ts");
  writeFileSync(
    goodFile,
    `const KEY = "aws_service_account_key";
export async function getKey() {
  return storage.getSystemSetting(KEY);
}
`,
  );
  const result = runLint({ root: tmpRoot, denylistFile: denylistWithSA });
  assert(result.ok, "A13: no violation when the service-account key is deny-listed");
  rmSync(goodFile);
  rmSync(denylistWithSA);
}

rmSync(tmpRoot, { recursive: true, force: true });

// ─── Real-tree pin: google_service_account_key (Task #3394) ─────────────────
{
  const realSrc = readFileSync("server/storage/settingsStorage.ts", "utf8");
  const realDenylist = parseDenylist(realSrc);
  assert(
    realDenylist.has("google_service_account_key"),
    "real: google_service_account_key is in SETTINGS_CACHE_DENYLIST",
  );
  const realHit = extractCredentialStructureLiterals(`const k = "google_service_account_key";`);
  assert(
    realHit.includes("google_service_account_key"),
    "real: google_service_account_key matches the new structure rule (would be caught if removed from deny-list)",
  );
}

// ─── Group C: runtime suffix safety net (isSettingsCacheDenylisted) ─────────
console.log("\n  [C] Runtime suffix safety net …");
{
  // C1 — a brand-new integration's token keys are cache-bypassed even though
  // they are NOT in the explicit deny-list (the exact gap Task #3118 closes:
  // runtime-built keys / DB-write-only paths the lint can't see).
  assert(
    isSettingsCacheDenylisted("hypothetical_future_access_token"),
    "C1: future *_access_token key bypasses cache without explicit listing",
  );
  assert(
    isSettingsCacheDenylisted("hypothetical_future_refresh_token"),
    "C1: future *_refresh_token key bypasses cache without explicit listing",
  );
  assert(
    isSettingsCacheDenylisted("hypothetical_future_client_secret"),
    "C1: future *_client_secret key bypasses cache without explicit listing",
  );
  // C2 — dynamic per-user keys: suffix matches the name part before ":".
  assert(
    isSettingsCacheDenylisted("hypothetical_future_oauth_nonce:user-123"),
    "C2: future per-user *_oauth_nonce:<userId> key bypasses cache",
  );
  assert(
    isSettingsCacheDenylisted("hypothetical_future_oauth_state"),
    "C2: future *_oauth_state key bypasses cache",
  );
  // C3 — explicit deny-list entries still work.
  assert(
    isSettingsCacheDenylisted("zoom_access_token"),
    "C3: explicit deny-list entry still bypasses cache",
  );
  assert(
    isSettingsCacheDenylisted("google_ads_oauth_nonce:user-123"),
    "C3: explicit deny-list prefix still bypasses cache",
  );
  // C4 — ordinary settings keys still flow through the Redis cache.
  assert(
    !isSettingsCacheDenylisted("redis_cache_enabled"),
    "C4: ordinary config key is NOT bypassed",
  );
  assert(
    !isSettingsCacheDenylisted("zoom_token_keepalive_interval_ms"),
    "C4: token-adjacent but non-secret key is NOT bypassed",
  );
  assert(
    !isSettingsCacheDenylisted("queue_drain_state:front_sync"),
    "C4: dynamic non-credential key is NOT bypassed",
  );
  // C5 — the shipped runtime list parses identically from source (the exact
  // list the lint lockstep-checks) and matches the exported constant.
  const realSrc = readFileSync("server/storage/settingsStorage.ts", "utf8");
  const parsed = parseRuntimeSuffixes(realSrc);
  assert(parsed !== null, "C5: TOKEN_BEARING_KEY_SUFFIXES block parses from real source");
  assert(
    parsed !== null &&
      parsed.length === TOKEN_BEARING_KEY_SUFFIXES.length &&
      parsed.every((s, i) => s === TOKEN_BEARING_KEY_SUFFIXES[i]),
    "C5: parsed runtime suffixes match the exported constant exactly",
  );

  // C6 — Task #3401: credential-STRUCTURE keys bypass the cache at RUNTIME,
  // not just at lint time. A hypothetical future key like
  // `acme_service_account_key` (ends in `_key`, no token-bearing suffix)
  // built at runtime or written via a DB-only path must never be Redis-cached.
  assert(
    isSettingsCacheDenylisted("acme_service_account_key"),
    "C6: future *service_account* key bypasses cache without explicit listing",
  );
  assert(
    isSettingsCacheDenylisted("some_provider_private_key_pem"),
    "C6: future *private_key* key bypasses cache",
  );
  assert(
    isSettingsCacheDenylisted("vendor_pkcs8_blob"),
    "C6: future *pkcs* key bypasses cache",
  );
  assert(
    isSettingsCacheDenylisted("firm_credentials_json"),
    "C6: future *credentials_json* key bypasses cache",
  );
  assert(
    isSettingsCacheDenylisted("gcp_keyfile_contents"),
    "C6: future *keyfile* key bypasses cache",
  );
  // C7 — dynamic per-user structure-word keys: matched on the name part
  // before ":".
  assert(
    isSettingsCacheDenylisted("acme_service_account_key:user-123"),
    "C7: per-user structure-word key bypasses cache",
  );
  // C8 — bare structure words are JSON field names, not settings keys;
  // they must NOT be bypassed (mirrors the lint's bare-word exclusion).
  assert(
    !isSettingsCacheDenylisted("private_key"),
    "C8: bare structure word 'private_key' is NOT bypassed",
  );
  assert(
    !isSettingsCacheDenylisted("service_account"),
    "C8: bare structure word 'service_account' is NOT bypassed",
  );
  // C9 — ordinary keys without a structure word still flow through the cache.
  assert(
    !isSettingsCacheDenylisted("google_calendar_credentials"),
    "C9: name without a structure word is NOT bypassed",
  );
  // C10 — the shipped runtime structure-word list parses identically from
  // source (the exact list the lint lockstep-checks) and matches the
  // exported constant.
  const parsedWords = parseRuntimeStructureWords(realSrc);
  assert(
    parsedWords !== null,
    "C10: CREDENTIAL_STRUCTURE_KEY_WORDS block parses from real source",
  );
  assert(
    parsedWords !== null &&
      parsedWords.length === CREDENTIAL_STRUCTURE_KEY_WORDS.length &&
      parsedWords.every((s, i) => s === CREDENTIAL_STRUCTURE_KEY_WORDS[i]),
    "C10: parsed runtime structure words match the exported constant exactly",
  );
}

// ─── Group B: real tree scan ─────────────────────────────────────────────────
console.log("\n  [B] Real tree scan …");
{
  const result = runLint();
  if (result.ok) {
    console.log(
      `  ✓ B1: real server/ tree passes (${result.filesScanned} files, ${result.denylistSize} deny-listed keys)`,
    );
    passed++;
  } else {
    failed++;
    console.error("  ✗ B1: real server/ tree FAILED — token-bearing keys not in deny-list:");
    for (const v of result.violations) {
      console.error(`    ${v.file}: ${v.reason}`);
    }
  }
}

// ─── Group C: Google Ads token-store audit (Task #3117) ─────────────────────
// Google Ads is deliberately NOT in SETTINGS_CACHE_DENYLIST because its
// OAuth access/refresh tokens live in the dedicated `google_ads_connection`
// table (direct DB read in server/storage/googleAdsStorage.ts — no Redis
// read-through cache in the path), not in `system_settings`. These
// assertions pin that audit result so a future refactor that moves the
// tokens into settings keys, or drops the nonce-prefix coverage, fails here.
console.log("\n  [C] Google Ads token-store audit …");
{
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const path = await import("node:path");

  // C1 — the google_ads_oauth_nonce: prefix retired with the in-app Google
  // Ads OAuth flow (Task #4008) and must NOT quietly come back; the remaining
  // per-user nonce prefixes stay covered. (Any legacy google_ads_oauth_nonce
  // rows would still bypass the cache via the `_oauth_nonce` suffix net.)
  const denySrc = readFileSync("server/storage/settingsStorage.ts", "utf8");
  const realPrefixes = parseDenylistPrefixes(denySrc);
  assert(
    !realPrefixes.includes("google_ads_oauth_nonce:"),
    "C1: google_ads_oauth_nonce: prefix stays retired (Task #4008 — no in-app Google Ads OAuth flow mints nonces)",
  );
  assert(
    realPrefixes.includes("google_calendar_oauth_nonce:"),
    "C1: google_calendar_oauth_nonce: remains in SETTINGS_CACHE_DENYLIST_PREFIXES",
  );

  // C2 — no `google_ads_access_token` / `google_ads_refresh_token` /
  // `google_ads_token_expires_at` settings-key literals anywhere in server/.
  // If someone moves Google Ads tokens into system_settings, this fails and
  // forces a deny-list entry (the B1 suffix scan would also catch it; this
  // makes the Google Ads-specific audit conclusion explicit).
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        const src = readFileSync(full, "utf8");
        const lits = extractTokenBearingLiterals(src);
        for (const lit of lits) {
          if (lit.startsWith("google_ads_")) offenders.push(`${full}: ${lit}`);
        }
      }
    }
  };
  walk("server");
  assert(
    offenders.length === 0,
    `C2: no google_ads_* token-bearing settings-key literals in server/ (found: ${offenders.join(", ") || "none"})`,
  );

  // C3 — Task #4008: Google Ads credentials live ONLY in the GOOGLE_ADS_*
  // env secrets (no DB row, no system_settings). googleAdsStorage must not
  // reference the dropped connection table nor read token material via
  // getSystemSetting — either would mean credential material crept back
  // into a cacheable store.
  const storageSrc = readFileSync("server/storage/googleAdsStorage.ts", "utf8");
  assert(
    !/googleAdsConnection/.test(storageSrc),
    "C3: googleAdsStorage.ts no longer references the dropped google_ads_connection table (Task #4008)",
  );
  assert(
    !/getSystemSetting\(/.test(storageSrc),
    "C3: googleAdsStorage.ts never reads token material via getSystemSetting",
  );
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n[lint-settings-token-cache] ${passed} passed, ${failed} failed`);
// Explicit exit: importing server/storage/settingsStorage (for the Group C
// runtime-predicate assertions) transitively creates the pg pools, whose
// ref'd idle-reaper timers keep the event loop alive outside NODE_ENV=test.
// All assertions are synchronous and complete by this point, so exiting
// here is safe and prevents a hanging test process.
process.exit(failed > 0 ? 1 : 0);
