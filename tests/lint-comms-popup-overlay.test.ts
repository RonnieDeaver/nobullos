/* test-registration
{
  "name": "lint-comms-popup-overlay guard (Task #3364)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3364: the comms popup-overlay drift guard. Its first assertion runs the lint over the REAL client/src/components/comms/ tree, so any NEW hand-rolled `absolute + z>=40` overlay panel in a comms component (the clipped-menu bug class of Tasks #3332/#3347) fails the routine gate even for popup variants the DOM-level section-G guard never mounts. The managed Long validation workflow runs the reviewed routine-gate profile, including this SMOKE_FILES coverage. Fast, DB-free, deterministic (source scan + tmpdir fixtures).",
  "tier": "small"
}
test-registration */
/**
 * Task #3364 — Regression test for the comms popup overlay drift guard.
 *
 * The guard (scripts/lint-comms-popup-overlay.ts) fails if any className
 * under client/src/components/comms/ combines `absolute` positioning with a
 * high z-index (z-40 / z-50 / z-[N>=40]) — the hand-rolled overlay pattern
 * that gets clipped inside CommsPopupManager's 300px overflow-hidden popups
 * (the Task #3332/#3347 bug class). Overlay panels must use
 * AnchoredPortalPanel instead. The DOM-level section-G guard in
 * tests/client/emoji-panel-popup-clipping.test.tsx only covers the popup
 * variants that test mounts; this source-level lint covers EVERY comms
 * component, including future popup surfaces.
 *
 * Proves:
 *   1. The REAL comms tree passes (only the documented EmojiPicker skin-tone
 *      flyout is allow-listed, at its exact count).
 *   2. A single-string `absolute … z-50` className is flagged with file+line.
 *   3. A multi-line cn(...) attribute splitting `absolute` and `z-50` across
 *      string fragments is still flagged.
 *   4. Low-z absolute decorations (z-10 hover toolbar) and fixed+z-50
 *      (AnchoredPortalPanel's own pattern) are NOT flagged.
 *   5. z-[45] arbitrary value >= 40 is flagged; z-[30] is not.
 *   6. Allow-list exact-count: passes at exactly N, a NEW (N+1th) occurrence
 *      trips the guard, and a stale allow-list entry (fewer than N) also fails.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint } from "../scripts/lint-comms-popup-overlay";

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

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lint-comms-popup-overlay-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeFile(root: string, rel: string, lines: string[]): string {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, lines.join("\n") + "\n");
  return full.replace(/\\/g, "/");
}

// 1. The REAL comms tree passes the guard.
{
  const res = runLint();
  if (!res.ok) for (const e of res.errors) console.error(`    error: ${e}`);
  assert(res.ok, "real comms tree passes the popup-overlay guard");
  assert(res.filesScanned > 0, "the guard actually scanned comms files");
  assert(
    res.occurrences === 1,
    "exactly the one documented EmojiPicker benign use is accounted for",
  );
}

// 2. A single-string absolute+z-50 className is flagged with file + line.
{
  const { root, cleanup } = fixture();
  try {
    const file = writeFile(root, "comms/ThreadPopupMenu.tsx", [
      "export function ThreadPopupMenu() {",
      "  return (",
      '    <div className="absolute right-0 top-8 bg-popover border z-50">',
      "      <button>Reply</button>",
      "    </div>",
      "  );",
      "}",
    ]);
    const res = runLint({ scanDirs: [root], allowList: {} });
    assert(!res.ok, "a hand-rolled absolute+z-50 overlay trips the guard");
    assert(
      res.errors.some((e) => e.includes(file) && e.includes("line(s) 3")),
      "the offending file and line are named in the error",
    );
    assert(
      res.errors.some((e) => e.includes("AnchoredPortalPanel")),
      "the error points the author at AnchoredPortalPanel",
    );
  } finally {
    cleanup();
  }
}

// 3. Multi-line cn(...) splitting absolute and z-50 is still flagged.
{
  const { root, cleanup } = fixture();
  try {
    const file = writeFile(root, "comms/CallPanelMenu.tsx", [
      'import { cn } from "@/lib/utils";',
      "export function CallPanelMenu({ open }: { open: boolean }) {",
      "  return (",
      "    <div",
      "      className={cn(",
      '        "absolute right-0 top-8 bg-popover border",',
      '        open && "z-50 shadow-xl",',
      "      )}",
      "    />",
      "  );",
      "}",
    ]);
    const res = runLint({ scanDirs: [root], allowList: {} });
    assert(
      !res.ok,
      "absolute and z-50 split across cn() fragments still trips the guard",
    );
    assert(
      res.errors.some((e) => e.includes(file)),
      "the multi-line offender file is named",
    );
  } finally {
    cleanup();
  }
}

// 4. Low-z absolute decorations and fixed+z-50 portals are NOT flagged.
{
  const { root, cleanup } = fixture();
  try {
    writeFile(root, "comms/BenignBits.tsx", [
      "export function BenignBits() {",
      "  return (",
      "    <>",
      // hover toolbar — row decoration, z-10
      '      <div className="absolute right-2 top-0 z-10"><button>React</button></div>',
      // notification badge — absolute, no z at all
      '      <span className="absolute -top-1 -right-1 h-5 w-5 rounded-full" />',
      // AnchoredPortalPanel-style portaled panel — fixed, not absolute
      '      <div className="fixed z-50 bg-popover border rounded-xl" />',
      "    </>",
      "  );",
      "}",
    ]);
    const res = runLint({ scanDirs: [root], allowList: {} });
    assert(
      res.ok,
      "low-z absolute decorations and fixed+z-50 portals are not flagged",
    );
    assert(res.occurrences === 0, "no occurrences counted for benign file");
  } finally {
    cleanup();
  }
}

// 5. Arbitrary z values: z-[45] flagged, z-[30] not.
{
  const { root, cleanup } = fixture();
  try {
    writeFile(root, "comms/ArbitraryZ.tsx", [
      "export function ArbitraryZ() {",
      "  return (",
      "    <>",
      '      <div className="absolute top-0 z-[45]" />',
      '      <div className="absolute top-0 z-[30]" />',
      "    </>",
      "  );",
      "}",
    ]);
    const res = runLint({ scanDirs: [root], allowList: {} });
    assert(!res.ok, "absolute + z-[45] (>= 40) trips the guard");
    assert(
      res.occurrences === 1,
      "absolute + z-[30] (< 40) is not counted — only the z-[45] one is",
    );
  } finally {
    cleanup();
  }
}

// 6. Allow-list exact-count: N passes, N+1 trips, stale entry fails.
{
  const { root, cleanup } = fixture();
  try {
    const file = writeFile(root, "comms/Documented.tsx", [
      "export function Documented() {",
      '  return <div className="absolute top-8 z-50" />;',
      "}",
    ]);
    const okRes = runLint({ scanDirs: [root], allowList: { [file]: 1 } });
    assert(okRes.ok, "exactly the allow-listed count passes");

    writeFile(root, "comms/Documented.tsx", [
      "export function Documented() {",
      "  return (",
      "    <>",
      '      <div className="absolute top-8 z-50" />',
      '      <div className="absolute top-8 z-50" />',
      "    </>",
      "  );",
      "}",
    ]);
    const driftRes = runLint({ scanDirs: [root], allowList: { [file]: 1 } });
    assert(
      !driftRes.ok,
      "a NEW occurrence in an allow-listed file still trips the guard",
    );

    writeFile(root, "comms/Documented.tsx", [
      "export function Documented() {",
      "  return <div />;",
      "}",
    ]);
    const staleRes = runLint({ scanDirs: [root], allowList: { [file]: 1 } });
    assert(
      !staleRes.ok,
      "a stale allow-list entry (benign use removed) fails the guard",
    );
    assert(
      staleRes.errors.some((e) => e.includes("lower (or delete)")),
      "the stale-entry error tells the author to shrink the allow-list",
    );
  } finally {
    cleanup();
  }
}

console.log(`\n  passed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exit(1);
