/* test-registration
{
  "name": "lint-bundle-budget guard — initial-JS budget evaluator + wiring lockstep (Task #3815)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3815: guards the bundle-budget evaluator (static-closure walk, entry/initial budgets, heavy-library-in-initial detection), the chunk-isolation + shared-chunk-cap rules for heavy libraries (Tasks #3846/#3859), and the wiring lockstep (gate.ts LINT_CHECKS, managed Long validation workflow command, bundleReportPlugin presence in vite.config.ts). Fixture-only — never runs a vite build; fast, DB-free, deterministic.",
  "tier": "small"
}
test-registration */
/**
 * Task #3815 — Guard for scripts/lint-bundle-budget.ts.
 *
 * The lint builds the client and fails the gate when the initial JS payload
 * (entry chunk + its static-import closure) regresses past the declared
 * budgets, or when a heavy library (spreadsheet/maps/PDF/charts/animation/
 * calling SDKs) enters that closure. This test proves the pure evaluator on
 * synthetic bundle reports — it deliberately NEVER runs vite:
 *
 *   1. A within-budget report with heavy libraries in lazy-only chunks passes.
 *   2. An over-budget entry chunk is flagged.
 *   3. An over-budget initial closure is flagged, and the closure walk is
 *      transitive (entry -> A -> B all count).
 *   4. A heavy library reachable through a transitive static import is
 *      flagged with its chunk and module id; stripped module families
 *      (hyphenation dictionaries, opentype.js/franc-min) reappearing are
 *      flagged; chunk-isolation rules (PDF, maps, univer, livekit, twilio)
 *      and shared-chunk byte caps (recharts, framer-motion) fire on merges.
 *   5. Zero/multiple entry chunks fail loudly (never silently pass).
 *   6. Budget constants and heavy-library patterns stay sane.
 *   7. Wiring lockstep: LINT_CHECKS + the managed Long validation workflow command +
 *      bundleReportPlugin + TASK_SELFCHECK row cover the lint.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeVerdictKey } from "../scripts/lintVerdictCache";
import {
  evaluateBundleBudget,
  ENTRY_BUDGET_BYTES,
  INITIAL_BUDGET_BYTES,
  BUNDLE_BUILD_TIMEOUT_MS,
  HEAVY_LIBRARY_PATTERNS,
  STRIPPED_MODULE_PATTERNS,
  ISOLATED_LIBRARY_RULES,
  RUNTIME_LOADED_LIBRARY_PATTERNS,
  SHARED_LIBRARY_CHUNK_RULES,
  cliMain,
  runLint,
  runLintCached,
  resolveLocalImports,
  bundleEnvDigest,
  classifyBundleBuildFailure,
  formatBundleBuildFailure,
  formatInvalidBundleReportFailure,
  parseBundleReport,
  type BundleReport,
} from "../scripts/lint-bundle-budget";

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

const KB = 1024;

function chunk(
  fileName: string,
  bytes: number,
  opts: { isEntry?: boolean; imports?: string[]; modules?: Record<string, number> } = {},
): BundleReport["chunks"][number] {
  return {
    fileName,
    isEntry: opts.isEntry ?? false,
    imports: opts.imports ?? [],
    bytes,
    modules: opts.modules ?? { [`client/src/gen/${fileName}.ts`]: bytes },
  };
}

// ─── 1. Within-budget report passes; lazy-only heavy libs are fine ────────────

const passing: BundleReport = {
  chunks: [
    chunk("assets/index-AAA.js", 300 * KB, {
      isEntry: true,
      imports: ["assets/vendor-react-BBB.js"],
      modules: { "node_modules/@tanstack/query-core/x.js": 300 * KB },
    }),
    chunk("assets/vendor-react-BBB.js", 180 * KB, {
      modules: { "node_modules/react-dom/cjs/react-dom-client.production.js": 180 * KB },
    }),
    // Heavy libraries in chunks OUTSIDE the closure must not trip anything.
    chunk("assets/univer-lazy.js", 4700 * KB, {
      modules: { "node_modules/@univerjs/engine-formula/lib/index.js": 4700 * KB },
    }),
    // recharts core in a dedicated lazy chunk (no app modules) is fine.
    chunk("assets/recharts-lazy.js", 440 * KB, {
      modules: { "node_modules/recharts/es6/chart/generateCategoricalChart.js": 440 * KB },
    }),
  ],
};
const passRes = evaluateBundleBudget(passing);
assert(passRes.violations.length === 0, "within-budget report has zero violations");
assert(passRes.entryBytes === 300 * KB, "entryBytes measured from the entry chunk");
assert(passRes.initialBytes === 480 * KB, "initialBytes sums entry + static closure only");
assert(passRes.initialChunks.length === 2, "lazy chunks stay out of the initial closure");

// ─── 2. Entry over budget ─────────────────────────────────────────────────────

const entryOver: BundleReport = {
  chunks: [chunk("assets/index-AAA.js", ENTRY_BUDGET_BYTES + 5 * KB, { isEntry: true })],
};
const entryRes = evaluateBundleBudget(entryOver);
assert(
  entryRes.violations.some((v) => v.includes("entry chunk") && v.includes("over the")),
  "over-budget entry chunk is flagged",
);

// ─── 3. Initial closure over budget, transitively ─────────────────────────────

const initialOver: BundleReport = {
  chunks: [
    chunk("assets/index-AAA.js", 300 * KB, { isEntry: true, imports: ["assets/A.js"] }),
    chunk("assets/A.js", 150 * KB, { imports: ["assets/B.js"] }),
    chunk("assets/B.js", 150 * KB),
  ],
};
const initRes = evaluateBundleBudget(initialOver);
assert(initRes.initialChunks.length === 3, "closure walk is transitive (entry -> A -> B)");
assert(initRes.initialBytes === 600 * KB, "transitive chunks all count toward initial bytes");
assert(
  initRes.violations.some((v) => v.includes("initial JS") && v.includes("over the")),
  "over-budget initial closure is flagged",
);

// ─── 4. Heavy library via transitive static import ────────────────────────────

const heavyLeak: BundleReport = {
  chunks: [
    chunk("assets/index-AAA.js", 100 * KB, { isEntry: true, imports: ["assets/A.js"] }),
    chunk("assets/A.js", 50 * KB, { imports: ["assets/B.js"] }),
    chunk("assets/B.js", 50 * KB, {
      modules: { "node_modules/@univerjs/sheets/lib/index.js": 50 * KB },
    }),
  ],
};
const heavyRes = evaluateBundleBudget(heavyLeak);
assert(
  heavyRes.violations.length === 1 &&
    heavyRes.violations[0].includes("@univerjs") &&
    heavyRes.violations[0].includes("assets/B.js"),
  "heavy library in a transitive static import is flagged with its chunk",
);

// ─── 4b. Stripped module families reappearing are flagged (Tasks #3837/#3850) ─

const strippedBack: BundleReport = {
  chunks: [
    chunk("assets/index-AAA.js", 100 * KB, { isEntry: true }),
    // Lazy chunk (NOT in the initial closure) — the heavy-library rule ignores
    // it, so the stripped-module rule must catch it on its own.
    chunk("assets/hu-lazy.js", 700 * KB, {
      modules: {
        "/w/node_modules/@univerjs/engine-render/lib/es/hu-DVk7Y_ka.js": 700 * KB,
      },
    }),
  ],
};
const strippedRes = evaluateBundleBudget(strippedBack);
assert(
  strippedRes.violations.length === 1 &&
    strippedRes.violations[0].includes("hyphenation dictionaries") &&
    strippedRes.violations[0].includes("assets/hu-lazy.js"),
  "reappeared hyphenation dictionary chunk is flagged even outside the initial closure",
);

// Task #3850: opentype.js + franc-min are stubbed out of univer's build; if
// either reappears (even in a lazy chunk) the stripped-module rule must fire.
const shapingBack = evaluateBundleBudget({
  chunks: [
    chunk("assets/index-AAA.js", 100 * KB, { isEntry: true }),
    chunk("assets/univer-lazy2.js", 600 * KB, {
      modules: {
        "/w/node_modules/opentype.js/dist/opentype.mjs": 470 * KB,
        "/w/node_modules/franc-min/data.js": 80 * KB,
      },
    }),
  ],
});
assert(
  shapingBack.violations.some((v) => v.includes("opentype.js") && v.includes("assets/univer-lazy2.js")) &&
    shapingBack.violations.some((v) => v.includes("franc-min")),
  "reappeared opentype.js/franc-min (stubbed shaping deps) are flagged even in a lazy chunk",
);

assert(
  !STRIPPED_MODULE_PATTERNS.some((p) =>
    p.pattern.test("/w/node_modules/@univerjs/engine-render/lib/es/index.js"),
  ),
  "stripped-module pattern never matches engine-render's index.js itself",
);
assert(
  evaluateBundleBudget({
    chunks: [
      chunk("assets/index-AAA.js", 100 * KB, {
        isEntry: true,
        modules: { "/w/node_modules/@univerjs/engine-render/lib/es/index.js": 100 * KB },
      }),
    ],
  }).violations.every((v) => !v.includes("hyphenation dictionaries")),
  "engine-render index.js alone does not trip the stripped-module rule",
);

// ─── 4c. PDF engine chunk isolation (Task #3846) ──────────────────────────────
// Task #3836 made pdfjs-dist/react-pdf lazy-load with PdfPreviewWithSearch;
// these cases prove a static import that merges the engine into a route
// chunk (which is itself lazy — the initial-closure rule can't see it) fails.

const pdfIsolated: BundleReport = {
  chunks: [
    chunk("assets/index-AAA.js", 100 * KB, { isEntry: true }),
    // The healthy shape: engine + its dedicated viewer, nothing else.
    chunk("assets/PdfPreviewWithSearch-CCC.js", 900 * KB, {
      modules: {
        "/w/client/src/components/PdfPreviewWithSearch.tsx": 10 * KB,
        "/w/node_modules/react-pdf/dist/index.js": 40 * KB,
        "/w/node_modules/pdfjs-dist/build/pdf.mjs": 850 * KB,
      },
    }),
    // A lazy route chunk WITHOUT pdf modules is of course fine.
    chunk("assets/ClientDetail-DDD.js", 400 * KB, {
      modules: { "/w/client/src/pages/ClientDetail.tsx": 400 * KB },
    }),
  ],
};
assert(
  evaluateBundleBudget(pdfIsolated).violations.length === 0,
  "PDF engine sharing a chunk with only PdfPreviewWithSearch passes",
);

const pdfMerged: BundleReport = {
  chunks: [
    chunk("assets/index-AAA.js", 100 * KB, { isEntry: true }),
    // A static import of PdfPreviewWithSearch merged the engine into the
    // (lazy) ClientDetail route chunk — outside the initial closure, so only
    // the isolation rule can catch it.
    chunk("assets/ClientDetail-DDD.js", 1300 * KB, {
      modules: {
        "/w/client/src/pages/ClientDetail.tsx": 400 * KB,
        "/w/client/src/components/PdfPreviewWithSearch.tsx": 10 * KB,
        "/w/node_modules/pdfjs-dist/build/pdf.mjs": 890 * KB,
      },
    }),
  ],
};
const pdfMergedRes = evaluateBundleBudget(pdfMerged);
assert(
  pdfMergedRes.violations.length === 1 &&
    pdfMergedRes.violations[0].includes("PDF engine") &&
    pdfMergedRes.violations[0].includes("assets/ClientDetail-DDD.js") &&
    pdfMergedRes.violations[0].includes("ClientDetail.tsx"),
  "PDF engine merged into a route chunk is flagged with chunk + intruding module",
);

// react-pdf alone (no pdfjs) merged into another chunk also trips the rule.
const reactPdfMerged: BundleReport = {
  chunks: [
    chunk("assets/index-AAA.js", 100 * KB, { isEntry: true }),
    chunk("assets/Other-EEE.js", 100 * KB, {
      modules: {
        "/w/client/src/components/SomethingElse.tsx": 60 * KB,
        "/w/node_modules/react-pdf/dist/index.js": 40 * KB,
      },
    }),
  ],
};
assert(
  evaluateBundleBudget(reactPdfMerged).violations.some((v) => v.includes("PDF engine")),
  "react-pdf leaking into a non-PDF chunk is flagged even without pdfjs-dist",
);

// If the engine ever lands in the ENTRY chunk, both the initial-closure
// heavy-library rule and the isolation rule fire — belt and braces.
const pdfInEntry: BundleReport = {
  chunks: [
    chunk("assets/index-AAA.js", 1000 * KB, {
      isEntry: true,
      modules: {
        "/w/client/src/main.tsx": 100 * KB,
        "/w/node_modules/pdfjs-dist/build/pdf.mjs": 900 * KB,
      },
    }),
  ],
};
const pdfEntryRes = evaluateBundleBudget(pdfInEntry);
assert(
  pdfEntryRes.violations.some((v) => v.includes("pdfjs-dist") && v.includes("INITIAL")) &&
    pdfEntryRes.violations.some((v) => v.includes("PDF engine")),
  "PDF engine in the entry chunk trips both the closure rule and the isolation rule",
);

assert(
  ISOLATED_LIBRARY_RULES.some(
    (r) =>
      r.pattern.test("node_modules/pdfjs-dist/build/pdf.mjs") &&
      r.pattern.test("node_modules/react-pdf/dist/index.js") &&
      r.allowedAppModules.test("/w/client/src/components/PdfPreviewWithSearch.tsx"),
  ),
  "isolation rule covers pdfjs-dist + react-pdf and allow-lists only the PDF viewer",
);
assert(
  HEAVY_LIBRARY_PATTERNS.some((p) => p.pattern.test("node_modules/react-pdf/dist/index.js")),
  "react-pdf is also in the heavy-library initial-closure list",
);

// ─── 4d. Other heavy-library isolation + shared-chunk caps (Task #3859) ───────

// maplibre is runtime-loaded (same-origin vendor route) and must NEVER be
// bundled — ANY appearance in any chunk (even a lazy, map-component-only
// one, the previously-sanctioned shape) is flagged.
const mapBundled: BundleReport = {
  chunks: [
    chunk("assets/index-AAA.js", 100 * KB, { isEntry: true }),
    chunk("assets/mapStyleReady-FFF.js", 1000 * KB, {
      modules: {
        "/w/client/src/lib/mapStyleReady.ts": 2 * KB,
        "/w/client/src/components/InteractiveHeatmap.tsx": 20 * KB,
        "/w/client/src/components/HexGridMap.tsx": 15 * KB,
        "/w/node_modules/maplibre-gl/dist/maplibre-gl.js": 1000 * KB,
      },
    }),
  ],
};
assert(
  evaluateBundleBudget(mapBundled).violations.some(
    (v) => v.includes("maplibre-gl") && v.includes("loadMaplibre"),
  ),
  "maplibre appearing ANYWHERE in the bundle is flagged (runtime-loaded, never bundled)",
);
assert(
  RUNTIME_LOADED_LIBRARY_PATTERNS.some((r) =>
    r.pattern.test("node_modules/maplibre-gl/dist/maplibre-gl.js"),
  ),
  "runtime-loaded rules cover maplibre-gl",
);

// univer: sheets/ modules allowed, anything else flagged.
assert(
  evaluateBundleBudget({
    chunks: [
      chunk("assets/index-AAA.js", 100 * KB, { isEntry: true }),
      chunk("assets/univer-HHH.js", 4700 * KB, {
        modules: {
          "/w/client/src/components/sheets/UniverEditor.tsx": 10 * KB,
          "/w/node_modules/@univerjs/core/lib/index.js": 4700 * KB,
        },
      }),
    ],
  }).violations.length === 0,
  "@univerjs sharing a chunk with only components/sheets/ modules passes",
);
// Task #4024: the docs editor (components/docs/) is the second sanctioned
// Univer surface — its lazy chunk may co-locate with @univerjs too.
assert(
  evaluateBundleBudget({
    chunks: [
      chunk("assets/index-AAA.js", 100 * KB, { isEntry: true }),
      chunk("assets/univer-docs-DDD.js", 3200 * KB, {
        modules: {
          "/w/client/src/components/docs/UniverDocEditor.tsx": 10 * KB,
          "/w/node_modules/@univerjs/core/lib/index.js": 3200 * KB,
        },
      }),
    ],
  }).violations.length === 0,
  "@univerjs sharing a chunk with only components/docs/ modules passes",
);
assert(
  evaluateBundleBudget({
    chunks: [
      chunk("assets/index-AAA.js", 100 * KB, { isEntry: true }),
      chunk("assets/SheetEditorPage-III.js", 4800 * KB, {
        modules: {
          "/w/client/src/pages/ClientDetail.tsx": 100 * KB,
          "/w/node_modules/@univerjs/core/lib/index.js": 4700 * KB,
        },
      }),
    ],
  }).violations.some((v) => v.includes("@univerjs") && v.includes("ClientDetail.tsx")),
  "@univerjs merged into a non-sheets/docs chunk is flagged",
);

// livekit: the Comms surface (pages/Comms.tsx + components/comms/*) is allowed…
assert(
  evaluateBundleBudget({
    chunks: [
      chunk("assets/index-AAA.js", 100 * KB, { isEntry: true }),
      chunk("assets/Comms-JJJ.js", 700 * KB, {
        modules: {
          "/w/client/src/pages/Comms.tsx": 50 * KB,
          "/w/client/src/components/comms/CallUI.tsx": 20 * KB,
          "/w/client/src/components/comms/ThreadsView.tsx": 30 * KB,
          "/w/node_modules/livekit-client/dist/livekit-client.esm.mjs": 400 * KB,
        },
      }),
    ],
  }).violations.length === 0,
  "livekit-client inside the Comms surface chunk passes",
);
// …but any other surface pulling it in fails.
assert(
  evaluateBundleBudget({
    chunks: [
      chunk("assets/index-AAA.js", 100 * KB, { isEntry: true }),
      chunk("assets/Shared-KKK.js", 500 * KB, {
        modules: {
          "/w/client/src/pages/ConversationHub.tsx": 100 * KB,
          "/w/node_modules/livekit-client/dist/livekit-client.esm.mjs": 400 * KB,
        },
      }),
    ],
  }).violations.some((v) => v.includes("livekit-client") && v.includes("ConversationHub.tsx")),
  "livekit-client leaking into a non-Comms chunk is flagged",
);

// twilio: only the useTwilioDevice hook may co-locate.
assert(
  evaluateBundleBudget({
    chunks: [
      chunk("assets/index-AAA.js", 100 * KB, { isEntry: true }),
      chunk("assets/twilio-LLL.js", 180 * KB, {
        modules: {
          "/w/client/src/hooks/useTwilioDevice.ts": 5 * KB,
          "/w/node_modules/@twilio/voice-sdk/es5/twilio/device.js": 175 * KB,
        },
      }),
    ],
  }).violations.length === 0,
  "@twilio/voice-sdk sharing a chunk with only useTwilioDevice passes",
);
assert(
  evaluateBundleBudget({
    chunks: [
      chunk("assets/index-AAA.js", 100 * KB, { isEntry: true }),
      chunk("assets/Hub-MMM.js", 300 * KB, {
        modules: {
          "/w/client/src/pages/ConversationHub.tsx": 125 * KB,
          "/w/node_modules/@twilio/voice-sdk/es5/twilio/device.js": 175 * KB,
        },
      }),
    ],
  }).violations.some((v) => v.includes("@twilio/voice-sdk") && v.includes("ConversationHub.tsx")),
  "@twilio/voice-sdk merged into a route chunk is flagged",
);

// recharts shared-chunk cap: small wrappers mixed into app chunks are fine…
assert(
  evaluateBundleBudget({
    chunks: [
      chunk("assets/index-AAA.js", 100 * KB, { isEntry: true }),
      chunk("assets/HealthDashboard-NNN.js", 380 * KB, {
        modules: {
          "/w/client/src/pages/admin/HealthDashboard.tsx": 350 * KB,
          "/w/node_modules/recharts/es6/chart/ComposedChart.js": 30 * KB,
        },
      }),
      // A dedicated shared chunk may carry the whole core (no app modules).
      chunk("assets/generateCategoricalChart-OOO.js", 440 * KB, {
        modules: {
          "/w/node_modules/recharts/es6/chart/generateCategoricalChart.js": 440 * KB,
        },
      }),
    ],
  }).violations.length === 0,
  "recharts small wrappers in app chunks + big core in a dedicated chunk passes",
);
// …but the multi-hundred-KB core merging into an app chunk fails.
const rechartsMergedRes = evaluateBundleBudget({
  chunks: [
    chunk("assets/index-AAA.js", 100 * KB, { isEntry: true }),
    chunk("assets/TrendAnalytics-PPP.js", 800 * KB, {
      modules: {
        "/w/client/src/pages/TrendAnalytics.tsx": 360 * KB,
        "/w/node_modules/recharts/es6/chart/generateCategoricalChart.js": 440 * KB,
      },
    }),
  ],
});
assert(
  rechartsMergedRes.violations.length === 1 &&
    rechartsMergedRes.violations[0].includes("recharts") &&
    rechartsMergedRes.violations[0].includes("TrendAnalytics.tsx") &&
    rechartsMergedRes.violations[0].includes("mixed-chunk cap"),
  "recharts core merged into an app chunk breaks the mixed-chunk cap",
);

// framer-motion cap: sums library bytes across modules in the chunk.
assert(
  evaluateBundleBudget({
    chunks: [
      chunk("assets/index-AAA.js", 100 * KB, { isEntry: true }),
      chunk("assets/Big-QQQ.js", 700 * KB, {
        modules: {
          "/w/client/src/pages/PublicReport.tsx": 300 * KB,
          "/w/node_modules/framer-motion/dist/es/render/VisualElement.mjs": 200 * KB,
          "/w/node_modules/framer-motion/dist/es/projection/node/create-projection-node.mjs": 200 * KB,
        },
      }),
    ],
  }).violations.some((v) => v.includes("framer-motion") && v.includes("mixed-chunk cap")),
  "framer-motion bytes are summed per chunk against its cap",
);

// Rule-shape sanity for the Task #3859 additions.
assert(
  ISOLATED_LIBRARY_RULES.length >= 4 &&
    ISOLATED_LIBRARY_RULES.some((r) => r.pattern.test("node_modules/@univerjs/core/lib/index.js")) &&
    ISOLATED_LIBRARY_RULES.some((r) => r.pattern.test("node_modules/livekit-client/dist/x.mjs")) &&
    ISOLATED_LIBRARY_RULES.some((r) => r.pattern.test("node_modules/@twilio/voice-sdk/es5/x.js")),
  "isolation rules cover @univerjs, livekit-client, @twilio/voice-sdk (maplibre moved to runtime-loaded)",
);
assert(
  SHARED_LIBRARY_CHUNK_RULES.some(
    (r) => r.pattern.test("node_modules/recharts/es6/chart/generateCategoricalChart.js") && r.maxBytesWithApp < 128 * KB,
  ) &&
    SHARED_LIBRARY_CHUNK_RULES.some(
      (r) => r.pattern.test("node_modules/framer-motion/dist/es/index.mjs") && r.maxBytesWithApp < 512 * KB,
    ),
  "shared-chunk caps cover recharts + framer-motion and stay well under their core sizes",
);
assert(
  ISOLATED_LIBRARY_RULES.every((r) => r.entryPointHint.length > 0),
  "every isolation rule carries an entry-point hint for the failure message",
);

// Allow-listed anchor files must exist — a rename would make a rule allow
// nothing (always-fail) or get 'fixed' wrongly. Fail here first with a clear
// message.
for (const p of [
  "client/src/components/PdfPreviewWithSearch.tsx",
  "client/src/lib/mapStyleReady.ts",
  "client/src/components/InteractiveHeatmap.tsx",
  "client/src/components/HexGridMap.tsx",
  "client/src/components/sheets/UniverEditor.tsx",
  "client/src/components/docs/UniverDocEditor.tsx",
  "client/src/pages/Comms.tsx",
  "client/src/components/comms/CallUI.tsx",
  "client/src/hooks/useTwilioDevice.ts",
]) {
  assert(
    existsSync(join(process.cwd(), p)),
    `${p} exists where an isolation allow-list expects it`,
  );
}

// ─── 5. Zero / multiple entries fail loudly ───────────────────────────────────

assert(
  evaluateBundleBudget({ chunks: [chunk("assets/a.js", KB)] }).violations.some((v) =>
    v.includes("expected exactly 1 entry chunk"),
  ),
  "report with no entry chunk fails loudly",
);
assert(
  evaluateBundleBudget({
    chunks: [chunk("a.js", KB, { isEntry: true }), chunk("b.js", KB, { isEntry: true })],
  }).violations.some((v) => v.includes("expected exactly 1 entry chunk")),
  "report with two entry chunks fails loudly",
);

// ─── 6. Budget constants + heavy patterns stay sane ───────────────────────────

assert(
  ENTRY_BUDGET_BYTES < INITIAL_BUDGET_BYTES,
  "entry budget is below the total-initial budget",
);
assert(
  ENTRY_BUDGET_BYTES >= 100 * KB && ENTRY_BUDGET_BYTES <= 1024 * KB,
  "entry budget stays in a sane band (no silent ballooning past 1 MB)",
);
assert(
  INITIAL_BUDGET_BYTES <= 1536 * KB,
  "initial budget stays well under the pre-split 4.7 MB era",
);
assert(HEAVY_LIBRARY_PATTERNS.length >= 7, "heavy-library list covers the known heavy deps");
assert(
  HEAVY_LIBRARY_PATTERNS.every((p) => p.pattern.source.includes("node_modules")),
  "every heavy pattern anchors on node_modules (never matches app code)",
);
assert(
  HEAVY_LIBRARY_PATTERNS.some((p) => p.pattern.test("node_modules/@univerjs/core/lib/index.js")) &&
    HEAVY_LIBRARY_PATTERNS.some((p) => p.pattern.test("node_modules/recharts/es6/chart/generateCategoricalChart.js")) &&
    HEAVY_LIBRARY_PATTERNS.some((p) => p.pattern.test("node_modules/maplibre-gl/dist/maplibre-gl.js")),
  "patterns match representative heavy-library module ids",
);
assert(
  !HEAVY_LIBRARY_PATTERNS.some((p) => p.pattern.test("client/src/lib/utils.ts")),
  "patterns never match first-party app modules",
);

// ─── 7. Wiring lockstep ───────────────────────────────────────────────────────

const gateSrc = readFileSync(join(process.cwd(), "scripts/gate.ts"), "utf-8");
assert(
  /name:\s*"lint-bundle-budget"/.test(gateSrc),
  "gate.ts LINT_CHECKS registers lint-bundle-budget",
);
const driftSrc = readFileSync(join(process.cwd(), "scripts/lint-gate-workflow-drift.ts"), "utf-8");
assert(
  /export const LONG_VALIDATION_WORKFLOW\s*=\s*\{[\s\S]*?command:\s*"npm run validate:long -- --request \.local\/runs\/long-validation-request\.json"/.test(driftSrc),
  "lint-gate-workflow-drift.ts defines LONG_VALIDATION_WORKFLOW with the exact managed Long validation command",
);
const viteSrc = readFileSync(join(process.cwd(), "vite.config.ts"), "utf-8");
assert(
  viteSrc.includes("BUNDLE_REPORT_PATH"),
  "vite.config.ts keeps the bundleReportPlugin the lint depends on",
);
assert(
  viteSrc.includes("vendor-react"),
  "vite.config.ts keeps the vendor-react manual chunk (entry budget assumes it)",
);
const selfcheckSrc = readFileSync(join(process.cwd(), "TASK_SELFCHECK.md"), "utf-8");

const timeoutFailure = classifyBundleBuildFailure(
  {
    status: null,
    signal: "SIGTERM",
    error: Object.assign(new Error("spawnSync vite ETIMEDOUT"), { code: "ETIMEDOUT" }),
  },
  false,
);
const lintSrc = readFileSync(join(process.cwd(), "scripts/lint-bundle-budget.ts"), "utf-8");
assert(
  typeof runLintCached === "function",
  "runLintCached exported (verdict-cached wrapper)",
);
assert(
  lintSrc.includes("readGreenVerdict") && lintSrc.includes("writeGreenVerdict"),
  "script wires lintVerdictCache read+write (green-only by module contract)",
);
for (const input of [
  '"client"',
  '"shared"',
  "vite.config.ts",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
  "scripts/lint-bundle-budget.ts",
  "scripts/lintVerdictCache.ts",
]) {
  assert(
    lintSrc.includes(input),
    `verdict key inputs include ${input} — a byte change there must force a real build`,
  );
}
assert(
  lintSrc.includes("reused cached green verdict"),
  "cache hits report honestly (\"reused cached green verdict\", never \"built\")",
);
assert(
  lintSrc.includes("--no-verdict-cache"),
  "standalone --no-verdict-cache bypass exists (LINT_VERDICT_CACHE=0 is the global kill switch)",
);
assert(
  /useCache \? runLintCached\(\) : runLint\(\)/.test(lintSrc),
  "cliMain default path goes through the verdict cache (the gate worker calls cliMain())",
);

// Behavioral: a changed VITE_* environment value rotates the env digest
// (vite injects those values into client chunk bytes), while non-VITE env
// churn does not; values are hashed, never stored in clear.
{
  const base = { VITE_CLERK_PUBLISHABLE_KEY: "pk_a", VITE_APP_VERSION: "1", PATH: "/x" };
  const d1 = bundleEnvDigest(base);
  const d2 = bundleEnvDigest({ ...base, VITE_CLERK_PUBLISHABLE_KEY: "pk_b" });
  const d3 = bundleEnvDigest({ ...base, PATH: "/y", HOME: "/h" });
  const d4 = bundleEnvDigest({ ...base, VITE_NEW_FLAG: "on" });
  assert(d1 !== d2, "rotating a VITE_* value changes the env digest (cache miss)");
  assert(d1 === d3, "non-VITE env churn does not perturb the digest");
  assert(d1 !== d4, "introducing a new VITE_* variable changes the digest");
  assert(!d1.includes("pk_a"), "digest never contains raw env values");
  const k1 = computeVerdictKey({ label: "env-fixture", repoRoot: process.cwd(), files: [], extra: [`vite-env:${d1}`] });
  const k2 = computeVerdictKey({ label: "env-fixture", repoRoot: process.cwd(), files: [], extra: [`vite-env:${d2}`] });
  assert(k1 !== k2, "a changed env digest rotates the verdict key");
  assert(
    /extra:\s*\[`vite-env:\$\{bundleEnvDigest\(process\.env\)\}`\]/.test(lintSrc),
    "the real key folds the VITE_* env digest in via computeVerdictKey extra",
  );
}

// Behavioral: the key input surface includes vite.config.ts's repo-local
// transitive imports — editing a local vite plugin file must rotate the key
// and force a real build. (vite-plugin-meta-images.ts, the former real-repo
// example, was removed in Task #4641; vite.config.ts currently has no local
// imports, so the resolver behavior is proven by the fixture test below.)
const viteConfigImports = resolveLocalImports(join(process.cwd(), "vite.config.ts"));
assert(
  Array.isArray(viteConfigImports) &&
    viteConfigImports.every((p) => !p.endsWith("vite-plugin-meta-images.ts")),
  "removed vite-plugin-meta-images.ts must not reappear as a vite.config.ts input",
);
assert(
  lintSrc.includes("resolveLocalImports(resolve(ROOT, \"vite.config.ts\"))"),
  "collectBundleVerdictInputs folds vite.config.ts's local import closure into the key",
);

// Behavioral (fixture, .local/scratch): the resolver follows transitive
// relative imports, and a one-byte change to ANY resolved input rotates the
// verdict key (⇒ cache miss ⇒ real build).
{
  const fixDir = join(process.cwd(), ".local/scratch/bundle-budget-cache-fixture");
  rmSync(fixDir, { recursive: true, force: true });
  mkdirSync(fixDir, { recursive: true });
  writeFileSync(join(fixDir, "entry.ts"), 'import { p } from "./plugin";\nexport const e = p;\n');
  writeFileSync(join(fixDir, "plugin.ts"), 'import { h } from "./deep/helper";\nexport const p = h;\n');
  mkdirSync(join(fixDir, "deep"), { recursive: true });
  writeFileSync(join(fixDir, "deep", "helper.ts"), "export const h = 1;\n");
  const resolved = resolveLocalImports(join(fixDir, "entry.ts"));
  assert(
    resolved.some((p) => p.endsWith("plugin.ts")) && resolved.some((p) => p.endsWith("helper.ts")),
    "resolver follows transitive relative imports (entry -> plugin -> deep/helper)",
  );
  const keyOf = () =>
    computeVerdictKey({ label: "fixture", repoRoot: process.cwd(), files: resolved });
  const before = keyOf();
  writeFileSync(join(fixDir, "deep", "helper.ts"), "export const h = 2;\n");
  assert(keyOf() !== before, "one-byte change to a transitive input rotates the verdict key (cache miss)");
  writeFileSync(join(fixDir, "deep", "helper.ts"), "export const h = 1;\n");
  assert(keyOf() === before, "restoring the byte restores the key (identity, not time, invalidates)");
  rmSync(fixDir, { recursive: true, force: true });
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nlint-bundle-budget guard: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

const invalidJsonReport = parseBundleReport("{");

const spawnFailure = classifyBundleBuildFailure(
  {
    status: null,
    signal: null,
    error: Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" }),
  },
  false,
);

  const parsed = parseBundleReport(raw);

const exitFailure = classifyBundleBuildFailure(
  { status: 2, signal: null, stderr: "rollup failed" },
  false,
);

const missingReportFailure = classifyBundleBuildFailure(
  { status: 0, signal: null },
  false,
);
