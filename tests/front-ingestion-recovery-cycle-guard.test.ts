/* test-registration
{
  "name": "Front ingestion/recovery import-cycle guard (Task #3945)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3945 broke the two-node runtime import cycle between frontHistoricalRecovery.ts and frontWebhookIngestion.ts by extracting the shared pure helper (extractFrontConvMessageVersion) into the leaf module frontConvMessageVersion.ts. This static guard pins the acyclic shape: ingestion must never import recovery again (statically or dynamically), the leaf must stay dependency-free (neither service, no db/storage/scheduler/worker access), and neither service may re-inline its own copy of the helper. A regression silently reintroduces the cycle the Knip audit (Task #3894) flagged. Pure source scan, no DB.",
  "scanPaths": [
    "server/services/frontConvMessageVersion.ts",
    "server/services/frontHistoricalRecovery.ts",
    "server/services/frontWebhookIngestion.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #3945 — static guard for the Front recovery / webhook-ingestion
 * dependency break.
 *
 * Before this task, `frontHistoricalRecovery.ts:31` imported the ingestion
 * write helpers (`normalizeReconciliationEvent`, `materializeFrontMessageRecord`)
 * while `frontWebhookIngestion.ts` imported `extractFrontConvMessageVersion`
 * back from recovery (one static import plus a redundant runtime
 * `await import(...)` inside `normalizeReconciliationEvent`) — a two-node
 * runtime cycle flagged by the pinned Knip audit
 * (`npx --yes knip@6.32.0 --cycles --reporter cycles --no-exit-code --no-progress`).
 *
 * The fix moved the only genuinely shared PURE helper verbatim into the leaf
 * `server/services/frontConvMessageVersion.ts`. This guard pins:
 *
 *   1. `frontWebhookIngestion.ts` has NO import edge to `frontHistoricalRecovery`
 *      — static, dynamic `import(...)`, `import type`, or `require`. (The
 *      remaining recovery → ingestion edge is one-way and allowed.)
 *   2. The leaf stays a leaf: its only permitted imports are `node:`-prefixed
 *      builtins and erased `import type` — so it can never grow an edge back
 *      into either service, nor into db/storage/routes/schedulers/workers,
 *      and never becomes a dumping ground.
 *   3. The leaf still exports `extractFrontConvMessageVersion` (proves the
 *      guard is scanning the real module, not passing vacuously).
 *   4. Neither service re-declares its own copy of the helper (both must
 *      keep importing the single leaf implementation — no duplication drift).
 *
 * Comments are stripped before scanning so doc references to the old layout
 * (or to this task) cannot trip the guard.
 */

import * as fs from "fs";

const INGESTION = "server/services/frontWebhookIngestion.ts";
const RECOVERY = "server/services/frontHistoricalRecovery.ts";
const LEAF = "server/services/frontConvMessageVersion.ts";

let failed = 0;
function check(cond: boolean, okMsg: string, failMsg: string): void {
  if (cond) {
    console.log(`  ok  ${okMsg}`);
  } else {
    console.error(`  FAIL ${failMsg}`);
    failed++;
  }
}

/**
 * Strip block and line comments so prose mentions of module names can't
 * produce false positives. String literals are left intact — import
 * specifiers ARE string literals and are exactly what we scan for.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Collect every import specifier in the (comment-stripped) source:
 *   - static:  import ... from "spec" / export ... from "spec"
 *   - bare:    import "spec"
 *   - dynamic: import("spec")
 *   - CJS:     require("spec")
 * Type-only imports (`import type ... from "spec"`) are collected separately
 * — they are erased at compile time and cannot form a runtime cycle.
 */
function collectImportSpecifiers(stripped: string): {
  runtime: string[];
  typeOnly: string[];
} {
  const runtime: string[] = [];
  const typeOnly: string[] = [];

  const fromRe = /\b(import|export)\s+(type\s+)?[^"'()]*?\bfrom\s*["']([^"']+)["']/g;
  for (const m of stripped.matchAll(fromRe)) {
    (m[2] ? typeOnly : runtime).push(m[3]);
  }
  const bareImportRe = /\bimport\s*["']([^"']+)["']/g;
  for (const m of stripped.matchAll(bareImportRe)) runtime.push(m[1]);

  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of stripped.matchAll(dynamicRe)) runtime.push(m[1]);

  const requireRe = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of stripped.matchAll(requireRe)) runtime.push(m[1]);

  return { runtime, typeOnly };
}

console.log("\n=== Front ingestion/recovery import-cycle guard (Task #3945) ===");

for (const f of [INGESTION, RECOVERY, LEAF]) {
  if (!fs.existsSync(f)) {
    console.error(`  FAIL expected source file missing: ${f}`);
    failed++;
  }
}

if (failed === 0) {
  const ingestionSrc = stripComments(fs.readFileSync(INGESTION, "utf8"));
  const recoverySrc = stripComments(fs.readFileSync(RECOVERY, "utf8"));
  const leafSrc = stripComments(fs.readFileSync(LEAF, "utf8"));

  // ── 1. Ingestion must have NO import edge back to recovery ──────────────
  {
    const { runtime, typeOnly } = collectImportSpecifiers(ingestionSrc);
    const offending = [...runtime, ...typeOnly].filter((s) =>
      s.includes("frontHistoricalRecovery"),
    );
    check(
      offending.length === 0,
      "frontWebhookIngestion.ts does not import frontHistoricalRecovery (no cycle edge)",
      `frontWebhookIngestion.ts imports frontHistoricalRecovery again (${offending.join(", ")}) — ` +
        "this recreates the recovery ↔ ingestion runtime cycle Task #3945 broke. " +
        "Shared pure helpers belong in server/services/frontConvMessageVersion.ts (or a new pure leaf).",
    );
  }

  // ── 2. The leaf must stay dependency-free ────────────────────────────────
  {
    const { runtime, typeOnly } = collectImportSpecifiers(leafSrc);
    const forbiddenRuntime = runtime.filter((s) => !s.startsWith("node:"));
    check(
      forbiddenRuntime.length === 0,
      "frontConvMessageVersion.ts has no runtime imports beyond node: builtins (pure leaf)",
      `frontConvMessageVersion.ts grew runtime import(s): ${forbiddenRuntime.join(", ")}. ` +
        "The leaf must import neither service and must have no db/storage, route, " +
        "scheduler, or worker access — keep it a pure dependency-free helper module.",
    );
    const typeOffenders = typeOnly.filter(
      (s) =>
        s.includes("frontHistoricalRecovery") ||
        s.includes("frontWebhookIngestion"),
    );
    check(
      typeOffenders.length === 0,
      "frontConvMessageVersion.ts has no type imports from either service",
      `frontConvMessageVersion.ts type-imports a service (${typeOffenders.join(", ")}) — ` +
        "even type-only edges from the leaf back into a service invite the cycle back in.",
    );
  }

  // ── 3. The leaf really exports the helper (guard is not vacuous) ────────
  {
    check(
      /\bexport\s+function\s+extractFrontConvMessageVersion\s*\(/.test(leafSrc),
      "frontConvMessageVersion.ts exports extractFrontConvMessageVersion",
      "frontConvMessageVersion.ts no longer exports extractFrontConvMessageVersion — " +
        "if the helper moved, update this guard AND every importer in lockstep.",
    );
  }

  // ── 4. Neither service re-inlines its own copy of the helper ────────────
  {
    for (const [label, src] of [
      ["frontWebhookIngestion.ts", ingestionSrc],
      ["frontHistoricalRecovery.ts", recoverySrc],
    ] as const) {
      check(
        !/\bfunction\s+extractFrontConvMessageVersion\s*\(/.test(src),
        `${label} does not re-declare extractFrontConvMessageVersion`,
        `${label} re-declares extractFrontConvMessageVersion — the single ` +
          "implementation lives in frontConvMessageVersion.ts; duplicating it " +
          "lets the two write paths' dedupe keys drift apart.",
      );
    }
  }

  // ── 5. Both services consume the leaf (single-source contract) ──────────
  {
    for (const [label, src] of [
      ["frontWebhookIngestion.ts", ingestionSrc],
      ["frontHistoricalRecovery.ts", recoverySrc],
    ] as const) {
      const { runtime } = collectImportSpecifiers(src);
      check(
        runtime.some((s) => s.includes("frontConvMessageVersion")),
        `${label} imports the shared leaf frontConvMessageVersion`,
        `${label} no longer imports frontConvMessageVersion — if the version ` +
          "helper is no longer needed there, update this guard; if it is, it " +
          "must come from the leaf, not a local copy.",
      );
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} cycle-guard check(s) failed`);
  process.exit(1);
}
console.log("\nAll Front ingestion/recovery cycle-guard checks passed.");
process.exit(0);
