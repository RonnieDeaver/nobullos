/* test-registration
{
  "name": "Missing-data-source placeholder tails + serve/cleanup predicates (Task #3769)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3769: “Missing data source … Name_Clean (N): <client>” tail detection — the exact gap that let the raw Ackah Law artifact evade the placeholder gate, get AI-rewritten into a fake red “Issue”, and reach a shared client report. Covers the raw-gate tail variants, the serve-time suppression predicate (share/preview/demo sanitizers), and the cleanup classifier. Pure functions, DB-free, network-free, fast; a drift here silently reopens the client-visible fake-finding hole.",
  "tier": "small"
}
test-registration */
/**
 * Task #3769 — "Missing data source" placeholder detection with trailing
 * source-name artifacts (`Name_Clean (N): <client>` tails).
 *
 * The Ackah Law 2026-07 incident: the raw Looker artifact
 *   "Missing data source - There is no data source associated with this
 *    component. See details Name_Clean (1): Ackah Law"
 * evaded `isMissingDataSourcePlaceholder` (the tail made it look like extra
 * real content), so the AI formatter rewrote it into a fake red "Issue" that
 * reached the shared client report.
 *
 * Verifies:
 *   1. `stripNameCleanArtifactTail` removes underscored / spaced / collapsed /
 *      letter-spaced tails but never touches real sentences.
 *   2. `isMissingDataSourcePlaceholder` detects the placeholder with every
 *      tail variant (incl. the exact raw Ackah text) while mixed
 *      placeholder+real-findings text stays NOT-placeholder.
 *   3. `isEmptySectionBody` treats a bare artifact-only body as empty.
 *   4. `isAiRewrittenMissingDataSourceFinding` still flags AI-rewritten
 *      placeholder findings that carry the tail, and never flags rewritten
 *      output that contains a real finding.
 *   5. `isPlaceholderOnlyCommonIssues` — the single serve-time predicate the
 *      share/preview/demo sanitizers use — flags literal and AI-rewritten
 *      classes, and returns false for blank / non-string / real values.
 *   6. `extractCommonIssuesFromText` end-to-end: tail variants extract as
 *      empty with reason `missing_data_source_placeholder`; real bodies keep
 *      "high" confidence.
 *   7. `classifyPlaceholderCommonIssues` (cleanup service) buckets stored
 *      values into literal / blank / ai-rewritten and returns null for real,
 *      mixed, and already-empty values.
 *
 * DB-free, network-free, fast.
 */

import {
  extractCommonIssuesFromText,
  isAiRewrittenMissingDataSourceFinding,
  isEmptySectionBody,
  isMissingDataSourcePlaceholder,
  isPlaceholderOnlyCommonIssues,
  stripNameCleanArtifactTail,
} from "../server/services/pdfImportParser";
import { classifyPlaceholderCommonIssues } from "../server/services/placeholderCommonIssuesCleanup";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function run(name: string, fn: () => void): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  ${name}`))
    .catch((e) => {
      console.error(`  FAIL ${name}`);
      throw e;
    });
}

const BASE =
  "Missing data source - There is no data source associated with this component. See details";

// The exact stored AI-rewritten Ackah finding class (what the formatter
// produced from the raw artifact before the gate fix).
const AI_REWRITTEN_TAIL = `🔴 **Issue:** Missing data source.
↳ **Impact:** The component has no data source associated with this component, so no findings are available.
➡️ **Strategic Fix:** Reconnect the data source.

Name_Clean (1): Ackah Law`;

const AI_REWRITTEN_MIXED = `🔴 **Issue:** Missing data source.
---
🔴 **Issue:** Reps not following up within 24 hours.
➡️ **Strategic Fix:** Add SLA.`;

// EXACT values stored in production for Ackah Law (read from the prod
// replica during Task #3769) — the fake findings the AI formatter produced
// from the raw artifact before the gate fix. Note the tail INSIDE the
// Strategic Fix line, the `> ` blockquote prefix, the collapsed
// "Name_Clean(1)" (June) vs spaced "Name_Clean (1)" (July), and the
// whitespace-collapsed single-line July shape.
const ACKAH_STORED_JUNE_SALES = `🔴 **Issue:** Missing data source
↳ **Impact:** There is no data source associated with this component
> ➡️ **Strategic Fix:** See details Name_Clean(1): Ackah Law`;
const ACKAH_STORED_JULY_SALES = `🔴 **Issue:** Missing data source ↳ **Impact:** There is no data source associated with this component > ➡️ **Strategic Fix:** See details Name_Clean (1): Ackah Law`;

// Real finding stored for the SAME client (July intake) — must never flag.
const ACKAH_STORED_JULY_INTAKE_REAL = `🔴 **Issue:** Weak or absent "Strong Ask to Book Now" and limited emotional urgency across calls ↳ **Impact:** The largest drivers of lost bookings > ➡️ **Strategic Fix:** Mandate an assumptive closing script that ties booking to concrete case urgency and lawyer availability, supported by weekly coached role-plays and conversion KPIs.`;

(async () => {
  console.log("stripNameCleanArtifactTail");
  await run("strips underscored tail", () => {
    const out = stripNameCleanArtifactTail(`${BASE} Name_Clean (1): Ackah Law`);
    assert(!/name_clean/i.test(out), `tail removed, got ${JSON.stringify(out)}`);
    assert(out.includes("See details"), "base text preserved");
  });
  await run("strips spaced and collapsed tails", () => {
    assert(!/name\s*clean/i.test(stripNameCleanArtifactTail(`${BASE} Name Clean (1): Ackah Law`)), "spaced");
    assert(!/nameclean/i.test(stripNameCleanArtifactTail(`${BASE} NameClean(1): Ackah Law`)), "collapsed");
  });
  await run("strips tail without colon", () => {
    const out = stripNameCleanArtifactTail(`${BASE} Name_Clean (2) Trusted Estate Planning Attorneys`);
    assert(!/name_clean/i.test(out), "no-colon tail removed");
  });
  await run("mid-sentence artifact-like text never flips the placeholder verdict", () => {
    // The strip helper itself is deliberately aggressive on trailing
    // artifact-shaped text; the mixed-content guard lives in the PREDICATE,
    // which additionally requires the base placeholder text. A real sentence
    // that merely mentions "name clean (1)" must stay non-placeholder and
    // non-empty.
    const real = "Reps should name clean (1) data before intake follow-up begins.";
    assert(stripNameCleanArtifactTail(real).startsWith("Reps should"), "leading words preserved");
    assert(!isMissingDataSourcePlaceholder(real), "not a placeholder");
    assert(!isEmptySectionBody(real), "not an empty body");
  });
  await run("leaves tail followed by a real sentence untouched", () => {
    const mixed = `${BASE} Name_Clean (1): Acme. Also reps drop calls on weekends.`;
    assert(stripNameCleanArtifactTail(mixed) === mixed, "sentence-punctuated continuation untouched");
  });

  console.log("isMissingDataSourcePlaceholder — tail variants");
  await run("exact Ackah raw (underscored tail)", () => {
    assert(isMissingDataSourcePlaceholder(`${BASE} Name_Clean (1): Ackah Law`), "underscored");
  });
  await run("spaced / collapsed / letter-spaced tails", () => {
    assert(isMissingDataSourcePlaceholder(`${BASE} Name Clean (1): Ackah Law`), "spaced");
    assert(isMissingDataSourcePlaceholder(`${BASE} NameClean(1): Ackah Law`), "collapsed");
    assert(
      isMissingDataSourcePlaceholder(`${BASE} N a m e _ C l e a n ( 1 ) : A c k a h L a w`),
      "letter-spaced (PDF extraction artifact)",
    );
  });
  await run("multi-line raw with tail", () => {
    assert(
      isMissingDataSourcePlaceholder(
        `Missing data source\n-\nThere is no data source associated with this\ncomponent.\nSee details\nName_Clean (1): Ackah Law`,
      ),
      "multi-line",
    );
  });
  await run("tail without colon, different client", () => {
    assert(isMissingDataSourcePlaceholder(`${BASE} Name_Clean (2) Trusted Estate Planning Attorneys`), "no colon");
  });
  await run("tail-less placeholder still detected (regression)", () => {
    assert(isMissingDataSourcePlaceholder(BASE), "base placeholder");
  });
  await run("mixed placeholder + real findings stays NOT placeholder", () => {
    assert(
      !isMissingDataSourcePlaceholder(`Missing data source. Reps are slow to answer calls in the morning shift.`),
      "real continuation",
    );
    assert(
      !isMissingDataSourcePlaceholder(`${BASE} Name_Clean (1): Acme. Also reps drop calls on weekends.`),
      "real sentence after tail",
    );
    assert(
      !isMissingDataSourcePlaceholder("Frequently dropped Spanish-speaking leads on first call."),
      "plain real content",
    );
  });

  console.log("isEmptySectionBody");
  await run("bare artifact-only body is empty", () => {
    assert(isEmptySectionBody("Name_Clean (1): Ackah Law"), "bare artifact");
    assert(isEmptySectionBody("--- ----"), "dashes regression");
    assert(!isEmptySectionBody("We are losing leads on weekends."), "real content not empty");
  });

  console.log("isAiRewrittenMissingDataSourceFinding");
  await run("AI-rewritten with underscored tail", () => {
    assert(isAiRewrittenMissingDataSourceFinding(AI_REWRITTEN_TAIL), "underscored tail");
  });
  await run("AI-rewritten with spaced no-colon tail", () => {
    assert(
      isAiRewrittenMissingDataSourceFinding(
        `🔴 **Issue:** Missing data source.\n➡️ **Strategic Fix:** Restore it.\nName Clean (3) Ackah Law`,
      ),
      "spaced no-colon tail",
    );
  });
  await run("AI-rewritten mixed with a real finding stays false", () => {
    assert(!isAiRewrittenMissingDataSourceFinding(AI_REWRITTEN_MIXED), "real finding preserved");
  });
  await run("EXACT Ackah prod-stored June + July sales values are detected", () => {
    assert(isAiRewrittenMissingDataSourceFinding(ACKAH_STORED_JUNE_SALES), "June (collapsed tail in Fix line)");
    assert(isAiRewrittenMissingDataSourceFinding(ACKAH_STORED_JULY_SALES), "July (single-line, spaced tail)");
  });
  await run("EXACT Ackah prod-stored real intake finding stays false", () => {
    assert(
      !isAiRewrittenMissingDataSourceFinding(ACKAH_STORED_JULY_INTAKE_REAL),
      "real Strong-Ask finding never flagged",
    );
  });
  await run("real sentence AFTER the artifact tail stays false (review hardening)", () => {
    // The tail after "Name_Clean (N):" must be a bare source name. A real
    // operator sentence written after the artifact means mixed content —
    // the destructive cleanup/suppression predicate must leave it alone.
    assert(
      !isAiRewrittenMissingDataSourceFinding(
        `🔴 **Issue:** Missing data source.\n➡️ **Strategic Fix:** Reconnect it.\nName_Clean (1): Ackah Law. Weekend calls are going unanswered and we are losing bookings to competitors every single week now.`,
      ),
      "sentence after underscored tail preserved",
    );
    assert(
      !isAiRewrittenMissingDataSourceFinding(
        `🔴 **Issue:** Missing data source. Name Clean (2): Ackah Law! Staff report the intake queue backs up on Mondays.`,
      ),
      "sentence with mid-tail punctuation preserved",
    );
    assert(
      !isPlaceholderOnlyCommonIssues(
        `🔴 **Issue:** Missing data source.\nName_Clean (1): Ackah Law. Weekend calls are going unanswered and we are losing bookings to competitors every single week now.`,
      ),
      "serve/cleanup predicate never flags the mixed row",
    );
    // The bounded strip itself: >10-word tails are NOT swallowed by the raw
    // gate either.
    assert(
      !isMissingDataSourcePlaceholder(
        `${BASE} Name_Clean (1): the intake team keeps missing weekend calls because nobody covers the Saturday morning shift at all`,
      ),
      "raw gate: long prose tail not swallowed",
    );
  });

  console.log("isPlaceholderOnlyCommonIssues (serve-time predicate)");
  await run("flags literal + tail", () => {
    assert(isPlaceholderOnlyCommonIssues(`${BASE} Name_Clean (1): Ackah Law`), "literal + tail");
  });
  await run("flags AI-rewritten class", () => {
    assert(isPlaceholderOnlyCommonIssues(AI_REWRITTEN_TAIL), "ai-rewritten");
    assert(isPlaceholderOnlyCommonIssues(ACKAH_STORED_JUNE_SALES), "exact stored June value");
    assert(isPlaceholderOnlyCommonIssues(ACKAH_STORED_JULY_SALES), "exact stored July value");
  });
  await run("flags bare artifact body", () => {
    assert(isPlaceholderOnlyCommonIssues("Name_Clean (1): Ackah Law"), "bare artifact");
  });
  await run("never flags blank / non-string / real values", () => {
    assert(!isPlaceholderOnlyCommonIssues(""), "empty string");
    assert(!isPlaceholderOnlyCommonIssues("   "), "whitespace-only (already blank — nothing to suppress)");
    assert(!isPlaceholderOnlyCommonIssues(null), "null");
    assert(!isPlaceholderOnlyCommonIssues(undefined), "undefined");
    assert(!isPlaceholderOnlyCommonIssues(42), "number");
    assert(!isPlaceholderOnlyCommonIssues({ text: BASE }), "object");
    assert(!isPlaceholderOnlyCommonIssues("Real finding text here."), "real content");
    assert(!isPlaceholderOnlyCommonIssues(AI_REWRITTEN_MIXED), "mixed AI output with real finding");
  });

  console.log("extractCommonIssuesFromText — tail variants end-to-end");
  await run("intake + sales tail variants extract as placeholder-empty", () => {
    const fullText = `Intake Common Issues
${BASE} Name_Clean (1): Ackah Law
Sales Common Issues
${BASE} N a m e _ C l e a n ( 1 ) : Ackah Law
Client (Acme)`;
    for (const section of ["intake", "sales"] as const) {
      const r = extractCommonIssuesFromText(fullText, section);
      assert(r.isEmpty, `${section} empty`);
      assert(r.value === "", `${section} value empty`);
      assert(
        r.emptyReason === "missing_data_source_placeholder",
        `${section} reason=${r.emptyReason}`,
      );
      assert(/missing data source/i.test(r.confidence.source), `${section} confidence source names the placeholder`);
    }
  });
  await run("real bodies still extract at high confidence", () => {
    const realText = `Intake Common Issues
Frequently dropped Spanish-speaking leads on first call. Need follow-up training.
Sales Common Issues
Reps not following up within 24 hours on consult requests for new clients.`;
    const ri = extractCommonIssuesFromText(realText, "intake");
    assert(!ri.isEmpty && ri.confidence.confidence === "high", `intake high, got ${ri.confidence.confidence}`);
    const rs = extractCommonIssuesFromText(realText, "sales");
    assert(!rs.isEmpty && rs.confidence.confidence === "high", `sales high, got ${rs.confidence.confidence}`);
  });

  console.log("classifyPlaceholderCommonIssues (cleanup service)");
  await run("buckets literal / blank / ai-rewritten", () => {
    assert(
      classifyPlaceholderCommonIssues(ACKAH_STORED_JUNE_SALES) === "ai_rewritten_placeholder",
      "exact stored June value → ai_rewritten",
    );
    assert(
      classifyPlaceholderCommonIssues(ACKAH_STORED_JULY_SALES) === "ai_rewritten_placeholder",
      "exact stored July value → ai_rewritten",
    );
    assert(
      classifyPlaceholderCommonIssues(ACKAH_STORED_JULY_INTAKE_REAL) === null,
      "exact stored real intake finding → null",
    );
    assert(
      classifyPlaceholderCommonIssues(`${BASE} Name_Clean (1): Ackah Law`) === "literal_placeholder",
      "literal + tail",
    );
    assert(classifyPlaceholderCommonIssues(BASE) === "literal_placeholder", "tail-less literal");
    assert(classifyPlaceholderCommonIssues("Name_Clean (1): Ackah Law") === "blank_body", "bare artifact");
    assert(classifyPlaceholderCommonIssues("   ") === "blank_body", "whitespace-only stored value");
    assert(classifyPlaceholderCommonIssues(AI_REWRITTEN_TAIL) === "ai_rewritten_placeholder", "ai-rewritten");
  });
  await run("returns null for real / mixed / already-empty", () => {
    assert(classifyPlaceholderCommonIssues("") === null, "already empty");
    assert(classifyPlaceholderCommonIssues("Real finding text here.") === null, "real");
    assert(
      classifyPlaceholderCommonIssues(`${BASE} Name_Clean (1): Acme. Also reps drop calls on weekends.`) === null,
      "mixed literal + real",
    );
    assert(classifyPlaceholderCommonIssues(AI_REWRITTEN_MIXED) === null, "mixed AI output");
  });

  console.log("\npdf-parser-placeholder-tail: PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("pdf-parser-placeholder-tail: FAILED", e);
  process.exit(1);
});
