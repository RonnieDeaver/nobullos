/* test-registration
{
  "name": "Tailwind v4 bare CSS-variable arbitrary values are banned in client class strings (Task #4001)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Tailwind v4 silently drops the v3 shorthand `x-[--var]` — the property vanishes with no build error, which removed the Select max-height clamp and let long dropdowns grow past the viewport with no way to scroll. Fast, DB-free, deterministic source scan.",
  "scanPaths": [
    "client/src"
  ],
  "tier": "small"
}
test-registration */
/**
 * Guard: Tailwind v4 (this repo: 4.1.16) removed the v3 shorthand that let an
 * arbitrary value reference a CSS variable bare, as in `max-h-[--foo]`. Under
 * v4 that compiles to `max-height: --foo` — an invalid value the browser
 * drops — so the utility silently does nothing. The working forms are
 * `max-h-[var(--foo)]` and the v4 paren shorthand `max-h-(--foo)`.
 *
 * This exact rot removed the height clamp from the shared SelectContent
 * (`max-h-[--radix-select-content-available-height]`), so every long Select
 * dropdown grew past the viewport edge and never became scrollable
 * (Task #4001). Sibling casualties: popover/tooltip/menu/select transform
 * origins, chart tooltip swatch colors, and a popover trigger-width match.
 *
 * Declaration-form arbitrary properties (`[--foo:value]`) remain valid v4
 * syntax for setting a variable and are deliberately not flagged.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SCAN_ROOTS = [resolve("client/src"), resolve("artifacts/mockup-sandbox/src")];
const EXTENSIONS = [".ts", ".tsx", ".css"];

function walkClientSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkClientSources(full));
    else if (entry.isFile() && EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

// Matches a bracketed arbitrary value that starts with a bare CSS variable:
// `[--foo]` or `[--foo,fallback]`. The valid `[var(--foo)]` form opens with
// `v`, so it never matches, and the declaration form `[--foo:value]` is
// excluded because the character class forbids `:` before the closing
// bracket.
const BARE_VAR_ARBITRARY = /\[--[A-Za-z][A-Za-z0-9_-]*(?:,[^\]:\n]*)?\]/g;

const files = SCAN_ROOTS.flatMap((root) => walkClientSources(root));
const offenders: string[] = [];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  BARE_VAR_ARBITRARY.lastIndex = 0;
  for (let m = BARE_VAR_ARBITRARY.exec(src); m; m = BARE_VAR_ARBITRARY.exec(src)) {
    const line = src.slice(0, m.index).split("\n").length;
    offenders.push(`${relative(process.cwd(), file)}:${line}  ${m[0]}`);
  }
}

assert.ok(
  files.length > 100,
  `expected to scan real source trees under client/src and artifacts/mockup-sandbox/src, found only ${files.length} files — walker is broken`,
);
assert.deepEqual(
  offenders,
  [],
  `Tailwind v4 drops bare CSS-variable arbitrary values: \`x-[--foo]\` compiles to the invalid ` +
    `declaration \`x: --foo\` and the browser discards it (this was v3-only shorthand). ` +
    `Write \`x-[var(--foo)]\` (or the v4 paren form \`x-(--foo)\`) instead. Offenders:\n` +
    offenders.map((o) => `  - ${o}`).join("\n"),
);

// The concrete Task #4001 fix: the shared Select popup must keep its
// viewport-height clamp in the var() form. Losing this class reopens the
// original bug — long Select dropdowns overflowing the screen, unscrollable.
for (const selectPath of [
  "client/src/components/ui/select.tsx",
  "artifacts/mockup-sandbox/src/components/ui/select.tsx",
]) {
  const selectSrc = readFileSync(resolve(selectPath), "utf8");
  assert.ok(
    selectSrc.includes("max-h-[var(--radix-select-content-available-height)]"),
    `${selectPath} must clamp SelectContent with max-h-[var(--radix-select-content-available-height)]`,
  );
}

console.log(
  `tailwind-v4-bare-var-class-guard: scanned ${files.length} client + mockup-sandbox source files — no bare [--…] arbitrary values; Select max-height clamps intact.`,
);
