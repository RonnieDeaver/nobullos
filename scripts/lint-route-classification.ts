/**
 * lint-route-classification.ts (Task #4180 — Architecture Governor first-wave
 * guard #2, activation approved per audits/architecture-governor-hardening-
 * epic-approval.md).
 *
 * Every API route must be classified (tests/route-inventory.ts#authClass):
 *   session | machine_token | signed_webhook | observed_public
 *
 * There is NO blanket /api auth guard in this codebase — protection is
 * per-route middleware arrays, so an omitted middleware ships a public route
 * and nothing fails closed. This guard makes that omission loud:
 *
 * Checks:
 *   1. Every OBSERVED-PUBLIC route (no recognized auth middleware in its
 *      registration) has an owner-reviewed entry in
 *      scripts/route-public-allowlist.json. A net-new unauthenticated route
 *      therefore FAILS the gate until the owner approves an allow-list entry
 *      (or the route gains real middleware).
 *   2. No stale allow-list entries: every entry must still match an
 *      observed-public route in the fresh scan. Stale entries rot the frozen
 *      baseline (memory: ratchet-frozen-snapshot-pattern) — remove them when
 *      the route is deleted or gains middleware (shrink-only, no approval
 *      needed).
 *   3. No duplicate allow-list entries.
 *   4. Every intentional_public entry must have a detectable caller in
 *      client/src or website/ (fixed-string prefix scan), or a documented
 *      external_caller field. Routes with no known caller and no documented
 *      external caller are publicly exposed for no reason — fail loud instead
 *      of rotting silently. (Task #4209 — L3 owner-approved addition.)
 *   4b. Every external_caller value that names a repo file path must still
 *      have that file present — a refactored-away server-side caller fails
 *      loud instead of leaving a stale annotation. (Task #4244.)
 *
 * "Observed" public ≠ intentionally public: in-handler checks (X-Cron-Key,
 * webhook HMACs, capability tokens, spread `...guard` arrays) are invisible
 * to the static parser; the allow-list entry's class/reason documents the
 * REAL protection. Owner review of the frozen list happened at activation
 * (Task #4180); every later addition is an L3 change requiring owner
 * approval per the Architecture Governor.
 *
 * Exit 0 = every route classified + allow-list exact; 1 = violations.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseRoutes, type RouteEntry } from "../tests/route-inventory";

const ALLOWLIST_PATH = "scripts/route-public-allowlist.json";

export const REMEDIATION =
  "Protect the route with real middleware (isAuthenticated + role / " +
  "requireCeoToolsAuth / validateTwilioWebhook), or — with explicit owner " +
  "approval (L3) — add an entry with class + reason to " +
  "scripts/route-public-allowlist.json. Remove entries for routes that were " +
  "deleted or gained middleware.";

export interface AllowlistEntry {
  method: string;
  path: string;
  class: string;
  reason: string;
  /**
   * Optional: document an external caller that cannot be detected by a
   * source-file scan (e.g. a third-party system, a CDN-deployed script, or a
   * separately-deployed marketing site that does not live in client/src or
   * website/). When present, check #4 skips the source-file scan for this
   * entry. Value should name the caller ("marketing website Webflow embed",
   * "external partner API"). Adding this field is an L3 change requiring
   * owner approval, same as adding the entry itself.
   *
   * Staleness guard (Task #4244): if the value names one or more repo file
   * paths (e.g. "server/services/chartImageGenerator.ts"), check #4b verifies
   * every named file still exists. A refactor that deletes the generating
   * file therefore fails the gate instead of leaving a rotten annotation
   * that silently re-opens the orphaned-public-route gap.
   */
  external_caller?: string;
}

export interface RouteClassificationLintResult {
  ok: boolean;
  observedPublicCount: number;
  allowlistCount: number;
  problems: string[];
}

const VALID_CLASSES = new Set([
  "signed_webhook_in_handler",
  "machine_token_in_handler",
  "capability_token",
  "oauth_callback",
  "custom_middleware_unrecognized",
  "intentional_public",
]);

function key(method: string, routePath: string): string {
  return `${method.toUpperCase()} ${routePath}`;
}

/**
 * Compute a fixed-string prefix suitable for source-scanning: truncate the
 * path at (but not including) the first `:param` segment, retaining up to and
 * including the trailing slash before it. For exact paths (no params), returns
 * the full path.
 *
 * Examples:
 *   /api/book/:slug/recurrence/preview-availability → /api/book/
 *   /api/ceo-pulse-charts/:monthKey/chart-:index.png → /api/ceo-pulse-charts/
 *   /api/health → /api/health
 */
export function callerPrefix(routePath: string): string {
  const colonIdx = routePath.indexOf(":");
  if (colonIdx === -1) return routePath;
  const slashIdx = routePath.lastIndexOf("/", colonIdx - 1);
  if (slashIdx === -1) return routePath.slice(0, colonIdx);
  return routePath.slice(0, slashIdx + 1); // include the trailing slash
}

/**
 * Extract repo-relative source-file paths named inside an external_caller
 * annotation. A "path" is a slash-containing token ending in a known source
 * extension (e.g. "server/services/chartImageGenerator.ts"). Prose-only
 * annotations ("external partner API") yield no paths and are exempt from
 * the existence check — file-based and non-file-based callers stay
 * distinguishable without a format migration. (Task #4244.)
 */
export function extractCallerFilePaths(externalCaller: string): string[] {
  const matches = externalCaller.match(
    /[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)+\.(?:ts|tsx|js|jsx|mjs|cjs)\b/g,
  );
  return matches ? Array.from(new Set(matches)) : [];
}

const SCANNABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js"]);

/** Recursively list all scannable source files under a root directory. */
function listSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  const recurse = (current: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        recurse(full);
      } else if (
        entry.isFile() &&
        SCANNABLE_EXTENSIONS.has(path.extname(entry.name))
      ) {
        results.push(full);
      }
    }
  };
  recurse(dir);
  return results;
}

/**
 * Returns true if `needle` appears as a substring in any scannable file under
 * any of the given roots. Reads each file as UTF-8; silently skips unreadable
 * files.
 */
export function hasCallerInRoots(needle: string, roots: string[]): boolean {
  for (const root of roots) {
    for (const filePath of listSourceFiles(root)) {
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      if (content.includes(needle)) return true;
    }
  }
  return false;
}

/** Pure core, unit-testable via injected routes/allow-list path/scan roots. */
export function runLint(options?: {
  freshRoutes?: RouteEntry[];
  allowlistPath?: string;
  /** Roots to scan for intentional_public caller detection (check #4). Defaults to ["client/src", "website"]. */
  callerScanRoots?: string[];
  /** Root against which external_caller file paths are resolved (check #4b). Defaults to the repo root ("."). */
  externalCallerFileRoot?: string;
}): RouteClassificationLintResult {
  const allowlistPath = options?.allowlistPath ?? ALLOWLIST_PATH;
  const fresh = options?.freshRoutes ?? parseRoutes();
  const callerScanRoots = options?.callerScanRoots ?? ["client/src", "website"];
  const externalCallerFileRoot = options?.externalCallerFileRoot ?? ".";
  const problems: string[] = [];

  let entries: AllowlistEntry[] = [];
  if (!fs.existsSync(allowlistPath)) {
    problems.push(`${allowlistPath} is missing. ${REMEDIATION}`);
  } else {
    try {
      const parsed = JSON.parse(fs.readFileSync(allowlistPath, "utf-8")) as {
        entries?: AllowlistEntry[];
      };
      if (!Array.isArray(parsed.entries)) {
        problems.push(`${allowlistPath} has no "entries" array.`);
      } else {
        entries = parsed.entries;
      }
    } catch {
      problems.push(`${allowlistPath} is not valid JSON.`);
    }
  }

  // Allow-list integrity: duplicates + malformed entries.
  const allowKeys = new Set<string>();
  for (const e of entries) {
    if (!e.method || !e.path || !e.class || !e.reason) {
      problems.push(
        `allow-list entry ${JSON.stringify(e)} is incomplete — method, path, class, and reason are all required.`,
      );
      continue;
    }
    if (!VALID_CLASSES.has(e.class)) {
      problems.push(
        `allow-list entry ${key(e.method, e.path)} has unknown class "${e.class}".`,
      );
    }
    const k = key(e.method, e.path);
    if (allowKeys.has(k)) {
      problems.push(`duplicate allow-list entry for ${k}.`);
    }
    allowKeys.add(k);
  }

  // 1. Every observed-public route is allow-listed.
  const observedPublic = fresh.filter((r) => r.authClass === "observed_public");
  const observedKeys = new Set<string>();
  for (const r of observedPublic) {
    const k = key(r.method, r.path);
    observedKeys.add(k);
    if (!allowKeys.has(k)) {
      problems.push(
        `NET-NEW observed-public route ${k} (${r.file}:${r.line}) has no recognized auth ` +
          `middleware and no owner-reviewed allow-list entry. New routes are protected by default.`,
      );
    }
  }

  // 2. No stale allow-list entries.
  for (const k of allowKeys) {
    if (!observedKeys.has(k)) {
      problems.push(
        `stale allow-list entry ${k} — no observed-public route matches it anymore ` +
          `(route deleted or now carries auth middleware). Remove the entry (shrink-only, no approval needed).`,
      );
    }
  }

  // 4. Every intentional_public entry has a detectable caller or documented external_caller.
  //    Orphaned public routes (no client/website caller, no external_caller) fail loud rather
  //    than rotting silently. (Task #4209 — L3 owner-approved extension.)
  for (const e of entries) {
    if (e.class !== "intentional_public") continue;
    if (e.external_caller && e.external_caller.trim().length > 0) {
      // 4b. Staleness guard (Task #4244): if the external_caller annotation
      //     names repo file paths, every named file must still exist. A
      //     refactor that removes the generating file would otherwise leave
      //     the annotation "valid" forever, silently re-opening the orphaned
      //     public-route gap check #4 was built to close.
      for (const p of extractCallerFilePaths(e.external_caller)) {
        if (!fs.existsSync(path.join(externalCallerFileRoot, p))) {
          problems.push(
            `intentional_public entry ${key(e.method, e.path)} has a STALE external_caller: ` +
              `it names "${p}", which no longer exists in the repo. The server-side caller was ` +
              `refactored away — update the annotation to the new generating file, or (if the ` +
              `route truly has no caller anymore) add auth middleware or remove the route.`,
          );
        }
      }
      continue;
    }
    const prefix = callerPrefix(e.path);
    if (!hasCallerInRoots(prefix, callerScanRoots)) {
      problems.push(
        `intentional_public entry ${key(e.method, e.path)} has no detectable caller ` +
          `in client/src or website/ (searched for prefix "${prefix}") and no external_caller field. ` +
          `If the route is still needed, add external_caller: "<description>" to the allow-list entry ` +
          `(L3 — owner approval required). If it is no longer needed, add auth middleware or remove it.`,
      );
    }
  }

  return {
    ok: problems.length === 0,
    observedPublicCount: observedPublic.length,
    allowlistCount: entries.length,
    problems,
  };
}

export function cliMain(): number {
  const result = runLint();
  if (!result.ok) {
    console.error("");
    console.error(
      "✗ lint-route-classification: unreviewed observed-public routes (or a drifted allow-list)",
    );
    console.error("");
    console.error(
      "  There is no blanket /api auth guard — omitting middleware ships a PUBLIC route.",
    );
    console.error(
      "  Every observed-public route needs an owner-reviewed entry in scripts/route-public-allowlist.json.",
    );
    console.error("");
    for (const p of result.problems) console.error(`  - ${p}`);
    console.error("");
    console.error(`  Remediation: ${REMEDIATION}`);
    console.error("");
    return 1;
  }
  console.log(
    `lint-route-classification: OK (${result.observedPublicCount} observed-public routes, ` +
      `all covered by the ${result.allowlistCount}-entry owner-reviewed allow-list; ` +
      `every other route is session/machine-token/signed-webhook classified)`,
  );
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-route-classification.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
