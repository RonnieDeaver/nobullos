/* test-registration
{
  "name": "Daily judgment honest prompt builders — no-data-aware report block, full-window comm representation, digest lines (Task #4048)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4048: pure, DB-free policy core of the honest-inputs fix — the report block must never fabricate zeros/NaN% for no-data metrics and the comm sections must represent EVERY window communication; the DB grain/e2e side gates via the sweep (tests/daily-judgment-comm-grain.test.ts)",
  "timeoutMs": 60000,
  "tier": "small"
}
test-registration */
/**
 * Task #4048 — pure unit coverage for the two rebuilt prompt sections:
 *
 *  1. buildLatestReportSection: renders metric-presence-aware lines on the
 *     shared helpers (shared/reportMetrics.ts) — a metric that was never
 *     entered (legacy blank-coerced 0) or explicitly No-Data-flagged comes
 *     out as an explicit "no data … NOT as zero" line, never "0 leads" or
 *     "NaN%"; stored 0-100 rates render as-is (the old block multiplied by
 *     100 again); the section carries the supersede-prior-claims guard.
 *  2. buildJudgmentCommSections: every communication in the analyzed window
 *     is represented — full detail up to the budget, then one-line digests
 *     for the remainder — and the section says so, instead of the old
 *     "…and N additional (summarized in knowledge context above)" line that
 *     claimed coverage the prompt did not contain.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import {
  buildLatestReportSection,
  buildJudgmentCommSections,
  formatCommunicationDigest,
  type CommWithPerClientSummary,
} from "../server/services/dailyJudgment";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ─── report section ──────────────────────────────────────────────────────────

function report(sections: Record<string, unknown>): any {
  return { reportId: "r1", reportMonth: "2026-07", updatedAt: null, sections };
}

function testReportSection(): void {
  console.log("\nbuildLatestReportSection:");

  check("null report → empty (no section)", buildLatestReportSection(null).length === 0);

  // Legacy blank-coerced zeros with no flags: nothing was entered.
  const legacyZeros = buildLatestReportSection(
    report({
      intake: { totalLeads: 0, totalConsults: 0, leadToConsultRate: 0 },
      sales: { totalConsults: 0, totalCases: 0, consultToCaseRate: 0, noShowRate: 0 },
      marketing: {},
    }),
  ).join("\n");
  check("legacy zeros → intake consults render as no-data", /consults booked: no data/.test(legacyZeros), legacyZeros);
  check("legacy zeros → no '0 consults' fabrication", !/: 0[,;]/.test(legacyZeros) && !/ 0 consults/.test(legacyZeros), legacyZeros);
  check("legacy zeros → no NaN anywhere", !legacyZeros.includes("NaN"));
  check("legacy zeros → lead volume is no-data (no evidence)", /Lead volume \(marketing\): no data/.test(legacyZeros));
  check("legacy zeros → no-show rate no-data (no entry tracking era)", /no-show rate: no data/.test(legacyZeros));
  check("supersede guard present", legacyZeros.includes("SUPERSEDES any metric claims in prior judgments"));
  check("guard says unknown-not-zero", legacyZeros.includes("never as zero and never as evidence"));

  // Explicit No-Data flags beat positive stored values.
  const flagged = buildLatestReportSection(
    report({
      intake: { totalConsults: 8, leadToConsultRate: 40, noDataFlags: { totalConsults: true } },
    }),
  ).join("\n");
  check("No-Data flag suppresses a positive stored consults value", /consults booked: no data/.test(flagged), flagged);
  check("No-Data flag suppresses the dependent rate too", /conversion: no data/.test(flagged), flagged);

  // Entered metrics render the STORED percent (0-100), not ×100.
  const entered = buildLatestReportSection(
    report({
      intake: { totalConsults: 12, leadToConsultRate: 24.5, noDataFlags: { totalConsults: false } },
      sales: {
        totalConsults: 10,
        totalCases: 3,
        consultToCaseRate: 30,
        noShowRate: 0,
        noDataFlags: { totalConsults: false, totalCases: false, noShowRate: false },
      },
      marketing: { totalLeads: 70, googleAdsLeads: 25 },
    }),
  ).join("\n");
  check("consults render when entered", entered.includes("consults booked: 12"));
  check("rate renders stored percent (24.5%, not 2450.0%)", entered.includes("24.5%") && !entered.includes("2450"), entered);
  check("close rate 30.0%", entered.includes("30.0%"));
  check("entry-tracked noShowRate 0 is a REAL 0.0% measurement", /no-show rate: 0\.0%/.test(entered), entered);
  check("lead volume renders with evidence", entered.includes("70 total leads"));

  // GBP: locations with no lead evidence must not claim "0 leads".
  const gbpNoData = buildLatestReportSection(
    report({
      marketing: {
        totalLeads: 0,
        gbp: { locations: [{ name: "A", uniqueLeads: 0 }, { name: "B" }] },
      },
    }),
  ).join("\n");
  check("GBP all-zero locations → explicit no-lead-data line", gbpNoData.includes("GBP: no lead data recorded for 2 location(s)"), gbpNoData);
  check("GBP all-zero → never 'GBP: 0 leads'", !gbpNoData.includes("GBP: 0 leads"));

  const gbpReal = buildLatestReportSection(
    report({
      marketing: { gbp: { locations: [{ uniqueLeads: 5 }, { uniqueLeads: 2 }] } },
    }),
  ).join("\n");
  check("GBP with evidence sums real leads", gbpReal.includes("GBP: 7 leads across 2 location(s)"), gbpReal);
  check("GBP evidence also satisfies lead-volume evidence", gbpReal.includes("Lead volume"));

  // Google Ads: enabled with all-zero values = nothing entered; partial data
  // renders per-field no-data instead of "undefined".
  const adsZero = buildLatestReportSection(
    report({ marketing: { googleAdsEnabled: true, googleAds: { uniqueLeads: 0, adSpend: 0 } } }),
  ).join("\n");
  check("ads enabled + all zeros → no metrics entered line", adsZero.includes("Google Ads: enabled, but no metrics entered"), adsZero);

  const adsReal = buildLatestReportSection(
    report({ marketing: { totalLeads: 12, googleAdsEnabled: true, googleAds: { uniqueLeads: 12, adSpend: 3400 } } }),
  ).join("\n");
  check("ads real data renders", adsReal.includes("Google Ads: 12 leads") && adsReal.includes("$3400 spend"), adsReal);
  check("ads absent CPL renders as no-data, never undefined", adsReal.includes("CPL: no data") && !adsReal.includes("undefined"), adsReal);

  // Ads disabled → no ads line at all.
  const adsDisabled = buildLatestReportSection(
    report({ marketing: { googleAds: { uniqueLeads: 9 }, googleAdsEnabled: false } }),
  ).join("\n");
  check("ads disabled → no Google Ads line", !adsDisabled.includes("Google Ads:"));
}

// ─── comm sections ───────────────────────────────────────────────────────────

function comm(i: number, ts: Date, extra: Partial<CommWithPerClientSummary> = {}): CommWithPerClientSummary {
  return {
    id: `c${i}`,
    timestamp: ts,
    sourceType: "front_email",
    sourceSubtype: "email_message",
    direction: i % 2 === 0 ? "inbound" : "outbound",
    title: `UniqueComm${i}`,
    contentPreview: `Preview body for comm ${i}`,
    ...extra,
  } as unknown as CommWithPerClientSummary;
}

function testCommSections(): void {
  console.log("\nbuildJudgmentCommSections:");

  const now = Date.now();
  const recent = (i: number) => new Date(now - i * 60_000); // within 24h
  const older = (i: number) => new Date(now - (2 + i) * 24 * 60 * 60 * 1000);

  // 25 comms in last 24h (budget 20 without knowledge ctx) + 60 older
  // (budget 15) — every single one must appear.
  const last24h = Array.from({ length: 25 }, (_, i) => comm(i, recent(i)));
  const olderComms = Array.from({ length: 60 }, (_, i) => comm(100 + i, older(i)));
  const windowComms = [...last24h, ...olderComms];

  const text = buildJudgmentCommSections(last24h, windowComms, false).join("\n");

  check("24h header counts all records", text.includes("=== LAST 24 HOURS COMMUNICATIONS (25 records) ==="));
  check("older header counts all records", text.includes("EARLIER IN THE ANALYZED WINDOW — LAST 30 DAYS (60 additional records)"));

  const missing = windowComms.filter((c) => !text.includes((c as any).title));
  check("EVERY window communication is represented", missing.length === 0, `missing: ${missing.map((m) => (m as any).title).slice(0, 5).join(",")}`);

  check("digest header for 24h overflow", text.includes("Remaining 5 last-24h communication(s), one line each:"));
  check("digest header for older overflow", text.includes("Remaining 45 earlier communication(s) in the window, one line each:"));
  check("closing full-representation line with true total", text.includes("All 85 communication(s) in the analyzed 30-day window are represented above"), text.slice(-300));
  check("no lying 'summarized in knowledge context' line", !text.includes("summarized in knowledge context") && !text.includes("patterns captured in knowledge context"));

  // Knowledge-context budgets shrink but representation stays total.
  const textK = buildJudgmentCommSections(last24h, windowComms, true).join("\n");
  const missingK = windowComms.filter((c) => !textK.includes((c as any).title));
  check("knowledge-context budgets still represent everything", missingK.length === 0);
  check("knowledge-context 24h digest count", textK.includes("Remaining 15 last-24h communication(s), one line each:"));

  // Empty window: no closing line, honest empty 24h.
  const empty = buildJudgmentCommSections([], [], false).join("\n");
  check("empty window has no 'represented above' line", !empty.includes("represented above"));
  check("empty window states no comms", empty.includes("No communications in the last 24 hours."));

  // Digest line format.
  const d = formatCommunicationDigest(
    comm(7, new Date("2026-07-15T12:00:00Z"), { isMultiClient: true, title: "T".repeat(120) } as any),
  );
  check("digest carries source/subtype", d.includes("[front_email/email_message]"));
  check("digest carries ISO date", d.includes("2026-07-15"));
  check("digest truncates long titles to 90 chars", d.includes("T".repeat(90)) && !d.includes("T".repeat(91)));
  check("digest flags multi-client comms", d.includes("[multi-client]"));

  const dBare = formatCommunicationDigest(comm(8, new Date("2026-07-15T12:00:00Z"), { title: null, direction: null, sourceSubtype: null } as any));
  check("digest tolerates null title/direction/subtype", dBare.includes("(untitled)") && dBare.includes("[front_email]"), dBare);
}

function main(): void {
  testReportSection();
  testCommSections();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
