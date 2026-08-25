/**
 * lint-route-inventory-freshness.ts
 *
 * Freshness guard for the committed API route inventory.
 *
 * Background: tests/route-inventory.json (and route-inventory-report.md)
 * silently drifted from 775 to 1349 routes before anyone noticed, and
 * security/contract audits were misled by phantom (or missing) routes.
 * The inventory is only trustworthy if it always matches what
 * tests/route-inventory.ts#parseRoutes() extracts from the live route tree.
 *
 * Checks:
 *   1. The committed tests/route-inventory.json deep-equals a fresh
 *      parseRoutes() run (same entries, same order, same fields).
 *   2. The committed tests/route-inventory-report.md's
 *      "Total routes discovered: N" header matches the fresh route count
 *      (the report embeds a generation timestamp, so a byte-diff would
 *      always fail — the count header is the meaningful freshness signal).
 *   3. No duplicate method+path pairs in the fresh scan — a duplicate means
 *      two live Express registrations where the FIRST wins at dispatch and
 *      the later one is dead code possibly carrying divergent auth.
 *
 * Remediation when this fires:
 *   npx tsx scripts/regen-route-inventory.mjs
 *   then commit tests/route-inventory.json and tests/route-inventory-report.md.
 *   (For duplicate registrations, fix the source instead: delete the shadowed
 *   handler and merge any unique guards into the live one.)
 *
 * Exit 0 = fresh; 1 = stale or duplicate registrations.
 */
import * as fs from "node:fs";
import { parseRoutes, type RouteEntry } from "../tests/route-inventory";

const INVENTORY_JSON = "tests/route-inventory.json";
const INVENTORY_REPORT = "tests/route-inventory-report.md";

export const REMEDIATION =
  "Run `npx tsx scripts/regen-route-inventory.mjs` and commit the updated " +
  "tests/route-inventory.json and tests/route-inventory-report.md.";

export interface RouteInventoryLintResult {
  ok: boolean;
  freshCount: number;
  committedCount: number | null;
  problems: string[];
}

function routeKey(r: RouteEntry): string {
  return `${r.method} ${r.path}`;
}

/**
 * Pure core, unit-testable: compares a fresh route list against committed
 * inventory artifacts. Callers may inject paths/routes for fixture testing.
 */
export function runLint(options?: {
  freshRoutes?: RouteEntry[];
  inventoryJsonPath?: string;
  inventoryReportPath?: string;
}): RouteInventoryLintResult {
  const jsonPath = options?.inventoryJsonPath ?? INVENTORY_JSON;
  const reportPath = options?.inventoryReportPath ?? INVENTORY_REPORT;
  const fresh = options?.freshRoutes ?? parseRoutes();
  const problems: string[] = [];

  // 3. Duplicate live registrations (first-wins shadowing).
  const seen = new Map<string, RouteEntry>();
  for (const r of fresh) {
    const key = routeKey(r);
    const prior = seen.get(key);
    if (prior) {
      problems.push(
        `duplicate live registration for ${key}: ${prior.file}:${prior.line} wins at dispatch; ` +
          `${r.file}:${r.line} is dead code (fix the source — delete the shadowed handler, ` +
          `merging any unique guards into the live one).`,
      );
    } else {
      seen.set(key, r);
    }
  }

  // 1. Committed JSON deep-equals a fresh scan.
  let committedCount: number | null = null;
  if (!fs.existsSync(jsonPath)) {
    problems.push(`${jsonPath} is missing. ${REMEDIATION}`);
  } else {
    let committed: RouteEntry[] | null = null;
    try {
      committed = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as RouteEntry[];
    } catch {
      problems.push(`${jsonPath} is not valid JSON. ${REMEDIATION}`);
    }
    if (committed) {
      committedCount = committed.length;
      if (JSON.stringify(committed) !== JSON.stringify(fresh)) {
        const committedKeys = new Set(committed.map(routeKey));
        const freshKeys = new Set(fresh.map(routeKey));
        const missing = fresh
          .map(routeKey)
          .filter((k) => !committedKeys.has(k));
        const phantom = committed
          .map(routeKey)
          .filter((k) => !freshKeys.has(k));
        const sample = (label: string, keys: string[]) =>
          keys.length
            ? `${label} (${keys.length}): ${keys.slice(0, 10).join(", ")}${keys.length > 10 ? ", …" : ""}`
            : null;
        const details = [
          sample("routes in code but not in committed inventory", Array.from(new Set(missing))),
          sample("phantom routes in committed inventory but not in code", Array.from(new Set(phantom))),
        ].filter((d): d is string => d !== null);
        if (details.length === 0) {
          details.push(
            "same route set, but entry details drifted (line numbers, middleware, protection, order)",
          );
        }
        problems.push(
          `${jsonPath} is STALE — committed ${committed.length} route(s), fresh scan finds ${fresh.length}. ` +
            details.join("; ") +
            `. ${REMEDIATION}`,
        );
      }
    }
  }

  // 2. Report header count matches (report embeds a timestamp, so only the
  //    count header is compared, not the full bytes).
  if (!fs.existsSync(reportPath)) {
    problems.push(`${reportPath} is missing. ${REMEDIATION}`);
  } else {
    const report = fs.readFileSync(reportPath, "utf-8");
    const m = report.match(/^Total routes discovered: (\d+)$/m);
    if (!m) {
      problems.push(
        `${reportPath} has no "Total routes discovered: N" header. ${REMEDIATION}`,
      );
    } else if (Number(m[1]) !== fresh.length) {
      problems.push(
        `${reportPath} is STALE — header says ${m[1]} routes, fresh scan finds ${fresh.length}. ${REMEDIATION}`,
      );
    }
  }

  return { ok: problems.length === 0, freshCount: fresh.length, committedCount, problems };
}

export function cliMain(): number {
  const result = runLint();
  if (!result.ok) {
    console.error("");
    console.error("✗ lint-route-inventory-freshness: committed route inventory is out of date");
    console.error("");
    console.error("  Audits treat tests/route-inventory.json as the canonical route list;");
    console.error("  a stale copy misleads them with phantom or missing routes (it once");
    console.error("  drifted 775 → 1349 routes unnoticed).");
    console.error("");
    for (const p of result.problems) console.error(`  - ${p}`);
    console.error("");
    console.error(`  Remediation: ${REMEDIATION}`);
    console.error("");
    return 1;
  }
  console.log(
    `lint-route-inventory-freshness: OK (${result.freshCount} routes; committed inventory matches a fresh parseRoutes() scan)`,
  );
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-route-inventory-freshness.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
