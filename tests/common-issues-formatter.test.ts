/* test-registration
{
  "name": "Common Issues auto-formatting fallback (Task #2391)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3770: Common Issues formatter unit suite — now also pins the single-line structure normalizer + repair detector (the July 2026 Ackah wall-of-text poison), the finish_reason=length truncation guard (degrade to deterministic fallback, never persist a cut-off reply), the roomy completion budget, and the deterministic path's marker branch. Pure unit suite (mocked OpenAI singleton), fast; a drift here lets a misbehaving AI reply persist as an unreadable run-on paragraph again.",
  "tier": "small"
}
test-registration */
/**
 * Task #2391 — automated coverage for the shared Common Issues formatter
 * (Task #2389, `server/services/commonIssuesFormatter.ts`).
 *
 * Two layers are exercised:
 *
 *   1. `deterministicFormatCommonIssues` — the non-AI, never-throws fallback.
 *      Covers:
 *        - marker-based splitting into 🔴 Issue / ↳ Impact / ➡️ Strategic Fix
 *          blocks (single and stacked, joined by the "---" separator),
 *        - the no-"Issue N:" but Impact:/Strategic Fix: present single-block
 *          path,
 *        - curated OCR spacing fixes ("of fers" → "offers", "bya" → "by a",
 *          "follow up" → "follow-up"),
 *        - the empty / placeholder guard (returns ""), and
 *        - the no-marker sentence-bullet path (run-on prose → "- " bullets),
 *          including the single-sentence "return lightly cleaned" case.
 *
 *   2. `formatCommonIssuesContent` — the AI-first entry point that degrades to
 *      the deterministic fallback. The OpenAI client is mocked by overriding
 *      the shared singleton's `chat.completions.create` (the same `openai`
 *      object instance the formatter imports from `../routes/middleware`; see
 *      memory "Mocking OpenAI in route tests" — ESM named-import bindings are
 *      read-only but the OBJECT is mutable). Covers:
 *        - AI success → { degraded: false }, AI text passed through,
 *        - AI returns empty → degraded, reason "ai_empty", fallback text,
 *        - AI throws → degraded, reason = error.message, fallback text,
 *        - empty / placeholder input → { formatted: "", degraded: false },
 *          with NO AI call, and
 *        - over-length input → degraded, reason "too_long_for_ai", NO AI call.
 *
 *   3. Task #3770 — `normalizeCommonIssuesStructure` +
 *      `needsCommonIssuesStructureRepair` + the truncation guard. The July
 *      2026 Ackah import stored an AI reply with every canonical marker on a
 *      SINGLE line (and cut off mid-sentence, finish_reason=length); markdown
 *      rendered it as one wall of text with literal "---"/">" characters.
 *      Covers:
 *        - the exact prod-stored Ackah single-line shape → 4 separated
 *          🔴 / ↳ / > ➡️ blocks with real divider lines (idempotent,
 *          convergent detector),
 *        - no-op guarantees (marker-less prose, well-formed canonical text,
 *          short single-line blocks the normalizer would not change),
 *        - the missing-blockquote and setext-heading (`text\n---`) hazards,
 *        - `formatCommonIssuesContent`: a single-line AI reply is normalized
 *          before return, and finish_reason=length degrades to the
 *          deterministic fallback on the RAW input (reason "ai_truncated"),
 *        - `deterministicFormatCommonIssues`: marker-bearing input routes
 *          through the normalizer instead of the "Issue N:" split (which
 *          would shred `**Issue:**` bold markers).
 *
 * This is a pure unit test — no DB, no Express, no network.
 */

import {
  deterministicFormatCommonIssues,
  formatCommonIssuesContent,
  needsCommonIssuesStructureRepair,
  normalizeCommonIssuesStructure,
} from "../server/services/commonIssuesFormatter";
import { openai } from "../server/routes/middleware";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  ${name}`))
    .catch((e) => {
      console.error(`  FAIL ${name}`);
      throw e;
    });
}

// ── OpenAI mock ───────────────────────────────────────────────────────
// `commonIssuesFormatter` calls `openai.chat.completions.create(...)`.
// `openai` is a singleton object exported from `../routes/middleware`; we
// import the SAME instance and replace its `create` method. Each test sets
// `aiBehavior` to control what the mocked model "returns" (or throws), and
// `aiCallCount` lets us assert the AI was (or was NOT) called.
type AiBehavior =
  | { kind: "content"; content: string; finishReason?: string }
  | { kind: "throw"; error: Error };

let aiBehavior: AiBehavior = { kind: "content", content: "" };
let aiCallCount = 0;
// Task #2460 — capture the system prompt of the last AI call so tests can
// assert the performance-aware tone guidance was (or was NOT) injected.
let lastSystemPrompt = "";
// Task #3770 — capture the completion budget so tests can assert the roomier
// cap (reasoning tokens count against max_completion_tokens on CHEAP_MODEL).
let lastMaxCompletionTokens: number | undefined;
const originalCreate = openai.chat.completions.create.bind(
  openai.chat.completions,
);
(openai.chat.completions as any).create = async (params: any) => {
  aiCallCount += 1;
  const sys = (params?.messages || []).find((m: any) => m.role === "system");
  lastSystemPrompt = sys?.content || "";
  lastMaxCompletionTokens = params?.max_completion_tokens;
  if (aiBehavior.kind === "throw") throw aiBehavior.error;
  return {
    choices: [
      {
        message: { content: aiBehavior.content },
        // Task #3770 — real OpenAI responses always carry finish_reason;
        // older tests omit it (undefined ≠ "length", so they are unaffected).
        ...(aiBehavior.finishReason
          ? { finish_reason: aiBehavior.finishReason }
          : {}),
      },
    ],
  };
};

const LITERAL_PLACEHOLDER =
  "Missing data source - There is no data source associated with this component. See details";

const AI_REWRITTEN_PLACEHOLDER = `🔴 **Issue:** Missing data source. There is no data source associated with this component.
↳ **Impact:** Operators cannot see the underlying intake metrics.
> ➡️ **Strategic Fix:** Connect the intake CSV feed so the section populates.`;

(async () => {
  // ── Layer 1: deterministicFormatCommonIssues ────────────────────────
  console.log("deterministicFormatCommonIssues");

  await run("empty / null / whitespace input → \"\"", () => {
    assert(deterministicFormatCommonIssues("") === "", "empty string → ''");
    assert(deterministicFormatCommonIssues(null) === "", "null → ''");
    assert(
      deterministicFormatCommonIssues(undefined) === "",
      "undefined → ''",
    );
    assert(
      deterministicFormatCommonIssues("    \n  \t ") === "",
      "whitespace-only → ''",
    );
  });

  await run("literal 'missing data source' placeholder → \"\"", () => {
    assert(
      deterministicFormatCommonIssues(LITERAL_PLACEHOLDER) === "",
      "literal placeholder → ''",
    );
  });

  await run("AI-rewritten missing-data-source finding → \"\"", () => {
    assert(
      deterministicFormatCommonIssues(AI_REWRITTEN_PLACEHOLDER) === "",
      "AI-rewritten placeholder → ''",
    );
  });

  await run(
    "single Issue/Impact/Strategic Fix marker block → 🔴 / ↳ / ➡️",
    () => {
      const out = deterministicFormatCommonIssues(
        "Issue 1: Reps don't return calls. Impact: Leads go cold. Strategic Fix: Add a same-day callback rule.",
      );
      assert(
        out ===
          "🔴 **Issue:** Reps don't return calls.\n" +
            "↳ **Impact:** Leads go cold.\n" +
            "> ➡️ **Strategic Fix:** Add a same-day callback rule.",
        `unexpected single-block output:\n${out}`,
      );
    },
  );

  await run(
    "stacked Issue markers → multiple blocks joined by '---'",
    () => {
      const out = deterministicFormatCommonIssues(
        "Issue 1: Reps don't return calls. Impact: Leads go cold. Strategic Fix: Add a callback rule. " +
          "Issue 2: No intake script. Impact: Inconsistent qualification. Strategic Fix: Roll out a script.",
      );
      const blocks = out.split("\n\n---\n\n");
      assert(blocks.length === 2, `expected 2 blocks, got ${blocks.length}`);
      assert(
        blocks[0] ===
          "🔴 **Issue:** Reps don't return calls.\n" +
            "↳ **Impact:** Leads go cold.\n" +
            "> ➡️ **Strategic Fix:** Add a callback rule.",
        `unexpected block 0:\n${blocks[0]}`,
      );
      assert(
        blocks[1] ===
          "🔴 **Issue:** No intake script.\n" +
            "↳ **Impact:** Inconsistent qualification.\n" +
            "> ➡️ **Strategic Fix:** Roll out a script.",
        `unexpected block 1:\n${blocks[1]}`,
      );
    },
  );

  await run(
    "no 'Issue N:' marker but Impact:/Strategic Fix: present → single block",
    () => {
      const out = deterministicFormatCommonIssues(
        "Reps skip discovery questions. Impact: Weak case assessment. Strategic Fix: Standardize the intake form.",
      );
      assert(
        out ===
          "🔴 **Issue:** Reps skip discovery questions.\n" +
            "↳ **Impact:** Weak case assessment.\n" +
            "> ➡️ **Strategic Fix:** Standardize the intake form.",
        `unexpected no-marker-block output:\n${out}`,
      );
    },
  );

  await run("OCR spacing artifacts are corrected", () => {
    // Single sentence → returned lightly cleaned (no bullets), so we can
    // assert on the exact corrected text.
    const out = deterministicFormatCommonIssues(
      "The firm of fers help and is reached bya phone call.",
    );
    assert(
      out === "The firm offers help and is reached by a phone call.",
      `OCR fixes not applied:\n${out}`,
    );
    // "follow up" → "follow-up" inside a fuller blob.
    const out2 = deterministicFormatCommonIssues(
      "Issue 1: No follow up cadence. Strategic Fix: Add a follow up step.",
    );
    assert(
      out2.includes("follow-up cadence") &&
        out2.includes("follow-up step"),
      `follow-up OCR fix not applied:\n${out2}`,
    );
  });

  await run(
    "no markers, multiple sentences → '- ' bullet list",
    () => {
      const out = deterministicFormatCommonIssues(
        "Reps are slow to respond. Leads are not tracked. Notes are missing.",
      );
      assert(
        out ===
          "- Reps are slow to respond.\n" +
            "- Leads are not tracked.\n" +
            "- Notes are missing.",
        `unexpected bullet output:\n${out}`,
      );
    },
  );

  await run(
    "no markers, single sentence → returned lightly cleaned (no bullet)",
    () => {
      const out = deterministicFormatCommonIssues(
        "Reps   are    slow   to respond.",
      );
      assert(
        out === "Reps are slow to respond.",
        `single sentence should not be bulleted:\n${out}`,
      );
    },
  );

  // ── Layer 2: formatCommonIssuesContent (AI + degrade path) ──────────
  console.log("\nformatCommonIssuesContent");

  await run(
    "AI success → { degraded: false }, AI text passed through",
    async () => {
      aiCallCount = 0;
      aiBehavior = { kind: "content", content: "AI FORMATTED OUTPUT" };
      const res = await formatCommonIssuesContent(
        "Issue 1: Reps don't return calls. Impact: Leads go cold. Strategic Fix: Call back same day.",
        "intake",
      );
      assert(aiCallCount === 1, "AI should have been called once");
      assert(res.degraded === false, "degraded should be false on success");
      assert(
        res.formatted === "AI FORMATTED OUTPUT",
        `AI output should pass through, got:\n${res.formatted}`,
      );
      assert(res.reason === undefined, "no reason on success");
    },
  );

  await run(
    "AI returns empty → degraded, reason 'ai_empty', deterministic fallback",
    async () => {
      aiCallCount = 0;
      aiBehavior = { kind: "content", content: "   " };
      const input =
        "Issue 1: Reps don't return calls. Impact: Leads go cold. Strategic Fix: Call back same day.";
      const res = await formatCommonIssuesContent(input, "sales");
      assert(aiCallCount === 1, "AI should have been called once");
      assert(res.degraded === true, "degraded should be true on empty AI");
      assert(res.reason === "ai_empty", `reason should be ai_empty, got ${res.reason}`);
      assert(
        res.formatted === deterministicFormatCommonIssues(input),
        "formatted should equal the deterministic fallback",
      );
      assert(
        res.formatted.startsWith("🔴 **Issue:**"),
        `fallback should be structured, got:\n${res.formatted}`,
      );
    },
  );

  await run(
    "AI throws → degraded, reason = error.message, deterministic fallback",
    async () => {
      aiCallCount = 0;
      aiBehavior = { kind: "throw", error: new Error("openai 500") };
      const input =
        "Issue 1: No intake script. Impact: Inconsistent qualification. Strategic Fix: Roll out a script.";
      const res = await formatCommonIssuesContent(input, "intake");
      assert(aiCallCount === 1, "AI should have been called once");
      assert(res.degraded === true, "degraded should be true on AI error");
      assert(
        res.reason === "openai 500",
        `reason should be the error message, got ${res.reason}`,
      );
      assert(
        res.formatted === deterministicFormatCommonIssues(input),
        "formatted should equal the deterministic fallback",
      );
    },
  );

  await run(
    "empty input → { formatted: '', degraded: false }, NO AI call",
    async () => {
      aiCallCount = 0;
      const res = await formatCommonIssuesContent("   ", "intake");
      assert(aiCallCount === 0, "AI should NOT be called for empty input");
      assert(res.formatted === "" && res.degraded === false, "empty → not degraded, empty");
    },
  );

  await run(
    "placeholder input → { formatted: '', degraded: false }, NO AI call",
    async () => {
      aiCallCount = 0;
      const res = await formatCommonIssuesContent(LITERAL_PLACEHOLDER, "sales");
      assert(aiCallCount === 0, "AI should NOT be called for placeholder input");
      assert(
        res.formatted === "" && res.degraded === false,
        "placeholder → not degraded, empty",
      );
    },
  );

  await run(
    "over-length input → degraded, reason 'too_long_for_ai', NO AI call",
    async () => {
      aiCallCount = 0;
      // > MAX_AI_INPUT_CHARS (5000). Use repeated sentences so the fallback
      // still produces a non-empty bulleted result.
      const input = "Reps are slow to respond. ".repeat(250);
      assert(input.length > 5000, "test input must exceed the AI cap");
      const res = await formatCommonIssuesContent(input, "intake");
      assert(aiCallCount === 0, "AI should NOT be called for over-length input");
      assert(res.degraded === true, "over-length should degrade");
      assert(
        res.reason === "too_long_for_ai",
        `reason should be too_long_for_ai, got ${res.reason}`,
      );
      assert(
        res.formatted === deterministicFormatCommonIssues(input),
        "formatted should equal the deterministic fallback",
      );
    },
  );

  // ── Layer 3: Task #2460 performance-aware tone context ──────────────
  console.log("\nformatCommonIssuesContent — performance-aware tone (Task #2460)");

  const TONE_INPUT =
    "Issue 1: Reps don't return calls. Impact: Leads go cold. Strategic Fix: Call back same day.";

  await run(
    "no metric context → neutral prompt (no PERFORMANCE-AWARE TONE block)",
    async () => {
      aiCallCount = 0;
      lastSystemPrompt = "";
      aiBehavior = { kind: "content", content: "FORMATTED" };
      await formatCommonIssuesContent(TONE_INPUT, "intake");
      assert(aiCallCount === 1, "AI should have been called once");
      assert(
        !lastSystemPrompt.includes("PERFORMANCE-AWARE TONE"),
        "neutral call must not inject tone guidance",
      );
    },
  );

  await run(
    "intake at/above goal (healthy) → gentle, positive tone guidance",
    async () => {
      aiCallCount = 0;
      lastSystemPrompt = "";
      aiBehavior = { kind: "content", content: "FORMATTED" };
      // free intake goal = 65; rate 80 → healthy.
      const res = await formatCommonIssuesContent(TONE_INPUT, "intake", {
        rate: 80,
        consultType: "free",
      });
      assert(res.degraded === false, "AI success should not degrade");
      assert(
        lastSystemPrompt.includes("PERFORMANCE-AWARE TONE"),
        "context call must inject tone guidance",
      );
      assert(
        lastSystemPrompt.includes("severity: healthy"),
        `expected healthy band in prompt:\n${lastSystemPrompt}`,
      );
      assert(
        /AT OR ABOVE/i.test(lastSystemPrompt) &&
          /optional/i.test(lastSystemPrompt),
        "healthy guidance should be gentle/optional",
      );
      assert(
        !/non-negotiable must-fixes/i.test(lastSystemPrompt),
        "healthy guidance must not include urgent must-fix language",
      );
    },
  );

  await run(
    "intake far below goal (critical) → urgent, direct tone guidance",
    async () => {
      aiCallCount = 0;
      lastSystemPrompt = "";
      aiBehavior = { kind: "content", content: "FORMATTED" };
      // free intake goal = 65; rate 20 (< 45) → critical.
      await formatCommonIssuesContent(TONE_INPUT, "intake", {
        rate: 20,
        consultType: "free",
      });
      assert(
        lastSystemPrompt.includes("severity: critical"),
        `expected critical band in prompt:\n${lastSystemPrompt}`,
      );
      assert(
        /urgent/i.test(lastSystemPrompt) &&
          /must-fixes/i.test(lastSystemPrompt),
        "critical guidance should be urgent/direct",
      );
    },
  );

  await run(
    "sales bands respect free-vs-paid thresholds",
    async () => {
      aiBehavior = { kind: "content", content: "FORMATTED" };
      // free sales: rate 32 (>=30) → healthy.
      lastSystemPrompt = "";
      await formatCommonIssuesContent(TONE_INPUT, "sales", {
        rate: 32,
        consultType: "free",
      });
      assert(
        lastSystemPrompt.includes("severity: healthy"),
        `free sales 32 should be healthy:\n${lastSystemPrompt}`,
      );
      // paid sales: rate 32 (<35) → issue (paid goal is higher).
      lastSystemPrompt = "";
      await formatCommonIssuesContent(TONE_INPUT, "sales", {
        rate: 32,
        consultType: "paid",
      });
      assert(
        lastSystemPrompt.includes("severity: issue"),
        `paid sales 32 should be issue:\n${lastSystemPrompt}`,
      );
      assert(
        lastSystemPrompt.includes("Consult-to-Case rate"),
        "sales prompt should reference Consult-to-Case rate",
      );
    },
  );

  await run(
    "tone context always preserves the substance instruction",
    async () => {
      aiBehavior = { kind: "content", content: "FORMATTED" };
      lastSystemPrompt = "";
      await formatCommonIssuesContent(TONE_INPUT, "intake", {
        rate: 20,
        consultType: "free",
      });
      assert(
        /PRESERVE the substance/i.test(lastSystemPrompt),
        "every tone band must preserve substance",
      );
      assert(
        lastSystemPrompt.includes("🔴") && lastSystemPrompt.includes("➡️"),
        "structure instruction must remain in the prompt",
      );
    },
  );

  await run(
    "AI failure with tone context still degrades to deterministic fallback",
    async () => {
      aiBehavior = { kind: "throw", error: new Error("openai 503") };
      const res = await formatCommonIssuesContent(TONE_INPUT, "intake", {
        rate: 80,
        consultType: "free",
      });
      assert(res.degraded === true, "AI throw should degrade");
      assert(
        res.formatted === deterministicFormatCommonIssues(TONE_INPUT),
        "fallback must equal deterministic output (no tone rewrite)",
      );
    },
  );

  // ── Layer 4: Task #3770 — structure normalizer + truncation guard ───
  console.log("\nnormalizeCommonIssuesStructure (Task #3770)");

  // The EXACT malformed single-line value stored on the shared Ackah Law
  // 2026-07 Intake section in production (read from the prod replica; ends
  // mid-sentence where finish_reason=length cut the reply off). Zero newlines
  // — every marker and every "---" divider is inline.
  const ACKAH_SINGLE_LINE = `🔴 **Issue:** Weak or absent "Strong Ask to Book Now" and limited emotional urgency across calls ↳ **Impact:** The largest drivers of lost bookings > ➡️ **Strategic Fix:** Mandate an assumptive closing script that ties booking to concrete case urgency and lawyer availability, supported by weekly coached role-plays and conversion KPIs. --- 🔴 **Issue:** Unclear next steps, inconsistent appointment confirmations, and lack of immediate reminders ↳ **Impact:** Scheduling friction and high no-show risk > ➡️ **Strategic Fix:** Implement a standardized end-of-call checklist plus automated SMS/email calendar invites and a lawyer-intro message before hang-up, with tracking for reminder delivery and attendance. --- 🔴 **Issue:** Poor data capture, language-switching friction, talk-to-listen imbalances, and premature fee conversations ↳ **Impact:** Weakened rapport and increased abandonment > ➡️ **Strategic Fix:** Enforce a structured intake template and language-routing protocol, train active-listening/empathetic probes, and delay fee discussions until value is established, monitored via QA and talk-listen metrics. --- 🔴 **Issue:** Weak or absent "Strong Ask to Book Now" ↳ **Impact:** Routine drop-off and missed revenue > ➡️ **Strategic Fix:** Institute a mandatory, scripted`;

  await run(
    "Ackah prod single-line shape → 4 separated 🔴/↳/➡️ blocks",
    () => {
      assert(
        !ACKAH_SINGLE_LINE.includes("\n"),
        "fixture must be single-line (mirrors the prod row)",
      );
      const out = normalizeCommonIssuesStructure(ACKAH_SINGLE_LINE);
      const blocks = out.split("\n\n---\n\n");
      assert(blocks.length === 4, `expected 4 blocks, got ${blocks.length}`);
      for (const [i, block] of blocks.entries()) {
        const lines = block.split("\n");
        assert(
          lines.length === 3,
          `block ${i} should be 3 lines, got ${lines.length}:\n${block}`,
        );
        assert(
          lines[0].startsWith("🔴 **Issue:**"),
          `block ${i} line 0 must be the issue line:\n${lines[0]}`,
        );
        assert(
          lines[1].startsWith("↳ **Impact:**"),
          `block ${i} line 1 must be the impact line:\n${lines[1]}`,
        );
        assert(
          lines[2].startsWith("> ➡️ **Strategic Fix:**"),
          `block ${i} line 2 must be the quoted fix line:\n${lines[2]}`,
        );
      }
      // Every "---" now sits alone on its own divider line — no literal
      // inline "---" survives anywhere.
      assert(
        out
          .split("\n")
          .filter((l) => l.includes("---"))
          .every((l) => l.trim() === "---"),
        `inline --- survived:\n${out}`,
      );
      // The mid-sentence truncation tail is preserved verbatim (structure
      // repair never invents or drops content).
      assert(
        out.endsWith("> ➡️ **Strategic Fix:** Institute a mandatory, scripted"),
        `truncated tail must be preserved verbatim:\n${out.slice(-120)}`,
      );
    },
  );

  await run("normalizer is idempotent; detector converges", () => {
    const once = normalizeCommonIssuesStructure(ACKAH_SINGLE_LINE);
    const twice = normalizeCommonIssuesStructure(once);
    assert(twice === once, "normalize(normalize(x)) must equal normalize(x)");
    assert(
      needsCommonIssuesStructureRepair(ACKAH_SINGLE_LINE) === true,
      "detector must flag the malformed single-line shape",
    );
    assert(
      needsCommonIssuesStructureRepair(once) === false,
      "detector must NOT flag the repaired output (self-extinguishing)",
    );
  });

  await run("no-op on well-formed canonical text and marker-less prose", () => {
    const wellFormed =
      "🔴 **Issue:** Reps are slow.\n↳ **Impact:** Leads churn.\n> ➡️ **Strategic Fix:** Respond same day.\n\n---\n\n🔴 **Issue:** No script.\n↳ **Impact:** Inconsistent calls.\n> ➡️ **Strategic Fix:** Roll one out.";
    assert(
      normalizeCommonIssuesStructure(wellFormed) === wellFormed,
      "well-formed canonical text must pass through unchanged",
    );
    const prose = "Reps are slow to respond. Leads are not tracked.";
    assert(
      normalizeCommonIssuesStructure(prose) === prose,
      "marker-less single-line prose must pass through unchanged",
    );
    const proseMulti = "Line one --- with dashes.\nLine > two.";
    assert(
      normalizeCommonIssuesStructure(proseMulti) === proseMulti,
      "marker-less multi-line prose (even with --- / >) must pass through unchanged",
    );
  });

  await run("detector: no-op single-line + non-string inputs are false", () => {
    // Marker-bearing but already as structured as it can be — the normalizer
    // would not change it, so it must never become a perpetual candidate.
    const shortBlock = "🔴 **Issue:** Short note.";
    assert(
      normalizeCommonIssuesStructure(shortBlock) === shortBlock,
      "single-issue-line block should be a normalizer no-op",
    );
    assert(
      needsCommonIssuesStructureRepair(shortBlock) === false,
      "normalizer no-op single-line block must NOT be flagged",
    );
    // Multi-line text is never flagged (repair targets the no-newline shape).
    const multiLine = "🔴 **Issue:** A ↳ **Impact:** B\nmore text";
    assert(
      needsCommonIssuesStructureRepair(multiLine) === false,
      "text containing any newline must NOT be flagged",
    );
    assert(needsCommonIssuesStructureRepair(null) === false, "null → false");
    assert(needsCommonIssuesStructureRepair(42) === false, "number → false");
    assert(needsCommonIssuesStructureRepair("   ") === false, "blank → false");
  });

  await run("missing blockquote prefix and setext-heading hazards", () => {
    // Bare "➡️ **Strategic Fix:**" (AI dropped the ">") gains the blockquote.
    const bare =
      "🔴 **Issue:** A ↳ **Impact:** B ➡️ **Strategic Fix:** C";
    const bareOut = normalizeCommonIssuesStructure(bare);
    assert(
      bareOut ===
        "🔴 **Issue:** A\n↳ **Impact:** B\n> ➡️ **Strategic Fix:** C",
      `bare arrow should gain the "> " prefix:\n${bareOut}`,
    );
    // "text\n---\ntext" is a markdown setext HEADING (the text line becomes a
    // huge <h2>) — the normalizer must force blank lines around the divider.
    const setext =
      "🔴 **Issue:** A\n↳ **Impact:** B\n> ➡️ **Strategic Fix:** C\n---\n🔴 **Issue:** D\n↳ **Impact:** E\n> ➡️ **Strategic Fix:** F";
    const setextOut = normalizeCommonIssuesStructure(setext);
    assert(
      setextOut.includes("C\n\n---\n\n🔴"),
      `divider must gain blank lines on both sides:\n${setextOut}`,
    );
    // A trailing divider is dropped (canonical output never ends with ---).
    const trailing = "🔴 **Issue:** A ↳ **Impact:** B > ➡️ **Strategic Fix:** C ---";
    const trailingOut = normalizeCommonIssuesStructure(trailing);
    assert(
      trailingOut.endsWith("> ➡️ **Strategic Fix:** C"),
      `trailing divider must be stripped:\n${trailingOut}`,
    );
  });

  console.log("\nformatCommonIssuesContent — Task #3770 guards");

  await run(
    "single-line AI reply with markers → normalized before return",
    async () => {
      aiCallCount = 0;
      aiBehavior = {
        kind: "content",
        content:
          "🔴 **Issue:** A ↳ **Impact:** B > ➡️ **Strategic Fix:** C --- 🔴 **Issue:** D ↳ **Impact:** E > ➡️ **Strategic Fix:** F",
        finishReason: "stop",
      };
      const res = await formatCommonIssuesContent(TONE_INPUT, "intake");
      assert(aiCallCount === 1, "AI called once");
      assert(res.degraded === false, "normalized reply is NOT a degrade");
      assert(
        res.formatted ===
          "🔴 **Issue:** A\n↳ **Impact:** B\n> ➡️ **Strategic Fix:** C\n\n---\n\n🔴 **Issue:** D\n↳ **Impact:** E\n> ➡️ **Strategic Fix:** F",
        `AI single-line reply must be structure-normalized:\n${res.formatted}`,
      );
    },
  );

  await run(
    "finish_reason=length → degraded 'ai_truncated', fallback on RAW input",
    async () => {
      aiCallCount = 0;
      aiBehavior = {
        kind: "content",
        // A plausible-looking but cut-off reply — must be discarded entirely.
        content: "🔴 **Issue:** Weak ask ↳ **Impact:** Lost bookings > ➡️ **Strategic Fix:** Institute a mandatory, scripted",
        finishReason: "length",
      };
      const res = await formatCommonIssuesContent(TONE_INPUT, "intake");
      assert(aiCallCount === 1, "AI called once");
      assert(res.degraded === true, "truncated reply must degrade");
      assert(
        res.reason === "ai_truncated",
        `reason should be ai_truncated, got ${res.reason}`,
      );
      assert(
        res.formatted === deterministicFormatCommonIssues(TONE_INPUT),
        "fallback must be the deterministic format of the RAW input (the truncated AI text is discarded)",
      );
      assert(
        !res.formatted.includes("Institute a mandatory"),
        "no fragment of the truncated AI reply may leak into the result",
      );
    },
  );

  await run(
    "completion budget is roomy (>= 8000) so reasoning can't starve output",
    async () => {
      aiCallCount = 0;
      lastMaxCompletionTokens = undefined;
      aiBehavior = { kind: "content", content: "FORMATTED", finishReason: "stop" };
      await formatCommonIssuesContent(TONE_INPUT, "intake");
      assert(aiCallCount === 1, "AI called once");
      assert(
        typeof lastMaxCompletionTokens === "number" &&
          lastMaxCompletionTokens >= 8000,
        `max_completion_tokens must be >= 8000, got ${lastMaxCompletionTokens} (the July 2026 Ackah truncation: reasoning tokens ate ~2700 of the old 3000 cap)`,
      );
    },
  );

  console.log("\ndeterministicFormatCommonIssues — Task #3770 marker branch");

  await run(
    "marker-bearing input routes through the normalizer (no 'Issue N:' shredding)",
    () => {
      const out = deterministicFormatCommonIssues(ACKAH_SINGLE_LINE);
      assert(
        out === normalizeCommonIssuesStructure(ACKAH_SINGLE_LINE),
        "deterministic fallback on marker-bearing input must equal the normalizer output",
      );
      assert(
        out.split("\n\n---\n\n").length === 4,
        "fallback must keep the 4 separated blocks",
      );
      assert(
        !out.includes("**\n") && out.includes("🔴 **Issue:** Weak"),
        `bold markers must not be shredded by the Issue-N split:\n${out.slice(0, 200)}`,
      );
    },
  );

  await run(
    "well-formed canonical text round-trips through the deterministic path",
    () => {
      const wellFormed =
        "🔴 **Issue:** Reps are slow.\n↳ **Impact:** Leads churn.\n> ➡️ **Strategic Fix:** Respond same day.";
      assert(
        deterministicFormatCommonIssues(wellFormed) === wellFormed,
        "already-canonical text must survive the deterministic path unchanged",
      );
    },
  );

  // Restore the real OpenAI client so nothing else in the process is affected.
  (openai.chat.completions as any).create = originalCreate;

  console.log("\nAll Task #2391 / #2460 / #3770 Common Issues formatter tests passed.");
  process.exit(0);
})().catch((e) => {
  (openai.chat.completions as any).create = originalCreate;
  console.error(e);
  process.exit(1);
});
