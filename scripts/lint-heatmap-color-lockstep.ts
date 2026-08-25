/**
 * Drift guard: lock the heatmap rank-band palette to ONE shared definition
 * (Task #2600, guarding the Task #2587 consolidation).
 *
 * Background
 * ----------
 * The heatmap rank-band palette (Top 3 / Top 10 / Top 20 / Beyond 20 /
 * Unranked) and the period-over-period movement palette (improved / stable /
 * declined) used to be duplicated as hardcoded hex literals across the server
 * map-fill builder, the legend swatches, the paint helper, and the
 * report/dashboard band colors. Task #2587 consolidated them into the single
 * source of truth `shared/heatmapColors.ts`. Nothing, however, *prevented* a
 * future edit from re-introducing a hardcoded palette hex (e.g. `#0d6b3d`,
 * `#c53030`) in a component instead of importing from the shared module — which
 * is exactly the drift #2587 fixed. There was no automated check to catch it at
 * PR time.
 *
 * What this lint asserts
 * ----------------------
 *   Every distinctive rank/movement palette hex below appears ONLY inside
 *   `shared/heatmapColors.ts`. If one shows up anywhere else under the scanned
 *   source tree (client/src, server, shared), the guard fails and names the
 *   file/line — the author must import from `@shared/heatmapColors` instead.
 *
 * Distinguishing palette hexes from incidental same-hex uses
 * ----------------------------------------------------------
 * Two of the canonical palette entries are generic Tailwind slate values that
 * are used pervasively as muted-text / axis-tick / tooltip colors all over the
 * app, where they have nothing to do with the heatmap palette:
 *   - `#94a3b8` (Tailwind slate-400) — the "unranked" slate, but also the
 *     generic muted-text color used in dozens of unrelated places.
 *   - `#64748b` (Tailwind slate-500) — the "stable" movement color, but also a
 *     generic muted color.
 * Flagging those would be pure noise (a new muted label would trip the guard),
 * and a slate literal is indistinguishable from a real "unranked" drift. They
 * are therefore intentionally OUT of scope — see SLATE_HEXES_OUT_OF_SCOPE.
 *
 * The remaining five hexes are distinctive enough to flag. Two of them happen
 * to be reused by unrelated charts (the LSA lead-source series and the
 * sov90dAvg accent stroke). Those documented incidental sites are allow-listed
 * by (file, hex) with an EXACT expected count, so the current tree passes while
 * any *new* occurrence of that hex — even in an allow-listed file — still trips
 * the guard.
 *
 * Exit code:
 *   0 — no palette hex leaked outside the shared module (modulo the documented
 *       allow-list).
 *   1 — drift detected; the message names the offending file/line/hex.
 *
 * Emergency escape hatch:
 *   Set LINT_HEATMAP_COLOR_SKIP=1 to skip the check entirely. Use only when you
 *   are intentionally moving the palette in `shared/heatmapColors.ts` in the
 *   same change and updating this lint's reference set accordingly.
 */
import { readFileSync } from "node:fs";
import {
  isScannablePath,
  listTrackedFiles,
  walkDir,
} from "./lintFileDiscovery";

/** The single source of truth — the only file allowed to define the palette. */
const SOURCE_OF_TRUTH = "shared/heatmapColors.ts";

/**
 * Distinctive rank/movement palette hexes that must live only in the source of
 * truth. Keyed by hex (lowercased, no `#`) -> human label, used in messages.
 */
const FLAGGED_HEXES: Readonly<Record<string, string>> = {
  "0d6b3d": "rank Top 3",
  "4ade80": "rank Top 10",
  e88c30: "rank Top 20",
  c53030: "rank Beyond 20 / movement declined",
  "0d9448": "movement improved",
};

/**
 * Generic Tailwind slate values that double as palette entries (unranked /
 * stable) but are used pervasively as muted UI colors. Intentionally NOT
 * flagged — see the file header. Kept here so the decision is explicit and so a
 * future reader knows these were considered, not forgotten.
 */
const SLATE_HEXES_OUT_OF_SCOPE = ["94a3b8", "64748b"] as const;
void SLATE_HEXES_OUT_OF_SCOPE;

/**
 * Documented incidental sites: (relative file) -> (hex -> exact expected count).
 * These are genuine non-heatmap uses of a palette hex. The count is exact so a
 * NEW occurrence in the same file still trips the guard.
 */
const ALLOW_LIST: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  // LSA lead-source series color across the lead-mix charts (Task #4271 split
  // the PublicReport monolith: the same 7 uses now live in derive.ts + the
  // marketing slide; Task #4468 deleted publicHeatmaps.tsx and its sov90dAvg
  // accent stroke — the e88c30 allowance went with it).
  "client/src/pages/publicReport/derive.ts": { "4ade80": 1 },
  "client/src/pages/publicReport/MarketingSlide.tsx": { "4ade80": 3 },
  // Task #4360 promoted ReportForm's inline lead-source series to
  // lib/leadSourceColors.ts; the LSA green (#4ADE80) moved with it — an
  // incidental match with the rank Top-10 green, same as the derive.ts
  // series above. (Entry relocated here by Task #4370's completion rebase,
  // which caught the sweep shipping without this lint's allow-list update.)
  "client/src/lib/leadSourceColors.ts": { "4ade80": 1 },
  // sov90dAvg accent stroke on the dominance trend chart.
};

/**
 * File extensions worth scanning for color literals. This is the lint's
 * SEMANTIC filter (code/style files where a palette hex could take effect),
 * not its discovery mechanism — discovery is repo-wide via `git ls-files`
 * (Task #2846), so a hex reintroduced in a NEW tree (scripts/, tests/, a
 * future frontend dir) is in scope automatically. Docs/markdown may mention
 * palette hexes freely; they can't drift rendered colors.
 */
const SCAN_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".css"];

function isColorScannable(file: string): boolean {
  const base = file.split("/").pop() ?? file;
  if (base.includes("lint-heatmap-color-lockstep")) return false;
  return SCAN_EXTENSIONS.some((ext) => file.endsWith(ext));
}

interface Occurrence {
  file: string;
  line: number;
  hex: string;
}

interface LintResult {
  ok: boolean;
  errors: string[];
  filesScanned: number;
  occurrences: number;
}

/**
 * Optional overrides so the guard can be unit-tested against a temp fixture
 * tree without touching the real source. Production callers (the CLI below)
 * pass nothing and get the committed defaults.
 */
export interface LintOptions {
  /** Fixture mode: walk these directories instead of `git ls-files`. */
  scanDirs?: string[];
  /** The one file allowed to define the palette (defaults to SOURCE_OF_TRUTH). */
  sourceOfTruth?: string;
  /** (file -> (hex -> exact count)) incidental allow-list (defaults to ALLOW_LIST). */
  allowList?: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/**
 * Match `#<6 hex>` not immediately followed by another hex digit (so an 8-digit
 * `#rrggbbaa` literal is not mistaken for a 6-digit palette hex). Case
 * insensitive — drift can be written in any case.
 */
const HEX_RE = /#([0-9a-fA-F]{6})(?![0-9a-fA-F])/g;

export function runLint(opts: LintOptions = {}): LintResult {
  const sourceOfTruth = opts.sourceOfTruth ?? SOURCE_OF_TRUTH;
  const allowList = opts.allowList ?? ALLOW_LIST;

  const errors: string[] = [];
  const files: string[] = [];
  if (opts.scanDirs) {
    // Fixture mode: walk the given directories with the same filters.
    for (const dir of opts.scanDirs) walkDir(dir, files, isColorScannable);
  } else {
    // Default mode: repo-wide discovery via git ls-files (Task #2846).
    for (const f of listTrackedFiles()) {
      if (isScannablePath(f) && isColorScannable(f)) files.push(f);
    }
  }

  // Tally flagged-hex occurrences per file (skipping the source of truth).
  const occurrencesByFileHex = new Map<string, Map<string, Occurrence[]>>();
  let totalOccurrences = 0;

  for (const file of files) {
    const rel = file.replace(/\\/g, "/");
    if (rel === sourceOfTruth) continue;

    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      errors.push(`could not read ${rel}: ${(err as Error).message}`);
      continue;
    }

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      HEX_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = HEX_RE.exec(lines[i])) !== null) {
        const hex = m[1].toLowerCase();
        if (!(hex in FLAGGED_HEXES)) continue;
        totalOccurrences += 1;
        let byHex = occurrencesByFileHex.get(rel);
        if (!byHex) {
          byHex = new Map();
          occurrencesByFileHex.set(rel, byHex);
        }
        const arr = byHex.get(hex) ?? [];
        arr.push({ file: rel, line: i + 1, hex });
        byHex.set(hex, arr);
      }
    }
  }

  // Compare each file/hex tally against the allow-list.
  for (const [file, byHex] of Array.from(occurrencesByFileHex)) {
    for (const [hex, occs] of Array.from(byHex)) {
      const allowed = allowList[file]?.[hex] ?? 0;
      if (occs.length > allowed) {
        const label = FLAGGED_HEXES[hex];
        const lineList = occs.map((o) => o.line).join(", ");
        if (allowed === 0) {
          errors.push(
            `${file}: hardcoded heatmap palette hex #${hex} (${label}) at line(s) ${lineList} — ` +
              `import it from "@shared/heatmapColors" instead of hardcoding the hex.`,
          );
        } else {
          errors.push(
            `${file}: ${occs.length} occurrence(s) of #${hex} (${label}) at line(s) ${lineList}, ` +
              `but only ${allowed} documented incidental use(s) are allow-listed — ` +
              `a new occurrence appeared. If this is a real heatmap palette use, import from ` +
              `"@shared/heatmapColors"; if it is a new incidental (non-heatmap) use, bump the ` +
              `count in ALLOW_LIST in this lint.`,
          );
        }
      }
    }
  }

  // Guard against an allow-list entry going stale (the incidental use was
  // removed) so the allow-list cannot silently over-permit forever.
  for (const [file, hexes] of Object.entries(allowList)) {
    for (const [hex, expected] of Object.entries(hexes)) {
      const actual = occurrencesByFileHex.get(file)?.get(hex)?.length ?? 0;
      if (actual < expected) {
        errors.push(
          `${file}: allow-list expects ${expected} incidental use(s) of #${hex} but found ${actual} — ` +
            `the incidental use was removed or changed; lower (or delete) the entry in ALLOW_LIST.`,
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    filesScanned: files.length,
    occurrences: totalOccurrences,
  };
}

export function cliMain(): number {
  if (process.env.LINT_HEATMAP_COLOR_SKIP === "1") {
    console.log(
      "lint-heatmap-color-lockstep: SKIPPED (LINT_HEATMAP_COLOR_SKIP=1)",
    );
    return 0;
  }

  const result = runLint();

  if (!result.ok) {
    console.error("");
    console.error(
      "✗ lint-heatmap-color-lockstep: a heatmap rank/movement palette hex leaked outside the shared module",
    );
    console.error("");
    console.error(
      `  The rank-band and movement palette lives in ${SOURCE_OF_TRUTH} (Task #2587).`,
    );
    console.error(
      "  Components must import HEATMAP_RANK_COLORS / HEATMAP_MOVEMENT_COLORS /",
    );
    console.error(
      "  HEATMAP_DISTRIBUTION_BAND_COLORS / HEATMAP_UNRANKED_FILL_COLOR / HEATMAP_RANK_LEGEND",
    );
    console.error("  from there — never hardcode the hex:");
    console.error("");
    for (const e of result.errors) {
      console.error(`  - ${e}`);
    }
    console.error("");
    console.error(
      "  Emergency override (intentional palette move in the same change): LINT_HEATMAP_COLOR_SKIP=1.",
    );
    console.error("");
    return 1;
  }

  console.log(
    `lint-heatmap-color-lockstep: OK (${result.filesScanned} files scanned, ` +
      `${result.occurrences} allow-listed incidental palette-hex use(s) accounted for)`,
  );
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("lint-heatmap-color-lockstep.ts");

if (isMain) {
  process.exit(cliMain());
}
