import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import fs from "fs";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

/**
 * Dependency-free bundle analysis (Task #3815): when BUNDLE_REPORT_PATH is
 * set, dump per-chunk module composition (rollup renderedLength per module)
 * so contributors to each chunk can be ranked without adding a visualizer
 * dependency. Used by scripts/lint-bundle-budget.ts and ad-hoc analysis:
 *   BUNDLE_REPORT_PATH=.local/scratch/bundle-report.json npx vite build
 */
function bundleReportPlugin(): Plugin {
  return {
    name: "bundle-report",
    apply: "build",
    generateBundle(_options, bundle) {
      const out = process.env.BUNDLE_REPORT_PATH;
      if (!out) return;
      const moduleToChunk = new Map<string, string>();
      for (const [fileName, item] of Object.entries(bundle)) {
        if (item.type !== "chunk") continue;
        for (const id of Object.keys(item.modules)) moduleToChunk.set(id, fileName);
      }
      const chunks = [];
      for (const [fileName, item] of Object.entries(bundle)) {
        if (item.type !== "chunk") continue;
        // One example module-level static edge per (thisChunk -> otherChunk)
        // pair, so unexpected chunk imports can be traced to the exact module.
        const edgeExamples: Record<string, string> = {};
        for (const id of Object.keys(item.modules)) {
          const info = this.getModuleInfo(id);
          if (!info) continue;
          for (const dep of info.importedIds) {
            const target = moduleToChunk.get(dep);
            if (target && target !== fileName && !(target in edgeExamples)) {
              edgeExamples[target] = `${id} -> ${dep}`;
            }
          }
        }
        chunks.push({
          fileName,
          isEntry: item.isEntry,
          isDynamicEntry: item.isDynamicEntry,
          imports: item.imports,
          dynamicImports: item.dynamicImports,
          bytes: Buffer.byteLength(item.code),
          edgeExamples,
          modules: Object.fromEntries(
            Object.entries(item.modules).map(([id, m]) => [
              id,
              m.renderedLength,
            ]),
          ),
        });
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(
        out,
        JSON.stringify(
          { generatedAt: new Date().toISOString(), chunks },
          null,
          2,
        ),
      );
    },
  };
}

/**
 * Strip @univerjs/engine-render's lazy hyphenation dictionaries (Task #3837).
 *
 * engine-render ships 77 hyphenation-pattern dictionaries (~4.6 MB total, hu
 * alone ~765 KB) behind a PATTERN_LOADERS dynamic-import map, so every build
 * emitted 77 locale chunks even though the app is English-only. (The en-us
 * pattern is inlined in engine-render's index via Promise.resolve and is NOT
 * an import() entry, so it survives untouched.)
 *
 * Rewriting each `() => import("./xx-….js")` loader to
 * `() => Promise.resolve(void 0)` is safe: engine-render's loadPattern()
 * treats an undefined/patternless load as "no pattern for this language" and
 * returns without hyphenating — the documented graceful path.
 *
 * Only applies to real files under @univerjs/engine-render (build / SSR-less
 * prod path); the dev optimizeDeps prebundle keeps full behavior, which is
 * fine — the goal is build output. scripts/lint-bundle-budget.ts fails the
 * gate if pattern chunks ever reappear (e.g. after a univer upgrade renames
 * PATTERN_LOADERS and this transform stops matching).
 */
function stripUniverHyphenationPatternsPlugin(): Plugin {
  return {
    name: "strip-univer-hyphenation-patterns",
    transform(code, id) {
      if (!id.includes("@univerjs/engine-render/")) return null;
      const start = code.indexOf("const PATTERN_LOADERS = {");
      if (start === -1) return null;
      const end = code.indexOf("};", start);
      if (end === -1) return null;
      let replaced = 0;
      const region = code
        .slice(start, end)
        .replace(/\(\)\s*=>\s*import\("\.\/[^"]+"\)/g, () => {
          replaced += 1;
          return "() => Promise.resolve(void 0)";
        });
      if (replaced === 0) return null;
      return { code: code.slice(0, start) + region + code.slice(end), map: null };
    },
  };
}

/**
 * Stub @univerjs/engine-render's dead-weight text-shaping deps (Task #3850).
 *
 * engine-render is the only consumer of two libraries that are pure build
 * weight in this app (~570 KB pre-minify in the univer lazy chunk):
 *
 *  - opentype.js (~475 KB): its `parse()` is only reached from the OpenType
 *    text-shaping path, which is gated on `fontLibrary.isReady` — and
 *    FontLibrary only becomes ready after the browser grants the
 *    `local-fonts` permission AND exposes `window.queryLocalFonts` (a
 *    Chromium-only, user-prompted API this app never requests). The stub
 *    keeps a throwing `parse` so if a univer upgrade ever calls it outside
 *    that gate, it fails loudly instead of mis-shaping silently.
 *
 *  - franc-min (~91 KB incl. its trigram data): `franc(text)` only feeds
 *    LANG_MAP_TO_HYPHEN_LANG to pick a hyphenation dictionary — and those
 *    dictionaries are already stripped by
 *    stripUniverHyphenationPatternsPlugin above (English-only app; the
 *    inlined en-us pattern needs no detection: "unknown" simply skips
 *    hyphenation, the same graceful path). Returning "und" (franc's own
 *    "undetermined" code, unmapped in LANG_MAP_TO_HYPHEN_LANG) yields
 *    lang "unknown".
 *
 * Build-only (like the hyphenation strip, dev prebundle keeps full
 * behavior). Only imports FROM @univerjs/engine-render are redirected, so a
 * future first-party use of either package would not be affected.
 * scripts/lint-bundle-budget.ts fails the gate if either module reappears
 * in the build output.
 */
function stubUniverShapingDepsPlugin(): Plugin {
  const STUBS: Record<string, string> = {
    "opentype.js":
      `export function parse() { throw new Error("opentype.js was stripped from the build (vite.config.ts stubUniverShapingDepsPlugin); the local-fonts shaping path should be unreachable"); }\n` +
      `export default { parse };\n`,
    "franc-min": `export function franc() { return "und"; }\nexport default { franc };\n`,
  };
  const PREFIX = "\0univer-shaping-stub:";
  return {
    name: "stub-univer-shaping-deps",
    apply: "build",
    // Must resolve before vite's core resolver, or it never sees these ids.
    enforce: "pre",
    resolveId(source, importer) {
      if (source in STUBS && importer?.includes("@univerjs/engine-render/")) {
        return PREFIX + source;
      }
      return null;
    },
    load(id) {
      if (id.startsWith(PREFIX)) return STUBS[id.slice(PREFIX.length)];
      return null;
    },
  };
}

export default defineConfig({
  define: {
    // Cache-buster for the same-origin maplibre-gl vendor URLs
    // (client/src/lib/loadMaplibre.ts): maplibre-gl is served from
    // node_modules at runtime instead of being bundled (~1 MB per publish).
    __MAPLIBRE_VERSION__: JSON.stringify(
      JSON.parse(
        fs.readFileSync(
          path.resolve(import.meta.dirname, "node_modules/maplibre-gl/package.json"),
          "utf8",
        ),
      ).version,
    ),
  },
  plugins: [
    react(),
    runtimeErrorOverlay(),
    tailwindcss({ optimize: false }),
    bundleReportPlugin(),
    stripUniverHyphenationPatternsPlugin(),
    stubUniverShapingDepsPlugin(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer(),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  css: {
    postcss: {
      plugins: [],
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        /**
         * Deliberate vendor chunking (Task #3815).
         *
         * ONLY vendor-react is pinned. react/react-dom/scheduler import
         * nothing outside themselves, so the pin cannot absorb shared
         * modules, and it gives the biggest initial-load dependency a chunk
         * that stays byte-identical across app deploys (long-lived cache).
         *
         * vendor-framer-motion (Task #3865) is pinned for the same reason:
         * the framer-motion/motion-dom/motion-utils family is fully
         * self-contained, so the pin is absorption-safe, and it keeps the
         * animation core out of the report-page chunks it would otherwise
         * co-locate with (see SHARED_LIBRARY_CHUNK_RULES).
         *
         * Do NOT add pins for other heavy libraries (univer, recharts,
         * maplibre-gl, pdfjs-dist, livekit, ...): rollup pulls
         * a manual chunk's unassigned dependencies INTO that chunk, so tiny
         * shared utilities (clsx, class-variance-authority, radix internals —
         * all also used by univer's design system and recharts) get absorbed,
         * and then every chunk that uses `cn()` statically imports the
         * multi-MB vendor chunk. Measured: pinning vendor-univer put a 10 MB
         * chunk into the entry's static closure via exactly this mechanism.
         * Rollup's automatic usage-based coloring already isolates the heavy
         * libraries into lazy-only chunks (and re-colors correctly if usage
         * spreads); scripts/lint-bundle-budget.ts enforces that they never
         * enter the initial closure.
         *
         * Also do not group lucide-react (stays tree-split per icon) or
         * @radix-ui (one blob would pull unused primitives into first load).
         */
        manualChunks(id: string) {
          if (!id.includes("node_modules/")) return undefined;
          const seg = id.split("node_modules/").pop()!;
          const pkg = seg.startsWith("@")
            ? seg.split("/").slice(0, 2).join("/")
            : seg.split("/")[0];
          if (pkg === "react" || pkg === "react-dom" || pkg === "scheduler") {
            return "vendor-react";
          }
          // Task #3865: framer-motion is another self-contained family —
          // framer-motion/motion-dom/motion-utils import nothing shared
          // (tslib is declared but unused in the ES build; verified in the
          // bundle report), so the pin cannot absorb shared utilities. It
          // exists because framer's ~227 KB core has exactly the same set
          // of consumers as CeoPulseChartRenderer, so rollup's usage-based
          // coloring merged them into one chunk and every report page
          // downloaded the whole animation engine. All consumers are lazy
          // routes, so this chunk never enters the initial closure
          // (enforced by scripts/lint-bundle-budget.ts).
          if (
            pkg === "framer-motion" ||
            pkg === "motion-dom" ||
            pkg === "motion-utils"
          ) {
            return "vendor-framer-motion";
          }
          return undefined;
        },
      },
    },
  },
  optimizeDeps: {
    include: [
      "lucide-react",
      "react",
      "react-dom",
      "@tanstack/react-query",
      "framer-motion",
      "recharts",
      "wouter",
    ],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
