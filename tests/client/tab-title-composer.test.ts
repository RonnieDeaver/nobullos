/* test-registration
{
  "name": "Browser tab title composer — zero/one/both counts, page-title interplay, 99+ cap (Task #3353)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3353: the tab-title composer is a pure function (no DB, no network) consumed by GlobalTitleManager on every page. Gate it so a formatting or cap regression (e.g. wrong badge order, missing zero-suppression, broken 99+ threshold) is caught before it ships.",
  "tier": "small"
}
test-registration */
/**
 * Unit tests for the browser-tab title composer (Task #3353).
 *
 * Covers:
 *  - Zero counts: plain title, no badges.
 *  - Bell only: one badge prefixed.
 *  - Chat only: one badge prefixed.
 *  - Both counts: bell first, chat second.
 *  - Page-title interplay: titled page gets " — NoBull OS" suffix after badges.
 *  - Root page (empty string): resolves to "NoBull OS" with/without badges.
 *  - 99+ cap: counts above 99 display as "(99+)".
 *  - Exactly 99: displays as "(99)" not "(99+)".
 *  - Zero suppressed: a zero count produces no badge group at all.
 */

import assert from "node:assert/strict";
import { composeTitleWithCounts, formatCountBadge, TITLE_CAP } from "../../client/src/lib/titleComposer";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("tab-title composer");

// ── formatCountBadge ─────────────────────────────────────────────────────────

test("formatCountBadge: 0 → empty string", () => {
  assert.strictEqual(formatCountBadge(0), "");
});

test("formatCountBadge: negative → empty string", () => {
  assert.strictEqual(formatCountBadge(-5), "");
});

test("formatCountBadge: 1 → (1)", () => {
  assert.strictEqual(formatCountBadge(1), "(1)");
});

test("formatCountBadge: 99 → (99)", () => {
  assert.strictEqual(formatCountBadge(TITLE_CAP), `(${TITLE_CAP})`);
});

test("formatCountBadge: 100 → (99+)", () => {
  assert.strictEqual(formatCountBadge(100), "(99+)");
});

test("formatCountBadge: very large number → (99+)", () => {
  assert.strictEqual(formatCountBadge(9999), "(99+)");
});

// ── composeTitleWithCounts — zero counts ─────────────────────────────────────

test("both zero, no page title → 'NoBull OS'", () => {
  assert.strictEqual(composeTitleWithCounts("", 0, 0), "NoBull OS");
});

test("both zero, with page title → 'Clients — NoBull OS'", () => {
  assert.strictEqual(composeTitleWithCounts("Clients", 0, 0), "Clients — NoBull OS");
});

// ── composeTitleWithCounts — bell only ───────────────────────────────────────

test("bell=3, chat=0, no page title → '(3) NoBull OS'", () => {
  assert.strictEqual(composeTitleWithCounts("", 3, 0), "(3) NoBull OS");
});

test("bell=3, chat=0, page title → '(3) Clients — NoBull OS'", () => {
  assert.strictEqual(composeTitleWithCounts("Clients", 3, 0), "(3) Clients — NoBull OS");
});

// ── composeTitleWithCounts — chat only ───────────────────────────────────────

test("bell=0, chat=5, no page title → '(5) NoBull OS'", () => {
  assert.strictEqual(composeTitleWithCounts("", 0, 5), "(5) NoBull OS");
});

test("bell=0, chat=5, page title → '(5) Comms — NoBull OS'", () => {
  assert.strictEqual(composeTitleWithCounts("Comms", 0, 5), "(5) Comms — NoBull OS");
});

// ── composeTitleWithCounts — both counts ─────────────────────────────────────

test("bell=2, chat=5, no page title → '(2) (5) NoBull OS'", () => {
  assert.strictEqual(composeTitleWithCounts("", 2, 5), "(2) (5) NoBull OS");
});

test("bell=2, chat=5, page title → '(2) (5) Clients — NoBull OS'", () => {
  assert.strictEqual(composeTitleWithCounts("Clients", 2, 5), "(2) (5) Clients — NoBull OS");
});

// ── composeTitleWithCounts — 99+ cap ─────────────────────────────────────────

test("bell=100, chat=0 → '(99+) NoBull OS'", () => {
  assert.strictEqual(composeTitleWithCounts("", 100, 0), "(99+) NoBull OS");
});

test("bell=0, chat=200 → '(99+) NoBull OS'", () => {
  assert.strictEqual(composeTitleWithCounts("", 0, 200), "(99+) NoBull OS");
});

test("bell=999, chat=999, page title → '(99+) (99+) Dashboard — NoBull OS'", () => {
  assert.strictEqual(
    composeTitleWithCounts("Dashboard", 999, 999),
    "(99+) (99+) Dashboard — NoBull OS",
  );
});

// ── composeTitleWithCounts — exactly 99 ──────────────────────────────────────

test("bell=99, chat=99, page title → '(99) (99) Page — NoBull OS'", () => {
  assert.strictEqual(
    composeTitleWithCounts("Page", 99, 99),
    "(99) (99) Page — NoBull OS",
  );
});

console.log(`\n${passed} tests passed`);
