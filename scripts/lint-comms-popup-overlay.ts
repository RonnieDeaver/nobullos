/**
 * Drift guard: no new clipped hand-rolled overlay menus inside comms popup
 * surfaces (Task #3364, guarding the Task #3347 consolidation).
 *
 * Background
 * ----------
 * CommsPopupManager renders 300px-tall popup windows with `overflow-hidden`.
 * Any interactive overlay panel rendered INSIDE that subtree with the old
 * hand-rolled `absolute … z-50` pattern gets clipped (the Task #3332/#3347 bug
 * class). Task #3347 removed the last such overlay and introduced
 * `AnchoredPortalPanel` (client/src/components/comms/EmojiPicker.tsx), which
 * portals panels to document.body with `fixed` positioning so they can never
 * be clipped. A DOM-level structural guard exists (section G of
 * tests/client/emoji-panel-popup-clipping.test.tsx) but it only exercises the
 * popup variants that test mounts. A NEW comms surface (thread popup, call
 * panel, future picker) could re-introduce a clipped absolute overlay without
 * failing it.
 *
 * What this lint asserts
 * ----------------------
 *   No `className` under client/src/components/comms/ combines `absolute`
 *   positioning with a high z-index (z-40, z-50, or z-[N] with N >= 40) —
 *   the signature of a hand-rolled overlay panel. Overlay panels must use
 *   `AnchoredPortalPanel` (fixed + portaled) instead. Low-z absolute
 *   decorations (badges, hover toolbars at z-10/z-20, input icons) are fine
 *   and out of scope, mirroring the DOM guard's z-threshold.
 *
 * Detection granularity
 * ---------------------
 * The scan captures each full `className` attribute value — including
 * multi-line `cn(...)` / template-literal expressions — so splitting
 * `absolute` and `z-50` across two string fragments of the same attribute
 * still trips the guard. It cannot see a class list assembled across separate
 * variables; the DOM-level section-G guard backstops that for mounted popups.
 *
 * Allow-list
 * ----------
 * Documented benign sites get an (file -> exact count) entry. Currently: the
 * skin-tone flyout inside EmojiPicker's own panel — that panel is ALREADY
 * portaled/fixed via the picker itself, so an absolute child within it cannot
 * be clipped by a popup. The count is exact so a NEW occurrence in the same
 * file still trips the guard.
 *
 * Exit code:
 *   0 — no hand-rolled high-z absolute overlay outside the allow-list.
 *   1 — drift detected; the message names the offending file/line.
 *
 * Emergency escape hatch:
 *   Set LINT_COMMS_POPUP_OVERLAY_SKIP=1 to skip entirely. Use only when you
 *   are intentionally adding a documented allow-list entry in the same change.
 */
import { readFileSync } from "node:fs";
import {
  isScannablePath,
  listTrackedFiles,
  walkDir,
} from "./lintFileDiscovery";

/** The directory whose components render inside comms popup surfaces. */
const COMMS_DIR = "client/src/components/comms/";

/**
 * Documented benign sites: (relative file) -> exact expected count of
 * absolute+high-z className attributes. See file header.
 */
const ALLOW_LIST: Readonly<Record<string, number>> = {
  // Skin-tone flyout inside the EmojiPicker panel — the panel itself is
  // portaled to document.body (fixed) by the picker, so this absolute child
  // can never be clipped by a popup's overflow-hidden.
  "client/src/components/comms/EmojiPicker.tsx": 1,
};

const SCAN_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];

function isCommsScannable(file: string): boolean {
  const rel = file.replace(/\\/g, "/");
  if (rel.includes(".test.")) return false;
  return SCAN_EXTENSIONS.some((ext) => rel.endsWith(ext));
}

/** `absolute` as a standalone Tailwind class token. */
const ABSOLUTE_RE = /(^|[\s"'`])absolute([\s"'`]|$)/;
/** z-40, z-50, or arbitrary z-[N]; N checked separately for the >= 40 rule. */
const Z_TOKEN_RE = /\bz-(40|50|\[(\d+)\])(?![\w-])/g;

function hasHighZ(text: string): boolean {
  Z_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = Z_TOKEN_RE.exec(text)) !== null) {
    if (m[2] === undefined) return true; // z-40 / z-50
    if (parseInt(m[2], 10) >= 40) return true; // z-[N]
  }
  return false;
}

/**
 * Capture the full value of each `className` attribute, including multi-line
 * `{cn(...)}` expressions, returning the chunk text and its 1-based start line.
 */
export function extractClassNameChunks(
  source: string,
): Array<{ text: string; line: number }> {
  const chunks: Array<{ text: string; line: number }> = [];
  const attrRe = /className\s*=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(source)) !== null) {
    const start = m.index + m[0].length;
    const line = source.slice(0, m.index).split("\n").length;
    const open = source[start];
    if (open === '"' || open === "'") {
      const end = source.indexOf(open, start + 1);
      if (end === -1) continue;
      chunks.push({ text: source.slice(start + 1, end), line });
    } else if (open === "{") {
      // Balanced-brace scan; treat string/template contents opaquely enough
      // for brace counting (braces inside plain strings are rare in class
      // lists, and template `${}` braces still balance).
      let depth = 0;
      let i = start;
      let inStr: string | null = null;
      for (; i < source.length; i += 1) {
        const ch = source[i];
        const prev = source[i - 1];
        if (inStr) {
          if (ch === inStr && prev !== "\\") inStr = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          inStr = ch;
          continue;
        }
        if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (depth === 0) chunks.push({ text: source.slice(start + 1, i), line });
    }
  }
  return chunks;
}

interface LintResult {
  ok: boolean;
  errors: string[];
  filesScanned: number;
  occurrences: number;
}

/**
 * Optional overrides so the guard can be unit-tested against a temp fixture
 * tree. Production callers (the CLI below) pass nothing.
 */
export interface LintOptions {
  /** Fixture mode: walk these directories instead of `git ls-files`. */
  scanDirs?: string[];
  /** (relative file -> exact count) allow-list (defaults to ALLOW_LIST). */
  allowList?: Readonly<Record<string, number>>;
}

export function runLint(opts: LintOptions = {}): LintResult {
  const allowList = opts.allowList ?? ALLOW_LIST;
  const errors: string[] = [];
  const files: string[] = [];

  if (opts.scanDirs) {
    for (const dir of opts.scanDirs) walkDir(dir, files, isCommsScannable);
  } else {
    for (const f of listTrackedFiles()) {
      const rel = f.replace(/\\/g, "/");
      if (rel.startsWith(COMMS_DIR) && isScannablePath(f) && isCommsScannable(f)) {
        files.push(f);
      }
    }
  }

  let totalOccurrences = 0;
  const countByFile = new Map<string, Array<number>>();

  for (const file of files) {
    const rel = file.replace(/\\/g, "/");
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      errors.push(`could not read ${rel}: ${(err as Error).message}`);
      continue;
    }
    for (const chunk of extractClassNameChunks(text)) {
      if (ABSOLUTE_RE.test(chunk.text) && hasHighZ(chunk.text)) {
        totalOccurrences += 1;
        const arr = countByFile.get(rel) ?? [];
        arr.push(chunk.line);
        countByFile.set(rel, arr);
      }
    }
  }

  for (const [file, lines] of Array.from(countByFile)) {
    const allowed = allowList[file] ?? 0;
    if (lines.length > allowed) {
      const lineList = lines.join(", ");
      if (allowed === 0) {
        errors.push(
          `${file}: hand-rolled overlay pattern (absolute + z>=40 className) at line(s) ${lineList} — ` +
            `inside CommsPopupManager's overflow-hidden popups this gets clipped. Render the panel via ` +
            `AnchoredPortalPanel (client/src/components/comms/EmojiPicker.tsx) instead.`,
        );
      } else {
        errors.push(
          `${file}: ${lines.length} absolute+high-z className(s) at line(s) ${lineList}, but only ` +
            `${allowed} documented benign use(s) are allow-listed — a NEW occurrence appeared. Use ` +
            `AnchoredPortalPanel, or (only if provably un-clippable) document it in ALLOW_LIST in this lint.`,
        );
      }
    }
  }

  // Stale allow-list detection so it can't silently over-permit forever.
  for (const [file, expected] of Object.entries(allowList)) {
    const actual = countByFile.get(file)?.length ?? 0;
    if (actual < expected) {
      errors.push(
        `${file}: allow-list expects ${expected} benign absolute+high-z use(s) but found ${actual} — ` +
          `the benign use was removed or changed; lower (or delete) the entry in ALLOW_LIST.`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    filesScanned: files.length,
    occurrences: totalOccurrences,
  };
}

function main(): void {
  if (process.env.LINT_COMMS_POPUP_OVERLAY_SKIP === "1") {
    console.log(
      "lint-comms-popup-overlay: SKIPPED (LINT_COMMS_POPUP_OVERLAY_SKIP=1)",
    );
    process.exit(0);
  }

  const result = runLint();

  if (!result.ok) {
    console.error("");
    console.error(
      "✗ lint-comms-popup-overlay: a hand-rolled absolute+high-z overlay panel appeared under client/src/components/comms/",
    );
    console.error("");
    console.error(
      "  CommsPopupManager popups are 300px overflow-hidden windows; absolute z>=40 overlays inside",
    );
    console.error(
      "  them get clipped (the Task #3332/#3347 bug class). Use AnchoredPortalPanel instead:",
    );
    console.error("");
    for (const e of result.errors) {
      console.error(`  - ${e}`);
    }
    console.error("");
    console.error(
      "  Emergency override (documented benign addition in the same change): LINT_COMMS_POPUP_OVERLAY_SKIP=1.",
    );
    console.error("");
    process.exit(1);
  }

  console.log(
    `lint-comms-popup-overlay: OK (${result.filesScanned} comms files scanned, ` +
      `${result.occurrences} allow-listed benign absolute+high-z use(s) accounted for)`,
  );
  process.exit(0);
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("lint-comms-popup-overlay.ts");

if (isMain) {
  main();
}
