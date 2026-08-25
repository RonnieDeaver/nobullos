/**
 * Task #2285 — Guardrail so a new integration (or a new probe path on an
 * existing one) can't accidentally re-introduce the "health check
 * disconnects a still-valid connection" bug class fixed in Task #2267.
 *
 * Background (durable rules:
 *   .agents/memory/oauth-probe-refresh-no-wipe.md,
 *   .agents/memory/front-oauth-refresh-token-rotation.md):
 * Providers that rotate the refresh_token on every refresh (Front, Zoom,
 * Google, …) hand the captured token to the FIRST refresher; a second,
 * concurrent refresher — or a sibling instance — then POSTs the
 * already-consumed token and gets a terminal `invalid_grant` /
 * `invalid_request`. If a BACKGROUND health-check probe (or a pre-expiry
 * proactive top-up) treats that terminal outcome as authoritative, it
 * commits a durable disconnect — wipes stored tokens, writes
 * `status: "disconnected"`, or trips an auth-dead breaker — for a
 * connection another instance just rotated to a healthy token. The badge
 * flaps to "Not Connected" and every healthy surface backs off.
 *
 * Task #2267 fixed Front / Zoom / Google Ads / SEMrush by routing every
 * terminal-disconnect decision through `isAuthoritativeRefreshPurpose(purpose)`
 * (in `server/services/oauthRefresh.ts`) and tagging each probe/health
 * refresh with a NON-authoritative purpose (`front_probe`, `zoom_probe`,
 * `probe`, …). The correctness of the whole fix rests on two invariants
 * that nothing currently enforces:
 *
 *   (A) every refresh-token integration consults the shared classifier
 *       before committing a disconnect (an unguarded terminal branch
 *       re-introduces the bug), and
 *   (B) every integration's probe / health path tags its refresh with a
 *       purpose the classifier treats as non-authoritative (forgetting the
 *       tag re-introduces the bug from the other direction).
 *
 * This lint asserts both, by registry, importing the REAL
 * `isAuthoritativeRefreshPurpose` so the classification can never drift
 * from production behavior. It deliberately does NOT try to enumerate every
 * "disconnect sink" callee across `server/` — legitimate authoritative
 * disconnects (operator "Disconnect" routes, hard "no refresh token at all"
 * failures) share those callee names and would swamp the signal with false
 * positives. Anchoring on the refresh-token integrations + their registered
 * probe purposes keeps the rule precise.
 *
 * What it enforces, for every `server/**` file that issues an OAuth2
 * refresh-token grant POST (same detection as
 * lint-oauth-refresh-single-flight), minus the ALLOWLIST:
 *
 *   1. Registry completeness — the file MUST have a PROBE_PURPOSE_REGISTRY
 *      entry (or be allowlisted). A brand-new integration that ships a
 *      refresh path without registering + verifying its probe purpose fails
 *      here.
 *   2. Non-authoritative purposes — every probe purpose the registry names
 *      MUST satisfy `isAuthoritativeRefreshPurpose(purpose) === false`.
 *   3. Purpose present in source — every registered probe purpose MUST
 *      actually appear in the file as a `purpose: "<value>"` /
 *      `purpose = "<value>"` literal, so the registry can't drift away from
 *      the code it claims to describe.
 *   4. Classifier consulted — the file MUST reference
 *      `isAuthoritativeRefreshPurpose`, i.e. it gates its terminal-disconnect
 *      decisions on the classifier instead of committing them blind.
 *
 * Allowlist (mirrors the other lint scripts):
 *   - ALLOWLIST set below for whole-file exceptions (with a written reason).
 *
 * Exit codes: 0 ok, 1 if any integration violates the rules.
 *
 * Usage: npx tsx scripts/lint-probe-refresh-purpose.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isAuthoritativeRefreshPurpose } from "../server/services/oauthRefresh";

// Scope intentionally fixed (Task #2846): probe-purpose OAuth refresh calls
// only exist in server runtime integration/status code.
const ROOT = "server";
const CLASSIFIER_NAME = "isAuthoritativeRefreshPurpose";

/**
 * The OAuth2 refresh-token grant string, in the common body shapes
 * (URL-encoded form, JSON, object literal). Same set as
 * lint-oauth-refresh-single-flight so the two guards agree on exactly which
 * files are "refresh-token integrations".
 */
const REFRESH_GRANT_PATTERNS: RegExp[] = [
  /grant_type=refresh_token/,
  /grant_type"\s*:\s*"refresh_token"/,
  /grant_type:\s*["']refresh_token["']/,
];

/**
 * Probe / health refresh purposes per integration. Each integration that
 * holds a system-scoped rotating refresh token MUST appear here with the
 * exact purpose string(s) its probe / health / proactive paths pass. These
 * are asserted non-authoritative against the real classifier AND asserted to
 * actually appear in the source file.
 */
export const PROBE_PURPOSE_REGISTRY: ReadonlyMap<string, readonly string[]> =
  new Map<string, readonly string[]>([
    ["server/services/frontIntegration.ts", ["front_probe"]],
    ["server/services/zoomIntegration.ts", ["zoom_probe"]],
    ["server/services/semrushApi.ts", ["probe"]],
    // (Google Ads left the registry in Task #4008: googleAdsIntegration.ts
    // no longer POSTs to Google's token endpoint at all — every surface
    // mints via the shared env-trio path in adsOs/googleAdsClient.ts, and
    // status reads are cache-only.)
    // Task #2358 — Google Calendar is PER-USER OAuth, but it holds a
    // rotating refresh token and ALREADY routes every terminal-disconnect
    // decision through `isAuthoritativeRefreshPurpose` (Task #2286). Its own
    // background/best-effort path (the timezone backfill) defaults its
    // refresh to the non-authoritative `proactive` purpose. Registering it
    // here (instead of allowlisting) brings it under the same guard as the
    // system-wide integrations, so a future terminal-disconnect branch added
    // to this file can't silently drop the classifier gate.
    ["server/services/googleCalendarIntegration.ts", ["proactive"]],
  ]);

/**
 * Whole-file exceptions. Add a path here only with a written justification.
 * Mirrors the ALLOWLIST in scripts/lint-oauth-refresh-single-flight.ts.
 */
export const ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // Empty. Google Calendar (per-user OAuth) used to live here, but as of
  // Task #2358 it is REGISTERED in PROBE_PURPOSE_REGISTRY instead: it holds a
  // rotating refresh token and already gates its terminal-disconnect
  // decisions on `isAuthoritativeRefreshPurpose` (Task #2286), so the guard
  // applies to it the same way it applies to the system-wide integrations.
  // It is still allowlisted in lint-oauth-refresh-single-flight, because the
  // cross-process refresh LEASE is scoped to a single user's stored
  // credential rather than a system-wide breaker — a separate concern from
  // this probe-purpose guard.

  // Task #3596 — Ads OS Phase 0: the Ads OS Google Ads client is a separate
  // read-only module with a static env-var refresh token. It does NOT participate
  // in NoBull's integration probe/breaker/authoritative-refresh architecture:
  // there is no probe, no health-check, and no terminal-disconnect decision
  // path — the client either has a working token or surfaces AdsOsCredsMissing
  // at the call site. There is therefore no "probe purpose" to register.
  "server/services/adsOs/googleAdsClient.ts",
]);

export interface Violation {
  file: string;
  reason: string;
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

function issuesRefreshTokenPost(src: string): boolean {
  return REFRESH_GRANT_PATTERNS.some((re) => re.test(src));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True if `src` tags a refresh with `purpose` set to exactly `purpose`,
 * in either object-literal (`purpose: "x"`) or assignment (`purpose = "x"`)
 * form, with single/double/backtick quotes.
 */
function sourceTagsPurpose(src: string, purpose: string): boolean {
  const re = new RegExp(
    `purpose\\s*[:=]\\s*["'\`]${escapeRegex(purpose)}["'\`]`,
  );
  return re.test(src);
}

/**
 * Core, importable for tests. Scans `scanRoot`, applies `registry` +
 * `allowlist`, and returns every violation. Pure aside from filesystem
 * reads under `scanRoot`.
 */
export function runLint(opts?: {
  scanRoot?: string;
  registry?: ReadonlyMap<string, readonly string[]>;
  allowlist?: ReadonlySet<string>;
}): { ok: boolean; scanned: number; violations: Violation[] } {
  const scanRoot = opts?.scanRoot ?? ROOT;
  const registry = opts?.registry ?? PROBE_PURPOSE_REGISTRY;
  const allowlist = opts?.allowlist ?? ALLOWLIST;

  const files: string[] = [];
  walk(scanRoot, files);

  const violations: Violation[] = [];
  const matchedRegistryKeys = new Set<string>();

  for (const file of files) {
    if (allowlist.has(file)) continue;
    const src = readFileSync(file, "utf8");
    if (!issuesRefreshTokenPost(src)) continue;

    const purposes = registry.get(file);

    // (1) Registry completeness.
    if (!purposes) {
      violations.push({
        file,
        reason:
          `issues a refresh_token POST but has no PROBE_PURPOSE_REGISTRY entry. ` +
          `Register its probe/health refresh purpose(s) in ` +
          `scripts/lint-probe-refresh-purpose.ts (each must be non-authoritative), ` +
          `or add the file to ALLOWLIST with a written reason.`,
      });
      continue;
    }
    matchedRegistryKeys.add(file);

    if (purposes.length === 0) {
      violations.push({
        file,
        reason: `has an empty PROBE_PURPOSE_REGISTRY entry — name at least one probe/health purpose.`,
      });
    }

    for (const purpose of purposes) {
      // (2) Non-authoritative.
      if (isAuthoritativeRefreshPurpose(purpose)) {
        violations.push({
          file,
          reason:
            `registered probe purpose "${purpose}" is classified AUTHORITATIVE by ` +
            `${CLASSIFIER_NAME} — a probe/health refresh must use a non-authoritative ` +
            `purpose (e.g. one containing "probe" or "proactive") so a rotation-race ` +
            `terminal failure does NOT commit a disconnect.`,
        });
      }
      // (3) Purpose present in source.
      if (!sourceTagsPurpose(src, purpose)) {
        violations.push({
          file,
          reason:
            `registered probe purpose "${purpose}" never appears as a \`purpose\` ` +
            `literal in the file — the registry is out of sync with the code.`,
        });
      }
    }

    // (4) Classifier consulted.
    if (!src.includes(CLASSIFIER_NAME)) {
      violations.push({
        file,
        reason:
          `does not reference ${CLASSIFIER_NAME} — every terminal-disconnect ` +
          `decision (token wipe / status: "disconnected" / breaker trip) must be ` +
          `gated on it so a non-authoritative probe/proactive refresh can't disconnect.`,
      });
    }
  }

  // Stale registry entries (a registered file that no longer exists / no
  // longer issues a refresh POST) are reported so the registry stays honest.
  for (const key of registry.keys()) {
    if (allowlist.has(key)) continue;
    if (matchedRegistryKeys.has(key)) continue;
    let exists = false;
    let posts = false;
    try {
      const src = readFileSync(key, "utf8");
      exists = true;
      posts = issuesRefreshTokenPost(src);
    } catch {
      exists = false;
    }
    if (!exists) {
      violations.push({
        file: key,
        reason: `PROBE_PURPOSE_REGISTRY entry points at a file that does not exist — remove the stale entry.`,
      });
    } else if (!posts) {
      violations.push({
        file: key,
        reason: `PROBE_PURPOSE_REGISTRY entry no longer issues a refresh_token POST — remove the stale entry.`,
      });
    }
  }

  return { ok: violations.length === 0, scanned: files.length, violations };
}

export function cliMain(): number {
  const { ok, scanned, violations } = runLint();
  if (ok) {
    console.log(
      `lint-probe-refresh-purpose: OK (${scanned} files scanned, ` +
        `${PROBE_PURPOSE_REGISTRY.size} integration(s) registered, ` +
        `${ALLOWLIST.size} allowlisted)`,
    );
    return 0;
  }
  console.error(`lint-probe-refresh-purpose: ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.file}: ${v.reason}`);
  }
  console.error(
    `\nSee the header of scripts/lint-probe-refresh-purpose.ts and ` +
      `server/services/oauthRefresh.ts (${CLASSIFIER_NAME}).`,
  );
  return 1;
}

// Only run when invoked directly (not when imported by the test).
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  /lint-probe-refresh-purpose\.ts$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  process.exit(cliMain());
}
