/* test-registration
{
  "name": "Junk-fed fake Sales Common Issues — import gate, capture bounds, serve suppression, cleanup (Task #3901)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3901: broken Looker Sales Common Issues components made the parser swallow the placeholder PLUS ~500 chars of trailing dashboard junk (Wanta Thome 2026-07); the junk-tailed capture evaded the placeholder-only gate, the AI formatter fabricated 11 fake 🔴 findings from the junk, and the result evaded the serve-time suppressor and the CEO cleanup action (126 poisoned rows in prod, several final/shared). Covers the begins-with import gate, the bounded sales/intake capture (anti-swallow), the junk-fabricated/junk-tailed stored-value classes, serve/cleanup predicate lockstep, and the real-prose false-positive guards — all pinned to exact prod-replica values. Pure functions, DB-free, network-free, fast; a drift here reopens the client-visible fake-finding hole on the next monthly webhook run.",
  "tier": "small"
}
test-registration */
/**
 * Task #3901 — junk-fed fake Sales Common Issues.
 *
 * The Wanta Thome 2026-07 incident (report 6c8ec434-4e02-4d1f-8c45-f33f338a2ea2,
 * import log 4c362c05-ad7a-4ed1-a384-2a7353cde41a): the source PDF's Sales
 * Common Issues component was broken, so the section body was the Looker
 * "Missing data source" placeholder — but the sales capture had no reliable
 * terminator and swallowed the placeholder PLUS trailing dashboard junk
 * ("Registrants 0 Attended No data … Google Ads Spend $6,430.99 … Paid Ads").
 * No longer placeholder-only, the body passed the import gate at high
 * confidence and the AI formatter fabricated 11 fake 🔴 findings from the
 * junk. All three prior defenses (import gate, serve-time suppressor, CEO
 * cleanup action) were evaded.
 *
 * Verifies, with fixtures pinned to EXACT production values (read from the
 * prod read-only replica on 2026-08-06; dev is a stale clone — see memory
 * `prod-fixture-from-replica`):
 *   1. `extractCommonIssuesFromText` on the real Wanta Thome raw text: sales
 *      → empty with reason `missing_data_source_placeholder` (begins-with
 *      gate, junk tail irrelevant); intake → the real findings byte-for-byte.
 *   2. Capture bounds: the sales capture stops at the Intake Common Issues
 *      heading and at trailing component-label runs; intake/sales real
 *      bodies are never truncated (guarded here by the byte-pinned Wanta
 *      intake body; a full replay over all 336 prod import logs during the
 *      task verified every real body is preserved byte-identically).
 *   3. `startsWithMissingDataSourcePlaceholder` + `isJunkTailedLiteralPlaceholder`
 *      flag the junk-tailed raw capture, never real prose.
 *   4. `classifyAiRewrittenMissingDataSourceFinding` recognizes the
 *      junk-fabricated multi-block class (Wanta 11-block, Cali Law 6-block),
 *      mid-text Name_Clean remediation variants (MJ Law / Sands), and the
 *      degenerate-block shape (Dellutri), while real prose (Ebbert) and
 *      mixed real+placeholder values stay null.
 *   5. Business-generic hallucination blocks ("Incomplete client
 *      information", "Low conversion rates" — Ashley Andrews / Jones Law
 *      2026-03) deliberately stay null: the text is indistinguishable from
 *      real operator findings, and the destructive cleanup errs toward
 *      leaving values visible (the task's sanctioned safety direction).
 *   6. `isPlaceholderOnlyCommonIssues` (serve-time) and
 *      `classifyPlaceholderCommonIssues` (cleanup CLI + CEO prod action)
 *      stay in single-predicate lockstep across every fixture.
 *   7. `resolveCommonIssuesOnReimport` preserve rules: a placeholder-empty
 *      re-parse never clears an existing stored value; real parses win.
 *
 * DB-free, network-free, fast.
 */

import {
  extractCommonIssuesFromText,
  resolveCommonIssuesOnReimport,
  startsWithMissingDataSourcePlaceholder,
  isJunkTailedLiteralPlaceholder,
  classifyAiRewrittenMissingDataSourceFinding,
  isAiRewrittenMissingDataSourceFinding,
  isMissingDataSourceDerivedBody,
  isPlaceholderOnlyCommonIssues,
  isEmptySectionBody,
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

// ===== Fixtures pinned to EXACT production values (prod read-only replica, 2026-08-06). =====
// WANTA_RAW_WINDOW: report 6c8ec434 import log 4c362c05 pdf_extracted_text, from the Intake Common Issues heading to end-of-document (the sales capture region plus trailing dashboard junk).
// WANTA_BASELINE_SALES_CAPTURE: what the PRE-FIX sales capture produced from that text (placeholder + junk tail) — the stored-value shape the junk_tailed_literal class exists for.
// WANTA_FIXED_INTAKE_BODY: the real intake findings the fixed capture must preserve byte-for-byte.
// Stored report_sections commonIssues values: Wanta Thome 2026-07 (11 fabricated blocks), Cali Law 2026-07, MJ Law / Sands 2026-06 (mid-text Name_Clean), Dellutri 2026-03 (degenerate blocks), Ricky Malik 2026-04 (letter-spaced literal), Ebbert 2026-03 (REAL operator prose — false-positive guard), Ashley Andrews / Jones Law 2026-03 (business-generic hallucinations that deliberately stay visible).

const WANTA_RAW_WINDOW =
  "Intake Common Issues - Issue 1: Passive/insuf ficient responsiveness (voicemail, unstaf fed lines, slow callbacks) causes urgent, high-value callers to abandon contact and seek competitors. Strategic Fix: Enforce a 1-hour callback SLA, staff peak hours for live answer , and enable instant channels (SMS/WhatsApp) with templated triage to capture and convert urgent leads. - Issue 2: Weak booking conversion—callers hear services/pricing but receive no compelling value proposition or urgency , leading to indecision and shopping around. Strategic Fix: Train intake to deliver concise value statements, use limited-availability CT As, and of fer immediate booking with deposit or text confirmation to lock appointments. - Issue 3: Operational communication friction (confused of fice hours, unclear scheduling options, inconsistent follow-up) creates avoidable drop-of fs and lowers throughput. Strategic Fix: Standardize scripts/F AQs for hours and scheduling, send post-call confirmations and automated reminders, and track booking failure reasons to prioritize fixes. Sales Common Issues Missing data source There is no data source associated with this component See details See details See details Registrants 0 Attended No data See details Show Rate No data See details See details See details See details See details See details See details See details See details See details See details Missed Call 34 See details Blog Post URL No data GBP Locations Leads GBP Location Leads No data Reviews 0 Webinar Reviews 0 Other Reviews 0 GBP Locations Reviews Location Reviews Reiews Responded Posts/Q&A Count No data See details Google Ads Spend $6,430.99 See details List Reviews 0 See details See details See details Paid Ads";

const WANTA_BASELINE_SALES_CAPTURE =
  "Missing data source There is no data source associated with this component See details See details See details Registrants 0 Attended No data See details Show Rate No data See details See details See details See details See details See details See details See details See details See details See details Missed Call 34 See details Blog Post URL No data GBP Locations Leads GBP Location Leads No data Reviews 0 Webinar Reviews 0 Other Reviews 0 GBP Locations Reviews Location Reviews Reiews Responded Posts/Q&A Count No data See details Google Ads Spend $6,430.99 See details List Reviews 0 See details See details See details Paid Ads";

const WANTA_FIXED_INTAKE_BODY =
  "- Issue 1: Passive/insuf ficient responsiveness (voicemail, unstaf fed lines, slow callbacks) causes urgent, high-value callers to abandon contact and seek competitors. Strategic Fix: Enforce a 1-hour callback SLA, staff peak hours for live answer , and enable instant channels (SMS/WhatsApp) with templated triage to capture and convert urgent leads. - Issue 2: Weak booking conversion-callers hear services/pricing but receive no compelling value proposition or urgency , leading to indecision and shopping around. Strategic Fix: Train intake to deliver concise value statements, use limited-availability CT As, and of fer immediate booking with deposit or text confirmation to lock appointments. - Issue 3: Operational communication friction (confused of fice hours, unclear scheduling options, inconsistent follow-up) creates avoidable drop-of fs and lowers throughput. Strategic Fix: Standardize scripts/F AQs for hours and scheduling, send post-call confirmations and automated reminders, and track booking failure reasons to prioritize fixes.";

const WANTA_STORED_11_BLOCK =
  "🔴 **Issue:** Missing data source\n↳ **Impact:** There is no data source associated with this component, preventing accurate tracking and reporting of performance metrics.\n> ➡️ **Strategic Fix:** Immediately identify and connect the correct data source(s) to this component; validate data flow and set monitoring to alert on source disconnections.\n\n---\n\n🔴 **Issue:** Registrants count missing\n↳ **Impact:** Registrant totals are shown as 0, obscuring lead volume and event interest.\n> ➡️ **Strategic Fix:** Audit registration tracking, repair or implement registration capture, and confirm counts populate correctly.\n\n---\n\n🔴 **Issue:** Attendance data missing\n↳ **Impact:** Attended field shows \"No data,\" preventing measurement of event engagement and conversion opportunities.\n> ➡️ **Strategic Fix:** Restore attendee tracking (e.g., event platform integration, post-event import) and verify attendance records sync.\n\n---\n\n🔴 **Issue:** Show Rate missing\n↳ **Impact:** Show Rate has \"No data,\" blocking assessment of expected vs. actual attendance and follow-up prioritization.\n> ➡️ **Strategic Fix:** Ensure Show Rate calculation is enabled by linking registrant and attendance datasets and add validation checks.\n\n---\n\n🔴 **Issue:** Missed Call tracking present but incomplete\n↳ **Impact:** Missed Call shows 34, but lack of contextual data may hinder follow-up and lead recovery efforts.\n> ➡️ **Strategic Fix:** Integrate call tracking with CRM to capture caller details, reason for call, and create immediate follow-up workflows.\n\n---\n\n🔴 **Issue:** Blog Post URL missing\n↳ **Impact:** Blog Post URL field shows \"No data,\" limiting content attribution and traffic/source analysis.\n> ➡️ **Strategic Fix:** Populate blog post URLs in the tracking system and ensure content links are tagged for attribution.\n\n---\n\n🔴 **Issue:** GBP Location Leads missing\n↳ **Impact:** GBP Location Leads fields show \"No data,\" preventing location-level lead performance analysis.\n> ➡️ **Strategic Fix:** Connect Google Business Profile (GBP) lead data to analytics and verify location mapping for lead attribution.\n\n---\n\n🔴 **Issue:** Reviews counts missing or zero\n↳ **Impact:** Reviews, Webinar Reviews, Other Reviews, and List Reviews are 0 or \"No data,\" obscuring reputation signals and social proof.\n> ➡️ **Strategic Fix:** Sync review sources (GBP, webinar platforms, other review sites) and schedule regular imports; set alerts for new reviews.\n\n---\n\n🔴 **Issue:** Location Reviews and Responded Posts/Q&A missing\n↳ **Impact:** Location-specific review data and response counts are \"No data,\" limiting reputation management and responsiveness metrics.\n> ➡️ **Strategic Fix:** Enable location-level review ingestion and response tracking; assign owners to monitor and respond to Q&A and review items.\n\n---\n\n🔴 **Issue:** Google Ads Spend present but disconnected\n↳ **Impact:** Google Ads Spend shows $6,430.99 without connected performance metrics, making ROI analysis impossible.\n> ➡️ **Strategic Fix:** Link Google Ads cost data to conversions and campaign performance in analytics; complete UTM tagging and conversion tracking.\n\n---\n\n🔴 **Issue:** Paid Ads label ambiguous\n↳ **Impact:** Paid Ads appears without detailed data, preventing assessment of channel performance and budget effectiveness.\n> ➡️ **Strategic Fix:** Break out paid ad channels, ensure spend and performance metrics are feeding into reports, and standardize naming and tagging.";

const CALI_STORED_JULY =
  "🔴 **Issue:** Missing data source for component\n↳ **Impact:** Data Studio cannot connect to the data set, preventing display of metrics and blocking analysis of leads, reviews, and ad performance\n> ➡️ **Strategic Fix:** Immediately identify and reconnect the correct data source in Data Studio; verify credentials and dataset permissions, then test each component to ensure data flows to dashboards\n\n---\n\n🔴 **Issue:** GBP Locations leads data set configuration error\n↳ **Impact:** GBP (Google Business Profile) location leads and reviews are not being ingested, causing zero reported leads and incomplete location-level metrics\n> ➡️ **Strategic Fix:** Fix the GBP data set configuration by reauthorizing the GBP connector, validating location IDs, and re-syncing historical data to restore accurate leads and reviews counts\n\n---\n\n🔴 **Issue:** No reviews or review counts populated (Reviews, Webinar Reviews, Other Reviews, Location Reviews, List Reviews show 0)\n↳ **Impact:** Review-related KPIs are missing, undermining reputation monitoring and response metrics\n> ➡️ **Strategic Fix:** Re-establish review data feeds from all review sources, confirm API access and scopes, and backfill missing review records where possible to restore review counts\n\n---\n\n🔴 **Issue:** No leads reported from LSA and Google Ads (LSA Leads 0, Google Ads Leads 0, Paid Ads)\n↳ **Impact:** Paid search and LSA performance cannot be measured, obscuring paid lead generation effectiveness\n> ➡️ **Strategic Fix:** Validate ad platform connectors and conversion tracking setup, ensure ad accounts are linked, and verify that lead conversion events are mapped into the dataset\n\n---\n\n🔴 **Issue:** Average Time to Answer metric not fully populated (Avg Time to Answer shows partial entries)\n↳ **Impact:** Incomplete response-time data prevents accurate assessment of contact responsiveness and service-level performance\n> ➡️ **Strategic Fix:** Ensure the time-to-answer source is connected and events are being captured; harmonize timestamp formats and backfill missing records so the metric calculates correctly\n\n---\n\n🔴 **Issue:** Blog Post URL appears as raw document link rather than integrated content\n↳ **Impact:** Blog content is not integrated into content performance tracking, limiting visibility into referral and engagement metrics\n> ➡️ **Strategic Fix:** Integrate the blog post URL into the content dataset, ensure UTM tracking is present, and map engagement metrics to the dashboard for content performance analysis";

const MJLAW_STORED_JUNE =
  "🔴 **Issue:** Missing data source ↳ **Impact:** There is no data source associated with this component (See details Name_Clean (1): MJLaw) > ➡️ **Strategic Fix:** Associate the correct data source with the component and verify Name_Clean (1): MJLaw is connected and accessible";

const SANDS_STORED_JUNE =
  "🔴 **Issue:** Missing data source\n↳ **Impact:** There is no data source associated with this component (See details Name_Clean (1): Sands Law)\n> ➡️ **Strategic Fix:** Identify and connect the appropriate data source to this component, ensuring the Name_Clean field for Sands Law is populated and validated before deployment";

const DELLUTRI_STORED_MARCH =
  "🔴 **Issue:** 🔴 **\n\n---\n\n🔴 **Issue:** ** Missing data source. There is no data source associated with this component. > ➡️ **\n> ➡️ **Strategic Fix:** ** Identify and link the appropriate data source to ensure functionality. --- 🔴 **\n\n---\n\n🔴 **Issue:** ** Incomplete data entry. Some fields are left blank. > ➡️ **\n> ➡️ **Strategic Fix:** ** Implement mandatory fields to ensure all necessary information is captured. --- 🔴 **\n\n---\n\n🔴 **Issue:** ** Data inconsistency. Discrepancies found in reported figures. > ➡️ **\n> ➡️ **Strategic Fix:** ** Conduct a thorough audit of data entries to standardize and correct discrepancies. --- 🔴 **\n\n---\n\n🔴 **Issue:** ** Lack of user training. Team members are unsure how to use the system effectively. > ➡️ **\n> ➡️ **Strategic Fix:** ** Develop and provide comprehensive training sessions for all users. --- 🔴 **\n\n---\n\n🔴 **Issue:** ** Slow system performance. Users experience delays when accessing data. > ➡️ **\n> ➡️ **Strategic Fix:** ** Optimize system performance by upgrading hardware or improving software efficiency.";

const EBBERT_REAL_MARCH =
  "Great job on maintaining a strong Consult-to-Case rate of 31.7, which is above the goal of 30. Here are some areas for potential improvement:\n\n🔴 **Issue:** Missing data source. There is no data source associated with this component.  \n↳ **Impact:** This can lead to incomplete analysis and reporting.  \n> ➡️ **Strategic Fix:** Consider identifying and linking the appropriate data source to the component.\n\n---\n\n🔴 **Issue:** Incomplete data entries. Some entries lack necessary information.  \n↳ **Impact:** This may result in gaps in data analysis and decision-making.  \n> ➡️ **Strategic Fix:** You might implement a validation process to ensure all required fields are completed before submission.\n\n---\n\n🔴 **Issue:** Data duplication. Multiple entries for the same record exist.  \n↳ **Impact:** This can cause confusion and inaccuracies in reporting.  \n> ➡️ **Strategic Fix:** Consider establishing a deduplication protocol to regularly check and remove duplicate records.\n\n---\n\n🔴 **Issue:** Outdated information. Some data has not been updated in a timely manner.  \n↳ **Impact:** This may lead to reliance on inaccurate data for decision-making.  \n> ➡️ **Strategic Fix:** You might create a schedule for regular data reviews and updates to maintain accuracy.\n\n---\n\n🔴 **Issue:** Inconsistent data formats. Data is recorded in various formats.  \n↳ **Impact:** This can hinder data integration and analysis efforts.  \n> ➡️ **Strategic Fix:** Consider standardizing data entry formats across all components to ensure consistency.\n\n---\n\n🔴 **Issue:** Lack of user training. Users are not adequately trained on data entry protocols.  \n↳ **Impact:** This can lead to errors and inefficiencies in data handling.  \n> ➡️ **Strategic Fix:** You might develop and implement a comprehensive training program for all users involved in data entry.";

const ASHLEY_HALLUCINATED_MARCH =
  "🔴 **Issue:** Missing data source. There is no data source associated with this component.  \n↳ **Impact:** This leads to functionality issues and hinders decision-making.  \n> ➡️ **Strategic Fix:** Identify and link the appropriate data source to ensure functionality.\n\n---\n\n🔴 **Issue:** Incomplete client information. Client profiles lack essential details.  \n↳ **Impact:** This results in inefficient case handling and poor client service.  \n> ➡️ **Strategic Fix:** Implement a standardized client intake process to capture all necessary information.\n\n---\n\n🔴 **Issue:** Low conversion rates. Potential clients are not converting into actual clients.  \n↳ **Impact:** This significantly affects revenue and growth potential.  \n> ➡️ **Strategic Fix:** Analyze the sales funnel to identify bottlenecks and enhance follow-up strategies.\n\n---\n\n🔴 **Issue:** Ineffective communication. Team members are not aligned on client interactions.  \n↳ **Impact:** This causes confusion and inconsistency in client service.  \n> ➡️ **Strategic Fix:** Establish regular communication protocols and updates to ensure everyone is informed.\n\n---\n\n🔴 **Issue:** Outdated marketing materials. Current materials do not reflect recent changes in services.  \n↳ **Impact:** This undermines the firm's credibility and client trust.  \n> ➡️ **Strategic Fix:** Review and update all marketing collateral to align with current offerings and branding.";

const JONES_HALLUCINATED_MARCH =
  "🔴 **Issue:** Missing data source. There is no data source associated with this component.  \n↳ **Impact:** Functionality is compromised, leading to potential data inaccuracies.  \n> ➡️ **Strategic Fix:** Identify and link the appropriate data source to ensure functionality.\n\n---\n\n🔴 **Issue:** Lack of user engagement metrics. No tracking of user interactions.  \n↳ **Impact:** Inability to assess user behavior and improve user experience.  \n> ➡️ **Strategic Fix:** Implement analytics tools to monitor and report user engagement effectively.\n\n---\n\n🔴 **Issue:** Inconsistent branding across platforms. Variations in logos and color schemes.  \n↳ **Impact:** Brand identity is weakened, causing confusion among users.  \n> ➡️ **Strategic Fix:** Develop a comprehensive branding guide to standardize visual elements across all platforms.\n\n---\n\n🔴 **Issue:** Delayed response times from customer support. Increased customer dissatisfaction.  \n↳ **Impact:** Customer loyalty is jeopardized, leading to potential loss of business.  \n> ➡️ **Strategic Fix:** Enhance staffing and training for customer support to improve response times and service quality.\n\n---\n\n🔴 **Issue:** Low conversion rates on landing pages. Ineffective call-to-action strategies.  \n↳ **Impact:** Revenue generation is hindered, affecting overall business performance.  \n> ➡️ **Strategic Fix:** A/B test different call-to-action phrases and designs to determine the most effective options.\n\n---\n\n🔴 **Issue:** High bounce rates on the website. Users leaving without engaging.  \n↳ **Impact:** Potential customers are lost, reducing overall conversion opportunities.  \n> ➡️ **Strategic Fix:** Optimize website content and layout to enhance user experience and retention.";

const LETTER_SPACED_STORED =
  "Missing data source There is no data source associated with this component See details N a m e C l e a n ( 1 ) : R i c k y M a l i k";

async function main(): Promise<void> {
  console.log("extractCommonIssuesFromText — exact Wanta Thome 2026-07 raw text");
  await run("sales: placeholder + junk tail extracts EMPTY with placeholder reason", () => {
    const r = extractCommonIssuesFromText(WANTA_RAW_WINDOW, "sales");
    assert(r.isEmpty, "sales isEmpty");
    assert(r.value === "", "sales value empty");
    assert(
      r.emptyReason === "missing_data_source_placeholder",
      `sales reason=${r.emptyReason}`,
    );
    assert(
      /missing data source/i.test(r.confidence.source),
      "confidence source names the placeholder (reports.ts warning wiring reads this)",
    );
  });
  await run("intake: real findings preserved byte-for-byte (capture-bound guard)", () => {
    const r = extractCommonIssuesFromText(WANTA_RAW_WINDOW, "intake");
    assert(!r.isEmpty, "intake not empty");
    assert(r.confidence.confidence === "high", `intake high, got ${r.confidence.confidence}`);
    assert(
      r.value === WANTA_FIXED_INTAKE_BODY,
      "intake body byte-identical to the pinned real findings",
    );
    assert(!/Registrants|Google Ads Spend/i.test(r.value), "no dashboard junk in intake body");
  });
  await run("sales capture stops at the Intake heading (anti-swallow both directions)", () => {
    const doc = `Sales Common Issues
Reps not following up within 24 hours on consult requests for new clients.
Intake Common Issues
Frequently dropped Spanish-speaking leads on first call. Need follow-up training.`;
    const rs = extractCommonIssuesFromText(doc, "sales");
    assert(!rs.isEmpty, "sales real body kept");
    assert(!/Intake Common Issues|Spanish-speaking/i.test(rs.value), "sales never swallows intake");
    const ri = extractCommonIssuesFromText(doc, "intake");
    assert(!ri.isEmpty && /Spanish-speaking/.test(ri.value), "intake body intact");
  });
  await run("sales capture stops at trailing component-label runs", () => {
    const doc = `Sales Common Issues
Reps not following up within 24 hours on consult requests.
Total Leads 179 Registrants 0 Attended No data Google Ads Spend $6,430.99 Paid Ads`;
    const rs = extractCommonIssuesFromText(doc, "sales");
    assert(!rs.isEmpty, "real body kept");
    assert(
      rs.value === "Reps not following up within 24 hours on consult requests.",
      `label run trimmed, got ${JSON.stringify(rs.value)}`,
    );
  });

  console.log("startsWith / junk-tailed literal gates — exact baseline capture");
  await run("the pre-fix Wanta sales capture (placeholder + 500 chars junk) is flagged", () => {
    assert(
      startsWithMissingDataSourcePlaceholder(WANTA_BASELINE_SALES_CAPTURE),
      "begins-with gate",
    );
    assert(
      isJunkTailedLiteralPlaceholder(WANTA_BASELINE_SALES_CAPTURE),
      "junk-tailed literal (stored-value class)",
    );
    assert(
      classifyPlaceholderCommonIssues(WANTA_BASELINE_SALES_CAPTURE) === "junk_tailed_literal",
      "cleanup kind junk_tailed_literal",
    );
  });
  await run("letter-spaced raw literal (exact Ricky Malik 2026-04 value) is flagged", () => {
    assert(startsWithMissingDataSourcePlaceholder(LETTER_SPACED_STORED), "begins-with");
    assert(
      classifyPlaceholderCommonIssues(LETTER_SPACED_STORED) !== null,
      "cleanup catches the letter-spaced literal",
    );
  });
  await run("real prose never trips the begins-with or junk-tailed gates", () => {
    assert(!startsWithMissingDataSourcePlaceholder(EBBERT_REAL_MARCH), "Ebbert begins-with");
    assert(!isJunkTailedLiteralPlaceholder(EBBERT_REAL_MARCH), "Ebbert junk-tailed");
    const realThenPlaceholder =
      "Reps not following up within 24 hours. Missing data source - There is no data source associated with this component.";
    assert(
      !startsWithMissingDataSourcePlaceholder(realThenPlaceholder),
      "placeholder later in real prose stays unflagged",
    );
    assert(!isJunkTailedLiteralPlaceholder(realThenPlaceholder), "mixed junk-tailed false");
  });

  console.log("classifyAiRewrittenMissingDataSourceFinding — stored prod values");
  await run("EXACT Wanta Thome stored 11-block value → junk_fabricated", () => {
    assert(
      classifyAiRewrittenMissingDataSourceFinding(WANTA_STORED_11_BLOCK) === "junk_fabricated",
      "wanta class",
    );
    assert(isAiRewrittenMissingDataSourceFinding(WANTA_STORED_11_BLOCK), "boolean wrapper");
  });
  await run("EXACT Cali Law 2026-07 stored value → junk_fabricated", () => {
    assert(
      classifyAiRewrittenMissingDataSourceFinding(CALI_STORED_JULY) === "junk_fabricated",
      "cali class",
    );
  });
  await run("mid-text Name_Clean remediation variants → placeholder_only", () => {
    assert(
      classifyAiRewrittenMissingDataSourceFinding(MJLAW_STORED_JUNE) === "placeholder_only",
      "MJ Law",
    );
    assert(
      classifyAiRewrittenMissingDataSourceFinding(SANDS_STORED_JUNE) === "placeholder_only",
      "Sands",
    );
  });
  await run("degenerate-block shape (exact Dellutri 2026-03 value) is flagged", () => {
    assert(
      classifyAiRewrittenMissingDataSourceFinding(DELLUTRI_STORED_MARCH) === "junk_fabricated",
      "Dellutri",
    );
  });
  await run("real operator prose (exact Ebbert 2026-03 value) stays null", () => {
    assert(classifyAiRewrittenMissingDataSourceFinding(EBBERT_REAL_MARCH) === null, "Ebbert null");
    assert(!isMissingDataSourceDerivedBody(EBBERT_REAL_MARCH), "derived-body false");
  });
  await run("business-generic hallucination blocks stay null (sanctioned safety direction)", () => {
    // Ashley Andrews / Jones Law 2026-03: the sibling blocks ("Incomplete
    // client information", "Low conversion rates", "High bounce rates") are
    // indistinguishable from real operator findings by text alone. The
    // destructive cleanup deliberately leaves them visible — a false
    // negative here is safe, a false positive would blank real findings.
    assert(
      classifyAiRewrittenMissingDataSourceFinding(ASHLEY_HALLUCINATED_MARCH) === null,
      "Ashley Andrews null",
    );
    assert(
      classifyAiRewrittenMissingDataSourceFinding(JONES_HALLUCINATED_MARCH) === null,
      "Jones Law null",
    );
  });
  await run("a real finding block anywhere forces null (mixed-content guard)", () => {
    const mixed = `🔴 **Issue:** Missing data source.
↳ **Impact:** There is no data source associated with this component.

---

🔴 **Issue:** Reps not following up within 24 hours on consult requests.
➡️ **Strategic Fix:** Same-day follow-up SLA with an owner per lead.`;
    assert(classifyAiRewrittenMissingDataSourceFinding(mixed) === null, "mixed null");
    assert(classifyPlaceholderCommonIssues(mixed) === null, "cleanup leaves mixed");
  });

  console.log("serve-time predicate + cleanup classifier lockstep");
  await run("poisoned fixtures flagged by BOTH predicates; healthy by NEITHER", () => {
    const poisoned: Array<[string, string]> = [
      ["WANTA_STORED_11_BLOCK", WANTA_STORED_11_BLOCK],
      ["CALI_STORED_JULY", CALI_STORED_JULY],
      ["MJLAW_STORED_JUNE", MJLAW_STORED_JUNE],
      ["SANDS_STORED_JUNE", SANDS_STORED_JUNE],
      ["DELLUTRI_STORED_MARCH", DELLUTRI_STORED_MARCH],
      ["LETTER_SPACED_STORED", LETTER_SPACED_STORED],
      ["WANTA_BASELINE_SALES_CAPTURE", WANTA_BASELINE_SALES_CAPTURE],
    ];
    for (const [name, v] of poisoned) {
      assert(isPlaceholderOnlyCommonIssues(v), `${name} serve-time flagged`);
      assert(classifyPlaceholderCommonIssues(v) !== null, `${name} cleanup flagged`);
      assert(isMissingDataSourceDerivedBody(v), `${name} derived-body`);
    }
    const healthy: Array<[string, string]> = [
      ["EBBERT_REAL_MARCH", EBBERT_REAL_MARCH],
      ["ASHLEY_HALLUCINATED_MARCH", ASHLEY_HALLUCINATED_MARCH],
      ["JONES_HALLUCINATED_MARCH", JONES_HALLUCINATED_MARCH],
      ["WANTA_FIXED_INTAKE_BODY", WANTA_FIXED_INTAKE_BODY],
    ];
    for (const [name, v] of healthy) {
      assert(!isPlaceholderOnlyCommonIssues(v), `${name} serve-time unflagged`);
      assert(classifyPlaceholderCommonIssues(v) === null, `${name} cleanup unflagged`);
    }
    assert(!isPlaceholderOnlyCommonIssues(""), "blank unflagged");
    assert(classifyPlaceholderCommonIssues("") === null, "blank cleanup null");
  });

  console.log("resolveCommonIssuesOnReimport — preserve rules");
  await run("placeholder-empty re-parse never clears existing values", () => {
    const emptyParse = extractCommonIssuesFromText(WANTA_RAW_WINDOW, "sales");
    assert(emptyParse.isEmpty && isEmptySectionBody(emptyParse.value), "parse is empty");
    assert(
      resolveCommonIssuesOnReimport(emptyParse.value, EBBERT_REAL_MARCH) === EBBERT_REAL_MARCH,
      "existing real findings preserved",
    );
    assert(
      resolveCommonIssuesOnReimport(emptyParse.value, WANTA_STORED_11_BLOCK) ===
        WANTA_STORED_11_BLOCK,
      "existing poisoned value preserved too — cleanup is the explicit CEO action, never a re-import side effect",
    );
    assert(resolveCommonIssuesOnReimport(emptyParse.value, "") === "", "empty + empty stays empty");
    assert(
      resolveCommonIssuesOnReimport(WANTA_FIXED_INTAKE_BODY, WANTA_STORED_11_BLOCK) ===
        WANTA_FIXED_INTAKE_BODY,
      "real parse wins over existing",
    );
  });

  console.log("\nAll Task #3901 junk-fed Common Issues checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
