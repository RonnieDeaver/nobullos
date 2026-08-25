/**
 * Task #2899 — Lint guard against new UNBOUNDED module-level Map caches
 * under server/.
 *
 * Background: Task #2897 manually audited the long-lived in-memory caches
 * (alertResendGuard cooldowns, slackIntegration userCache, the SEMrush
 * circuit-breaker backoff map, the Zoom user cache) and gave each a cap or
 * TTL-prune. On the always-on Reserved VM the process never recycles, so
 * any NEW module-level `Map` cache added later without a bound becomes a
 * slow memory leak that only shows up weeks into an uptime.
 *
 * That audit is a point-in-time snapshot. This lint is the standing guard,
 * mirroring `lint-cross-instance-locks`: every module-level Map that is
 * WRITTEN TO (`.set(`) must show structural evidence of being bounded, or
 * carry an explicit annotation, or be baselined.
 *
 * What counts as a "module-level Map cache":
 *   - A `const|let|var NAME = new Map(...)` declaration at brace-depth 0
 *     of the file (module scope — lives for the whole process lifetime),
 *   - whose NAME is subsequently written via `NAME.set(...)`.
 *
 * Maps declared inside functions/classes are request- or call-scoped and
 * are garbage-collected normally, so they are out of scope. A module-level
 * Map that is never `.set(...)` (a lookup table populated at module load)
 * has a fixed size and is also out of scope.
 *
 * A cache-bearing (declared + written) Map PASSES when ANY of these holds:
 *
 *   1. Structural bound evidence in the same file:
 *        - `NAME.delete(` — entries are removed (single-flight maps,
 *          TTL prunes, oldest-insertion eviction all end in .delete);
 *        - `NAME.clear(` — wholesale reset;
 *        - `NAME.size`   — a size check feeding a cap/eviction branch;
 *        - `NAME` reassigned to a fresh `new Map(...)` after declaration
 *          (a `let`-declared cache reset wholesale);
 *        - `NAME` passed as an argument to a helper whose name mentions
 *          evict/prune/trim/lru/cap/bound (e.g. `evictOldest(cache, 2000)`).
 *
 *   2. An explicit safe-by-design annotation in the file header (first
 *      HEADER_LINES lines):
 *
 *        // @bounded-cache-safe: <reason>
 *
 *      Use this when the key space is inherently bounded (e.g. keyed by a
 *      small fixed enum, or by user id in a ~20-user internal tool) or the
 *      bound lives in another module. State the specific reason.
 *
 *   3. The `<path>::<mapName>` pair is listed in the baseline
 *      (`scripts/lint-unbounded-caches.baseline.txt`) — the audited
 *      snapshot at the time this guard shipped. Each line carries a
 *      trailing `# rationale`.
 *
 * The lint FAILS when:
 *   1. A new module-level Map cache has none of the above — an unbounded
 *      cache by construction.
 *   2. A baseline entry is stale (file gone, map gone, or the map is now
 *      structurally bounded) — keep the baseline honest.
 *
 * To make the lint pass for a NEW cache: cap it (see
 * `server/services/alertResendGuard.ts` — `evictOldest` + MAX_TRACKED_ENTRIES
 * is the house pattern), or TTL-prune it, or add a
 * `// @bounded-cache-safe: <reason>` header annotation when the key space
 * is inherently bounded. Adding a baseline line is the grandfather escape
 * hatch — prefer bounding the cache.
 *
 * Baseline format: one `<path>::<mapName>` per line. Trailing `# ...`
 * comments and blank lines are ignored.
 *
 * Exit codes:
 *   0 — every module-level Map cache is bounded, annotated, or baselined.
 *   1 — at least one new unbounded cache, or a stale baseline entry.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { maskLiterals } from "./lint-cross-instance-locks";

const DEFAULT_ROOT = "server";
const DEFAULT_BASELINE_PATH = "scripts/lint-unbounded-caches.baseline.txt";
const HEADER_LINES = 80;

// Explicit safe-by-design annotation, anywhere in the file header.
const SAFE_ANNOTATION_RE = /@bounded-cache-safe\b/;

// Helper names that constitute bound evidence when the map is passed as an
// argument (e.g. `evictOldest(cooldowns, MAX_TRACKED_ENTRIES)`).
const BOUND_HELPER_NAME_RE = /evict|prune|trim|lru|cap|bound/i;

export interface LintOptions {
  root: string;
  baselinePath: string;
}

export interface CacheOffender {
  file: string;
  mapName: string;
  reason: string;
}

export interface LintResult {
  ok: boolean;
  /** Module-level written-to Maps found (cache candidates). */
  scanned: number;
  boundedCount: number;
  annotatedCount: number;
  baselinedCount: number;
  offenders: CacheOffender[];
  /** Baseline entries that no longer name an unbounded module-level cache. */
  stale: string[];
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

function loadBaseline(path: string): Set<string> {
  const out = new Set<string>();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const withoutComment = line.split("#")[0];
    const trimmed = withoutComment.trim();
    if (!trimmed) continue;
    out.add(trimmed);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Brace depth at index `idx` of already-masked source. Depth 0 = module
// scope. Paren/bracket depth is tracked too so a Map declared inside a call
// argument or array literal is not mistaken for a module-scope declaration.
function isModuleScope(masked: string, idx: number): boolean {
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  for (let i = 0; i < idx; i++) {
    const c = masked[i];
    if (c === "{") brace++;
    else if (c === "}") brace--;
    else if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (c === "[") bracket++;
    else if (c === "]") bracket--;
  }
  return brace === 0 && paren === 0 && bracket === 0;
}

interface MapDecl {
  name: string;
  /** Index of the declaration keyword in the masked source. */
  index: number;
  /** Index just past the `new Map` token — used to skip the declaration
   *  itself when looking for reassignments. */
  afterNewMap: number;
}

// Module-level `const|let|var NAME = new Map(...)` declarations. The type
// annotation between NAME and `=` (e.g. `: Map<string, number>`) is allowed
// but must not contain `=` or `;` so we don't jump across statements.
export function findModuleLevelMapDecls(masked: string): MapDecl[] {
  const out: MapDecl[] = [];
  const re =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*new\s+Map\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    if (!isModuleScope(masked, m.index)) continue;
    out.push({
      name: m[1],
      index: m.index,
      afterNewMap: m.index + m[0].length,
    });
  }
  return out;
}

// Structural evidence that the map named `name` is bounded — see the file
// header for the accepted forms. `masked` is the literal-masked source and
// `decl` the declaration record (so the declaring `= new Map` itself is not
// counted as a "reassignment reset").
export function hasBoundEvidence(masked: string, decl: MapDecl): boolean {
  const n = escapeRegExp(decl.name);

  // .delete( / .clear( / .size on the map itself.
  if (new RegExp(`\\b${n}\\s*\\.\\s*(?:delete|clear)\\s*\\(`).test(masked)) {
    return true;
  }
  if (new RegExp(`\\b${n}\\s*\\.\\s*size\\b`).test(masked)) return true;

  // Wholesale reset: `NAME = new Map` anywhere OTHER than the declaration.
  const reassign = new RegExp(`\\b${n}\\s*=\\s*new\\s+Map\\b`, "g");
  let m: RegExpExecArray | null;
  while ((m = reassign.exec(masked))) {
    if (m.index >= decl.index && m.index < decl.afterNewMap) continue;
    return true;
  }

  // Passed to an eviction/prune-style helper: `helperName(..., NAME, ...)`
  // where helperName mentions evict/prune/trim/lru/cap/bound.
  const asArg = new RegExp(
    `\\b([A-Za-z_$][\\w$]*)\\s*\\(([^()]*\\b${n}\\b[^()]*)\\)`,
    "g",
  );
  while ((m = asArg.exec(masked))) {
    if (BOUND_HELPER_NAME_RE.test(m[1])) return true;
  }
  return false;
}

export function runLint(options: LintOptions): LintResult {
  const files: string[] = [];
  walk(options.root, files);

  const baseline = loadBaseline(options.baselinePath);
  const seenUnboundedKeys = new Set<string>();
  const seenCandidateKeys = new Set<string>();

  const offenders: CacheOffender[] = [];
  let scanned = 0;
  let boundedCount = 0;
  let annotatedCount = 0;
  let baselinedCount = 0;

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const masked = maskLiterals(src);
    const decls = findModuleLevelMapDecls(masked);
    if (decls.length === 0) continue;

    // The annotation lives in a comment, so match against raw source.
    const header = src.split("\n", HEADER_LINES).join("\n");
    const annotated = SAFE_ANNOTATION_RE.test(header);

    for (const decl of decls) {
      // Only Maps that are WRITTEN TO are cache candidates.
      const setRe = new RegExp(
        `\\b${escapeRegExp(decl.name)}\\s*\\.\\s*set\\s*\\(`,
      );
      if (!setRe.test(masked)) continue;
      scanned++;
      const key = `${file}::${decl.name}`;
      seenCandidateKeys.add(key);

      if (hasBoundEvidence(masked, decl)) {
        boundedCount++;
        continue;
      }
      seenUnboundedKeys.add(key);
      if (annotated) {
        annotatedCount++;
        continue;
      }
      if (baseline.has(key)) {
        baselinedCount++;
        continue;
      }
      offenders.push({
        file,
        mapName: decl.name,
        reason:
          `module-level Map \`${decl.name}\` is written via .set(...) but shows no bound ` +
          `(no .delete/.clear/.size, no reset, no evict/prune helper), has no ` +
          "`@bounded-cache-safe` annotation, and is not baselined",
      });
    }
  }

  // Stale baseline entries: no longer an UNBOUNDED module-level cache
  // (bounded now, map removed, or file gone).
  const stale: string[] = [];
  for (const entry of Array.from(baseline)) {
    if (seenUnboundedKeys.has(entry)) continue;
    const sep = entry.lastIndexOf("::");
    const path = sep === -1 ? entry : entry.slice(0, sep);
    if (sep === -1) {
      stale.push(`${entry} (malformed — expected <path>::<mapName>)`);
      continue;
    }
    if (!existsSync(path)) {
      stale.push(`${entry} (file no longer exists)`);
      continue;
    }
    if (seenCandidateKeys.has(entry)) {
      stale.push(`${entry} (cache is now structurally bounded — remove the baseline line)`);
    } else {
      stale.push(`${entry} (no longer a module-level written-to Map)`);
    }
  }

  return {
    ok: offenders.length === 0 && stale.length === 0,
    scanned,
    boundedCount,
    annotatedCount,
    baselinedCount,
    offenders,
    stale,
  };
}

function main(): void {
  const result = runLint({ root: DEFAULT_ROOT, baselinePath: DEFAULT_BASELINE_PATH });
  const { offenders, stale } = result;

  if (offenders.length === 0 && stale.length === 0) {
    console.log(
      `lint-unbounded-caches: OK (${result.scanned} module-level Map cache${
        result.scanned === 1 ? "" : "s"
      } under ${DEFAULT_ROOT}/: ${result.boundedCount} bounded, ${result.annotatedCount} annotated, ${result.baselinedCount} baselined)`,
    );
    process.exit(0);
  }

  if (offenders.length > 0) {
    console.error("");
    console.error(
      "✗ lint-unbounded-caches: new unbounded module-level Map cache(s)",
    );
    console.error("");
    console.error(
      "  On the always-on Reserved VM the process never recycles, so a module-level",
    );
    console.error(
      "  Map that only ever .set()s grows forever — a slow memory leak that surfaces",
    );
    console.error("  weeks into an uptime.");
    console.error("");
    console.error("  Fix one of three ways:");
    console.error("");
    console.error("    A) Bound it (preferred) — cap with oldest-insertion eviction or TTL-prune.");
    console.error("       House pattern: server/services/alertResendGuard.ts (`evictOldest` +");
    console.error("       MAX_TRACKED_ENTRIES). Single-flight maps that .delete in `finally`");
    console.error("       already pass.");
    console.error("");
    console.error("    B) If the key space is inherently bounded, add a header comment:");
    console.error("       // @bounded-cache-safe: <reason — e.g. keyed by a fixed enum /");
    console.error("       //   bounded elsewhere in <module>>");
    console.error("");
    console.error(
      `    C) Grandfather it (audited snapshot only) by adding \`<path>::<mapName>\``,
    );
    console.error(`       to ${DEFAULT_BASELINE_PATH} with its rationale.`);
    console.error("");
    for (const o of offenders) {
      console.error(`  ✗ ${o.file} :: ${o.mapName}`);
      console.error(`      ${o.reason}`);
    }
  }

  if (stale.length > 0) {
    console.error("");
    console.error("✗ lint-unbounded-caches: stale baseline entries");
    for (const s of stale) console.error(`  ✗ ${s}`);
    console.error(
      `  Remove the stale lines from ${DEFAULT_BASELINE_PATH} to keep the baseline honest.`,
    );
  }

  console.error("");
  process.exit(1);
}

// Only run as a CLI when executed directly (not when imported by tests).
const isMain = process.argv[1]?.endsWith("lint-unbounded-caches.ts");
if (isMain) main();
