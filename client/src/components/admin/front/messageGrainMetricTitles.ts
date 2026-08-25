/**
 * Task #2603 — Front Console is message-grain only. The shared
 * `FRONT_CONSOLE_METRIC_DEFINITIONS` (server-owned) still describes these
 * figures in conversation-grain language ("Tracked conversations", "matchable
 * conversations", …). The Front console UI must never surface that vocabulary —
 * not in visible labels and not in tooltip `title` attributes. These
 * frontend-only tooltip strings restate the same metrics in individual-email /
 * message-grain terms so the console reads consistently with the Analytics
 * Coverage screen. Backend metric math is unchanged; only the user-facing copy
 * differs.
 */
export const FRONT_MESSAGE_GRAIN_METRIC_TITLES = {
  rawImported:
    "All Front records ever imported (raw_communication_records, source_type='front_email'). Includes per-version duplicates — not a count of distinct emails.",
  trackedTotal:
    "Tracked emails (front_sync_emails) — the de-duplicated operational rows, one per email.",
  matched:
    "Tracked emails matched to a client (match_status auto_matched or manually_matched).",
  unmatched:
    "Tracked emails awaiting a client match (match_status unmatched).",
  matchable:
    "Matchable emails = matched + unmatched. Excludes dismissed-operational / spam / notification / blocked rows.",
  matchRate:
    "Matched ÷ matchable emails. Excludes non-matchable rows, so it is not diluted by operational dismissals.",
  backlog:
    "Pipeline rows still awaiting or failing processing (every pipeline_state except applied and triage_dismissed). Includes failed and dead-lettered.",
  appliedDone:
    "Pipeline rows already processed to completion (pipeline_state applied) or intentionally dismissed at triage (triage_dismissed).",
} as const;
