/* test-registration
{
  "name": "SMS consent keyword classifier (Task #4336)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Pure in-process unit test (no DB, no network, <1s) guarding the compliance-critical STOP/START/HELP classification the Twilio inbound webhook and the consent backfill both depend on.",
  "timeoutMs": 60000,
  "tier": "small"
}
test-registration */
// Task #4336 — unit coverage for classifySmsConsentKeyword: the single
// classifier used by the live inbound webhook AND the historical backfill.
// HubSpot-parity keyword sets; single-word-only matching (so "can you stop
// by tomorrow" never opts anyone out); Twilio OptOutType edge hint as the
// fallback for custom keywords the static sets cannot know.
//
// Usage: tsx tests/sms-consent-keywords.test.ts

import {
  classifySmsConsentKeyword,
  SMS_OPT_OUT_KEYWORDS,
  SMS_OPT_IN_KEYWORDS,
  SMS_HELP_KEYWORDS,
} from "../server/services/smsConsentKeywords";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  const sym = ok ? "✓" : "✗";
  if (ok) {
    passed++;
    console.log(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.error(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function main(): void {
  console.log("SMS consent keyword classifier (Task #4336)");

  console.log("\n— 1. Opt-out family (single word, case-insensitive, trailing punctuation) —");
  for (const kw of SMS_OPT_OUT_KEYWORDS) {
    const m = classifySmsConsentKeyword(kw.toLowerCase());
    check(`"${kw.toLowerCase()}" → opt_out`, m?.kind === "opt_out" && m.keyword === kw);
  }
  check(
    `HubSpot-parity set covers STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT`,
    ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].every((k) =>
      (SMS_OPT_OUT_KEYWORDS as readonly string[]).includes(k),
    ),
  );
  const punct = classifySmsConsentKeyword("Stop.");
  check(`"Stop." (trailing punctuation) → opt_out STOP`, punct?.kind === "opt_out" && punct.keyword === "STOP");
  const bang = classifySmsConsentKeyword("STOP!!!");
  check(`"STOP!!!" → opt_out`, bang?.kind === "opt_out");
  const padded = classifySmsConsentKeyword("  stop  ");
  check(`"  stop  " (whitespace-padded) → opt_out`, padded?.kind === "opt_out");

  console.log("\n— 2. Opt-in + help families —");
  for (const kw of SMS_OPT_IN_KEYWORDS) {
    const m = classifySmsConsentKeyword(kw.toLowerCase());
    check(`"${kw.toLowerCase()}" → opt_in`, m?.kind === "opt_in" && m.keyword === kw);
  }
  for (const kw of SMS_HELP_KEYWORDS) {
    const m = classifySmsConsentKeyword(kw.toLowerCase());
    check(`"${kw.toLowerCase()}" → help`, m?.kind === "help" && m.keyword === kw);
  }
  check(`matchedVia is "body" for direct matches`, classifySmsConsentKeyword("STOP")?.matchedVia === "body");

  console.log("\n— 3. Non-keywords never match —");
  const nonKeywords = [
    "can you stop by tomorrow", // multi-word — the critical false-positive guard
    "please stop",
    "stopping",
    "I want to unsubscribe from this",
    "started",
    "helpful",
    "",
    "   ",
    "thanks!",
  ];
  for (const body of nonKeywords) {
    check(`"${body}" → null`, classifySmsConsentKeyword(body) === null);
  }
  check(`null body → null`, classifySmsConsentKeyword(null) === null);
  check(`undefined body → null`, classifySmsConsentKeyword(undefined) === null);
  // Opt-in/help are deliberately punctuation-strict (only opt-out tolerates
  // trailing punctuation — the conservative direction for compliance).
  check(`"start." → null (opt-in is punctuation-strict)`, classifySmsConsentKeyword("start.") === null);

  console.log("\n— 4. Twilio OptOutType edge hint fallback —");
  const hintStop = classifySmsConsentKeyword("remove me from this list", "STOP");
  check(
    `multi-word body + hint STOP → opt_out via hint`,
    hintStop?.kind === "opt_out" && hintStop.matchedVia === "opt_out_type_hint" && hintStop.keyword === "STOP",
  );
  const hintStart = classifySmsConsentKeyword("sign me back up", "START");
  check(`hint START → opt_in via hint`, hintStart?.kind === "opt_in" && hintStart.matchedVia === "opt_out_type_hint");
  const hintHelp = classifySmsConsentKeyword("what is this", "HELP");
  check(`hint HELP → help via hint`, hintHelp?.kind === "help" && hintHelp.matchedVia === "opt_out_type_hint");
  const bodyWins = classifySmsConsentKeyword("STOP", "HELP");
  check(`body keyword beats a conflicting hint`, bodyWins?.kind === "opt_out" && bodyWins.matchedVia === "body");
  check(`unknown hint value → null`, classifySmsConsentKeyword("hello there", "WHATEVER") === null);
  check(`hint on a plain message only (no hint) → null`, classifySmsConsentKeyword("hello there", null) === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
