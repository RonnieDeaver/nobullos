/* test-registration
{
  "name": "Comms search modifier parser — terms, phrases, exclusions, from:/in:/before:/after:/on:, date normalization, error cases (Task #3298)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3298: comms search modifier parser — pure-logic module (no DB, no network); covers terms/phrases/exclusions, all five modifiers (from:/in:/before:/after:/on:), date normalization, and error cases. Fast and deterministic — ideal smoke gating so parser regressions surface on every routine validation run, not just the full suite.",
  "notes": "Was also registered a second time (pre-#3786 duplicate; the file ran twice) as: \"Comms search modifier parser — plain terms, quoted phrases, excluded terms, from/in/before/after/on modifiers, date normalization, combinations (Task #3261)\".",
  "tier": "small"
}
test-registration */
/**
 * Unit tests for the shared comms search modifier parser.
 *
 * Covers: plain terms, quoted phrases, excluded terms, all five modifiers
 * (from:, in:, before:, after:, on:), date normalization, combinations, and
 * error cases.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSearchQuery } from "../shared/commsSearchParser.ts";

describe("parseSearchQuery", () => {
  it("parses plain terms", () => {
    const r = parseSearchQuery("hello world");
    assert.deepEqual(r.modifiers.terms, ["hello", "world"]);
    assert.equal(r.ftsQuery, "hello world");
    assert.deepEqual(r.modifiers.excluded, []);
    assert.deepEqual(r.errors, []);
  });

  it("parses a quoted phrase", () => {
    const r = parseSearchQuery('"exact phrase"');
    assert.deepEqual(r.modifiers.phrases, ["exact phrase"]);
    assert.equal(r.modifiers.terms.length, 0);
    assert.equal(r.ftsQuery, '"exact phrase"');
  });

  it("combines plain terms and quoted phrase in ftsQuery", () => {
    const r = parseSearchQuery('meeting "follow up"');
    assert.deepEqual(r.modifiers.terms, ["meeting"]);
    assert.deepEqual(r.modifiers.phrases, ["follow up"]);
    assert.equal(r.ftsQuery, 'meeting "follow up"');
  });

  it("parses excluded terms with -", () => {
    const r = parseSearchQuery("report -spam -draft");
    assert.deepEqual(r.modifiers.terms, ["report"]);
    assert.deepEqual(r.modifiers.excluded, ["spam", "draft"]);
    assert.equal(r.ftsQuery, "report");
  });

  it("parses from: modifier (strips leading @)", () => {
    const r = parseSearchQuery("from:@alice meeting");
    assert.equal(r.modifiers.fromUsername, "alice");
    assert.deepEqual(r.modifiers.terms, ["meeting"]);
    assert.equal(r.ftsQuery, "meeting");
  });

  it("parses from: modifier without @", () => {
    const r = parseSearchQuery("from:bob hello");
    assert.equal(r.modifiers.fromUsername, "bob");
    assert.deepEqual(r.modifiers.terms, ["hello"]);
  });

  it("parses in: modifier (strips leading #)", () => {
    const r = parseSearchQuery("in:#general keyword");
    assert.equal(r.modifiers.inChannelSlug, "general");
    assert.deepEqual(r.modifiers.terms, ["keyword"]);
  });

  it("parses in: modifier without #", () => {
    const r = parseSearchQuery("in:marketing report");
    assert.equal(r.modifiers.inChannelSlug, "marketing");
    assert.deepEqual(r.modifiers.terms, ["report"]);
  });

  it("parses before: with ISO date", () => {
    const r = parseSearchQuery("before:2026-01-15 hello");
    assert.equal(r.modifiers.before, "2026-01-15");
    assert.deepEqual(r.errors, []);
  });

  it("parses after: with ISO date", () => {
    const r = parseSearchQuery("after:2025-12-01 topic");
    assert.equal(r.modifiers.after, "2025-12-01");
    assert.deepEqual(r.errors, []);
  });

  it("parses after: with slash date MM/DD/YYYY", () => {
    const r = parseSearchQuery("after:01/15/2026");
    assert.equal(r.modifiers.after, "2026-01-15");
    assert.deepEqual(r.errors, []);
  });

  it("parses before: with slash date M/D/YYYY", () => {
    const r = parseSearchQuery("before:1/5/2026");
    assert.equal(r.modifiers.before, "2026-01-05");
    assert.deepEqual(r.errors, []);
  });

  it("on: sets both after and before (next day)", () => {
    const r = parseSearchQuery("on:2026-03-10 meeting");
    assert.equal(r.modifiers.on, "2026-03-10");
    assert.equal(r.modifiers.after, "2026-03-10");
    assert.equal(r.modifiers.before, "2026-03-11");
    assert.deepEqual(r.errors, []);
  });

  it("on: handles end-of-month correctly", () => {
    const r = parseSearchQuery("on:2026-01-31");
    assert.equal(r.modifiers.on, "2026-01-31");
    assert.equal(r.modifiers.before, "2026-02-01");
  });

  it("returns error for invalid date in before:", () => {
    const r = parseSearchQuery("before:notadate hello");
    assert.ok(r.errors.some((e) => e.includes("before")));
    assert.equal(r.modifiers.before, undefined);
  });

  it("returns error for invalid date in after:", () => {
    const r = parseSearchQuery("after:01-15-2026");
    assert.ok(r.errors.some((e) => e.includes("after")));
  });

  it("returns error for invalid date in on:", () => {
    const r = parseSearchQuery("on:tomorrow");
    assert.ok(r.errors.some((e) => e.includes("on")));
  });

  it("parses complex combination", () => {
    const r = parseSearchQuery('from:alice in:#general "status update" -draft after:2026-01-01');
    assert.equal(r.modifiers.fromUsername, "alice");
    assert.equal(r.modifiers.inChannelSlug, "general");
    assert.deepEqual(r.modifiers.phrases, ["status update"]);
    assert.deepEqual(r.modifiers.excluded, ["draft"]);
    assert.equal(r.modifiers.after, "2026-01-01");
    assert.equal(r.ftsQuery, '"status update"');
    assert.deepEqual(r.errors, []);
  });

  it("ignores standalone - (not an exclusion)", () => {
    const r = parseSearchQuery("hello - world");
    assert.deepEqual(r.modifiers.excluded, []);
    assert.deepEqual(r.modifiers.terms, ["hello", "world"]);
  });

  it("handles empty string", () => {
    const r = parseSearchQuery("");
    assert.deepEqual(r.modifiers.terms, []);
    assert.equal(r.ftsQuery, "");
    assert.deepEqual(r.errors, []);
  });

  it("raw field preserves original input", () => {
    const input = 'from:alice "status update" -draft';
    const r = parseSearchQuery(input);
    assert.equal(r.raw, input);
  });

  it("handles multiple phrases", () => {
    const r = parseSearchQuery('"first phrase" "second phrase"');
    assert.deepEqual(r.modifiers.phrases, ["first phrase", "second phrase"]);
    assert.equal(r.ftsQuery, '"first phrase" "second phrase"');
  });

  it("unknown modifier-looking token treated as plain term", () => {
    const r = parseSearchQuery("subject:hello world");
    assert.deepEqual(r.modifiers.terms, ["subject:hello", "world"]);
  });
});
