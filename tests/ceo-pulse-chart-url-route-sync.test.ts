/* test-registration
{
  "name": "CEO Pulse chart URL ↔ registered route sync (Task #4245)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Pure source-scan + unit check (no DB, no network, sub-second, deterministic); it guards a silent-404 class of drift where generated chart URLs stop matching the registered public route, which nothing else in the gate would catch.",
  "scanPaths": ["server/routes/reports.ts", "server/services/chartImageGenerator.ts", "scripts/route-public-allowlist.json"],
  "tier": "small"
}
test-registration */
/**
 * Task #4245 — keep `getChartImageUrl` (server/services/chartImageGenerator.ts)
 * in lockstep with the route actually registered in server/routes/reports.ts
 * and its entry in scripts/route-public-allowlist.json.
 *
 * History: chartImageGenerator once built URLs as `/api/n/${monthKey}/...`
 * while the serving route was registered as
 * `GET /api/ceo-pulse-charts/:monthKey/chart-:index.png` — every generated
 * URL 404'd silently in shared letters. The generator has since been fixed;
 * this test pins the three surfaces together so the drift cannot recur:
 *
 *   1. The generated URL must MATCH the Express pattern extracted from the
 *      live registration in reports.ts (pattern is read from source, not
 *      hard-coded, so a route rename fails here until the generator moves).
 *   2. The allow-list must carry exactly that registered path.
 *   3. No `/api/n/` remnant may reappear in chartImageGenerator.ts.
 */
import { readFileSync } from "fs";
import path from "path";
import { getChartImageUrl } from "../server/services/chartImageGenerator";

let passed = 0;
let failed = 0;

function check(ok: boolean, msg: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const routesSource = readFileSync(path.join(root, "server/routes/reports.ts"), "utf8");
const generatorSource = readFileSync(
  path.join(root, "server/services/chartImageGenerator.ts"),
  "utf8"
);
const allowlist = JSON.parse(
  readFileSync(path.join(root, "scripts/route-public-allowlist.json"), "utf8")
) as { entries: { method: string; path: string }[] };

// 1. Extract the registered chart-image route pattern from reports.ts.
const registrationMatch = routesSource.match(
  /app\.get\(\s*"(\/api\/[^"]*chart[^"]*\.png)"/
);
check(!!registrationMatch, "reports.ts registers a GET route serving chart PNGs");

const routePattern = registrationMatch ? registrationMatch[1] : "";
check(
  routePattern === "/api/ceo-pulse-charts/:monthKey/chart-:index.png",
  `registered pattern is the expected one (got "${routePattern}")`
);

// 2. The generated URL must match that Express pattern.
// Convert the Express path to a regex: `:param` matches one non-slash,
// non-dot segment piece (Express treats `.` as a delimiter), everything
// else is literal.
const patternRegex = new RegExp(
  "^" +
    routePattern
      .split(/(:[A-Za-z0-9_]+)/)
      .map((piece) =>
        piece.startsWith(":")
          ? "[^/.]+"
          : piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      )
      .join("") +
    "$"
);

const sampleUrl = getChartImageUrl("2026-08", 2);
check(
  patternRegex.test(sampleUrl),
  `getChartImageUrl output "${sampleUrl}" matches the registered route pattern "${routePattern}"`
);

// The route handler additionally validates monthKey/index shapes; pin that
// the generator's outputs satisfy them (YYYY-MM month, numeric index).
const paramMatch = sampleUrl.match(
  /^\/api\/ceo-pulse-charts\/([^/]+)\/chart-([^/.]+)\.png$/
);
check(
  !!paramMatch &&
    /^\d{4}-\d{2}$/.test(paramMatch[1]) &&
    /^\d+$/.test(paramMatch[2]),
  "generated URL params pass the handler's monthKey/index validation regexes"
);

// 3. Allow-list carries the registered path.
check(
  allowlist.entries.some(
    (e) => e.method === "GET" && e.path === routePattern
  ),
  "route-public-allowlist.json contains the registered chart route"
);

// 4. The dead /api/n/ URL shape must not reappear in the generator.
check(
  !generatorSource.includes("/api/n/"),
  "chartImageGenerator.ts contains no dead /api/n/ URL remnant"
);

console.log(`\nTest run: ${passed} passed, ${failed} failed`);
// Unconditional explicit exit: importing chartImageGenerator pulls in
// DB-pool infrastructure whose handles keep the event loop alive, so a
// natural drain never happens — exit with the accumulated failure status.
process.exit(failed > 0 ? 1 : 0);
