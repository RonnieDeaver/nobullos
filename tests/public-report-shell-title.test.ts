/* test-registration
{
  "name": "Public report shell title guard — client/index.html carries a pre-mount inline script that sets a neutral tab title ('Report') on the client-facing report routes (/share, /preview, /demo-report) before React mounts, while internal routes keep the 'NoBull OS' shell title (Task #4518)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4518: sub-second hermetic check (file read + vm eval, no DB/network/DOM libs). client/index.html sits above React and above the Task #4287 client-copy AST guard's TS/TSX-only scan — this is the ONLY guard that can see the shell title leak. One deleted inline script silently re-exposes the internal product name in every client tab, history entry, and link preview; scanPaths keeps it gate-selected only when the shell changes.",
  "scanPaths": [
    "client/index.html",
    "tests/public-report-shell-title.test.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4518 — the browser tab on client-facing report routes must never
 * show the internal product name, not even for a frame. client/index.html
 * ships `<title>NoBull OS</title>` as the shared shell (internal surfaces
 * pin that deliberately), so the fix is a tiny inline <head> script that
 * swaps in a neutral title ("Report") when location.pathname matches a
 * public report route, before React mounts. PublicReport's title effect
 * then upgrades it to "<Firm> - <Month>", and its initialTitleRef unmount
 * restore captures the neutral value instead of "NoBull OS".
 *
 * This test EXECUTES the actual inline script from index.html (extracted by
 * its Task #4518 marker, run under node:vm with a fake location/document)
 * rather than grepping for it, so a broken regex or a title typo fails just
 * as loudly as a deleted script. The Task #4287 client-copy guard
 * (tests/public-report-client-copy.test.ts) deliberately scans only TS/TSX
 * strings and cannot see index.html — this suite is the shell-side
 * counterpart.
 *
 * Hermetic: filesystem read + vm eval only. No DB, no network.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const ROOT = new URL("..", import.meta.url).pathname;
const html = readFileSync(join(ROOT, "client/index.html"), "utf8");

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// ---------------------------------------------------------------------------
// 1. The shell still titles the app "NoBull OS" for internal surfaces —
//    the fix is route-aware, not a blanket rename (internal tab-title tests
//    pin the internal name).
// ---------------------------------------------------------------------------
assert.ok(
  html.includes("<title>NoBull OS</title>"),
  "client/index.html must keep the internal shell <title>NoBull OS</title> — the public-route fix is route-aware, not a rename",
);
ok("internal shell title unchanged (<title>NoBull OS</title>)");

// ---------------------------------------------------------------------------
// 2. Extract the Task #4518 inline script and execute it per-route.
// ---------------------------------------------------------------------------
const scriptBlocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const titleScript = scriptBlocks.find((s) => s.includes("Task #4518"));
assert.ok(
  titleScript,
  "client/index.html lost the Task #4518 pre-mount title script — client report routes will show 'NoBull OS' in the tab from first paint",
);

function runShellTitleScript(pathname: string): string {
  const doc = { title: "NoBull OS" };
  const context = vm.createContext({ location: { pathname }, document: doc });
  vm.runInContext(titleScript!, context);
  return doc.title;
}

const NEUTRAL = "Report";
const publicPaths = [
  "/share/abc123token",
  "/share/abc123token/print",
  "/preview/42",
  "/preview",
  "/demo-report",
  "/demo-report/",
];
for (const p of publicPaths) {
  assert.equal(
    runShellTitleScript(p),
    NEUTRAL,
    `public report route ${p} must get the neutral pre-mount title ${JSON.stringify(NEUTRAL)} — no frame may show the internal product name`,
  );
}
ok(`public report routes get neutral title ${JSON.stringify(NEUTRAL)} (${publicPaths.length} paths)`);

const internalPaths = [
  "/",
  "/dashboard",
  "/clients",
  "/reports",
  "/sharept",       // prefix must not false-match /share
  "/previews",      // prefix must not false-match /preview
  "/demo-reporting", // prefix must not false-match /demo-report
  "/admin/share",   // public match is path-START anchored
];
for (const p of internalPaths) {
  assert.equal(
    runShellTitleScript(p),
    "NoBull OS",
    `internal route ${p} must keep the shell title "NoBull OS" — the pre-mount script must be anchored to the public route prefixes`,
  );
}
ok(`internal routes keep the shell title (${internalPaths.length} paths, incl. prefix near-misses)`);

// ---------------------------------------------------------------------------
// 3. The neutral title itself carries no internal vocabulary.
// ---------------------------------------------------------------------------
assert.ok(
  !/nobull\s+os/i.test(NEUTRAL),
  "the neutral public-route title must not contain the internal product name",
);
ok("neutral title carries no internal vocabulary");

console.log(`\nTest run complete: ${passed} passed, 0 failed`);
