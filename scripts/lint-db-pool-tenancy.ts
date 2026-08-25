/**
 * Pre-merge lint guard for the DB pool tenancy contract (Task #1723 Phase 2.1).
 *
 * Task #1721 split the Drizzle pool into a request-scoped `api` pool
 * (18 conns) and a background-only `worker` pool (7 conns). The
 * runtime entry point is `getDb()` in `server/db.ts`, which returns
 * `workerDb` when an `AsyncLocalStorage` context has been installed by
 * `runWithWorkerDb(...)` and otherwise defaults to the API pool `db`.
 *
 * Because the routing is context-driven, it is silently easy to add a
 * new caller of `getDb()` that ends up burning API-pool connections
 * for background work — exactly the regression Task #1721 Phase 2 set
 * out to prevent. This lint enforces the *declaration* side of the
 * contract: every file that calls `getDb()` must declare its pool
 * intent in a header comment so the routing is documented and
 * reviewable.
 *
 * Recognized declarations (case-insensitive, anywhere in the first
 * 60 source lines):
 *
 *   // @db-pool-intent: api      file always runs in API request
 *                                context (no `runWithWorkerDb`
 *                                wrapper). `getDb()` always returns
 *                                the API pool.
 *   // @db-pool-intent: worker   file always runs as background work.
 *                                The file (or its only callers) wraps
 *                                its entry points in
 *                                `runWithWorkerDb(...)` so `getDb()`
 *                                returns the worker pool.
 *   // @db-pool-intent: ambient  file is a shared helper / storage
 *                                module that inherits its pool from
 *                                whatever caller wrapped it.
 *                                Storage files in `server/storage/`
 *                                are the canonical example.
 *   // @db-pool-intent: mixed    file deliberately has both API and
 *                                worker call sites, each of which
 *                                explicitly opts in locally (e.g. by
 *                                wrapping a heavy admin call in
 *                                `runWithWorkerDb`). Use sparingly.
 *
 * Exit codes:
 *   0 — every `getDb()` caller declares a recognized intent.
 *   1 — at least one caller is missing or has a malformed declaration.
 *
 * To add a new caller: read the comment block in `server/db.ts` above
 * `withDbAttribution` for the namespace catalog, then pick the
 * matching intent.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Scope intentionally fixed (Task #2846): pool tenancy rules apply only to
// server runtime code — pools are defined and consumed in server/; scripts
// and tests use getDb()/their own connections, not the tenant pools.
const ROOT = "server";
const VALID_INTENTS = new Set(["api", "worker", "ambient", "mixed"]);
// Match `// @db-pool-intent: <name>` allowing extra whitespace and
// case-insensitive intent labels. The comment must appear in the
// header — we only scan the first HEADER_LINES of each file so the
// declaration stays visible to reviewers.
const INTENT_RE = /@db-pool-intent\s*:\s*([a-z]+)/i;
const HEADER_LINES = 60;
const GETDB_RE = /\bgetDb\s*\(/;

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

interface Offender {
  file: string;
  reason: string;
}

export function cliMain(): number {
  const files: string[] = [];
  walk(ROOT, files);

  const offenders: Offender[] = [];
  let scanned = 0;
  let declared = 0;

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    // Strip the runtime definition itself — `server/db.ts` exports
    // `getDb` and references it in its own source, but is not a
    // "caller" in the tenancy sense.
    if (file === "server/db.ts") continue;
    if (!GETDB_RE.test(src)) continue;
    scanned++;

    const header = src.split("\n", HEADER_LINES).join("\n");
    const match = header.match(INTENT_RE);
    if (!match) {
      offenders.push({
        file,
        reason: "missing `// @db-pool-intent: <api|worker|ambient|mixed>` declaration in the first " +
          `${HEADER_LINES} lines`,
      });
      continue;
    }
    const intent = match[1].toLowerCase();
    if (!VALID_INTENTS.has(intent)) {
      offenders.push({
        file,
        reason: `unrecognized intent "${intent}" — must be one of ${Array.from(VALID_INTENTS).sort().join(", ")}`,
      });
      continue;
    }
    declared++;
  }

  if (offenders.length > 0) {
    console.error("");
    console.error("✗ lint-db-pool-tenancy: undeclared `getDb()` callers detected");
    console.error("");
    console.error("  Task #1721 Phase 2 split background work onto a dedicated `worker`");
    console.error("  pool so slow sweeps cannot starve user-facing requests on the `api`");
    console.error("  pool. Because routing is driven by an AsyncLocalStorage context, any");
    console.error("  file that calls `getDb()` must declare which pool it intends to land");
    console.error("  on so the routing is documented and reviewable.");
    console.error("");
    console.error("  Add one of the following header comments near the top of the file:");
    console.error("");
    console.error("    // @db-pool-intent: api      — always runs on the API pool");
    console.error("    // @db-pool-intent: worker   — always wrapped in runWithWorkerDb(...)");
    console.error("    // @db-pool-intent: ambient  — shared/storage helper, inherits caller");
    console.error("    // @db-pool-intent: mixed    — heterogeneous; explicitly opted-in per call");
    console.error("");
    console.error("  See `server/db.ts` (above `withDbAttribution`) for the full namespace");
    console.error("  catalog and the `runWithWorkerDb` helper.");
    console.error("");
    console.error("  Offending files:");
    for (const o of offenders) console.error(`    - ${o.file}: ${o.reason}`);
    console.error("");
    return 1;
  }

  console.log(
    `lint-db-pool-tenancy: OK (scanned ${scanned} getDb() caller${scanned === 1 ? "" : "s"} under ${ROOT}/, all declared)`,
  );
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-db-pool-tenancy.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
