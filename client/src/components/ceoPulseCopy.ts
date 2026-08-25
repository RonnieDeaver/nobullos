/**
 * Task #4276 — centralized client-facing display strings for "The NoBull
 * Brief" (internal name: CEO Pulse; identifiers deliberately keep the old
 * name — see replit.md, NoBull Brief rename). Every surface that renders the
 * brief's branding (report slide, /pulse/:token share page, Studio preview,
 * full-letter page) reads from THIS module so a future product rename lands
 * in exactly one place.
 *
 * Edition tag labels stay in @shared/schema (ceoPulseEditionLabel) because
 * the server shares them; everything here is client-only display copy.
 */
export const NOBULL_BRIEF_STRINGS = {
  /** Product name as rendered on all client surfaces. */
  title: "The NoBull Brief",
  /** Standing masthead line on the share page (Task #4268). */
  masthead: "Prepared for our partners",
  /** Slide subtitle / tagline under the title. */
  tagline:
    "Direct from our CEO — monthly insights on what's moving the market and how we're responding.",
  /** Eyebrow above the full-letter CTA. */
  letterCtaEyebrow: "From the CEO's Desk",
  /** Full-letter CTA label. */
  letterCtaLabel: "Read the Full NoBull Brief",
  /** Task #4813 — company-update announcement layout: section label above the
   *  initiative grid. The shared visual and the report deck slide read this
   *  same string so the two surfaces never drift. */
  updateInitiativesLabel: "What We're Building",
  /** Task #4813 — company-update announcement layout: section label above the
   *  commitments band (shared by the visual and the report deck slide). */
  updateCommitmentsLabel: "What This Means for You",
  /** Task #4834 — company-update ROADMAP template (freshly analyzed briefs).
   *  Section labels for the executive product-roadmap layout (update
   *  snapshot → why this matters → pull quote; Task #4984 retired the
   *  Before & After and What's Coming Next bands and their labels), shared
   *  by CeoPulseVisual and the report deck slide so the two surfaces never
   *  drift. The Task #4813 labels above stay: they still render on legacy
   *  rows that predate the roadmap fields. */
  roadmapKicker: "What We're Building",
  roadmapSnapshotLabel: "Update Snapshot",
  roadmapWhyLabel: "Why This Matters",
  roadmapPullQuoteLabel: "The Bottom Line",
  /** Empty state (share page) when no brief exists yet. */
  emptyTitle: "No NoBull Brief data available yet.",
  emptySubtitle: "Submit monthly content to generate AI-powered insights.",
} as const;
