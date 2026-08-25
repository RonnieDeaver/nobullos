/* test-registration
{
  "name": "Service Desk category parse — en/em/plain-dash split, General fallback, grouping order (Task #3552)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3552: Service Desk category-parse helpers (parseTypeName / groupTypesByCategory) drive the grouped request-type picker. Pure function, DB-free, network-free. Gate it so a dash-variant mis-parse or General-sort regression is caught before it ships.",
  "tier": "small"
}
test-registration */
/**
 * Unit tests for the Service Desk request-type category helpers
 * (parseTypeName / groupTypesByCategory) in client/src/lib/serviceDeskCategories.ts.
 *
 * Covers:
 *  - En-dash split ("GBP / Local SEO – Fix listing")
 *  - Em-dash split ("Billing — Refund request")
 *  - Plain hyphen split ("Ads - Pause campaign")
 *  - No prefix → "General" category, full name as shortLabel
 *  - Bare-hyphenated words inside the label half don't re-split
 *  - stripOptionPrefix strips "Option N" artifacts before parsing
 *  - groupTypesByCategory: General sorted last, others alphabetically
 *  - groupTypesByCategory: single-category list → exactly one group
 *  - groupTypesByCategory: preserves insertion order within each category
 */

import assert from "node:assert/strict";
import {
  parseTypeName,
  groupTypesByCategory,
  stripOptionPrefix,
} from "../../client/src/lib/serviceDeskCategories";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("service-desk-category-parse");

// ── stripOptionPrefix ─────────────────────────────────────────────────────────

test("strips 'Option 1' prefix", () => {
  assert.strictEqual(stripOptionPrefix("Option 1Fulfillment – GBP"), "Fulfillment – GBP");
});

test("strips 'Option 12 ' prefix (with space)", () => {
  assert.strictEqual(stripOptionPrefix("Option 12 Billing – Refund"), "Billing – Refund");
});

test("passes through names without Option prefix unchanged", () => {
  assert.strictEqual(stripOptionPrefix("GBP / Local SEO – Fix listing"), "GBP / Local SEO – Fix listing");
});

// ── parseTypeName — dash variants ─────────────────────────────────────────────

test("en-dash split: 'GBP / Local SEO – Fix listing'", () => {
  const r = parseTypeName("GBP / Local SEO – Fix listing");
  assert.strictEqual(r.category, "GBP / Local SEO");
  assert.strictEqual(r.shortLabel, "Fix listing");
});

test("em-dash split: 'Billing — Refund request'", () => {
  const r = parseTypeName("Billing — Refund request");
  assert.strictEqual(r.category, "Billing");
  assert.strictEqual(r.shortLabel, "Refund request");
});

test("plain hyphen split: 'Ads - Pause campaign'", () => {
  const r = parseTypeName("Ads - Pause campaign");
  assert.strictEqual(r.category, "Ads");
  assert.strictEqual(r.shortLabel, "Pause campaign");
});

test("multi-word category: 'Google Ads / LSA – Review hygiene'", () => {
  const r = parseTypeName("Google Ads / LSA – Review hygiene");
  assert.strictEqual(r.category, "Google Ads / LSA");
  assert.strictEqual(r.shortLabel, "Review hygiene");
});

// ── parseTypeName — no prefix ─────────────────────────────────────────────────

test("no prefix → General category, full name as shortLabel", () => {
  const r = parseTypeName("Onboarding call");
  assert.strictEqual(r.category, "General");
  assert.strictEqual(r.shortLabel, "Onboarding call");
});

test("completely empty string → General category, empty shortLabel", () => {
  const r = parseTypeName("");
  assert.strictEqual(r.category, "General");
  assert.strictEqual(r.shortLabel, "");
});

// ── parseTypeName — bare-hyphenated words in the label half ──────────────────

test("hyphenated word inside label half does NOT re-split", () => {
  // "follow-up" is in the label portion — requires the first dash to have
  // spaces on both sides, so internal hyphens are safe.
  const r = parseTypeName("GBP – Follow-up audit");
  assert.strictEqual(r.category, "GBP");
  assert.strictEqual(r.shortLabel, "Follow-up audit");
});

test("bare-hyphenated name with no spaced dash → General", () => {
  // "Re-onboarding" has no spaced dash, so it lands in General.
  const r = parseTypeName("Re-onboarding");
  assert.strictEqual(r.category, "General");
  assert.strictEqual(r.shortLabel, "Re-onboarding");
});

// ── parseTypeName — Option prefix + dash ─────────────────────────────────────

test("Option prefix stripped before dash-parse", () => {
  const r = parseTypeName("Option 3 GBP / Local SEO – Claim listing");
  assert.strictEqual(r.category, "GBP / Local SEO");
  assert.strictEqual(r.shortLabel, "Claim listing");
});

// ── groupTypesByCategory ──────────────────────────────────────────────────────

function rt(name: string, id = name) {
  return { id, name };
}

test("groups types by parsed category", () => {
  const types = [
    rt("GBP – Fix listing"),
    rt("GBP – Claim listing"),
    rt("Billing – Refund"),
  ];
  const groups = groupTypesByCategory(types);
  assert.strictEqual(groups.length, 2);
  const gbp = groups.find((g) => g.category === "GBP");
  assert.ok(gbp, "GBP group exists");
  assert.strictEqual(gbp!.items.length, 2);
  assert.strictEqual(gbp!.items[0].shortLabel, "Fix listing");
  assert.strictEqual(gbp!.items[1].shortLabel, "Claim listing");
});

test("General group is sorted last even if it appears first in input", () => {
  const types = [
    rt("Onboarding call"),
    rt("Ads – Pause campaign"),
    rt("GBP – Fix listing"),
  ];
  const groups = groupTypesByCategory(types);
  assert.strictEqual(groups[groups.length - 1].category, "General");
});

test("non-General categories are sorted alphabetically", () => {
  const types = [
    rt("Zoom – Recording"),
    rt("Ads – Pause"),
    rt("Billing – Refund"),
  ];
  const groups = groupTypesByCategory(types);
  const names = groups.map((g) => g.category);
  assert.deepStrictEqual(names, ["Ads", "Billing", "Zoom"]);
});

test("single-category list produces exactly one group", () => {
  const types = [rt("GBP – Fix listing"), rt("GBP – Claim listing"), rt("GBP – Add photo")];
  const groups = groupTypesByCategory(types);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].category, "GBP");
  assert.strictEqual(groups[0].items.length, 3);
});

test("empty list → empty groups", () => {
  const groups = groupTypesByCategory([]);
  assert.strictEqual(groups.length, 0);
});

test("preserves insertion order within a category", () => {
  const types = [
    rt("GBP – C"),
    rt("GBP – A"),
    rt("GBP – B"),
  ];
  const groups = groupTypesByCategory(types);
  assert.deepStrictEqual(
    groups[0].items.map((i) => i.shortLabel),
    ["C", "A", "B"],
  );
});

console.log(`\nservice-desk-category-parse: ${passed} test(s) passed`);
