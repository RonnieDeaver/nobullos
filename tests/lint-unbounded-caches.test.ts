/* test-registration
{
  "name": "lint-unbounded-caches guard (Task #2899)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2899: the unbounded in-memory cache guard. On the always-on Reserved VM the process never recycles, so a NEW module-level Map cache added without a cap/TTL-prune is a slow leak (#2897 bounded the known ones by hand). The Validate workflow runs npm run gate; assertion 1 runs the real server/ tree against the committed baseline. Fast, DB-free, in-process (temp-dir fixtures for the exact-behavior assertions).",
  "tier": "small"
}
test-registration */
/**
 * Task #2899 — Regression test + routine gate for the unbounded in-memory
 * cache guard (scripts/lint-unbounded-caches.ts).
 *
 * On the always-on Reserved VM the process never recycles, so a NEW
 * module-level Map cache added without a cap/TTL-prune is a slow leak.
 * The guard flags module-level `new Map(...)` declarations that are
 * written via `.set(...)` but show no structural bound, no
 * `@bounded-cache-safe` annotation, and no baseline entry.
 *
 * The `.replit` `Validate` workflow runs `npm run gate`, so this lint is
 * gated here via SMOKE_FILES: assertion 1 runs the REAL server/ tree
 * against the committed baseline — a new unbounded cache fails the
 * routine validation gate.
 *
 * Then, against a temp fixture tree so the assertions are exact:
 *   2.  A module-level set-only Map is flagged.
 *   3.  A Map with `.delete(` (single-flight / TTL-prune) passes.
 *   4.  A Map with `.clear(` passes.
 *   5.  A Map with a `.size` cap check passes.
 *   6.  A `let` Map reassigned to a fresh `new Map()` (wholesale reset)
 *       passes.
 *   7.  A Map passed to an evict/prune-named helper passes.
 *   8.  A `@bounded-cache-safe` header annotation passes.
 *   9.  A baselined `<path>::<mapName>` entry passes.
 *  10.  A stale baseline entry (cache now bounded) is reported.
 *  11.  A stale baseline entry (file gone) is reported.
 *  12.  A function-scoped Map is NOT flagged (call-scoped, GC'd normally).
 *  13.  A module-level Map that is never `.set(...)` is NOT flagged.
 *  14.  `new Map` mentioned only in a comment/string is NOT flagged.
 *  15.  Two Maps in one file are judged independently.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint } from "../scripts/lint-unbounded-caches";

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

function fixture(): { root: string; baseline: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lint-ubcache-"));
  const baseline = join(root, "baseline.txt");
  writeFileSync(baseline, "");
  return {
    root,
    baseline,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeFile(root: string, rel: string, lines: string[]): string {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, lines.join("\n") + "\n");
  return full;
}

// 1. The REAL server/ tree passes against the committed baseline. This is
//    the routine-gate assertion — a new unbounded cache fails here.
{
  const res = runLint({
    root: "server",
    baselinePath: "scripts/lint-unbounded-caches.baseline.txt",
  });
  if (!res.ok) {
    for (const o of res.offenders) console.error(`    offender: ${o.file} :: ${o.mapName}`);
    for (const s of res.stale) console.error(`    stale: ${s}`);
  }
  assert(res.ok, "real server/ tree passes the unbounded-cache guard");
  assert(res.scanned > 0, "the guard actually scanned module-level Map caches in server/");
  assert(res.boundedCount > 0, "structurally bounded caches are recognized in server/");
}

// 2. A module-level set-only Map is flagged.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/leaky.ts", [
      "const cache = new Map<string, number>();",
      "export function remember(k: string, v: number) {",
      "  cache.set(k, v);",
      "}",
      "export function recall(k: string) { return cache.get(k); }",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(!res.ok, "a set-only module-level Map trips the lint");
    assert(
      res.offenders.some((o) => o.file.endsWith("leaky.ts") && o.mapName === "cache"),
      "the leaky map is reported by file and name",
    );
  } finally {
    cleanup();
  }
}

// 3. A Map with .delete( passes (single-flight / prune pattern).
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/singleFlight.ts", [
      "const inFlight = new Map<string, Promise<unknown>>();",
      "export async function once(k: string, fn: () => Promise<unknown>) {",
      "  if (inFlight.has(k)) return inFlight.get(k);",
      "  const p = fn();",
      "  inFlight.set(k, p);",
      "  try { return await p; } finally { inFlight.delete(k); }",
      "}",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(res.ok, "a .delete()-ing single-flight map passes");
    assert(res.boundedCount === 1, "it is counted as bounded");
  } finally {
    cleanup();
  }
}

// 4. A Map with .clear( passes.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/cleared.ts", [
      "const memo = new Map<string, string>();",
      "export function put(k: string, v: string) { memo.set(k, v); }",
      "export function reset() { memo.clear(); }",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(res.ok, "a .clear()-able map passes");
  } finally {
    cleanup();
  }
}

// 5. A Map with a .size cap check passes.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/capped.ts", [
      "const memo = new Map<string, string>();",
      "export function put(k: string, v: string) {",
      "  if (memo.size > 500) return;",
      "  memo.set(k, v);",
      "}",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(res.ok, "a .size-checked map passes");
  } finally {
    cleanup();
  }
}

// 6. A let-declared Map reassigned to a fresh new Map() passes.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/reset.ts", [
      "let memo = new Map<string, string>();",
      "export function put(k: string, v: string) { memo.set(k, v); }",
      "export function rotate() { memo = new Map(); }",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(res.ok, "a wholesale-reset map passes");
  } finally {
    cleanup();
  }
}

// 7. A Map passed to an evict/prune-named helper passes.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/evicted.ts", [
      "import { evictOldest } from './evictOldest';",
      "const cooldowns = new Map<string, number>();",
      "export function mark(k: string) {",
      "  cooldowns.set(k, Date.now());",
      "  evictOldest(cooldowns, 2000);",
      "}",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(res.ok, "a map passed to an evict-named helper passes");
  } finally {
    cleanup();
  }
}

// 8. A @bounded-cache-safe header annotation passes.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/annotated.ts", [
      "// @bounded-cache-safe: keyed by a fixed code-defined enum of queue names",
      "const lastRun = new Map<string, number>();",
      "export function mark(q: string) { lastRun.set(q, Date.now()); }",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(res.ok, "an annotated cache passes");
    assert(res.annotatedCount === 1, "it is counted as annotated");
  } finally {
    cleanup();
  }
}

// 9. A baselined <path>::<mapName> entry passes.
{
  const { root, baseline, cleanup } = fixture();
  try {
    const full = writeFile(root, "svc/grandfathered.ts", [
      "const legacy = new Map<string, number>();",
      "export function put(k: string) { legacy.set(k, 1); }",
    ]);
    writeFileSync(baseline, `${full}::legacy # grandfathered: audited snapshot\n`);
    const res = runLint({ root, baselinePath: baseline });
    assert(res.ok, "a baselined cache passes");
    assert(res.baselinedCount === 1, "it is counted as baselined");
    assert(res.stale.length === 0, "no stale entries when baseline matches");
  } finally {
    cleanup();
  }
}

// 10. A stale baseline entry (cache is now bounded) is reported.
{
  const { root, baseline, cleanup } = fixture();
  try {
    const full = writeFile(root, "svc/nowBounded.ts", [
      "const memo = new Map<string, number>();",
      "export function put(k: string) { memo.set(k, 1); }",
      "export function drop(k: string) { memo.delete(k); }",
    ]);
    writeFileSync(baseline, `${full}::memo # grandfathered\n`);
    const res = runLint({ root, baselinePath: baseline });
    assert(!res.ok, "a baseline entry for a now-bounded cache trips the lint");
    assert(
      res.stale.some((s) => s.includes("nowBounded.ts") && s.includes("bounded")),
      "the now-bounded stale entry is reported with its reason",
    );
  } finally {
    cleanup();
  }
}

// 11. A stale baseline entry (file gone) is reported.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFileSync(baseline, `${join(root, "svc/ghost.ts")}::ghostMap # gone\n`);
    const res = runLint({ root, baselinePath: baseline });
    assert(!res.ok, "a baseline entry for a deleted file trips the lint");
    assert(
      res.stale.some((s) => s.includes("ghost.ts") && s.includes("no longer exists")),
      "the deleted-file stale entry is reported",
    );
  } finally {
    cleanup();
  }
}

// 12. A function-scoped Map is NOT flagged.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/scoped.ts", [
      "export function groupBy(rows: Array<{ k: string }>) {",
      "  const groups = new Map<string, number>();",
      "  for (const r of rows) groups.set(r.k, (groups.get(r.k) ?? 0) + 1);",
      "  return groups;",
      "}",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(res.ok, "a function-scoped map is not flagged");
    assert(res.scanned === 0, "no module-level cache candidates detected");
  } finally {
    cleanup();
  }
}

// 13. A module-level Map that is never .set(...) is NOT flagged.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/lookupTable.ts", [
      "const LABELS = new Map<string, string>([['a', 'Alpha'], ['b', 'Beta']]);",
      "export function label(k: string) { return LABELS.get(k) ?? k; }",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(res.ok, "a read-only lookup table is not flagged");
    assert(res.scanned === 0, "a never-written map is not a cache candidate");
  } finally {
    cleanup();
  }
}

// 14. `new Map` mentioned only in a comment / string is NOT flagged.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/commentOnly.ts", [
      "// We used to keep `const cache = new Map()` here; now DB-backed.",
      "const note = 'const cache = new Map()';",
      "export function helper() { return note; }",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(res.ok, "comment/string mentions of new Map are not flagged");
    assert(res.scanned === 0, "no cache candidates detected for masked mentions");
  } finally {
    cleanup();
  }
}

// 15. Two Maps in one file are judged independently.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/mixed.ts", [
      "const bounded = new Map<string, number>();",
      "const leaky = new Map<string, number>();",
      "export function put(k: string) {",
      "  bounded.set(k, 1);",
      "  leaky.set(k, 1);",
      "}",
      "export function drop(k: string) { bounded.delete(k); }",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(!res.ok, "the unbounded sibling still trips the lint");
    assert(res.boundedCount === 1, "the bounded sibling is counted bounded");
    assert(
      res.offenders.length === 1 && res.offenders[0].mapName === "leaky",
      "only the leaky map is reported",
    );
  } finally {
    cleanup();
  }
}

console.log(`\n  passed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exit(1);
