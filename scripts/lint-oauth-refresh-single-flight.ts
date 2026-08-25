/**
 * Task #1975 / Task #2289 — Lint guard against ad-hoc OAuth
 * `refresh_token` POSTs AND against in-process-only refresh serialization.
 *
 * Rule 1 (Task #1975): every integration that holds an OAuth2 refresh
 * token must route the refresh POST through `withSingleFlightOAuthRefresh`
 * (in `server/services/oauthRefresh.ts`). Doing so collapses concurrent
 * in-process refreshers onto one POST and adds the re-read-and-retry
 * path that covers the cross-process race when a sibling instance
 * rotates the refresh token mid-flight. Skipping the helper is the bug
 * pattern that put SEMrush into "Disconnected" flap (token wipe on
 * race-induced `invalid_request`).
 *
 * Rule 1 detection: any file in `server/` that contains the literal
 *   `grant_type=refresh_token` or `grant_type":"refresh_token"`
 * (the OAuth2 grant_type body string) MUST also reference
 * `withSingleFlightOAuthRefresh` somewhere in the same file. The
 * helper itself is allowlisted.
 *
 * Rule 2 (Task #2289): in-process single-flight is NOT enough on
 * autoscale — N deployed instances plus the workspace process each run
 * their own in-memory single-flight Map, so concurrent refreshers across
 * processes still race and the loser POSTs a stale refresh token
 * (`invalid_grant`, which Front treats as terminal → recovery dies). Any
 * file that USES `withSingleFlightOAuthRefresh` must therefore also pass a
 * `crossProcessLease` so only one process refreshes at a time
 * (`server/services/oauthRefreshLease.ts`). Integrations not yet migrated
 * to the cross-process lease are tracked in LEASE_PENDING_ALLOWLIST and
 * must be removed from it as they migrate.
 *
 * Exit codes: 0 ok, 1 if any file violates either rule.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Scope intentionally fixed (Task #2846): OAuth refresh POSTs only exist in
// server runtime integration code; scripts/ and tests never issue rotating
// token refreshes directly.
const ROOT = "server";
const HELPER_NAME = "withSingleFlightOAuthRefresh";
const LEASE_NAME = "crossProcessLease";
const ALLOWLIST = new Set<string>([
  // The helper file itself does not perform an OAuth POST.
  "server/services/oauthRefresh.ts",
  // Task #3596 (updated by Task #4008) — the shared Google Ads env-trio
  // mint. Since Task #4008 this is THE token source for every Google Ads
  // surface (Ads OS pulls AND the platform integration's hygiene/discover/
  // sync paths). It uses a static env-var refresh token: NOT part of
  // NoBull's rotating OAuth flow, holds its own in-process 55-min TTL
  // access-token cache + terminal negative cache (not a persisted refresh
  // token that rotates on every use), and has no probe/authoritative
  // distinction. Wrapping it in withSingleFlightOAuthRefresh would wire it
  // into NoBull's shared integration-status breaker system, which is
  // architecturally wrong for a static env credential. The module manages
  // its own concurrency internally (one in-flight fetch, cache reads
  // without a lock).
  "server/services/adsOs/googleAdsClient.ts",
  // Task #1975 scope: Front, Zoom, SEMrush migrated. (Google Ads' rotating
  // platform OAuth flow retired in Task #4008 — env-only credential now.)
  // Task #2377: Google Calendar (per-user OAuth) now routes its refresh
  // through withSingleFlightOAuthRefresh with `subjectKey: userId` + a
  // per-user cross-process lease (lease key
  // `oauth_refresh_lease:google_calendar:<userId>`), so it is enforced by
  // both rules below rather than POST-allowlisted.
]);

// Task #2289 — files that use withSingleFlightOAuthRefresh but have NOT
// yet been migrated to the cross-process refresh lease. These are
// system-scoped, single refresh-token integrations whose refresh still
// races across processes; they share Front's exact failure mode and
// should each adopt `crossProcessLease` (see oauthRefreshLease.ts) and be
// removed from this list. Front migrated first because it was actively
// dying in prod (Task #2289). Zoom, SEMrush, and Google Ads migrated in
// Task #2361. Remove an entry when it wires the lease.
const LEASE_PENDING_ALLOWLIST = new Set<string>([]);

// Detect the OAuth2 refresh-token grant string in a few common shapes
// (URL-encoded form body, JSON body, object literal).
const PATTERNS: RegExp[] = [
  /grant_type=refresh_token/,
  /grant_type"\s*:\s*"refresh_token"/,
  /grant_type:\s*["']refresh_token["']/,
];

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

function fileMatchesRefreshTokenPost(src: string): boolean {
  return PATTERNS.some((re) => re.test(src));
}

export function cliMain(): number {
  const files: string[] = [];
  walk(ROOT, files);

  const violations: Array<{ file: string; reason: string }> = [];

  for (const file of files) {
    const src = readFileSync(file, "utf8");

    // Rule 1 — refresh_token POST must route through the single-flight helper.
    if (!ALLOWLIST.has(file) && fileMatchesRefreshTokenPost(src)) {
      if (!src.includes(HELPER_NAME)) {
        violations.push({
          file,
          reason: `Issues a refresh_token POST but does not reference ${HELPER_NAME}`,
        });
      }
    }

    // Rule 2 — any caller of the single-flight helper must also pass a
    // cross-process lease (Task #2289). The helper file defines the param;
    // the lease module references the helper name only in its doc comment.
    if (
      file !== "server/services/oauthRefresh.ts" &&
      file !== "server/services/oauthRefreshLease.ts" &&
      !LEASE_PENDING_ALLOWLIST.has(file) &&
      src.includes(HELPER_NAME) &&
      !src.includes(LEASE_NAME)
    ) {
      violations.push({
        file,
        reason: `Calls ${HELPER_NAME} but does not pass a ${LEASE_NAME} — in-process single-flight does not stop a cross-instance refresh race on autoscale`,
      });
    }
  }

  if (violations.length === 0) {
    console.log(
      `lint-oauth-refresh-single-flight: OK (${files.length} files scanned, ${ALLOWLIST.size} POST-allowlisted, ${LEASE_PENDING_ALLOWLIST.size} lease-pending)`,
    );
    return 0;
  }

  console.error(`lint-oauth-refresh-single-flight: ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.file}: ${v.reason}`);
  }
  console.error(
    `\nRule 1: wrap the refresh POST in withSingleFlightOAuthRefresh from server/services/oauthRefresh.ts,\n` +
      `or add the file path to ALLOWLIST in scripts/lint-oauth-refresh-single-flight.ts with a comment.\n` +
      `Rule 2: pass a crossProcessLease (server/services/oauthRefreshLease.ts) so only one process refreshes\n` +
      `at a time, or add the file to LEASE_PENDING_ALLOWLIST with a migration note.`,
  );
  return 1;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-oauth-refresh-single-flight.ts") ?? false);

if (isMain) {
  process.exit(cliMain());
}
