/**
 * lint-bundle-budget — initial-JS payload budget for the client bundle (Task #3815).
 *
 * Builds the client with vite (report emitted by the bundleReportPlugin in
 * vite.config.ts via BUNDLE_REPORT_PATH) and fails if the first download a
 * browser must complete before the app shell can paint regresses:
 *
 *   1. The entry chunk exceeds ENTRY_BUDGET_BYTES.
 *   2. The initial static closure (entry + every chunk reachable through
 *      static chunk imports — all fetched before first render) exceeds
 *      INITIAL_BUDGET_BYTES.
 *   3. Any heavy library (HEAVY_LIBRARY_PATTERNS: spreadsheet engine, maps,
 *      PDF, charts, animation, calling SDKs) appears in that closure. These
 *      must only ever load with the lazy page that uses them.
 *   4. (Task #3846) The PDF engine (pdfjs-dist/react-pdf) shares a chunk with
 *      any first-party module other than PdfPreviewWithSearch — catches a
 *      static import merging it into a lazy ROUTE chunk (e.g. ClientDetail),
 *      which rule 3 cannot see because that chunk is outside the closure.
 *
 * Baseline (2026-08, Task #3815): entry 323 KB + vendor-react 188 KB =
 * 512 KB initial, down from a 751 KB single entry. Budgets sit just above
 * those sizes so real regressions fail loudly while routine drift (a few KB
 * of new routes/lazy stubs) does not. Raising a budget is a deliberate
 * decision — first try lazy imports; see the manualChunks comment in
 * vite.config.ts for why heavy libraries must NOT be pinned there.
 *
 * Task #4550: the vite build's GREEN verdicts are memoized via
 * scripts/lintVerdictCache.ts (see runLintCached below) — byte-identical
 * inputs reuse the last green verdict instead of paying the ~56s build.
 *
 * Wired through gate.ts LINT_CHECKS; the `.replit` `Validate` workflow runs
 * `npm run gate`. Guarded by tests/lint-bundle-budget.test.ts (fixture-only,
 * never builds).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  computeVerdictKey,
  readGreenVerdict,
  verdictCacheEnabled,
  writeGreenVerdict,
} from "./lintVerdictCache";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

export const ENTRY_BUDGET_BYTES = 360 * 1024;
export const INITIAL_BUDGET_BYTES = 560 * 1024;

/** Libraries that must never enter the initial static closure. */
export const HEAVY_LIBRARY_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "@univerjs (spreadsheet engine)", pattern: /node_modules\/@univerjs\// },
  { label: "maplibre-gl (maps)", pattern: /node_modules\/maplibre-gl\// },
  { label: "pdfjs-dist (PDF rendering)", pattern: /node_modules\/pdfjs-dist\// },
  { label: "react-pdf (PDF rendering)", pattern: /node_modules\/react-pdf\// },
  { label: "recharts (charting)", pattern: /node_modules\/recharts\// },
  { label: "framer-motion (animation)", pattern: /node_modules\/(framer-motion|motion-dom|motion-utils)\// },
  { label: "livekit-client (calls)", pattern: /node_modules\/livekit-client\// },
  { label: "@twilio/voice-sdk (calls)", pattern: /node_modules\/@twilio\/voice-sdk\// },
];

/**
 * Task #3837: engine-render's lazy hyphenation dictionaries (77 chunks,
 * ~4.6 MB) are stripped at build time by stripUniverHyphenationPatternsPlugin
 * in vite.config.ts (the app is English-only; en-us is inlined in
 * engine-render's index and unaffected). If a univer upgrade renames the
 * PATTERN_LOADERS map and the transform silently stops matching, these
 * modules reappear as lazy chunks — this pattern fails the gate loudly.
 * lib/es contains only index.js plus the pattern dictionaries.
 */
export const STRIPPED_MODULE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  {
    label: "@univerjs/engine-render hyphenation dictionaries",
    pattern: /node_modules\/@univerjs\/engine-render\/lib\/es\/(?!index\.js$)[^/]+\.js$/,
  },
  /**
   * Task #3850: opentype.js + franc-min (~570 KB) are stubbed out of
   * engine-render's build by stubUniverShapingDepsPlugin in vite.config.ts
   * (opentype shaping is gated on the never-granted local-fonts permission;
   * franc only picks already-stripped hyphenation dictionaries). engine-render
   * is their only importer, so ANY appearance in the bundle means the stub
   * stopped matching (e.g. a univer upgrade changed the import shape).
   */
  {
    label: "opentype.js (univer text shaping — stubbed)",
    pattern: /node_modules\/opentype\.js\//,
  },
  {
    label: "franc-min (univer hyphenation language detection — stubbed)",
    pattern: /node_modules\/franc-min\//,
  },
];

/**
 * Task #3846: chunk-isolation for the PDF engine. Task #3836 made
 * pdfjs-dist/react-pdf load lazily on first PDF view (CommandPanel's
 * lazyWithRetry(() => import("./PdfPreviewWithSearch"))), cutting the
 * client-detail chunk from ~869 KB to ~451 KB. The initial-closure rule
 * above cannot protect that win: the ClientDetail route chunk is itself
 * lazy, so a future STATIC import of PdfPreviewWithSearch (or react-pdf /
 * pdfjs-dist) would merge the ~900 KB engine into the route chunk without
 * touching the initial closure. This rule fails the gate whenever a chunk
 * containing an isolated library also contains any first-party module
 * other than the library's own dedicated viewer component(s).
 */
export const ISOLATED_LIBRARY_RULES: ReadonlyArray<{
  label: string;
  /** node_modules module ids that identify the library. */
  pattern: RegExp;
  /** First-party modules allowed to share a chunk with the library. */
  allowedAppModules: RegExp;
  /** Human hint for the failure message: the sanctioned lazy entry point. */
  entryPointHint: string;
}> = [
  {
    label: "pdfjs-dist/react-pdf (PDF engine)",
    pattern: /node_modules\/(pdfjs-dist|react-pdf)\//,
    allowedAppModules: /client\/src\/components\/PdfPreviewWithSearch\.tsx$/,
    entryPointHint:
      "only `import(\"./PdfPreviewWithSearch\")` (dynamic, via lazyWithRetry in CommandPanel.tsx) may pull it in",
  },
  // Task #3859: the same protection for the other feature-surface-only heavy
  // libraries. Allow-lists mirror the modules that legitimately co-locate with
  // each library in the current build (verified against a real bundle report).
  {
    label: "@univerjs (spreadsheet + document engine)",
    pattern: /node_modules\/@univerjs\//,
    allowedAppModules: /client\/src\/components\/(sheets|docs)\//,
    entryPointHint:
      "UniverEditor.tsx / UniverDocEditor.tsx load it with `await import()` — never import @univerjs statically outside client/src/components/sheets/ or client/src/components/docs/",
  },
  {
    label: "livekit-client (calls)",
    pattern: /node_modules\/livekit-client\//,
    allowedAppModules: /client\/src\/(components\/comms\/|pages\/Comms\.tsx$)/,
    entryPointHint:
      "it belongs to the Comms surface (pages/Comms.tsx + components/comms/*) only — never import CallUI or livekit from another route",
  },
  {
    label: "@twilio/voice-sdk (calls)",
    pattern: /node_modules\/@twilio\/voice-sdk\//,
    allowedAppModules: /client\/src\/hooks\/useTwilioDevice\.ts$/,
    entryPointHint:
      "useTwilioDevice.ts loads it with `await import(\"@twilio/voice-sdk\")` — keep every other import dynamic through that hook",
  },
];

/**
 * Map-style publish-size task: maplibre-gl is no longer bundled at all. Its
 * dist build is a single prebuilt ~1 MB file rollup cannot tree-shake, so it
 * re-shipped a full megabyte inside dist/public on every publish. It now
 * loads at runtime from the same-origin /vendor/maplibre-gl/ route (served
 * straight from node_modules — see registerMaplibreVendorRoutes in
 * server/static.ts and client/src/lib/loadMaplibre.ts). ANY appearance of
 * the package in the vite bundle means someone re-introduced a value import
 * (`import maplibregl from "maplibre-gl"` — only `import type` is allowed
 * in client code), undoing the size win — fail loudly.
 */
export const RUNTIME_LOADED_LIBRARY_PATTERNS: ReadonlyArray<{
  label: string;
  pattern: RegExp;
  hint: string;
}> = [
  {
    label: "maplibre-gl (map engine — runtime-loaded, never bundled)",
    pattern: /node_modules\/maplibre-gl\//,
    hint:
      "client code must use loadMaplibre() from client/src/lib/loadMaplibre.ts and `import type` " +
      "for typings — a value import of maplibre-gl re-bundles its untree-shakeable ~1 MB dist file",
  },
];
/**
 * Task #3859: libraries used across MANY feature surfaces (recharts powers a
 * dozen pages; framer-motion several) cannot get a single allow-list — Rollup
 * legitimately co-locates a few small wrapper modules with app chunks. What
 * must never happen is the library's multi-hundred-KB CORE merging into an
 * app chunk (e.g. a manualChunks pin disappearing or an import shape change
 * hoisting recharts' generateCategoricalChart into a route chunk). So instead
 * of isolation, cap the library bytes any single app-module-bearing chunk may
 * carry. Baselines (2026-08 build): recharts max 22.8 KB mixed-in
 * (core 439 KB lives in a dedicated shared chunk); framer-motion max 227 KB
 * (its core currently co-locates with CeoPulseChartRenderer).
 */
export const SHARED_LIBRARY_CHUNK_RULES: ReadonlyArray<{
  label: string;
  /** node_modules module ids that identify the library. */
  pattern: RegExp;
  /** Max library bytes allowed in a chunk that also contains app modules. */
  maxBytesWithApp: number;
}> = [
  { label: "recharts (charting)", pattern: /node_modules\/recharts\//, maxBytesWithApp: 64 * 1024 },
  // Task #3865: the framer core lives in the pinned vendor-framer-motion
  // chunk (see the manualChunks comment in vite.config.ts — the family is
  // self-contained, so the pin is absorption-safe). Only tiny per-consumer
  // wrapper modules may co-locate with app chunks now (2026-08 build: max
  // 2.1 KB mixed-in), so the cap drops from the old 288 KB (when the ~227 KB
  // core co-located with CeoPulseChartRenderer). The pattern covers the whole
  // family: motion-dom carries another ~115 KB of the engine.
  {
    label: "framer-motion (animation)",
    pattern: /node_modules\/(framer-motion|motion-dom|motion-utils)\//,
    maxBytesWithApp: 32 * 1024,
  },
];
/** First-party (non-dependency, non-virtual) module ids. */
const isAppModule = (id: string): boolean =>
  !id.includes("node_modules/") && !id.startsWith("\0");

export interface BundleChunkReport {
  fileName: string;
  isEntry: boolean;
  imports: string[];
  bytes: number;
  /** moduleId -> rendered bytes */
  modules: Record<string, number>;
}

export interface BundleReport {
  chunks: BundleChunkReport[];
}

export interface BudgetEvaluation {
  violations: string[];
  entryBytes: number;
  initialBytes: number;
  initialChunks: string[];
}

const KB = (n: number): string => `${(n / 1024).toFixed(1)} KB`;

/** Pure evaluator — unit-tested against synthetic reports. */
export function evaluateBundleBudget(
  report: BundleReport,
  budgets: { entryBytes: number; initialBytes: number } = {
    entryBytes: ENTRY_BUDGET_BYTES,
    initialBytes: INITIAL_BUDGET_BYTES,
  },
): BudgetEvaluation {
  const violations: string[] = [];
  const entries = report.chunks.filter((c) => c.isEntry);
  if (entries.length !== 1) {
    violations.push(
      `expected exactly 1 entry chunk in the client build, found ${entries.length} — ` +
        `the budget cannot be evaluated; check vite.config.ts / the bundle report`,
    );
    return { violations, entryBytes: 0, initialBytes: 0, initialChunks: [] };
  }
  const entry = entries[0];
  const byName = new Map(report.chunks.map((c) => [c.fileName, c]));

  // Initial closure: the entry plus every chunk reachable via static imports.
  const closure = new Set<string>();
  const stack = [entry.fileName];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (closure.has(name)) continue;
    closure.add(name);
    const chunk = byName.get(name);
    if (!chunk) continue;
    for (const imported of chunk.imports) stack.push(imported);
  }
  const initialChunks = Array.from(closure);
  const initialBytes = initialChunks.reduce((sum, name) => sum + (byName.get(name)?.bytes ?? 0), 0);

  if (entry.bytes > budgets.entryBytes) {
    violations.push(
      `entry chunk ${entry.fileName} is ${KB(entry.bytes)} — over the ${KB(budgets.entryBytes)} budget. ` +
        `Move new shell dependencies behind lazy imports (lazyWithRetry) instead of growing the entry.`,
    );
  }
  if (initialBytes > budgets.initialBytes) {
    violations.push(
      `initial JS (entry + static closure: ${initialChunks.join(", ")}) is ${KB(initialBytes)} — ` +
        `over the ${KB(budgets.initialBytes)} budget. A statically-imported chunk joined the first download; ` +
        `make the import dynamic or trim the dependency.`,
    );
  }

  for (const { label, pattern } of HEAVY_LIBRARY_PATTERNS) {
    for (const name of initialChunks) {
      const chunk = byName.get(name);
      if (!chunk) continue;
      const moduleId = Object.keys(chunk.modules).find((id) => pattern.test(id));
      if (moduleId) {
        violations.push(
          `heavy library ${label} is in the INITIAL static closure via ${name} ` +
            `(e.g. ${moduleId.slice(moduleId.lastIndexOf("node_modules/"))}). ` +
            `It must load only with the lazy page that uses it — never pin it in manualChunks ` +
            `(see vite.config.ts) and never import it statically from the shell.`,
        );
        break; // one violation per library is enough
      }
    }
  }

  for (const { label, pattern, allowedAppModules, entryPointHint } of ISOLATED_LIBRARY_RULES) {
    for (const chunk of report.chunks) {
      const moduleIds = Object.keys(chunk.modules);
      const libModule = moduleIds.find((id) => pattern.test(id));
      if (!libModule) continue;
      const intruder = moduleIds.find((id) => isAppModule(id) && !allowedAppModules.test(id));
      if (intruder) {
        violations.push(
          `isolated library ${label} shares chunk ${chunk.fileName} with app module ${intruder} ` +
            `(library module e.g. ${libModule.slice(libModule.lastIndexOf("node_modules/"))}). ` +
            `A static import merged the library into a route/component chunk, undoing its lazy ` +
            `split — ${entryPointHint}.`,
        );
        break; // one violation per rule is enough
      }
    }
  }

  for (const { label, pattern, maxBytesWithApp } of SHARED_LIBRARY_CHUNK_RULES) {
    for (const chunk of report.chunks) {
      const entries = Object.entries(chunk.modules);
      const libBytes = entries.reduce((sum, [id, b]) => (pattern.test(id) ? sum + b : sum), 0);
      if (libBytes === 0 || libBytes <= maxBytesWithApp) continue;
      const appModule = entries.map(([id]) => id).find(isAppModule);
      if (appModule) {
        violations.push(
          `shared library ${label} contributes ${KB(libBytes)} to chunk ${chunk.fileName}, which also ` +
            `contains app module ${appModule} — over the ${KB(maxBytesWithApp)} mixed-chunk cap. ` +
            `The library core merged into a page/component chunk (bloating that page's download); ` +
            `keep the core in a dedicated shared chunk — check import shapes and the manualChunks ` +
            `comment in vite.config.ts before raising the cap.`,
        );
        break; // one violation per rule is enough
      }
    }
  }

  for (const { label, pattern, hint } of RUNTIME_LOADED_LIBRARY_PATTERNS) {
    for (const chunk of report.chunks) {
      const moduleId = Object.keys(chunk.modules).find((id) => pattern.test(id));
      if (moduleId) {
        violations.push(
          `runtime-loaded library ${label} was BUNDLED via ${chunk.fileName} ` +
            `(e.g. ${moduleId.slice(moduleId.lastIndexOf("node_modules/"))}) — ${hint}.`,
        );
        break; // one violation per library is enough
      }
    }
  }

  for (const { label, pattern } of STRIPPED_MODULE_PATTERNS) {
    for (const chunk of report.chunks) {
      const moduleId = Object.keys(chunk.modules).find((id) => pattern.test(id));
      if (moduleId) {
        violations.push(
          `stripped module family "${label}" reappeared in the build via ${chunk.fileName} ` +
            `(e.g. ${moduleId.slice(moduleId.lastIndexOf("node_modules/"))}). ` +
            `stripUniverHyphenationPatternsPlugin in vite.config.ts should have removed it — ` +
            `a dependency upgrade likely changed the shape it matches on; update the transform.`,
        );
        break; // one violation per family is enough
      }
    }
  }

  return { violations, entryBytes: entry.bytes, initialBytes, initialChunks };
}

/**
 * Task #4550 — green-verdict cache for the bundle build (picks up the
 * deferral recorded in audits/gate-duration-budget-2026-08.md §7; the cache
 * contract itself was approved in the Task #4531 L3 review). The ~56s vite
 * build was the warm gate lint-phase floor even for server-only diffs.
 *
 * The key covers every byte the build reads that can change the verdict:
 *   - the ENTIRE client/ tree (src, index.html, public/ — vite's root), so
 *     any client change forces a real build;
 *   - the ENTIRE shared/ tree (reachable via the `@shared` alias);
 *   - vite.config.ts (budgets' upstream: plugins, manualChunks, aliases),
 *     package.json + package-lock.json (dep graph), tsconfig.json;
 *   - this script (budgets/rules live here) and the cache module.
 * The cache module folds in the Node major; the build always runs with
 * NODE_ENV=production, so the dev-only plugins (cartographer/dev-banner)
 * never load and need no env keying. GREEN ONLY: a red build/verdict is
 * never cached; any walk/hash error falls open to a real build. Kill
 * switch: LINT_VERDICT_CACHE=0. Honest reporting: a hit says "reused
 * cached green verdict", never "built".
 */
const VERDICT_CACHE_NAME = "lint-bundle-budget";

interface CachedBundleVerdictMeta {
  message: string;
  entryBytes: number;
  initialBytes: number;
  inputFileCount: number;
}

function walkFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, out);
    else if (entry.isFile()) out.push(p);
  }
}

/**
 * Resolve every repository-local file transitively imported from `entryAbs`
 * (relative `import ... from "./x"` / `import("./x")` specifiers only —
 * node_modules packages are covered by the lockfile in the key). Exported
 * for the guard test. Any unreadable file simply stops that branch; missing
 * resolutions are ignored (the file then isn't a build input either).
 */
export function resolveLocalImports(entryAbs: string): string[] {
  const seen = new Set<string>([entryAbs]);
  const queue = [entryAbs];
  const SPEC_RE = /(?:from\s+|import\s*\()\s*["'](\.\.?\/[^"']+)["']/g;
  const EXTS = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx"];
  while (queue.length > 0) {
    const file = queue.pop()!;
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of src.matchAll(SPEC_RE)) {
      const base = resolve(dirname(file), m[1]);
      for (const ext of EXTS) {
        const candidate = `${base}${ext}`;
        if (seen.has(candidate) || candidate.includes("node_modules")) continue;
        let isFile = false;
        try {
          isFile = statSync(candidate).isFile();
        } catch {
          isFile = false;
        }
        if (isFile) {
          seen.add(candidate);
          queue.push(candidate);
          break;
        }
      }
    }
  }
  return Array.from(seen);
}

/**
 * Digest of every environment variable that can change the emitted client
 * bundle: vite statically injects all `VITE_*` values into the output
 * (import.meta.env.VITE_…), so rotating one (e.g. a publishable Clerk key)
 * changes chunk bytes. Values are hashed, never logged or stored in clear.
 * NODE_ENV is pinned to production by runLint itself and needs no keying.
 * Exported for the guard test (takes the env as a parameter).
 */
export function bundleEnvDigest(env: Record<string, string | undefined>): string {
  const lines = Object.keys(env)
    .filter((k) => k.startsWith("VITE_"))
    .sort()
    .map((k) => `${k}\u0000${createHash("sha256").update(env[k] ?? "").digest("hex")}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function collectBundleVerdictInputs(): string[] | null {
  try {
    const files: string[] = [];
    walkFiles(resolve(ROOT, "client"), files);
    walkFiles(resolve(ROOT, "shared"), files);
    // vite.config.ts PLUS every repo-local file it transitively imports —
    // editing a local plugin file changes the build output and must rotate
    // the key. (No local imports exist today; the closure resolver stays so
    // any future local plugin is picked up automatically.)
    files.push(...resolveLocalImports(resolve(ROOT, "vite.config.ts")));
    files.push(
      resolve(ROOT, "package.json"),
      resolve(ROOT, "package-lock.json"),
      resolve(ROOT, "tsconfig.json"),
      resolve(ROOT, "scripts/lint-bundle-budget.ts"),
      resolve(ROOT, "scripts/lintVerdictCache.ts"),
    );
    return files;
  } catch {
    return null; // fall open — run the real build
  }
}

/** Verdict-cached wrapper around runLint() (see block comment above). */
export function runLintCached(): { ok: boolean; message: string; fromCache?: boolean } {
  let key: string | null = null;
  let inputCount = 0;
  if (verdictCacheEnabled()) {
    const inputs = collectBundleVerdictInputs();
    if (inputs) {
      inputCount = inputs.length;
      key = computeVerdictKey({
        label: VERDICT_CACHE_NAME,
        repoRoot: ROOT,
        files: inputs,
        // Vite injects VITE_* env values into client output — a rotated
        // value changes chunk bytes, so it must rotate the key too.
        extra: [`vite-env:${bundleEnvDigest(process.env)}`],
      });
    }
  }
  if (key) {
    const hit = readGreenVerdict<CachedBundleVerdictMeta>(ROOT, VERDICT_CACHE_NAME, key);
    if (hit) {
      return {
        ok: true,
        fromCache: true,
        message:
          `lint-bundle-budget: reused cached green verdict from ${hit.cachedAt} — ` +
          `all build inputs (client/ + shared/ trees, vite.config.ts, package.json, ` +
          `lockfile, tsconfig, lint script; ${hit.meta.inputFileCount} file(s)) are ` +
          `byte-identical to that green build (entry ${KB(hit.meta.entryBytes)}, ` +
          `initial ${KB(hit.meta.initialBytes)}). No build was run. ` +
          `LINT_VERDICT_CACHE=0 forces a real build.`,
      };
    }
  }
  const res = runLint();
  if (key && res.ok) {
    writeGreenVerdict<CachedBundleVerdictMeta>(ROOT, VERDICT_CACHE_NAME, key, {
      message: res.message,
      entryBytes: lastGreenSizes.entryBytes,
      initialBytes: lastGreenSizes.initialBytes,
      inputFileCount: inputCount,
    });
  }
  return res;
}

/** Structural side-channel for the sizes of the most recent green runLint()
 * (avoids re-parsing the human message when persisting the verdict). */
const lastGreenSizes = { entryBytes: 0, initialBytes: 0 };

export function runLint(): { ok: boolean; message: string } {
  const scratchDir = resolve(ROOT, ".local/scratch");
  const outDir = resolve(scratchDir, "bundle-budget-dist");
  const reportPath = resolve(scratchDir, "bundle-budget-report.json");
  mkdirSync(scratchDir, { recursive: true });
  rmSync(reportPath, { force: true });

  const viteBin = resolve(ROOT, "node_modules/vite/bin/vite.js");
  const build = spawnSync(
    process.execPath,
    [viteBin, "build", "--outDir", outDir, "--emptyOutDir", "--logLevel", "warn"],
    {
      cwd: ROOT,
      env: { ...process.env, BUNDLE_REPORT_PATH: reportPath, NODE_ENV: "production" },
      encoding: "utf8",
      timeout: 240_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  // The scratch build tree is only needed for the report.
  rmSync(outDir, { recursive: true, force: true });

  if (build.status !== 0 || !existsSync(reportPath)) {
    const tail = `${build.stdout ?? ""}\n${build.stderr ?? ""}`.trim().split("\n").slice(-15).join("\n");
    return {
      ok: false,
      message:
        `lint-bundle-budget FAILED — vite build ${build.status !== 0 ? `exited ${build.status}` : "produced no bundle report"} ` +
        `(bundleReportPlugin in vite.config.ts must honor BUNDLE_REPORT_PATH).\n${tail}`,
    };
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8")) as BundleReport;
  const result = evaluateBundleBudget(report);
  lastGreenSizes.entryBytes = result.entryBytes;
  lastGreenSizes.initialBytes = result.initialBytes;
  if (result.violations.length > 0) {
    return {
      ok: false,
      message:
        `lint-bundle-budget FAILED — ${result.violations.length} violation(s):\n` +
        result.violations.map((v) => `  ✗ ${v}`).join("\n"),
    };
  }
  return {
    ok: true,
    message:
      `lint-bundle-budget OK — entry ${KB(result.entryBytes)} ≤ ${KB(ENTRY_BUDGET_BYTES)}, ` +
      `initial JS ${KB(result.initialBytes)} ≤ ${KB(INITIAL_BUDGET_BYTES)} ` +
      `across ${result.initialChunks.length} chunk(s); no heavy libraries in the initial closure.`,
  };
}

/** Gate worker-pool entry (Task #3789 cliMain contract): prints and returns
 * the exit code. `argv` defaults to [] (not process.argv) — inside a gate
 * worker the process argv is the gate's own. Default path goes through the
 * green-verdict cache (Task #4550); `--no-verdict-cache` forces a real
 * build (LINT_VERDICT_CACHE=0 does too, globally). Honest reporting: on a
 * cache hit the message says "reused cached green verdict", never "built". */
export function cliMain(argv: string[] = []): number {
  const useCache = !argv.includes("--no-verdict-cache");
  const { ok, message } = useCache ? runLintCached() : runLint();
  if (ok) {
    console.log(message);
    return 0;
  }
  console.error(message);
  return 1;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  process.exit(cliMain(process.argv.slice(2)));
}
