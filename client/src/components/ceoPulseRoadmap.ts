/**
 * Task #4834 / #4984 — company-update ROADMAP template derivation.
 *
 * Freshly analyzed text-only company updates carry additive optional
 * aiAnalysis fields (supportingLine, per-takeaway category, whyBullets,
 * pullQuote — see shared/models/reports.ts). This module is the single
 * client-side seam that decides whether a brief renders the roadmap template
 * (update snapshot → Why This Matters → pull quote) or falls back to the
 * Task #4813 announcement layout, and normalizes the stored values
 * defensively (the server normalizes at both write sites; this repeats the
 * same rules so a hand-edited or legacy row can never render a broken
 * section).
 *
 * Task #4984 retired the Before & After and What's Coming Next (timeline)
 * bands. Stored legacy beforeAfter/timeline values still COUNT toward layout
 * detection — published roadmap briefs keep the template rather than
 * snapping back to the announcement layout — but they are never derived for
 * rendering. Why This Matters absorbed their job: it renders one short lead
 * paragraph (contextNarrative[0]) plus short whyBullets, with the stored
 * paragraphs as the fallback for legacy rows that predate whyBullets.
 *
 * Deliberately JSX-free: both CeoPulseVisual (Studio + /pulse share page) and
 * the report deck's CeoPulseSlide import from here, and test batches compile
 * shared modules under the classic JSX runtime — a pure-TS module sidesteps
 * that entirely. Icon values are component REFERENCES (rendered by callers),
 * not elements.
 */
import {
  BarChart3,
  Cog,
  GraduationCap,
  MessageSquare,
  Package,
  type LucideIcon,
} from "lucide-react";
import {
  CEO_PULSE_UPDATE_CATEGORY_MAX_CHARS,
  CEO_PULSE_UPDATE_WHY_MAX_BULLETS,
  CEO_PULSE_UPDATE_WHY_MAX_PARAGRAPHS,
} from "@shared/schema";

export type RoadmapContent = {
  /** True when the analysis carries ANY roadmap field — the render gate. */
  isRoadmap: boolean;
  supportingLine?: string;
  /** Why-This-Matters lead paragraph (contextNarrative[0]) — set only when whyBullets render. */
  whyLead?: string;
  /** Why-This-Matters skimmable bullets (Task #4984), capped at 5. */
  whyBullets: string[];
  /** Why-This-Matters paragraphs (contextNarrative, roadmap cap of 3) — the
   *  legacy fallback rendered only when whyBullets is empty. */
  whyParagraphs: string[];
  pullQuote?: string;
};

const cleanLine = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const cleanBullets = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? value
        .map((bullet) => cleanLine(bullet))
        .filter((bullet): bullet is string => bullet !== undefined)
        .slice(0, max)
    : [];

/** Sanitized per-takeaway category label (object-form items only). */
export function roadmapCategoryLabel(takeaway: unknown): string | undefined {
  if (!takeaway || typeof takeaway !== "object") return undefined;
  const category = cleanLine((takeaway as any).category);
  if (!category || category.length > CEO_PULSE_UPDATE_CATEGORY_MAX_CHARS) return undefined;
  return category;
}

// Category → icon map from the template's canonical area labels
// (System / Product / Reporting / Education / Feedback), matched
// case-insensitively. Unknown or missing categories return null and callers
// render the padded-number fallback ("01", "02", …) instead.
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  system: Cog,
  product: Package,
  reporting: BarChart3,
  education: GraduationCap,
  feedback: MessageSquare,
};

export function roadmapCategoryIcon(category: string | undefined): LucideIcon | null {
  if (!category) return null;
  return CATEGORY_ICONS[category.trim().toLowerCase()] ?? null;
}

// Task #4984 — retired-field detection (rendering for these was removed; the
// values themselves still flip the roadmap layout so already-published
// roadmap briefs keep the template, minus the removed bands). Mirrors the
// pre-retirement cleaning rules: a beforeAfter side counts only when it has a
// non-empty string bullet, a timeline entry only with a whitelisted phase AND
// a non-empty title.
const LEGACY_TIMELINE_PHASES = ["now", "next", "soon"] as const;
function hasLegacyRoadmapFields(analysis: any): boolean {
  const sideHasBullet = (side: unknown): boolean =>
    Array.isArray(side) && side.some((b) => typeof b === "string" && b.trim().length > 0);
  const beforeAfter = analysis?.beforeAfter;
  if (
    beforeAfter &&
    typeof beforeAfter === "object" &&
    !Array.isArray(beforeAfter) &&
    (sideHasBullet((beforeAfter as any).before) || sideHasBullet((beforeAfter as any).after))
  ) {
    return true;
  }
  const timeline = analysis?.timeline;
  return (
    Array.isArray(timeline) &&
    timeline.some(
      (entry: any) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.phase === "string" &&
        (LEGACY_TIMELINE_PHASES as readonly string[]).includes(entry.phase.trim().toLowerCase()) &&
        typeof entry.title === "string" &&
        entry.title.trim().length > 0,
    )
  );
}

/**
 * Derive the roadmap-template content from a stored aiAnalysis.
 *
 * Detection runs on the RAW values (any roadmap field present — including a
 * retired legacy beforeAfter/timeline or a takeaway category — flips the
 * layout), while the rendered values are normalized: whyBullets cap at 5,
 * and the legacy whyParagraphs fallback caps at the roadmap's 3-paragraph
 * limit. Legacy rows (no roadmap fields anywhere) return isRoadmap=false and
 * callers keep the Task #4813 announcement layout byte-for-byte.
 */
export function deriveRoadmapContent(analysis: any): RoadmapContent {
  const supportingLine = cleanLine(analysis?.supportingLine);
  const pullQuote = cleanLine(analysis?.pullQuote);
  const whyBullets = cleanBullets(analysis?.whyBullets, CEO_PULSE_UPDATE_WHY_MAX_BULLETS);
  const hasCategory =
    Array.isArray(analysis?.keyTakeaways) &&
    analysis.keyTakeaways.some((takeaway: unknown) => roadmapCategoryLabel(takeaway) !== undefined);

  const isRoadmap = Boolean(
    supportingLine ||
      pullQuote ||
      whyBullets.length > 0 ||
      hasCategory ||
      hasLegacyRoadmapFields(analysis),
  );

  const whyParagraphs = Array.isArray(analysis?.contextNarrative)
    ? analysis.contextNarrative
        .filter((paragraph: unknown): paragraph is string => typeof paragraph === "string" && paragraph.trim().length > 0)
        .slice(0, CEO_PULSE_UPDATE_WHY_MAX_PARAGRAPHS)
    : [];

  // Bullets present → the section renders lead + bullets and any extra
  // stored paragraphs simply don't render (brevity is the point). No bullets
  // → legacy paragraph rendering, unchanged.
  const whyLead = whyBullets.length > 0 ? whyParagraphs[0] : undefined;

  return {
    isRoadmap,
    supportingLine,
    whyLead,
    whyBullets,
    whyParagraphs: whyBullets.length > 0 ? [] : whyParagraphs,
    pullQuote,
  };
}
