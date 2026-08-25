/* test-registration
{
  "name": "Front email thread composition (baseline triage, Task #3424)",
  "smoke": true,
  "smokeReason": "Task #2963: the shared composeEmailThreadTextFromSiblings helper (canonical implementation for both the detail route and the AI analysis path) and the exported buildAnalysisContent function (drift guard + composedContent override). A rename or removal of either export would silently break the drift contract and leave rollup rows with empty AI analysis content. Fast, pure, DB-free (pure function + import assertions only).",
  "tier": "small"
}
test-registration */
/**
 * Task #2963 — Verify the shared email-thread composition helper and the
 * AI analysis fallback for empty email_thread rollup rows.
 *
 * Tests:
 * 1. composeEmailThreadTextFromSiblings — siblings with body → composed string
 * 2. composeEmailThreadTextFromSiblings — siblings without body → null
 * 3. composeEmailThreadTextFromSiblings — empty array → null
 * 4. buildAnalysisContent — composedContent overrides empty contentText
 * 5. buildAnalysisContent — rollup with its own content unchanged by composedContent=null
 * 6. buildAnalysisContent — fallback to "(no content available)" when both null
 * 7. Drift guard — route and analysis both import from communicationStorage
 */

import assert from "node:assert/strict";

import { composeEmailThreadTextFromSiblings } from "../server/storage/communicationStorage";
import { buildAnalysisContent, warnIfUncomposableRollup } from "../server/services/communicationAnalysis";

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

// ── 1. Siblings with body → composed non-null string ──
{
  const siblings = [
    {
      direction: "inbound" as const,
      participantsJson: [{ email: "alice@lawfirm.test", role: "external" }],
      timestamp: new Date("2026-01-15T09:30:00Z"),
      contentText: "Hello, we need to discuss the case.",
    },
    {
      direction: "outbound" as const,
      participantsJson: [{ email: "rep@agency.test", role: "teammate" }],
      timestamp: new Date("2026-01-15T10:00:00Z"),
      contentText: "Absolutely, let me pull up the details.",
    },
  ];
  const result = composeEmailThreadTextFromSiblings(siblings);
  assert.ok(result !== null, "should return non-null with body-bearing siblings");
  assert.ok(result!.includes("Hello, we need to discuss"), "contains first message body");
  assert.ok(result!.includes("Absolutely, let me pull up"), "contains second message body");
  assert.ok(result!.includes("Inbound"), "labels inbound direction");
  assert.ok(result!.includes("Outbound"), "labels outbound direction");
  assert.ok(result!.includes("alice@lawfirm.test"), "includes participant email");
  ok("composeEmailThreadTextFromSiblings: body-bearing siblings → non-null composed string with headers");
}

// ── 2. Siblings with no body → null ──
{
  const siblings = [
    {
      direction: "inbound" as const,
      participantsJson: [],
      timestamp: new Date("2026-01-15T09:30:00Z"),
      contentText: null,
    },
    {
      direction: "outbound" as const,
      participantsJson: [],
      timestamp: new Date("2026-01-15T10:00:00Z"),
      contentText: "",
    },
  ];
  const result = composeEmailThreadTextFromSiblings(siblings as any);
  assert.equal(result, null, "should return null when no sibling has body");
  ok("composeEmailThreadTextFromSiblings: siblings with no body → null");
}

// ── 3. Empty sibling array → null ──
{
  const result = composeEmailThreadTextFromSiblings([]);
  assert.equal(result, null, "should return null for empty array");
  ok("composeEmailThreadTextFromSiblings: empty array → null");
}

// ── 4. buildAnalysisContent: composedContent overrides empty rollup contentText ──
{
  const rollupRecord = {
    sourceType: "front_email",
    sourceSubtype: "email_thread",
    title: "Case discussion",
    timestamp: new Date("2026-01-15T09:00:00Z"),
    direction: "inbound",
    participantsJson: [{ email: "alice@lawfirm.test" }],
    contentText: null,
    contentPreview: "short preview only",
  };
  const composedContent = "[Inbound — alice@lawfirm.test — Jan 15, 2026, 9:30 AM]\nHello, full body here.";
  const result = buildAnalysisContent(rollupRecord, composedContent);
  assert.ok(result.includes("Hello, full body here."), "composed body appears in analysis content");
  assert.ok(!result.includes("short preview only"), "content preview is NOT used when composedContent provided");
  assert.ok(!result.includes("(no content available)"), "fallback not used when composedContent provided");
  ok("buildAnalysisContent: composedContent overrides rollup's empty contentText");
}

// ── 5. buildAnalysisContent: rollup with its own contentText unchanged (composedContent=null) ──
{
  const rollupRecord = {
    sourceType: "front_email",
    sourceSubtype: "email_thread",
    title: "Existing content thread",
    timestamp: new Date("2026-01-15T09:00:00Z"),
    direction: "outbound",
    participantsJson: [],
    contentText: "Full body already stored on rollup row.",
    contentPreview: null,
  };
  const result = buildAnalysisContent(rollupRecord, null);
  assert.ok(result.includes("Full body already stored on rollup row."), "own contentText preserved");
  assert.ok(!result.includes("(no content available)"), "fallback not triggered");
  ok("buildAnalysisContent: rollup with own contentText unchanged when composedContent=null");
}

// ── 6. buildAnalysisContent: fallback to '(no content available)' when both null ──
{
  const emptyRecord = {
    sourceType: "front_email",
    sourceSubtype: "email_thread",
    title: "Empty thread",
    timestamp: new Date("2026-01-15T09:00:00Z"),
    direction: "inbound",
    participantsJson: [],
    contentText: null,
    contentPreview: null,
  };
  const result = buildAnalysisContent(emptyRecord, null);
  assert.ok(result.includes("(no content available)"), "fallback text appears when both composedContent and contentText null");
  ok("buildAnalysisContent: falls back to '(no content available)' when composedContent=null and no contentText/preview");
}

// ── 7. Drift guard: shared helper imported from communicationStorage in both consumers ──
// Static import above proves the test can import composeEmailThreadTextFromSiblings
// from communicationStorage. The analysis path imports the same symbol — verified by
// reading the import in communicationAnalysis.ts (task #2963). This assertion guards
// that the exports still exist (a rename would break both imports + this test).
{
  assert.equal(typeof composeEmailThreadTextFromSiblings, "function", "composeEmailThreadTextFromSiblings exported from communicationStorage");
  assert.equal(typeof buildAnalysisContent, "function", "buildAnalysisContent exported from communicationAnalysis");
  ok("drift guard: both composeEmailThreadTextFromSiblings and buildAnalysisContent are exported from their canonical modules");
}

// ── 8. Task #2986: uncomposable rollup (no contentText AND no externalThreadId) warns ──
{
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
  try {
    const fired = warnIfUncomposableRollup(
      {
        sourceType: "front_email",
        sourceSubtype: "email_thread",
        contentText: null,
        externalThreadId: null,
        clientId: "client-abc",
      },
      "rec-123",
    );
    assert.equal(fired, true, "warn fires for empty rollup with no externalThreadId");
    assert.equal(warns.length, 1, "exactly one warn emitted");
    assert.ok(warns[0].includes("data-quality"), "warn is tagged data-quality");
    assert.ok(warns[0].includes("rec-123"), "warn includes recordId");
    assert.ok(warns[0].includes("client-abc"), "warn includes clientId");
  } finally {
    console.warn = origWarn;
  }
  ok("warnIfUncomposableRollup: fires structured warn with recordId + clientId for uncomposable rollup");
}

// ── 9. Task #2986: composable or content-bearing rows do NOT warn ──
{
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
  try {
    assert.equal(
      warnIfUncomposableRollup(
        { sourceType: "front_email", sourceSubtype: "email_thread", contentText: null, externalThreadId: "thr_1", clientId: "c1" },
        "rec-a",
      ),
      false,
      "rollup with externalThreadId does not warn (composable)",
    );
    assert.equal(
      warnIfUncomposableRollup(
        { sourceType: "front_email", sourceSubtype: "email_thread", contentText: "has body", externalThreadId: null, clientId: "c1" },
        "rec-b",
      ),
      false,
      "rollup with contentText does not warn",
    );
    assert.equal(
      warnIfUncomposableRollup(
        { sourceType: "front_email", sourceSubtype: "email_message", contentText: null, externalThreadId: null, clientId: "c1" },
        "rec-c",
      ),
      false,
      "non-rollup subtype does not warn",
    );
    assert.equal(
      warnIfUncomposableRollup(
        { sourceType: "zoom", sourceSubtype: null, contentText: null, externalThreadId: null, clientId: "c1" },
        "rec-d",
      ),
      false,
      "non-front_email sourceType does not warn",
    );
    assert.equal(warns.length, 0, "no warns emitted for composable/content-bearing/non-rollup rows");
  } finally {
    console.warn = origWarn;
  }
  ok("warnIfUncomposableRollup: silent for composable, content-bearing, and non-rollup records");
}

console.log(`\nfront-email-thread-composition: ${passed} assertions passed`);
process.exit(0);
