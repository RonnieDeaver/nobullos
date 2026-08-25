/**
 * Task #4254 — curated Common Issues copy library.
 *
 * Task #4227 added a quality floor: degenerate AI "Common Issues" copy blocks
 * finalize behind an explicit operator confirm. But when the RAW source text
 * is itself thin (the "Being Bad" incident came from thin intake notes), the
 * operator's only options were rewrite-by-hand or confirm-anyway. This module
 * provides a small curated set of vetted, generic-but-realistic Issue /
 * Impact / Strategic Fix blocks per section that operators can select from
 * the Report Form quality-gate dialog as a one-click quality replacement.
 *
 * Contract (guarded by tests/report-finalize-quality-gate.test.ts):
 *   - Every block body comfortably clears the #4227 thinness floor
 *     (findDegenerateCommonIssues finds nothing in the rendered output).
 *   - renderCuratedIssueBlocks emits the canonical 🔴 / ↳ / ➡️ structure the
 *     formatter produces, already well-formed (normalizeCommonIssuesStructure
 *     is a no-op on it), so it stores cleanly via the normal section save
 *     path.
 *   - NEVER auto-applied. Canned copy risks asserting issues a specific
 *     client doesn't have, so the library is surfaced for explicit operator
 *     selection only — no server code substitutes it automatically.
 */

export type CommonIssuesSection = "intake" | "sales";

export interface CuratedIssueBlock {
  /** Stable id — used for selection state and de-duplication. */
  id: string;
  section: CommonIssuesSection;
  /** Short operator-facing label shown in the picker. */
  title: string;
  issue: string;
  impact: string;
  fix: string;
}

export const COMMON_ISSUES_COPY_LIBRARY: CuratedIssueBlock[] = [
  // ---------------------------------------------------------------- intake
  {
    id: "intake_slow_speed_to_lead",
    section: "intake",
    title: "Slow speed-to-lead",
    issue:
      "New inquiries are not being contacted within the first few minutes of coming in.",
    impact:
      "Leads who don't hear back quickly move on to the next firm, so hard-won marketing spend converts at a fraction of its potential.",
    fix:
      "Set a five-minute first-response standard for every new lead and track it daily, with a clear owner for after-hours coverage.",
  },
  {
    id: "intake_inconsistent_scripting",
    section: "intake",
    title: "Inconsistent call scripting",
    issue:
      "Intake calls are handled differently depending on who answers, with no consistent script or qualification questions.",
    impact:
      "Qualified callers slip through without being booked, and the firm can't tell which part of the conversation is losing them.",
    fix:
      "Adopt a short standard intake script covering greeting, qualification, and a direct ask to book the consultation, and review recorded calls against it weekly.",
  },
  {
    id: "intake_no_followup_cadence",
    section: "intake",
    title: "No follow-up cadence on unbooked leads",
    issue:
      "Leads who don't book on the first touch receive little or no structured follow-up afterward.",
    impact:
      "A large share of recoverable prospects quietly go cold, deflating the lead-to-consult rate below what the lead quality supports.",
    fix:
      "Implement a multi-touch follow-up sequence (calls, texts, and emails over the first two weeks) and only close a lead after the full cadence completes.",
  },
  {
    id: "intake_missed_after_hours_calls",
    section: "intake",
    title: "Missed and after-hours calls",
    issue:
      "A meaningful portion of inbound calls ring out or land in voicemail, especially outside core office hours.",
    impact:
      "Every missed call is a lead the firm already paid to generate handed to a competitor who simply picked up.",
    fix:
      "Add overflow and after-hours answering coverage, and review the missed-call report weekly until the miss rate is consistently near zero.",
  },
  {
    id: "intake_weak_booking_ask",
    section: "intake",
    title: "Weak booking ask on qualified calls",
    issue:
      "Qualified callers are given information and invited to call back later instead of being asked directly to schedule a consultation.",
    impact:
      "Interested prospects leave the call without a concrete next step, and most never call back on their own.",
    fix:
      "Train intake staff to end every qualified call with a direct scheduling ask and to offer two specific appointment times rather than an open-ended invitation.",
  },
  // ----------------------------------------------------------------- sales
  {
    id: "sales_slow_consult_followup",
    section: "sales",
    title: "Slow follow-up after consults",
    issue:
      "Prospects who don't sign at the consultation are not contacted again promptly or consistently afterward.",
    impact:
      "Deals that only needed one more conversation stall out, dragging the consult-to-case rate down well below the quality of the consults.",
    fix:
      "Follow up within 24 hours of every unsigned consultation and keep a scheduled touch cadence going until the prospect signs or clearly declines.",
  },
  {
    id: "sales_no_show_management",
    section: "sales",
    title: "Consultation no-shows not managed",
    issue:
      "Booked consultations are frequently missed, with no structured reminder sequence or same-day rebooking process.",
    impact:
      "Calendar slots and attorney time are wasted, and many no-shows are never recovered even though most would have rebooked if asked.",
    fix:
      "Send automated reminders at booking, 24 hours out, and one hour out, and call every no-show the same day to rebook while interest is still warm.",
  },
  {
    id: "sales_value_not_communicated",
    section: "sales",
    title: "Value not communicated at the consult",
    issue:
      "Consultations focus on case facts and process mechanics rather than clearly explaining the value of hiring the firm.",
    impact:
      "Prospects leave without understanding what they gain by signing, so price objections and 'let me think about it' responses dominate.",
    fix:
      "Restructure the consultation around the prospect's desired outcome, present a clear plan of action, and ask for the engagement before the meeting ends.",
  },
  {
    id: "sales_no_pipeline_visibility",
    section: "sales",
    title: "No pipeline visibility on open matters",
    issue:
      "Unsigned prospects are tracked informally, with no single pipeline view showing who is waiting on what next step.",
    impact:
      "Open opportunities age silently until they are lost, and nobody can say how much signable value is sitting in the pipeline right now.",
    fix:
      "Track every unsigned prospect in one pipeline with a named owner and a dated next action, and review it as a team at least weekly.",
  },
  {
    id: "sales_fee_conversation_avoided",
    section: "sales",
    title: "Fee conversation handled defensively",
    issue:
      "Fees are presented apologetically or left vague at the consultation instead of being stated plainly alongside the value delivered.",
    impact:
      "Prospects sense hesitation, anchor on cost instead of outcome, and delay signing while they shop other firms.",
    fix:
      "State fees confidently with a simple explanation of what the client receives, and pair the fee discussion with payment options so cost never becomes the last word.",
  },
];

/** Curated blocks for one section, in display order. */
export function getCuratedIssueBlocks(
  section: CommonIssuesSection,
): CuratedIssueBlock[] {
  return COMMON_ISSUES_COPY_LIBRARY.filter((b) => b.section === section);
}

/**
 * Render selected blocks into the canonical 🔴 / ↳ / ➡️ Common Issues
 * markdown (same shape the AI formatter produces): one block per issue,
 * `---` dividers between blocks, no trailing divider.
 */
export function renderCuratedIssueBlocks(blocks: CuratedIssueBlock[]): string {
  return blocks
    .map((b) =>
      [
        `🔴 **Issue:** ${b.issue}`,
        `↳ **Impact:** ${b.impact}`,
        `> ➡️ **Strategic Fix:** ${b.fix}`,
      ].join("\n"),
    )
    .join("\n\n---\n\n");
}
