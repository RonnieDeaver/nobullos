/* test-registration
{
  "name": "Radix SelectItem empty-string value guard — clear/none options must use the SELECT_NONE_VALUE sentinel",
  "regression": true,
  "smoke": true,
  "smokeReason": "A single <SelectItem value=\"\"> crashes the entire page at render time (Radix reserves the empty string for clearing the selection and throws), which took down /admin/service-desk/role-assignments. Fast, DB-free, deterministic source scan of client .tsx files.",
  "scanPaths": [
    "client/src"
  ],
  "tier": "small"
}
test-registration */
/**
 * Guard: no client component may render a Radix <SelectItem> with a literal
 * empty-string value. Radix UI throws at render time ("A <Select.Item /> must
 * have a value prop that is not an empty string"), and because SelectContent
 * renders its items into a hidden tree even while the dropdown is closed, one
 * such item takes the whole page down through the error boundary.
 *
 * Pages that keep "" in component state as the "no selection" sentinel must
 * render their None/Clear option with SELECT_NONE_VALUE (from
 * client/src/lib/constants.ts) and map "" <-> SELECT_NONE_VALUE at the Select
 * value/onValueChange boundary, leaving save paths (`state || null`) intact.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const CLIENT_SRC = resolve("client/src");

function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsx(full));
    else if (entry.isFile() && entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

// Matches an opening <SelectItem ...> tag whose value attribute is a literal
// empty string: value="" / value='' / value={""} / value={''} / value={``}.
// [^>] crosses newlines, so multi-line attribute lists are covered, but the
// match can never escape the opening tag itself.
const EMPTY_VALUE_SELECT_ITEM = /<SelectItem\b[^>]*?\bvalue\s*=\s*(?:""|''|\{\s*(?:""|''|``)\s*\})/g;

const files = walkTsx(CLIENT_SRC);
const offenders: string[] = [];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  EMPTY_VALUE_SELECT_ITEM.lastIndex = 0;
  for (let m = EMPTY_VALUE_SELECT_ITEM.exec(src); m; m = EMPTY_VALUE_SELECT_ITEM.exec(src)) {
    const line = src.slice(0, m.index).split("\n").length;
    offenders.push(`${relative(process.cwd(), file)}:${line}`);
  }
}

assert.ok(
  files.length > 100,
  `expected to scan a real client tree under client/src, found only ${files.length} .tsx files — walker is broken`,
);
assert.deepEqual(
  offenders,
  [],
  `Empty-string SelectItem values crash the page at render time (Radix reserves "" for clearing the selection). ` +
    `Use SELECT_NONE_VALUE from client/src/lib/constants.ts and map "" <-> sentinel at the Select boundary. Offenders:\n` +
    offenders.map((o) => `  - ${o}`).join("\n"),
);

// The sentinel itself must stay a non-empty literal — an empty sentinel would
// reintroduce the exact crash everywhere the mapping is used.
const constantsSrc = readFileSync(resolve("client/src/lib/constants.ts"), "utf8");
const sentinel = constantsSrc.match(/export const SELECT_NONE_VALUE = "([^"]+)";/);
assert.ok(
  sentinel && sentinel[1].length > 0,
  "client/src/lib/constants.ts must export a non-empty SELECT_NONE_VALUE string literal",
);

console.log(
  `select-item-empty-value-guard: scanned ${files.length} client .tsx files — no empty-string SelectItem values; sentinel "${sentinel![1]}" intact.`,
);
