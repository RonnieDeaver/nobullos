/* test-registration
{
  "name": "Daily judgment calibration pure helpers — business-day silence, severity rubric, lifetime context, operator intel sections, fingerprint sensitivity (Task #4292)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4292: the churn-board calibration core. Business-day silence is the authoritative silence measure (Fri→Mon = 1 business day, weekend-only = 0 — a drift re-opens the 'weekend narrated as intentional avoidance' bug); the system prompt must keep the tier definitions (Critical = RARE + explicit churn signals), risk-score anchors, motive-attribution ban, and operator-intel hard rules that fixed the 46/56-Critical alarmism; the lifetime-context and operator-intel prompt sections are how the judge sees tenure/cadence/trajectory and human notes at all; and the inputs fingerprint must move when intel/lifetime/trajectory move (else new intel never breaks carry-forward and a resolved concern keeps re-surfacing). Pure functions, DB-free, fast.",
  "tier": "small"
}
test-registration */
/**
 * Task #4292 — churn judgment calibration: pure helper rules.
 *
 * Four policy surfaces, all pure and DB-free:
 *
 *   1. `computeBusinessDaySilence` — Mon–Fri (UTC) days strictly after the
 *      last-comm date up to and including the judgment date. Friday→Monday
 *      is 1; a Saturday-judged Friday sender is 0; weekends never count.
 *      This is what stops "3 days of silence spanning a weekend" from being
 *      narrated as avoidance.
 *   2. `getSystemPrompt` — the severity rubric: explicit tier definitions
 *      (Critical RARE and reserved for explicit churn/cancel signals or
 *      severe failure + client-expressed dissatisfaction), risk-score
 *      anchoring bands, the motive-attribution ban ("intentional
 *      avoidance"/"ghosting" banned unless the client said it), silence
 *      calibration (0-3 business days never a concern), whatChanged honesty
 *      ("No material change" instead of re-escalation), operator-intel hard
 *      rules, and the removal of the old drama-amplifying "Opinionated —
 *      take a position" tone directive.
 *   3. `buildLifetimeContextSection` / `buildOperatorIntelSection` — the
 *      prompt sections that give the judge tenure, cadence baseline,
 *      long-run trajectory (with the standing-issue instruction) and
 *      human-filed intel (with RESOLVED/CONTEXT labels). Empty-input rules:
 *      no lifetime/trajectory/history → [] ; no intel → [] (absence of
 *      intel is normal, not a data gap).
 *   4. `computeInputsFingerprint` — carry-forward must break when intel is
 *      added (count or latestAt moves), when the trajectory gains a
 *      completed month, or when the lifetime aggregate moves; and must NOT
 *      depend on anything time-derived beyond the existing weekly silence
 *      bucket (same inputs → same hash, stable across calls).
 *   5. `buildJudgmentBasis` / `buildDataAvailabilityManifest` — the stored
 *      basis labels and manifest lines that surface lifetime history,
 *      operator intel (authoritative), the business-day silence note, and
 *      the recency line's "0–3 business days are normal cadence" rule.
 *
 * DB-free logic, but importing the service module warms the pg pools
 * through its storage imports, so the suite closes them for a natural
 * drain (same pattern as tests/daily-judgment-tiering-pure.test.ts).
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import {
  buildDataAvailabilityManifest,
  buildJudgmentBasis,
  buildLifetimeContextSection,
  buildOperatorIntelSection,
  computeBusinessDaySilence,
  computeInputsFingerprint,
  getSystemPrompt,
  type JudgmentDataInventory,
  type JudgmentSourceSignals,
} from "../server/services/dailyJudgment";
import type { ClientConcernIntel } from "@shared/models/dailyJudgment";
import { closeDbPools } from "../server/db";

let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err?.message ?? err}`);
  }
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(haystack: string, needle: string, msg: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${msg}: expected to find ${JSON.stringify(needle)}`);
  }
}

function assertNotIncludes(haystack: string, needle: string, msg: string): void {
  if (haystack.includes(needle)) {
    throw new Error(`${msg}: expected NOT to find ${JSON.stringify(needle)}`);
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function baseSources(): JudgmentSourceSignals {
  return {
    comms: { count24h: 1, count7d: 4, count30d: 12, lastCommAt: "2026-08-07T15:00:00.000Z" },
    report: { reportId: "rep-1", month: "2026-07", updatedAt: "2026-08-01T00:00:00.000Z" },
    commandPanel: { lastUpdatedAt: "2026-08-01T00:00:00.000Z", lastReviewedAt: null },
    knowledge: { totalFacts: 5, latestFactSeenAt: "2026-08-01T00:00:00.000Z" },
    openAsks: { activeCount: 2, latestUpdatedAt: "2026-08-05T00:00:00.000Z" },
    ris: { resultCount: 0, latest: [] },
    lifetime: {
      firstCommAt: "2024-03-15T10:00:00.000Z",
      totalComms: 480,
      inboundComms: 210,
      outboundComms: 270,
      comms90d: 36,
      longestGapDays: 21,
    },
    trajectory: [
      { month: "2026-07", endStatus: "Watch", avgRisk: 38, days: 22 },
      { month: "2026-06", endStatus: "Watch", avgRisk: 35, days: 21 },
    ],
    reportHistory: [
      { month: "2026-07", leads: 14, reviews: 6 },
      { month: "2026-06", leads: 18, reviews: null },
    ],
    intel: { count90d: 0, latestAt: null },
  };
}

function inventoryFor(
  sources: JudgmentSourceSignals,
  overrides: Partial<JudgmentDataInventory> = {},
): JudgmentDataInventory {
  return {
    version: 2,
    tier: "full",
    generatedAt: "2026-08-10T12:00:00.000Z",
    inputsFingerprint: "x",
    basedOn: buildJudgmentBasis(sources, 3).basedOn,
    missing: buildJudgmentBasis(sources, 3).missing,
    silenceDays: 3,
    businessDaySilence: 1,
    sources,
    ...overrides,
  };
}

// ── 1. computeBusinessDaySilence ────────────────────────────────────────────

console.log("\ncomputeBusinessDaySilence:");

check("Friday last-comm judged Monday = 1 business day (weekend excluded)", () => {
  // 2026-08-07 is a Friday, 2026-08-10 a Monday.
  assertEq(
    computeBusinessDaySilence("2026-08-07T16:00:00.000Z", new Date("2026-08-10T09:00:00.000Z")),
    1,
    "Fri→Mon",
  );
});

check("Friday last-comm judged Saturday/Sunday = 0 (weekend-only gap)", () => {
  assertEq(
    computeBusinessDaySilence("2026-08-07T16:00:00.000Z", new Date("2026-08-08T09:00:00.000Z")),
    0,
    "Fri→Sat",
  );
  assertEq(
    computeBusinessDaySilence("2026-08-07T16:00:00.000Z", new Date("2026-08-09T23:00:00.000Z")),
    0,
    "Fri→Sun",
  );
});

check("same-day comm = 0; null/invalid lastCommAt = null", () => {
  assertEq(
    computeBusinessDaySilence("2026-08-10T08:00:00.000Z", new Date("2026-08-10T18:00:00.000Z")),
    0,
    "same day",
  );
  assertEq(computeBusinessDaySilence(null, new Date("2026-08-10T00:00:00.000Z")), null, "null");
  assertEq(
    computeBusinessDaySilence("not-a-date", new Date("2026-08-10T00:00:00.000Z")),
    null,
    "invalid",
  );
});

check("full calendar week = 5 business days; two weeks = 10", () => {
  // Mon 2026-07-27 → Mon 2026-08-03 spans one weekend.
  assertEq(
    computeBusinessDaySilence("2026-07-27T12:00:00.000Z", new Date("2026-08-03T12:00:00.000Z")),
    5,
    "one week",
  );
  assertEq(
    computeBusinessDaySilence("2026-07-27T12:00:00.000Z", new Date("2026-08-10T12:00:00.000Z")),
    10,
    "two weeks",
  );
});

check("UTC date boundaries drive the count, not time-of-day", () => {
  // Late-Friday-UTC comm and early-Monday-UTC judgment still bracket the
  // same weekend: strictly-after-Friday through Monday inclusive = Mon only.
  assertEq(
    computeBusinessDaySilence("2026-08-07T23:59:59.000Z", new Date("2026-08-10T00:00:01.000Z")),
    1,
    "boundary times",
  );
});

// ── 2. getSystemPrompt — the severity rubric ────────────────────────────────

console.log("\ngetSystemPrompt severity rubric:");

const prompt = getSystemPrompt();

check("tier definitions present, Critical explicitly RARE and evidence-gated", () => {
  assertIncludes(prompt, "STATUS TIER DEFINITIONS", "tier header");
  assertIncludes(prompt, '"Critical": RARE and reserved', "critical rare");
  assertIncludes(prompt, "explicit churn or cancellation signals", "critical requires churn signals");
  assertIncludes(
    prompt,
    "Critical must NEVER be produced by silence alone, missing data, weekend gaps, or accumulated small concerns",
    "critical never from silence",
  );
  assertIncludes(prompt, "Watch is the correct home for uncertainty", "watch = ambiguity home");
  assertIncludes(prompt, "most accounts should land Healthy or Watch", "portfolio expectation");
});

check("server-owned risk uses non-overlapping tier bands", () => {
  assertIncludes(prompt, "RATING PROPOSALS ARE ADVISORY", "advisory header");
  assertIncludes(prompt, "Healthy 0-24", "healthy band");
  assertIncludes(prompt, "Watch 25-49", "watch band");
  assertIncludes(prompt, "At Risk 50-74", "at-risk band");
  assertIncludes(prompt, "Critical 75-100", "critical band");
});

check("motive-attribution ban is a hard rule", () => {
  assertIncludes(prompt, "NEVER attribute motive or intent the client did not state", "motive ban");
  assertIncludes(prompt, '"intentional avoidance"', "names the banned phrase");
  assertIncludes(prompt, '"ghosting"', "names ghosting");
});

check("silence calibration: business days authoritative, 0-3 never a concern, client's own baseline", () => {
  assertIncludes(prompt, "SILENCE CALIBRATION", "silence header");
  assertIncludes(prompt, "Weekends and holidays are NOT silence and NEVER avoidance", "weekend rule");
  assertIncludes(prompt, "0-3 business days without contact is normal cadence", "0-3 rule");
  assertIncludes(prompt, "THIS client's own baseline", "own-baseline rule");
});

check("whatChanged honesty: standing issues are not re-escalated", () => {
  assertIncludes(prompt, '"whatChanged" honesty', "honesty header");
  assertIncludes(prompt, "No material change", "no-change line");
  assertIncludes(prompt, "Do NOT re-narrate standing issues as new", "no re-narration");
});

check("operator-intel hard rules present (resolved concerns stay resolved)", () => {
  assertIncludes(prompt, "Operator intel rules", "intel header");
  assertIncludes(prompt, "OUTRANKS your own inference", "outranks rule");
  assertIncludes(
    prompt,
    "must NOT re-surface as an unaddressed concern unless CLIENT evidence dated AFTER the resolution note contradicts it",
    "resolved rule",
  );
  assertIncludes(prompt, "CONTEXT intel must temper your framing", "context rule");
});

check("drama-amplifying tone directives are gone; measured tone in", () => {
  assertNotIncludes(prompt, "Opinionated", "old opinionated directive removed");
  assertIncludes(prompt, "Measured and evidence-grounded", "measured tone");
  assertNotIncludes(prompt, "not dramatic, not robotic".slice(0, 0) + "we keep the money", "no money speculation seed");
});

check("churn-evidence classification: fixed vocabulary, verbatim citations, server-owned outcomes", () => {
  assertIncludes(prompt, "CHURN EVIDENCE CLASSIFICATION (hard rules — server code enforces these):", "section header");
  assertIncludes(prompt, "Your tier proposal is advisory", "model no longer owns the tier");
  assertIncludes(prompt, "VERBATIM quote (copy the exact words)", "verbatim rule");
  assertIncludes(prompt, "Do not quote prior judgments or agent-memory context as evidence", "no laundering rule");
  // The client-said vs we-said line: our own write-off vocabulary is a
  // hygiene gap, never client churn language.
  assertIncludes(prompt, '"effectively churned", "functionally churned", "should offboard") are "internal_hygiene_gap"', "we-said rule");
  assertIncludes(prompt, "Never a client signal", "hygiene definition");
  // Atomic author provenance + corroboration are server-enforced.
  assertIncludes(prompt, "Provenance is enforced mechanically too", "provenance rule header");
  assertIncludes(prompt, "An INBOUND direction or communication title/subject does NOT prove who authored", "direction/subject exclusion");
  assertIncludes(prompt, "require directly client-authored Content whose sender matches the client's known contact identity", "client-author rule");
  assertIncludes(prompt, "forwarded/quoted text, automated alerts, third-party reviews", "forwarded/third-party exclusion");
  assertIncludes(prompt, "cannot become client dissatisfaction, service failure, or Critical evidence", "risk-category exclusion");
  assertIncludes(prompt, `"not tracked" and "no data" lines never support decline`, "untracked metric exclusion");
  assertIncludes(prompt, 'automatically reclassified to "internal_hygiene_gap" wherever it appears', "write-off auto-reclass rule");
  assertIncludes(prompt, "at least TWO independent, differently-worded client communication fragments", "corroboration rule");
  assertIncludes(prompt, "never a one-off question or backlog row", "repeated ask rule");
  assertIncludes(prompt, "Server-computed history must independently confirm the decline", "measured decline rule");
  assertIncludes(prompt, 'Authoritative outcomes the server enforces: internal_hygiene_gap / other_negative alone → "Watch"', "watch outcome");
  assertIncludes(prompt, '"Critical" requires a current validated explicit_churn_language, competitor_switch, billing_or_legal_escalation, or corroborated_loss_signal citation', "critical requirement");
  assertIncludes(prompt, "Do not inflate your proposal to compensate", "anti-gaming line");
  assertIncludes(prompt, '"churnEvidence": [', "response schema carries churnEvidence");
  assertIncludes(prompt, "VERBATIM text copied character-for-character", "schema quote rule");
});

check("standing-issue decay and missing-data rules are hard rules (Task #4761)", () => {
  assertIncludes(prompt, "Standing-issue decay (hard rule)", "decay header");
  assertIncludes(prompt, "must DECAY", "decay rule");
  assertIncludes(prompt, "Never re-escalate or hold peak risk on an unchanged issue", "no peak-hold rule");
  assertIncludes(prompt, 'NEVER evidence of client churn or delivery decline', "missing-data rule");
});

// ── 3. Lifetime-context + operator-intel prompt sections ───────────────────

console.log("\nbuildLifetimeContextSection:");

check("full lifetime fixture renders tenure, totals, cadence, gap, trajectory, history", () => {
  const text = buildLifetimeContextSection(baseSources(), "2026-08-10").join("\n");
  assertIncludes(text, "=== LIFETIME RELATIONSHIP CONTEXT ===", "header");
  assertIncludes(text, "against THEIR OWN history", "own-history rule");
  assertIncludes(text, "first matched communication 2024-03-15", "tenure date");
  assertIncludes(text, "All-time communications: 480 (210 inbound / 270 outbound)", "totals");
  assertIncludes(text, "/week lifetime average", "weekly lifetime");
  assertIncludes(text, "over the last 90 days", "weekly 90d");
  assertIncludes(text, "Longest historical gap between communications: 21 days", "longest gap");
  assertIncludes(text, "- 2026-07: Watch (avg risk 38, 22 judgments)", "trajectory row");
  assertIncludes(text, "STANDING issue", "standing-issue instruction");
  assertIncludes(text, "do not re-escalate it as new", "no re-escalation");
  assertIncludes(text, "- 2026-07: leads 14, reviews 6", "report history row");
  assertIncludes(text, "- 2026-06: leads 18, reviews n/a", "report history null → n/a");
});

check("weekly averages derive from stored raw counts (not stored ratios)", () => {
  // tenure 2024-03-15 → 2026-08-10 ≈ 878 days; 480/(878/7) ≈ 3.8/week;
  // 36/(90/7) = 2.8/week. Pin the rendered numbers so a silent switch to
  // stored ratios (which would drift the fingerprint daily) shows up here.
  const text = buildLifetimeContextSection(baseSources(), "2026-08-10").join("\n");
  assertIncludes(text, "~3.8/week lifetime average", "lifetime weekly");
  assertIncludes(text, "~2.8/week over the last 90 days", "90d weekly");
});

check("no lifetime/trajectory/history → empty section (no fabricated context)", () => {
  const s = baseSources();
  s.lifetime = null;
  s.trajectory = [];
  s.reportHistory = [];
  assertEq(buildLifetimeContextSection(s, "2026-08-10").length, 0, "empty");
});

check("standing-issue line carries the decay rule (Task #4761)", () => {
  const text = buildLifetimeContextSection(baseSources(), "2026-08-10").join("\n");
  assertIncludes(text, "must DECAY", "decay rule in trajectory guidance");
  assertIncludes(text, "must never hold risk at peak on its own", "no peak-hold");
});

check("pre-calibration trajectory months are excluded with an explicit unreliable-era note (Task #4761)", () => {
  const s = baseSources();
  s.trajectoryExcludedMonths = 5;
  const text = buildLifetimeContextSection(s, "2026-08-10").join("\n");
  assertIncludes(text, "EXCLUDED as unreliable-era", "exclusion note");
  assertIncludes(text, "miscalibrated judge", "names the cause");
  assertIncludes(text, "Do NOT anchor today's tier or risk on that era", "anti-anchor instruction");
  // Calibrated months still render normally alongside the note.
  assertIncludes(text, "- 2026-07: Watch (avg risk 38, 22 judgments)", "calibrated rows kept");
});

check("exclusion note renders even when NO calibrated trajectory months exist yet", () => {
  // The first post-calibration judgment for a long-tenured client: every
  // prior month is unreliable-era, so trajectory is empty but the section
  // must still tell the model that history was withheld deliberately —
  // even when lifetime/reportHistory are ALSO empty (the guard case).
  const s = baseSources();
  s.lifetime = null;
  s.trajectory = [];
  s.reportHistory = [];
  s.trajectoryExcludedMonths = 12;
  const text = buildLifetimeContextSection(s, "2026-08-10").join("\n");
  assertIncludes(text, "12 earlier completed months of judgment history are EXCLUDED as unreliable-era", "note without calibrated months");
  assertIncludes(text, "do not re-escalate it as new", "standing-issue guidance still attaches to the note");
});

console.log("\nbuildOperatorIntelSection:");

const INTEL_ROWS: ClientConcernIntel[] = [
  {
    id: "i-1",
    clientId: "c-1",
    judgmentId: "j-1",
    concernText: "Three emails unanswered for over a week",
    intelType: "resolved",
    note: "Called Tuesday — campaign approved, client satisfied.",
    createdBy: "u-1",
    createdAt: new Date("2026-08-06T14:00:00.000Z"),
  },
  {
    id: "i-2",
    clientId: "c-1",
    judgmentId: null,
    concernText: "Lead volume dropped month-over-month",
    intelType: "context",
    note: "Client paused ads for their office move; expected through September.",
    createdBy: "u-1",
    createdAt: new Date("2026-08-01T09:00:00.000Z"),
  },
];

check("intel entries render with RESOLVED/CONTEXT labels, dates, and hard rules", () => {
  const text = buildOperatorIntelSection(INTEL_ROWS).join("\n");
  assertIncludes(text, "=== OPERATOR INTEL (human-verified, last 90 days) ===", "header");
  assertIncludes(text, "OUTRANKS your own inference", "authority");
  assertIncludes(
    text,
    '[RESOLVED 2026-08-06] Concern: "Three emails unanswered for over a week" — Operator note: Called Tuesday — campaign approved, client satisfied.',
    "resolved entry",
  );
  assertIncludes(
    text,
    '[CONTEXT 2026-08-01] Concern: "Lead volume dropped month-over-month"',
    "context entry",
  );
  assertIncludes(text, "must NOT appear in your \"concerns\" as unaddressed", "resolved hard rule");
  assertIncludes(text, "CONTEXT notes must temper your framing", "context hard rule");
});

check("no intel → empty section (absence of intel is normal)", () => {
  assertEq(buildOperatorIntelSection([]).length, 0, "empty");
});

// ── 4. Fingerprint sensitivity ──────────────────────────────────────────────

console.log("\ncomputeInputsFingerprint sensitivity:");

check("same inputs → same hash (stable, no time-derived drift)", () => {
  const a = computeInputsFingerprint(baseSources(), 3);
  const b = computeInputsFingerprint(baseSources(), 3);
  assertEq(a, b, "deterministic");
});

check("adding operator intel breaks carry-forward (count and latestAt both fingerprinted)", () => {
  const base = computeInputsFingerprint(baseSources(), 3);
  const withIntel = baseSources();
  withIntel.intel = { count90d: 1, latestAt: "2026-08-10T10:00:00.000Z" };
  const a = computeInputsFingerprint(withIntel, 3);
  if (a === base) throw new Error("intel count change did not change the fingerprint");
  // Same count, newer note (e.g. one intel aged out of 90d while another was
  // filed) must ALSO break carry-forward — latestAt is fingerprinted too.
  const newer = baseSources();
  newer.intel = { count90d: 1, latestAt: "2026-08-10T11:00:00.000Z" };
  const b = computeInputsFingerprint(newer, 3);
  if (a === b) throw new Error("intel latestAt change did not change the fingerprint");
});

check("a new completed trajectory month breaks carry-forward", () => {
  const base = computeInputsFingerprint(baseSources(), 3);
  const s = baseSources();
  s.trajectory = [{ month: "2026-08", endStatus: "Watch", avgRisk: 40, days: 20 }, ...s.trajectory];
  if (computeInputsFingerprint(s, 3) === base) {
    throw new Error("trajectory month did not change the fingerprint");
  }
});

check("lifetime aggregate movement breaks carry-forward", () => {
  const base = computeInputsFingerprint(baseSources(), 3);
  const s = baseSources();
  s.lifetime = { ...s.lifetime!, totalComms: 481, comms90d: 37 };
  if (computeInputsFingerprint(s, 3) === base) {
    throw new Error("lifetime change did not change the fingerprint");
  }
});

check("report-metric history movement breaks carry-forward", () => {
  const base = computeInputsFingerprint(baseSources(), 3);
  const s = baseSources();
  s.reportHistory = [{ month: "2026-08", leads: 9, reviews: 2 }, ...s.reportHistory];
  if (computeInputsFingerprint(s, 3) === base) {
    throw new Error("reportHistory change did not change the fingerprint");
  }
});

check("trajectory-exclusion count movement breaks carry-forward (Task #4761)", () => {
  // When a month flips from calibrated to excluded (or the exclusion set
  // grows as old months age in), the prompt's trajectory section changes —
  // a carried-forward judgment would keep narrating history the prompt no
  // longer shows.
  const base = computeInputsFingerprint(baseSources(), 3);
  const s = baseSources();
  s.trajectoryExcludedMonths = 4;
  if (computeInputsFingerprint(s, 3) === base) {
    throw new Error("trajectoryExcludedMonths change did not change the fingerprint");
  }
});

// ── 5. Basis labels + manifest wording ──────────────────────────────────────

console.log("\nbuildJudgmentBasis / buildDataAvailabilityManifest:");

check("basis basedOn gains lifetime/trajectory/history/intel labels", () => {
  const s = baseSources();
  s.intel = { count90d: 2, latestAt: "2026-08-08T00:00:00.000Z" };
  const { basedOn } = buildJudgmentBasis(s, 3);
  const joined = basedOn.join(" | ");
  assertIncludes(joined, "lifetime history (480 comms since 2024-03-15)", "lifetime label");
  assertIncludes(joined, "2 months judgment trajectory", "trajectory label");
  assertIncludes(joined, "2-month report history", "report-history label");
  assertIncludes(joined, "operator intel (2 notes, 90d)", "intel label");
});

check("absence of intel is never 'missing data'", () => {
  const { missing } = buildJudgmentBasis(baseSources(), 3);
  assertEq(missing.some((m) => m.toLowerCase().includes("intel")), false, "no intel in missing");
});

check("manifest lists lifetime + intel lines and the comms recency business-day rule", () => {
  const s = baseSources();
  s.intel = { count90d: 1, latestAt: "2026-08-08T00:00:00.000Z" };
  const manifest = buildDataAvailabilityManifest(inventoryFor(s));
  assertIncludes(
    manifest,
    "- Lifetime history: 480 communications since 2024-03-15 (see LIFETIME RELATIONSHIP CONTEXT)",
    "lifetime manifest line",
  );
  assertIncludes(
    manifest,
    "- Operator intel: 1 human-filed note in the last 90 days (see OPERATOR INTEL — it is authoritative)",
    "intel manifest line",
  );
  assertIncludes(
    manifest,
    "Recency: last matched communication 3 calendar days ago (1 business day). Gaps of 0–3 business days are normal cadence — never a silence concern.",
    "recency line",
  );
});

check("zero-comms silence line carries the business-day note and cadence-baseline rule", () => {
  const s = baseSources();
  s.comms = { count24h: 0, count7d: 0, count30d: 0, lastCommAt: "2026-07-01T00:00:00.000Z" };
  const inv = inventoryFor(s, { silenceDays: 40, businessDaySilence: 28, tier: "operational" });
  const manifest = buildDataAvailabilityManifest(inv);
  assertIncludes(
    manifest,
    "Silence: no matched communications for 40 calendar days (28 business days — weekends are not silence).",
    "silence line",
  );
  assertIncludes(manifest, "own cadence baseline", "baseline rule");
  assertIncludes(manifest, "Never invent sentiment or motive from silence", "no-motive rule");
});

// ── Wrap up ─────────────────────────────────────────────────────────────────

closeDbPools()
  .catch(() => {})
  .finally(() => {
    if (failures > 0) {
      console.error(`\n${failures} calibration test step(s) FAILED`);
      process.exitCode = 1;
    } else {
      console.log("\nAll daily-judgment-calibration tests passed");
    }
  });
